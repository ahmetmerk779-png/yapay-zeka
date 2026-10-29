'use strict'
// Botun "öğrenmek için" web araması (v2).
// Akış: önbellek -> sorguyu İngilizceye çevir (wiki İngilizce) -> Minecraft Wiki + DuckDuckGo (+ varsa Groq compound)
// paralel -> en alakalı paragrafları seç -> gerekirse en iyi sonuç sayfasını da oku.
// Web metni GÜVENİLMEYEN veridir; çağıran taraf bunu modele "talimat değil bilgi" olarak vermelidir.

const UA = 'Mozilla/5.0 (compatible; MinecraftAIBot/4.0)'
const cache = new Map()          // sorgu -> { ts, result }
const CACHE_MS = 60 * 60 * 1000

async function fetchText(url, { timeoutMs = 12000, headers = {}, method = 'GET', body, maxChars = 600000 } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { method, body, signal: ctrl.signal, headers: { 'user-agent': UA, 'accept-language': 'en,tr;q=0.8', ...headers }, redirect: 'follow' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const t = await res.text()
    return t.length > maxChars ? t.slice(0, maxChars) : t
  } finally {
    clearTimeout(timer)
  }
}

const decodeEntities = (s) => s
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, ' ')

function stripHtml(html) {
  return decodeEntities(String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<nav[\s\S]*?<\/nav>/gi, ' ').replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
}

// ---- URL güvenliği (sadece açık internet, https/http)
function isSafeUrl(u) {
  try {
    const x = new URL(u)
    if (!/^https?:$/.test(x.protocol)) return false
    const h = x.hostname.toLowerCase()
    if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || !h.includes('.')) return false
    if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false
    if (/(youtube\.com|youtu\.be|tiktok\.com|facebook\.com|instagram\.com|twitter\.com|x\.com)$/.test(h)) return false
    return true
  } catch (e) { return false }
}

// ---- sorgu hazırlığı
const TR_EN = [
  [/nas[ıi]l yap[ıi]l[ıi]r|nas[ıi]l yap[ıi]l[ıi]yor|nas[ıi]l kurulur|yap[ıi]m[ıi]|nas[ıi]l/g, 'how to'], [/tarifi?/g, 'recipe'], [/tarif/g, 'recipe'],
  [/pist[oö]n/g, 'piston'], [/kap[ıi]/g, 'door'], [/g[uü]venli/g, 'secure'], [/otomatik/g, 'automatic'], [/\bfarm\b|[cç]iftlik/g, 'farm'], [/demir/g, 'iron'],
  [/alt[ıi]n/g, 'gold'], [/elmas/g, 'diamond'], [/z[ıi]rh/g, 'armor'], [/b[uü]y[uü]/g, 'enchanting'], [/iksir/g, 'potion'], [/k[oö]yl[uü]/g, 'villager'],
  [/ev\b/g, 'house'], [/sava[sş]/g, 'combat'], [/kristal/g, 'end crystal'], [/rüzgar topu|ruzgar topu/g, 'wind charge'], [/m[ıi]zrak/g, 'spear'], [/ma[cç]/g, 'mace'],
]
function dictTranslate(q) {
  let s = q.toLowerCase()
  for (const [re, en] of TR_EN) s = s.replace(re, en)
  return s.replace(/\s+/g, ' ').trim()
}
const needsEnglish = (q) => /[çğıöşüÇĞİÖŞÜ]/.test(q) || /\b(nas[ıi]l|yap[ıi]l[ıi]r|tarif|nedir|kurulur|yap[ıi]m[ıi]|yapmak|ne i[cç]in)\b/i.test(q)
const withMc = (q) => (/minecraft/i.test(q) ? q : `minecraft ${q}`)
const words = (q) => [...new Set(String(q).toLowerCase().split(/[^a-z0-9çğıöşü_]+/).filter((w) => w.length > 2 && !['how', 'the', 'and', 'for', 'minecraft', 'with', 'what', 'make', 'build'].includes(w)))]

// En alakalı paragrafları seç (sıra korunur)
function pickRelevant(text, query, max = 1800) {
  const ws = words(query)
  const paras = String(text).split(/\n+|(?<=[.!?])\s{2,}/).map((p) => p.trim()).filter((p) => p.length > 30)
  if (!paras.length) return String(text).slice(0, max)
  const scored = paras.map((p, i) => {
    const lp = p.toLowerCase()
    let sc = ws.reduce((s, w) => s + (lp.includes(w) ? 2 : 0), 0)
    if (/\d/.test(p)) sc += 0.5
    if (/(craft|recipe|ingredient|place|build|require|need|step|use)/i.test(p)) sc += 1
    if (i < 2) sc += 1.5            // giriş paragrafı genelde özet
    return { p, i, sc }
  })
  const top = scored.sort((a, b) => b.sc - a.sc)
  const chosen = []
  let len = 0
  for (const t of top) {
    if (len + t.p.length > max) { if (len > max * 0.6) break; continue }
    chosen.push(t); len += t.p.length
  }
  return chosen.sort((a, b) => a.i - b.i).map((t) => t.p).join('\n').slice(0, max)
}

// ---- kaynaklar
function parseDuckDuckGo(html) {
  const out = []
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi
  let m
  while ((m = re.exec(html)) && out.length < 8) {
    let url = decodeEntities(m[1])
    const u = url.match(/[?&]uddg=([^&]+)/)
    if (u) { try { url = decodeURIComponent(u[1]) } catch (e) { /* ham bırak */ } }
    out.push({ title: stripHtml(m[2]), url, snippet: stripHtml(m[3]) })
  }
  return out
}

function parseDdgLite(html) {
  const out = []
  const links = [...html.matchAll(/<a[^>]*href="([^"]+)"[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/gi)]
  const snips = [...html.matchAll(/<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/gi)]
  links.slice(0, 8).forEach((l, i) => {
    let url = decodeEntities(l[1])
    const u = url.match(/[?&]uddg=([^&]+)/)
    if (u) { try { url = decodeURIComponent(u[1]) } catch (e) { /* ham */ } }
    out.push({ title: stripHtml(l[2]), url, snippet: snips[i] ? stripHtml(snips[i][1]) : '' })
  })
  return out
}

async function ddgResults(query) {
  try {
    const items = parseDuckDuckGo(await fetchText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { timeoutMs: 9000 }))
    if (items.length) return items
  } catch (e) { /* lite dene */ }
  const items = parseDdgLite(await fetchText(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, { timeoutMs: 9000 }))
  if (!items.length) throw new Error('DuckDuckGo sonuç vermedi')
  return items
}

async function duckduckgo(query) {
  const items = await ddgResults(query)
  return items.slice(0, 6).map((i, n) => `${n + 1}. ${i.title} - ${i.snippet} (${i.url})`).join('\n')
}

async function minecraftWiki(query, rawQuery = query) {
  const api = 'https://minecraft.wiki/api.php'
  const sr = JSON.parse(await fetchText(`${api}?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=4&format=json`, { timeoutMs: 9000 }))
  const hits = (sr.query && sr.query.search) || []
  if (!hits.length) throw new Error('Minecraft Wiki sonuç vermedi')
  const parts = []
  for (const h of hits.slice(0, 2)) {
    let text = ''
    try {
      const ex = JSON.parse(await fetchText(`${api}?action=query&prop=extracts&explaintext=1&exsectionformat=plain&titles=${encodeURIComponent(h.title)}&format=json`, { timeoutMs: 9000 }))
      const page = Object.values((ex.query && ex.query.pages) || {})[0]
      text = (page && page.extract) || ''
    } catch (e) { /* TextExtracts yoksa yedek */ }
    if (!text) {
      try {
        const pr = JSON.parse(await fetchText(`${api}?action=parse&page=${encodeURIComponent(h.title)}&prop=text&format=json&formatversion=2`, { timeoutMs: 9000 }))
        text = stripHtml((pr.parse && pr.parse.text) || '')
      } catch (e) { text = stripHtml(h.snippet || '') }
    }
    parts.push(`[Wiki: ${h.title}] ${pickRelevant(text, `${query} ${rawQuery}`, 1700)}`)
  }
  return parts.join('\n\n')
}

// En iyi sonuç sayfasının ilgili kısmını oku (deep)
async function readTopPage(query, items) {
  for (const it of items.slice(0, 4)) {
    if (!isSafeUrl(it.url)) continue
    try {
      const html = await fetchText(it.url, { timeoutMs: 8000, maxChars: 400000 })
      const text = stripHtml(html)
      if (text.length < 200) continue
      return `[Sayfa: ${it.title} - ${new URL(it.url).hostname}] ${pickRelevant(text.replace(/\s{2,}/g, '\n'), query, 1500)}`
    } catch (e) { /* sonrakini dene */ }
  }
  throw new Error('sonuç sayfaları okunamadı')
}

async function groqCompound(query, apiKey, model) {
  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: `Minecraft ile ilgili şu konuyu web'de araştır ve Türkçe, doğru, kısa özetle (malzeme listesi, yapım adımları, mekanik detaylar; sürüm farklarını belirt): ${query}` }],
    max_tokens: 700,
  })
  const text = await fetchText('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST', body, timeoutMs: 40000,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
  })
  const content = JSON.parse(text).choices?.[0]?.message?.content
  if (!content) throw new Error('boş cevap')
  return content
}

// opts: { groqKey, searchModel ('off' ise compound yok), rewrite(async q => İngilizce sorgu), deep, force, log }
async function webSearch(query, opts = {}) {
  const q = String(query || '').trim().slice(0, 200)
  if (q.length < 3) throw new Error('arama sorgusu çok kısa')
  const hit = cache.get(q.toLowerCase())
  if (hit && !opts.force && Date.now() - hit.ts < CACHE_MS) return { ...hit.result, source: `${hit.result.source} (önbellek)` }

  // 1) İngilizce sorgu (wiki İngilizce): önce model, olmazsa sözlük
  let en = q
  if (needsEnglish(q)) {
    let rewritten = ''
    if (typeof opts.rewrite === 'function') { try { rewritten = String(await opts.rewrite(q) || '').replace(/["\n]/g, ' ').trim().slice(0, 100) } catch (e) { /* sözlük */ } }
    en = rewritten.length >= 3 ? rewritten : dictTranslate(q)
  }
  const mcEn = withMc(en)

  // 2) Kaynaklar paralel
  const tasks = []
  if (opts.groqKey && opts.searchModel && opts.searchModel !== 'off') tasks.push(['groq-compound', groqCompound(q, opts.groqKey, opts.searchModel)])
  tasks.push(['minecraft.wiki', minecraftWiki(en, q)])
  const ddgP = ddgResults(mcEn)
  tasks.push(['duckduckgo', ddgP.then((items) => items.slice(0, 5).map((i, n) => `${n + 1}. ${i.title} - ${i.snippet} (${i.url})`).join('\n'))])
  const settled = await Promise.allSettled(tasks.map(([, p]) => p))
  const got = []
  const errors = []
  settled.forEach((r, i) => {
    const src = tasks[i][0]
    if (r.status === 'fulfilled' && String(r.value).trim()) got.push({ src, text: String(r.value).trim() })
    else errors.push(`${src}: ${r.reason ? r.reason.message : 'boş'}`)
  })

  // 3) Derin okuma: istenirse ya da wiki/compound sonuç yoksa en iyi sayfayı oku
  const hasRich = got.some((g) => g.src !== 'duckduckgo')
  if (opts.deep || !hasRich) {
    try {
      const items = await ddgP
      got.unshift({ src: 'sayfa', text: await readTopPage(`${en} ${q}`, items) })
    } catch (e) { errors.push(`sayfa: ${e.message}`) }
  }
  if (!got.length) throw new Error(`web araması başarısız (${errors.join(' | ')})`)

  const order = ['groq-compound', 'sayfa', 'minecraft.wiki', 'duckduckgo']
  got.sort((a, b) => order.indexOf(a.src) - order.indexOf(b.src))
  let text = ''
  for (const g of got) { if (text.length > 3200) break; text += `${text ? '\n\n' : ''}${g.text.slice(0, g.src === 'duckduckgo' ? 700 : 1800)}` }
  const result = { source: got.map((g) => g.src).join('+'), text: text.slice(0, 3600), query: en }
  cache.set(q.toLowerCase(), { ts: Date.now(), result })
  if (cache.size > 100) cache.delete(cache.keys().next().value)
  return result
}

module.exports = { webSearch, parseDuckDuckGo, parseDdgLite, stripHtml, minecraftWiki, duckduckgo, groqCompound, pickRelevant, dictTranslate, isSafeUrl }
