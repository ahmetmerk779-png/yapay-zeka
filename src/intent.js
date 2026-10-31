'use strict'
// Yerel komut çözücü: basit/sık komutları (Türkçe ve İngilizce) yapay zekaya sormadan eyleme çevirir.
// Amaç: Groq token/rate limitini korumak ve gecikmeyi sıfırlamak. Anlayamazsa null döner (AI devreye girer).
// Dönen eylemler HAM'dır; blok/eşya adlarını validate.js çözer ve geçersizse AI'ya düşülür.

let Skills = null
try { Skills = require('./skills') } catch (e) { /* skills.js yoksa atla */ }

const ORE = /(demir|iron|alt[ıi]n|gold|elmas|diamond|k[oö]m[uü]r|coal|bak[ıi]r|copper|redstone|lapis|z[uü]mr[uü]t|emerald|quartz|kuvars|debris|maden|cevher|\bore\b)/i
const MOBS = /(zombi|zombie|iskelet|skeleton|[oö]r[uü]mcek|spider|creeper|enderman|inek|cow|domuz|pig|tavuk|chicken|koyun|sheep|d[uü][sş]man|hostile|canavar|mob|ghast|blaze|piglin|witch|cad[ıi]|pillager)/i
const FILL = /\b(tane|adet|blok|tanesi|x)\b/g

const num = (t) => { const m = String(t).match(/\d+/); return m ? Math.min(512, Number(m[0])) : null }
const cleanNoun = (t) => t.replace(/\d+/g, ' ').replace(FILL, ' ').replace(/\b(bana|biraz|bir|şu|su|bu|lütfen|lutfen|hemen|çok|cok|bol|bolca|please)\b/g, ' ').replace(/\s+/g, ' ').trim()

const VERBS_COLLECT = '(?:kaz|kazar m[ıi]s[ıi]n|topla|toplar m[ıi]s[ıi]n|k[ıi]r|getir|[cç][ıi]kar|mine|collect|gather|chop|kes|bul)'
const VERBS_CRAFT = '(?:yap|[uü]ret|craft|make|olu[sş]tur)'

function single(t, botName) {
  let m
  if (/^(dur|b[ıi]rak|iptal|stop|cancel|vazge[cç]|yeter)( artik| art[ıi]k)?$/.test(t)) return [{ type: 'stop' }]
  if (/^(beni |bizi )?(takip et|takip|follow( me)?|pe[sş]imden gel)$/.test(t)) return [{ type: 'follow', target: 'sender' }]
  if (/^(gel|buraya gel|yan[ıi]ma gel|bana gel|come( here)?)$/.test(t)) return [{ type: 'goto_player', target: 'sender' }]
  if (/^((bana|yan[ıi]ma|buraya) (elytra ile |roketle )?u[cç]|(elytra|roket)(le|\s?ile)? (bana|yan[ıi]ma) u[cç]a?(rak gel)?)$/.test(t)) return [{ type: 'fly', target: 'sender' }]
  if (/^(u[cç]|elytra (ile )?u[cç]|havalan|fly|takeoff)$/.test(t)) return [{ type: 'fly', height: 60 }]
  if (/^(durum|rapor|durumun ne|ne durumdas[ıi]n|status|envanter(in)?|envanterin ne)$/.test(t)) return [{ type: 'status' }]
  if (/^(ke[sş]fet|explore|etrafi gez|etraf[ıi] ke[sş]fet)$/.test(t)) return [{ type: 'explore', direction: 'random', blocks: 100 }]
  if (/^(beni koru|koru beni|bizi koru|protect me)$/.test(t)) return [{ type: 'protect', target: 'sender', seconds: 180 }]
  if (/^(sand[ıi]klar[ıi] (yağmala|yagmala|soy|bo[sş]alt)|loot)$/.test(t)) return [{ type: 'loot', radius: 16 }]
  if (/^(envanteri (sand[ıi][gğ]a )?(bo[sş]alt|depola)|e[sş]yalar[ıi] sand[ıi][gğ]a koy)$/.test(t)) return [{ type: 'store_all', radius: 16 }]
  { const m = /^(?:afk(?: ol| kal)?|afk moduna ge[cç])(?:\s+(\d{1,3})\s*(?:dk|dakika|min))?$/.exec(t); if (m) return [{ type: 'afk', minutes: m[1] ? Number(m[1]) : 0 }] }
  { const m = /^(?:otomatik (?:hasat|tarla)|hasat d[oö]ng[uü]s[uü]|auto ?farm)(?:\s+(\d{1,3})\s*(?:dk|dakika|min))?$/.exec(t); if (m) return [{ type: 'auto_farm', radius: 16, minutes: m[1] ? Number(m[1]) : 0, store: true }] }
  if (/^(ye|yemek ye|karn[ıi]n[ıi] doyur|eat)$/.test(t)) return [{ type: 'eat' }]
  if (/^(uyu|yat|ya[gğ]a[gğ]a yat|sleep)$/.test(t)) return [{ type: 'sleep' }]
  if (/^(uyan|wake|kalk)$/.test(t)) return [{ type: 'wake' }]
  if (/^(z[ıi]pla|jump)$/.test(t)) return [{ type: 'jump' }]
  if (/^([cç][oö]mel|sneak)$/.test(t)) return [{ type: 'sneak', on: true }]
  if (/^(etraf[ıi]na bak|etrafa bak|look around)$/.test(t)) return [{ type: 'look_around' }]
  if (/^(z[ıi]rh[ıi]? ?(giy|tak)|zirh giy|wear armor|armor)$/.test(t)) return [{ type: 'armor' }]
  if (/^(eve (git|d[oö]n)|go home)$/.test(t)) return [{ type: 'go_home', name: 'home' }]
  if (/^(evi|buray[ıi]) kaydet$/.test(t)) return [{ type: 'set_home', name: 'home' }]
  if (/([cç][oö]p|gereksiz).*(at|temizle)/.test(t)) return [{ type: 'drop_junk' }]
  if ((m = t.match(/^(sa[gğ]a|sola) d[oö]n(?: (\d+))?(?: derece)?$/))) return [{ type: 'turn', direction: m[1] === 'sola' ? 'left' : 'right', degrees: Number(m[2] || 90) }]
  if ((m = t.match(/^(ileri|geri|sa[gğ]a|sola) (y[uü]r[uü]|git|ko[sş])(?: (\d+))?(?: blok)?$/))) {
    const d = { ileri: 'forward', geri: 'back', sağa: 'right', saga: 'right', sola: 'left' }[m[1]]
    return [{ type: 'walk', direction: d, blocks: Number(m[3] || 5), sprint: m[2].startsWith('ko') }]
  }
  if (/(benimle|bana|beni).*(pvp|d[oö]v[uü][sş]|sava[sş]|duel)|(pvp|d[uü]ello) (at|yap)/.test(t)) {
    const style = /m[ıi]zrak|spear/.test(t) ? 'spear' : /mace|g[uü]rz/.test(t) ? 'mace' : /balta|axe/.test(t) ? 'axe' : /kristal|crystal/.test(t) ? 'crystal' : /\buhc\b/.test(t) ? 'uhc' : /\bsmp\b/.test(t) ? 'smp' : /\bpot\b|nether?ite pot/.test(t) ? 'pot' : /k[ıi]l[ıi][cç]|sword/.test(t) ? 'sword' : 'auto'
    return [{ type: 'duel', target: 'sender', style, seconds: 120 }]
  }
  if (/^(ev|kul[uü]be|house)( yap| kur| in[sş]a et)?$/.test(t) || /^(ev|kul[uü]be) (yap|kur|in[sş]a et)$/.test(t)) return [{ type: 'house', size: 'small' }]
  if ((m = t.match(/^(\d+ )?k[oö]pr[uü]( yap| kur)?$/))) return [{ type: 'bridge', blocks: Number(m[1] || 10) }]
  if ((m = t.match(/^(a[gğ]a[cç]|tree) (kes|k[ıi]r|chop)(?: (\d+))?$/))) return [{ type: 'chop_tree', count: Number(m[3] || 1) }]
  if ((m = t.match(/^(.+?) (pi[sş]ir|erit|smelt|cook)$/))) {
    const SM = [[/^(demir|iron)/, 'raw_iron'], [/^(alt[ıi]n|gold)/, 'raw_gold'], [/^(bak[ıi]r|copper)/, 'raw_copper'], [/^(et|biftek|beef)\b/, 'beef'], [/^(domuz|porkchop)/, 'porkchop'], [/^(tavuk|chicken)/, 'chicken'], [/^(bal[ıi]k|cod)/, 'cod'], [/^patates/, 'potato'], [/^(kum|sand)/, 'sand'], [/^(ta[sş]|cobble)/, 'cobblestone']]
    const nn = cleanNoun(m[1])
    const hit = SM.find(([re]) => re.test(nn))
    return [{ type: 'smelt', item: hit ? hit[1] : nn, count: num(m[1]) || 8 }]
  }

  // kaz/topla: "10 taş kaz", "taş kaz", "kaz taş", "odun topla"
  let noun = null
  let cnt = null
  let verb = null
  if ((m = t.match(new RegExp(`^(.+?) ${VERBS_COLLECT}(?: (\\d+))?$`)))) { noun = m[1]; cnt = num(m[1]) || (m[2] ? Number(m[2]) : null); verb = 'collect' }
  else if ((m = t.match(new RegExp(`^${VERBS_COLLECT} (.+)$`)))) { noun = m[1]; cnt = num(m[1]); verb = 'collect' }
  if (noun) {
    const n = cleanNoun(noun)
    if (!n || n.split(' ').length > 3) return null
    if (MOBS.test(n) && /(kes|k[ıi]r)$/.test(t)) return [{ type: 'attack', target: n, count: cnt || 1 }]
    if (ORE.test(n)) return [{ type: 'mine', block: n, count: cnt || 8 }]
    return [{ type: 'collect', block: n, count: cnt || 8 }]
  }
  // saldır / öldür
  if ((m = t.match(/^(.+?) (öldür|oldur|saldır|saldir|vur|avla|kill|attack|hunt)(?: (\d+))?$/)) || (m = t.match(/^(kill|attack|hunt) (.+)$/))) {
    const n = cleanNoun(m[1].match(/^(kill|attack|hunt)$/) ? m[2] : m[1])
    if (MOBS.test(n)) return [{ type: 'attack', target: n, count: num(m[1]) || (m[3] ? Number(m[3]) : 1) }]
    return null
  }
  // üret: "10 çubuk yap", "kazma yap", "craft stone pickaxe"
  if ((m = t.match(new RegExp(`^(.+?) ${VERBS_CRAFT}(?: (\\d+))?$`))) || (m = t.match(new RegExp(`^(?:craft|make) (.+)$`)))) {
    const raw = m[1]
    const n = cleanNoun(raw)
    if (!n || n.split(' ').length > 3) return null
    return [{ type: 'craft', item: n, count: num(raw) || (m[2] ? Number(m[2]) : 1) }]
  }
  // doğrudan yetenek adı: "get_iron_pickaxe", "gather_diamond"
  if (Skills) {
    const key = t.replace(/ /g, '_')
    if (/^(gather|get|craft|house|build|hunt|cook|duel|face|turn|walk|emote|plant|chop|guard|bridge|tower|light_up)_/.test(key) && Skills.resolve(key)) return [{ type: 'skill', name: key }]
  }
  return null
}

// msg: ham mesaj; opts: { botName }. Döner: eylem dizisi ya da null
function parse(msg, opts = {}) {
  let t = String(msg || '').toLowerCase().replace(/[.,!?;:]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (opts.botName) t = t.replace(new RegExp(`^${String(opts.botName).toLowerCase().replace(/[^a-z0-9_]/g, '')}\\s+`), '')
  t = t.replace(/^(l[uü]tfen|hadi|şimdi|simdi|bana|bi|bir)\s+/, '').replace(/\s+(l[uü]tfen|hemen|şimdi|simdi|ya|abi|kanka)$/, '').trim()
  if (!t || t.length > 90) return null
  const parts = t.split(/\s+(?:ve|sonra|ard[ıi]ndan|and then|then)\s+/)
  if (parts.length > 1) {
    const all = []
    for (const p of parts) { const r = single(p.trim()); if (!r) return null; all.push(...r) }
    return all.length <= 6 ? all : null
  }
  return single(t)
}

module.exports = { parse }
