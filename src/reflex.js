'use strict'
// Hayatta kalma refleksleri. Hepsi try/catch içinde; hata botu düşürmez.
// Kapatmak için: REFLEX=0
const { goals } = require('mineflayer-pathfinder')

function install(inst) {
  const bot = inst.bot
  if (process.env.REFLEX === '0' || !bot) return
  const safe = (fn) => async () => { try { await fn() } catch (e) { /* önemsiz */ } }
  let deathPos = null
  let recovering = false

  // Ölüm noktasını hatırla
  bot.on('death', () => {
    try { if (bot.entity) deathPos = bot.entity.position.clone() } catch (e) { /* */ }
  })
  bot.on('spawn', () => {
    if (!deathPos) return
    const pos = deathPos
    deathPos = null
    setTimeout(() => recover(pos).catch(() => {}), 2500)
  })

  async function recover(pos) {
    if (recovering || !inst.ready || inst.mode === 'busy') return
    recovering = true
    const pid = inst.planId
    try {
      inst.narrate && inst.narrate('Öldüm; eşyalarımı almak için ölüm noktasına gidiyorum.', 'info')
      inst.mode = 'busy'; inst.activity = 'eşyaları kurtarıyor'
      bot.pathfinder.setGoal(new goals.GoalNear(pos.x, pos.y, pos.z, 2))
      const t0 = Date.now()
      while (Date.now() - t0 < 60000 && bot.entity.position.distanceTo(pos) > 3 && inst.planId === pid) {
        await new Promise((r) => setTimeout(r, 500))
      }
      if (inst.planId === pid) await collectDrops(12000, 16)
      if (inst.planId !== pid) return   // kullanıcı yeni komut verdi: karışma
    } finally {
      if (inst.planId === pid && inst.mode === 'busy') { bot.pathfinder.setGoal(null); inst.mode = 'idle'; inst.activity = 'boşta' }
      recovering = false
    }
  }

  async function collectDrops(ms, radius, abort) {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (abort && abort()) return
      const p = bot.entity.position
      const drop = Object.values(bot.entities)
        .filter((e) => (e.name === 'item' || e.displayName === 'Item') && e.position.distanceTo(p) < radius)
        .sort((a, b) => a.position.distanceTo(p) - b.position.distanceTo(p))[0]
      if (!drop) break
      bot.pathfinder.setGoal(new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 0.5))
      await new Promise((r) => setTimeout(r, 900))
    }
    if (!(abort && abort())) bot.pathfinder.setGoal(null)
  }

  // Totem: ikinci ele otomatik al
  inst.timers.push(setInterval(safe(async () => {
    if (!inst.ready) return
    const off = bot.inventory.slots[45]
    if (off && off.name === 'totem_of_undying') return
    const t = bot.inventory.items().find((i) => i.name === 'totem_of_undying')
    if (t) await bot.equip(t, 'off-hand')
  }), 4000))

  // Bot kendi attığı eşyayı (give/drop/drop_junk) geri toplamasın
  let lastToss = 0
  if (typeof bot.toss === 'function' && !bot._tossWrapped) {
    const rawToss = bot.toss.bind(bot)
    bot._tossWrapped = true
    bot.toss = (...args) => { lastToss = Date.now(); return rawToss(...args) }
  }

  // Boşta iken yakındaki düşen eşyaları topla
  inst.timers.push(setInterval(safe(async () => {
    if (!inst.ready || inst.mode !== 'idle' || recovering || Date.now() - lastToss < 30000) return
    const me = bot.entity.position
    if (Object.values(bot.players).some((pl) => pl.username !== bot.username && pl.entity && pl.entity.position.distanceTo(me) < 6)) return   // yanında oyuncu varken toplama (ona atılmış olabilir)
    const p = bot.entity.position
    const near = Object.values(bot.entities).some((e) => e.name === 'item' && e.position.distanceTo(p) < 7)
    if (!near) return
    const pid = inst.planId
    inst.mode = 'busy'; inst.activity = 'eşya topluyor'
    try { await collectDrops(5000, 7, () => inst.planId !== pid) } finally { if (inst.planId === pid && inst.mode === 'busy') { bot.pathfinder.setGoal(null); inst.mode = 'idle'; inst.activity = 'boşta' } }
  }), 5000))

  // Envanter dolmak üzereyse bir kez haber ver (toplama işleri sessizce takılmasın)
  let fullWarned = 0
  inst.timers.push(setInterval(safe(async () => {
    if (!inst.ready) return
    const empty = typeof bot.inventory.emptySlotCount === 'function' ? bot.inventory.emptySlotCount() : 99
    if (empty <= 1 && Date.now() - fullWarned > 5 * 60 * 1000) {
      fullWarned = Date.now()
      inst.narrate && inst.narrate('Envanterim dolmak üzere. "envanteri boşalt" dersen yakındaki sandığa koyarım, ya da "çöpleri at" diyebilirsin.', 'info')
    }
  }), 10000))

  // Lavda / suda boğulurken yüzeye ve karaya çık
  inst.timers.push(setInterval(safe(async () => {
    if (!inst.ready || !bot.entity) return
    const feet = bot.blockAt(bot.entity.position)
    if (!feet) return
    if (feet.name === 'lava') {
      bot.setControlState('jump', true); bot.setControlState('forward', true)
      setTimeout(() => { bot.setControlState('jump', false); bot.setControlState('forward', false) }, 1500)
    } else if (feet.name === 'water' && bot.oxygenLevel !== undefined && bot.oxygenLevel < 10) {
      bot.setControlState('jump', true)
      setTimeout(() => bot.setControlState('jump', false), 1500)
    }
  }), 700))
}

module.exports = { install }
