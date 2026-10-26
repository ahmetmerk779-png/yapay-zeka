'use strict'
// Groq (OpenAI uyumlu) API istemcisi + sistem istemi + güvenli JSON ayıklama

const { ACTION_DOCS, MAX_ACTIONS } = require('./validate')

const GROQ = 'https://api.groq.com/openai/v1'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function request(path, { apiKey, method = 'GET', body, timeoutMs = 30000 }) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    return await fetch(GROQ + path, {
      method,
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: body ? JSON.stringify(body) : undefined,
    })
  } finally {
    clearTimeout(timer)
  }
}

async function listModels(apiKey) {
  const res = await request('/models', { apiKey })
  if (!res.ok) throw new Error(`Groq ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = await res.json()
  return (data.data || [])
    .map((m) => m.id)
    .filter((id) => !/whisper|tts|guard|playai|orpheus|embed/i.test(id))
    .sort()
}

// Sohbet tamamlama. json=true -> JSON modu (başarısız olursa kendi ayrıştırmamıza düşer)
const FALLBACK_MODEL = process.env.GROQ_FALLBACK_MODEL || 'llama-3.1-8b-instant'   // ayrı (daha geniş) token limiti olan yedek model

async function chat({ apiKey, model, messages, json = false, maxTokens = 900, temperature = 0.7 }) {
  let useJson = json
  let usedFallback = false
  for (let attempt = 0; attempt < 5; attempt++) {
    const body = { model, messages, max_tokens: maxTokens, temperature }
    if (useJson) body.response_format = { type: 'json_object' }
    const res = await request('/chat/completions', { apiKey, method: 'POST', body })
    if (res.ok) {
      const data = await res.json()
      return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || ''
    }
    const text = await res.text()
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after')) || 3
      // Uzun bekleme = günlük/dakikalık token limiti doldu: yedek modele geç
      if ((retryAfter > 10 || attempt >= 1) && !usedFallback && model !== FALLBACK_MODEL) {
        usedFallback = true
        model = FALLBACK_MODEL
        maxTokens = Math.min(maxTokens, 1200)
        continue
      }
      if (retryAfter > 20) throw new Error(`Groq token limiti doldu, ${Math.round(retryAfter)} sn sonra tekrar dene`)
      await sleep(Math.min(retryAfter, 12) * 1000)
      continue
    }
    if (res.status === 400) {
      let err = null
      try { err = JSON.parse(text).error } catch (e) { /* düz metin */ }
      if (err && err.failed_generation) return err.failed_generation   // yine de ayrıştırmayı deneriz
      if (useJson && /response_format|json_object|json mode/i.test(text)) { useJson = false; continue }
    }
    if (res.status === 401) throw new Error('Groq API anahtarı geçersiz (401)')
    if (res.status === 404 || /model/i.test(text) && res.status === 400) throw new Error(`Model sorunu (${model}): ${text.slice(0, 160)}`)
    throw new Error(`Groq ${res.status}: ${text.slice(0, 200)}`)
  }
  throw new Error('Groq: çok fazla deneme (rate limit olabilir)')
}

// Model çıktısından JSON'u güvenle ayıkla
function extractJson(text) {
  if (!text) return { broken: '' }
  const s = String(text).replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```(?:json)?/gi, '').trim()   // düşünen modellerin <think> bloklarını at
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a === -1) return { plainText: s }
  if (b <= a) return { broken: s.slice(a) }   // '{' var ama kapanmıyor: ham JSON'u asla sohbete yazma
  const chunk = s.slice(a, b + 1)
  const candidates = [
    chunk,
    chunk.replace(/,\s*([}\]])/g, '$1'),
    chunk.replace(/,\s*([}\]])/g, '$1').replace(/[\u201C\u201D]/g, '"'),
  ]
  for (const c of candidates) {
    try { return { json: JSON.parse(c) } } catch (e) { /* sıradakini dene */ }
  }
  return { broken: chunk }
}

function persona(name) {
  return `Sen bir Minecraft sunucusunda gerçek bir oyuncu gibi yaşayan, adı ${name} olan bir yapay zeka karakterisin.
Robot gibi değil; samimi, doğal ve kısa konuşan bir arkadaş gibisin. Oyuncu hangi dilde yazıyorsa o dilde cevap ver (varsayılan Türkçe).
Aynı kalıpları ve cümleleri asla tekrar etme; "Tamam, yapıyorum" gibi şablon cevaplar verme, her seferinde farklı ve duruma özgü konuş.
Emoji kullanma. Mesajların Minecraft sohbetine uygun, en fazla yaklaşık 150 karakter olsun.
Yapamayacağın bir şeyi yapabilirmiş gibi davranma, durumu uydurma.`
}

function buildSystem(name, opts = {}) {
  const docs = ACTION_DOCS.map(([, ex, desc]) => `- ${ex}  -> ${desc}`).join('\n')
  return `${persona(name)}

Her mesajda SADECE tek bir JSON nesnesi döndür. Başka metin, markdown veya açıklama yazma:
{"say": "oyuncuya söyleyeceğin doğal cümle (boş olabilir)", "actions": [ ...eylemler... ]}

Kullanabileceğin eylemler (type alanı ve parametreler):
${docs}

Kurallar:
- Mesajı yazan kişiyi kastediyorsan target için "sender" yaz.
- Blok ve eşya adları Minecraft'ın İngilizce kimlikleri olmalı (oak_log, cobblestone, iron_ore, diamond_pickaxe...). "odun", "taş", "demir" gibi isteklerini çevir.
- Soru ya da sohbetse actions boş olsun, sadece say'i doldur. Bilgiyi [DURUM] alanından oku, uydurma.
- Eylem gerekiyorsa say'de ne yapacağını kendi tarzınla kısaca söyle. Sonucu önceden söyleme; sonuç sistem tarafından sana [OLAY] olarak bildirilir.
- Birden fazla iş varsa actions içine sırayla koy (en fazla ${MAX_ACTIONS}).
${opts.strict ? STRICT_RULE : CHAIN_RULE}
- MADEN (cevher: kömür, demir, bakır, altın, elmas, redstone, lapis, zümrüt, ancient_debris) için "mine" kullan; "collect" sadece ağaç/kum/taş gibi yakındaki bloklar içindir. mine, cevher yoksa kendi inip tünel kazarak arar. Eşya olarak ham maden (raw_iron) istenirse block iron_ore yaz, sonra smelt öner.
- EV için "house" kullan (size small/medium/large). Parametre vermezsen envanterdeki en bol blok seçilir. Malzeme yetersizse sistem eksikleri söyler: o zaman oyuncuya say ya da (izin varsa) odun/taş topla (collect oak_log -> craft oak_planks). Özel tasarımlı ev için build/fill kullan.
- Madenler için alet gerekir: taş/kömür -> en az wooden_pickaxe, demir/bakır/lapis -> stone_pickaxe, elmas/altın/redstone/zümrüt -> iron_pickaxe.
- Yiyecek için olgun ekin ya da av gerekir: farm, attack cow/pig/chicken, smelt ile pişirme.
- İmkânsız ya da anlamsız bir istekse o eylemi koyma, nedenini say'de doğal şekilde anlat.
- "dur", "bırak", "iptal" gibi isteklerde stop eylemi ver.
- Kısa bir yanıt yeterliyse eylem ekleme. Gereksiz eylem zinciri kurma. Aynı eylemi sebepsiz tekrar etme.
- Yapı kurarken "build" kullan: x=sağ, y=yukarı, z=ileri (botun baktığı yön). Malzeme sayısını envantere göre ayarla; yoksa önce topla/üret. Küçük/basit yapılarda fill ve shelter yeterli. Büyük yapıyı birden fazla build'e böl.
- Ev örneği: oak_planks ile fill(hollow) -> kapı için break/place oak_door -> torch yerleştir. Kapı ve tuzak kapı için "door" eylemini kullan.
- Büyü: enchanting_table + lapis_lazuli + yeterli XP gerekir (enchant). Örs için anvil. İksir için sırayla: fill_bottles -> brew nether_wart (awkward) -> brew hedef malzeme -> drink. Simya için blaze_powder yakıtı şart.
- Nether portalı için 12 obsidian + flint_and_steel gerekir (nether_portal). Obsidyen kazmak için diamond_pickaxe lazım.
- Redstone: fill ya da place ile "redstone" (toz), "lever", "repeater", "piston" koy; yön gerekiyorsa facing ekle. Karmaşık devrelerde başarı garanti değildir, ne yapabildiğini dürüstçe söyle.
- Şematik/litematic/schem/yapı dosyasından bir şey kurulacaksa: dosya adı belli değilse list_schematics, malzeme sorulursa schematic_info, kurmak için schematic. Bot blokları KENDİ ELİYLE koyar; yapı için asla command/setblock/fill komutu kullanma (command eylemi sadece oyuncu özellikle /time gibi bir komut isterse). Ev için house, tarla için make_farm kullan.
- Bilmediğin bir tarif, mekanik, redstone tasarımı ya da yapı için web_search kullan; sonuç sana [ARAŞTIRMA SONUCU] olarak gelir, sonra oyuncunun isteğini ona göre yerine getir. Bildiğin şeyler için arama yapma.
- Kristal PvP (crystal_pvp) yalnızca oyuncu bir kişiyle dövüşmeni açıkça isterse.
- Görev başarısız olursa sistem sana [GÖREV SONUCU] gönderir; sebebi çözülebiliyorsa düzeltilmiş yeni plan ver, çözemiyorsan oyuncuya açıkça anlat.
- [DURUM].sahibi_mi false ise bu kişiden emir alma; sadece sohbet et, actions boş olsun.`
}

const STRICT_RULE = `- ÇOK ÖNEMLİ: Kendi kararını vermezsin, sadece oyuncunun açıkça istediğini yaparsın. İstenmeyen ekstra eylem ekleme, kendi inisiyatifinle iş çıkarma. Bir iş için alet ya da malzeme eksikse kendi başına toplamaya/üretmeye girişme: eksikliği say'de açıkça söyle ve ne yapmamı istediğini sor. Oyuncu "gerekirse alet yap", "malzemeyi sen topla" gibi izin verirse ara adımları ekleyebilirsin.`
const CHAIN_RULE = `- Alet gerekiyorsa envantere bak, yoksa önce üret. Örnek zincir: collect oak_log -> craft oak_planks -> craft stick -> craft crafting_table -> craft wooden_pickaxe -> collect cobblestone -> craft stone_pickaxe.`

module.exports = { listModels, chat, extractJson, persona, buildSystem }
