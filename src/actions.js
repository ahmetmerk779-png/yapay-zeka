'use strict'
// Doğrulanmış eylemlerin Mineflayer ile gerçekten uygulandığı yer.
// Her uygulayıcı { ok, msg } döndürür; hata fırlatsa bile plan çalıştırıcı yakalar.

const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const Sch = require('./schematic')
const search = require('./search')
const crystal = require('./crystal')
const OpBuild = require('./opbuild')
// builder.js ayrı dosya olarak gerekmesin diye buraya gömüldü
const Builder = (() => {
// Blokları elle koymak için sıra planlayıcı (saf mantık, Minecraft'a bağlı değil).
// Kural: bir blok ancak yaslanacak katı bir komşusu varsa koyulabilir.
// Komşusu olmayan (havada kalan) bloklar için yerden geçici bir iskele sütunu planlanır,
// iş bitince iskele yukarıdan aşağı kırılır.

const key = (x, y, z) => `${x},${y},${z}`
const DIRS = [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]

// Yaslanılamayan/yaslanmaya uygun olmayan bloklar (ince, sıvı, bitki, etkileşimli vb.)
const NON_SUPPORT = /(torch|redstone_wire|lever|button|sign|banner|carpet|pressure_plate|rail|repeater|comparator|flower|sapling|^grass$|^short_grass$|^tall_grass$|fern|^wheat$|carrots|potatoes|beetroots|vine|ladder|tripwire|^snow$|candle|_head$|_skull$|^water$|^lava$|flower_pot|lantern|chain|_rod$|^air$|cave_air|void_air|_coral$|_fan$|pickles|egg|cobweb|berries|bush|mushroom$|roots|sprouts|^fire$|soul_fire|_door$|trapdoor|fence_gate|^bed$|_bed$)/

const canSupport = (blockName) => !NON_SUPPORT.test(String(blockName))

/**
 * targets: [{ pos:{x,y,z}, name }]   koyulacak bloklar (name = blok adı)
 * worldSolid(x,y,z) -> bool          dünyada o hücre yaslanılabilir mi
 * opts.maxPillar: en uzun iskele (varsayılan 24)
 * dönen: { steps:[{kind:'place', i} | {kind:'scaffold', pos}], cleanup:[pos...] (kırma sırası), unreachable:[i...] }
 */
function planBuild(targets, worldSolid, opts = {}) {
  const maxPillar = opts.maxPillar ?? 24
  const steps = []
  const scaffolds = []
  const unreachable = []
  const remaining = new Map()
  targets.forEach((t, i) => remaining.set(key(t.pos.x, t.pos.y, t.pos.z), i))
  const placedSolid = new Set()
  const placedAny = new Set()      // destek olmasa da koyulmuş her hedef (hücre dolu)
  const solid = (x, y, z) => placedSolid.has(key(x, y, z)) || worldSolid(x, y, z)
  const supported = (p) => DIRS.some(([dx, dy, dz]) => solid(p.x + dx, p.y + dy, p.z + dz))

  const ready = new Set()
  for (const [k, i] of remaining) if (supported(targets[i].pos)) ready.add(i)

  let last = null
  const better = (a, b) => {   // önce düşük y, sonra son konuma yakın
    const pa = targets[a].pos, pb = targets[b].pos
    if (pa.y !== pb.y) return pa.y < pb.y
    if (!last) return a < b
    const da = Math.abs(pa.x - last.x) + Math.abs(pa.z - last.z)
    const db = Math.abs(pb.x - last.x) + Math.abs(pb.z - last.z)
    return da !== db ? da < db : a < b
  }

  const place = (i) => {
    const t = targets[i]
    const k = key(t.pos.x, t.pos.y, t.pos.z)
    remaining.delete(k)
    ready.delete(i)
    placedAny.add(k)
    steps.push({ kind: 'place', i })
    if (canSupport(t.name)) {
      placedSolid.add(k)
      for (const [dx, dy, dz] of DIRS) {
        const nk = key(t.pos.x + dx, t.pos.y + dy, t.pos.z + dz)
        if (remaining.has(nk)) ready.add(remaining.get(nk))
      }
    }
    last = t.pos
  }

  while (remaining.size) {
    if (ready.size) {
      let best = null
      for (const i of ready) if (best === null || better(i, best)) best = i
      place(best)
      continue
    }
    // yaslanacak komşusu olmayan en alçak hedef: yerden iskele kur
    let low = null
    for (const i of remaining.values()) if (low === null || better(i, low)) low = i
    const t = targets[low]
    let groundY = null
    for (let y = t.pos.y - 1; y >= t.pos.y - maxPillar - 1; y--) {
      if (solid(t.pos.x, y, t.pos.z)) { groundY = y; break }
    }
    let blocked = false
    if (groundY !== null) for (let y = groundY + 1; y < t.pos.y; y++) if (placedAny.has(key(t.pos.x, y, t.pos.z))) blocked = true
    if (groundY === null || blocked) {
      unreachable.push(low)
      remaining.delete(key(t.pos.x, t.pos.y, t.pos.z))
      continue
    }
    for (let y = groundY + 1; y < t.pos.y; y++) {
      steps.push({ kind: 'scaffold', pos: { x: t.pos.x, y, z: t.pos.z } })
      scaffolds.push({ x: t.pos.x, y, z: t.pos.z })
      placedSolid.add(key(t.pos.x, y, t.pos.z))
    }
    ready.add(low)
  }
  // iskele sütunları: yukarıdan aşağı kır
  const cleanup = [...scaffolds].sort((a, b) => b.y - a.y)
  return { steps, cleanup, unreachable }
}

return { planBuild, canSupport, NON_SUPPORT, key }

})()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ok = (msg) => ({ ok: true, msg })
const fail = (msg) => ({ ok: false, msg })

const LIQUIDS = new Set(['water', 'lava', 'flowing_water', 'flowing_lava'])
const REPLACEABLE = new Set(['air', 'cave_air', 'void_air', 'water', 'lava', 'short_grass', 'grass', 'tall_grass', 'fern', 'snow', 'vine', 'dead_bush', 'seagrass'])
const SWORD_RANK = ['wooden_sword', 'golden_sword', 'stone_sword', 'iron_sword', 'diamond_sword', 'netherite_sword']
const CONTAINER_BLOCKS = ['chest', 'trapped_chest', 'barrel']

const isLiquid = (b) => !!b && LIQUIDS.has(b.name)
const isAir = (b) => !b || b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air'

// ---------------------------------------------------------------- yardımcılar
// ---- Takılma çözücü: neden takıldığını anla, kademeli stratejiler dene
function goalPos(goal) {
  if (!goal) return null
  if (goal.goal) return null                       // GoalInvert vb.: yön belirsiz
  if (goal.entity) return goal.entity.position
  if (goal.pos) return goal.pos
  if (typeof goal.x === 'number' && typeof goal.z === 'number') return { x: goal.x, y: typeof goal.y === 'number' ? goal.y : null, z: goal.z }
  return null
}

async function tryDig(inst, b) {
  if (!b || isAir(b) || isLiquid(b) || !b.diggable) return false
  if (inst.movements && inst.movements.blocksCantBreak && inst.movements.blocksCantBreak.has(b.type)) return false
  try { if (!inst.bot.canDigBlock(b)) return false; await digBlock(inst, b); return true } catch (e) { return false }
}

async function unstick(inst, attempt, goal) {
  const bot = inst.bot
  try {
    try { bot.pathfinder.stop() } catch (e) { /* yok */ }
    bot.clearControlStates()
    const feet = bot.entity.position.floored()
    const at = (dx, dy, dz) => bot.blockAt(feet.offset(dx, dy, dz))
    // 1) boğulma / örümcek ağı / su / kar içinde
    const head = at(0, 1, 0)
    const foot = at(0, 0, 0)
    if (head && !isAir(head) && head.boundingBox === 'block') await tryDig(inst, head)
    if (foot && foot.name === 'cobweb') await tryDig(inst, foot)
    if ((foot && isLiquid(foot)) || (head && isLiquid(head))) {
      bot.setControlState('jump', true); bot.setControlState('forward', true)
      await sleep(1200)
      bot.clearControlStates()
    }
    // 2) hedefe doğru yön
    const gp = goalPos(goal)
    let dx = 0
    let dz = 0
    if (gp) {
      const vx = gp.x - bot.entity.position.x
      const vz = gp.z - bot.entity.position.z
      if (Math.abs(vx) > Math.abs(vz)) dx = Math.sign(vx); else dz = Math.sign(vz)
    }
    if (!dx && !dz) { const d = yawDir(bot.entity.yaw); dx = d[0]; dz = d[1] }
    const ahead = (dy) => bot.blockAt(feet.offset(dx, dy, dz))
    const faceDir = async () => { try { await bot.lookAt(bot.entity.position.offset(dx * 3, 1.6, dz * 3), true) } catch (e) { /* yoksay */ } }
    const step = attempt % 5

    if (step === 0) {                                  // zıpla + ileri, kapı/çit kapısı varsa aç
      await faceDir()
      for (const dy of [0, 1]) {
        const b = ahead(dy)
        if (b && /(_door|fence_gate|trapdoor)$/.test(b.name) && !/iron_/.test(b.name)) { try { await bot.activateBlock(b) } catch (e) { /* yoksay */ } }
      }
      bot.setControlState('forward', true); bot.setControlState('jump', true); bot.setControlState('sprint', true)
      await sleep(700)
    } else if (step === 1) {                           // önündeki blokları kır (hedefe doğru)
      await faceDir()
      for (const dy of [1, 0]) await tryDig(inst, ahead(dy))
      if (gp && gp.y !== null && gp.y > feet.y + 1) await tryDig(inst, at(0, 2, 0))
      bot.setControlState('forward', true); await sleep(600)
    } else if (step === 2) {                           // boşluk varsa köprü kur, hedef yüksekteyse bir blok yüksel
      await faceDir()
      const floorAhead = bot.blockAt(feet.offset(dx, -1, dz))
      const name = TEMP_BLOCKS.find((n) => invCount(inst, n) > 0)
      if (name && (!floorAhead || isAir(floorAhead) || isLiquid(floorAhead))) {
        await placeAt(inst, name, feet.offset(dx, -1, dz))
        bot.setControlState('forward', true); await sleep(500)
      } else if (name && gp && gp.y !== null && gp.y > feet.y + 1) {
        await bot.look(bot.entity.yaw, -Math.PI / 2 + 0.05)
        bot.setControlState('jump', true)
        const t0 = Date.now()
        while (bot.entity.position.y < feet.y + 1.02 && Date.now() - t0 < 700) await sleep(20)
        await placeAt(inst, name, feet)
        bot.setControlState('jump', false)
      } else {
        bot.setControlState('back', true); bot.setControlState('jump', true); await sleep(500)
      }
    } else if (step === 3) {                           // yan adım at, kısa rastgele yere git (sıkışık köşeden çık)
      const side = Math.random() < 0.5 ? 'left' : 'right'
      bot.setControlState(side, true); bot.setControlState('jump', true); await sleep(800)
      bot.clearControlStates()
      const ang = Math.random() * Math.PI * 2
      const p = bot.entity.position
      try { await bot.pathfinder.goto(new goals.GoalNearXZ(p.x + Math.cos(ang) * 5, p.z + Math.sin(ang) * 5, 2)) } catch (e) { /* yoksay */ }
    } else {                                           // 4: geri çekil, sonra parkur/koşuyu kapatarak devam
      bot.setControlState('back', true); await sleep(900)
      bot.clearControlStates()
      if (inst.movements) { inst.movements.allowParkour = false; inst.movements.allowSprinting = false }
    }
    bot.clearControlStates()
  } catch (e) { try { inst.bot.clearControlStates() } catch (e2) { /* yok */ } }
}

// Hedef erişilemezse yarıçapı büyüt (GoalNear / GoalLookAtBlock yerine yakın bir nokta)
function relaxGoal(goal, step) {
  if (goal && typeof goal.rangeSq === 'number' && typeof goal.x === 'number') {
    return new goals.GoalNear(goal.x, goal.y, goal.z, Math.sqrt(goal.rangeSq) + 2 + step * 2)
  }
  if (goal && goal.pos && typeof goal.pos.x === 'number') return new goals.GoalNear(goal.pos.x, goal.pos.y, goal.pos.z, 3 + step * 2)
  return null
}

async function goTo(inst, goal0, opts = {}) {
  const bot = inst.bot
  const maxRetries = opts.retries === undefined ? 4 : opts.retries
  const saved = inst.movements ? { parkour: inst.movements.allowParkour, sprint: inst.movements.allowSprinting } : null
  let goal = goal0
  let relaxed = 0
  try {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let finished = false
      let result = false
      let abortedStuck = false
      const start = bot.pathfinder.goto(goal).then(() => { result = true }, () => { result = false }).then(() => { finished = true })
      let last = bot.entity.position.clone()
      let lastMove = Date.now()
      const hist = []                                   // son ~8 sn konumları: salınım (ileri-geri) tespiti
      const t0 = Date.now()
      while (!finished) {
        await sleep(500)
        if (opts.cancelled && opts.cancelled()) { try { bot.pathfinder.stop() } catch (e) { /* yok */ } break }
        const p = bot.entity.position
        const digging = !!bot.targetDigBlock
        const moving = !!(bot.pathfinder.isMoving && bot.pathfinder.isMoving())
        const busy = digging || !moving
        if (p.distanceTo(last) > 0.4 || busy) { last = p.clone(); lastMove = Date.now() }
        hist.push(p.clone()); if (hist.length > 16) hist.shift()
        const stuck = Date.now() - lastMove > 5000
        const oscillating = hist.length >= 16 && moving && !digging && hist[0].distanceTo(p) < 1.2 && hist.every((q) => q.distanceTo(hist[0]) < 2.2)
        const tooLong = Date.now() - t0 > (opts.timeoutMs || 60000)
        if (stuck || oscillating || tooLong) { abortedStuck = stuck || oscillating; try { bot.pathfinder.stop() } catch (e) { /* yok */ } break }
      }
      await Promise.race([start, sleep(1000)])
      if (result) return true
      if (opts.cancelled && opts.cancelled()) return false
      if (!abortedStuck) {
        // yol yok: hedefi gevşet (yakın nokta), olmazsa takılma çözücüyü dene
        const g2 = relaxed < 2 ? relaxGoal(goal0, relaxed + 1) : null
        if (g2 && attempt < maxRetries) { goal = g2; relaxed++; continue }
        if (attempt < 1) { await unstick(inst, 3, goal0); continue }
        return false
      }
      await unstick(inst, attempt, goal0)
    }
    return false
  } finally {
    if (saved && inst.movements) { inst.movements.allowParkour = saved.parkour; inst.movements.allowSprinting = saved.sprint }
  }
}

const findInv = (inst, name) => inst.bot.inventory.items().find((i) => i.name === name)
const invCount = (inst, name) => inst.bot.inventory.items().filter((i) => i.name === name).reduce((s, i) => s + i.count, 0)

async function waitFor(ms, cancelled) {
  const end = Date.now() + ms
  while (Date.now() < end && !cancelled()) await sleep(200)
}

function playerEntity(inst, name) {
  return inst.bot.players[name] && inst.bot.players[name].entity
}

function nearestEntity(inst, filter, maxDist = 48) {
  const p = inst.bot.entity.position
  let best = null
  let bestD = maxDist
  for (const e of Object.values(inst.bot.entities)) {
    if (e === inst.bot.entity || !filter(e)) continue
    const d = e.position.distanceTo(p)
    if (d < bestD) { best = e; bestD = d }
  }
  return best
}

async function digBlock(inst, block) {
  const bot = inst.bot
  const tool = inst.movements.bestHarvestTool ? inst.movements.bestHarvestTool(block) : null
  if (block.harvestTools && bot.game.gameMode !== 'creative' && !(tool && block.harvestTools[tool.type])) {
    throw new Error(`${block.name} kırmak için uygun aletim yok`)
  }
  if (tool) await bot.equip(tool, 'hand')
  try {
    await bot.dig(block)
  } catch (e) {
    // insansı kırma "menzil dışı / görüş hattı yok" derse: bloğa görüş hattı olan, rahat menzilde bir noktaya geç ve bir kez daha dene
    if (!/menzil|görüş hattı/.test(e.message)) throw e
    await goTo(inst, new goals.GoalLookAtBlock(block.position, bot.world, { reach: 3.6 }), { retries: 1, timeoutMs: 15000 })
    const fresh = bot.blockAt(block.position)
    if (!fresh || fresh.type !== block.type) return   // bu arada yok olmuş
    await bot.dig(fresh)
  }
}

async function equipBestWeapon(inst) {
  const items = inst.bot.inventory.items()
  const swords = items.filter((i) => SWORD_RANK.includes(i.name))
  const best = swords.sort((a, b) => SWORD_RANK.indexOf(b.name) - SWORD_RANK.indexOf(a.name))[0] ||
    items.find((i) => i.name.endsWith('_axe'))
  if (best) { try { await inst.bot.equip(best, 'hand') } catch (e) { /* önemsiz */ } }
}

function yawDir(yaw) {
  const x = -Math.sin(yaw)
  const z = -Math.cos(yaw)
  return Math.abs(x) > Math.abs(z) ? [Math.sign(x), 0] : [0, Math.sign(z)]
}

// ---- yerleştirme ipuçları: blok özelliklerinden (facing/half/delay...) bakış yönü ve referans yüzü çıkar
const DIR_VEC = { north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0], up: [0, 1, 0], down: [0, -1, 0] }
const OPPOSITE = { north: 'south', south: 'north', east: 'west', west: 'east', up: 'down', down: 'up' }
const SAME_AS_LOOK = /(_stairs|_door|_fence_gate|_bed)$/
const FACES_PLAYER = /(furnace|smoker|chest|barrel|dispenser|dropper|observer|piston|repeater|comparator|lectern|loom|stonecutter|glazed_terracotta|carved_pumpkin|jack_o_lantern)$/
const WALL_MOUNT = /^(torch|soul_torch|redstone_torch|wall_torch|soul_wall_torch|redstone_wall_torch|ladder|lever|tripwire_hook|.*_wall_(sign|banner|head|skull|hanging_sign)|.*_button)$/

function hintsFor(name, props = {}) {
  const h = {}
  const f = props.facing
  if (f && DIR_VEC[f]) {
    if (SAME_AS_LOOK.test(name)) h.lookDir = f
    else if (FACES_PLAYER.test(name)) h.lookDir = OPPOSITE[f]
    if (WALL_MOUNT.test(name) && (props.face === undefined || props.face === 'wall')) h.refDir = DIR_VEC[OPPOSITE[f]]
  }
  if (props.face === 'floor') h.refDir = DIR_VEC.down
  else if (props.face === 'ceiling') h.refDir = DIR_VEC.up
  if (props.half === 'top' || props.type === 'top') h.half = 'top'
  if (props.delay && /repeater$/.test(name)) h.clicks = Math.max(0, Math.min(3, Number(props.delay) - 1))
  if (props.mode === 'subtract' && /comparator$/.test(name)) h.clicks = 1
  return h
}

// 'forward/back/left/right' gibi göreli yönleri botun baktığı yöne göre dünya yönüne çevir
function worldFacing(inst, f) {
  if (!f) return null
  if (DIR_VEC[f]) return f
  const [fx, fz] = yawDir(inst.bot.entity.yaw)
  const nameOf = (dx, dz) => (dx > 0 ? 'east' : dx < 0 ? 'west' : dz > 0 ? 'south' : 'north')
  if (f === 'forward') return nameOf(fx, fz)
  if (f === 'back') return nameOf(-fx, -fz)
  if (f === 'right') return nameOf(-fz, fx)
  if (f === 'left') return nameOf(fz, -fx)
  return null
}

// mineflayer'ın placeBlock'u her zaman yüze bakar; bakış yönünü korumak için dahili seçenekli sürümü kullan
async function rawPlace(bot, ref, face, extra = {}) {
  if (bot._placeBlockWithOptions) return bot._placeBlockWithOptions(ref, face, { swingArm: 'right', ...extra })
  return bot.placeBlock(ref, face)
}

// Blok yerleştirme: komşu bir referans blok bulur, menzile girer, koyar.
// opts: { lookDir, refDir:[dx,dy,dz], half, clicks }
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('zaman aşımı')), ms))])

async function placeAt(inst, itemName, pos, opts = {}) {
  const bot = inst.bot
  const target = bot.blockAt(pos)
  if (target && !REPLACEABLE.has(target.name)) return 'full'
  let item = findInv(inst, itemName)
  if (!item && isCreative(inst) && (await ensureItem(inst, itemName))) item = findInv(inst, itemName)
  if (!item) return 'noitem'

  const eyeDist = (v) => bot.entity.position.offset(0, 1.62, 0).distanceTo(v)
  const center = pos.offset(0.5, 0.5, 0.5)
  // Yaslanacak katı komşu yoksa (suyun/havanın ortası) boşuna ileri geri gitme
  const hasRef = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]].some((f) => {
    const r = bot.blockAt(pos.offset(f[0], f[1], f[2]))
    return r && !isAir(r) && !isLiquid(r) && r.boundingBox === 'block'
  })
  if (!hasRef) return 'noref'
  await moveNear(inst, pos)
  if (eyeDist(center) > 5.0) { await moveNear(inst, pos) }   // bir kez daha yaklaşmayı dene
  if (eyeDist(center) > 5.4) return 'far'                    // menzil dışı: boşuna bekleme, sonra yeniden denenecek
  const feet = bot.entity.position.floored()
  if (feet.equals(pos) || feet.offset(0, 1, 0).equals(pos)) {
    await goTo(inst, new goals.GoalInvert(new goals.GoalNear(pos.x, pos.y, pos.z, 2)))
  }

  const faces = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]
  if (opts.refDir) faces.unshift(opts.refDir)
  for (const f of faces) {
    const ref = bot.blockAt(pos.offset(f[0], f[1], f[2]))
    if (!ref || isAir(ref) || isLiquid(ref) || ref.boundingBox !== 'block') continue
    if (eyeDist(ref.position.offset(0.5, 0.5, 0.5)) > 5.6) continue   // bu yüze uzanamıyorum
    let sneaking = false
    try {
      await bot.equip(item, 'hand')
      const face = new Vec3(-f[0], -f[1], -f[2])
      if (INTERACTABLE.test(ref.name)) { bot.setControlState('sneak', true); sneaking = true; await sleep(130) }
      if (opts.lookDir && DIR_VEC[opts.lookDir]) {
        const v = DIR_VEC[opts.lookDir]
        await bot.lookAt(bot.entity.position.offset(0, 1.62, 0).plus(new Vec3(v[0], v[1], v[2]).scaled(5)), true)
        await withTimeout(rawPlace(bot, ref, face, { forceLook: 'ignore', half: opts.half }), 1800)
      } else {
        await withTimeout(rawPlace(bot, ref, face, { half: opts.half }), 1800)
      }
      if (opts.clicks) {
        const placed = bot.blockAt(pos)
        for (let i = 0; i < opts.clicks && placed; i++) { try { await bot.activateBlock(placed) } catch (e) { break } await sleep(150) }
      }
      return 'ok'
    } catch (e) { /* diğer yüzü dene */ } finally { if (sneaking) bot.setControlState('sneak', false) }
  }
  return 'noref'
}

async function openNearestContainer(inst, a) {
  const bot = inst.bot
  let block
  if (a.pos) block = bot.blockAt(new Vec3(a.pos.x, a.pos.y, a.pos.z))
  else {
    const ids = CONTAINER_BLOCKS.map((n) => inst.mcData.blocksByName[n]).filter(Boolean).map((b) => b.id)
    block = bot.findBlock({ matching: ids, maxDistance: 32 })
  }
  if (!block) throw new Error('yakında sandık/varil bulamadım')
  await goTo(inst, new goals.GoalLookAtBlock(block.position, bot.world))
  return bot.openContainer(block)
}

// ---------------------------------------------------------------- hareket
async function stop(inst) { inst.stopEverything(); inst.mode = 'busy'; return ok('durdum') }

async function follow(inst, a) {
  const e = playerEntity(inst, a.target)
  if (!e) return fail(`${a.target} görüş alanımda değil`)
  const dist = a.distance || 2
  inst.bot.pathfinder.setGoal(new goals.GoalFollow(e, dist), true)
  inst.bot.setControlState('sprint', a.sprint !== false)
  inst.mode = 'follow'
  return ok(`${a.target} takip ediliyor (${dist} blok mesafe)`)
}

async function goto_player(inst, a, { cancelled } = {}) {
  const bot = inst.bot
  const d = a.distance || 2
  const cancel = cancelled || (() => false)
  let e = playerEntity(inst, a.target)
  let last = e ? e.position.clone() : null
  if (!e) {
    // görüş dışı: bilinen son konuma git, orada görürsek devam ederiz
    last = inst.lastSeen && inst.lastSeen[a.target]
    if (!last) return fail(`${a.target} çok uzakta, göremiyorum (koordinat verirsen oraya giderim)`)
  }
  const t0 = Date.now()
  let ref = bot.entity.position.clone()
  let refT = Date.now()
  let stuckN = 0
  let curKey = null
  let curGoal = null
  try {
    while (!cancel() && Date.now() - t0 < 120000) {
      e = playerEntity(inst, a.target)
      if (e) { last = e.position.clone(); inst.lastSeen = inst.lastSeen || {}; inst.lastSeen[a.target] = last }
      const me = bot.entity.position
      const dist = me.distanceTo(last)
      if (dist <= d + 0.8 && (!e || Math.abs(me.y - last.y) < 3)) {
        if (e) { try { await bot.lookAt(e.position.offset(0, e.height || 1.6, 0)) } catch (err) { /* yoksay */ } }
        bot.pathfinder.setGoal(null)
        return ok(`${a.target} yanına vardım`)
      }
      // hedef hareket ediyorsa dinamik takip, görüş dışıysa sabit nokta
      const gkey = e ? `f${e.id}` : `n${Math.round(last.x)},${Math.round(last.z)}`
      if (gkey !== curKey) {
        curKey = gkey
        curGoal = e ? new goals.GoalFollow(e, d) : new goals.GoalNear(last.x, last.y, last.z, d)
        bot.pathfinder.setGoal(curGoal, !!e)
      }
      const goal = curGoal
      await sleep(400)
      // takıldıysa kurtul
      if (me.distanceTo(ref) > 0.6 || bot.targetDigBlock) { ref = bot.entity.position.clone(); refT = Date.now(); stuckN = 0 }
      else if (Date.now() - refT > 4500) {
        refT = Date.now(); stuckN++
        if (stuckN > 6) return fail('yanına ulaşamadım (yol yok ya da engel aşılamadı)')
        await unstick(inst, stuckN, goal).catch(() => {})
      }
      if (!e && bot.entity.position.distanceTo(last) <= d + 1) return fail(`${a.target}'ı bulamadım (son bildiğim yere geldim ama görünmüyor)`)
    }
    return cancel() ? fail('iptal edildi') : fail('zaman aşımı: yanına varamadım')
  } finally {
    if (inst.mode !== 'follow') bot.pathfinder.setGoal(null)
  }
}

async function goto_(inst, a) {
  const goal = a.y === null ? new goals.GoalNearXZ(a.x, a.z, 1) : new goals.GoalNear(a.x, a.y, a.z, 1)
  return (await goTo(inst, goal)) ? ok('koordinata vardım') : fail('koordinata ulaşamadım (yol yok ya da zaman aşımı)')
}

async function goto_block(inst, a) {
  const block = inst.bot.findBlock({ matching: a.defs.map((d) => d.id), maxDistance: a.maxDistance })
  if (!block) return fail(`${a.maxDistance} blok çevrede ${a.label} bulamadım`)
  const p = block.position
  return (await goTo(inst, new goals.GoalNear(p.x, p.y, p.z, 2)))
    ? ok(`${a.label} yanına geldim (${p.x}, ${p.y}, ${p.z})`) : fail(`${a.label} bloğuna ulaşamadım`)
}

async function wander(inst, a, { cancelled }) {
  const start = inst.bot.entity.position.clone()
  const end = Date.now() + a.seconds * 1000
  let moves = 0
  while (!cancelled() && Date.now() < end) {
    const ang = Math.random() * Math.PI * 2
    const r = 3 + Math.random() * Math.max(1, a.radius - 3)
    await goTo(inst, new goals.GoalNearXZ(start.x + Math.cos(ang) * r, start.z + Math.sin(ang) * r, 2))
    moves++
    // insan gibi: durup etrafa bak
    await lookSweep(inst, 1 + Math.floor(Math.random() * 2), cancelled)
    await waitFor(300 + Math.random() * 1500, cancelled)
  }
  return ok(`${moves} noktaya uğrayarak gezindim`)
}

// ---------------------------------------------------------------- hareket / kafa çevirme
const wrapAng = (a) => { let x = (a + Math.PI) % (Math.PI * 2); if (x < 0) x += Math.PI * 2; return x - Math.PI }
// mineflayer yönü: yaw 0 = kuzey (-z), pi/2 = batı, pi = güney, -pi/2 = doğu
const COMPASS = { north: 0, south: Math.PI, west: Math.PI / 2, east: -Math.PI / 2 }

async function lookSweep(inst, times = 2, cancelled = () => false) {
  const bot = inst.bot
  for (let i = 0; i < times && !cancelled(); i++) {
    const base = bot.entity.yaw
    const off = (0.5 + Math.random() * 1.1) * (Math.random() < 0.5 ? -1 : 1)
    await bot.look(wrapAng(base + off), (Math.random() - 0.5) * 0.4)
    await waitFor(250 + Math.random() * 500, cancelled)
  }
}

async function turn(inst, a) {
  const bot = inst.bot
  // yaw artarsa sola döner: sağa dönmek yaw'ı azaltır
  const delta = (a.direction === 'left' ? 1 : -1) * (a.degrees * Math.PI / 180)
  const pitch = a.pitch === null ? bot.entity.pitch : -a.pitch * Math.PI / 180
  await bot.look(wrapAng(bot.entity.yaw + delta), pitch)
  return ok(`${a.degrees} derece ${a.direction === 'left' ? 'sola' : 'sağa'} döndüm`)
}

async function face(inst, a) {
  const bot = inst.bot
  const d = a.direction
  if (d === 'up') await bot.look(bot.entity.yaw, Math.PI / 2 - 0.05)
  else if (d === 'down') await bot.look(bot.entity.yaw, -Math.PI / 2 + 0.05)
  else if (d === 'forward') await bot.look(bot.entity.yaw, 0)
  else if (d === 'back') await bot.look(wrapAng(bot.entity.yaw + Math.PI), 0)
  else await bot.look(COMPASS[d], 0)
  return ok(`${d} yönüne döndüm`)
}

async function look_around(inst, a, { cancelled }) {
  const end = Date.now() + a.seconds * 1000
  let n = 0
  while (!cancelled() && Date.now() < end) { await lookSweep(inst, 1, cancelled); n++ }
  return ok(`etrafıma ${n} kez bakındım`)
}

// Elle yürü: yön, blok sayısı, engelde zıpla, uçurum/lav önünde dur
async function walk(inst, a, { cancelled }) {
  const bot = inst.bot
  const start = bot.entity.position.clone()
  const t0 = Date.now()
  const limit = (a.blocks * (a.sprint ? 0.25 : 0.45) + 4) * 1000
  const stateName = { forward: 'forward', back: 'back', left: 'left', right: 'right' }[a.direction]
  const yaw = bot.entity.yaw
  const fwd = { x: -Math.sin(yaw), z: -Math.cos(yaw) }
  const vec = { forward: fwd, back: { x: -fwd.x, z: -fwd.z }, right: { x: Math.cos(yaw), z: -Math.sin(yaw) }, left: { x: -Math.cos(yaw), z: Math.sin(yaw) } }[a.direction]
  const dx = Math.abs(vec.x) > Math.abs(vec.z) ? Math.sign(vec.x) : 0
  const dz = dx === 0 ? Math.sign(vec.z) : 0
  bot.setControlState('sneak', !!a.sneak)
  bot.setControlState(stateName, true)
  bot.setControlState('sprint', !!a.sprint && a.direction === 'forward' && !a.sneak)
  let why = null
  let lastPos = start
  let lastMove = Date.now()
  try {
    while (!cancelled()) {
      await sleep(50)
      const p = bot.entity.position
      if (Math.hypot(p.x - start.x, p.z - start.z) >= a.blocks) break
      if (Date.now() - t0 > limit) { why = 'süre doldu'; break }
      const feet = p.floored()
      const ahead = feet.offset(dx, 0, dz)
      const b0 = bot.blockAt(ahead)
      const b1 = bot.blockAt(ahead.offset(0, 1, 0))
      const b2 = bot.blockAt(ahead.offset(0, 2, 0))
      const floor = bot.blockAt(ahead.offset(0, -1, 0))
      const floor2 = bot.blockAt(ahead.offset(0, -2, 0))
      const solid0 = b0 && !isAir(b0) && b0.boundingBox === 'block'
      const solid1 = b1 && !isAir(b1) && b1.boundingBox === 'block'
      const solid2 = b2 && !isAir(b2) && b2.boundingBox === 'block'
      if (b0 && isLiquid(b0) && b0.name.includes('lava')) { why = 'önümde lav var'; break }
      if (solid0 && !solid1 && !solid2) { if (bot.entity.onGround) bot.setControlState('jump', true) } else bot.setControlState('jump', false)
      if (solid0 && (solid1 || solid2)) { why = 'önümde duvar var'; break }
      if (!solid0 && (!floor || isAir(floor) || isLiquid(floor)) && (!floor2 || isAir(floor2) || isLiquid(floor2))) { why = 'önümde uçurum var'; break }
      if (p.distanceTo(lastPos) > 0.15) { lastPos = p.clone(); lastMove = Date.now() }
      else if (Date.now() - lastMove > 1500) { why = 'bir şeye takıldım'; break }
    }
  } finally {
    for (const c of ['forward', 'back', 'left', 'right', 'sprint', 'jump', 'sneak']) bot.setControlState(c, false)
  }
  const moved = Math.round(Math.hypot(bot.entity.position.x - start.x, bot.entity.position.z - start.z) * 10) / 10
  if (cancelled()) return fail('iptal edildi')
  return why ? fail(`${moved} blok yürüdüm, durdum: ${why}`) : ok(`${moved} blok ${a.direction === 'forward' ? 'ileri' : a.direction} yürüdüm`)
}

// Birinden / bir şeyden kaç
async function flee(inst, a, { cancelled }) {
  const bot = inst.bot
  const end = Date.now() + a.seconds * 1000
  let ran = 0
  bot.setControlState('sprint', true)
  try {
    while (!cancelled() && Date.now() < end) {
      let e = null
      if (a.kind === 'player') e = playerEntity(inst, a.name)
      else if (a.kind === 'hostile') e = nearestEntity(inst, (x) => x.type === 'hostile' || x.kind === 'Hostile mobs', 32)
      else e = nearestEntity(inst, (x) => x.name === a.name, 32)
      if (!e) break
      const d = e.position.distanceTo(bot.entity.position)
      if (d > a.blocks) break
      const p = e.position
      await goTo(inst, new goals.GoalInvert(new goals.GoalNear(p.x, p.y, p.z, a.blocks)), { cancelled, retries: 0, timeoutMs: 6000 })
      ran++
    }
  } finally { bot.setControlState('sprint', false) }
  return cancelled() ? fail('iptal edildi') : ok(ran ? 'uzaklaştım' : 'kaçacak kimse yoktu / zaten uzaktayım')
}

// Birinin etrafında dön (yan adım ile, mesafeyi koruyarak)
async function circle(inst, a, { cancelled }) {
  const bot = inst.bot
  const end = Date.now() + a.seconds * 1000
  const side = a.direction === 'left' ? 'left' : 'right'
  let flip = Date.now() + 99999999
  if (bot.smoothLook) bot.smoothLook.fast = true
  try {
    while (!cancelled() && Date.now() < end) {
      const e = playerEntity(inst, a.target)
      if (!e) return fail(`${a.target} görüş alanımda değil`)
      await bot.lookAt(e.position.offset(0, (e.height || 1.8) * 0.85, 0), true)
      const d = Math.hypot(e.position.x - bot.entity.position.x, e.position.z - bot.entity.position.z)
      bot.setControlState(side, true)
      bot.setControlState('forward', d > a.radius + 0.8)
      bot.setControlState('back', d < a.radius - 0.8)
      if (bot.entity.isCollidedHorizontally && bot.entity.onGround) bot.setControlState('jump', true); else bot.setControlState('jump', false)
      await sleep(50)
    }
  } finally {
    for (const c of ['forward', 'back', 'left', 'right', 'jump']) bot.setControlState(c, false)
    if (bot.smoothLook) bot.smoothLook.fast = false
  }
  return cancelled() ? fail('iptal edildi') : ok(`${a.target} etrafında döndüm`)
}

// Kısa jestler: el sallama, kafa sallama, dans, çömelme
async function emote(inst, a, { cancelled }) {
  const bot = inst.bot
  const sl = (ms) => waitFor(ms, cancelled)
  const e = nearestEntity(inst, (x) => x.type === 'player' && x.username !== bot.username, 12)
  if (e && a.kind !== 'crouch') { try { await bot.lookAt(e.position.offset(0, e.height || 1.6, 0)) } catch (err) { /* yoksay */ } }
  if (a.kind === 'wave') { for (let i = 0; i < 4 && !cancelled(); i++) { bot.swingArm('right'); await sl(280) } }
  else if (a.kind === 'nod') { for (let i = 0; i < 3 && !cancelled(); i++) { await bot.look(bot.entity.yaw, -0.45); await sl(150); await bot.look(bot.entity.yaw, 0.1); await sl(150) } }
  else if (a.kind === 'shake') { for (let i = 0; i < 3 && !cancelled(); i++) { await bot.look(wrapAng(bot.entity.yaw + 0.5), 0); await sl(150); await bot.look(wrapAng(bot.entity.yaw - 1.0), 0); await sl(150); await bot.look(wrapAng(bot.entity.yaw + 0.5), 0) } }
  else if (a.kind === 'crouch') { for (let i = 0; i < 6 && !cancelled(); i++) { bot.setControlState('sneak', i % 2 === 0); await sl(220) } bot.setControlState('sneak', false) }
  else if (a.kind === 'dance') {
    for (let i = 0; i < 8 && !cancelled(); i++) {
      await bot.look(wrapAng(bot.entity.yaw + 0.9), 0)
      bot.setControlState('jump', true); await sl(120); bot.setControlState('jump', false)
      bot.setControlState('sneak', i % 2 === 0); await sl(260)
    }
    bot.setControlState('sneak', false)
  }
  return ok(`${a.kind} jestini yaptım`)
}

async function look_at(inst, a) {
  const bot = inst.bot
  if (a.kind === 'pos') { await bot.lookAt(new Vec3(a.x + 0.5, a.y + 0.5, a.z + 0.5)); return ok('baktım') }
  const e = a.kind === 'player' ? playerEntity(inst, a.name) : nearestEntity(inst, (x) => x.name === a.name)
  if (!e) return fail(`${a.name} görünürde yok`)
  await bot.lookAt(e.position.offset(0, e.height || 1.6, 0))
  return ok(`${a.name} tarafına baktım`)
}

async function jump(inst) {
  inst.bot.setControlState('jump', true)
  await sleep(400)
  inst.bot.setControlState('jump', false)
  return ok('zıpladım')
}

async function sneak(inst, a) { inst.bot.setControlState('sneak', a.on); return ok(a.on ? 'çömeldim' : 'ayağa kalktım') }

async function set_home(inst, a) {
  const p = inst.bot.entity.position.floored()
  inst.homes[a.name] = p
  if (inst.saveHomes) inst.saveHomes()
  return ok(`"${a.name}" noktası kaydedildi (${p.x}, ${p.y}, ${p.z})`)
}

async function go_home(inst, a) {
  const p = inst.homes[a.name]
  if (!p) return fail(`"${a.name}" adında kayıtlı nokta yok. Kayıtlılar: ${Object.keys(inst.homes).join(', ') || 'yok'}`)
  return (await goTo(inst, new goals.GoalNear(p.x, p.y, p.z, 1))) ? ok(`"${a.name}" noktasına döndüm`) : fail('eve yol bulamadım')
}

async function mount(inst, a) {
  const isBoat = a.name.endsWith('boat')
  const e = nearestEntity(inst, (x) => x.name === a.name || (isBoat && x.name.endsWith('boat') && !x.name.includes('chest')), 24)
  if (!e) return fail(`yakında ${a.name} yok`)
  await goTo(inst, new goals.GoalNear(e.position.x, e.position.y, e.position.z, 2))
  try { inst.bot.mount(e); return ok(`${a.name} üzerine bindim`) } catch (err) { return fail(`binemedim (${err.message})`) }
}

async function dismount(inst) { try { inst.bot.dismount() } catch (e) { return fail('zaten bir şeye binmiyorum') } return ok('indim') }

async function sleep_(inst) {
  const bot = inst.bot
  if (bot.time && bot.time.isDay && !bot.isRaining) return fail('şu an gündüz, uyunamaz')
  const bed = bot.findBlock({ matching: (b) => bot.isABed(b), maxDistance: 32 })
  if (!bed) return fail('32 blok çevrede yatak yok')
  await goTo(inst, new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 1))
  try { await bot.sleep(bed); return ok('yatağa yattım') } catch (e) { return fail(`uyuyamadım (${e.message})`) }
}

async function wake(inst) { try { await inst.bot.wake(); return ok('uyandım') } catch (e) { return fail('zaten uyanığım') } }

// ---------------------------------------------------------------- toplama
const ORE_RE = /(_ore|ancient_debris)$/
const BEST_Y = { coal: 45, iron: 16, copper: 48, gold: -16, redstone: -58, diamond: -58, lapis: 0, emerald: 232, ancient_debris: 15, nether_gold: 15, nether_quartz: 15 }
const bkey = (p) => `${p.x},${p.y},${p.z}`

// Bloğun yanında lav varsa kazma (lav akışı / tuzak)
function nearLava(inst, pos) {
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
    const b = inst.bot.blockAt(pos.offset(dx, dy, dz))
    if (b && (b.name === 'lava' || b.name === 'flowing_lava')) return true
  }
  return false
}

async function collect(inst, a, ctx) {
  const { cancelled } = ctx
  const ids = a.defs.map((b) => b.id)
  const idSet = new Set(ids)
  const isOre = a.defs.some((d) => ORE_RE.test(d.name))
  const blacklist = new Set()
  let mined = 0
  let fails = 0
  let lastErr = ''
  let hops = 0
  let exploreAng = Math.random() * Math.PI * 2
  while (!cancelled() && mined < a.count && fails < 5) {
    const here = inst.bot.entity.position
    const cands = inst.bot.findBlocks({ matching: ids, maxDistance: 64, count: 24 })
      .filter((p) => !blacklist.has(bkey(p)) && !(isOre && nearLava(inst, p)))
    const pos = cands[0]
    if (!pos) {
      // Cevher yakında yok: tünel/inme ile aramaya geç
      if (isOre && a.explore !== false) {
        const r = await mine(inst, { ...a, count: a.count - mined }, ctx)
        return r.ok ? ok(`${mined + (r.mined || 0)} adet ${a.label} topladım`) : fail(r.msg)
      }
      // Ağaç/kum/toprak gibi yüzey blokları: yakında yoksa keşfe çıkıp ara (en çok 5 sıçrama ≈ 200 blok)
      if (!isOre && a.explore !== false && hops < 5 && !cancelled()) {
        hops++
        const cur = inst.bot.entity.position
        const ang = exploreAng + (hops - 1) * 0.35
        const tx = Math.floor(cur.x + Math.sin(ang) * 40)
        const tz = Math.floor(cur.z - Math.cos(ang) * 40)
        inst.log('action', `${a.label} yakında yok: keşfe çıkıyorum (${hops}/5)`)
        const moved = await goTo(inst, new goals.GoalNearXZ(tx, tz, 5), { cancelled, retries: 1, timeoutMs: 40000 })
        if (!moved) exploreAng += 1.2   // engel: yönü değiştir
        continue
      }
      return mined > 0 ? ok(`${mined} adet ${a.label} kırdım, çevrede başka kalmadı`) : fail(`çevrede ${a.label} bulamadım${hops ? ` (${hops * 40} blok keşfettim)` : ''}`)
    }
    try {
      const reached = await goTo(inst, new goals.GoalLookAtBlock(pos, inst.bot.world), { cancelled, retries: 2, timeoutMs: 45000 })
      if (cancelled()) break
      const fresh = inst.bot.blockAt(pos)
      if (!fresh || !idSet.has(fresh.type)) continue
      if (!reached && fresh.position.distanceTo(inst.bot.entity.position.offset(0, 1.6, 0)) > 4.5) {
        blacklist.add(bkey(pos)); fails++; lastErr = 'bir bloğa ulaşılamadı'; continue
      }
      await digBlock(inst, fresh)
      mined++
      fails = 0
      await sleep(250)
      const drop = nearestEntity(inst, (e) => e.name === 'item' && e.position.distanceTo(pos) < 5, 8)
      if (drop && !cancelled()) await goTo(inst, new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 0.8), { cancelled, retries: 0, timeoutMs: 10000 })
    } catch (e) {
      if (cancelled()) break
      lastErr = e.message
      if (/uygun aletim yok/.test(e.message)) return fail(e.message)
      blacklist.add(bkey(pos))
      fails++
      await sleep(400)
    }
  }
  if (cancelled()) return fail('iptal edildi')
  return mined >= a.count ? ok(`${mined} adet ${a.label} topladım`) : fail(`${mined}/${a.count} ${a.label} toplayabildim (${lastErr || 'engellere takıldım'})`)
}

// Madencilik: cevher ara; yoksa en verimli yüksekliğe in, dal tüneli kaz ve taramaya devam et.
async function digForward(inst, dx, dz, n, cancelled) {
  const bot = inst.bot
  for (let i = 0; i < n && !cancelled(); i++) {
    const feet = bot.entity.position.floored()
    const front = feet.offset(dx, 0, dz)
    for (const dy of [0, 1]) {
      const b = bot.blockAt(front.offset(0, dy, 0))
      if (!b) return { ok: false, reason: 'yüklenmemiş alan' }
      if (isLiquid(b)) return { ok: false, reason: `${b.name} var` }
      if (!isAir(b)) {
        if (!b.diggable) return { ok: false, reason: `${b.name} kırılamaz` }
        if (nearLava(inst, b.position)) return { ok: false, reason: 'lav yakın' }
        try { await digBlock(inst, b) } catch (e) { return { ok: false, reason: e.message, tool: /alet/.test(e.message) } }
      }
    }
    // üstte düşen blok (kum/çakıl) varsa bekle
    await sleep(120)
    const below = bot.blockAt(front.offset(0, -1, 0))
    if (!below || isLiquid(below)) return { ok: false, reason: 'ileride sıvı/boşluk var' }
    if (isAir(below)) {   // 1 blokluk boşluğu doldur, değilse dur
      const fill = TEMP_BLOCKS.find((nme) => invCount(inst, nme) > 0)
      const deeper = bot.blockAt(front.offset(0, -2, 0))
      if (!fill || !deeper || isAir(deeper) || isLiquid(deeper)) return { ok: false, reason: 'ileride uçurum var' }
      await placeAt(inst, fill, below.position)
    }
    if (!(await goTo(inst, new goals.GoalBlock(front.x, front.y, front.z), { cancelled, retries: 1, timeoutMs: 15000 }))) return { ok: false, reason: 'ilerleyemedim' }
  }
  return { ok: true }
}

async function mine(inst, a, { cancelled }) {
  const bot = inst.bot
  const ids = a.defs.map((d) => d.id)
  const idSet = new Set(ids)
  const base = a.defs[0].name.replace(/^deepslate_/, '').replace(/_ore$/, '')
  const bestY = BEST_Y[base]
  const creative = isCreative(inst)
  if (!creative && !bot.inventory.items().some((i) => i.name.endsWith('_pickaxe'))) return fail('kazmam yok, maden kazamam (önce bir kazma ver ya da üret)')
  const blacklist = new Set()
  const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]]
  let [dx0, dz0] = yawDir(bot.entity.yaw)
  let di = dirs.findIndex(([x, z]) => x === dx0 && z === dz0)
  if (di < 0) di = 0
  let mined = 0
  let tunneled = 0
  let turns = 0
  let descendFailed = false
  let fails = 0
  let lastReason = ''
  const maxTunnel = a.maxTunnel || 160
  while (!cancelled() && mined < a.count && fails < 6) {
    const cands = bot.findBlocks({ matching: ids, maxDistance: 48, count: 24 })
      .filter((p) => !blacklist.has(bkey(p)) && !nearLava(inst, p))
    const pos = cands[0]
    if (pos) {
      try {
        const reached = await goTo(inst, new goals.GoalLookAtBlock(pos, bot.world), { cancelled, retries: 2, timeoutMs: 60000 })
        if (cancelled()) break
        const fresh = bot.blockAt(pos)
        if (!fresh || !idSet.has(fresh.type)) continue
        if (!reached && fresh.position.distanceTo(bot.entity.position.offset(0, 1.6, 0)) > 4.5) { blacklist.add(bkey(pos)); fails++; continue }
        await digBlock(inst, fresh)
        mined++
        fails = 0
        await sleep(250)
        const drop = nearestEntity(inst, (e) => e.name === 'item' && e.position.distanceTo(pos) < 5, 8)
        if (drop) await goTo(inst, new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 0.8), { cancelled, retries: 0, timeoutMs: 10000 })
      } catch (e) {
        if (/uygun aletim yok/.test(e.message)) return { ...fail(`${e.message} (${mined} adet kazdım)`), mined }
        blacklist.add(bkey(pos)); fails++; lastReason = e.message
      }
      continue
    }
    // Cevher görünmüyor: önce uygun yüksekliğe in
    const y = Math.floor(bot.entity.position.y)
    if (bestY !== undefined && !descendFailed && !/nether/.test(String(bot.game.dimension)) && y > bestY + 3) {
      inst.log('info', `${a.label} için y=${bestY} seviyesine iniliyor (şu an y=${y})`)
      const goalY = Math.max(bestY, -58)
      await goTo(inst, new goals.GoalY(goalY), { cancelled, retries: 1, timeoutMs: 120000 })
      if (Math.floor(bot.entity.position.y) > goalY + 6) descendFailed = true
      continue
    }
    // Dal tüneli: 6 blok kaz, yeniden tara
    if (tunneled >= maxTunnel) break
    const [dx, dz] = dirs[di]
    const r = await digForward(inst, dx, dz, 6, cancelled)
    if (r.tool) return { ...fail(`${r.reason} (${mined} adet kazdım)`), mined }
    if (r.ok) { tunneled += 6; turns = 0; continue }
    lastReason = r.reason
    di = (di + 1) % 4
    turns++
    if (turns >= 4) break   // dört yön de kapalı
  }
  if (cancelled()) return { ...fail('iptal edildi'), mined }
  if (mined >= a.count) return { ...ok(`${mined} adet ${a.label} kazdım`), mined }
  return { ...fail(`${mined}/${a.count} ${a.label} kazabildim (${lastReason || `${tunneled} blok tünel kazdım, yakında kalmadı`}). Başka bir bölgeye gitmemi ister misin?`), mined }
}

async function pickup(inst, a, { cancelled }) {
  const seen = new Set()
  let n = 0
  while (!cancelled() && n < 40) {
    const e = nearestEntity(inst, (x) => x.name === 'item' && !seen.has(x.id) && x.position.distanceTo(inst.bot.entity.position) <= a.radius, a.radius)
    if (!e) break
    seen.add(e.id)
    await goTo(inst, new goals.GoalNear(e.position.x, e.position.y, e.position.z, 0.7))
    await sleep(150)
    n++
  }
  return n > 0 ? ok(`${n} eşyanın başına gittim ve topladım`) : fail('yakında yerde eşya yok')
}

async function tunnel(inst, a, { cancelled }) {
  const bot = inst.bot
  const dirs = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }
  const [dx, dz] = a.direction === 'forward' ? yawDir(bot.entity.yaw) : dirs[a.direction]
  let dug = 0
  for (let i = 0; i < a.length && !cancelled(); i++) {
    const front = bot.entity.position.floored().offset(dx, 0, dz)
    for (const dy of [0, 1]) {
      const b = bot.blockAt(front.offset(0, dy, 0))
      if (!b) continue
      if (isLiquid(b)) return fail(`ilerde ${b.name} var, güvenlik için durdum (${i} blok ilerledim)`)
      if (!isAir(b) && b.diggable) {
        try { await digBlock(inst, b); dug++ } catch (e) { return fail(`${e.message} (${i} blok ilerledim)`) }
      }
    }
    const below = bot.blockAt(front.offset(0, -1, 0))
    if (!below || isLiquid(below) || isAir(below)) return fail(`ilerde boşluk/sıvı var, güvenlik için durdum (${i} blok ilerledim)`)
    if (!(await goTo(inst, new goals.GoalBlock(front.x, front.y, front.z)))) return fail(`ilerleyemedim (${i} blok gittim)`)
  }
  return cancelled() ? fail('iptal edildi') : ok(`${a.length} blokluk tünel kazdım`)
}

async function dig_down(inst, a) {
  const p = inst.bot.entity.position.floored()
  const targetY = a.y !== undefined ? a.y : p.y - a.depth
  if (targetY >= p.y) return fail('hedef y şu anki yüksekliğimden aşağıda değil')
  const ok1 = await goTo(inst, new goals.GoalBlock(p.x, targetY, p.z))
  const now = Math.floor(inst.bot.entity.position.y)
  return ok1 ? ok(`y=${now} seviyesine indim`) : fail(`y=${now} seviyesine kadar inebildim, sonra engel/tehlike çıktı`)
}

const CROPS = {
  wheat: { seed: 'wheat_seeds', max: 7 }, carrots: { seed: 'carrot', max: 7 },
  potatoes: { seed: 'potato', max: 7 }, beetroots: { seed: 'beetroot_seeds', max: 3 },
  nether_wart: { seed: 'nether_wart', max: 3 },
}

function cropAge(b) {
  try { const p = b.getProperties(); if (p && p.age !== undefined) return Number(p.age) } catch (e) { /* eski sürüm */ }
  return b.metadata
}

async function farm(inst, a, { cancelled }) {
  const bot = inst.bot
  const ids = Object.keys(CROPS).map((n) => inst.mcData.blocksByName[n]).filter(Boolean).map((b) => b.id)
  const spots = bot.findBlocks({ matching: ids, maxDistance: a.radius, count: 80 })
  let harvested = 0
  let replanted = 0
  for (const pos of spots) {
    if (cancelled()) break
    const b = bot.blockAt(pos)
    if (!b || !CROPS[b.name] || cropAge(b) < CROPS[b.name].max) continue
    if (!(await goTo(inst, new goals.GoalNear(pos.x, pos.y, pos.z, 2)))) continue
    try {
      await bot.dig(b)
      harvested++
      await sleep(200)
      let seed = findInv(inst, CROPS[b.name].seed)
      if (!seed && (await ensureItem(inst, CROPS[b.name].seed, 64))) seed = findInv(inst, CROPS[b.name].seed)
      const ground = bot.blockAt(pos.offset(0, -1, 0))
      if (seed && ground && ['farmland', 'soul_sand'].includes(ground.name)) {
        await bot.equip(seed, 'hand')
        await bot.placeBlock(ground, new Vec3(0, 1, 0))
        replanted++
      }
    } catch (e) { /* sıradaki */ }
  }
  if (cancelled()) return fail('iptal edildi')
  if (harvested > 0) { try { await pickup(inst, { radius: Math.min(a.radius, 10) }, { cancelled }) } catch (e) { /* */ } }
  return harvested > 0 ? ok(`${harvested} ekin hasat ettim, ${replanted} tanesini yeniden diktim`) : fail(`${a.radius} blok çevrede olgun ekin bulamadım`)
}

async function fish(inst, a, { cancelled }) {
  const bot = inst.bot
  const rod = findInv(inst, 'fishing_rod')
  if (!rod) return fail('envanterimde olta yok')
  const water = bot.findBlock({ matching: inst.mcData.blocksByName.water.id, maxDistance: 32 })
  if (!water) return fail('yakında su yok')
  await goTo(inst, new goals.GoalNear(water.position.x, water.position.y, water.position.z, 4))
  await bot.equip(rod, 'hand')
  await bot.lookAt(water.position.offset(0.5, 0.5, 0.5))
  const end = Date.now() + a.seconds * 1000
  let caught = 0
  while (!cancelled() && Date.now() < end && (a.catches === null || caught < a.catches)) {
    try {
      let timer
      const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('zaman aşımı')), 45000) })
      const aborted = (async () => { while (!cancelled()) await sleep(300); return 'iptal' })()
      const res = await Promise.race([bot.fish(), timeout, aborted])
      clearTimeout(timer)
      if (res === 'iptal') { try { bot.activateItem() } catch (e) {} break }
      caught++
    } catch (e) {
      try { bot.activateItem() } catch (err) { /* olta toplama */ }
      await sleep(600)
    }
  }
  return cancelled() ? fail('iptal edildi') : (caught > 0 ? ok(`${caught} balık tuttum`) : fail('hiçbir şey yakalayamadım'))
}

async function shear(inst, a, { cancelled }) {
  const bot = inst.bot
  const shears = findInv(inst, 'shears')
  if (!shears) return fail('envanterimde makas yok')
  const wool = () => bot.inventory.items().filter((i) => i.name.endsWith('_wool')).reduce((s, i) => s + i.count, 0)
  const before = wool()
  const sheep = Object.values(bot.entities).filter((e) => e.name === 'sheep' && e.position.distanceTo(bot.entity.position) <= a.radius)
  await bot.equip(shears, 'hand')
  for (const s of sheep.slice(0, 12)) {
    if (cancelled()) break
    await goTo(inst, new goals.GoalNear(s.position.x, s.position.y, s.position.z, 2))
    try { await bot.activateEntity(s) } catch (e) { /* atla */ }
    await sleep(400)
  }
  await sleep(500)
  const got = wool() - before
  return got > 0 ? ok(`${got} yün kırptım`) : fail(sheep.length ? 'koyunlar zaten kırpılmış olabilir' : 'yakında koyun yok')
}

const BREED_FOODS = {
  cow: ['wheat'], sheep: ['wheat'], mooshroom: ['wheat'], goat: ['wheat'], pig: ['carrot', 'potato', 'beetroot'], chicken: ['wheat_seeds', 'beetroot_seeds', 'melon_seeds', 'pumpkin_seeds'],
  horse: ['golden_carrot', 'golden_apple'], donkey: ['golden_carrot', 'golden_apple'], rabbit: ['carrot', 'golden_carrot', 'dandelion'], llama: ['hay_block'],
  wolf: ['beef', 'porkchop', 'mutton', 'chicken', 'rotten_flesh'], cat: ['cod', 'salmon'], fox: ['sweet_berries', 'glow_berries'], turtle: ['seagrass'],
  bee: ['poppy', 'dandelion', 'blue_orchid', 'allium', 'azure_bluet', 'cornflower'], camel: ['cactus'], panda: ['bamboo'],
}

async function breed(inst, a, { cancelled }) {
  const bot = inst.bot
  const me = bot.entity.position
  const isBaby = (e) => {
    const def = inst.mcData.entitiesByName[e.name]
    return !!(def && def.height && e.height && e.height < def.height * 0.8)
  }
  const near = (name) => Object.values(bot.entities)
    .filter((e) => e.name === name && e.position.distanceTo(me) <= 32 && !isBaby(e))
    .sort((x, y) => x.position.distanceTo(me) - y.position.distanceTo(me))
  const foodFor = (name) => {
    const list = a.itemName ? [a.itemName] : (BREED_FOODS[name] || [])
    return list.map((n) => findInv(inst, n)).find(Boolean) || null
  }
  // Tür belirtilmediyse: yakında en az 2 yetişkini olan ve yemi envanterde olan ilk tür
  const species = a.animal ? [a.animal] : Object.keys(BREED_FOODS)
  let pick = null
  const report = []
  for (const sp of species) {
    const list = near(sp)
    if (list.length === 0) continue
    const food = foodFor(sp)
    report.push(`${sp} x${list.length}${food ? '' : ` (yem yok: ${(BREED_FOODS[sp] || [])[0]})`}`)
    if (list.length >= 2 && food && !pick) pick = { sp, list: list.slice(0, 2), food }
  }
  if (!pick) {
    if (!report.length) return fail(`32 blok çevrede çiftleştirilecek hayvan göremedim${a.animal ? ` (${a.animal})` : ''}`)
    return fail(`çiftleştiremedim. Yakındakiler: ${report.join(', ')}. Her tür için en az 2 yetişkin ve envanterde yemi (örn. inek/koyun için wheat) olmalı`)
  }
  let fed = 0
  for (const an of pick.list) {
    if (cancelled()) break
    for (let t = 0; t < 3; t++) {
      const cur = bot.entities[an.id] || an
      await goTo(inst, new goals.GoalNear(cur.position.x, cur.position.y, cur.position.z, 1.8))
      try {
        await bot.equip(findInv(inst, pick.food.name) || pick.food, 'hand')
        await bot.lookAt(cur.position.offset(0, (cur.height || 1) * 0.6, 0), true)
        await sleep(160)
        await bot.activateEntity(cur)
        fed++
        break
      } catch (e) { await sleep(300) }
    }
    await sleep(450)
  }
  return fed === 2 ? ok(`iki ${pick.sp} yemledim (${pick.food.name}); bebek çıkması birkaç saniye sürer`) : fail(`sadece ${fed}/2 ${pick.sp} yemleyebildim`)
}

// ---------------------------------------------------------------- savaş
function findTarget(inst, a) {
  if (a.kind === 'player') return playerEntity(inst, a.name)
  return nearestEntity(inst, (e) => e.type !== 'player' && (a.kind === 'hostile' ? inst.isHostile(e) : e.name === a.name), 40)
}

async function attack(inst, a, { cancelled }) {
  let killed = 0
  for (let i = 0; i < a.count && !cancelled(); i++) {
    const target = findTarget(inst, a)
    if (!target) break
    await equipBestWeapon(inst)
    inst.bot.pvp.attack(target)
    await new Promise((resolve) => {
      const done = () => { clearTimeout(to); inst.bot.removeListener('stoppedAttacking', done); resolve() }
      const to = setTimeout(done, 30000)
      inst.bot.once('stoppedAttacking', done)
    })
    if (!cancelled()) killed++
  }
  if (cancelled()) return fail('iptal edildi')
  return killed === 0 ? fail(`yakında saldıracak ${a.name} bulamadım`) : ok(`${killed} hedefle savaştım`)
}

async function guard(inst, a, { sender }) {
  const e = sender && playerEntity(inst, sender)
  inst.guardPos = (e ? e.position : inst.bot.entity.position).clone()
  inst.guardRadius = a.radius
  inst.mode = 'guard'
  return ok('nöbete başladım')
}

async function shoot(inst, a, { cancelled }) {
  const bot = inst.bot
  const bow = findInv(inst, 'bow')
  if (!bow) return fail('envanterimde yay yok')
  if (invCount(inst, 'arrow') === 0) return fail('okum kalmamış')
  let shots = 0
  for (let i = 0; i < a.shots && !cancelled(); i++) {
    if (invCount(inst, 'arrow') === 0) break
    const t = findTarget(inst, a)
    if (!t) break
    const d = t.position.distanceTo(bot.entity.position)
    if (d > 28) await goTo(inst, new goals.GoalNear(t.position.x, t.position.y, t.position.z, 18))
    await bot.equip(bow, 'hand')
    await bot.lookAt(t.position.offset(0, (t.height || 1.6) * 0.9 + d * 0.04, 0))
    bot.activateItem()
    await sleep(1100)
    bot.deactivateItem()
    shots++
    await sleep(500)
  }
  return shots > 0 ? ok(`${shots} ok attım`) : fail('nişan alacak hedef bulamadım')
}

// ---------------------------------------------------------------- inşa
function bestFiller(inst) {
  const it = inst.bot.inventory.items().filter((i) => /(_planks|^cobblestone$|^stone$|stone_bricks|^bricks$|^dirt$|cobbled_deepslate|sandstone|^netherrack$|_concrete$|_wool$|_terracotta$)/.test(i.name)).sort((x, y) => y.count - x.count)[0]
  return it ? it.name : null
}

async function place(inst, a) {
  if (!findInv(inst, a.item.name) && !isCreative(inst)) {
    const alt = bestFiller(inst)
    if (alt && /(_planks|_log$|cobblestone|^stone$|bricks|dirt|deepslate|sandstone|netherrack|concrete|wool|terracotta)/.test(a.item.name) && !/(stairs|slab|door|fence|trapdoor)/.test(a.item.name)) a = { ...a, item: inst.mcData.itemsByName[alt] || a.item }
  }
  const res = await placeAt(inst, a.item.name, new Vec3(a.x, a.y, a.z), hintsFor(a.item.name, { facing: worldFacing(inst, a.facing), delay: a.delay }))
  const map = { ok: `${a.item.name} yerleştirdim`, full: 'orası zaten dolu', noitem: `envanterimde ${a.item.name} yok`, noref: 'yaslanacak komşu blok bulamadım' }
  return res === 'ok' ? ok(map.ok) : fail(map[res] || 'yerleştiremedim')
}

async function break_(inst, a) {
  const pos = new Vec3(a.x, a.y, a.z)
  const b = inst.bot.blockAt(pos)
  if (!b || isAir(b)) return fail('orada kırılacak blok yok')
  await goTo(inst, new goals.GoalLookAtBlock(pos, inst.bot.world))
  try { await digBlock(inst, inst.bot.blockAt(pos)); return ok(`${b.name} kırdım`) } catch (e) { return fail(e.message) }
}

function regionPositions(a) {
  const list = []
  for (let y = a.minY; y <= a.maxY; y++) {
    for (let x = a.minX; x <= a.maxX; x++) {
      for (let z = a.minZ; z <= a.maxZ; z++) {
        const edgeXZ = x === a.minX || x === a.maxX || z === a.minZ || z === a.maxZ
        const edgeY = y === a.minY || y === a.maxY
        if (a.mode === 'hollow' && !(edgeXZ || edgeY)) continue
        if (a.mode === 'walls' && !edgeXZ) continue
        if (a.mode === 'floor' && y !== a.minY) continue
        list.push(new Vec3(x, y, z))
      }
    }
  }
  return list
}


// ---------------------------------------------------------------- ortak yerleştirme motoru
// Tüm inşa eylemleri (şematik, build, fill, house, shelter, portal) blokları BOTUN KENDİSİ koyarak yapar; komut kullanılmaz.
// - Yaslanacak komşusu olan bloklar önce gelir (alttan yukarı); havada kalanlar için geçici iskele kurulur ve sonra kırılır.
// - Creative modundaysa eksik blokları kendi envanterine ekler ve uçarak yaklaşır.
const TEMP_BLOCKS = ['dirt', 'cobblestone', 'netherrack', 'stone', 'cobbled_deepslate', 'sand']
const INTERACTABLE = /(door|trapdoor|fence_gate|button|lever|chest|barrel|furnace|smoker|crafting_table|anvil|_bed$|shulker_box|note_block|dispenser|dropper|hopper|repeater|comparator|enchanting_table|brewing_stand|loom|stonecutter|lectern|cartography_table|smithing_table|grindstone|beacon|bell|cauldron|jukebox|daylight_detector|cake|command_block|_sign$)/
const ITEM_TO_BLOCK = { redstone: 'redstone_wire', wheat_seeds: 'wheat', carrot: 'carrots', potato: 'potatoes', beetroot_seeds: 'beetroots', string: 'tripwire' }

const isCreative = (inst) => {
  const b = inst.bot
  // game_state_change kaçsa bile oyuncu bilgisinden (gamemode 1 = creative) anla
  return !!((b.game && b.game.gameMode === 'creative') || (b.player && b.player.gamemode === 1))
}

async function ensureItem(inst, name, count = 64) {
  const bot = inst.bot
  if (invCount(inst, name) > 0) return true
  if (!isCreative(inst) || !bot.creative) return false
  const def = inst.mcData.itemsByName[name]
  if (!def) return false
  if (!inst.ItemClass) inst.ItemClass = require('prismarine-item')(bot.registry || bot.version)
  inst.creativeSlot = ((inst.creativeSlot === undefined ? -1 : inst.creativeSlot) + 1) % 9
  try {
    await bot.creative.setInventorySlot(36 + inst.creativeSlot, new inst.ItemClass(def.id, count, null))
    await sleep(80)
  } catch (e) { return false }
  return invCount(inst, name) > 0
}

// Hedefe erişim menziline gir: creative'de uçarak, değilse yürüyerek / kule çıkarak
async function moveNear(inst, pos) {
  const bot = inst.bot
  const reach = 4.3
  const within = () => bot.entity.position.offset(0, 1.62, 0).distanceTo(pos.offset(0.5, 0.5, 0.5)) <= reach
  if (within()) return
  if (isCreative(inst) && bot.creative && bot.creative.flyTo) {
    const solid = (x, y, z) => { const b = bot.blockAt(new Vec3(x, y, z)); return !!b && b.boundingBox === 'block' }
    const free2 = (x, y, z) => !solid(x, y, z) && !solid(x, y + 1, z)
    // hedefe erişim menzilinde, içi boş bir duruş noktası seç (önce tepesi, sonra yanları)
    const offs = [[0, 0], [2, 0], [-2, 0], [0, 2], [0, -2], [2, 2], [-2, 2], [2, -2], [-2, -2], [3, 0], [-3, 0], [0, 3], [0, -3]]
    let stand = null
    for (const dy of [2, 3, 1, 4, 0]) {
      for (const [dx, dz] of offs) {
        const sx = pos.x + dx
        const sy = pos.y + dy
        const sz = pos.z + dz
        if (!free2(sx, sy, sz)) continue
        const d = new Vec3(sx + 0.5, sy + 1.62, sz + 0.5).distanceTo(pos.offset(0.5, 0.5, 0.5))
        if (d <= reach - 0.3) { stand = new Vec3(sx + 0.5, sy, sz + 0.5); break }
      }
      if (stand) break
    }
    if (stand) {
      const flyTo = (v) => Promise.race([bot.creative.flyTo(v), sleep(9000).then(() => { throw new Error('flyTo zaman aşımı') })])
      try {
        if (!bot.creative.flying && bot.creative.startFlying) bot.creative.startFlying()
        const cur = bot.entity.position.clone()
        // yol boyunca en yüksek katı blok: üstünden uç (yapıların içinden geçme)
        let top = Math.max(cur.y, stand.y)
        const steps = Math.max(2, Math.ceil(cur.distanceTo(stand) / 3))
        for (let k = 0; k <= steps; k++) {
          const x = Math.floor(cur.x + ((stand.x - cur.x) * k) / steps)
          const z = Math.floor(cur.z + ((stand.z - cur.z) * k) / steps)
          for (let y = Math.floor(Math.max(cur.y, stand.y)) + 24; y > Math.floor(Math.min(cur.y, stand.y)) - 8; y--) {
            if (solid(x, y, z)) { top = Math.max(top, y + 3); break }
          }
        }
        const hover = Math.min(318, Math.max(top, cur.y))
        if (hover > cur.y + 0.1) await flyTo(new Vec3(cur.x, hover, cur.z))
        await flyTo(new Vec3(stand.x, hover, stand.z))
        if (stand.y < hover - 0.1) await flyTo(stand)
        if (within()) return
      } catch (e) { /* aşağıdaki yedeklere geç */ }
      // OP ise ışınlan
      try {
        if ((await OpBuild.available(inst)) && inst._op && inst._op.mode === 'vanilla') {
          bot.chat(`/tp @s ${stand.x.toFixed(1)} ${stand.y.toFixed(1)} ${stand.z.toFixed(1)}`)
          await sleep(500)
          if (within()) return
        }
      } catch (e) { /* yoksay */ }
    }
  }
  await goTo(inst, new goals.GoalNear(pos.x, pos.y, pos.z, 3))
}

// Creative'de (ya da OP ise /give ile) eşyayı KENDİ envanterine alır; kimseye atmaz.
async function get_item(inst, a) {
  const bot = inst.bot
  const name = a.item.name
  const want = a.count
  const have0 = invCount(inst, name)
  if (have0 >= want) return ok(`envanterimde zaten ${have0} ${name} var`)
  if (isCreative(inst) && bot.creative) {
    const per = Math.min(64, (inst.mcData.itemsByName[name] && inst.mcData.itemsByName[name].stackSize) || 64)
    let guard = 0
    while (invCount(inst, name) < want && guard++ < 36) {
      const slot = bot.inventory.firstEmptyInventorySlot ? bot.inventory.firstEmptyInventorySlot(true) : null
      if (slot === null || slot === undefined) return fail(`envanter dolu, ${invCount(inst, name)}/${want} ${name} alabildim`)
      const sl = slot >= 36 && slot <= 44 ? slot : slot
      try {
        if (!inst.ItemClass) inst.ItemClass = require('prismarine-item')(bot.registry || bot.version)
        await bot.creative.setInventorySlot(sl, new inst.ItemClass(inst.mcData.itemsByName[name].id, per, null))
        await sleep(90)
      } catch (e) { return fail(`creative envanterden alamadım (${e.message})`) }
    }
    const got = invCount(inst, name)
    return got >= want ? ok(`creative'den ${got} ${name} aldım (envanterimde)`) : fail(`sadece ${got}/${want} ${name} alabildim`)
  }
  try {
    if ((await OpBuild.available(inst)) && inst._op && inst._op.mode === 'vanilla') {
      bot.chat(`/give ${bot.username} ${name} ${want - have0}`)
      for (let t = 0; t < 12 && invCount(inst, name) < want; t++) await sleep(250)
      const got = invCount(inst, name)
      if (got > have0) return ok(`/give ile ${got - have0} ${name} aldım (envanterimde ${got})`)
    }
  } catch (e) { /* aşağıya düş */ }
  return fail(`${name} alamadım: creative modda değilim ve OP yetkim yok (survival'da ${name} toplamam ya da craft etmem gerekir)`)
}

async function tillBlock(inst, pos) {
  const bot = inst.bot
  const cur = bot.blockAt(pos)
  if (!cur) return false
  if (cur.name === 'farmland') return true
  let hoe = bot.inventory.items().find((i) => i.name.endsWith('_hoe'))
  if (!hoe && (await ensureItem(inst, 'diamond_hoe', 1))) hoe = findInv(inst, 'diamond_hoe')
  if (!hoe) return false
  try { await bot.equip(hoe, 'hand'); await bot.activateBlock(cur); await sleep(150) } catch (e) { return false }
  const after = bot.blockAt(pos)
  return !!after && after.name === 'farmland'
}

async function placeLiquid(inst, name, pos) {
  const bot = inst.bot
  const bucketName = `${name}_bucket`
  if (!(await ensureItem(inst, bucketName, 1))) return 'noitem'
  const cur = bot.blockAt(pos)
  if (cur && cur.name === name) return 'full'
  await moveNear(inst, pos)
  for (const f of [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
    const ref = bot.blockAt(pos.offset(f[0], f[1], f[2]))
    if (!ref || isAir(ref) || isLiquid(ref)) continue
    const bucket = findInv(inst, bucketName)
    if (!bucket) return 'noitem'
    try {
      await bot.equip(bucket, 'hand')
      await bot.lookAt(ref.position.offset(0.5 - f[0] * 0.5, 0.5 - f[1] * 0.5, 0.5 - f[2] * 0.5), true)
      bot.activateItem()
      await sleep(450)
      const after = bot.blockAt(pos)
      if (after && after.name === name) return 'ok'
    } catch (e) { /* diğer yüzü dene */ }
  }
  return 'noref'
}

// Tek hedefi koy (yanlış blok varsa önce kır; özel türleri işle)
async function placeOne(inst, t, creative) {
  const bot = inst.bot
  if (t.kind === 'liquid') return placeLiquid(inst, t.blockName, t.pos)
  const cur = bot.blockAt(t.pos)
  if (cur && !REPLACEABLE.has(cur.name) && cur.name !== t.blockName) {
    if (!cur.diggable) return 'full'
    try { await moveNear(inst, t.pos); await digBlock(inst, cur) } catch (e) { return 'full' }
  }
  if (creative && !(await ensureItem(inst, t.item))) return 'noitem'
  const r = await placeAt(inst, t.item, t.pos, t.hints || {})
  if (r !== 'ok') return r
  if (t.kind === 'double') {
    // çift slab: ilk slabın üst yüzüne ikinci slabı koy
    try {
      const first = bot.blockAt(t.pos)
      const again = findInv(inst, t.item) || ((creative && (await ensureItem(inst, t.item))) ? findInv(inst, t.item) : null)
      if (first && again) {
        await bot.equip(again, 'hand')
        await bot.lookAt(first.position.offset(0.5, 1, 0.5), true)
        await bot.activateBlock(first, new Vec3(0, 1, 0))
        await sleep(120)
      }
    } catch (e) { /* ilk slab yerinde kalır */ }
  } else if (t.kind === 'farmland') {
    if (!(await tillBlock(inst, t.pos))) return 'nohoe'
  }
  return 'ok'
}

/**
 * targets: [{ pos:Vec3, item:string (envanter adı), blockName:string, hints?, kind?:'normal'|'liquid'|'double'|'farmland' }]
 * opts: { cancelled, partial, label }
 */
// Elle konamayan tek bir blok için OP komutunu dene (su içi/havada yaslanacak yer olmayan bloklar)
async function opCmdOne(inst, t, cancelled) {
  try {
    const d = await OpBuild.placeTargets(inst, [t], cancelled, { min: 1 })
    return d.has(t)
  } catch (e) { return false }
}

async function placeMany(inst, targets, opts = {}) {
  const bot = inst.bot
  const cancelled = opts.cancelled || (() => false)
  const creative = isCreative(inst)
  const stats = { total: targets.length, placed: 0, failed: 0, noitem: 0, already: 0, scaffolds: 0, unreachable: 0, cancelled: false, blocked: null }

  const todo = []
  for (const t of targets) {
    const cur = bot.blockAt(t.pos)
    if (cur && cur.name === t.blockName) stats.already++
    else todo.push(t)
  }

  // OP ise /fill ve /setblock ile kur (doğrulananlar listeden düşer, kalanlar elle konur)
  if (opts.cmd !== false && todo.length) {
    try {
      const doneSet = await OpBuild.placeTargets(inst, todo, cancelled)
      if (doneSet.size) {
        stats.placed += doneSet.size
        stats.viaCommand = doneSet.size
        for (let i = todo.length - 1; i >= 0; i--) if (doneSet.has(todo[i])) todo.splice(i, 1)
      }
    } catch (e) { /* komut yolu başarısızsa elle devam */ }
  }

  // Malzeme ikamesi: bir yapı bloğu yetmezse envanterdeki diğer yapı bloklarıyla tamamla (survival)
  if (!creative && opts.flex !== false) {
    const FILL = /(_planks|_log$|_wood$|^cobblestone$|^stone$|stone_bricks|^bricks$|^dirt$|^coarse_dirt$|deepslate|sandstone|^netherrack$|_concrete$|_wool$|_terracotta$|^terracotta$|^andesite$|^diorite$|^granite$|^tuff|^blackstone|^basalt|^sand$|^gravel$|^glass$|^mud_bricks$|^prismarine|^end_stone|^purpur)/
    const BAD = /(stairs|slab|door|fence|_wall$|trapdoor|button|plate|sign|carpet|pane|powder)/
    const isFill = (n) => FILL.test(n) && !BAD.test(n)
    const own = {}
    for (const t of todo) if (!t.kind || t.kind === 'normal') own[t.item] = (own[t.item] || 0) + 1
    const spare = {}
    for (const it of bot.inventory.items()) {
      if (isFill(it.name) && it.name !== 'sand' && it.name !== 'gravel') spare[it.name] = (spare[it.name] || 0) + it.count
    }
    for (const n of Object.keys(spare)) spare[n] = Math.max(0, spare[n] - (own[n] || 0))
    const have = (n) => invCount(inst, n)
    const used = {}
    stats.substituted = 0
    for (const t of todo) {
      if ((t.kind && t.kind !== 'normal') || !isFill(t.item)) continue
      used[t.item] = (used[t.item] || 0) + 1
      if (used[t.item] <= have(t.item)) continue
      const alt = Object.keys(spare).filter((n) => spare[n] > 0).sort((a, b) => spare[b] - spare[a])[0]
      if (!alt) continue
      spare[alt]--
      used[alt] = (used[alt] || 0) + 1
      t.item = alt
      t.blockName = ITEM_TO_BLOCK[alt] || alt
      stats.substituted++
    }
  }

  // malzeme kontrolü (creative'de gerekmez)
  const need = {}
  for (const t of todo) need[t.item] = (need[t.item] || 0) + (t.kind === 'double' ? 2 : 1)
  if (!creative) {
    const missing = Object.entries(need).filter(([n, k]) => invCount(inst, n) < k).map(([n, k]) => `${n} (${invCount(inst, n)}/${k})`)
    if (todo.some((t) => t.kind === 'farmland') && !bot.inventory.items().some((i) => i.name.endsWith('_hoe'))) missing.push('çapa (hoe)')
    if (missing.length && !opts.partial) {
      stats.blocked = `malzeme eksik, başlamadım -> ${missing.slice(0, 10).join(', ')}. Oyun modum creative değil (${(bot.game && bot.game.gameMode) || '?'}) ve OP komutu kullanamıyorum; creative/OP ver ya da malzemeyi envanterime koy. Eksik olanla devam etmemi istersen "partial" de`
      return stats
    }
  }

  const worldSolid = (x, y, z) => {
    const b = bot.blockAt(new Vec3(x, y, z))
    return !!b && !isAir(b) && !isLiquid(b) && b.boundingBox === 'block' && Builder.canSupport(b.name)
  }
  const plan = Builder.planBuild(todo.map((t) => ({ pos: t.pos, name: t.blockName })), worldSolid)
  stats.unreachable = plan.unreachable.length
  const remainingNeed = { ...need }
  const scaffolded = []
  const pickTemp = async () => {
    if (creative) return (await ensureItem(inst, 'cobblestone')) ? 'cobblestone' : null
    return TEMP_BLOCKS.find((n) => invCount(inst, n) - (remainingNeed[n] || 0) > 0) || null
  }

  let n = 0
  const retry = []
  for (const st of plan.steps) {
    if (cancelled()) { stats.cancelled = true; break }
    if (st.kind === 'scaffold') {
      const name = await pickTemp()
      if (!name) { stats.failed++; continue }
      const r = await placeAt(inst, name, new Vec3(st.pos.x, st.pos.y, st.pos.z))
      if (r === 'ok') { scaffolded.push(st.pos); stats.scaffolds++ }
      continue
    }
    const t = todo[st.i]
    let r = await placeOne(inst, t, creative)
    if (r !== 'ok' && r !== 'full' && r !== 'noitem' && opts.cmd !== false) r = (await opCmdOne(inst, t, cancelled)) ? 'ok' : r
    remainingNeed[t.item] = Math.max(0, (remainingNeed[t.item] || 0) - (t.kind === 'double' ? 2 : 1))
    if (r === 'ok') stats.placed++
    else if (r === 'noitem') stats.noitem++
    else if (r !== 'full') retry.push(t)   // menzil/yaslanma sorunu: sonra tekrar denenecek
    n++
    if (n % 40 === 0) inst.log('action', `${opts.label || 'inşa'}: ${n}/${todo.length}`)
  }

  // Yeniden deneme: kalanlar bota en yakından başlayarak (komşu bloklar artık yerinde olabilir), en çok 2 geçiş
  let pending = retry
  for (let pass = 0; pass < 2 && pending.length && !(cancelled() || stats.cancelled); pass++) {
    inst.log('action', `${opts.label || 'inşa'}: ${pending.length} blok için ${pass + 1}. tekrar deneme`)
    const next = []
    pending.sort((a, b) => bot.entity.position.distanceTo(a.pos) - bot.entity.position.distanceTo(b.pos))
    for (const t of pending) {
      if (cancelled()) { stats.cancelled = true; break }
      const cur = bot.blockAt(t.pos)
      if (cur && cur.name === t.blockName) { stats.placed++; continue }
      let r = await placeOne(inst, t, creative)
      if (r !== 'ok' && r !== 'full' && r !== 'noitem' && opts.cmd !== false) r = (await opCmdOne(inst, t, cancelled)) ? 'ok' : r
      if (r === 'ok') stats.placed++
      else if (r === 'noitem') stats.noitem++
      else if (r !== 'full') next.push(t)
    }
    pending = next
  }
  stats.failed += pending.length

  // iskeleyi yukarıdan aşağı kır
  const placedScaf = new Set(scaffolded.map((p) => `${p.x},${p.y},${p.z}`))
  for (const p of plan.cleanup) {
    if (!placedScaf.has(`${p.x},${p.y},${p.z}`)) continue
    const b = bot.blockAt(new Vec3(p.x, p.y, p.z))
    if (!b || isAir(b)) continue
    try { await moveNear(inst, b.position); await digBlock(inst, b) } catch (e) { /* kalabilir */ }
  }
  return stats
}

function summarizeBuild(s, label = 'blok') {
  if (s.blocked) return fail(s.blocked)
  const parts = [`${s.placed}/${s.total - s.already} ${label} koydum`]
  if (s.viaCommand) parts.push(`${s.viaCommand} tanesi OP komutuyla`)
  if (s.already) parts.push(`${s.already} zaten yerinde`)
  if (s.substituted) parts.push(`${s.substituted} blokta eksik malzemeyi envanterdeki diğer bloklarla tamamladım`)
  if (s.scaffolds) parts.push(`${s.scaffolds} iskele bloğu kurup kırdım`)
  if (s.failed) parts.push(`${s.failed} tanesi olmadı`)
  if (s.noitem) parts.push(`${s.noitem} tanesinde malzeme bitti`)
  if (s.unreachable) parts.push(`${s.unreachable} tanesine ulaşamadım (altında zemin yok)`)
  if (s.cancelled) return fail(`iptal edildi: ${parts.join(', ')} (aynı komutu tekrar verirsen kaldığı yerden devam eder)`)
  const bad = s.failed + s.noitem + s.unreachable
  return bad <= Math.max(2, (s.total - s.already) * 0.15) ? ok(parts.join(', ')) : fail(`${parts.join(', ')}. Aynı komutu tekrar vererek kalanı tamamlatabilirsin`)
}

async function buildPositions(inst, positions, itemName, cancelled) {
  const targets = positions.map((p) => ({ pos: p, item: itemName, blockName: ITEM_TO_BLOCK[itemName] || itemName }))
  return summarizeBuild(await placeMany(inst, targets, { cancelled }))
}

async function fill(inst, a, { cancelled }) {
  const positions = regionPositions(a)
  if (a.clear) {
    try { const c = await OpBuild.clearPositions(inst, positions, cancelled); if (c >= 0) return ok(`${c} bloğu OP komutuyla temizledim`) } catch (e) { /* elle dene */ }
    let dug = 0
    positions.sort((p, q) => q.y - p.y)
    for (const p of positions) {
      if (cancelled()) return fail('iptal edildi')
      const b = inst.bot.blockAt(p)
      if (!b || isAir(b) || !b.diggable) continue
      try {
        await goTo(inst, new goals.GoalLookAtBlock(p, inst.bot.world))
        await digBlock(inst, inst.bot.blockAt(p))
        dug++
      } catch (e) { if (/uygun aletim yok/.test(e.message)) return fail(`${dug} blok kazdım, sonra: ${e.message}`) }
    }
    return ok(`${dug} bloğu temizledim`)
  }
  positions.sort((p, q) => p.y - q.y)
  return buildPositions(inst, positions, a.item.name, cancelled)
}

async function shelter(inst, a, { cancelled }) {
  const bot = inst.bot
  const c = bot.entity.position.floored()
  let name = a.item && a.item.name
  if (!name) {
    const cand = bot.inventory.items().filter((i) => inst.mcData.blocksByName[i.name] && /cobblestone|dirt|planks|stone|deepslate|netherrack|sand|log/.test(i.name))
      .sort((x, y) => y.count - x.count)[0]
    if (!cand) return fail('barınak için kullanabileceğim blok yok')
    name = cand.name
  }
  const half = a.size === 'medium' ? 2 : 1
  const wallH = a.size === 'medium' ? 2 : 2
  const list = []
  for (let y = 0; y <= wallH; y++) {
    for (let x = -half; x <= half; x++) {
      for (let z = -half; z <= half; z++) {
        const ring = Math.abs(x) === half || Math.abs(z) === half
        const roof = y === wallH
        if (!ring && !roof) continue
        if (a.size === 'medium' && x === 0 && z === half && y < 2) continue   // kapı boşluğu
        list.push({ v: new Vec3(c.x + x, c.y + y, c.z + z), d: Math.abs(x) + Math.abs(z), y })
      }
    }
  }
  list.sort((p, q) => p.y - q.y || q.d - p.d)
  return buildPositions(inst, list.map((l) => l.v), name, cancelled)
}

// ---------------------------------------------------------------- envanter
async function equip(inst, a) {
  if (!findInv(inst, a.item.name) && isCreative(inst)) await ensureItem(inst, a.item.name)
  const it = findInv(inst, a.item.name)
  if (!it) return fail(`envanterimde ${a.item.name} yok`)
  try { await inst.bot.equip(it, a.slot); return ok(`${a.item.name} kuşandım`) } catch (e) { return fail(`kuşanamadım (${e.message})`) }
}

async function drop(inst, a) {
  const have = invCount(inst, a.item.name)
  if (!have) return fail(`envanterimde ${a.item.name} yok`)
  const n = a.count === null ? have : Math.min(have, a.count)
  await inst.bot.toss(a.item.id, null, n)
  return ok(`${n} adet ${a.item.name} attım`)
}

async function give(inst, a) {
  if (!invCount(inst, a.item.name) && isCreative(inst)) await ensureItem(inst, a.item.name, a.count || 64)
  const have = invCount(inst, a.item.name)
  if (!have) return fail(`envanterimde ${a.item.name} yok`)
  const e = playerEntity(inst, a.target)
  if (!e) return fail(`${a.target} çok uzakta`)
  await goTo(inst, new goals.GoalNear(e.position.x, e.position.y, e.position.z, 2))
  await inst.bot.lookAt(e.position.offset(0, e.height || 1.6, 0))
  const n = a.count === null ? have : Math.min(have, a.count)
  await inst.bot.toss(a.item.id, null, n)
  return ok(`${a.target} oyuncusuna ${n} adet ${a.item.name} verdim`)
}

async function placeTable(inst, tableItem) {
  const bot = inst.bot
  try { await bot.equip(tableItem, 'hand') } catch (e) { return null }
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const ref = bot.blockAt(bot.entity.position.offset(dx, -1, dz))
    const above = bot.blockAt(bot.entity.position.offset(dx, 0, dz))
    if (ref && ref.boundingBox === 'block' && above && isAir(above)) {
      try { await bot.placeBlock(ref, new Vec3(0, 1, 0)); return bot.blockAt(above.position) } catch (e) { /* diğer yön */ }
    }
  }
  return null
}

// ---------------------------------------------------------------- üretim (ara ürünleri de kendisi üretir)
const plankFor = (inst, item) => {
  if (!/_planks$/.test(item.name) || invCount(inst, item.name.replace('_planks', '_log'))) return item
  const log = inst.bot.inventory.items().find((i) => /_(log|stem)$/.test(i.name) && !i.name.startsWith('stripped_'))
  const alt = log && inst.mcData.itemsByName[log.name.replace(/_(log|stem)$/, '_planks')]
  return alt || item
}

async function ensureTableNear(inst, cancelled, depth) {
  const bot = inst.bot
  const id = inst.mcData.blocksByName.crafting_table.id
  let table = bot.findBlock({ matching: id, maxDistance: 32 })
  if (!table) {
    let ti = findInv(inst, 'crafting_table')
    if (!ti && depth < 3) { await craftItem(inst, inst.mcData.itemsByName.crafting_table, 1, cancelled, depth + 1); ti = findInv(inst, 'crafting_table') }
    if (ti) {
      table = await placeTable(inst, ti)
      if (!table) {   // yerleştirme yedeği: yakındaki boş zemine placeAt
        const f = bot.entity.position.floored()
        for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2], [1, 1], [-1, -1]]) {
          if ((await placeAt(inst, 'crafting_table', f.offset(dx, 0, dz))) === 'ok') { table = bot.blockAt(f.offset(dx, 0, dz)); break }
        }
      }
    }
  }
  if (table) await goTo(inst, new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2), { cancelled, retries: 1, timeoutMs: 20000 })
  return table
}

const itemNameById = (inst, id) => (inst.mcData.items[id] && inst.mcData.items[id].name) || String(id)

// En az eksiği olan tarifi seç: { recipe, missing:[{id,need,have}] }
function bestRecipe(inst, item) {
  const bot = inst.bot
  const all = bot.recipesAll(item.id, null, true)
  let best = null
  for (const r of all) {
    const missing = []
    for (const d of r.delta) {
      if (d.count >= 0) continue
      const need = -d.count
      const have = bot.inventory.count(d.id, d.metadata ?? null)
      if (have < need) missing.push({ id: d.id, need: need - have })
    }
    const score = missing.reduce((x, m) => x + m.need, 0)
    if (!best || score < best.score) best = { recipe: r, missing, score }
  }
  return best
}

async function craftItem(inst, item, count, cancelled, depth) {
  const bot = inst.bot
  item = plankFor(inst, item)
  const start = invCount(inst, item.name)
  const target = start + count
  let table = null
  let lastMissing = null
  for (let round = 0; round < 8 && invCount(inst, item.name) < target && !cancelled(); round++) {
    let recipes = bot.recipesFor(item.id, null, 1, null)
    let useTable = null
    if (!recipes.length && item.name !== 'crafting_table') {
      if (!table) table = await ensureTableNear(inst, cancelled, depth)
      if (table) { useTable = table; recipes = bot.recipesFor(item.id, null, 1, table) }
    }
    if (recipes.length) {
      const recipe = recipes[0]
      const per = (recipe.result && recipe.result.count) || 1
      const times = Math.max(1, Math.ceil((target - invCount(inst, item.name)) / per))
      try { await bot.craft(recipe, times, useTable) } catch (e) { lastMissing = `üretim hatası: ${e.message}`; break }
      continue
    }
    // Tarif için malzeme eksik: eksik malzemeleri ara ürün olarak üretmeyi dene (tahta, çubuk, külçe bloğu...)
    const best = bestRecipe(inst, item)
    if (!best || !best.missing.length) { lastMissing = 'uygun tarif yok'; break }
    lastMissing = best.missing.map((m) => `${m.need}x ${itemNameById(inst, m.id)}`).join(', ')
    if (depth >= 3) break
    let progressed = false
    for (const m of best.missing) {
      const ing = inst.mcData.items[m.id]
      if (!ing || !(inst.mcData.recipes[m.id] || []).length) continue
      const before = invCount(inst, ing.name)
      await craftItem(inst, ing, m.need, cancelled, depth + 1)
      if (invCount(inst, ing.name) > before) progressed = true
    }
    if (!progressed) break
  }
  return { made: invCount(inst, item.name) - start, item, missing: lastMissing }
}

async function craft(inst, a, { cancelled }) {
  const r = await craftItem(inst, a.item, a.count, cancelled, 0)
  if (cancelled()) return fail('iptal edildi')
  if (r.made >= a.count) return ok(`${r.made} adet ${r.item.name} ürettim`)
  if (r.made > 0) return ok(`${r.made}/${a.count} adet ${r.item.name} ürettim (malzeme yetmedi${r.missing ? `: eksik ${r.missing}` : ''})`)
  return fail(`${r.item.name} üretemedim${r.missing ? `, eksik: ${r.missing}` : ''}`)
}

async function smelt(inst, a, { cancelled }) {
  const bot = inst.bot
  const input = findInv(inst, a.item.name)
  if (!input) return fail(`envanterimde ${a.item.name} yok`)
  let furnace = bot.findBlock({ matching: ['furnace', 'blast_furnace', 'smoker'].map((n) => inst.mcData.blocksByName[n]).filter(Boolean).map((b) => b.id), maxDistance: 32 })
  if (!furnace) {
    const fi = findInv(inst, 'furnace')
    if (!fi) return fail('yakında fırın yok, envanterimde de fırın yok')
    furnace = await placeTable(inst, fi)
    if (!furnace) return fail('fırını yere koyamadım')
  }
  await goTo(inst, new goals.GoalLookAtBlock(furnace.position, bot.world))
  const count = Math.min(a.count, input.count)
  const fuelOrder = ['coal', 'charcoal', 'blaze_rod', 'dried_kelp_block']
  let fuel = fuelOrder.map((n) => findInv(inst, n)).find(Boolean)
  let fuelNeed = fuel ? Math.ceil(count / (fuel.name === 'blaze_rod' ? 12 : 8)) : 0
  if (!fuel) {
    fuel = bot.inventory.items().find((i) => i.name.endsWith('_planks')) || bot.inventory.items().find((i) => i.name.endsWith('_log') && i.name !== input.name)
    fuelNeed = fuel ? Math.ceil(count / 1.5) : 0
  }
  if (!fuel) return fail('yakıt (kömür/odun) yok')
  const f = await bot.openFurnace(furnace)
  let collected = 0
  try {
    await f.putFuel(fuel.type, null, Math.min(fuelNeed, fuel.count))
    await f.putInput(input.type, null, count)
    const end = Date.now() + count * 11000 + 8000
    while (!cancelled() && collected < count && Date.now() < end) {
      await sleep(1000)
      if (f.outputItem()) { const it = await f.takeOutput(); if (it) collected += it.count }
    }
  } finally {
    try { f.close() } catch (e) { /* kapalı */ }
  }
  if (cancelled()) return fail('iptal edildi, fırındakiler pişmeye devam eder')
  return collected >= count ? ok(`${collected} adet ${a.item.name} pişirdim`) : fail(`${collected}/${count} pişirebildim`)
}

async function eat(inst) {
  return (await inst.autoEat(true)) ? ok('yemek yedim') : fail('yiyecek yok ya da zaten tokum')
}

async function use_item(inst, a) {
  const bot = inst.bot
  if (a.item) {
    const it = findInv(inst, a.item.name)
    if (!it) return fail(`envanterimde ${a.item.name} yok`)
    await bot.equip(it, 'hand')
  }
  if (!bot.heldItem) return fail('elim boş')
  const name = bot.heldItem.name
  if (a.pos) {
    const pos = new Vec3(a.pos.x, a.pos.y, a.pos.z)
    await goTo(inst, new goals.GoalNear(pos.x, pos.y, pos.z, 3))
    const target = bot.blockAt(pos)
    await bot.lookAt(pos.offset(0.5, 0.5, 0.5))
    if (target && !isAir(target) && !isLiquid(target)) {
      try { await bot.activateBlock(target) } catch (e) { return fail(`${name} kullanılamadı (${e.message})`) }
    } else {
      bot.activateItem()
      await sleep(600)
      try { bot.deactivateItem() } catch (e) { /* önemsiz */ }
    }
    return ok(`${name} hedefe kullandım`)
  }
  bot.activateItem()
  await sleep(600)
  try { bot.deactivateItem() } catch (e) { /* önemsiz */ }
  return ok(`${name} kullandım`)
}

async function store(inst, a) {
  const have = invCount(inst, a.item.name)
  if (!have) return fail(`envanterimde ${a.item.name} yok`)
  let c
  try { c = await openNearestContainer(inst, a) } catch (e) { return fail(e.message) }
  try {
    const n = a.count === null ? have : Math.min(have, a.count)
    await c.deposit(a.item.id, null, n)
    return ok(`${n} adet ${a.item.name} sandığa koydum`)
  } catch (e) { return fail(`koyamadım (${e.message})`) } finally { try { c.close() } catch (e) {} }
}

async function take(inst, a) {
  let c
  try { c = await openNearestContainer(inst, a) } catch (e) { return fail(e.message) }
  try {
    const inside = c.containerItems().filter((i) => i.type === a.item.id).reduce((s, i) => s + i.count, 0)
    if (!inside) return fail(`sandıkta ${a.item.name} yok`)
    const n = a.count === null ? inside : Math.min(inside, a.count)
    await c.withdraw(a.item.id, null, n)
    return ok(`sandıktan ${n} adet ${a.item.name} aldım`)
  } catch (e) { return fail(`alamadım (${e.message})`) } finally { try { c.close() } catch (e) {} }
}

async function inspect_chest(inst, a) {
  let c
  try { c = await openNearestContainer(inst, a) } catch (e) { return fail(e.message) }
  try {
    const sum = {}
    c.containerItems().forEach((i) => { sum[i.name] = (sum[i.name] || 0) + i.count })
    const text = Object.entries(sum).map(([n, k]) => `${n} x${k}`).join(', ')
    return ok(text ? `sandıkta: ${text}` : 'sandık boş')
  } finally { try { c.close() } catch (e) {} }
}

async function trade(inst, a) {
  const bot = inst.bot
  const e = nearestEntity(inst, (x) => x.name === 'villager' || x.name === 'wandering_trader', 40)
  if (!e) return fail('40 blok çevrede köylü ya da gezgin tüccar göremedim')
  // Meslek yoksa (nitwit / işsiz) takas olmaz
  await goTo(inst, new goals.GoalNear(e.position.x, e.position.y, e.position.z, 2))
  const cur = bot.entities[e.id] || e
  try { await bot.lookAt(cur.position.offset(0, (cur.height || 1.8) * 0.8, 0), true) } catch (err) { /* yoksay */ }
  let v
  try { v = await bot.openVillager(cur) } catch (err) { return fail(`köylüyle konuşamadım (${err.message}). İşsiz köylüler (yeşil cüppeli) takas yapmaz; meslek bloğu (örn. fletching_table, lectern) koymak gerekir`) }
  try {
    const trades = v.trades || []
    const nm = (it) => (it ? `${it.count || 1} ${it.name}` : null)
    const describe = (t) => `${[nm(t.inputItem1), nm(t.inputItem2)].filter(Boolean).join(' + ')} -> ${nm(t.outputItem)}${t.tradeDisabled ? ' (tükenmiş)' : ''}`
    if (!trades.length) return fail('bu köylünün takas listesi boş (işsiz olabilir)')
    if (!a.item) return ok(`köylünün teklifleri: ${trades.slice(0, 8).map(describe).join(' | ')}`)
    // önce "ürün olarak istenen" eşleşmesi, yoksa "verdiğim eşya" eşleşmesi (örn. buğday satıp zümrüt almak)
    let idx = trades.findIndex((t) => t.outputItem && t.outputItem.name === a.item.name && !t.tradeDisabled)
    if (idx === -1) idx = trades.findIndex((t) => t.inputItem1 && t.inputItem1.name === a.item.name && !t.tradeDisabled)
    if (idx === -1) return fail(`köylüde ${a.item.name} yok. Teklifler: ${trades.slice(0, 8).map(describe).join(' | ')}`)
    const t = trades[idx]
    for (const inp of [t.inputItem1, t.inputItem2]) {
      if (inp && invCount(inst, inp.name) < (inp.count || 1)) return fail(`takas için ${inp.count || 1} ${inp.name} lazım, ${invCount(inst, inp.name)} tane var (teklif: ${describe(t)})`)
    }
    await bot.trade(v, idx, a.count)
    return ok(`takas yaptım: ${describe(t)} (x${a.count})`)
  } catch (err) { return fail(`takas olmadı (${err.message})`) } finally { try { v.close() } catch (err) { /* yoksay */ } }
}

// ---------------------------------------------------------------- dünya
async function activate_block(inst, a) {
  const bot = inst.bot
  let block
  if (a.pos) block = bot.blockAt(new Vec3(a.pos.x, a.pos.y, a.pos.z))
  else block = bot.findBlock({ matching: a.defs.map((d) => d.id), maxDistance: 32 })
  if (!block) return fail('uygun blok bulamadım')
  await goTo(inst, new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2))
  try { await bot.activateBlock(block); return ok(`${block.name} bloğuna sağ tıkladım`) } catch (e) { return fail(`etkileşim olmadı (${e.message})`) }
}

async function find(inst, a) {
  const bot = inst.bot
  const p = bot.entity.position
  const fmt = (v) => `${Math.floor(v.x)}, ${Math.floor(v.y)}, ${Math.floor(v.z)} (${Math.round(v.distanceTo(p))} blok)`
  if (a.kind === 'block') {
    const list = bot.findBlocks({ matching: a.defs.map((d) => d.id), maxDistance: 128, count: 4 })
    return list.length ? ok(`en yakın ${a.label}: ${list.map(fmt).join(' | ')}`) : fail(`128 blok çevrede ${a.label} görünmüyor`)
  }
  if (a.kind === 'player') {
    const e = playerEntity(inst, a.name)
    return e ? ok(`${a.name}: ${fmt(e.position)}`) : fail(`${a.name} görüş alanımda değil`)
  }
  const list = Object.values(bot.entities).filter((e) => e.name === a.name).sort((x, y) => x.position.distanceTo(p) - y.position.distanceTo(p)).slice(0, 4)
  return list.length ? ok(`${a.name}: ${list.map((e) => fmt(e.position)).join(' | ')}`) : fail(`yakında ${a.name} yok`)
}

async function chat(inst, a) {
  if (a.target) inst.bot.whisper(a.target, a.text)
  else inst.bot.chat(a.text)
  inst.log('bot', `[Sohbet] ${a.text}`)
  return ok('mesaj gönderildi')
}

async function command(inst, a) {
  inst.bot.chat(a.text)
  inst.log('action', `Komut çalıştırıldı: ${a.text}`)
  await sleep(600)
  return ok(`${a.text} komutunu gönderdim`)
}

async function wait(inst, a, { cancelled }) { await waitFor(a.seconds * 1000, cancelled); return ok(`${a.seconds} sn bekledim`) }


// ---------------------------------------------------------------- gelişmiş eylemler
const DOOR_KINDS = { door: /_door$/, trapdoor: /_trapdoor$/, gate: /_fence_gate$/, any: /(_door|_trapdoor|_fence_gate)$/ }

async function door(inst, a) {
  const bot = inst.bot
  let block
  if (a.pos) block = bot.blockAt(new Vec3(a.pos.x, a.pos.y, a.pos.z))
  else block = bot.findBlock({ matching: (b) => DOOR_KINDS[a.kind].test(b.name) && !b.name.startsWith('iron_'), maxDistance: 16 })
  if (!block || !DOOR_KINDS.any.test(block.name)) return fail('yakında uygun kapı / tuzak kapı / çit kapısı yok')
  if (block.name.startsWith('iron_')) return fail('demir kapılar elle açılmaz (redstone gerekir)')
  await goTo(inst, new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2))
  let isOpen = null
  try { const p = block.getProperties(); if (p && p.open !== undefined) isOpen = p.open === true || p.open === 'true' } catch (e) { /* eski sürüm */ }
  if (a.open !== null && isOpen !== null && isOpen === a.open) return ok(`${block.name} zaten ${a.open ? 'açık' : 'kapalı'}`)
  try { await bot.activateBlock(block) } catch (e) { return fail(`kapıyla etkileşim olmadı (${e.message})`) }
  return ok(`${block.name} ${a.open === null ? 'durumu değiştirildi' : a.open ? 'açıldı' : 'kapatıldı'}`)
}

async function enchant(inst, a) {
  const bot = inst.bot
  const tableDef = inst.mcData.blocksByName.enchanting_table
  const table = tableDef && bot.findBlock({ matching: tableDef.id, maxDistance: 32 })
  if (!table) return fail('yakında büyü masası (enchanting_table) yok')
  if (!findInv(inst, a.item.name)) return fail(`envanterimde ${a.item.name} yok`)
  if (!findInv(inst, 'lapis_lazuli')) return fail('lapis lazuli yok')
  await goTo(inst, new goals.GoalLookAtBlock(table.position, bot.world))
  let t
  try { t = await bot.openEnchantmentTable(table) } catch (e) { return fail(`büyü masası açılmadı (${e.message})`) }
  try {
    await t.putTargetItem(findInv(inst, a.item.name))
    const lapis = findInv(inst, 'lapis_lazuli')
    const lapisHave = lapis.count
    await t.putLapis(lapis)
    for (let i = 0; i < 24 && !(t.enchantments || []).some((e) => e && e.level > 0); i++) await sleep(250)
    const opts = (t.enchantments || []).map((e, i) => ({ i, level: e ? e.level : 0 })).filter((o) => o.level > 0)
    if (!opts.length) return fail('büyü seçenekleri açılmadı (eşya büyülenemez ya da zaten büyülü olabilir)')
    const xp = bot.experience ? bot.experience.level : 0
    const affordable = opts.filter((o) => o.level <= xp && o.i + 1 <= lapisHave)
    let pick
    if (a.choice === 'best') pick = affordable.sort((x, y) => y.level - x.level)[0]
    else pick = affordable.find((o) => o.i === a.choice - 1)
    if (!pick) return fail(`yetmiyor: XP seviyem ${xp}, seçenekler (seviye ücreti): ${opts.map((o) => o.level).join('/')}, lapis: ${lapisHave}`)
    await t.enchant(pick.i)
    try { await t.takeTargetItem() } catch (e) { /* pencere kapanınca geri döner */ }
    return ok(`${a.item.name} eşyasını ${pick.level}. seviye ücretiyle büyüledim`)
  } catch (e) {
    return fail(`büyüleyemedim (${e.message})`)
  } finally { try { t.close() } catch (e) { /* kapalı */ } }
}

async function anvil(inst, a) {
  const bot = inst.bot
  const ids = ['anvil', 'chipped_anvil', 'damaged_anvil'].map((n) => inst.mcData.blocksByName[n]).filter(Boolean).map((b) => b.id)
  const block = bot.findBlock({ matching: ids, maxDistance: 32 })
  if (!block) return fail('yakında örs yok')
  const first = findInv(inst, a.item.name)
  if (!first) return fail(`envanterimde ${a.item.name} yok`)
  const second = a.with ? findInv(inst, a.with.name) : null
  if (a.with && !second) return fail(`envanterimde ${a.with.name} yok`)
  await goTo(inst, new goals.GoalLookAtBlock(block.position, bot.world))
  let w
  try { w = await bot.openAnvil(block) } catch (e) { return fail(`örs açılmadı (${e.message})`) }
  try {
    if (second) await w.combine(first, second, a.name)
    else await w.rename(first, a.name)
    return ok(second ? `${a.item.name} ile ${a.with.name} birleştirildi` : `${a.item.name} yeniden adlandırıldı`)
  } catch (e) {
    return fail(`örs işlemi olmadı (${e.message}) - XP yetmiyor olabilir`)
  } finally { try { w.close() } catch (e) { /* kapalı */ } }
}

async function fill_bottles(inst, a, { cancelled }) {
  const bot = inst.bot
  if (!findInv(inst, 'glass_bottle')) return fail('envanterimde cam şişe yok')
  const water = bot.findBlock({ matching: inst.mcData.blocksByName.water.id, maxDistance: 32 })
  if (!water) return fail('yakında su yok')
  await goTo(inst, new goals.GoalNear(water.position.x, water.position.y, water.position.z, 3))
  const before = invCount(inst, 'potion')
  for (let i = 0; i < a.count && !cancelled(); i++) {
    const bottle = findInv(inst, 'glass_bottle')
    if (!bottle) break
    await bot.equip(bottle, 'hand')
    await bot.lookAt(water.position.offset(0.5, 0.9, 0.5))
    bot.activateItem()
    await sleep(600)
  }
  const got = invCount(inst, 'potion') - before
  return got > 0 ? ok(`${got} şişeyi suyla doldurdum`) : fail('şişeleri dolduramadım (suya bakamamış olabilirim)')
}

// Eşyanın iksir türünü NBT/bileşenlerden tahmin et (sürüme göre değişir, en iyi çaba)
function potionText(item) {
  try { return JSON.stringify({ n: item.nbt, c: item.components }).toLowerCase() } catch (e) { return '' }
}

async function drink(inst, a) {
  const bot = inst.bot
  const cands = bot.inventory.items().filter((i) => i.name === 'potion')
  if (!cands.length) return fail('envanterimde içilebilir iksir yok')
  const it = (a.potion && cands.find((i) => potionText(i).includes(a.potion))) || (a.potion ? null : cands[0])
  if (!it) return fail(`"${a.potion}" türünde iksir bulamadım (${cands.length} iksirim var)`)
  try { await bot.equip(it, 'hand'); await bot.consume(); return ok('iksiri içtim') } catch (e) { return fail(`içemedim (${e.message})`) }
}

async function brew(inst, a, { cancelled }) {
  const bot = inst.bot
  const standDef = inst.mcData.blocksByName.brewing_stand
  if (!standDef) return fail('bu sürümde simya sehpası yok')
  let stand = bot.findBlock({ matching: standDef.id, maxDistance: 32 })
  if (!stand) {
    const it = findInv(inst, 'brewing_stand')
    if (!it) return fail('yakında simya sehpası yok')
    stand = await placeTable(inst, it)
    if (!stand) return fail('simya sehpasını yere koyamadım')
  }
  if (!findInv(inst, a.item.name)) return fail(`envanterimde ${a.item.name} yok`)
  if (!invCount(inst, 'potion')) return fail('envanterimde şişe (potion / su şişesi) yok')
  await goTo(inst, new goals.GoalLookAtBlock(stand.position, bot.world))
  let w
  try { w = await bot.openBlock(stand) } catch (e) { return fail(`simya sehpası açılmadı (${e.message})`) }
  try {
    const invStart = w.inventoryStart
    const srcSlot = (name) => w.slots.findIndex((s, i) => i >= invStart && s && s.name === name)
    // Yakıt (1.9+)
    if (invStart >= 5 && !w.slots[4]) {
      const s = srcSlot('blaze_powder')
      if (s === -1) return fail('sehpada yakıt yok ve envanterimde blaze_powder yok')
      await bot.clickWindow(s, 0, 0); await bot.clickWindow(4, 0, 0)
    }
    // Malzeme
    if (w.slots[3] && w.slots[3].name !== a.item.name) return fail('sehpanın malzeme yuvasında başka bir şey var')
    if (!w.slots[3]) {
      const s = srcSlot(a.item.name)
      if (s === -1) return fail(`${a.item.name} bulunamadı`)
      await bot.clickWindow(s, 0, 0); await bot.clickWindow(3, 0, 0)
    }
    // Şişeler (iksirler 1'lik yığındır)
    let placed = 0
    for (let i = 0; i < 3 && placed < a.count; i++) {
      if (w.slots[i]) { placed++; continue }
      const s = srcSlot('potion')
      if (s === -1) break
      await bot.clickWindow(s, 0, 0); await bot.clickWindow(i, 0, 0)
      placed++
    }
    if (!placed) return fail('sehpaya şişe koyamadım')
    const before = w.slots[3] ? w.slots[3].count : 0
    const end = Date.now() + 40000
    let done = false
    while (!cancelled() && Date.now() < end) {
      await sleep(1000)
      const cur = w.slots[3]
      if (!cur || cur.count < before) { done = true; break }
    }
    if (!done) return fail('demleme tamamlanmadı (yanlış malzeme, yakıt yok ya da şişeler uygun değil)')
    let taken = 0
    for (let i = 0; i < 3; i++) if (w.slots[i]) { await bot.clickWindow(i, 0, 1); taken++ }
    if (w.slots[3]) await bot.clickWindow(3, 0, 1)
    return ok(`${taken} iksir demledim (${a.item.name})`)
  } catch (e) {
    return fail(`demleme hatası (${e.message})`)
  } finally { try { w.close() } catch (e) { /* kapalı */ } }
}

async function nether_portal(inst, a, { cancelled }) {
  const bot = inst.bot
  const obs = invCount(inst, 'obsidian')
  if (obs < 12) return fail(`portal için en az 12 obsidyen lazım, envanterimde ${obs} var`)
  const lighter = findInv(inst, 'flint_and_steel') || findInv(inst, 'fire_charge')
  if (!lighter) return fail('envanterimde çakmak (flint_and_steel) yok')
  const c = bot.entity.position.floored()
  const [fx, fz] = yawDir(bot.entity.yaw)
  const rx = -fz
  const rz = fx
  const O = c.offset(fx * 3, 0, fz * 3)
  const at = (w, y) => O.offset(rx * w, y, rz * w)
  // iç alanı temizle
  for (let y = 1; y <= 3; y++) {
    for (const w of [1, 2]) {
      const b = bot.blockAt(at(w, y))
      if (b && !isAir(b) && !isLiquid(b) && b.diggable) {
        try { await goTo(inst, new goals.GoalLookAtBlock(b.position, bot.world)); await digBlock(inst, b) } catch (e) { return fail(`portal alanını temizleyemedim (${e.message})`) }
      }
    }
  }
  const list = []
  for (const w of [1, 2]) list.push(at(w, 0))
  for (let y = 1; y <= 3; y++) { list.push(at(0, y)); list.push(at(3, y)) }
  for (let w = 0; w <= 3; w++) list.push(at(w, 4))
  const built = await buildPositions(inst, list, 'obsidian', cancelled)
  if (!built.ok) return fail(`çerçeve kurulamadı: ${built.msg}`)
  const base = bot.blockAt(at(1, 0))
  await goTo(inst, new goals.GoalNear(at(1, 0).x, at(1, 0).y, at(1, 0).z, 3))
  await bot.equip(lighter, 'hand')
  await bot.lookAt(at(1, 0).offset(0.5, 1, 0.5))
  try { await bot.activateBlock(base, new Vec3(0, 1, 0)) } catch (e) { return fail(`portal yakılamadı (${e.message})`) }
  await sleep(1500)
  const inside = bot.blockAt(at(1, 1))
  if (!inside || inside.name !== 'nether_portal') return fail('çerçeve kuruldu ama portal yanmadı')
  if (!a.enter) return ok('Nether portalı kurdum ve yaktım')
  const startDim = bot.game.dimension
  await goTo(inst, new goals.GoalBlock(at(1, 1).x, at(1, 1).y, at(1, 1).z))
  for (let i = 0; i < 60 && !cancelled() && bot.game.dimension === startDim; i++) await sleep(250)
  return bot.game.dimension !== startDim ? ok(`portaldan geçtim, şu an: ${bot.game.dimension}`) : ok('portal yandı, içine girdim ama boyut değişmedi (biraz beklemek gerekebilir)')
}

async function runBuild(inst, list, offset, cancelled) {
  const bot = inst.bot
  const c = bot.entity.position.floored()
  const [fx, fz] = yawDir(bot.entity.yaw)
  const rx = -fz
  const rz = fx
  const O = c.offset(fx * offset, 0, fz * offset)
  const feet = c
  const head = c.offset(0, 1, 0)
  const targets = list
    .map((e) => ({ pos: O.offset(rx * e.x + fx * e.z, e.y, rz * e.x + fz * e.z), item: e.item.name, facing: worldFacing(inst, e.facing), delay: e.delay }))
    .filter((e) => !e.pos.equals(feet) && !e.pos.equals(head))
    .map((e) => ({ pos: e.pos, item: e.item, blockName: ITEM_TO_BLOCK[e.item] || e.item, hints: hintsFor(e.item, { facing: e.facing, delay: e.delay }) }))
  return summarizeBuild(await placeMany(inst, targets, { cancelled }))
}


// ---------------------------------------------------------------- hazır redstone devreleri
// Koordinatlar: x=sağ, y=yukarı, z=ileri (botun baktığı yön). Sinyal ileri (+z) akar.
function redstoneEntries(a, mcData) {
  const it = (n) => { const d = mcData.itemsByName[n]; if (!d) throw new Error(`${n} bu sürümde yok`); return d }
  const E = []
  const add = (x, y, z, n, extra = {}) => E.push({ x, y, z, item: it(n), ...extra })
  if (a.kind === 'line' || a.kind === 'lamp') {
    // kol + toz hattı (her 12 blokta tekrarlayıcı) + lamba. Zemin düz olmalı.
    const n = a.kind === 'lamp' ? 2 : a.length
    add(0, 0, 0, 'lever')
    for (let z = 1; z <= n; z++) {
      if (z % 12 === 0) add(0, 0, z, 'repeater', { facing: 'back' })   // sinyal ileri aksın: giriş arkada
      else add(0, 0, z, 'redstone')
    }
    add(0, 0, n + 1, 'redstone_lamp')
  } else if (a.kind === 'pressure_door') {
    // demir kapı + iki yanında basınç plakası (içeriden ve dışarıdan açılır). Kapı yerleştirilecek zemin gerekir.
    add(0, 0, 0, 'iron_door', { facing: 'forward' })
    add(0, 0, -1, 'stone_pressure_plate')
    add(0, 0, 1, 'stone_pressure_plate')
  }
  return E
}

async function redstone(inst, a, { cancelled }) {
  let list
  try { list = redstoneEntries(a, inst.mcData) } catch (e) { return fail(e.message) }
  if (!list.length) return fail('bilinmeyen devre türü (line, lamp, pressure_door)')
  return runBuild(inst, list, a.offset, cancelled)
}

async function build(inst, a, { cancelled }) { return runBuild(inst, a.list, a.offset, cancelled) }

async function write_sign(inst, a) {
  const bot = inst.bot
  const block = a.pos ? bot.blockAt(new Vec3(a.pos.x, a.pos.y, a.pos.z))
    : bot.findBlock({ matching: (b) => /_sign$/.test(b.name), maxDistance: 8 })
  if (!block || !/_sign$/.test(block.name)) return fail('yakında tabela yok (önce place ile bir tabela yerleştir)')
  try { await bot.updateSign(block, a.text); return ok('tabelaya yazdım') } catch (e) { return fail(`tabelaya yazamadım (${e.message})`) }
}


// ---------------------------------------------------------------- şematik, arama, PvP, tarla, ev
const sleepMs = sleep

function schematicOrigin(inst, s, a) {
  if (a.pos) return { x: a.pos.x, y: a.pos.y, z: a.pos.z }
  const c = inst.bot.entity.position.floored()
  const [fx, fz] = yawDir(inst.bot.entity.yaw)
  let x
  let z
  if (fx > 0) { x = c.x + a.offset; z = c.z - Math.floor(s.size.z / 2) }
  else if (fx < 0) { x = c.x - a.offset - s.size.x + 1; z = c.z - Math.floor(s.size.z / 2) }
  else if (fz > 0) { z = c.z + a.offset; x = c.x - Math.floor(s.size.x / 2) }
  else { z = c.z - a.offset - s.size.z + 1; x = c.x - Math.floor(s.size.x / 2) }
  return { x, y: c.y + a.dy, z }
}

async function clearRegion(inst, origin, size, keep, cancelled) {
  const bot = inst.bot
  let dug = 0
  for (let y = size.y - 1; y >= 0; y--) {
    for (let z = 0; z < size.z; z++) {
      for (let x = 0; x < size.x; x++) {
        if (cancelled()) return dug
        const p = new Vec3(origin.x + x, origin.y + y, origin.z + z)
        const b = bot.blockAt(p)
        if (!b || isAir(b) || isLiquid(b) || !b.diggable || keep.has(`${p.x},${p.y},${p.z}`)) continue
        try { await moveNear(inst, p); await digBlock(inst, b); dug++ } catch (e) { /* atla */ }
      }
    }
  }
  return dug
}

// Şematiği botun kendi eliyle kurar (komut kullanmaz)
async function schematic(inst, a, { cancelled }) {
  const bot = inst.bot
  let s
  try { s = await Sch.load(a.file) } catch (e) { return fail(e.message) }
  s = Sch.rotate(s, a.rotate)
  const origin = schematicOrigin(inst, s, a)
  const creative = isCreative(inst)
  inst.log('info', `Şematik: ${s.file} (${s.size.x}x${s.size.y}x${s.size.z}, ${s.blocks.length} blok) -> başlangıç ${origin.x}, ${origin.y}, ${origin.z}${creative ? ' [creative: blokları kendi envanterine ekler]' : ''}`)
  await moveNear(inst, new Vec3(origin.x + Math.floor(s.size.x / 2), origin.y, origin.z + Math.floor(s.size.z / 2)))

  const targets = []
  const keep = new Set()
  let unknown = 0
  for (const b of s.blocks) {
    const it = Sch.blockToItem(b, inst.mcData)
    if (!it) continue                                   // hava, kapının üst yarısı gibi bilerek atlananlar
    if (it.unknown) { unknown++; continue }
    const pos = new Vec3(origin.x + b.x, origin.y + b.y, origin.z + b.z)
    keep.add(`${pos.x},${pos.y},${pos.z}`)
    let kind = 'normal'
    if (b.name === 'water' || b.name === 'lava') kind = 'liquid'
    else if (b.name === 'farmland') kind = 'farmland'
    else if (/_slab$/.test(b.name) && b.props.type === 'double') kind = 'double'
    targets.push({ pos, item: it.item, blockName: b.name, kind, props: b.props, hints: hintsFor(b.name, b.props) })
  }
  let cleared = 0
  if (a.withAir) cleared = await clearRegion(inst, origin, s.size, keep, cancelled)
  const stats = await placeMany(inst, targets, { cancelled, partial: a.partial, label: 'şematik' })
  const res = summarizeBuild(stats)
  const extra = [cleared ? `${cleared} blok temizledim` : '', unknown ? `${unknown} blok desteklenmeyen türde olduğu için atlandı` : ''].filter(Boolean).join(', ')
  return { ...res, msg: extra ? `${res.msg} (${extra})` : res.msg }
}

async function schematic_info(inst, a) {
  let s
  try { s = await Sch.load(a.file) } catch (e) { return fail(e.message) }
  return ok(Sch.describe(s, inst.mcData, (item) => invCount(inst, item)).text.slice(0, 900))
}

async function list_schematics() {
  const files = Sch.listFiles()
  return files.length ? ok(`şematikler: ${files.map((f) => `${f.name} (${Math.round(f.size / 1024)} KB)`).join(', ')}`) : fail('schematics klasörü boş (panelden dosya yükle)')
}

async function download_schematic(inst, a) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 45000)
  try {
    const res = await fetch(a.url, { signal: ctrl.signal, redirect: 'follow', headers: { 'user-agent': 'MinecraftAIBot/3.0' } })
    if (!res.ok) return fail(`indirilemedi (HTTP ${res.status})`)
    const len = Number(res.headers.get('content-length') || 0)
    const dlMax = Math.min(Sch.MAX_FILE_BYTES, Sch.MAX_LOAD_BYTES)   // internetten indirme belleğe alınır: yükleme sınırından düşük
    if (len > dlMax) return fail(`dosya ${Sch.fmtBytes(dlMax)} indirme sınırını aşıyor (panelden yükle, 2 GB'a kadar)`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > dlMax) return fail(`dosya ${Sch.fmtBytes(dlMax)} indirme sınırını aşıyor`)
    const name = Sch.saveFile(a.name, buf)
    try { await Sch.load(name) } catch (e) { Sch.deleteFile(name); return fail(`indirilen dosya geçerli bir şematik değil: ${e.message}`) }
    return ok(`${name} indirildi (${Math.round(buf.length / 1024)} KB)`)
  } catch (e) {
    return fail(`indirme hatası: ${e.message}`)
  } finally { clearTimeout(timer) }
}

// Yerel gerçekler (minecraft-data): tarifler, blok dayanıklılığı/alet, yiyecek. İnternetsiz, hızlı ve doğru.
function localFacts(inst, q) {
  const md = inst.mcData
  if (!md) return ''
  const text = `${q} ${search.dictTranslate(String(q))}`.toLowerCase().replace(/[^a-z0-9_ ]+/g, ' ')
  const words = text.split(/\s+/).filter(Boolean)
  const cands = []
  for (let i = 0; i < words.length; i++) {
    for (let n = 3; n >= 1; n--) { if (words.slice(i, i + n).length === n) cands.push(words.slice(i, i + n).join('_')) }
  }
  const found = []
  for (const c of cands) {
    const it = md.itemsByName[c] || md.blocksByName[c]
    if (it && !found.some((f) => f.name === it.name) && !['air', 'stone_button'].includes(it.name) && c.length > 2) found.push(it)
    if (found.length >= 2) break
  }
  if (!found.length) return ''
  const nm = (id) => { const x = id && typeof id === 'object' ? id.id : id; return (md.items[x] && md.items[x].name) || String(x) }
  const out = []
  for (const it of found) {
    const lines = []
    const recipes = md.recipes && md.recipes[md.itemsByName[it.name] ? md.itemsByName[it.name].id : -1]
    if (recipes && recipes.length) {
      recipes.slice(0, 3).forEach((r, i) => {
        const per = (r.result && r.result.count) || 1
        if (r.ingredients) {
          const cnt = {}
          r.ingredients.forEach((x) => { const k = nm(x); cnt[k] = (cnt[k] || 0) + 1 })
          lines.push(`Tarif${recipes.length > 1 ? ` ${i + 1}` : ''} (dizilimsiz, ${per} adet verir): ${Object.entries(cnt).map(([k, v]) => `${v}x ${k}`).join(', ')}`)
        } else if (r.inShape) {
          const rows = r.inShape.map((row) => row.map((x) => (x === null || x === -1 ? '_' : nm(x))).join(' | ')).join('  //  ')
          lines.push(`Tarif${recipes.length > 1 ? ` ${i + 1}` : ''} (şekilli, ${per} adet verir): ${rows}`)
        }
      })
    }
    const bl = md.blocksByName[it.name]
    if (bl) {
      const tools = bl.harvestTools ? Object.keys(bl.harvestTools).map((id) => nm(Number(id))).join(', ') : 'alet gerekmez'
      lines.push(`Blok: dayanıklılık ${bl.hardness}, kırmak için: ${tools}${bl.diggable === false ? ' (kırılamaz)' : ''}`)
    }
    const fd = md.foodsByName && md.foodsByName[it.name]
    if (fd) lines.push(`Yiyecek: ${fd.foodPoints} açlık, doygunluk ${Math.round(fd.saturation * 10) / 10}`)
    const item = md.itemsByName[it.name]
    if (item && item.stackSize) lines.push(`Yığın boyutu: ${item.stackSize}`)
    if (lines.length) out.push(`[Yerel bilgi: ${it.name}] ${lines.join('. ')}`)
  }
  return out.join('\n')
}

async function web_search(inst, a) {
  const local = (() => { try { return localFacts(inst, a.query) } catch (e) { return '' } })()
  // Saf tarif sorusu ve yerel tarif bulunduysa interneti beklemeden dön (hızlı ve doğru)
  if (local.includes('Tarif') && /recipe|craft|tarif|how to make|nas[ıi]l yap[ıi]l[ıi]r|nas[ıi]l [uü]retilir/i.test(a.query) && !a.deep) {
    if (inst.learn) inst.learn(a.query, local)
    return { ok: true, msg: `"${a.query}" için yerel tarif bulundu`, data: local.slice(0, 3000) }
  }
  try {
    const query = a.topic ? `${a.query} ${a.topic}` : a.query
    const r = await search.webSearch(query, { groqKey: inst.cfg.groqKey, searchModel: inst.cfg.searchModel, deep: a.deep })
    const text = [local, r.text].filter(Boolean).join('\n\n')
    if (inst.learn) inst.learn(a.query, text)
    inst.log('ai', `Arama (${local ? 'yerel+' : ''}${r.source}): ${text.slice(0, 500).replace(/\s+/g, ' ')}...`)
    return { ok: true, msg: `"${a.query}" için araştırma tamamlandı (${local ? 'yerel+' : ''}${r.source})`, data: text.slice(0, 3600) }
  } catch (e) {
    if (local) { if (inst.learn) inst.learn(a.query, local); return { ok: true, msg: `"${a.query}" için sadece yerel bilgi bulundu (web: ${e.message})`, data: local.slice(0, 3000) } }
    return fail(e.message)
  }
}

// ---- kristal PvP (deneysel, basit sezgisel)
async function crystal_pvp(inst, a, { cancelled }) {
  const bot = inst.bot
  if (!inst.cfg.allowPvp && !a.friendly) return fail('oyunculara saldırı kapalı')
  if (!findInv(inst, 'end_crystal')) return fail('envanterimde end_crystal yok')
  if (!playerEntity(inst, a.target)) return fail(`${a.target} görüş alanımda değil`)
  const baseIds = ['obsidian', 'bedrock'].map((n) => inst.mcData.blocksByName[n]).filter(Boolean).map((b) => b.id)
  if (inst.autoArmor) await inst.autoArmor().catch(() => {})
  if (bot.smoothLook) bot.smoothLook.fast = true
  let dead = false
  const onDead = (e) => { if (e && e.username === a.target) dead = true }
  bot.on('entityDead', onDead)
  const stats = { placed: 0, hit: 0, melee: 0, obs: 0 }
  const last = { place: 0, hit: 0, melee: 0, obs: 0 }
  const end = Date.now() + a.seconds * 1000
  let lost = 0
  let followed = null
  try {
    while (!cancelled() && !dead && Date.now() < end) {
      const te = playerEntity(inst, a.target)
      if (!te) { if (++lost > 40) break; await sleep(150); continue }
      lost = 0
      if (followed !== te) { bot.pathfinder.setGoal(new goals.GoalFollow(te, 3), true); followed = te }
      const off = bot.inventory.slots[45]
      const totem = findInv(inst, 'totem_of_undying')
      if (totem && (!off || off.name !== 'totem_of_undying')) { try { await bot.equip(totem, 'off-hand') } catch (e) { /* sürüm */ } }
      if (bot.health <= 9 && !inst.eating) {
        const ap = findInv(inst, 'enchanted_golden_apple') || findInv(inst, 'golden_apple')
        if (ap) { inst.eating = true; try { await bot.equip(ap, 'hand'); await bot.consume() } catch (e) { /* kesildi */ } inst.eating = false; continue }
      }
      const me = bot.entity.position
      const tp = te.position
      const crystals = Object.values(bot.entities).filter((e) => e.name === 'end_crystal' && e.position.distanceTo(me) <= 7)
      const hit = crystal.pickCrystalToBreak(crystals.map((e) => ({ id: e.id, position: e.position, entity: e })), tp, me, bot.health)
      if (hit && Date.now() - last.hit > 110) {
        await bot.lookAt(hit.position.offset(0, 0.5, 0), true)
        bot.attack(hit.entity)
        last.hit = Date.now(); stats.hit++
        await sleep(50)
        continue
      }
      if (Date.now() - last.place > 220) {
        const cand = bot.findBlocks({ matching: baseIds, maxDistance: 5, count: 80 })
          .filter((p) => isAir(bot.blockAt(p.offset(0, 1, 0))) && isAir(bot.blockAt(p.offset(0, 2, 0))))
          .filter((p) => !crystals.some((e) => Math.abs(e.position.x - (p.x + 0.5)) < 0.7 && Math.abs(e.position.z - (p.z + 0.5)) < 0.7 && Math.abs(e.position.y - (p.y + 1)) < 1.5))
        const base = crystal.pickCrystalBase(cand.map((p) => ({ x: p.x, y: p.y, z: p.z })), tp, me)
        const cr = findInv(inst, 'end_crystal')
        if (base && cr) {
          try {
            const block = bot.blockAt(new Vec3(base.x, base.y, base.z))
            await bot.equip(cr, 'hand')
            await bot.lookAt(block.position.offset(0.5, 1, 0.5), true)
            await bot.activateBlock(block, new Vec3(0, 1, 0))
            stats.placed++
          } catch (e) { /* tekrar dener */ }
          last.place = Date.now()
          continue
        }
        // taban yoksa hedefin yanına obsidyen koy
        if (!base && findInv(inst, 'obsidian') && Date.now() - last.obs > 700 && me.distanceTo(tp) < 6) {
          last.obs = Date.now()
          const tf = tp.floored()
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const pos = tf.offset(dx, 0, dz)
            if (isAir(bot.blockAt(pos)) && !isAir(bot.blockAt(pos.offset(0, -1, 0))) && me.distanceTo(pos) > 1.8) {
              if ((await placeAt(inst, 'obsidian', pos)) === 'ok') { stats.obs++; break }
            }
          }
        }
        last.place = Date.now()
      }
      if (me.distanceTo(tp) < 3.4 && Date.now() - last.melee > 550) {
        await equipBestWeapon(inst)
        await bot.lookAt(tp.offset(0, (te.height || 1.8) * 0.9, 0), true)
        bot.attack(te)
        last.melee = Date.now(); stats.melee++
      }
      await sleep(60)
    }
  } finally {
    bot.removeListener('entityDead', onDead)
    if (bot.smoothLook) bot.smoothLook.fast = false
    try { bot.pathfinder.stop() } catch (e) { /* kapalı */ }
  }
  if (cancelled()) return fail('iptal edildi')
  const summary = `${stats.placed} kristal koydum, ${stats.hit} kez kristale vurdum, ${stats.melee} yakın vuruş, ${stats.obs} obsidyen`
  return dead ? ok(`${a.target} öldü. ${summary}`) : ok(`süre/bağlantı bitti. ${summary}`)
}

// ---- 9x9 (yarıçap R) çalışan tarla: ortada su, çevresi çapalanmış ve ekilmiş
// Tohum yoksa (buğday) çimen kırarak topla. Diğer ekinler için tohum bulunamaz.
async function gatherSeeds(inst, seedName, need, cancelled, ms) {
  const bot = inst.bot
  if (seedName !== 'wheat_seeds') return
  const GRASS = new Set(['short_grass', 'grass', 'tall_grass'])
  const t0 = Date.now()
  let n = 0
  while (!cancelled() && invCount(inst, seedName) < need && Date.now() - t0 < ms) {
    const g = bot.findBlock({ matching: (b) => GRASS.has(b.name), maxDistance: 24 })
    if (!g) break
    if (!(await goTo(inst, new goals.GoalNear(g.position.x, g.position.y, g.position.z, 2)))) { await sleep(300); continue }
    try { await digBlock(inst, g) } catch (e) { /* sıradaki */ }
    if (++n % 4 === 0) { try { await pickup(inst, { radius: 5 }, { cancelled }) } catch (e) { /* */ } }
  }
  try { await pickup(inst, { radius: 6 }, { cancelled }) } catch (e) { /* */ }
}

async function make_farm(inst, a, { cancelled }) {
  const bot = inst.bot
  const cropBlock = a.crop
  const seedName = { wheat: 'wheat_seeds', carrots: 'carrot', potatoes: 'potato', beetroots: 'beetroot_seeds' }[a.crop]
  const R = Math.min(a.radius, 4)                 // tek su bloğu en fazla 4 blok uzağı sular
  const cells = (R * 2 + 1) ** 2 - 1
  const c = bot.entity.position.floored()
  const [fx, fz] = yawDir(bot.entity.yaw)
  const center = c.offset(fx * (a.offset + R), -1, fz * (a.offset + R))     // merkez zemin bloğu
  const ground = []
  for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) if (dx || dz) ground.push(center.offset(dx, 0, dz))
  const near = async (p, r = 3) => { if (bot.entity.position.offset(0, 1.62, 0).distanceTo(p.offset(0.5, 1, 0.5)) > 4.2) await goTo(inst, new goals.GoalNear(p.x, p.y + 1, p.z, r)) }
  const notes = []

  // ---- A) OP / komut yolu: çapa, kova, tohum gerekmez
  let opDone = false
  try {
    if (await OpBuild.available(inst)) {
      await goTo(inst, new goals.GoalNear(center.x, center.y + 1, center.z, 3))
      const clr = []
      for (const p of [center, ...ground]) for (const dy of [1, 2]) { const b = bot.blockAt(p.offset(0, dy, 0)); if (b && !isAir(b)) clr.push(p.offset(0, dy, 0)) }
      if (clr.length) { try { await OpBuild.clearPositions(inst, clr, cancelled) } catch (e) { /* */ } }
      const mk = (pos, blockName, props) => ({ pos, blockName, props })
      const base = ground.map((p) => mk(p, 'farmland', { moisture: 7 }))
      base.push(mk(center, 'water'))
      // çit halkası (bota bakan kenarın ortası açık) + köşelere meşale
      const fence = []
      const torch = []
      for (let dx = -R - 1; dx <= R + 1; dx++) for (let dz = -R - 1; dz <= R + 1; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== R + 1) continue
        if ((fx !== 0 && dx === -fx * (R + 1) && dz === 0) || (fz !== 0 && dz === -fz * (R + 1) && dx === 0)) continue   // giriş boşluğu
        const p = center.offset(dx, 1, dz)
        fence.push(mk(p, 'oak_fence'))
        if (Math.abs(dx) === R + 1 && Math.abs(dz) === R + 1) torch.push(mk(p.offset(0, 1, 0), 'torch'))
      }
      const s1 = await OpBuild.placeTargets(inst, [...base, ...fence], cancelled)
      const crops = ground.map((p) => mk(p.offset(0, 1, 0), cropBlock, { age: 0 }))
      const s2 = await OpBuild.placeTargets(inst, [...crops, ...torch], cancelled)
      const farmOk = ground.filter((p) => (bot.blockAt(p) || {}).name === 'farmland').length
      const cropOk = ground.filter((p) => (bot.blockAt(p.offset(0, 1, 0)) || {}).name === cropBlock).length
      const waterOk = (bot.blockAt(center) || {}).name === 'water'
      if (farmOk >= cells * 0.9 && waterOk && cropOk >= cells * 0.9) {
        return ok(`komutla tarla kurdum: ${farmOk} tarla, ${cropOk} ${cropBlock}, su ve çit tamam (${s1.size + s2.size} blok)`)
      }
      opDone = farmOk > 0
      notes.push(`komut yolu eksik kaldı (tarla ${farmOk}/${cells}, ekin ${cropOk}/${cells}${waterOk ? '' : ', su yok'}); kalanı elle tamamlıyorum`)
    }
  } catch (e) { notes.push(`komut yolu hata verdi (${e.message})`) }

  // ---- B) Malzemeleri hazırla (creative → al, survival → craft / topla)
  let hoe = bot.inventory.items().find((i) => i.name.endsWith('_hoe'))
  if (!hoe && !opDone) {
    if (await ensureItem(inst, 'diamond_hoe', 1)) hoe = findInv(inst, 'diamond_hoe')
    else { try { await craftItem(inst, 'wooden_hoe', 1, cancelled, 0) } catch (e) { /* */ } hoe = bot.inventory.items().find((i) => i.name.endsWith('_hoe')) }
  }
  if (!hoe && !opDone) return fail('çapa yok ve yapamadım (2 odun + 2 çubuk lazım; önce "odun topla" dene)')

  let bucket = findInv(inst, 'water_bucket')
  const waterThere = () => (bot.blockAt(center) || {}).name === 'water'
  if (!bucket && !waterThere()) {
    if (await ensureItem(inst, 'water_bucket', 1)) bucket = findInv(inst, 'water_bucket')
    else {
      let empty = findInv(inst, 'bucket')
      if (!empty) { try { await craftItem(inst, 'bucket', 1, cancelled, 0) } catch (e) { /* */ } empty = findInv(inst, 'bucket') }
      if (empty) {
        const w = bot.findBlock({ matching: (b) => b.name === 'water' && Number(b.metadata) === 0, maxDistance: 48 })
        if (w) {
          await goTo(inst, new goals.GoalNear(w.position.x, w.position.y, w.position.z, 2))
          for (let t = 0; t < 3 && !findInv(inst, 'water_bucket'); t++) {
            await bot.equip(empty, 'hand')
            await bot.lookAt(w.position.offset(0.5, 0.9, 0.5), true)
            bot.activateItem(); await sleep(600)
          }
          bucket = findInv(inst, 'water_bucket')
        }
      }
    }
    if (!bucket) return fail('su kovası yok: 3 demir ile kova yapıp su kaynağından doldurmam lazım; yakında su ya da demir bulamadım')
  }

  let have = invCount(inst, seedName)
  if (!opDone && have < cells) {
    await ensureItem(inst, seedName, 64)
    have = invCount(inst, seedName)
    if (have < cells && seedName === 'wheat_seeds') { notes.push('çimenden tohum topluyorum'); await gatherSeeds(inst, seedName, cells, cancelled, 90000); have = invCount(inst, seedName) }
  }
  if (!opDone && have < 4) return fail(`${seedName} yok (${have}). ${seedName === 'wheat_seeds' ? 'Çimen kırıp bulamadım' : 'Bunu survival\'da köylüden/zombiden/ekinden alabilirim'}; bana ver ya da creative ver`)

  // ---- C) Zemin kontrolü (komut yolu zemini zaten çevirdiyse atla)
  if (!opDone) {
    const okGround = new Set(['dirt', 'grass_block', 'farmland', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium'])
    const bad = ground.filter((p) => { const b = bot.blockAt(p); return !b || !okGround.has(b.name) }).length
    if (bad > cells * 0.2) return fail(`alanın ${bad}/${cells} zemini toprak/çimen değil, düz bir yer seç`)
  }

  // ---- D) Elle: bitkileri temizle, su, çapala, ek
  if (!opDone) {
    for (const p of ground) {
      if (cancelled()) return fail('iptal edildi')
      const up = bot.blockAt(p.offset(0, 1, 0))
      if (up && !isAir(up) && up.diggable && !isLiquid(up)) { await near(p); try { await digBlock(inst, up) } catch (e) { /* atla */ } }
    }
  }
  if (!waterThere() && bucket) {
    await near(center, 2)
    const cb = bot.blockAt(center)
    if (cb && !isAir(cb) && cb.name !== 'water') { try { await digBlock(inst, cb) } catch (e) { return fail(`merkez kazılamadı: ${e.message}`) } }
    for (let t = 0; t < 3 && !waterThere(); t++) {
      await bot.equip(bucket, 'hand')
      await bot.lookAt(center.offset(0.5, 0, 0.5), true)
      bot.activateItem()
      await sleep(700)
    }
    if (!waterThere()) notes.push('UYARI: su yerleşmedi, tarla kurumuş kalabilir')
  }
  let tilled = 0
  if (hoe) {
    await bot.equip(hoe, 'hand')
    for (const p of ground) {
      if (cancelled()) return fail('iptal edildi')
      const b = bot.blockAt(p)
      if (!b) continue
      if (b.name === 'farmland') { tilled++; continue }
      await near(p)
      if (await tillBlock(inst, p)) tilled++
    }
  }
  let planted = 0
  {
    for (const p of ground) {
      if (cancelled()) return fail('iptal edildi')
      const b = bot.blockAt(p)
      if (!b || b.name !== 'farmland' || !isAir(bot.blockAt(p.offset(0, 1, 0)))) continue
      const seed = findInv(inst, seedName)
      if (!seed) { notes.push(`tohum bitti (${planted} ekildi)`); break }
      await near(p)
      try { await bot.equip(seed, 'hand'); await bot.placeBlock(b, new Vec3(0, 1, 0)); planted++ } catch (e) { /* atla */ }
    }
  }
  const total = ground.filter((p) => (bot.blockAt(p.offset(0, 1, 0)) || {}).name === cropBlock).length
  const tail = notes.length ? ` (${notes.join('; ')})` : ''
  return total > 0
    ? ok(`${tilled} tarla hazır, ${total}/${cells} ${a.crop} ekili${tail}`)
    : fail(`ekim yapamadım (${tilled} blok çapalandı)${tail}`)
}

// ---- parametrik ev
function houseEntries(a, mcData, inst) {
  const [W, D, H] = { small: [5, 5, 3], medium: [7, 7, 4], large: [9, 9, 4] }[a.size]
  const x0 = -Math.floor(W / 2)
  const x1 = x0 + W - 1
  const z1 = D - 1
  const E = []
  const add = (x, y, z, item, extra = {}) => E.push({ x, y, z, item, ...extra })
  // Zemin y=-1 (botun bastığı zemin seviyesi), duvarlar y=0..H-1, çatı y=H. Böylece kapıdan zıplamadan girilir.
  for (let x = x0; x <= x1; x++) for (let z = 0; z <= z1; z++) add(x, -1, z, a.floor)
  for (let y = 0; y < H; y++) {
    for (let x = x0; x <= x1; x++) {
      for (let z = 0; z <= z1; z++) {
        if (!(x === x0 || x === x1 || z === 0 || z === z1)) continue
        if (x === 0 && z === 0) { if (y === 0) add(x, y, z, a.door, { facing: 'forward' }); continue }   // kapı (üst yarısı otomatik)
        const window = y === 1 && ((z === Math.floor(D / 2) && (x === x0 || x === x1)) || (z === z1 && x === 0)) && H >= 3
        add(x, y, z, window ? a.glass : a.wall)
      }
    }
  }
  for (let x = x0; x <= x1; x++) for (let z = 0; z <= z1; z++) add(x, H, z, a.roof)
  const torch = mcData.itemsByName.torch
  if (torch) { add(x1 - 1, 0, z1 - 1, torch); add(x0 + 1, 0, z1 - 1, torch) }
  // İsteğe bağlı parçalar (kapı, cam, meşale) envanterde yoksa atlanır: kapı yoksa açık kapı boşluğu, cam yoksa duvar bloğu
  if (inst && !isCreative(inst)) {
    const has = (n) => invCount(inst, n) > 0
    return E.filter((e) => {
      if (e.item.name === a.door.name) return has(e.item.name)
      if (e.item.name === (torch && torch.name)) return has('torch')
      return true
    }).map((e) => (e.item.name === a.glass.name && !has(a.glass.name) ? { ...e, item: a.wall } : e))
  }
  return E
}

async function house(inst, a, { cancelled }) { return runBuild(inst, houseEntries(a, inst.mcData, inst), a.offset, cancelled) }

// ---------------------------------------------------------------- PvP / düello
// Sezgisel bir dövüş motoru: bekleme süresine göre vuruş, kritik (düşerken) vuruş, W-tap, yan adım,
// balta ile kalkan kırma, totem, altın elma, iksir (pot), ok (UHC), rüzgar topu + mace smash.
// Gerçek bir PvP oyuncusunun refleks ve ping hesabı yoktur; "iyi bir başlangıç seviyesi" gibi düşün.
const PVP_WEAPONS = {
  sword: ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword'],
  axe: ['netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'golden_axe', 'wooden_axe'],
  mace: ['mace'],
  spear: ['netherite_spear', 'diamond_spear', 'iron_spear', 'copper_spear', 'stone_spear', 'golden_spear', 'wooden_spear'],
}
// Vuruş bekleme süresi (ms): kılıç 1.6 hız ~625ms, balta ~1000-1250ms, mace ~1670ms. Mızrak değerleri tahmindir.
const PVP_COOLDOWN = { sword: 640, axe: 1050, mace: 1700, spear: 900 }

const pvpPotText = (it) => { try { return JSON.stringify(it.components || it.nbt || it.name).toLowerCase() } catch (e) { return it.name } }

async function duel(inst, a, { cancelled }) {
  const bot = inst.bot
  let style = a.style
  if (style === 'crystal') return crystal_pvp(inst, { target: a.target, seconds: a.seconds, friendly: a.friendly }, { cancelled })
  if (!a.friendly && !inst.cfg.allowPvp) return fail('oyunculara saldırı kapalı (panelden aç)')
  if (!playerEntity(inst, a.target)) return fail(`${a.target} görüş alanımda değil`)
  const noteParts = []
  const has = (n) => !!findInv(inst, n)
  const weaponOf = (kind) => PVP_WEAPONS[kind].map((n) => findInv(inst, n)).find(Boolean)
  // Stil -> birincil silah
  if (style === 'elytra_mace') { style = 'mace'; noteParts.push('elytra ile uçarak mace henüz yok, yerden mace yapıyorum') }
  if (style === 'auto') style = weaponOf('mace') ? 'mace' : weaponOf('spear') ? 'spear' : weaponOf('sword') ? 'sword' : weaponOf('axe') ? 'axe' : 'sword'
  const primary = ['mace', 'spear', 'axe'].includes(style) ? style : 'sword'
  if (!weaponOf(primary)) {
    const alt = ['sword', 'axe', 'mace', 'spear'].find((k) => weaponOf(k))
    if (!alt) return fail(`${style} için silahım yok (envanterimde kılıç/balta/mace/mızrak yok)`)
    noteParts.push(`${primary} yok, ${alt} ile dövüşüyorum`)
    style = alt === primary ? style : alt
  }
  const kind = weaponOf(primary) ? primary : ['sword', 'axe', 'mace', 'spear'].find((k) => weaponOf(k))

  if (inst.autoArmor) await inst.autoArmor().catch(() => {})
  if (bot.smoothLook) bot.smoothLook.fast = true   // dövüşte anında dön
  let dead = false
  let iDied = false
  const onDead = (e) => { if (e && e.username === a.target) dead = true }
  const onDeath = () => { iDied = true }
  bot.on('entityDead', onDead)
  bot.on('death', onDeath)

  const st = { hits: 0, crits: 0, smashes: 0, ate: 0, healed: 0, arrows: 0, shieldBreaks: 0, webs: 0, debuffs: 0, pearls: 0, escapes: 0 }
  const t = { hit: 0, eat: 0, heal: 0, bow: 0, launch: 0, strafe: 0, jump: 0, wind: 0, web: 0, pearl: 0, escape: 0, debuff: 0 }
  const lastDebuff = {}
  let strafeDir = 'left'
  let wantCritAt = 0
  let airborneLaunch = null
  let followed = null
  let lost = 0
  const end = Date.now() + a.seconds * 1000
  const equipKind = async (k) => {
    const w = weaponOf(k)
    if (w && (!bot.heldItem || bot.heldItem.name !== w.name)) { try { await bot.equip(w, 'hand') } catch (e) { /* meşgul */ } }
    return w
  }
  const releaseMove = () => { for (const c of ['forward', 'back', 'left', 'right', 'sprint']) bot.setControlState(c, false) }
  const lookAtTarget = (te, hf = 0.85) => bot.lookAt(te.position.offset(0, (te.height || 1.8) * hf, 0), true)
  const hdist = (te) => Math.hypot(te.position.x - bot.entity.position.x, te.position.z - bot.entity.position.z)

  // Başlangıç iksirleri (envanterde varsa her stilde): güç, hız, ateş direnci
  {
    const te0 = playerEntity(inst, a.target)
    if (te0 && hdist(te0) > 7) {
      for (const want of ['strength', 'swiftness|speed', 'fire_resistance']) {
        const p = bot.inventory.items().find((i) => i.name === 'potion' && new RegExp(want).test(pvpPotText(i)))
        if (p && !cancelled()) { try { await bot.equip(p, 'hand'); await bot.consume(); st.ate++ } catch (e) { /* yoksay */ } }
      }
    }
  }

  try {
    while (!cancelled() && !dead && !iDied && Date.now() < end) {
      const te = playerEntity(inst, a.target)
      if (!te) { releaseMove(); if (++lost > 60) break; await sleep(100); continue }
      lost = 0
      const now = Date.now()
      const hp = bot.health
      const dist = bot.entity.position.distanceTo(te.position)
      const hd = hdist(te)
      const dy = te.position.y - bot.entity.position.y

      // Totem her zaman yan elde
      const off = bot.inventory.slots[45]
      const totem = findInv(inst, 'totem_of_undying')
      if (totem && (!off || off.name !== 'totem_of_undying')) { try { await bot.equip(totem, 'off-hand') } catch (e) { /* sürüm */ } }

      // --- iyileşme
      const apple = findInv(inst, 'enchanted_golden_apple') || findInv(inst, 'golden_apple')
      const healLimit = style === 'uhc' ? 12 : 9
      if (apple && hp <= healLimit && now - t.eat > 3500 && (dist > 4.2 || hp <= 6)) {
        t.eat = now; releaseMove()
        try { await bot.equip(apple, 'hand'); await bot.consume(); st.ate++ } catch (e) { /* kesildi */ }
        continue
      }
      if (style === 'pot' && hp <= 9 && now - t.heal > 1300) {
        const sp = bot.inventory.items().find((i) => i.name === 'splash_potion' && /healing|instant_health/.test(pvpPotText(i)))
        if (sp) {
          t.heal = now
          try { await bot.equip(sp, 'hand'); await bot.lookAt(bot.entity.position.offset(0, -1, 0), true); bot.activateItem(); st.healed++ } catch (e) { /* yoksay */ }
          await sleep(120)
          continue
        }
      }

      // --- uzak mesafe: ok (UHC) ya da yaklaş
      if (style === 'uhc' && dist > 9 && dist < 30 && now - t.bow > 1700 && has('bow') && has('arrow')) {
        t.bow = now; releaseMove()
        try {
          await bot.equip(findInv(inst, 'bow'), 'hand')
          const lead = dist / 26   // ok uçuş süresi tahmini (sn)
          const v = te.velocity || { x: 0, y: 0, z: 0 }
          await bot.lookAt(te.position.offset(v.x * lead * 20, (te.height || 1.8) * 0.9 + dist * 0.045, v.z * lead * 20), true)
          bot.activateItem()
          await sleep(950)
          bot.deactivateItem()
          st.arrows++
        } catch (e) { /* yoksay */ }
        continue
      }

      // --- tuzak, debuff, pearl, rüzgar topuyla kaçış
      if (has('wind_charge') && hp <= 6 && dist < 4.5 && bot.entity.onGround && now - t.escape > 6000) {
        t.escape = now; releaseMove()
        try {
          await bot.equip(findInv(inst, 'wind_charge'), 'hand')
          await bot.lookAt(bot.entity.position.offset(0, -1, 0), true)
          bot.setControlState('jump', true); await sleep(60)
          bot.activateItem(); await sleep(60)
          bot.setControlState('jump', false)
          st.escapes++
        } catch (e) { /* yoksay */ }
        continue
      }
      if (has('cobweb') && dist <= 4.8 && now - t.web > 4500) {
        t.web = now
        const r = await placeAt(inst, 'cobweb', te.position.floored())
        if (r === 'ok') { st.webs++; continue }
      }
      if (dist > 4 && dist <= 9 && now - t.debuff > 2200) {
        const DEB = [/harming|instant_damage/, /poison/, /slowness/, /weakness/]
        const sp = bot.inventory.items().find((i) => i.name === 'splash_potion' && DEB.some((re) => re.test(pvpPotText(i)) && now - (lastDebuff[re.source] || 0) > 9000))
        if (sp) {
          const re = DEB.find((r2) => r2.test(pvpPotText(sp)))
          t.debuff = now; lastDebuff[re.source] = now
          try { await bot.equip(sp, 'hand'); await bot.lookAt(te.position.offset(0, 0.4 + dist * 0.05, 0), true); bot.activateItem(); st.debuffs++ } catch (e) { /* yoksay */ }
          await sleep(120)
          continue
        }
      }
      if (hd > 16 && has('ender_pearl') && now - t.pearl > 12000) {
        t.pearl = now
        try { await bot.equip(findInv(inst, 'ender_pearl'), 'hand'); await bot.lookAt(te.position.offset(0, 1 + hd * 0.09, 0), true); bot.activateItem(); st.pearls++ } catch (e) { /* yoksay */ }
        await sleep(300)
        continue
      }

      // --- yaklaşma
      const far = hd > 9 || Math.abs(dy) > 2.5
      if (far) {
        if (followed !== te) { bot.pathfinder.setGoal(new goals.GoalFollow(te, 2), true); followed = te }
        bot.setControlState('sprint', true)
        await sleep(100)
        continue
      }
      if (followed) { try { bot.pathfinder.stop() } catch (e) { /* yok */ } followed = null }

      // --- silah seçimi (kalkan varsa balta ile kır)
      let useKind = kind
      const eq = te.equipment || []
      const tShield = eq.some((it) => it && it.name === 'shield')
      if (tShield && weaponOf('axe') && kind !== 'mace') useKind = 'axe'
      const w = await equipKind(useKind)
      const cd = PVP_COOLDOWN[useKind]

      // --- mace: rüzgar topuyla havaya çık, düşerek vur (smash)
      if (useKind === 'mace' && has('wind_charge') && bot.entity.onGround && dist > 2.5 && dist < 14 && now - t.wind > 2200) {
        t.wind = now
        try {
          await bot.equip(findInv(inst, 'wind_charge'), 'hand')
          await bot.lookAt(bot.entity.position.offset(0, -1, 0), true)
          bot.setControlState('jump', true)
          await sleep(60)
          bot.activateItem()
          await sleep(60)
          bot.setControlState('jump', false)
          airborneLaunch = { y: bot.entity.position.y, maxY: bot.entity.position.y, at: Date.now() }
          await equipKind('mace')
        } catch (e) { /* yoksay */ }
        continue
      }
      if (airborneLaunch) {
        const y = bot.entity.position.y
        airborneLaunch.maxY = Math.max(airborneLaunch.maxY, y)
        await lookAtTarget(te, 0.9)
        if (hd > 1.2) { bot.setControlState('forward', true); bot.setControlState('sprint', true) } else { bot.setControlState('forward', false) }
        const fell = airborneLaunch.maxY - y
        if (!bot.entity.onGround && bot.entity.velocity.y < -0.1 && fell >= 1.5 && dist <= 3.4 && now - t.hit > 250) {
          bot.attack(te); t.hit = now; st.hits++; st.smashes++
          airborneLaunch = null
          releaseMove()
        } else if (bot.entity.onGround && Date.now() - airborneLaunch.at > 400) {
          airborneLaunch = null
          releaseMove()
        } else if (Date.now() - airborneLaunch.at > 4000) { airborneLaunch = null; releaseMove() }
        await sleep(40)
        continue
      }

      // --- normal yakın dövüş
      await lookAtTarget(te)
      const inReach = hd <= 3.0 && Math.abs(dy) < 2.2
      // yaklaş / mesafeyi koru
      if (hd > 2.6) { bot.setControlState('forward', true); bot.setControlState('sprint', true) }
      else { bot.setControlState('forward', hd > 2.0); bot.setControlState('sprint', false) }
      // yan adım (rastgele aralıkla yön değiştir)
      if (now - t.strafe > 450 + Math.random() * 700) {
        t.strafe = now
        strafeDir = strafeDir === 'left' ? 'right' : 'left'
        bot.setControlState('left', false); bot.setControlState('right', false)
        bot.setControlState(strafeDir, true)
      }
      // kritik vuruş: bekleme dolmaya yakınken zıpla, düşerken vur
      const ready = now - t.hit >= cd
      if (ready && inReach && w) {
        if (bot.entity.onGround && now - t.jump > 700 && useKind !== 'mace') {
          bot.setControlState('jump', true)
          setTimeout(() => bot.setControlState('jump', false), 90)
          t.jump = now; wantCritAt = now
        } else if (!bot.entity.onGround && bot.entity.velocity.y < -0.05 || (wantCritAt && now - wantCritAt > 450) || useKind === 'mace') {
          const crit = !bot.entity.onGround && bot.entity.velocity.y < 0
          bot.attack(te)
          t.hit = now; st.hits++; if (crit) st.crits++
          if (tShield && useKind === 'axe') st.shieldBreaks++
          wantCritAt = 0
          // W-tap: sprinti sıfırla ki geri tepme tam çalışsın
          bot.setControlState('sprint', false)
          setTimeout(() => { if (!cancelled()) bot.setControlState('sprint', true) }, 110)
        }
      }
      await sleep(40)
    }
  } finally {
    bot.removeListener('entityDead', onDead)
    bot.removeListener('death', onDeath)
    if (bot.smoothLook) bot.smoothLook.fast = false
    releaseMove()
    try { bot.pathfinder.stop() } catch (e) { /* yok */ }
  }
  if (cancelled()) return fail('iptal edildi')
  const summary = `${st.hits} vuruş (${st.crits} kritik${st.smashes ? `, ${st.smashes} mace smash` : ''}${st.shieldBreaks ? `, ${st.shieldBreaks} kalkan kırma` : ''}), ${st.ate} yemek/iksir${st.healed ? `, ${st.healed} iyileştirme potu` : ''}${st.arrows ? `, ${st.arrows} ok` : ''}${st.webs ? `, ${st.webs} örümcek ağı` : ''}${st.debuffs ? `, ${st.debuffs} zayıflatma pot` : ''}${st.pearls ? `, ${st.pearls} pearl` : ''}${st.escapes ? `, ${st.escapes} rüzgar topu kaçışı` : ''}`
  const note = noteParts.length ? ` (${noteParts.join('; ')})` : ''
  if (iDied) return ok(`öldüm. ${summary}${note}`)
  return dead ? ok(`${a.target} öldü. ${summary}${note}`) : ok(`süre bitti. ${summary}${note}`)
}

// ---------------------------------------------------------------- custom: modelin kendi yazdığı eylem (güvenli adım dili)
const sleepC = sleep
async function customRun(inst, steps, ctx, budget) {
  const bot = inst.bot
  const { cancelled } = ctx
  for (const s of steps) {
    if (cancelled()) return { ok: false, msg: 'iptal edildi' }
    if (++budget.ran > 400 || Date.now() > budget.deadline) return { ok: false, msg: 'adım/süre sınırı aşıldı' }
    switch (s.op) {
      case 'equip': {
        const it = findInv(inst, s.item)
        if (!it) return { ok: false, msg: `envanterimde ${s.item} yok` }
        try { await bot.equip(it, s.slot || 'hand') } catch (e) { return { ok: false, msg: `${s.item} kuşanılamadı (${e.message})` } }
        break
      }
      case 'use': {
        if (s.item) {
          const it = findInv(inst, s.item)
          if (!it) return { ok: false, msg: `envanterimde ${s.item} yok` }
          try { await bot.equip(it, 'hand') } catch (e) { /* devam */ }
        }
        bot.activateItem()
        if (s.hold > 0) { await sleepC(s.hold); bot.deactivateItem() }
        break
      }
      case 'use_on': {
        const base = bot.entity.position.floored()
        const p = s.rel ? base.offset(s.x, s.y, s.z) : new Vec3(s.x, s.y, s.z)
        const b = bot.blockAt(p)
        if (!b || isAir(b)) return { ok: false, msg: 'o noktada blok yok' }
        await moveNear(inst, p)
        try { await bot.activateBlock(b) } catch (e) { return { ok: false, msg: `bloğa sağ tık olmadı (${e.message})` } }
        break
      }
      case 'look': {
        const pos = bot.entity.position
        if (s.at === 'down') await bot.lookAt(pos.offset(0, -1, 0), true)
        else if (s.at === 'up') await bot.lookAt(pos.offset(0, 5, 0), true)
        else if (s.at === 'player') {
          const e = playerEntity(inst, s.name === 'sender' ? ctx.sender : s.name)
          if (!e) return { ok: false, msg: `${s.name} görüş alanımda değil` }
          await bot.lookAt(e.position.offset(0, 1.6, 0), true)
        } else if (s.at === 'mob') {
          const e = nearestEntity(inst, (x) => x.name === s.name || x.type === s.name, 32)
          if (!e) return { ok: false, msg: `yakında ${s.name} yok` }
          await bot.lookAt(e.position.offset(0, (e.height || 1) * 0.8, 0), true)
        } else if (s.at === 'coord') await bot.lookAt(new Vec3(s.x, s.y, s.z), true)
        break
      }
      case 'control': {
        bot.setControlState(s.state, s.on)
        if (s.ms > 0) { await sleepC(s.ms); bot.setControlState(s.state, !s.on) }
        break
      }
      case 'wait': await sleepC(s.ms); break
      case 'say': bot.chat(s.message); break
      case 'action': {
        const r = await execute(inst, s.action, ctx)
        if (!r.ok && !s.optional) return { ok: false, msg: `${s.action.type}: ${r.msg}` }
        break
      }
      case 'repeat': {
        for (let i = 0; i < s.times; i++) {
          const r = await customRun(inst, s.steps, ctx, budget)
          if (!r.ok) return r
        }
        break
      }
      case 'if': {
        const c = s.cond
        let yes = false
        if (c.kind === 'health_below') yes = bot.health < c.value
        else if (c.kind === 'health_above') yes = bot.health > c.value
        else if (c.kind === 'food_below') yes = (bot.food ?? 20) < c.value
        else if (c.kind === 'has_item') yes = !!findInv(inst, c.item)
        else if (c.kind === 'no_item') yes = !findInv(inst, c.item)
        else if (c.kind === 'on_ground') yes = !!bot.entity.onGround
        const r = await customRun(inst, yes ? s.then : s.else, ctx, budget)
        if (!r.ok) return r
        break
      }
      default: return { ok: false, msg: `bilinmeyen adım: ${s.op}` }
    }
  }
  return { ok: true }
}

async function custom(inst, a, ctx) {
  const budget = { ran: 0, deadline: Date.now() + (a.long ? 40 * 60000 : 180000) }
  let r
  try { r = await customRun(inst, a.steps, ctx, budget) } finally {
    try { inst.bot.clearControlStates() } catch (e) { /* yok */ }
  }
  if (!r.ok) return fail(`"${a.name}" yarıda kaldı: ${r.msg}`)
  if (a.save && a.name && inst.saveMacro) inst.saveMacro(a.name, a.steps, a.desc)
  return ok(`"${a.name}" tamamlandı (${budget.ran} adım)${a.save && a.name ? ', kaydettim' : ''}`)
}

// ---------------------------------------------------------------- ek eylemler: ağaç, ekim, köprü, kule, fırlatma, kova, ışık, devriye, şekil
const LOGS_RE = /_log$/
const logIdsOf = (inst) => Object.values(inst.mcData.blocksByName).filter((b) => LOGS_RE.test(b.name) && !b.name.startsWith('stripped_')).map((b) => b.id)
const tempBlockName = (inst, pref) => (pref && findInv(inst, pref.name) ? pref.name : TEMP_BLOCKS.find((n) => invCount(inst, n) > 0))

// Bir ağacı tamamen kes (alttan üste), düşenleri topla, elinde fidan varsa yerine dik
async function chop_tree(inst, a, { cancelled }) {
  const bot = inst.bot
  const logIds = logIdsOf(inst)
  const logSet = new Set(logIds)
  let felled = 0
  let logs = 0
  while (!cancelled() && felled < a.count) {
    const start = bot.findBlock({ matching: logIds, maxDistance: 48 })
    if (!start) break
    // bağlı odun kümesi (BFS)
    const seen = new Set()
    const queue = [start.position]
    const cluster = []
    while (queue.length && cluster.length < 90) {
      const p = queue.shift()
      const k = bkey(p)
      if (seen.has(k)) continue
      seen.add(k)
      const b = bot.blockAt(p)
      if (!b || !logSet.has(b.type)) continue
      cluster.push(b.position)
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) if (dx || dy || dz) queue.push(p.offset(dx, dy, dz))
    }
    cluster.sort((x, y) => x.y - y.y)
    let cut = 0
    for (const p of cluster) {
      if (cancelled()) break
      const b = bot.blockAt(p)
      if (!b || !logSet.has(b.type)) continue
      const reached = await goTo(inst, new goals.GoalLookAtBlock(p, bot.world), { cancelled, retries: 1, timeoutMs: 20000 })
      if (!reached && b.position.distanceTo(bot.entity.position.offset(0, 1.6, 0)) > 4.6) continue
      try { await digBlock(inst, bot.blockAt(p)); cut++; logs++ } catch (e) { if (/alet/.test(e.message)) return fail(e.message) }
    }
    if (!cut) { if (!cluster.length) break; return fail('ağaca ulaşamadım') }
    felled++
    await sleep(500)
    await pickup(inst, { radius: 12 }, { cancelled }).catch(() => {})
    const sap = bot.inventory.items().find((i) => i.name.endsWith('_sapling'))
    if (sap && !cancelled()) { try { await placeAt(inst, sap.name, start.position) } catch (e) { /* yoksay */ } }
  }
  if (cancelled()) return fail('iptal edildi')
  return felled ? ok(`${felled} ağaç kestim (${logs} odun)`) : fail('yakında ağaç bulamadım')
}

// Fidan / tohum / havuç / patates ek
async function plant(inst, a, { cancelled }) {
  const bot = inst.bot
  const name = a.item.name
  if (!findInv(inst, name)) return fail(`envanterimde ${name} yok`)
  const isSap = name.endsWith('_sapling') || name === 'mangrove_propagule'
  const need = isSap ? ['dirt', 'grass_block', 'podzol', 'coarse_dirt', 'rooted_dirt', 'moss_block'] : ['farmland']
  const ids = need.map((n) => inst.mcData.blocksByName[n]).filter(Boolean).map((b) => b.id)
  const cands = bot.findBlocks({ matching: ids, maxDistance: a.radius, count: 300 }).filter((p) => isAir(bot.blockAt(p.offset(0, 1, 0))))
  if (!cands.length) return fail(isSap ? 'yakında fidan dikilecek toprak yok' : 'yakında sürülmüş tarla (farmland) yok')
  const done = []
  let planted = 0
  for (const p of cands) {
    if (cancelled() || planted >= a.count || !findInv(inst, name)) break
    if (isSap && done.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < 3)) continue
    if ((await placeAt(inst, name, p.offset(0, 1, 0))) === 'ok') { planted++; done.push(p) }
  }
  return planted ? ok(`${planted} adet ${name} diktim`) : fail(`${name} dikemedim`)
}

// Kemik tozu: ekinlere ve fidanlara
async function bone_meal(inst, a, { cancelled }) {
  const bot = inst.bot
  if (!findInv(inst, 'bone_meal')) return fail('envanterimde bone_meal yok')
  const MAXAGE = { wheat: 7, carrots: 7, potatoes: 7, beetroots: 3 }
  const ok1 = (b) => {
    if (b.name.endsWith('_sapling')) return true
    if (MAXAGE[b.name] === undefined) return false
    try { const pr = b.getProperties ? b.getProperties() : {}; return pr.age === undefined || Number(pr.age) < MAXAGE[b.name] } catch (e) { return true }
  }
  let used = 0
  while (!cancelled() && used < a.count && findInv(inst, 'bone_meal')) {
    const cands = bot.findBlocks({ matching: (b) => b && (b.name.endsWith('_sapling') || MAXAGE[b.name] !== undefined) && ok1(b), maxDistance: a.radius, count: 40 })
    if (!cands.length) break
    const block = bot.blockAt(cands[0])
    await goTo(inst, new goals.GoalNear(block.position.x, block.position.y, block.position.z, 3), { cancelled, retries: 1, timeoutMs: 15000 })
    try { await bot.equip(findInv(inst, 'bone_meal'), 'hand'); await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true); await bot.activateBlock(block); used++ } catch (e) { break }
    await sleep(250)
  }
  return used ? ok(`${used} kez kemik tozu kullandım`) : fail('kemik tozu uygulanacak ekin/fidan bulamadım')
}

// Baktığın yöne köprü kur (çömelerek, boşluğun üstüne blok koyup yürür)
async function bridge(inst, a, { cancelled }) {
  const bot = inst.bot
  const name = tempBlockName(inst, a.item)
  if (!name) return fail('köprü için blok yok')
  const [dx, dz] = yawDir(bot.entity.yaw)
  let placed = 0
  let walked = 0
  bot.setControlState('sneak', true)
  try {
    for (let i = 0; i < a.blocks && !cancelled(); i++) {
      if (invCount(inst, name) <= 0) return fail(`${name} bitti (${placed} blok koydum)`)
      const feet = bot.entity.position.floored()
      const front = feet.offset(dx, 0, dz)
      const body = bot.blockAt(front)
      const head = bot.blockAt(front.offset(0, 1, 0))
      if ((body && !isAir(body) && !isLiquid(body) && body.boundingBox === 'block') || (head && !isAir(head) && !isLiquid(head) && head.boundingBox === 'block')) return fail(`önümde blok var (${walked} blok ilerledim)`)
      const floorPos = front.offset(0, -1, 0)
      const fb = bot.blockAt(floorPos)
      if (!fb || isAir(fb) || isLiquid(fb)) {
        const r = await placeAt(inst, name, floorPos)
        if (r !== 'ok') return fail(`blok koyamadım (${r}), ${walked} blok ilerledim`)
        placed++
      }
      bot.setControlState('forward', true)
      const t0 = Date.now()
      while (Date.now() - t0 < 1500 && !cancelled()) {
        const p = bot.entity.position
        if (Math.hypot(p.x - (front.x + 0.5), p.z - (front.z + 0.5)) < 0.3) break
        await sleep(40)
      }
      bot.setControlState('forward', false)
      walked++
    }
  } finally { bot.setControlState('forward', false); bot.setControlState('sneak', false) }
  return cancelled() ? fail('iptal edildi') : ok(`${walked} blok köprü kurdum (${placed} blok koydum)`)
}

// Zıplayıp altına blok koyarak yukarı çık (kule/pillar)

// ---------------------------------------------------------------- elytra ile uçuş (roketli)
// Kalkış: zıpla -> havadayken kanat aç (elytraFly) -> roketle hız al. Hedefe yönel, yaklaşınca alçal ve in.
// Mineflayer'da pitch POZİTİF = yukarı. Roket, bakılan yönde hızlandırır.
async function fly(inst, a, { cancelled }) {
  const bot = inst.bot
  const items = () => bot.inventory.items()
  const torso = bot.inventory.slots[6]
  let elytra = items().find((i) => i.name === 'elytra') || (torso && torso.name === 'elytra' ? torso : null)
  if (!elytra) return fail('elytram yok (envanterimde elytra olmalı)')
  const rocketCount = () => items().filter((i) => i.name === 'firework_rocket').reduce((n, i) => n + i.count, 0)
  if (rocketCount() === 0) return fail('roketim (firework_rocket) yok; roket olmadan kalkış yapamam')
  const prevTorso = torso && torso.name !== 'elytra' ? torso.name : null
  try { if (!torso || torso.name !== 'elytra') await bot.equip(elytra, 'torso') } catch (e) { return fail(`elytra giyemedim (${e.message})`) }

  const sl = bot.smoothLook
  const wasFast = sl ? sl.fast : false
  if (sl) sl.fast = true
  const t0 = Date.now()
  const maxMs = a.seconds * 1000
  let rockets = 0
  let lastRocket = 0
  let started = false
  let flewTicks = 0
  let result = null
  const heldRocket = async () => {
    const r = items().find((i) => i.name === 'firework_rocket')
    if (!r) return false
    if (!bot.heldItem || bot.heldItem.name !== 'firework_rocket') { try { await bot.equip(r, 'hand') } catch (e) { return false } }
    return true
  }
  const useRocket = async () => {
    if (!(await heldRocket())) return false
    try { bot.activateItem(); rockets++; lastRocket = Date.now(); return true } catch (e) { return false }
  }
  const aim = (yaw, pitch) => { try { bot.look(yaw, Math.max(-1.2, Math.min(1.2, pitch)), true) } catch (e) { /* yoksay */ } }
  const wrapPi = (x) => { let y = (x + Math.PI) % (2 * Math.PI); if (y < 0) y += 2 * Math.PI; return y - Math.PI }

  try {
    bot.pathfinder.setGoal(null)
    // hedef konumu
    const targetPos = () => {
      if (a.target && a.target.player) { const e = playerEntity(inst, a.target.player); return e ? e.position : null }
      if (a.target) return new Vec3(a.target.x, a.target.y === null ? bot.entity.position.y : a.target.y, a.target.z)
      return null
    }
    const startY = bot.entity.position.y
    const wantY = a.height ? startY + a.height : null

    // ---- kalkış
    const dir0 = (() => { const t = targetPos(); if (!t) return bot.entity.yaw; const p = bot.entity.position; return Math.atan2(-(t.x - p.x), -(t.z - p.z)) })()
    aim(dir0, 0.6)
    await sleep(250)
    if (bot.entity.onGround) { bot.setControlState('jump', true); await sleep(120); bot.setControlState('jump', false) }
    await sleep(380)
    for (let k = 0; k < 4 && !started; k++) {
      try {
        if (typeof bot.elytraFly === 'function') await bot.elytraFly()
        else bot._client.write('entity_action', { entityId: bot.entity.id, actionId: 8, jumpBoost: 0 })
        started = true
      } catch (e) { await sleep(250) }   // henüz havada değilsek tekrar dene
    }
    if (!started) return fail('kanatları açamadım (havada olmam gerekiyor; yüksekçe bir yerden dene)')
    await sleep(150)
    await useRocket()

    // ---- uçuş döngüsü
    while (!cancelled() && Date.now() - t0 < maxMs) {
      await sleep(120)
      const pos = bot.entity.position
      const vel = bot.entity.velocity
      const speed = Math.hypot(vel.x, vel.y, vel.z) * 20   // blok/sn
      const flying = !!bot.entity.elytraFlying
      if (flying) flewTicks++
      if (!flying && bot.entity.onGround && Date.now() - t0 > 2500) break
      if (!flying && !bot.entity.onGround && Date.now() - t0 > 2000 && flewTicks === 0) {
        try { if (typeof bot.elytraFly === 'function') await bot.elytraFly() } catch (e) { /* yoksay */ }
      }
      const tp = targetPos()
      let yaw = bot.entity.yaw
      let pitch = 0.35
      let wantRocket = false
      if (tp) {
        const dx = tp.x - pos.x
        const dz = tp.z - pos.z
        const hd = Math.hypot(dx, dz)
        yaw = Math.atan2(-dx, -dz)
        const dy = tp.y - pos.y
        if (hd < 14) {
          // yaklaştık: alçal ve in
          pitch = -0.35
          if (pos.y - tp.y < 3) pitch = 0.05
          if (hd < 4 && bot.entity.onGround) break
        } else if (dy > 8) { pitch = 0.6; wantRocket = true }
        else {
          // seyir: hedef irtifayı koru, hız düşünce roket
          pitch = Math.max(-0.5, Math.min(0.5, Math.atan2(dy, Math.max(hd, 1)) * 0.8))
          wantRocket = speed < 22
        }
      } else if (wantY !== null) {
        if (pos.y < wantY) { pitch = 0.8; wantRocket = true } else { pitch = -0.05; if (Date.now() - t0 > 6000 && speed < 12) wantRocket = false }
        if (pos.y >= wantY && Date.now() - t0 > 4000) { result = ok(`${Math.round(pos.y)} yüksekliğe çıktım (${rockets} roket)`); break }
      } else {
        wantRocket = speed < 22   // hedefsiz: ileri süzül
      }
      aim(yaw + (Math.random() - 0.5) * 0.01, pitch)
      if (wantRocket && rocketCount() > 0 && Date.now() - lastRocket > 2300 && speed < 30) await useRocket()
      if (wantRocket && rocketCount() === 0 && speed < 8) { result = fail(`roketim bitti (${rockets} kullandım), süzülerek devam ediyorum`); }
      if (bot.health < 5) break
    }
    // ---- iniş: yere değene kadar hafif alçal
    const tEnd = Date.now()
    while (!cancelled() && !bot.entity.onGround && Date.now() - tEnd < 20000) {
      const tp = targetPos()
      const pos = bot.entity.position
      const yaw = tp ? Math.atan2(-(tp.x - pos.x), -(tp.z - pos.z)) : bot.entity.yaw
      const below = bot.blockAt(pos.offset(0, -6, 0))
      aim(yaw, below && below.name !== 'air' ? 0.4 : -0.25)   // yere yakınsa burnu kaldır (yavaşla)
      await sleep(120)
    }
    const p = bot.entity.position
    return result || ok(`uçtum: ${rockets} roket kullandım, şu an (${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)})`)
  } finally {
    if (sl) sl.fast = wasFast
    for (const c of ['jump', 'forward', 'sprint']) bot.setControlState(c, false)
    if (prevTorso && bot.entity.onGround) {
      const c = items().find((i) => i.name === prevTorso)
      if (c) { try { await bot.equip(c, 'torso') } catch (e) { /* yoksay */ } }
    }
  }
}


// ---------------------------------------------------------------- yeni yetenekler: status, explore, protect, loot, store_all, mine_vein
async function status(inst, a) {
  const b = inst.bot
  const p = b.entity.position
  if (a.item) return ok(`envanterimde ${invCount(inst, a.item.name)} ${a.item.name} var`)
  const inv = {}
  b.inventory.items().forEach((i) => { inv[i.name] = (inv[i.name] || 0) + i.count })
  const top = Object.entries(inv).sort((x, y) => y[1] - x[1]).slice(0, 10).map(([n, c]) => `${n} x${c}`).join(', ') || 'boş'
  const hostiles = Object.values(b.entities).filter((e) => inst.isHostile(e) && e.position.distanceTo(p) < 24).length
  return ok(`can ${Math.round(b.health)}/20, açlık ${b.food}/20, konum ${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}, envanter: ${top}, yakında ${hostiles} düşman`)
}

async function explore(inst, a, { cancelled }) {
  const bot = inst.bot
  const start = bot.entity.position.clone()
  const V = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }
  let ang = a.direction === 'random' ? Math.random() * Math.PI * 2 : Math.atan2(V[a.direction][0], -V[a.direction][1])
  let dx = a.direction === 'random' ? Math.sin(ang) : V[a.direction][0]
  let dz = a.direction === 'random' ? -Math.cos(ang) : V[a.direction][1]
  let traveled = 0
  let fails = 0
  while (!cancelled() && traveled < a.blocks && fails < 4) {
    const cur = bot.entity.position
    const hop = Math.min(30, a.blocks - traveled)
    const tx = Math.floor(cur.x + dx * hop)
    const tz = Math.floor(cur.z + dz * hop)
    const reached = await goTo(inst, new goals.GoalNearXZ(tx, tz, 4))
    const moved = bot.entity.position.distanceTo(cur)
    traveled = bot.entity.position.distanceTo(start)
    if (!reached && moved < 5) {   // engel: yönü biraz kaydır
      fails++
      ang += (Math.random() < 0.5 ? 1 : -1) * 0.7
      dx = Math.sin(ang); dz = -Math.cos(ang)
    } else fails = 0
    if (bot.health < 6) break
  }
  const p = bot.entity.position
  return cancelled() ? fail('iptal edildi') : ok(`${Math.round(traveled)} blok keşfettim, şu an ${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}`)
}

async function protect(inst, a, { cancelled }) {
  const bot = inst.bot
  let curKey = null
  const end = Date.now() + a.seconds * 1000
  let kills = 0
  try {
    while (!cancelled() && Date.now() < end) {
      const e = playerEntity(inst, a.target)
      if (!e) { await sleep(1000); continue }
      const threat = nearestEntity(inst, (x) => x.type !== 'player' && inst.isHostile(x) && x.position.distanceTo(e.position) < 10, 24)
      if (threat) {
        curKey = null
        await equipBestWeapon(inst)
        bot.pvp.attack(threat)
        await new Promise((resolve) => {
          const done = () => { clearTimeout(to); bot.removeListener('stoppedAttacking', done); resolve() }
          const to = setTimeout(done, 8000)
          bot.once('stoppedAttacking', done)
        })
        kills++
      } else {
        if (curKey !== e.id) { curKey = e.id; bot.pathfinder.setGoal(new goals.GoalFollow(e, 3), true) }
        await sleep(500)
      }
    }
  } finally { try { bot.pvp.stop() } catch (err) { /* yoksay */ } bot.pathfinder.setGoal(null) }
  return cancelled() ? ok(`korumayı bıraktım (${kills} düşmanla savaştım)`) : ok(`koruma süresi bitti, ${kills} düşmanla savaştım`)
}

const CONTAINER_NAMES = ['chest', 'trapped_chest', 'barrel']
function containerBlocks(inst, radius, count) {
  const ids = CONTAINER_NAMES.map((n) => inst.mcData.blocksByName[n] && inst.mcData.blocksByName[n].id).filter((x) => x !== undefined)
  return inst.bot.findBlocks({ matching: ids, maxDistance: radius, count })
}

async function loot(inst, a, { cancelled }) {
  const bot = inst.bot
  const spots = containerBlocks(inst, a.radius, 8)
  if (!spots.length) return fail(`${a.radius} blok çevrede sandık/varil bulamadım`)
  let total = 0
  let chests = 0
  for (const pos of spots) {
    if (cancelled()) break
    if (bot.inventory.emptySlotCount() === 0) break
    await goTo(inst, new goals.GoalNear(pos.x, pos.y, pos.z, 2))
    const block = bot.blockAt(pos)
    if (!block) continue
    let c
    try { c = await bot.openContainer(block) } catch (e) { continue }
    try {
      for (const it of c.containerItems()) {
        if (bot.inventory.emptySlotCount() === 0) break
        try { await c.withdraw(it.type, it.metadata, it.count); total += it.count } catch (e) { /* sıradaki */ }
      }
      chests++
    } finally { try { c.close() } catch (e) { /* yoksay */ } }
    await sleep(200)
  }
  return total ? ok(`${chests} sandıktan toplam ${total} eşya aldım`) : fail('sandıklar boştu ya da hiçbir şey alamadım')
}

const KEEP_ITEMS = /(_sword|_axe|_pickaxe|_shovel|_hoe|_helmet|_chestplate|_leggings|_boots|^shield$|^bow$|^crossbow$|^arrow$|^elytra$|totem|ender_pearl|_bucket$|^torch$|firework|^bread$|^cooked_|golden_apple|^mace$|_spear$|^trident$|^crafting_table$|wind_charge)/
async function store_all(inst, a, { cancelled }) {
  const bot = inst.bot
  const spots = containerBlocks(inst, a.radius, 6)
  if (!spots.length) return fail(`${a.radius} blok çevrede sandık/varil bulamadım`)
  let total = 0
  for (const pos of spots) {
    if (cancelled()) break
    const stuff = bot.inventory.items().filter((i) => !KEEP_ITEMS.test(i.name))
    if (!stuff.length) break
    await goTo(inst, new goals.GoalNear(pos.x, pos.y, pos.z, 2))
    const block = bot.blockAt(pos)
    if (!block) continue
    let c
    try { c = await bot.openContainer(block) } catch (e) { continue }
    try {
      for (const it of stuff) {
        try { await c.deposit(it.type, it.metadata, it.count); total += it.count } catch (e) { break }   // sandık doldu: sonrakine geç
      }
    } finally { try { c.close() } catch (e) { /* yoksay */ } }
    await sleep(200)
  }
  const left = bot.inventory.items().filter((i) => !KEEP_ITEMS.test(i.name)).length
  return total ? ok(`${total} eşya sandığa koydum (alet, zırh, yemek ve silahları tuttum)${left ? `, ${left} çeşit kaldı (sandık doldu)` : ''}`) : fail('sandığa bir şey koyamadım')
}

async function mine_vein(inst, a, { cancelled }) {
  const bot = inst.bot
  const ids = a.defs.map((d) => d.id)
  const first = bot.findBlock({ matching: ids, maxDistance: 32 })
  if (!first) return fail(`32 blok çevrede ${a.label} bulamadım`)
  // bağlı damarı (26 komşu) topla
  const seen = new Set([`${first.position.x},${first.position.y},${first.position.z}`])
  const queue = [first.position]
  const vein = []
  while (queue.length && vein.length < a.limit) {
    const p = queue.shift()
    vein.push(p)
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      if (!dx && !dy && !dz) continue
      const q = p.offset(dx, dy, dz)
      const k = `${q.x},${q.y},${q.z}`
      if (seen.has(k)) continue
      seen.add(k)
      const b = bot.blockAt(q)
      if (b && ids.includes(b.type)) queue.push(q)
    }
  }
  const lavaNear = (p) => {
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const n = bot.blockAt(p.offset(dx, dy, dz))
      if (n && (n.name === 'lava' || n.name === 'water')) return true
    }
    return false
  }
  let mined = 0
  let skipped = 0
  while (vein.length && !cancelled()) {
    const me = bot.entity.position
    vein.sort((x, y) => x.distanceTo(me) - y.distanceTo(me))
    const p = vein.shift()
    const b = bot.blockAt(p)
    if (!b || !ids.includes(b.type)) continue
    if (lavaNear(p)) { skipped++; continue }
    try {
      await goTo(inst, new goals.GoalLookAtBlock(p, bot.world))
      await digBlock(inst, bot.blockAt(p))
      mined++
    } catch (e) {
      if (/uygun aletim yok/.test(e.message)) return fail(`${mined} blok kazdım, sonra: ${e.message}`)
      skipped++
    }
  }
  if (cancelled()) return fail(`iptal edildi (${mined} blok kazdım)`)
  return mined ? ok(`${a.label} damarından ${mined} blok kazdım${skipped ? `, ${skipped} tanesini (lav/su yanında ya da ulaşılamaz) atladım` : ''}`) : fail(`${a.label} damarına ulaşamadım`)
}


async function auto_tool(inst, a) {
  inst.cfg.autoTool = a.on
  return ok(a.on ? 'otomatik alet seçimi açık: kırmadan önce en hızlı aleti kuşanırım' : 'otomatik alet seçimi kapalı')
}


// Sunucudaki komutları/eklentileri söyler (örn. "sunucuda tpa var mı", "hangi eklentiler var")
async function server_commands(inst, a) {
  if (!inst.serverCmds || !inst.serverCmds.size) return fail('sunucu komut listesini göndermedi (eski sürüm olabilir); /help ya da /plugins dene')
  const r = inst.cmdSummary(a.query)
  const plug = r.eklentiler.length ? `eklentiler: ${r.eklentiler.join(', ')}. ` : ''
  if (a.query && !r.komutlar.length) return fail(`"${a.query}" ile eşleşen komut yok (toplam ${r.toplam} komut kullanabiliyorum)`)
  return ok(`${plug}${a.query ? `"${a.query}" komutları` : 'işe yarar komutlar'}: ${r.komutlar.map((c) => '/' + c).join(' ')} (toplam ${r.toplam})`)
}

async function pillar_up(inst, a, { cancelled }) {
  const bot = inst.bot
  const name = tempBlockName(inst, a.item)
  if (!name) return fail('kule için blok yok')
  let cur = bot.entity.position.floored()
  let up = 0
  for (let i = 0; i < a.height && !cancelled(); i++) {
    if (invCount(inst, name) <= 0) return fail(`${name} bitti (${up} blok çıktım)`)
    let done = false
    for (let tries = 0; tries < 3 && !done; tries++) {
      await bot.look(bot.entity.yaw, -Math.PI / 2 + 0.05)
      bot.setControlState('jump', true)
      const t0 = Date.now()
      while (bot.entity.position.y < cur.y + 1.02 && Date.now() - t0 < 700) await sleep(20)
      const r = await placeAt(inst, name, cur)
      bot.setControlState('jump', false)
      if (r === 'ok') done = true
      else { await sleep(350); if (r === 'noitem') return fail(`${name} yok`) }
    }
    if (!done) return fail(`${up} blok çıkabildim, sonra blok koyamadım`)
    up++
    await sleep(250)
    cur = cur.offset(0, 1, 0)
  }
  return ok(`${up} blok yukarı çıktım`)
}

// Eşya fırlat: pearl, kartopu, yumurta, splash iksir...
async function throw_item(inst, a, { cancelled }) {
  const bot = inst.bot
  const name = a.item.name
  if (!findInv(inst, name)) return fail(`envanterimde ${name} yok`)
  let n = 0
  for (let i = 0; i < a.count && !cancelled(); i++) {
    const it = findInv(inst, name)
    if (!it) break
    let tp
    if (a.kind === 'player') { const e = playerEntity(inst, a.name); if (!e) return fail(`${a.name} görüş alanımda değil`); tp = e.position.offset(0, 0.9, 0) }
    else if (a.kind === 'pos') tp = new Vec3(a.x + 0.5, a.y + 0.5, a.z + 0.5)
    else { const [dx, dz] = yawDir(bot.entity.yaw); tp = bot.entity.position.offset(dx * 10, 1.6, dz * 10) }
    const d = tp.distanceTo(bot.entity.position)
    try {
      await bot.equip(it, 'hand')
      await bot.lookAt(tp.offset(0, d * 0.06, 0), true)   // yay düşüşünü telafi et
      bot.activateItem()
      n++
    } catch (e) { break }
    await waitFor(350, cancelled)
  }
  return n ? ok(`${n} adet ${name} fırlattım`) : fail(`${name} fırlatamadım`)
}

// Kova: sudan/lavdan doldur ya da su/lav koy
async function bucket(inst, a, { cancelled }) {
  const bot = inst.bot
  if (a.mode === 'pickup') {
    if (!findInv(inst, 'bucket')) return fail('boş kovam yok')
    const src = bot.findBlock({ matching: (b) => b && b.name === a.fluid && (b.getProperties ? Number(b.getProperties().level) === 0 : b.metadata === 0), maxDistance: 24 })
    if (!src) return fail(`yakında ${a.fluid} kaynağı yok`)
    await goTo(inst, new goals.GoalLookAtBlock(src.position, bot.world), { cancelled, retries: 1 })
    try { await bot.equip(findInv(inst, 'bucket'), 'hand'); await bot.lookAt(src.position.offset(0.5, 0.5, 0.5), true); bot.activateItem() } catch (e) { return fail(`kovayı dolduramadım (${e.message})`) }
    await sleep(400)
    return findInv(inst, `${a.fluid}_bucket`) ? ok(`kovayı ${a.fluid} ile doldurdum`) : fail('kova dolmadı')
  }
  const item = findInv(inst, `${a.fluid}_bucket`)
  if (!item) return fail(`envanterimde ${a.fluid}_bucket yok`)
  let tp
  if (a.x !== null) tp = new Vec3(a.x, a.y, a.z)
  else { const [dx, dz] = yawDir(bot.entity.yaw); const k = a.fluid === 'lava' ? 4 : 2; tp = bot.entity.position.floored().offset(dx * k, -1, dz * k) }
  if (a.fluid === 'lava' && tp.distanceTo(bot.entity.position) < 3) return fail('lavı güvenlik için bana 3 bloktan yakın koymam')
  await moveNear(inst, tp)
  try { await bot.equip(item, 'hand'); await bot.lookAt(tp.offset(0.5, 1, 0.5), true); bot.activateItem() } catch (e) { return fail(`kovayı boşaltamadım (${e.message})`) }
  await sleep(300)
  return ok(`${a.fluid} koydum`)
}

// Karanlık yerlere meşale koy
async function light_area(inst, a, { cancelled }) {
  const bot = inst.bot
  if (!findInv(inst, 'torch')) return fail('envanterimde torch yok')
  const c = bot.entity.position.floored()
  let placed = 0
  for (let dx = -a.radius; dx <= a.radius && !cancelled(); dx += a.spacing) {
    for (let dz = -a.radius; dz <= a.radius && !cancelled(); dz += a.spacing) {
      if (placed >= a.max || !findInv(inst, 'torch')) break
      let spot = null
      for (let y = c.y + 3; y >= c.y - 4; y--) {
        const floor = bot.blockAt(new Vec3(c.x + dx, y - 1, c.z + dz))
        const air = bot.blockAt(new Vec3(c.x + dx, y, c.z + dz))
        if (floor && air && !isAir(floor) && !isLiquid(floor) && floor.boundingBox === 'block' && isAir(air)) { spot = air; break }
      }
      if (!spot) continue
      const level = Math.max(spot.light || 0, 0)
      if (level > 7) continue
      await goTo(inst, new goals.GoalNear(spot.position.x, spot.position.y, spot.position.z, 3), { cancelled, retries: 0, timeoutMs: 12000 })
      if ((await placeAt(inst, 'torch', spot.position)) === 'ok') placed++
    }
  }
  return placed ? ok(`${placed} meşale koydum`) : fail('karanlık ve uygun yer bulamadım (ya da koyamadım)')
}

// Noktalar arasında devriye
async function patrol(inst, a, { cancelled }) {
  const end = Date.now() + a.seconds * 1000
  let legs = 0
  let failed = 0
  for (let l = 0; l < a.loops && !cancelled() && Date.now() < end; l++) {
    for (const p of a.points) {
      if (cancelled() || Date.now() >= end) break
      const ok1 = await goTo(inst, new goals.GoalNearXZ(p.x, p.z, 1), { cancelled, retries: 1, timeoutMs: 45000 })
      if (ok1) { legs++; await lookSweep(inst, 1, cancelled) } else failed++
    }
  }
  return cancelled() ? fail('iptal edildi') : ok(`${legs} noktaya uğradım${failed ? `, ${failed} noktaya ulaşamadım` : ''}`)
}

// Kalkan kaldır (sağ tık basılı tut)
async function shield(inst, a, { cancelled }) {
  const bot = inst.bot
  const sh = findInv(inst, 'shield')
  if (!sh) return fail('envanterimde shield yok')
  try { await bot.equip(sh, 'off-hand') } catch (e) { /* zaten takılı olabilir */ }
  bot.activateItem(true)
  await waitFor(a.seconds * 1000, cancelled)
  try { bot.deactivateItem() } catch (e) { /* yok */ }
  return ok(`${a.seconds} sn kalkan tuttum`)
}

// Çöp eşyaları at
const JUNK = ['dirt', 'gravel', 'andesite', 'diorite', 'granite', 'tuff', 'cobbled_deepslate', 'rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'sand', 'netherrack', 'cobblestone']
async function drop_junk(inst, a, { cancelled }) {
  const bot = inst.bot
  const list = a.items && a.items.length ? a.items : JUNK
  let dropped = 0
  for (const it of bot.inventory.items()) {
    if (cancelled()) break
    if (!list.includes(it.name)) continue
    const n = Math.max(0, it.count - a.keep)
    if (n <= 0) continue
    try { await bot.toss(it.type, it.metadata, n); dropped += n; await sleep(120) } catch (e) { /* yoksay */ }
  }
  return dropped ? ok(`${dropped} adet gereksiz eşya attım`) : ok('atılacak gereksiz eşya yoktu')
}

async function armor(inst) {
  if (!inst.autoArmor) return fail('zırh sistemi hazır değil')
  await inst.autoArmor().catch(() => {})
  const slots = [5, 6, 7, 8].map((i) => inst.bot.inventory.slots[i]).filter(Boolean).map((i) => i.name)
  return slots.length ? ok(`giydim: ${slots.join(', ')}`) : fail('envanterimde giyecek zırh yok')
}

// Hazır şekiller: duvar, kule, piramit, merdiven, platform, daire, küp
function shapeEntries(a) {
  const E = []
  const add = (x, y, z) => E.push({ x, y, z, item: a.item })
  const W = a.width
  const H = a.height
  const L = a.length
  const x0 = -Math.floor(W / 2)
  switch (a.shape) {
    case 'wall': for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) add(x0 + x, y, 0); break
    case 'platform': for (let x = 0; x < W; x++) for (let z = 0; z < L; z++) add(x0 + x, -1, z); break
    case 'tower':
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let z = 0; z < W; z++) if (x === 0 || z === 0 || x === W - 1 || z === W - 1) add(x0 + x, y, z)
      break
    case 'cube':
      for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) for (let z = 0; z < W; z++) if (x === 0 || z === 0 || y === 0 || x === W - 1 || z === W - 1 || y === W - 1) add(x0 + x, y, z)
      break
    case 'pyramid': {
      const half = Math.floor(W / 2)
      for (let y = 0; y <= half; y++) { const r = half - y; for (let x = -r; x <= r; x++) for (let z = -r; z <= r; z++) add(x, y, half + z) }
      break
    }
    case 'stairs': for (let i = 0; i < H; i++) for (let x = 0; x < W; x++) add(x0 + x, i, i); break
    case 'circle': {
      const r = Math.max(2, Math.floor(W / 2))
      const seen = new Set()
      for (let y = 0; y < H; y++) {
        for (let ang = 0; ang < 360; ang += 3) {
          const x = Math.round(Math.cos(ang * Math.PI / 180) * r)
          const z = Math.round(Math.sin(ang * Math.PI / 180) * r) + r
          const k = `${x},${y},${z}`
          if (!seen.has(k)) { seen.add(k); add(x, y, z) }
        }
      }
      break
    }
    default: break
  }
  return E
}
async function build_shape(inst, a, { cancelled }) { return runBuild(inst, shapeEntries(a), a.offset, cancelled) }

const EXEC = {
  server_commands, auto_tool, status, explore, protect, loot, store_all, mine_vein, get_item, fly, stop, follow, goto_player, goto: goto_, goto_block, wander, look_at, jump, sneak, set_home, go_home,
  turn, face, look_around, walk, flee, circle, emote, chop_tree, plant, bone_meal, bridge, pillar_up, throw_item, bucket, light_area, patrol, shield, drop_junk, armor, build_shape, mount, dismount, sleep: sleep_, wake, collect, mine, pickup, tunnel, dig_down, farm, fish, shear, breed,
  attack, guard, shoot, place, break: break_, fill, shelter, equip, drop, give, craft, smelt, eat,
  use_item, store, take, inspect_chest, trade, activate_block, find, chat, command, wait,
  door, enchant, anvil, fill_bottles, brew, drink, nether_portal, build, write_sign,
  redstone, schematic, schematic_info, list_schematics, download_schematic, web_search, crystal_pvp, duel, custom, skill: custom, make_farm, house,
}

async function execute(inst, action, ctx) {
  const fn = EXEC[action.type]
  if (!fn) return fail('bilinmeyen eylem')
  return fn(inst, action, ctx)
}

module.exports = { execute, equipBestWeapon, EXEC, unstick, goTo, hintsFor, worldFacing, houseEntries, __placeMany: placeMany }
