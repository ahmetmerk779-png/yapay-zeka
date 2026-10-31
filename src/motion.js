'use strict'
// İnsan benzeri hareket: yumuşak kafa çevirme (anti-cheat dostu), akıllı yol ayarları, boştayken etrafa bakma.
// Bu dosya yoksa bot yine çalışır (bot-instance.js try/catch ile yükler), sadece kafa çevirme anlık olur.

const TWO_PI = Math.PI * 2
const wrap = (a) => { let x = (a + Math.PI) % TWO_PI; if (x < 0) x += TWO_PI; return x - Math.PI }
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
// Fare hassasiyeti %50 için dönüş adımı (~0.15°): sunucu anti-cheat'leri rotasyonun bu adımın katı olmasını bekler
const STEP = ((0.5 * 0.6 + 0.2) ** 3) * 8 * 0.15 * Math.PI / 180
const quant = (r) => Math.round(r / STEP) * STEP

function installSmoothLook(bot, opts = {}) {
  if (bot.smoothLook) return bot.smoothLook
  const raw = bot.look.bind(bot)
  const st = {
    fast: false,                      // true: anında dön (PvP)
    maxYaw: opts.maxYaw ?? 0.40,      // tick başına en çok ~23 derece
    maxPitch: opts.maxPitch ?? 0.26,
    target: null,
    waiters: [],
    since: 0,
  }
  const finish = () => { const w = st.waiters; st.waiters = []; st.target = null; w.forEach((r) => r()) }

  bot.look = (yaw, pitch, force) => {
    const p = clamp(typeof pitch === 'number' ? pitch : bot.entity.pitch, -Math.PI / 2, Math.PI / 2)
    const y = typeof yaw === 'number' ? yaw : bot.entity.yaw
    if (st.fast) { finish(); return raw(quant(y), quant(p), true) }
    return new Promise((resolve) => {
      st.target = { yaw: y, pitch: p }
      st.since = Date.now()
      st.waiters.push(resolve)
    })
  }

  bot.on('physicsTick', () => {
    const t = st.target
    if (!t || !bot.entity) return
    const cy = bot.entity.yaw
    const cp = bot.entity.pitch
    const dy = wrap(t.yaw - cy)
    const dp = t.pitch - cp
    const mv = !!(bot.pathfinder && bot.pathfinder.isMoving && bot.pathfinder.isMoving())
    if ((Math.abs(dy) < (mv ? 0.05 : 0.012) && Math.abs(dp) < (mv ? 0.05 : 0.012)) || Date.now() - st.since > (mv ? 250 : 900)) {
      raw(quant(t.yaw), quant(t.pitch), true).catch(() => {})
      finish()
      return
    }
    // yumuşak ivmelenme: uzaktayken hızlı, yaklaşınca yavaş; hafif sabit titreşim
    // Yürürken (yol bulucu yönü her tick ayarlar) kafa neredeyse anında dönmeli, yoksa bot yanlış yöne bakarak yürür ve takılır
    const moving = !!(bot.pathfinder && bot.pathfinder.isMoving && bot.pathfinder.isMoving())
    const k = moving ? 0.92 : 0.45
    const my = moving ? 1.3 : st.maxYaw
    const mp = moving ? 0.8 : st.maxPitch
    const sy = clamp(dy * k, -my, my) + (moving ? 0 : (Math.random() - 0.5) * 0.004)
    const sp = clamp(dp * k, -mp, mp) + (moving ? 0 : (Math.random() - 0.5) * 0.003)
    raw(quant(cy + sy), quant(clamp(cp + sp, -Math.PI / 2, Math.PI / 2)), true).catch(() => {})
  })
  bot.on('death', () => finish())
  bot.smoothLook = st
  return st
}

// Yol bulucu ayarları: tehlikeli blokları sev(me), değerli blokları kırma
function tuneMovements(mov, mcData) {
  const ids = (names) => names.map((n) => mcData.blocksByName[n] && mcData.blocksByName[n].id).filter((x) => x !== undefined)
  const avoid = ['cactus', 'fire', 'soul_fire', 'magma_block', 'sweet_berry_bush', 'cobweb', 'campfire', 'soul_campfire', 'wither_rose', 'powder_snow', 'lava']
  const keep = ['chest', 'trapped_chest', 'barrel', 'ender_chest', 'furnace', 'blast_furnace', 'smoker', 'crafting_table', 'enchanting_table',
    'anvil', 'beacon', 'spawner', 'end_portal_frame', 'bedrock', 'respawn_anchor', 'lectern', 'brewing_stand', 'hopper', 'shulker_box']
  try { ids(avoid).forEach((i) => mov.blocksToAvoid && mov.blocksToAvoid.add(i)) } catch (e) { /* yoksay */ }
  try { ids(keep).forEach((i) => mov.blocksCantBreak && mov.blocksCantBreak.add(i)) } catch (e) { /* yoksay */ }
  mov.dontCreateFlow = true
  mov.dontMineUnderFallingBlock = true
  mov.allowEntityDetection = true
  mov.liquidCost = 4
  mov.digCost = 3          // mümkünse kazmak yerine dolaş (yavaş ve takılgan olmasın)
  mov.placeCost = 14       // havada iskele/köprü kurmak son çare: önce dolaş, kaz ya da atla
  mov.allow1by1towers = false   // kendi altına kule çıkma sadece yol hiç yoksa (goTo son denemelerde açar)
  mov.entityCost = 2
  mov.maxDropDown = 4
}

// Yol bulucu takılırsa (takip/nöbet gibi goTo dışındaki hareketlerde) zıpla, olmazsa hedefi yeniden hesapla
function startPathWatchdog(inst) {
  const bot = inst.bot
  let last = null
  let since = 0
  let kicked = 0
  return setInterval(() => {
    try {
      if (!inst.ready || !bot.entity || !bot.pathfinder) return
      const moving = !!(bot.pathfinder.isMoving && bot.pathfinder.isMoving())
      const idleish = inst.mode === 'follow' || inst.mode === 'guard' || inst.activity === 'boşta'
      if (!moving || !idleish || bot.targetDigBlock) { last = null; kicked = 0; return }
      const p = bot.entity.position
      if (!last || p.distanceTo(last) > 0.25) { last = p.clone(); since = Date.now(); kicked = 0; return }
      const stuckFor = Date.now() - since
      if (stuckFor > 3500 && kicked < 1) {
        kicked = 1
        bot.setControlState('jump', true)
        setTimeout(() => bot.setControlState('jump', false), 350)
      } else if (stuckFor > 7000 && kicked < 2) {
        kicked = 2
        const g = bot.pathfinder.goal
        bot.pathfinder.setGoal(null)
        setTimeout(() => { try { if (g) bot.pathfinder.setGoal(g, g.dynamic === true || (g.entity !== undefined)) } catch (e) { /* */ } }, 300)
      }
    } catch (e) { /* önemsiz */ }
  }, 700)
}

// Boştayken yakındaki oyuncuya bak / etrafa göz at (komut yokken yaptığı tek şey kafa çevirmek)
function startIdleGlance(inst) {
  const bot = inst.bot
  let next = Date.now() + 3000
  const timer = setInterval(() => {
    try {
      if (!inst.ready || Date.now() < next) return
      if (process.env.HUMANIZE === '0' || (inst.cfg && inst.cfg.humanize === false)) return
      const idle = (inst.mode === 'idle' || inst.mode === 'follow') && !bot.targetDigBlock && !bot.pathfinder.isMoving() && !(bot.smoothLook && bot.smoothLook.fast)
      next = Date.now() + 2500 + Math.random() * 5500
      if (!idle || bot.isSleeping) return
      const me = bot.entity.position
      let near = null
      let nd = 10
      for (const p of Object.values(bot.players)) {
        const e = p.entity
        if (!e || p.username === bot.username) continue
        const d = e.position.distanceTo(me)
        if (d < nd) { nd = d; near = e }
      }
      if (near && Math.random() < 0.65) {
        bot.lookAt(near.position.offset(0, (near.height || 1.8) * 0.9, 0))
      } else {
        bot.look(wrap(bot.entity.yaw + (Math.random() - 0.5) * 1.4), clamp((Math.random() - 0.5) * 0.35, -0.4, 0.4))
      }
    } catch (e) { /* önemsiz */ }
  }, 700)
  return timer
}


// ---------------------------------------------------------------- insan gibi kırma (anti-cheat dostu)
// Sunucu anti-cheat'leri kırılan bloğun gerçekten NİŞAN ALINAN blok olmasını, menzili ve görüş hattını kontrol eder.
// Bu sarmalayıcı HER bot.dig çağrısını (yol bulucunun kendi kazmaları dahil) şöyle yapar:
//   1) bloğun görünen bir noktasını bulur (arada başka blok varsa kırmaz, hata verir)
//   2) o noktaya yumuşakça bakar, kısa insan tepki süresi bekler
//   3) imleç gerçekten o bloğu gösteriyor mu doğrular, sonra kırar
// Kapatmak: HUMANIZE=0
function installHumanDig(bot) {
  if (bot._humanDig || process.env.HUMANIZE === '0') return
  const rawDig = bot.dig.bind(bot)
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const rnd = (a, b) => a + Math.random() * (b - a)
  bot._humanDig = true

  const eyePos = () => bot.entity.position.offset(0, 1.62, 0)
  const reach = () => (bot.game && bot.game.gameMode === 'creative' ? 5 : 4.4)

  function visiblePoint(block) {
    if (!bot.world || typeof bot.world.raycast !== 'function') return null
    const eye = eyePos()
    const c = block.position.offset(0.5, 0.5, 0.5)
    const pts = [c]
    const o = [0.12, 0.5, 0.88]
    for (const a of o) for (const b of o) {
      pts.push(block.position.offset(a, 0.001, b), block.position.offset(a, 0.999, b))
      pts.push(block.position.offset(0.001, a, b), block.position.offset(0.999, a, b))
      pts.push(block.position.offset(a, b, 0.001), block.position.offset(a, b, 0.999))
    }
    pts.sort((p, q) => p.distanceTo(c) - q.distanceTo(c))
    for (const pt of pts) {
      const d = pt.minus(eye)
      const len = d.norm()
      if (len > reach()) continue
      let hit = null
      try { hit = bot.world.raycast(eye, d.scaled(1 / len), reach() + 0.6) } catch (e) { return null }
      if (hit && hit.position && hit.position.equals(block.position)) return pt
    }
    return undefined   // görüş yok
  }

  bot.dig = async function humanDig(block, forceLook, digFace) {
    try {
      if (!block || block.boundingBox !== 'block') return rawDig(block, forceLook, digFace)   // çiçek/ot/meşale gibi geçilebilir bloklar
      const pt = visiblePoint(block)
      if (pt === undefined) {
        const d = eyePos().distanceTo(block.position.offset(0.5, 0.5, 0.5))
        throw new Error(d > reach() ? `${block.name} menzil dışında` : `${block.name} görüş hattında değil (önünde başka blok var)`)
      }
      if (pt) {
        await bot.lookAt(pt, false)
        await sleep(rnd(70, 190))                         // insan tepki süresi
        const cur = typeof bot.blockAtCursor === 'function' ? bot.blockAtCursor(reach() + 0.6) : null
        if (cur && !cur.position.equals(block.position)) {   // imleç kaydı: bir kez daha nişan al
          await bot.lookAt(pt, false); await sleep(rnd(60, 120))
        }
        bot.setControlState('sprint', false)   // kazarken koşulmaz
        await rawDig(block, 'ignore', 'raycast')
        if (!(bot.game && bot.game.gameMode === 'creative')) await sleep(rnd(30, 140))
        return
      }
    } catch (e) {
      if (/menzil|görüş hattı/.test(e.message)) throw e
      // beklenmeyen bir sorun: orijinal kırmaya düş
    }
    return rawDig(block, forceLook, digFace)
  }
}

module.exports = {
  startPathWatchdog, installHumanDig, installSmoothLook, tuneMovements, startIdleGlance, wrap, clamp, quant }
