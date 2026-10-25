'use strict'
// Botun "öğrenmek için" web araması. Sırayla dener:
//   1) Groq compound modeli (yerleşik web araması; hesabında varsa)
//   2) Minecraft Wiki API (tarif, mekanik, yapı bilgisi)
//   3) DuckDuckGo HTML sonuçları (yedek)

const UA = 'MinecraftAIBot/3.0 (+local panel)'

async function fetchText(url, { timeoutMs = 15000, headers = {}, method = 'GET', body } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { method, body, signal: ctrl.signal, headers: { 'user-agent': UA, ...headers }, redirect: 'follow' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

const decodeEntities = (s) => s
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, ' ')

function stripHtml(html) {
  return decodeEntities(String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
}

// DuckDuckGo html sonuç sayfasını ayrıştır
function parseDuckDuckGo(html) {
  const out = []
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi
  let m
  while ((m = re.exec(html)) && out.length < 6) {
    let url = decodeEntities(m[1])
    const u = url.match(/[?&]uddg=([^&]+)/)
    if (u) { try { url = decodeURIComponent(u[1]) } catch (e) { /* ham bırak */ } }
    out.push({ title: stripHtml(m[2]), url, snippet: stripHtml(m[3]) })
  }
  return out
}

async function duckduckgo(query) {
  const html = await fetchText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`)
  const items = parseDuckDuckGo(html)
  if (!items.length) throw new Error('DuckDuckGo sonuç vermedi')
  return items.map((i, n) => `${n + 1}. ${i.title} - ${i.snippet} (${i.url})`).join('\n')
}

async function minecraftWiki(query) {
  const api = 'https://minecraft.wiki/api.php'
  const sr = JSON.parse(await fetchText(`${api}?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=3&format=json`))
  const hits = (sr.query && sr.query.search) || []
  if (!hits.length) throw new Error('Minecraft Wiki sonuç vermedi')
  const parts = []
  for (const h of hits.slice(0, 2)) {
    let text = ''
    try {
      const ex = JSON.parse(await fetchText(`${api}?action=query&prop=extracts&explaintext=1&exsectionformat=plain&titles=${encodeURIComponent(h.title)}&format=json`))
      const page = Object.values((ex.query && ex.query.pages) || {})[0]
      text = (page && page.extract) || ''
    } catch (e) { /* TextExtracts yoksa aşağıdaki yedek */ }
    if (!text) {
      try {
        const pr = JSON.parse(await fetchText(`${api}?action=parse&page=${encodeURIComponent(h.title)}&prop=text&format=json&formatversion=2`))
        text = stripHtml((pr.parse && pr.parse.text) || '')
      } catch (e) { text = stripHtml(h.snippet || '') }
    }
    parts.push(`[${h.title}] ${text.replace(/\s+/g, ' ').slice(0, 1800)}`)
  }
  return parts.join('\n\n')
}

async function groqCompound(query, apiKey, model) {
  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: `Minecraft ile ilgili şu konuyu web'de araştır ve Türkçe, doğru, kısa özetle (malzeme listesi, yapım adımları, mekanik detaylar; sürüm farklarını belirt): ${query}` }],
    max_tokens: 900,
  })
  const text = await fetchText('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST', body, timeoutMs: 45000,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
  })
  const content = JSON.parse(text).choices?.[0]?.message?.content
  if (!content) throw new Error('boş cevap')
  return content
}

// opts: { groqKey, searchModel ('off' ise compound denenmez), log(fn) }
async function webSearch(query, opts = {}) {
  const q = String(query || '').trim().slice(0, 200)
  if (q.length < 3) throw new Error('arama sorgusu çok kısa')
  const errors = []
  const attempts = []
  if (opts.groqKey && opts.searchModel && opts.searchModel !== 'off') {
    attempts.push(['groq-compound', () => groqCompound(q, opts.groqKey, opts.searchModel)])
  }
  attempts.push(['minecraft.wiki', () => minecraftWiki(q)])
  attempts.push(['duckduckgo', () => duckduckgo(q)])
  for (const [source, fn] of attempts) {
    try {
      const text = (await fn()).trim()
      if (text) return { source, text: text.slice(0, 3500) }
    } catch (e) {
      errors.push(`${source}: ${e.message}`)
    }
  }
  throw new Error(`web araması başarısız (${errors.join(' | ')})`)
}

module.exports = { webSearch, parseDuckDuckGo, stripHtml, minecraftWiki, duckduckgo, groqCompound }
