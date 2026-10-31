'use strict'
// Anti-cheat dostu "insan ritmi": aksiyonlar arasında rastgele boşluk, makul tıklama hızı, menzil dışı vuruşları engelleme,
// sohbet/komut hız sınırı ve olay döngüsü gecikme uyarısı. Kapatmak için: HUMANIZE=0
const rnd = (a, b) => a + Math.random() * (b - a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function install(inst) {
  const bot = inst.bot
  if (!bot || bot._humanized || process.env.HUMANIZE === '0') return
  bot._humanized = true

  // ---- 1) Aksiyon aralığı: aynı türden eylemler arasında en az min..max ms (yük altında paketler birikmesin)
  const last = {}
  async function space(kind, min, max) {
    // Yol bulucu yürürken kule/köprü için blok koyuyorsa zamanlama kritik: bekletme
    if (kind === 'place' && bot.pathfinder && bot.pathfinder.isMoving && bot.pathfinder.isMoving()) { last[kind] = Date.now(); return }
    const now = Date.now()
    const due = (last[kind] || 0) + rnd(min, max)
    const wait = due - now
    last[kind] = Math.max(now, due)
    if (wait > 0) await sleep(wait)
  }
  const wrapAsync = (name, kind, min, max) => {
    const orig = bot[name]
    if (typeof orig !== 'function') return
    bot[name] = async function (...args) { await space(kind, min, max); return orig.apply(bot, args) }
  }
  wrapAsync('placeBlock', 'place', 120, 260)
  wrapAsync('_placeBlockWithOptions', 'place', 120, 260)
  wrapAsync('activateBlock', 'use', 100, 240)
  wrapAsync('equip', 'equip', 80, 190)

  // ---- 2) Saldırı: gerçekçi tıklama hızı (≈6-10 CPS) ve vanilla menzili (survival 3, creative 5)
  if (typeof bot.attack === 'function') {
    const rawAttack = bot.attack.bind(bot)
    let lastHit = 0
    let gap = rnd(100, 170)
    bot.attack = (entity, ...rest) => {
      try {
        const now = Date.now()
        if (now - lastHit < gap) return
        if (entity && entity.position && bot.entity) {
          const eye = bot.entity.position.offset(0, 1.62, 0)
          const w = (entity.width || 0.6) / 2
          const h = entity.height || 1.8
          const p = entity.position
          const dx = Math.max(p.x - w - eye.x, 0, eye.x - (p.x + w))
          const dy = Math.max(p.y - eye.y, 0, eye.y - (p.y + h))
          const dz = Math.max(p.z - w - eye.z, 0, eye.z - (p.z + w))
          const lim = (bot.game && bot.game.gameMode === 'creative') ? 5.0 : 3.0
          if (Math.sqrt(dx * dx + dy * dy + dz * dz) > lim) return
        }
        lastHit = now
        gap = rnd(100, 170)
      } catch (e) { /* kontrol başarısızsa vur */ }
      return rawAttack(entity, ...rest)
    }
  }

  // ---- 3) Sohbet/komut kuyruğu: art arda gönderim yerine 400-520 ms aralık (spam ve "too fast" tepkilerini önler)
  const rawChat = bot.chat.bind(bot)
  const queue = []
  let busy = false
  async function pump() {
    if (busy) return
    busy = true
    while (queue.length) {
      const m = queue.shift()
      try { rawChat(m) } catch (e) { /* bağlantı yoksa atla */ }
      // komutların hızını zaten OP inşa modülü ayarlıyor; düz sohbet yavaş gider
      await sleep(String(m).startsWith('/') ? rnd(30, 80) : rnd(400, 520))
    }
    busy = false
  }
  bot.chat = (m) => { queue.push(m); pump() }

  // ---- 4) Olay döngüsü gecikmesi: sunucu "Timer" bayrakları çoğunlukla barındırıcının donmasından gelir
  let prev = Date.now()
  let warned = 0
  inst.timers.push(setInterval(() => {
    const now = Date.now()
    const lag = now - prev - 500
    prev = now
    if (lag > 300 && now - warned > 60000) {
      warned = now
      inst.log && inst.log('warn', `Olay döngüsü ${lag} ms gecikti (barındırıcı CPU kısıtı olabilir). Bu "Timer/Simulation" anti-cheat bayrağı yapabilir.`)
    }
  }, 500))
}

module.exports = { install }
