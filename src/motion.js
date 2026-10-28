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
    if ((Math.abs(dy) < 0.012 && Math.abs(dp) < 0.012) || Date.now() - st.since > 900) {
      raw(quant(t.yaw), quant(t.pitch), true).catch(() => {})
      finish()
      return
    }
    // yumuşak ivmelenme: uzaktayken hızlı, yaklaşınca yavaş; hafif sabit titreşim
    const sy = clamp(dy * 0.45, -st.maxYaw, st.maxYaw) + (Math.random() - 0.5) * 0.004
    const sp = clamp(dp * 0.45, -st.maxPitch, st.maxPitch) + (Math.random() - 0.5) * 0.003
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
  mov.entityCost = 2
  mov.maxDropDown = 4
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

module.exports = { installSmoothLook, tuneMovements, startIdleGlance, wrap, clamp, quant }
