'use strict'
// Web panel sunucusu: statik sayfa + WebSocket ile bot yönetimi.
// Varsayılan olarak sadece bu bilgisayardan erişilir (127.0.0.1).

const http = require('http')
const fs = require('fs')
const path = require('path')
const { WebSocketServer } = require('ws')
const { BotInstance } = require('./src/bot-instance')
const ai = require('./src/ai')
const Sch = require('./src/schematic')

const PORT = parseInt(process.env.PANEL_PORT || '3000')
const HOST = process.env.PANEL_HOST || '127.0.0.1'
const DEFAULT_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile'
const ENV_KEY = process.env.GROQ_API_KEY || ''

process.on('unhandledRejection', (e) => console.error('[!] Yakalanmamış hata:', e && e.message ? e.message : e))
process.on('uncaughtException', (e) => console.error('[!] Beklenmeyen hata:', e && e.message ? e.message : e))

const bots = new Map()

const server = http.createServer((req, res) => {
  // Sağlık kontrolü: UptimeRobot gibi bir izleyici ya da kendi kendine ping bunu çağırır (Render ücretsiz planı uyumasın)
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/ping')) {
    res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return
  }
  // Şematik yükleme: POST /upload?name=ev.schem  (ham ikili gövde)
  if (req.method === 'POST' && req.url.startsWith('/upload')) {
    const name = new URL(req.url, 'http://x').searchParams.get('name') || ''
    // Dosya RAM'e alınmadan doğrudan diske akar (2 GB'a kadar). Önce geçici dosyaya yazılır, bitince asıl adına taşınır.
    let safe
    try { safe = Sch.sanitizeName(name); Sch.ensureDir() } catch (e) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); return }
    const finalPath = path.join(Sch.SCHEM_DIR, safe)
    const tmpPath = `${finalPath}.part`
    const out = fs.createWriteStream(tmpPath)
    let size = 0
    let aborted = false
    const fail = (code, msg) => {
      if (aborted) return
      aborted = true
      try { out.destroy() } catch (e) { /* kapalı */ }
      try { fs.unlinkSync(tmpPath) } catch (e) { /* yok */ }
      if (!res.headersSent) { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: msg })) }
    }
    req.on('data', (c) => {
      if (aborted) return
      size += c.length
      if (size > Sch.MAX_FILE_BYTES) { fail(413, `dosya ${Sch.fmtBytes(Sch.MAX_FILE_BYTES)} sınırını aşıyor`); req.destroy(); return }
      if (!out.write(c)) { req.pause(); out.once('drain', () => req.resume()) }   // diske yazma yavaşsa yüklemeyi yavaşlat
    })
    req.on('error', () => fail(400, 'yükleme kesildi'))
    req.on('end', () => {
      if (aborted) return
      out.end(async () => {
        try {
          fs.renameSync(tmpPath, finalPath)
          // Küçük/orta dosyalar doğrulanır; çok büyükler (bellekte açılamaz) doğrulanmadan saklanır
          let note = ''
          if (size <= Sch.MAX_LOAD_BYTES) {
            try { await Sch.load(safe) } catch (e) { Sch.deleteFile(safe); throw e }
          } else note = `dosya ${Sch.fmtBytes(size)}: saklandı ama doğrulanamadı ve bu sunucuda kurulamayabilir (bellek sınırı ${Sch.fmtBytes(Sch.MAX_LOAD_BYTES)})`
          broadcast({ t: 'schematics', files: Sch.listFiles() })
          res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, name: safe, note }))
        } catch (e) {
          res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: e.message }))
        }
      })
    })
    return
  }
  if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?') || req.url === '/index.html')) {
    fs.readFile(path.join(__dirname, 'public', 'index.html'), (err, data) => {
      if (err) { res.writeHead(500); res.end('index.html okunamadı'); return }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(data)
    })
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('Bulunamadı')
})

const wss = new WebSocketServer({ server })

function broadcast(msg) {
  const s = JSON.stringify(msg)
  for (const c of wss.clients) if (c.readyState === 1) c.send(s)
}
const send = (ws, msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)) }

// Panelden gelen ayarları temizle ve doğrula
function sanitizeCfg(raw = {}) {
  const cfg = {}
  cfg.auth = raw.auth === 'microsoft' ? 'microsoft' : 'offline'
  cfg.name = String(raw.name || '').trim()
  if (cfg.auth === 'offline' && !/^[A-Za-z0-9_]{3,16}$/.test(cfg.name)) {
    throw new Error('Bot adı 3-16 karakter olmalı (harf, rakam, alt çizgi).')
  }
  if (!cfg.name) throw new Error('Bot adı / e-posta boş olamaz.')

  let host = String(raw.host || 'localhost').trim()
  let port = parseInt(raw.port || '25565')
  const m = host.match(/^(.+):(\d{1,5})$/)
  if (m) { host = m[1]; port = parseInt(m[2]) }
  if (!/^[A-Za-z0-9.\-_]+$/.test(host)) throw new Error('Sunucu adresi geçersiz.')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port 1-65535 arası olmalı.')
  cfg.host = host
  cfg.port = port

  const v = String(raw.version || 'auto').trim()
  if (v !== 'auto' && !/^\d+\.\d+(\.\d+)?$/.test(v)) throw new Error('Sürüm "auto" ya da 1.20.4 gibi olmalı.')
  cfg.version = v

  cfg.owner = String(raw.owner || '').trim()
  cfg.groqKey = String(raw.groqKey || ENV_KEY || '').trim()
  cfg.model = String(raw.model || DEFAULT_MODEL).trim()
  cfg.allowPvp = !!raw.allowPvp
  cfg.allowCommands = raw.allowCommands !== false
  // Kendi başına davranışlar varsayılan KAPALI: bot sadece söylenenleri yapar
  cfg.strict = raw.strict !== false
  cfg.autoDefend = raw.autoDefend === true
  cfg.autoEat = raw.autoEat === true
  cfg.autoReplan = raw.autoReplan === true
  cfg.autoReconnect = raw.autoReconnect !== false
  const sm = String(raw.searchModel || 'groq/compound-mini').trim()
  if (!/^[\w\-./:]{2,60}$/.test(sm)) throw new Error('Arama modeli adı geçersiz.')
  cfg.searchModel = sm
  return cfg
}

function makeEmit(name) {
  return (type, payload) => broadcast({ t: type, name, ...payload })
}

async function handle(ws, msg) {
  switch (msg.t) {
    case 'connect': {
      const cfg = sanitizeCfg(msg.cfg)
      const old = bots.get(cfg.name)
      if (old) { old.stop(); old.cfg = cfg }
      const inst = new BotInstance(cfg, makeEmit(cfg.name), { isManaged: (n) => bots.has(n) && n !== cfg.name })
      bots.set(cfg.name, inst)
      broadcast({ t: 'added', summary: inst.summary(), logs: [] })
      inst.start()
      break
    }
    case 'disconnect': {
      const inst = bots.get(msg.name)
      if (inst) inst.stop()
      break
    }
    case 'reconnect': {
      const inst = bots.get(msg.name)
      if (inst) { inst.stop(); setTimeout(() => inst.start(), 800) }
      break
    }
    case 'remove': {
      const inst = bots.get(msg.name)
      if (inst) { inst.stop(); bots.delete(msg.name); broadcast({ t: 'removed', name: msg.name }) }
      break
    }
    case 'say': {
      const inst = bots.get(msg.name)
      if (inst) inst.handleConsole(msg.text, msg.mode)
      break
    }
    case 'action': {
      const inst = bots.get(msg.name)
      if (inst) await inst.handleManualAction(msg.action)
      break
    }
    case 'schematics':
      send(ws, { t: 'schematics', files: Sch.listFiles() })
      break
    case 'delete_schematic': {
      Sch.deleteFile(msg.file)
      broadcast({ t: 'schematics', files: Sch.listFiles() })
      break
    }
    case 'models': {
      const key = String(msg.key || ENV_KEY || '').trim()
      if (!key) { send(ws, { t: 'models', error: 'Önce Groq API anahtarını gir.' }); break }
      try { send(ws, { t: 'models', models: await ai.listModels(key) }) } catch (e) { send(ws, { t: 'models', error: e.message }) }
      break
    }
    default:
      break
  }
}

wss.on('connection', (ws) => {
  const logs = {}
  for (const [name, inst] of bots) logs[name] = inst.logs
  send(ws, {
    t: 'init',
    bots: [...bots.values()].map((b) => b.summary()),
    logs,
    defaults: { model: DEFAULT_MODEL, keyFromEnv: !!ENV_KEY },
    schematics: Sch.listFiles(),
  })
  ws.on('message', async (raw) => {
    let msg
    try { msg = JSON.parse(String(raw)) } catch (e) { return }
    try { await handle(ws, msg) } catch (e) { send(ws, { t: 'error', error: e.message }) }
  })
})

// Render ücretsiz planı ~15 dk dış istek gelmezse uygulamayı uyutur ve bot düşer. Kendi adresine düzenli istek at.
if (process.env.RENDER_EXTERNAL_URL && process.env.KEEPALIVE !== '0' && typeof fetch === 'function') {
  const url = `${process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '')}/health`
  setInterval(() => { fetch(url).catch(() => { /* önemsiz */ }) }, 4 * 60 * 1000).unref()
  console.log(`Uyutma koruması açık: ${url} adresine 4 dakikada bir istek atılacak`)
}

server.listen(PORT, HOST, () => {
  console.log(`Panel hazır: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`)
  if (HOST !== '127.0.0.1' && HOST !== 'localhost') console.log('UYARI: Panel ağa açık. Parola yok, güvendiğin bir ağda kullan.')
})

function shutdown() {
  console.log('\nBotlar kapatılıyor...')
  for (const b of bots.values()) { try { b.stop() } catch (e) { /* kapalı */ } }
  setTimeout(() => process.exit(0), 500)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
