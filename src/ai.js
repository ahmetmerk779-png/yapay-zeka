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
// Yedek model SADECE ortam değişkeniyle verilirse kullanılır (GROQ_FALLBACK_MODEL=...). Hesabında olmayan model hata verir.
let FALLBACK_MODEL = process.env.GROQ_FALLBACK_MODEL || ''

async function chat({ apiKey, model, messages, json = false, maxTokens = 900, temperature = 0.7 }) {
  let useJson = json
  let usedFallback = false
  const origModel = model
  let noReason = false
  for (let attempt = 0; attempt < 5; attempt++) {
    const body = { model, messages, max_tokens: maxTokens, temperature }
    if (useJson) body.response_format = { type: 'json_object' }
    // Düşünen modellerde (qwen3, gpt-oss) düşünme tokenleri limiti hızla doldurur: kıs
    if (!noReason) {
      if (/qwen/i.test(model)) body.reasoning_effort = 'none'
      else if (/gpt-oss/i.test(model)) body.reasoning_effort = 'low'
    }
    const res = await request('/chat/completions', { apiKey, method: 'POST', body })
    if (res.ok) {
      const data = await res.json()
      return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || ''
    }
    const text = await res.text()
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after')) || 3
      // Uzun bekleme = günlük/dakikalık token limiti doldu: yedek modele geç
      if (FALLBACK_MODEL && (retryAfter > 10 || attempt >= 1) && !usedFallback && model !== FALLBACK_MODEL) {
        usedFallback = true
        model = FALLBACK_MODEL
        maxTokens = Math.min(maxTokens, 1200)
        continue
      }
      if (retryAfter > 20) throw new Error(`Groq token limiti doldu, ${Math.round(retryAfter)} sn sonra tekrar dene`)
      await sleep(Math.min(retryAfter, 12) * 1000)
      continue
    }
    if (res.status === 400 && !noReason && /reasoning_effort|reasoning/i.test(text)) { noReason = true; continue }
    if (res.status === 400) {
      let err = null
      try { err = JSON.parse(text).error } catch (e) { /* düz metin */ }
      if (err && err.failed_generation) return err.failed_generation   // yine de ayrıştırmayı deneriz
      if (useJson && /response_format|json_object|json mode/i.test(text)) { useJson = false; continue }
    }
    if (usedFallback && /model_not_found|does not exist|no access/i.test(text)) {   // yedek model geçersiz: kapat, asıl modele dön
      FALLBACK_MODEL = ''
      usedFallback = false
      model = origModel
      await sleep(3000)
      continue
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

// Token tasarrufu: sistem istemine sadece mesajla ilgili eylemler ve kurallar girer.
const CORE_ACTIONS = new Set(['stop', 'follow', 'goto_player', 'goto', 'goto_block', 'wander', 'look_at', 'collect', 'mine', 'craft', 'equip', 'attack', 'chat', 'custom', 'skill', 'eat', 'drop', 'give', 'wait', 'find', 'place', 'break'])
const ACTION_KEYS = [
  [/d[oö]n\b|d[oö]n[uü]p|bak\b|bakin|bak[ıi]n|kafa|y[uü]r[uü]|ko[sş]|ka[cç]|etraf|sa[gğ]a|sola|geri|ileri|turn|walk|face|look|flee|run|circle|orbit|dance|dans|wave|selam|el sallay|emote|jest|kuzey|g[uü]ney|do[gğ]u|bat[ıi]/i, ['turn', 'face', 'look_around', 'walk', 'flee', 'circle', 'emote', 'look_at', 'jump', 'sneak']],
  [/a[gğ]a[cç]|tree|fidan|sapling|ekin|tohum|dik\b|bone|kemik|k[oö]pr[uü]|bridge|kule|tower|pillar|f[ıi]rlat|fırla|throw|pearl|kova|bucket|ayd[ıi]nlat|me[sş]ale|torch|devriye|patrol|kalkan|shield|piramit|pyramid|merdiven|stairs|duvar|wall|[cç][oö]p|junk|z[ıi]rh|armor|[sş]ekil|shape/i, ['chop_tree', 'plant', 'bone_meal', 'bridge', 'pillar_up', 'throw_item', 'bucket', 'light_area', 'patrol', 'shield', 'drop_junk', 'armor', 'build_shape']],
  [/pvp|d[uü]ell?o|d[oö]v[uü][sş]|sava[sş]|kristal|crystal|mace|spear|m[ıi]zrak|balta|\baxe|k[ıi]l[ıi][cç]|sword|uhc|smp|\bpot\b|sald[ıi]r|fight|spar/i, ['duel', 'crystal_pvp', 'shoot', 'guard']],
  [/\bev\b|bar[ıi]nak|yap\b|yap[ıi]|kur\b|kurul|build|fill|duvar|kap[ıi]|door|house|shelter|in[sş]a|doldur|temizle/i, ['house', 'fill', 'shelter', 'build', 'door']],
  [/tarla|farm|hasat|[cç]iftlik|hayvan|koyun|bal[ıi]k|fish|breed|shear|yem/i, ['farm', 'make_farm', 'breed', 'shear', 'fish']],
  [/f[ıi]r[ıi]n|erit|pi[sş]ir|smelt|cook/i, ['smelt']],
  [/b[uü]y[uü]|enchant|[oö]rs|anvil|iksir|brew|simya|potion|portal|nether|[sş]i[sş]e|drink/i, ['enchant', 'anvil', 'brew', 'drink', 'fill_bottles', 'nether_portal']],
  [/[sş]ema|schem|litem|\.nbt/i, ['schematic', 'schematic_info', 'list_schematics', 'download_schematic']],
  [/[oö][gğ]ren|nas[ıi]l|ara[sş]t[ıi]r|search|tarif/i, ['web_search']],
  [/sand[ıi]k|chest|store|take|koy|\bal\b|envanter/i, ['store', 'take', 'inspect_chest']],
  [/k[oö]yl[uü]|takas|trade|sat[ıi]n/i, ['trade']],
  [/t[uü]nel|tunnel|kaz|a[sş]a[gğ][ıi]|dig|yerdeki|pickup/i, ['tunnel', 'dig_down', 'pickup']],
  [/n[oö]bet|koru|guard|ok at|shoot|yay/i, ['guard', 'shoot']],
  [/\bbin\b|mount|uyu|sleep|yatak|home|eve\b|nokta|kaydet|uyan/i, ['mount', 'dismount', 'sleep', 'wake', 'set_home', 'go_home']],
  [/etkile|kol\b|lever|buton|button|tabela|sign|komut|command|z[ıi]pla|jump|[cç][oö]mel|sneak|kullan/i, ['activate_block', 'write_sign', 'use_item', 'command', 'jump', 'sneak']],
]

function pickActions(query) {
  const set = new Set(CORE_ACTIONS)
  for (const [re, names] of ACTION_KEYS) if (re.test(query)) names.forEach((n) => set.add(n))
  return set
}

// [regex|null, kural]  null = her zaman
const RULES = [
  [null, 'Mesajı yazan kişiyi kastediyorsan target için "sender" yaz.'],
  [null, 'Blok/eşya adları Minecraft İngilizce kimlikleri olmalı (oak_log, cobblestone, iron_ore...). "odun", "taş", "demir" gibi isteklerini çevir.'],
  [null, 'Soru/sohbetse actions boş olsun, sadece say. Bilgiyi [DURUM] alanından oku, uydurma.'],
  [null, 'Eylem gerekiyorsa say\'de ne yapacağını kısaca söyle. Sonucu önceden söyleme; sonuç sana [OLAY] olarak gelir.'],
  [null, `Birden fazla iş varsa actions içine sırayla koy (en fazla ${MAX_ACTIONS}). Gereksiz zincir kurma, aynı eylemi sebepsiz tekrar etme.`],
  [null, 'Odun/ağaç isteğinde block "oak_log" yaz (her ağaç türü kabul edilir). "odun topla" için alet ISTEME, yumrukla kırılır; önce eylemi dene.'],
  [null, 'Görev bitince "serbestim, dolaşırım" gibi kendi kararını söyleme; kısa sonucu söyle ve bekle.'],
  [null, '"dur", "bırak", "iptal" -> stop eylemi.'],
  [null, 'Eylem listesinde OLMAYAN bir şey istenirse "custom" eylemiyle kendi adımlarını yaz (op: equip/use/use_on/look/control/wait/say/action/repeat/if). Mevcut eylemleri "action" adımıyla birleştirebilirsin. Daha önce kaydettiğin işler [DURUM].kayitli_makrolar içindedir: {"type":"custom","name":"ad"} ile çağır. Gerçekten yapılamayacak şeyi (Minecraft kurallarına aykırı) uydurma.'],
  [null, 'İmkânsız/anlamsız istekte eylem koyma, nedenini kısaca söyle.'],
  [null, '[DURUM].sahibi_mi false ise bu kişiden emir alma; sadece sohbet et, actions boş.'],
  [null, 'Görev başarısız olursa [GÖREV SONUCU] gelir; sebep çözülebiliyorsa düzeltilmiş plan ver, değilse oyuncuya açıkça anlat.'],
  [/maden|cevher|kömür|komur|demir|bak[ıi]r|alt[ıi]n|elmas|redstone|lapis|z[uü]mr[uü]t|coal|iron|copper|gold|diamond|emerald|debris|ore|kaz/i,
    'MADEN için "mine" kullan; "collect" sadece ağaç/kum/taş gibi yakın bloklar içindir. mine cevher yoksa kendi inip tünel kazarak arar. Alet: taş/kömür -> wooden_pickaxe, demir/bakır/lapis -> stone_pickaxe, elmas/altın/redstone/zümrüt -> iron_pickaxe. Ham maden istenirse block iron_ore yaz, sonra smelt öner.'],
  [/\bev\b|house|bar[ıi]nak|kur\b|yap\b|yap[ıi]|build|fill|duvar|in[sş]a/i,
    'EV için "house" (small/medium/large); parametre vermezsen envanterdeki en bol blok seçilir. Malzeme yetmezse sistem eksikleri söyler. Özel yapı için build/fill (build: x=sağ, y=yukarı, z=ileri, en çok 300 blok). Kapı/tuzak kapı için "door".'],
  [/pvp|d[uü]ell?o|d[oö]v[uü][sş]|sava[sş]|kristal|crystal|mace|spear|m[ıi]zrak|balta|\baxe|k[ıi]l[ıi][cç]|sword|uhc|smp|\bpot\b|sald[ıi]r|fight|spar/i,
    'PvP: oyuncu "benimle pvp at/dövüş" derse duel (target "sender") kullan. Stil: sword, axe, mace, spear, pot (netherite pot), uhc, smp (diamond smp), crystal, elytra_mace; belirtmezse "auto". Envanter eksikse (silah, totem, altın elma, iksir, rüzgar topu) say\'de kısaca belirt ama yine de dene. Rakibe sadece açıkça istenirse saldır.'],
  [/b[uü]y[uü]|enchant|[oö]rs|anvil|iksir|brew|simya|potion|nether|portal/i,
    'Büyü: enchanting_table + lapis_lazuli + XP (enchant). İksir: fill_bottles -> brew nether_wart -> brew hedef malzeme -> drink; blaze_powder yakıt şart. Nether portalı: 12 obsidian + flint_and_steel (nether_portal); obsidyen için diamond_pickaxe.'],
  [/redstone|piston|kol\b|lever|tekrarlay|repeater/i,
    'Redstone: fill/place ile redstone, lever, repeater, piston koy; yön gerekiyorsa facing ekle. Karmaşık devrede başarı garanti değil, dürüst ol.'],
  [/[sş]ema|schem|litem|\.nbt/i,
    'Şematik: ad belli değilse list_schematics, malzeme için schematic_info, kurmak için schematic. Yapı için asla command/setblock kullanma.'],
  [/yiyecek|ac[ıi]k|yemek|tarla|farm|hasat/i,
    'Yiyecek için olgun ekin ya da av gerekir: farm, attack cow/pig/chicken, smelt.'],
  [/[oö][gğ]ren|nas[ıi]l|ara[sş]t[ıi]r|tarif/i,
    'Bilmediğin tarif/mekanik/yapı için web_search kullan; sonuç [ARAŞTIRMA SONUCU] olarak gelir.'],
]

function buildSystem(name, opts = {}) {
  const q = String(opts.query || '')
  const want = pickActions(q)
  const docs = ACTION_DOCS.filter(([t]) => want.has(t)).map(([, ex, desc]) => `- ${ex} -> ${desc}`).join('\n')
  const others = ACTION_DOCS.filter(([t]) => !want.has(t)).map(([t]) => t).join(', ')
  const rules = RULES.filter(([re]) => !re || re.test(q)).map(([, r]) => `- ${r}`).join('\n')
  return `${persona(name)}

Her mesajda SADECE tek bir JSON nesnesi döndür, başka metin/markdown yazma:
{"say": "oyuncuya doğal cümle (boş olabilir)", "actions": [ ...eylemler... ]}

Eylemler:
${docs}
Diğer geçerli eylem tipleri (ilgili istek gelirse kullan, parametreleri mantıkla ver): ${others}

Kurallar:
${rules}
${opts.strict ? STRICT_RULE : CHAIN_RULE}`
}

const STRICT_RULE = `- ÇOK ÖNEMLİ: Kendi kararını vermezsin, sadece oyuncunun açıkça istediğini yaparsın. İstenmeyen ekstra eylem ekleme, kendi inisiyatifinle iş çıkarma. Bir iş için alet ya da malzeme eksikse kendi başına toplamaya/üretmeye girişme: eksikliği say'de açıkça söyle ve ne yapmamı istediğini sor. Oyuncu "gerekirse alet yap", "malzemeyi sen topla" gibi izin verirse ara adımları ekleyebilirsin.`
const CHAIN_RULE = `- Alet gerekiyorsa envantere bak, yoksa önce üret. Örnek zincir: collect oak_log -> craft oak_planks -> craft stick -> craft crafting_table -> craft wooden_pickaxe -> collect cobblestone -> craft stone_pickaxe.`

module.exports = { listModels, chat, extractJson, persona, buildSystem }
