'use strict'
// Tek bir Minecraft botunun yaşam döngüsü: bağlantı, sohbet -> Groq -> JSON -> doğrulama -> eylem.

const fs = require('fs')
const path = require('path')
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const pvp = require('mineflayer-pvp').plugin
const minecraftData = require('minecraft-data')

const ai = require('./ai')
const { validateActions } = require('./validate')
const { execute, equipBestWeapon } = require('./actions')

const DATA_DIR = path.join(__dirname, '..', 'data')
const ARMOR_RANK = ['leather', 'golden', 'chainmail', 'iron', 'diamond', 'netherite']
const ARMOR_SLOTS = { head: 'helmet', torso: 'chestplate', legs: 'leggings', feet: 'boots' }
const SILENT_TYPES = new Set(['stop', 'follow', 'guard', 'eat', 'equip', 'wait', 'jump', 'sneak', 'look_at', 'set_home', 'chat', 'command', 'drink', 'door', 'write_sign'])
const MAX_REPLAN = 2
const MAX_LOGS = 600

const FALLBACKS = {
  done: ['Hallettim.', 'Bitti, buyur.', 'İş tamam.', 'Tamamdır, sırada ne var?', 'Oldu bu iş.'],
  fail: ['Olmadı bu sefer, başka yol deneyelim mi?', 'Bir yerde tıkandım.', 'Bunu yapamadım, kusura bakma.', 'Takıldım kaldım.'],
  hurt: ['Auch!', 'Biri bana vuruyor!', 'Hasar aldım!', 'Hey, dur bakalım!'],
  flee: ['Canım azaldı, geri çekiliyorum!', 'Burası tehlikeli, kaçıyorum!', 'Şimdi değil, kaçıyorum!'],
  death: ['Öldüm ya...', 'Yine mi öldüm?', 'Eşyalarım...'],
  respawn: ['Geri döndüm.', 'Tekrar buradayım.', 'Selam millet.'],
  api: ['Kafam karıştı biraz, tekrar söyler misin?', 'Şu an düşünemiyorum, bir daha dener misin?', 'Bağlantım koptu gibi, tekrar yaz.'],
  dropped: ['Bir kısmını anlayamadım.', 'Söylediklerinin bir kısmı bana ters geldi.', 'Her şeyi yapamayacağım galiba.'],
}

const safeName = (s) => String(s).replace(/[^A-Za-z0-9_.@-]/g, '_')

// Geçmişe/terminale yazmak için eylemi sadeleştir
function simplify(a) {
  const o = { type: a.type }
  for (const k of ['target', 'x', 'y', 'z', 'count', 'seconds', 'slot', 'name', 'radius', 'length', 'depth', 'direction', 'mode', 'size', 'text', 'kind', 'open', 'choice', 'enter', 'potion', 'facing', 'offset']) {
    if (a[k] !== undefined && a[k] !== null) o[k] = a[k]
  }
  if (a.label) o.block = a.label
  if (a.list) o.blocks = a.list.length
  if (a.with && a.with.name) o.with = a.with.name
  if (a.item && a.item.name) o.item = a.item.name
  if (a.minX !== undefined) Object.assign(o, { x1: a.minX, y1: a.minY, z1: a.minZ, x2: a.maxX, y2: a.maxY, z2: a.maxZ })
  return o
}

class BotInstance {
  constructor(cfg, emit, hooks = {}) {
    this.cfg = cfg
    this.emit = emit
    this.hooks = hooks
    this.logs = []
    this.status = 'idle'
    this.bot = null
    this.mcData = null
    this.movements = null
    this.ready = false
    this.mode = 'idle'            // idle | busy | follow | guard | flee
    this.activity = 'boşta'
    this.guardPos = null
    this.guardRadius = 16
    this.homes = {}
    this.planId = 0
    this.history = []
    this.recentSaid = []
    this.lastResults = []
    this.recentChat = new Map()
    this.llmQueue = Promise.resolve()
    this.outQueue = []
    this.sending = false
    this.lastNarrate = 0
    this.eating = false
    this.timers = []
    this.manualStop = false
    this.retry = 0
    this.reconnectTimer = null
    this.replanDepth = 0
    this.system = ai.buildSystem(cfg.name, { strict: cfg.strict !== false })
    this.researchDepth = 0
    this.knowledge = []
  }

  // ------------------------------------------------------------ günlük & durum
  log(level, text) {
    const entry = { ts: Date.now(), level, text: String(text) }
    this.logs.push(entry)
    if (this.logs.length > MAX_LOGS) this.logs.shift()
    this.emit('log', { entry })
    if (level === 'error') console.error(`[${this.cfg.name}] ${text}`)
  }

  setStatus(s) {
    this.status = s
    this.emit('status', { summary: this.summary() })
  }

  summary() {
    const c = this.cfg
    return { name: c.name, host: c.host, port: c.port, version: c.version, auth: c.auth, model: c.model, aiOn: !!c.groqKey, status: this.status, owner: c.owner || '' }
  }

  getState() {
    const b = this.bot
    if (!b || !b.entity || !this.ready) return { status: this.status, mode: this.mode, activity: this.activity }
    const p = b.entity.position
    const inv = {}
    b.inventory.items().forEach((i) => { inv[i.name] = (inv[i.name] || 0) + i.count })
    const players = Object.values(b.players).filter((pl) => pl.username !== b.username)
      .map((pl) => ({ name: pl.username, dist: pl.entity ? Math.round(pl.entity.position.distanceTo(p)) : null }))
    const hostiles = {}
    Object.values(b.entities).forEach((e) => {
      if (this.isHostile(e) && e.position.distanceTo(p) < 24) hostiles[e.name] = (hostiles[e.name] || 0) + 1
    })
    const t = b.time && b.time.timeOfDay
    return {
      status: this.status, mode: this.mode, activity: this.activity,
      health: Math.round(b.health), food: b.food, xp: b.experience ? b.experience.level : 0,
      gamemode: b.game && b.game.gameMode, dimension: b.game && b.game.dimension,
      pos: [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)],
      time: t !== undefined ? (t >= 13000 && t < 23000 ? 'gece' : 'gündüz') : '?',
      raining: !!b.isRaining, held: b.heldItem ? b.heldItem.name : null,
      inventory: Object.entries(inv).map(([name, count]) => ({ name, count })),
      players, hostiles, homes: Object.fromEntries(Object.entries(this.homes).map(([k, v]) => [k, [v.x, v.y, v.z]])),
      version: b.version, aiOn: !!this.cfg.groqKey,
    }
  }

  // ------------------------------------------------------------ yaşam döngüsü
  start() {
    clearTimeout(this.reconnectTimer)
    this.manualStop = false
    this.ready = false
    this.setStatus('connecting')
    const c = this.cfg
    this.log('info', `${c.host}:${c.port} adresine bağlanılıyor (sürüm: ${c.version}, giriş: ${c.auth})...`)
    const opts = {
      host: c.host, port: c.port, username: c.name, auth: c.auth,
      version: c.version === 'auto' ? false : c.version,
    }
    if (c.auth === 'microsoft') {
      opts.profilesFolder = path.join(DATA_DIR, 'auth', safeName(c.name))
      opts.onMsaCode = (d) => this.log('warn', `Microsoft girişi: ${d.verification_uri} adresini aç ve şu kodu gir: ${d.user_code}`)
    }
    let bot
    try {
      bot = mineflayer.createBot(opts)
    } catch (e) {
      this.log('error', `Bot oluşturulamadı: ${e.message}`)
      this.setStatus('error')
      this.scheduleReconnect()
      return
    }
    this.bot = bot
    bot.loadPlugin(pathfinder)
    bot.loadPlugin(pvp)
    this.wire(bot)
  }

  stop() {
    this.manualStop = true
    clearTimeout(this.reconnectTimer)
    this.clearTimers()
    this.planId++
    try { if (this.bot) this.bot.quit() } catch (e) { /* zaten kapalı */ }
    this.ready = false
    this.setStatus('stopped')
    this.log('info', 'Bot durduruldu.')
  }

  homesFile() { return path.join(DATA_DIR, `homes-${safeName(this.cfg.name)}.json`) }

  loadHomes() {
    try { this.homes = JSON.parse(fs.readFileSync(this.homesFile(), 'utf8')) } catch (e) { this.homes = this.homes || {} }
  }

  saveHomes() {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(this.homesFile(), JSON.stringify(this.homes)) } catch (e) { this.log('warn', `Noktalar kaydedilemedi: ${e.message}`) }
  }

  knowledgeFile() { return path.join(DATA_DIR, `knowledge-${safeName(this.cfg.name)}.json`) }

  macrosFile() { return path.join(DATA_DIR, `macros-${safeName(this.cfg.name)}.json`) }

  loadMacros() {
    try { this.macros = JSON.parse(fs.readFileSync(this.macrosFile(), 'utf8')) } catch (e) { this.macros = {} }
  }

  // Modelin yazdığı ve başarıyla çalışan özel eylemleri kaydet (tekrar kullanılsın)
  saveMacro(name, steps, desc) {
    if (!this.macros) this.macros = {}
    this.macros[name] = { steps, desc: desc || (this.macros[name] && this.macros[name].desc) || '', ts: Date.now() }
    const names = Object.keys(this.macros)
    if (names.length > 30) delete this.macros[names.sort((a, b) => this.macros[a].ts - this.macros[b].ts)[0]]
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(this.macrosFile(), JSON.stringify(this.macros)) } catch (e) { /* önemsiz */ }
    this.log('info', `Yeni özel eylem kaydedildi: ${name}`)
  }

  loadKnowledge() {
    try { this.knowledge = JSON.parse(fs.readFileSync(this.knowledgeFile(), 'utf8')) } catch (e) { this.knowledge = [] }
  }

  // Web araması sonuçlarını hafızaya al (sonraki ilgili sorularda isteme eklenir)
  learn(query, text) {
    this.knowledge = this.knowledge.filter((k) => k.q !== query)
    this.knowledge.push({ q: query, text: String(text).slice(0, 900), ts: Date.now() })
    if (this.knowledge.length > 40) this.knowledge.shift()
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(this.knowledgeFile(), JSON.stringify(this.knowledge)) } catch (e) { /* önemsiz */ }
  }

  relevantNotes(message) {
    const words = new Set(String(message).toLowerCase().split(/[^a-zçğıöşü0-9_]+/).filter((w) => w.length > 3))
    if (!words.size) return []
    return this.knowledge
      .map((k) => ({ k, score: [...words].filter((w) => (k.q + ' ' + k.text).toLowerCase().includes(w)).length }))
      .filter((x) => x.score >= 2)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2)
      .map((x) => ({ konu: x.k.q, bilgi: x.k.text.slice(0, 500) }))
  }

  clearTimers() { this.timers.forEach((t) => clearInterval(t)); this.timers = [] }

  scheduleReconnect() {
    if (this.manualStop || !this.cfg.autoReconnect) return
    this.retry++
    const wait = Math.min(60, 5 * this.retry)
    this.log('warn', `${wait} sn sonra yeniden bağlanılacak (deneme ${this.retry})...`)
    this.reconnectTimer = setTimeout(() => this.start(), wait * 1000)
  }

  // ------------------------------------------------------------ olaylar
  wire(bot) {
    bot.once('login', () => this.log('info', `Giriş yapıldı: ${bot.username}`))

    bot.once('spawn', () => {
      this.mcData = minecraftData(bot.version)
      this.movements = new Movements(bot, this.mcData)
      this.movements.canDig = true
      this.movements.allowSprinting = true
      this.movements.allowParkour = true
      this.movements.allow1by1towers = true
      this.movements.maxDropDown = 4
      this.movements.digCost = 2          // kazarak geçmek yerine mümkünse dolaş
      this.movements.placeCost = 3
      try { bot.pathfinder.thinkTimeout = 6000; bot.pathfinder.tickTimeout = 40 } catch (e) { /* eski sürüm */ }
      try {   // iskele olarak sadece ucuz bloklar kullan
        const cheap = ['dirt', 'cobblestone', 'netherrack', 'cobbled_deepslate', 'stone', 'oak_planks']
        this.movements.scafoldingBlocks = cheap.map((n) => this.mcData.itemsByName[n] && this.mcData.itemsByName[n].id).filter((x) => x !== undefined)
      } catch (e) { /* yoksay */ }
      if ('canOpenDoors' in this.movements) this.movements.canOpenDoors = true
      try {   // insan benzeri hareket/kafa çevirme (motion.js yoksa atlanır)
        const Motion = require('./motion')
        Motion.installSmoothLook(bot)
        Motion.tuneMovements(this.movements, this.mcData)
        this.timers.push(Motion.startIdleGlance(this))
      } catch (e) { this.log('warn', `motion.js yüklenemedi (kafa çevirme anlık olacak): ${e.message}`) }
      bot.pathfinder.setMovements(this.movements)
      this.ready = true
      this.retry = 0
      this.loadHomes()
      this.loadKnowledge()
      this.loadMacros()
      this.mode = 'idle'
      this.setStatus('online')
      this.log('info', `Sunucuya girdi. Sürüm: ${bot.version}`)
      if (!this.cfg.groqKey) this.log('warn', 'Groq anahtarı yok: doğal dil kapalı. Terminalden "/komut" yazabilir veya manuel eylem JSON\'u gönderebilirsin.')
      this.timers.push(setInterval(() => {
        if (this.cfg.autoEat) { this.autoEat().catch(() => {}); this.autoArmor().catch(() => {}) }
      }, 3000))
      // Takip modunda engele takılırsa kendini kurtar (zıpla / kır / köprü kur / yön değiştir)
      let fp = null
      let fSince = Date.now()
      let fN = 0
      this.timers.push(setInterval(() => {
        try {
          if (this.mode !== 'follow' || !this.ready) { fp = null; return }
          const p = bot.entity.position
          const moving = bot.pathfinder.isMoving && bot.pathfinder.isMoving()
          if (!fp || p.distanceTo(fp) > 0.5 || !moving || bot.targetDigBlock) { fp = p.clone(); fSince = Date.now(); return }
          if (Date.now() - fSince > 6000) {
            fSince = Date.now(); fN++
            const g = bot.pathfinder.goal
            require('./actions').unstick(this, fN, g).then(() => { if (g && this.mode === 'follow') bot.pathfinder.setGoal(g, true) }).catch(() => {})
          }
        } catch (e) { /* önemsiz */ }
      }, 1000))
      this.timers.push(setInterval(() => this.emit('state', { state: this.getState() }), 1500))
    })

    bot.on('messagestr', (msg) => {
      if (!msg) return
      const m = msg.match(/^(?:\[[^\]]+\]\s*)*<?(\w{3,16})>?\s*(?:»|:|>)\s+(.+)$/)
      const isChat = m && bot.players[m[1]]
      this.log(isChat ? 'chat' : 'server', msg)
      if (isChat && m[1] !== bot.username) this.handleChat(m[1], m[2], false)   // 'chat' olayı ayrıştıramazsa yedek yol
    })
    bot.on('chat', (u, m) => this.handleChat(u, m, false))
    bot.on('whisper', (u, m) => this.handleChat(u, m, true))
    bot.on('playerJoined', (p) => { if (this.ready && p.username !== bot.username) this.log('info', `${p.username} sunucuya katıldı`) })
    bot.on('playerLeft', (p) => { if (this.ready) this.log('info', `${p.username} sunucudan ayrıldı`) })

    bot.on('physicsTick', () => this.physicsTick())

    bot.on('entityHurt', (entity) => {
      if (entity !== bot.entity || !this.cfg.autoDefend || this.mode === 'busy' || this.mode === 'flee') return
      const h = this.nearestHostile(6)
      if (h && bot.health > 6 && !bot.pvp.target) {
        this.narrate('Biri sana saldırdı, karşılık veriyorsun.', 'hurt')
        equipBestWeapon(this)
        bot.pvp.attack(h)
      }
    })

    bot.on('death', () => {
      this.planId++
      this.mode = 'idle'
      this.activity = 'boşta'
      this.log('warn', 'Öldü.')
    })
    bot.on('respawn', () => this.log('info', 'Yeniden doğdu.'))
    bot.on('kicked', (r) => this.log('error', `Sunucudan atıldı: ${typeof r === 'string' ? r : JSON.stringify(r)}`))
    bot.on('error', (e) => this.log('error', `Hata: ${e.message}`))
    bot.on('end', (reason) => {
      this.ready = false
      this.clearTimers()
      this.log('warn', `Bağlantı koptu${reason ? ` (${reason})` : ''}.`)
      if (this.manualStop) return
      this.setStatus('disconnected')
      this.scheduleReconnect()
    })
  }

  // ------------------------------------------------------------ düşman / otomatik davranışlar
  isHostile(e) {
    return !!e && e.type !== 'player' && (e.type === 'hostile' || e.kind === 'Hostile mobs') && e.name !== 'enderman'
  }

  nearestHostile(maxDist = 12, origin = this.bot.entity.position) {
    let best = null
    let bestD = maxDist
    for (const e of Object.values(this.bot.entities)) {
      if (!this.isHostile(e)) continue
      const d = e.position.distanceTo(origin)
      if (d < bestD) { best = e; bestD = d }
    }
    return best
  }

  physicsTick() {
    if (!this.ready || !this.movements) return
    const bot = this.bot
    if (this.cfg.autoDefend && bot.health <= 6 && this.nearestHostile(6)) {
      if (this.mode !== 'flee') {
        this.mode = 'flee'
        bot.pvp.stop()
        const h = this.nearestHostile(6)
        const away = bot.entity.position.minus(h.position).normalize().scaled(20).plus(bot.entity.position)
        bot.pathfinder.setGoal(new goals.GoalNear(away.x, away.y, away.z, 3))
        this.narrate('Canın çok azaldı ve yakında düşman var, kaçıyorsun.', 'flee')
        setTimeout(() => { if (this.mode === 'flee') this.mode = 'idle' }, 6000)
      }
      return
    }
    if (this.mode === 'guard' && !bot.pvp.target) {
      const h = this.nearestHostile(this.guardRadius, this.guardPos || bot.entity.position)
      if (h) { equipBestWeapon(this); bot.pvp.attack(h) }
    }
  }

  async autoEat(force = false) {
    const bot = this.bot
    if (this.eating || bot.food === undefined || !this.mcData) return false
    if (!force && bot.food > 14) return false
    if (bot.food >= 20) return false
    const foods = this.mcData.foodsByName
    const bad = ['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chorus_fruit']
    const food = bot.inventory.items()
      .filter((i) => foods[i.name] && !bad.includes(i.name))
      .sort((a, b) => foods[b.name].foodPoints - foods[a.name].foodPoints)[0]
    if (!food) return false
    this.eating = true
    try {
      const prev = bot.heldItem
      await bot.equip(food, 'hand')
      await bot.consume()
      if (prev && prev.name !== food.name) await bot.equip(prev, 'hand').catch(() => {})
    } catch (e) { /* yarıda kesildi */ }
    this.eating = false
    return true
  }

  async autoArmor() {
    const bot = this.bot
    for (const [slot, piece] of Object.entries(ARMOR_SLOTS)) {
      const cands = bot.inventory.items().filter((i) => i.name.endsWith('_' + piece))
      if (!cands.length) continue
      const score = (i) => ARMOR_RANK.indexOf(i.name.replace('_' + piece, ''))
      const best = cands.sort((a, b) => score(b) - score(a))[0]
      const cur = bot.inventory.slots[bot.getEquipmentDestSlot(slot)]
      if (!cur || score(best) > ARMOR_RANK.indexOf(cur.name.replace('_' + piece, ''))) {
        try { await bot.equip(best, slot) } catch (e) { /* sonra */ }
      }
    }
    const shield = bot.inventory.items().find((i) => i.name === 'shield')
    if (shield && !bot.inventory.slots[45]) { try { await bot.equip(shield, 'off-hand') } catch (e) { /* sürüm uyumsuzluğu */ } }
  }

  // ------------------------------------------------------------ sohbet çıkışı
  splitChat(text) {
    const t = String(text).replace(/\s+/g, ' ').trim()
    if (!t) return []
    const chunks = []
    let rest = t
    while (rest.length > 0 && chunks.length < 2) {
      if (rest.length <= 230) { chunks.push(rest); break }
      let cut = rest.lastIndexOf(' ', 230)
      if (cut < 100) cut = 230
      chunks.push(rest.slice(0, cut))
      rest = rest.slice(cut).trim()
    }
    return chunks
  }

  async pump() {
    if (this.sending) return
    this.sending = true
    while (this.outQueue.length) {
      try { this.bot.chat(this.outQueue.shift()) } catch (e) { /* bağlantı yok */ }
      await new Promise((r) => setTimeout(r, 1100))
    }
    this.sending = false
  }

  say(text) {
    if (!text || !String(text).trim()) return
    this.recentSaid.push(String(text).trim())
    if (this.recentSaid.length > 12) this.recentSaid.shift()
    this.log('bot', text)
    if (!this.ready) return
    this.splitChat(text).forEach((c) => this.outQueue.push(c))
    this.pump()
  }

  pick(kind) {
    const pool = FALLBACKS[kind] || FALLBACKS.done
    const fresh = pool.filter((p) => !this.recentSaid.includes(p))
    const list = fresh.length ? fresh : pool
    return list[Math.floor(Math.random() * list.length)]
  }

  // Olayları doğal cümleyle anlat (Groq yoksa ya da hata verirse hazır havuzdan farklı bir cümle)
  async narrate(event, kind = 'done', force = false) {
    const now = Date.now()
    if (!force && now - this.lastNarrate < 15000) return
    this.lastNarrate = now
    let line
    if (!this.cfg.groqKey) line = this.pick(kind)
    else {
      try {
        line = await ai.chat({
          apiKey: this.cfg.groqKey, model: this.cfg.model, maxTokens: 120, temperature: 0.9,
          messages: [
            { role: 'system', content: ai.persona(this.cfg.name) },
            { role: 'user', content: `[OLAY] ${event}\nSon söylediklerin (bunları tekrar etme): ${JSON.stringify(this.recentSaid.slice(-6))}\nOyuncuya bu olayla ilgili doğal, kısa (tek cümle) bir şey söyle. Sadece söyleyeceğin cümleyi yaz, JSON veya tırnak kullanma.` },
          ],
        })
        line = line.replace(/```/g, '').replace(/^["']|["']$/g, '').trim() || this.pick(kind)
      } catch (e) {
        this.log('warn', `AI anlatımı başarısız: ${e.message}`)
        line = this.pick(kind)
      }
    }
    this.say(line)
  }

  // ------------------------------------------------------------ gelen mesajlar
  handleChat(username, message, whisper) {
    const bot = this.bot
    if (!this.ready || username === bot.username) return
    if (this.hooks.isManaged && this.hooks.isManaged(username)) return
    const key = `${username}\u0000${message}`
    const nowTs = Date.now()
    if (this.recentChat.has(key) && nowTs - this.recentChat.get(key) < 1500) return
    this.recentChat.set(key, nowTs)
    if (this.recentChat.size > 50) this.recentChat.delete(this.recentChat.keys().next().value)

    const owner = this.cfg.owner
    const isOwner = owner ? username.toLowerCase() === owner.toLowerCase() : true
    const mentioned = message.toLowerCase().includes(bot.username.toLowerCase())
    if (!(whisper || mentioned || (owner && isOwner))) return
    this.queueMessage(username, username, message, owner ? isOwner : true)
  }

  // Panel terminalinden gelen girdi
  handleConsole(text, mode) {
    const t = String(text || '').trim()
    if (!t) return
    if (!this.ready) { this.log('warn', 'Bot sunucuda değil.'); return }
    if (t.startsWith('/') || mode === 'chat') {
      this.bot.chat(t.slice(0, 250))
      this.log('bot', `[Terminal -> sohbet] ${t}`)
      return
    }
    this.log('chat', `[Terminal] ${t}`)
    this.queueMessage('Terminal', this.consolePlayer(), t, true)
  }

  consolePlayer() {
    if (this.cfg.owner && this.bot.players[this.cfg.owner]) return this.cfg.owner
    return Object.keys(this.bot.players).find((n) => n !== this.bot.username) || null
  }

  queueMessage(label, senderPlayer, message, trusted) {
    if (label !== 'Sistem') { this.replanDepth = 0; this.researchDepth = 0 }
    this.llmQueue = this.llmQueue
      .then(() => this.processMessage(label, senderPlayer, message, trusted))
      .catch((e) => this.log('error', e.message))
  }

  // Elle eylem JSON'u (panel hızlı butonları / manuel kutu)
  async handleManualAction(raw) {
    if (!this.ready) { this.log('warn', 'Bot sunucuda değil.'); return }
    const actions = Array.isArray(raw) ? raw : [raw]
    const sender = this.consolePlayer()
    const v = validateActions(this, actions, { senderPlayer: sender, trusted: true })
    if (v.errors.length) this.log('warn', `Eylem hataları: ${v.errors.join(' | ')}`)
    if (v.out.length) this.runPlan(v.out, sender, false)
  }

  // ------------------------------------------------------------ yapay zeka
  snapshot(label, trusted, message = '') {
    const s = this.getState()
    const inv = {}
    ;(s.inventory || []).slice(0, 25).forEach((i) => { inv[i.name] = i.count })
    return {
      gonderen: label, sahibi_mi: trusted, can: s.health, aclik: s.food, konum: s.pos, boyut: s.dimension,
      oyun_modu: s.gamemode, zaman: s.time, yagmur: s.raining, elinde: s.held, envanter: inv,
      oyuncular: (s.players || []).slice(0, 6).map((p) => ({ ad: p.name, mesafe: p.dist })), yakin_dusmanlar: s.hostiles,
      kayitli_noktalar: s.homes, mod: this.mode, yaptigi_is: this.activity,
      son_gorev_sonuclari: this.lastResults.slice(-4), son_soylediklerin: this.recentSaid.slice(-5),
      ogrendiklerin: this.relevantNotes(message),
      kayitli_makrolar: Object.entries(this.macros || {}).map(([k, v]) => (v.desc ? `${k} (${v.desc})` : k)).slice(0, 15),
      yuklu_sematikler: /sema|schem|litem|yap[ıi]|kur|ev\b/i.test(message) ? require('./schematic').listFiles().map((f) => f.name).slice(0, 10) : undefined,
    }
  }

  async planFromAI(senderPlayer, trusted) {
    // Token tasarrufu: yalnızca SON mesajın [DURUM] bloğu tam kalır, eskilerinden çıkarılır
    const hist = this.history.map((m, i) => (m.role === 'user' && i < this.history.length - 1
      ? { role: 'user', content: m.content.replace(/^\[DURUM\] .*\n/, '') }
      : m))
    const system = ai.buildSystem(this.cfg.name, { strict: this.cfg.strict !== false, query: `${this.lastUserQuery || ''} ${this.lastQuery || ''}` })
    let messages = [{ role: 'system', content: system }, ...hist]
    let lastPlan = null
    for (let attempt = 0; attempt < 2; attempt++) {
      const text = await ai.chat({ apiKey: this.cfg.groqKey, model: this.cfg.model, messages, json: true, maxTokens: 1200 })
      const ex = ai.extractJson(text)
      let problems = []
      let plan = null
      if (ex.plainText !== undefined) {
        plan = { say: ex.plainText, actions: [], dropped: [] }
      } else if (ex.json && typeof ex.json === 'object' && !Array.isArray(ex.json)) {
        const v = validateActions(this, ex.json.actions, { senderPlayer, trusted })
        plan = { say: typeof ex.json.say === 'string' ? ex.json.say : '', actions: v.out, dropped: v.errors }
        problems = v.errors
      } else {
        problems = ['Geçerli bir JSON nesnesi ayrıştırılamadı (sözdizimi hatası).']
      }
      if (plan) lastPlan = plan
      if (!problems.length) return plan
      this.log('warn', `AI planında sorun (deneme ${attempt + 1}): ${problems.join(' | ')}`)
      if (attempt === 0) {
        messages = [
          ...messages,
          { role: 'assistant', content: text || '{}' },
          { role: 'user', content: `[SİSTEM] Cevabındaki sorunlar:\n- ${problems.join('\n- ')}\nBunları düzelterek yalnızca JSON nesnesini yeniden ver.` },
        ]
      }
    }
    if (lastPlan) return lastPlan
    throw new Error('Plan üretilemedi')
  }

  async processMessage(label, senderPlayer, message, trusted) {
    if (!this.cfg.groqKey) { this.log('warn', 'Groq anahtarı yok, doğal dil kapalı.'); return }
    if (!this.ready) return
    this.lastQuery = message
    if (label !== 'Sistem') this.lastUserQuery = message
    this.history.push({ role: 'user', content: `[DURUM] ${JSON.stringify(this.snapshot(label, trusted, message))}\n[${label}] ${message}` })
    const t0 = Date.now()
    let plan
    try {
      plan = await this.planFromAI(senderPlayer, trusted)
    } catch (e) {
      this.log('error', `AI hatası: ${e.message}`)
      this.history.pop()
      this.say(this.pick('api'))
      return
    }
    if (!trusted) plan.actions = []
    this.log('ai', `(${Date.now() - t0} ms) ${JSON.stringify({ say: plan.say, actions: plan.actions.map(simplify) })}`)

    this.history.push({ role: 'assistant', content: JSON.stringify({ say: plan.say || '', actions: plan.actions.map(simplify) }) })
    while (this.history.length > 8) this.history.splice(0, 2)

    if (plan.say) this.say(plan.say)
    if (trusted && plan.dropped && plan.dropped.length) {
      this.narrate(`İstenen bazı eylemler geçersiz olduğu için atlandı: ${plan.dropped.join(' | ')}`, 'dropped', true)
    }
    if (plan.actions.length) this.runPlan(plan.actions, senderPlayer, true).catch((e) => this.log('error', `Plan hatası: ${e.message}`))
  }

  // ------------------------------------------------------------ plan çalıştırıcı
  stopEverything() {
    try { this.bot.pathfinder.stop() } catch (e) { /* yok */ }
    try { this.bot.pvp.stop() } catch (e) { /* yok */ }
    try { this.bot.clearControlStates() } catch (e) { /* yok */ }
    this.guardPos = null
    this.mode = 'idle'
  }

  async runPlan(actions, sender, narrateResult = true) {
    const id = ++this.planId
    this.stopEverything()
    this.mode = 'busy'
    const cancelled = () => id !== this.planId
    const results = []

    for (const a of actions) {
      if (cancelled()) return
      this.activity = JSON.stringify(simplify(a))
      this.log('action', `▶ ${this.activity}`)
      let r
      try {
        r = await execute(this, a, { sender, cancelled })
      } catch (e) {
        r = { ok: false, msg: `beklenmeyen hata: ${e.message}` }
      }
      if (cancelled()) return
      this.log(r.ok ? 'action' : 'warn', `${r.ok ? '✔' : '✖'} ${a.type}: ${r.msg}`)
      results.push({ type: a.type, ok: r.ok, msg: r.msg, data: r.data })
      if (!r.ok) break
    }

    if (cancelled()) return
    if (this.mode === 'busy') this.mode = 'idle'
    this.activity = this.mode === 'follow' ? 'oyuncuyu takip ediyor' : this.mode === 'guard' ? 'nöbette' : 'boşta'
    this.lastResults.push(...results.map((r) => `${r.type}: ${r.ok ? 'başarılı' : 'BAŞARISIZ'} - ${r.msg}`))
    if (this.lastResults.length > 12) this.lastResults.splice(0, this.lastResults.length - 12)

    if (!narrateResult) return
    // Araştırma sonucu: yapay zekaya geri ver, oyuncunun orijinal isteğini ona göre yerine getirsin
    const research = results.find((r) => r.ok && r.data)
    if (research && this.cfg.groqKey && this.researchDepth < 2) {
      this.researchDepth++
      this.queueMessage('Sistem', sender, `[ARAŞTIRMA SONUCU] ${research.msg}\n${research.data}\nBu bilgiyi kullanarak oyuncunun orijinal isteğini yerine getir (gerekiyorsa eylem planı ver). Bilgi yetersizse bunu oyuncuya açıkça söyle.`, true)
      return
    }
    const failed = results.find((r) => !r.ok)
    if (!failed && results.every((r) => SILENT_TYPES.has(r.type))) return
    const summary = results.map((r) => `${r.type}: ${r.ok ? 'başarılı' : 'BAŞARISIZ'} - ${r.msg}`).join(' | ')
    // Voyager benzeri öz-düzeltme: başarısız olursa hatayı yapay zekaya geri ver, yeni plan istesin
    if (failed && this.cfg.groqKey && this.cfg.autoReplan === true && this.replanDepth < MAX_REPLAN) {
      this.replanDepth++
      this.log('info', `Otomatik yeniden planlama (${this.replanDepth}/${MAX_REPLAN})...`)
      this.queueMessage('Sistem', sender, `[GÖREV SONUCU] ${summary}\nBu görev başarısız oldu. Neden çözülebiliyorsa (eksik alet, eksik malzeme, yanlış konum gibi) düzeltilmiş yeni bir plan ver; çözemiyorsan actions boş bırak ve oyuncuya durumu doğal şekilde anlat.`, true)
      return
    }
    this.narrate(`Görev sonucu -> ${summary}`, failed ? 'fail' : 'done', true)
  }
}

module.exports = { BotInstance, simplify }
