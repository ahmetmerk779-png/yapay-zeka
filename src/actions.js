'use strict'
// Doğrulanmış eylemlerin Mineflayer ile gerçekten uygulandığı yer.
// Her uygulayıcı { ok, msg } döndürür; hata fırlatsa bile plan çalıştırıcı yakalar.

const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const Sch = require('./schematic')
const search = require('./search')
const crystal = require('./crystal')
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
// Takılma korumalı yürüme: ilerleme yoksa zıpla/yan adım/önündeki bloğu kır, sonra yeniden yol bul.
async function unstick(inst, attempt) {
  const bot = inst.bot
  try {
    bot.pathfinder.stop()
    bot.clearControlStates()
    const yaw = bot.entity.yaw
    // Önündeki ayak/baş hizası bloğu engelse kır (kazma izni açıksa)
    if (inst.movements && inst.movements.canDig) {
      const dir = new Vec3(-Math.sin(yaw), 0, -Math.cos(yaw))
      for (const dy of [1, 0]) {
        const b = bot.blockAt(bot.entity.position.offset(Math.round(dir.x), dy, Math.round(dir.z)).floored())
        if (b && b.diggable && b.name !== 'air' && !LIQUIDS.has(b.name) && bot.canDigBlock(b)) {
          try { await bot.dig(b) } catch (e) { /* yoksay */ }
        }
      }
    }
    // Rastgele yan adım + zıplama
    const dirs = ['left', 'right', 'back', 'forward']
    const d = dirs[(attempt + Math.floor(Math.random() * 2)) % dirs.length]
    bot.setControlState(d, true); bot.setControlState('jump', true)
    await sleep(500 + attempt * 200)
    bot.clearControlStates()
  } catch (e) { try { inst.bot.clearControlStates() } catch (e2) { /* yok */ } }
}

async function goTo(inst, goal, opts = {}) {
  const bot = inst.bot
  const maxRetries = opts.retries === undefined ? 3 : opts.retries
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let finished = false
    let result = false
    let abortedStuck = false
    const start = bot.pathfinder.goto(goal).then(() => { result = true }, () => { result = false }).then(() => { finished = true })
    let last = bot.entity.position.clone()
    let lastMove = Date.now()
    const t0 = Date.now()
    while (!finished) {
      await sleep(500)
      if (opts.cancelled && opts.cancelled()) { try { bot.pathfinder.stop() } catch (e) { /* yok */ } break }
      const p = bot.entity.position
      // Kazarken / yol hesaplarken durmak takılmak sayılmaz
      const busy = !!bot.targetDigBlock || !(bot.pathfinder.isMoving && bot.pathfinder.isMoving())
      if (p.distanceTo(last) > 0.4 || busy) { last = p.clone(); lastMove = Date.now() }
      const stuck = Date.now() - lastMove > 5000
      const tooLong = Date.now() - t0 > (opts.timeoutMs || 60000)
      if (stuck || tooLong) { abortedStuck = stuck; try { bot.pathfinder.stop() } catch (e) { /* yok */ } break }
    }
    await Promise.race([start, sleep(1000)])
    if (result) return true
    if (opts.cancelled && opts.cancelled()) return false
    if (!abortedStuck) return false   // yol yok / hedef erişilemez: zıplamanın faydası yok
    await unstick(inst, attempt)
  }
  return false
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
  await bot.dig(block)
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
async function placeAt(inst, itemName, pos, opts = {}) {
  const bot = inst.bot
  const target = bot.blockAt(pos)
  if (target && !REPLACEABLE.has(target.name)) return 'full'
  const item = findInv(inst, itemName)
  if (!item) return 'noitem'

  await moveNear(inst, pos)
  const feet = bot.entity.position.floored()
  if (feet.equals(pos) || feet.offset(0, 1, 0).equals(pos)) {
    await goTo(inst, new goals.GoalInvert(new goals.GoalNear(pos.x, pos.y, pos.z, 2)))
  }

  const faces = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]
  if (opts.refDir) faces.unshift(opts.refDir)
  for (const f of faces) {
    const ref = bot.blockAt(pos.offset(f[0], f[1], f[2]))
    if (!ref || isAir(ref) || isLiquid(ref) || ref.boundingBox !== 'block') continue
    let sneaking = false
    try {
      await bot.equip(item, 'hand')
      const face = new Vec3(-f[0], -f[1], -f[2])
      if (INTERACTABLE.test(ref.name)) { bot.setControlState('sneak', true); sneaking = true; await sleep(130) }
      if (opts.lookDir && DIR_VEC[opts.lookDir]) {
        const v = DIR_VEC[opts.lookDir]
        await bot.lookAt(bot.entity.position.offset(0, 1.62, 0).plus(new Vec3(v[0], v[1], v[2]).scaled(5)), true)
        await rawPlace(bot, ref, face, { forceLook: 'ignore', half: opts.half })
      } else {
        await rawPlace(bot, ref, face, { half: opts.half })
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
  inst.bot.pathfinder.setGoal(new goals.GoalFollow(e, 2), true)
  inst.mode = 'follow'
  return ok(`${a.target} takip ediliyor`)
}

async function goto_player(inst, a) {
  const e = playerEntity(inst, a.target)
  if (!e) return fail(`${a.target} çok uzakta, göremiyorum`)
  return (await goTo(inst, new goals.GoalNear(e.position.x, e.position.y, e.position.z, 2)))
    ? ok(`${a.target} yanına vardım`) : fail('oraya yol bulamadım')
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
    await waitFor(400 + Math.random() * 1800, cancelled)
  }
  return ok(`${moves} noktaya uğrayarak gezindim`)
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
      return mined > 0 ? ok(`${mined} adet ${a.label} kırdım, çevrede başka kalmadı`) : fail(`64 blok çevrede ${a.label} bulamadım`)
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
      const seed = findInv(inst, CROPS[b.name].seed)
      const ground = bot.blockAt(pos.offset(0, -1, 0))
      if (seed && ground && ['farmland', 'soul_sand'].includes(ground.name)) {
        await bot.equip(seed, 'hand')
        await bot.placeBlock(ground, new Vec3(0, 1, 0))
        replanted++
      }
    } catch (e) { /* sıradaki */ }
  }
  if (cancelled()) return fail('iptal edildi')
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

async function breed(inst, a, { cancelled }) {
  const bot = inst.bot
  const food = findInv(inst, a.itemName)
  if (!food) return fail(`envanterimde ${a.itemName} yok`)
  const animals = Object.values(bot.entities)
    .filter((e) => e.name === a.animal && e.position.distanceTo(bot.entity.position) <= 20)
    .sort((x, y) => x.position.distanceTo(bot.entity.position) - y.position.distanceTo(bot.entity.position))
    .slice(0, 2)
  if (animals.length < 2) return fail(`çiftleştirmek için en az 2 ${a.animal} lazım, ${animals.length} tane buldum`)
  let fed = 0
  for (const an of animals) {
    if (cancelled()) break
    await goTo(inst, new goals.GoalNear(an.position.x, an.position.y, an.position.z, 2))
    try { await bot.equip(food, 'hand'); await bot.activateEntity(an); fed++ } catch (e) { /* sıradaki */ }
    await sleep(400)
  }
  return fed === 2 ? ok(`iki ${a.animal} yemledim`) : fail(`sadece ${fed} hayvanı yemleyebildim`)
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
async function place(inst, a) {
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

const isCreative = (inst) => !!(inst.bot.game && inst.bot.game.gameMode === 'creative')

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
  const eye = bot.entity.position.offset(0, 1.62, 0)
  if (eye.distanceTo(pos.offset(0.5, 0.5, 0.5)) <= 4.3) return
  if (isCreative(inst) && bot.creative && bot.creative.flyTo) {
    try {
      if (!bot.creative.flying && bot.creative.startFlying) bot.creative.startFlying()
      const cur = bot.entity.position
      const hover = Math.max(cur.y, pos.y + 2.5)
      if (hover > cur.y + 0.1) await bot.creative.flyTo(new Vec3(cur.x, hover, cur.z))
      await bot.creative.flyTo(new Vec3(pos.x + 0.5, hover, pos.z + 0.5))
      return
    } catch (e) { /* yürümeyi dene */ }
  }
  await goTo(inst, new goals.GoalNear(pos.x, pos.y, pos.z, 3))
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

  // malzeme kontrolü (creative'de gerekmez)
  const need = {}
  for (const t of todo) need[t.item] = (need[t.item] || 0) + (t.kind === 'double' ? 2 : 1)
  if (!creative) {
    const missing = Object.entries(need).filter(([n, k]) => invCount(inst, n) < k).map(([n, k]) => `${n} (${invCount(inst, n)}/${k})`)
    if (todo.some((t) => t.kind === 'farmland') && !bot.inventory.items().some((i) => i.name.endsWith('_hoe'))) missing.push('çapa (hoe)')
    if (missing.length && !opts.partial) {
      stats.blocked = `malzeme eksik, başlamadım -> ${missing.slice(0, 10).join(', ')}. Eksik olanla devam etmemi istersen "partial" de`
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
    const r = await placeOne(inst, t, creative)
    remainingNeed[t.item] = Math.max(0, (remainingNeed[t.item] || 0) - (t.kind === 'double' ? 2 : 1))
    if (r === 'ok') stats.placed++
    else if (r === 'noitem') stats.noitem++
    else if (r !== 'full') stats.failed++
    n++
    if (n % 40 === 0) inst.log('action', `${opts.label || 'inşa'}: ${n}/${todo.length}`)
  }

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
  if (s.already) parts.push(`${s.already} zaten yerinde`)
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

async function craft(inst, a, { cancelled }) {
  const bot = inst.bot
  const item = a.item
  let table = null
  let recipes = bot.recipesFor(item.id, null, 1, null)
  if (!recipes.length) {
    table = bot.findBlock({ matching: inst.mcData.blocksByName.crafting_table.id, maxDistance: 32 })
    if (!table) {
      const tableItem = findInv(inst, 'crafting_table')
      if (tableItem) table = await placeTable(inst, tableItem)
    }
    if (table) {
      await goTo(inst, new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2))
      recipes = bot.recipesFor(item.id, null, 1, table)
    }
  }
  if (!recipes.length) return fail(`${item.name} için malzemem yok ya da yakında crafting_table yok`)
  const recipe = recipes[0]
  const per = (recipe.result && recipe.result.count) || 1
  const times = Math.max(1, Math.ceil(a.count / per))
  let made = 0
  for (let i = 0; i < times && !cancelled(); i++) {
    try { await bot.craft(recipe, 1, table); made += per } catch (e) { break }
  }
  return made > 0 ? ok(`${made} adet ${item.name} ürettim`) : fail(`${item.name} üretemedim, malzeme yetmedi`)
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
  const e = nearestEntity(inst, (x) => x.name === 'villager' || x.name === 'wandering_trader', 32)
  if (!e) return fail('yakında köylü yok')
  await goTo(inst, new goals.GoalNear(e.position.x, e.position.y, e.position.z, 2))
  let v
  try { v = await bot.openVillager(e) } catch (err) { return fail(`köylüyle konuşamadım (${err.message})`) }
  try {
    const idx = v.trades.findIndex((t) => t.outputItem && t.outputItem.name === a.item.name && !t.tradeDisabled)
    if (idx === -1) {
      const offers = v.trades.map((t) => t.outputItem && t.outputItem.name).filter(Boolean).slice(0, 8).join(', ')
      return fail(`köylü ${a.item.name} satmıyor. Sattıkları: ${offers || 'yok'}`)
    }
    await bot.trade(v, idx, a.count)
    return ok(`köylüden ${a.item.name} aldım`)
  } catch (err) { return fail(`takas olmadı (${err.message})`) } finally { try { v.close() } catch (err) {} }
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
    targets.push({ pos, item: it.item, blockName: b.name, kind, hints: hintsFor(b.name, b.props) })
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
    if (len > Sch.MAX_FILE_BYTES) return fail('dosya 20 MB sınırını aşıyor')
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > Sch.MAX_FILE_BYTES) return fail('dosya 20 MB sınırını aşıyor')
    const name = Sch.saveFile(a.name, buf)
    try { await Sch.load(name) } catch (e) { Sch.deleteFile(name); return fail(`indirilen dosya geçerli bir şematik değil: ${e.message}`) }
    return ok(`${name} indirildi (${Math.round(buf.length / 1024)} KB)`)
  } catch (e) {
    return fail(`indirme hatası: ${e.message}`)
  } finally { clearTimeout(timer) }
}

async function web_search(inst, a) {
  try {
    const r = await search.webSearch(a.query, { groqKey: inst.cfg.groqKey, searchModel: inst.cfg.searchModel })
    if (inst.learn) inst.learn(a.query, r.text)
    inst.log('ai', `Arama (${r.source}): ${r.text.slice(0, 500).replace(/\s+/g, ' ')}...`)
    return { ok: true, msg: `"${a.query}" için araştırma tamamlandı (${r.source})`, data: r.text.slice(0, 3000) }
  } catch (e) { return fail(e.message) }
}

// ---- kristal PvP (deneysel, basit sezgisel)
async function crystal_pvp(inst, a, { cancelled }) {
  const bot = inst.bot
  if (!inst.cfg.allowPvp && !a.friendly) return fail('oyunculara saldırı kapalı')
  if (!findInv(inst, 'end_crystal')) return fail('envanterimde end_crystal yok')
  if (!playerEntity(inst, a.target)) return fail(`${a.target} görüş alanımda değil`)
  const baseIds = ['obsidian', 'bedrock'].map((n) => inst.mcData.blocksByName[n]).filter(Boolean).map((b) => b.id)
  if (inst.autoArmor) await inst.autoArmor().catch(() => {})
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
    try { bot.pathfinder.stop() } catch (e) { /* kapalı */ }
  }
  if (cancelled()) return fail('iptal edildi')
  const summary = `${stats.placed} kristal koydum, ${stats.hit} kez kristale vurdum, ${stats.melee} yakın vuruş, ${stats.obs} obsidyen`
  return dead ? ok(`${a.target} öldü. ${summary}`) : ok(`süre/bağlantı bitti. ${summary}`)
}

// ---- 9x9 (yarıçap R) çalışan tarla: ortada su, çevresi çapalanmış ve ekilmiş
async function make_farm(inst, a, { cancelled }) {
  const bot = inst.bot
  const seedName = { wheat: 'wheat_seeds', carrots: 'carrot', potatoes: 'potato', beetroots: 'beetroot_seeds' }[a.crop]
  const hoe = bot.inventory.items().find((i) => i.name.endsWith('_hoe'))
  if (!hoe) return fail('envanterimde çapa (hoe) yok')
  const bucket = findInv(inst, 'water_bucket')
  if (!bucket) return fail('envanterimde su kovası (water_bucket) yok')
  const R = a.radius
  const cells = (R * 2 + 1) ** 2 - 1
  if (invCount(inst, seedName) < cells) return fail(`${cells} adet ${seedName} lazım, envanterimde ${invCount(inst, seedName)} var`)
  const c = bot.entity.position.floored()
  const [fx, fz] = yawDir(bot.entity.yaw)
  const center = c.offset(fx * (a.offset + R), -1, fz * (a.offset + R))     // merkez zemin bloğu
  const ground = []
  for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) if (dx || dz) ground.push(center.offset(dx, 0, dz))
  const okGround = new Set(['dirt', 'grass_block', 'farmland', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium'])
  const bad = ground.filter((p) => { const b = bot.blockAt(p); return !b || !okGround.has(b.name) }).length
  if (bad > cells * 0.2) return fail(`alanın ${bad}/${cells} zemini toprak/çimen değil, düz bir yer seç`)
  const near = async (p, r = 3) => { if (bot.entity.position.offset(0, 1.62, 0).distanceTo(p.offset(0.5, 1, 0.5)) > 4.2) await goTo(inst, new goals.GoalNear(p.x, p.y + 1, p.z, r)) }

  // 1) üstteki bitkileri temizle
  for (const p of ground) {
    if (cancelled()) return fail('iptal edildi')
    const up = bot.blockAt(p.offset(0, 1, 0))
    if (up && !isAir(up) && up.diggable && !isLiquid(up)) { await near(p); try { await digBlock(inst, up) } catch (e) { /* atla */ } }
  }
  // 2) ortadaki bloğu kaz, suyu koy
  await near(center, 2)
  const cb = bot.blockAt(center)
  if (cb && !isAir(cb)) { try { await digBlock(inst, cb) } catch (e) { return fail(`merkez kazılamadı: ${e.message}`) } }
  await bot.equip(bucket, 'hand')
  await bot.lookAt(center.offset(0.5, 0, 0.5), true)
  bot.activateItem()
  await sleep(700)
  // 3) çapala
  await bot.equip(hoe, 'hand')
  let tilled = 0
  for (const p of ground) {
    if (cancelled()) return fail('iptal edildi')
    const b = bot.blockAt(p)
    if (!b || b.name === 'farmland') { if (b) tilled++; continue }
    await near(p)
    try { await bot.equip(hoe, 'hand'); await bot.activateBlock(b); await sleep(60); tilled++ } catch (e) { /* atla */ }
  }
  // 4) ek
  let planted = 0
  for (const p of ground) {
    if (cancelled()) return fail('iptal edildi')
    const b = bot.blockAt(p)
    if (!b || b.name !== 'farmland' || !isAir(bot.blockAt(p.offset(0, 1, 0)))) continue
    const seed = findInv(inst, seedName)
    if (!seed) break
    await near(p)
    try { await bot.equip(seed, 'hand'); await bot.placeBlock(b, new Vec3(0, 1, 0)); planted++ } catch (e) { /* atla */ }
  }
  const waterOk = (bot.blockAt(center) || {}).name === 'water'
  return planted > 0
    ? ok(`${tilled} tarla çapaladım, ${planted} ${a.crop} ektim${waterOk ? ', ortada su var' : ', UYARI: ortadaki su yerleşmemiş olabilir'}`)
    : fail(`ekim yapamadım (${tilled} blok çapalandı). Zemin/menzil sorunu olabilir`)
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
  let dead = false
  let iDied = false
  const onDead = (e) => { if (e && e.username === a.target) dead = true }
  const onDeath = () => { iDied = true }
  bot.on('entityDead', onDead)
  bot.on('death', onDeath)

  const st = { hits: 0, crits: 0, smashes: 0, ate: 0, healed: 0, arrows: 0, shieldBreaks: 0 }
  const t = { hit: 0, eat: 0, heal: 0, bow: 0, launch: 0, strafe: 0, jump: 0, wind: 0 }
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

  // Başlangıç iksirleri (pot): güç, hız, ateş direnci
  if (style === 'pot') {
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
    releaseMove()
    try { bot.pathfinder.stop() } catch (e) { /* yok */ }
  }
  if (cancelled()) return fail('iptal edildi')
  const summary = `${st.hits} vuruş (${st.crits} kritik${st.smashes ? `, ${st.smashes} mace smash` : ''}${st.shieldBreaks ? `, ${st.shieldBreaks} kalkan kırma` : ''}), ${st.ate} yemek/iksir${st.healed ? `, ${st.healed} iyileştirme potu` : ''}${st.arrows ? `, ${st.arrows} ok` : ''}`
  const note = noteParts.length ? ` (${noteParts.join('; ')})` : ''
  if (iDied) return ok(`öldüm. ${summary}${note}`)
  return dead ? ok(`${a.target} öldü. ${summary}${note}`) : ok(`süre bitti. ${summary}${note}`)
}

const EXEC = {
  stop, follow, goto_player, goto: goto_, goto_block, wander, look_at, jump, sneak, set_home, go_home,
  mount, dismount, sleep: sleep_, wake, collect, mine, pickup, tunnel, dig_down, farm, fish, shear, breed,
  attack, guard, shoot, place, break: break_, fill, shelter, equip, drop, give, craft, smelt, eat,
  use_item, store, take, inspect_chest, trade, activate_block, find, chat, command, wait,
  door, enchant, anvil, fill_bottles, brew, drink, nether_portal, build, write_sign,
  schematic, schematic_info, list_schematics, download_schematic, web_search, crystal_pvp, duel, make_farm, house,
}

async function execute(inst, action, ctx) {
  const fn = EXEC[action.type]
  if (!fn) return fail('bilinmeyen eylem')
  return fn(inst, action, ctx)
}

module.exports = { execute, equipBestWeapon, EXEC, hintsFor, worldFacing, houseEntries, __placeMany: placeMany }
