'use strict'
// İnsan gibi bakış ve küçük alışkanlıklar: konuşan/yaklaşan oyuncuya dönüp bakma (kafayla takip), hasar alınca saldırgana bakma,
// yere düşen eşyaya bakma, boştayken hafif kafa titremesi, ara sıra etrafa bakma / çömelme / zıplama.
// Sadece bot BOŞTAyken çalışır; iş yaparken (yürüme, kazma, inşa, dövüş) karışmaz. Kapatmak için: HUMANIZE=0
const rnd = (a, b) => a + Math.random() * (b - a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const TWO_PI = Math.PI * 2
const wrap = (a) => { let x = (a + Math.PI) % TWO_PI; if (x < 0) x += TWO_PI; return x - Math.PI }
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

function install(inst) {
  const bot = inst.bot
  if (!bot || bot._humanLook || process.env.HUMANIZE === '0' || (inst.cfg && inst.cfg.humanize === false)) return
  bot._humanLook = true

  // Boşta mıyız? İş, yürüme, kazma, dövüş ya da uyku varsa kafaya karışma
  const free = () => {
    try {
      return inst.ready && bot.entity && !bot.isSleeping && !bot.targetDigBlock && !(bot.pvp && bot.pvp.target) &&
        !(bot.pathfinder && bot.pathfinder.isMoving && bot.pathfinder.isMoving()) && !(bot.smoothLook && bot.smoothLook.fast) &&
        (inst.mode === 'idle' || inst.mode === 'follow') && (!inst.activity || inst.activity === 'boşta' || inst.mode === 'follow')
    } catch (e) { return false }
  }
  const eye = (e) => e.position.offset(0, (e.height || 1.8) * 0.9, 0)
  const entOf = (name) => { const p = bot.players[name]; return p && p.entity ? p.entity : null }
  const dist = (e) => e.position.distanceTo(bot.entity.position)

  // ---- Bakış: bir varlığı süre boyunca hafif gecikmeyle takip et (insan gözü gibi)
  let gaze = null
  const setGaze = (e, ms, delay = 0) => {
    if (!e || !e.position) return
    setTimeout(() => { if (free() || inst.mode === 'follow') { gaze = { ent: e, until: Date.now() + ms }; bot._gazeActive = true } }, delay)
  }
  const gazeTimer = setInterval(() => {
    try {
      if (!gaze) { bot._gazeActive = false; return }
      const e = gaze.ent
      if (Date.now() > gaze.until || !e.position || !bot.entities[e.id] || !free() || dist(e) > 28) { gaze = null; bot._gazeActive = false; return }
      const p = eye(e)
      bot.lookAt(p.offset(rnd(-0.12, 0.12), rnd(-0.1, 0.08), rnd(-0.12, 0.12)))
    } catch (err) { gaze = null }
  }, 180)
  inst.timers.push(gazeTimer)

  // ---- Olaylar
  bot.on('chat', (u) => {
    if (u === bot.username) return
    const e = entOf(u)
    if (e && dist(e) < 24) setGaze(e, rnd(1800, 4200), rnd(250, 900))
  })
  bot.on('whisper', (u) => { const e = entOf(u); if (e && dist(e) < 24) setGaze(e, rnd(1500, 3000), rnd(300, 800)) })
  bot.on('entityHurt', (ent) => {
    if (ent !== bot.entity || !free()) return
    const near = Object.values(bot.entities).filter((e) => e !== bot.entity && e.position && (e.type === 'player' || e.type === 'hostile' || e.type === 'mob') && dist(e) < 8)
      .sort((a, b) => dist(a) - dist(b))[0]
    if (near) setGaze(near, 1400, rnd(60, 200))
  })
  const seen = new Map()   // oyuncu -> son bakılma zamanı
  bot.on('entitySpawn', (e) => {
    if (e.type === 'player' && e.username !== bot.username && Date.now() - (seen.get(e.username) || 0) > 30000) {
      seen.set(e.username, Date.now()); setGaze(e, rnd(1200, 2600), rnd(300, 900))
    } else if (e.name === 'item' && e.position && dist(e) < 8) setGaze(e, rnd(700, 1400), rnd(150, 500))
  })
  inst.timers.push(setInterval(() => {   // sessizce yanına gelen oyuncuya bak
    try {
      if (!free() || gaze) return
      for (const p of Object.values(bot.players)) {
        const e = p.entity
        if (!e || p.username === bot.username || dist(e) > 5) continue
        if (Date.now() - (seen.get(p.username) || 0) > 45000) { seen.set(p.username, Date.now()); setGaze(e, rnd(1200, 2800), rnd(200, 700)); break }
      }
    } catch (e) { /* */ }
  }, 1000))

  // ---- Boştayken hafif kafa titremesi (el sabit durmaz)
  const drift = () => {
    try {
      if (free() && !gaze) {
        const y = wrap(bot.entity.yaw + rnd(-0.05, 0.05))
        const pch = clamp(bot.entity.pitch + rnd(-0.03, 0.03), -0.6, 0.6)
        bot.look(y, pch)
      }
    } catch (e) { /* */ }
    t1 = setTimeout(drift, rnd(900, 2600))
  }
  let t1 = setTimeout(drift, 2000)

  // ---- Ara sıra: etrafa bak / çömel / zıpla
  const fidget = async () => {
    try {
      if (free() && !gaze) {
        const r = Math.random()
        if (r < 0.55) {
          const side = Math.random() < 0.5 ? -1 : 1
          bot.look(wrap(bot.entity.yaw + side * rnd(0.6, 1.9)), clamp(rnd(-0.25, 0.3), -0.4, 0.4))
          await sleep(rnd(800, 1800))
          if (free() && Math.random() < 0.5) bot.look(wrap(bot.entity.yaw - side * rnd(0.8, 2.2)), clamp(rnd(-0.2, 0.25), -0.4, 0.4))
        } else if (r < 0.78) {
          bot.setControlState('sneak', true); await sleep(rnd(150, 420)); bot.setControlState('sneak', false)
          if (Math.random() < 0.35) { await sleep(rnd(120, 260)); bot.setControlState('sneak', true); await sleep(rnd(120, 300)); bot.setControlState('sneak', false) }
        } else if (r < 0.9) {
          bot.setControlState('jump', true); await sleep(120); bot.setControlState('jump', false)
        } else {
          bot.swingArm(Math.random() < 0.8 ? 'right' : 'left')
        }
      }
    } catch (e) { /* */ }
    t2 = setTimeout(fidget, rnd(18000, 55000))
  }
  let t2 = setTimeout(fidget, rnd(12000, 30000))

  bot.once('end', () => { clearTimeout(t1); clearTimeout(t2); clearInterval(gazeTimer); bot._humanLook = false })
}

module.exports = { install }
