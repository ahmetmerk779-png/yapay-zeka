'use strict'
// Öz-öğrenme: botun BAŞARIYLA tamamladığı komutları hatırlar; aynı komut tekrar gelince yapay zekaya sormadan çalıştırır.
// - Hızlı (gecikme yok) ve rate limit harcamaz.
// - Hep yeniden doğrulanır (validateActions): eski plan bugünkü duruma uymuyorsa çalışmaz, hatırlama silinir.
// - Bir plan 2 kez başarılı olduktan sonra kullanılır; 2 kez başarısız olursa unutulur.
// - Oyuncu "hayır / yanlış / öyle değil" derse son öğrenilen plan unutulur.
// Kapatmak: LEARNING=0
const fs = require('fs')
const path = require('path')

const MAX_ENTRIES = 150
const MIN_WINS = 2
const NEVER = new Set(['command', 'web_search', 'chat', 'stop', 'wait', 'custom', 'skill'])

const norm = (msg, botName) => {
  let t = String(msg || '').toLowerCase().trim()
  if (botName) t = t.split(String(botName).toLowerCase()).join(' ')
  return t.replace(/[.,!?;:"'`()]/g, ' ').replace(/\s+/g, ' ').trim()
}

class PlanMemory {
  constructor(file) {
    this.file = file
    this.data = {}
    this.timer = null
    try { this.data = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { this.data = {} }
  }

  save() {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      try { fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(this.data)) } catch (e) { /* önemsiz */ }
    }, 1500)
  }

  // Hatırlanabilir mi? Konuma bağlı (mesajda sayı yokken x/y/z içeren) ve yan etkili planlar öğrenilmez
  eligible(message, rawActions) {
    if (process.env.LEARNING === '0') return false
    if (!message || message.length > 90 || !Array.isArray(rawActions) || !rawActions.length || rawActions.length > 6) return false
    if (rawActions.some((a) => !a || NEVER.has(String(a.type || '').toLowerCase()))) return false
    const json = JSON.stringify(rawActions)
    if (/"(x|y|z|pos)"\s*:/.test(json) && !/\d/.test(message)) return false
    return true
  }

  lookup(message, botName) {
    if (process.env.LEARNING === '0') return null
    const e = this.data[norm(message, botName)]
    if (!e || e.wins < MIN_WINS || e.fails >= 2) return null
    return e
  }

  win(message, rawActions, botName) {
    const k = norm(message, botName)
    if (!k) return null
    const json = JSON.stringify(rawActions)
    const e = this.data[k]
    if (e && JSON.stringify(e.actions) === json) { e.wins++; e.fails = 0; e.t = Date.now() }
    else this.data[k] = { actions: rawActions, wins: 1, fails: 0, t: Date.now() }
    this.trim()
    this.save()
    return this.data[k]
  }

  fail(message, botName) {
    const k = norm(message, botName)
    const e = this.data[k]
    if (!e) return
    e.fails++
    if (e.fails >= 2) delete this.data[k]
    this.save()
  }

  forget(message, botName) {
    const k = norm(message, botName)
    if (this.data[k]) { delete this.data[k]; this.save(); return true }
    return false
  }

  clear() { this.data = {}; this.save() }

  stats() {
    const all = Object.values(this.data)
    return { total: all.length, ready: all.filter((e) => e.wins >= MIN_WINS && e.fails < 2).length }
  }

  trim() {
    const keys = Object.keys(this.data)
    if (keys.length <= MAX_ENTRIES) return
    keys.sort((a, b) => this.data[a].t - this.data[b].t).slice(0, keys.length - MAX_ENTRIES).forEach((k) => delete this.data[k])
  }
}

module.exports = { PlanMemory, norm, MIN_WINS }
