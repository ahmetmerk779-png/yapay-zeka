'use strict'
// Yapay zekanın ürettiği JSON eylemlerini doğrular ve düzeltir.
// Amaç: bota hatalı/geçersiz hiçbir şey ulaşmasın. Hatalar açıklamalı olarak
// modele geri gönderilip bir kez daha düzelttirilir.

const MAX_ACTIONS = 10
const MAX_FILL = 1000
const Sch = require('./schematic')
const MAX_BUILD = 300

// [tip, örnek JSON, açıklama]  -> hem sistem istemine hem doğrulamaya temel
const ACTION_DOCS = [
  // Hareket
  ['follow', '{"type":"follow","target":"sender"}', 'oyuncuyu sürekli takip et'],
  ['goto_player', '{"type":"goto_player","target":"sender"}', 'oyuncunun yanına git'],
  ['goto', '{"type":"goto","x":0,"y":64,"z":0}', 'koordinata git (y opsiyonel)'],
  ['goto_block', '{"type":"goto_block","block":"crafting_table"}', 'en yakın bloğun yanına git'],
  ['wander', '{"type":"wander","radius":20,"seconds":30}', 'rastgele gez / çevreyi keşfet'],
  ['look_at', '{"type":"look_at","target":"sender"}', 'oyuncuya ya da mob\'a bak (veya x,y,z ver)'],
  ['jump', '{"type":"jump"}', 'zıpla'],
  ['sneak', '{"type":"sneak","on":true}', 'çömel / kalk'],
  ['set_home', '{"type":"set_home","name":"ev"}', 'bulunduğun noktayı kaydet'],
  ['go_home', '{"type":"go_home","name":"ev"}', 'kayıtlı noktaya dön'],
  ['mount', '{"type":"mount","target":"boat"}', 'tekneye/ata/vagona bin'],
  ['dismount', '{"type":"dismount"}', 'bindiğin şeyden in'],
  ['sleep', '{"type":"sleep"}', 'en yakın yatakta uyu'],
  ['wake', '{"type":"wake"}', 'uyanıp yataktan kalk'],
  ['stop', '{"type":"stop"}', 'yaptığın her işi durdur'],
  // Toplama / madencilik / çiftçilik
  ['collect', '{"type":"collect","block":"oak_log","count":20}', 'yakındaki blokları kaz/topla (ağaç, kum, taş...). Maden için mine kullan'],
  ['mine', '{"type":"mine","block":"iron_ore","count":10}', 'MADEN kaz: cevher yakında yoksa uygun yüksekliğe inip tünel kazarak kendi arar (kazma gerekir). Elmas/demir/altın/kömür/bakır/redstone/lapis için bunu kullan'],
  ['pickup', '{"type":"pickup","radius":16}', 'yerdeki eşyaları topla'],
  ['tunnel', '{"type":"tunnel","direction":"forward","length":10}', 'düz tünel kaz (forward/north/south/east/west)'],
  ['dig_down', '{"type":"dig_down","depth":10}', 'aşağı doğru kaz (depth ya da hedef y)'],
  ['farm', '{"type":"farm","radius":16}', 'olgun ekinleri hasat et ve yeniden ek'],
  ['fish', '{"type":"fish","seconds":60,"catches":5}', 'olta ile balık tut'],
  ['shear', '{"type":"shear","radius":16}', 'koyunları makasla'],
  ['breed', '{"type":"breed","animal":"cow"}', 'hayvanları yemle ve çiftleştir'],
  // Savaş
  ['attack', '{"type":"attack","target":"zombie","count":3}', 'mob\'a saldır ("hostile" = herhangi düşman)'],
  ['guard', '{"type":"guard","radius":16}', 'bulunduğun yeri koru'],
  ['shoot', '{"type":"shoot","target":"skeleton","shots":3}', 'yay ile ok at'],
  // İnşa
  ['place', '{"type":"place","block":"cobblestone","x":1,"y":64,"z":1}', 'tek blok yerleştir'],
  ['break', '{"type":"break","x":1,"y":64,"z":1}', 'tek bloğu kır'],
  ['fill', '{"type":"fill","block":"cobblestone","x1":0,"y1":64,"z1":0,"x2":4,"y2":67,"z2":4,"mode":"hollow"}', 'alanı doldur (mode: solid/hollow/walls/floor; block:"air" = alanı temizle)'],
  ['shelter', '{"type":"shelter","size":"small","block":"cobblestone"}', 'etrafına hızlı barınak yap (small/medium)'],
  // Envanter
  ['equip', '{"type":"equip","item":"iron_sword","slot":"hand"}', 'eşya kuşan (hand/head/torso/legs/feet/off-hand)'],
  ['drop', '{"type":"drop","item":"cobblestone","count":10}', 'eşya at (count:"all" hepsi)'],
  ['give', '{"type":"give","item":"bread","count":3,"target":"sender"}', 'oyuncuya eşya ver'],
  ['craft', '{"type":"craft","item":"oak_planks","count":8}', 'eşya üret (gerekirse crafting_table kullanır)'],
  ['smelt', '{"type":"smelt","item":"raw_iron","count":8}', 'fırında eritme/pişirme'],
  ['eat', '{"type":"eat"}', 'yemek ye'],
  ['use_item', '{"type":"use_item","item":"ender_pearl"}', 'eldeki eşyayı kullan (sağ tık)'],
  ['store', '{"type":"store","item":"cobblestone","count":"all"}', 'en yakın sandığa eşya koy'],
  ['take', '{"type":"take","item":"iron_ingot","count":5}', 'en yakın sandıktan eşya al'],
  ['inspect_chest', '{"type":"inspect_chest"}', 'en yakın sandığın içeriğine bak'],
  ['trade', '{"type":"trade","item":"bread","count":1}', 'köylüden bu eşyayı satın al'],
  // Dünya
  ['activate_block', '{"type":"activate_block","block":"lever"}', 'bloğa sağ tık (kapı, düğme, kol...) ya da x,y,z'],
  ['find', '{"type":"find","block":"diamond_ore"}', 'yakında ara ve koordinatını bildir (block / entity / player)'],
  ['chat', '{"type":"chat","text":"merhaba"}', 'oyun sohbetine yaz (target ile fısılda)'],
  ['command', '{"type":"command","text":"/time set day"}', 'sunucu komutu çalıştır'],
  ['wait', '{"type":"wait","seconds":5}', 'bekle'],
  // Gelişmiş
  ['door', '{"type":"door","kind":"trapdoor","open":true}', 'kapı/tuzak kapı/çit kapısı aç-kapat (kind: door/trapdoor/gate/any, open: true/false, x,y,z opsiyonel)'],
  ['enchant', '{"type":"enchant","item":"diamond_sword","choice":"best"}', 'büyü masasında eşyayı büyüle (lapis + XP seviyesi gerekir; choice: best/1/2/3)'],
  ['anvil', '{"type":"anvil","item":"iron_sword","with":"enchanted_book","name":"Kılıcım"}', 'örs: iki eşyayı birleştir (with) ve/veya yeniden adlandır (name)'],
  ['fill_bottles', '{"type":"fill_bottles","count":3}', 'suya bakıp cam şişeleri su şişesiyle doldur'],
  ['brew', '{"type":"brew","item":"nether_wart","count":3}', 'simya: envanterdeki şişelere (potion) bu malzemeyi uygula; blaze_powder yakıt gerekir. Zincir: su şişesi -> nether_wart (awkward) -> hedef malzeme'],
  ['drink', '{"type":"drink","potion":"healing"}', 'iksir iç (potion alanı anahtar kelime, opsiyonel)'],
  ['nether_portal', '{"type":"nether_portal","enter":true}', '12 obsidyen + flint_and_steel ile Nether portalı kur, yak ve gir'],
  ['build', '{"type":"build","offset":2,"blocks":[{"x":0,"y":0,"z":0,"block":"oak_planks"},{"x":1,"y":0,"z":0,"block":"oak_planks"}]}', 'blok listesinden yapı kur. x=sağ, y=yukarı, z=ileri (botun baktığı yöne göre, offset kadar önünden başlar). En fazla 300 blok; yön gereken bloklara "facing" ekle'],
  ['write_sign', '{"type":"write_sign","text":"Ev|Hoş geldin"}', 'yerleştirilmiş tabelaya yaz (satırlar | ile ayrılır)'],
  // Şematik, arama, PvP, hazır yapılar
  ['schematic', '{"type":"schematic","file":"ev.schem","rotate":0}', 'schematics klasöründeki .schem/.litematic/.nbt dosyasını botun önüne BLOKLARI KENDİ KOYARAK kur (komut kullanmaz; creative ise blokları kendi envanterine ekler). rotate: 0/90/180/270; x,y,z verilirse tam konum; partial:true eksik malzemeyle devam; with_air:true alandaki fazlalıkları önce kır'],
  ['schematic_info', '{"type":"schematic_info","file":"ev.schem"}', 'şematiğin boyutunu ve gereken/eksik malzemeyi söyle'],
  ['list_schematics', '{"type":"list_schematics"}', 'yüklü şematik dosyalarını listele'],
  ['download_schematic', '{"type":"download_schematic","url":"https://.../ev.schem","name":"ev.schem"}', 'oyuncunun verdiği bağlantıdan şematik indir'],
  ['web_search', '{"type":"web_search","query":"minecraft piston door redstone design"}', 'web\'de araştır ve öğren (sonuç sana [ARAŞTIRMA SONUCU] olarak gelir)'],
  ['crystal_pvp', '{"type":"crystal_pvp","target":"OyuncuAdi","seconds":120}', 'oyuncuyla kristal PvP (end_crystal + obsidyen/bedrock gerekir; sadece açıkça istenirse)'],
  ['make_farm', '{"type":"make_farm","crop":"wheat","radius":4}', 'önünde çalışan tarla kur (çapa, su kovası ve tohum gerekir)'],
  ['house', '{"type":"house","size":"small","wall":"oak_planks"}', 'ev kur (size small=5x5/medium=7x7/large=9x9; wall/floor/roof/glass/door opsiyonel). Malzeme: small ~ 25 zemin + ~44 duvar + 25 çatı blok; kapı/cam/meşale yoksa atlanır. Parametre vermezsen envanterdeki en bol blok seçilir'],
]

const TYPE_ALIASES = {
  gather: 'collect', chop: 'collect', get: 'collect',
  kill: 'attack', fight: 'attack',
  go: 'goto', walk: 'goto', move: 'goto',
  come: 'goto_player', come_here: 'goto_player', come_to: 'goto_player',
  halt: 'stop', cancel: 'stop', idle: 'stop',
  rest: 'sleep', defend: 'guard', protect: 'guard',
  toss: 'drop', throw: 'drop', hand: 'give',
  make: 'craft', wear: 'equip', hold: 'equip',
  pause: 'wait', say: 'chat', message: 'chat', whisper: 'chat',
  cmd: 'command', run_command: 'command',
  strip_mine: 'mine', mine_ore: 'mine', dig_ore: 'mine', dig: 'break', destroy: 'break', build_shelter: 'shelter', explore: 'wander', fishing: 'fish',
  open: 'activate_block', interact: 'activate_block', right_click: 'activate_block',
  deposit: 'store', put: 'store', withdraw: 'take',
  ride: 'mount', unmount: 'dismount', locate: 'find', search: 'find', scan: 'find',
  harvest: 'farm', crops: 'farm', cook: 'smelt', bow: 'shoot',
  pick_up: 'pickup', collect_items: 'pickup',
  portal: 'nether_portal', enchanting: 'enchant', brewing: 'brew', potion: 'brew', construct: 'build',
  build_house: 'house', make_house: 'house', sign: 'write_sign', open_door: 'door', trapdoor: 'door', gate: 'door',
  schem: 'schematic', paste: 'schematic', load_schematic: 'schematic', litematic: 'schematic', build_schematic: 'schematic',
  schematic_list: 'list_schematics', schematics: 'list_schematics', research: 'web_search', google: 'web_search', learn: 'web_search',
  browse: 'web_search', lookup: 'web_search', crystal: 'crystal_pvp', build_farm: 'make_farm', farm_build: 'make_farm',
  drink_potion: 'drink', bottle: 'fill_bottles', rename: 'anvil', fill_bottle: 'fill_bottles',
}

const BLOCK_SYNONYMS = {
  stone: 'stone', taş: 'stone', tas: 'stone', cobble: 'cobblestone', kırmataş: 'cobblestone',
  ancient_debris: 'ancient_debris', quartz: 'nether_quartz_ore', kuvars: 'nether_quartz_ore', coal: 'coal_ore', kömür: 'coal_ore', komur: 'coal_ore',
  iron: 'iron_ore', demir: 'iron_ore', gold: 'gold_ore', altın: 'gold_ore', altin: 'gold_ore',
  diamond: 'diamond_ore', elmas: 'diamond_ore', copper: 'copper_ore', bakır: 'copper_ore', bakir: 'copper_ore',
  redstone: 'redstone_ore', lapis: 'lapis_ore', emerald: 'emerald_ore', zümrüt: 'emerald_ore',
  sand: 'sand', kum: 'sand', dirt: 'dirt', toprak: 'dirt', gravel: 'gravel', çakıl: 'gravel',
  bed: 'white_bed', yatak: 'white_bed', chest: 'chest', sandık: 'chest', sandik: 'chest',
  table: 'crafting_table', tezgah: 'crafting_table', fırın: 'furnace', firin: 'furnace',
  kapı: 'oak_door', kapi: 'oak_door', door: 'oak_door', water: 'water', su: 'water', lava: 'lava',
  trapdoor: 'oak_trapdoor', tuzak_kapı: 'oak_trapdoor', tuzak_kapi: 'oak_trapdoor', tuzakkapı: 'oak_trapdoor',
  fence_gate: 'oak_fence_gate', çit_kapısı: 'oak_fence_gate', cit_kapisi: 'oak_fence_gate',
  obsidian: 'obsidian', obsidyen: 'obsidian', enchanting_table: 'enchanting_table', büyü_masası: 'enchanting_table', buyu_masasi: 'enchanting_table',
  örs: 'anvil', ors: 'anvil', simya: 'brewing_stand', simya_sehpası: 'brewing_stand', torch: 'torch', meşale: 'torch',
}
const GENERIC_WOOD = new Set(['wood', 'log', 'logs', 'tree', 'trees', 'odun', 'kütük', 'kutuk', 'ağaç', 'agac'])

const ITEM_SYNONYMS = {
  planks: 'oak_planks', tahta: 'oak_planks', kalas: 'oak_planks', odun: 'oak_log', wood: 'oak_log', log: 'oak_log',
  stick: 'stick', çubuk: 'stick', cubuk: 'stick', table: 'crafting_table', tezgah: 'crafting_table',
  taş: 'cobblestone', tas: 'cobblestone', stone: 'cobblestone',
  demir: 'iron_ingot', iron: 'iron_ingot', altın: 'gold_ingot', altin: 'gold_ingot', gold: 'gold_ingot',
  elmas: 'diamond', kömür: 'coal', komur: 'coal', zümrüt: 'emerald', ekmek: 'bread', meşale: 'torch', mesale: 'torch',
  et: 'cooked_beef', biftek: 'cooked_beef', steak: 'cooked_beef', elma: 'apple', yay: 'bow', ok: 'arrow',
  olta: 'fishing_rod', makas: 'shears', kova: 'bucket', fırın: 'furnace', firin: 'furnace', sandık: 'chest', sandik: 'chest',
  kılıç: 'iron_sword', kilic: 'iron_sword', kazma: 'iron_pickaxe', balta: 'iron_axe', kürek: 'iron_shovel', kurek: 'iron_shovel',
  kalkan: 'shield', yatak: 'white_bed',
  obsidyen: 'obsidian', çakmak: 'flint_and_steel', cakmak: 'flint_and_steel', şişe: 'glass_bottle', sise: 'glass_bottle',
  tabela: 'oak_sign', kemik_unu: 'bone_meal', su_kovası: 'water_bucket', su_kovasi: 'water_bucket', lav_kovası: 'lava_bucket',
  kırmızı_toz: 'redstone', kirmizi_toz: 'redstone', lapis: 'lapis_lazuli', blaze_tozu: 'blaze_powder', tuzak_kapı: 'oak_trapdoor',
  tuzak_kapi: 'oak_trapdoor', kapı: 'oak_door', kapi: 'oak_door', iksir: 'potion',
}

const MOB_SYNONYMS = {
  zombi: 'zombie', iskelet: 'skeleton', örümcek: 'spider', orumcek: 'spider', inek: 'cow', koyun: 'sheep',
  domuz: 'pig', tavuk: 'chicken', yarasa: 'bat', cadı: 'witch', cadi: 'witch', hortlak: 'phantom',
  köylü: 'villager', koylu: 'villager', at: 'horse', tekne: 'boat', kurt: 'wolf', kedi: 'cat',
  tavşan: 'rabbit', tavsan: 'rabbit', lama: 'llama', eşek: 'donkey', esek: 'donkey',
}

const DIRECTIONS = {
  forward: 'forward', ileri: 'forward', front: 'forward',
  north: 'north', kuzey: 'north', south: 'south', güney: 'south', guney: 'south',
  east: 'east', doğu: 'east', dogu: 'east', west: 'west', batı: 'west', bati: 'west',
}

const BREED_ITEMS = {
  cow: 'wheat', sheep: 'wheat', mooshroom: 'wheat', goat: 'wheat', pig: 'carrot', chicken: 'wheat_seeds',
  horse: 'golden_carrot', donkey: 'golden_carrot', rabbit: 'carrot', llama: 'hay_block', wolf: 'beef',
  cat: 'cod', fox: 'sweet_berries', turtle: 'seagrass', bee: 'poppy', camel: 'cactus', panda: 'bamboo',
}

const SLOT_ALIASES = {
  hand: 'hand', main_hand: 'hand', el: 'hand',
  head: 'head', helmet: 'head', kask: 'head',
  torso: 'torso', chest: 'torso', chestplate: 'torso', body: 'torso', göğüslük: 'torso',
  legs: 'legs', leggings: 'legs', pantolon: 'legs',
  feet: 'feet', boots: 'feet', ayakkabı: 'feet',
  'off-hand': 'off-hand', off_hand: 'off-hand', offhand: 'off-hand',
}

const normName = (s) => String(s ?? '').trim().toLowerCase().replace(/^minecraft:/, '').replace(/[\s-]+/g, '_')

function validateActions(inst, rawActions, ctx = {}) {
  const out = []
  const errors = []
  const bot = inst.bot
  const md = inst.mcData
  const onlinePlayers = () => Object.keys(bot.players).filter((n) => n !== bot.username)

  const h = {
    player(raw) {
      const n = String(raw ?? '').trim().toLowerCase()
      if (!n || ['sender', 'me', 'ben', 'beni', 'bana', 'user', 'owner'].includes(n)) {
        const p = n === 'owner' ? (inst.cfg.owner || ctx.senderPlayer) : ctx.senderPlayer
        if (!p) throw new Error('komutu veren oyuncu belli değil; hedef oyuncunun adını açıkça yaz')
        return p
      }
      const names = onlinePlayers()
      const f = names.find((x) => x.toLowerCase() === n) || names.find((x) => x.toLowerCase().includes(n))
      if (!f) throw new Error(`"${raw}" adlı oyuncu çevrimiçi değil. Çevrimiçi: ${names.join(', ') || '(kimse yok)'}`)
      return f
    },
    exactPlayer(raw) {
      const n = String(raw ?? '').trim().toLowerCase()
      return onlinePlayers().find((x) => x.toLowerCase() === n) || null
    },
    blocks(raw) {
      const n0 = normName(raw)
      if (n0.length < 2) throw new Error('blok adı boş')
      if (GENERIC_WOOD.has(n0)) {
        const defs = Object.values(md.blocksByName).filter((b) => b.name.endsWith('_log') && !b.name.startsWith('stripped_'))
        return { defs, label: 'odun' }
      }
      const n = BLOCK_SYNONYMS[n0] || n0
      let def = md.blocksByName[n]
      if (!def) {
        const m = Object.keys(md.blocksByName).filter((k) => k.includes(n)).sort((a, b) => a.length - b.length)
        if (m.length) def = md.blocksByName[m[0]]
      }
      if (!def) throw new Error(`"${raw}" geçerli bir Minecraft blok kimliği değil (örn. oak_log, cobblestone, iron_ore)`)
      const defs = [def]
      if (def.name.endsWith('_ore')) {
        const deep = md.blocksByName['deepslate_' + def.name]
        if (deep) defs.push(deep)
      }
      if (def.name === 'water' || def.name === 'lava') return { defs, label: def.name }
      return { defs, label: def.name }
    },
    item(raw, preferInv = false) {
      const n0 = normName(raw)
      if (n0.length < 2) throw new Error('eşya adı boş')
      const n = ITEM_SYNONYMS[n0] || n0
      if (preferInv) {
        const inv = bot.inventory.items()
        const hit = inv.find((i) => i.name === n) || inv.find((i) => i.name.includes(n))
        if (hit) return md.itemsByName[hit.name]
      }
      let def = md.itemsByName[n]
      if (!def) {
        const m = Object.keys(md.itemsByName).filter((k) => k.includes(n)).sort((a, b) => a.length - b.length)
        if (m.length) def = md.itemsByName[m[0]]
      }
      if (!def) throw new Error(`"${raw}" geçerli bir Minecraft eşya kimliği değil (örn. iron_sword, bread, cobblestone)`)
      return def
    },
    placeable(raw) {
      // redstone -> redstone_wire, wheat_seeds -> wheat gibi eşya/blok adı farkları olduğu için sıkı kontrol yapmıyoruz
      return h.item(raw, true)
    },
    mob(raw) {
      const n0 = normName(raw)
      if (['hostile', 'monster', 'enemy', 'düşman', 'dusman', 'canavar'].includes(n0)) return 'hostile'
      const n = MOB_SYNONYMS[n0] || n0
      if (md.entitiesByName[n]) return n
      const m = Object.keys(md.entitiesByName).filter((k) => k.includes(n)).sort((a, b) => a.length - b.length)
      if (!m.length) throw new Error(`"${raw}" geçerli bir mob adı değil (örn. zombie, cow, villager, hostile)`)
      return m[0]
    },
    num(v, label) {
      const x = Number(v)
      if (v === undefined || v === null || v === '' || !Number.isFinite(x)) throw new Error(`${label} sayı olmalı`)
      return x
    },
    int(v, def, min, max, label = 'değer') {
      if (v === undefined || v === null || v === '') {
        if (def === undefined) throw new Error(`${label} gerekli`)
        return def
      }
      const x = Number(v)
      if (!Number.isFinite(x)) throw new Error(`${label} sayı olmalı`)
      return Math.min(max, Math.max(min, Math.round(x)))
    },
    coord(a, kx = 'x', ky = 'y', kz = 'z') {
      return {
        x: Math.floor(h.num(a[kx], kx)),
        y: Math.max(-64, Math.min(320, Math.floor(h.num(a[ky], ky)))),
        z: Math.floor(h.num(a[kz], kz)),
      }
    },
    countOrAll(v) {
      if (v === 'all' || v === 'hepsi' || v === 'tümü') return null
      return h.int(v, 1, 1, 2304, 'count')
    },
    text(v, max = 200) {
      const s = String(v ?? '').replace(/[\r\n]+/g, ' ').trim()
      if (!s) throw new Error('text boş olamaz')
      return s.slice(0, max)
    },
  }

  const FACING_NAMES = { north: 'north', kuzey: 'north', south: 'south', güney: 'south', guney: 'south', east: 'east', doğu: 'east', dogu: 'east', west: 'west', batı: 'west', bati: 'west', up: 'up', yukarı: 'up', yukari: 'up', down: 'down', aşağı: 'down', asagi: 'down', forward: 'forward', ileri: 'forward', back: 'back', geri: 'back', left: 'left', sol: 'left', right: 'right', sağ: 'right', sag: 'right' }
  const facing = (v) => {
    if (v === undefined || v === null || v === '') return null
    const f = FACING_NAMES[normName(v)]
    if (!f) throw new Error(`facing "${v}" geçersiz (north/south/east/west/up/down)`)
    return f
  }

  const N = {
    stop: () => ({}), wake: () => ({}), dismount: () => ({}), sleep: () => ({}), eat: () => ({}), jump: () => ({}),
    inspect_chest: (a) => (a.x !== undefined && a.z !== undefined ? { pos: h.coord(a) } : {}),
    follow: (a) => ({ target: h.player(a.target) }),
    goto_player: (a) => ({ target: h.player(a.target) }),
    goto: (a) => ({
      x: h.num(a.x, 'x'), z: h.num(a.z, 'z'),
      y: a.y === undefined || a.y === null || a.y === '' ? null : Math.max(-64, Math.min(320, h.num(a.y, 'y'))),
    }),
    goto_block: (a) => ({ ...h.blocks(a.block), maxDistance: h.int(a.maxDistance, 64, 4, 128, 'maxDistance') }),
    wander: (a) => ({ radius: h.int(a.radius, 20, 5, 64, 'radius'), seconds: h.int(a.seconds, 30, 5, 300, 'seconds') }),
    look_at: (a) => {
      if (a.target !== undefined && a.target !== null && a.target !== '') {
        const exact = h.exactPlayer(a.target)
        if (exact) return { kind: 'player', name: exact }
        try { return { kind: 'player', name: h.player(a.target) } } catch (e) { /* mob dene */ }
        return { kind: 'mob', name: h.mob(a.target) }
      }
      return { kind: 'pos', ...h.coord(a) }
    },
    sneak: (a) => ({ on: a.on === undefined ? true : !(a.on === false || a.on === 'false') }),
    set_home: (a) => ({ name: String(a.name || 'home').slice(0, 24) }),
    go_home: (a) => ({ name: String(a.name || 'home').slice(0, 24) }),
    mount: (a) => ({ name: h.mob(a.target) }),
    collect: (a) => ({ ...h.blocks(a.block || a.ore), count: h.int(a.count, 8, 1, 512, 'count') }),
    mine: (a) => ({ ...h.blocks(a.block || a.ore || a.target), count: h.int(a.count, 8, 1, 256, 'count'), maxTunnel: h.int(a.maxTunnel, 160, 10, 400, 'maxTunnel') }),
    pickup: (a) => ({ radius: h.int(a.radius, 16, 3, 32, 'radius') }),
    tunnel: (a) => {
      const d = DIRECTIONS[normName(a.direction || 'forward')]
      if (!d) throw new Error('direction forward/north/south/east/west olmalı')
      return { direction: d, length: h.int(a.length, 10, 1, 64, 'length') }
    },
    dig_down: (a) => {
      if (a.y !== undefined && a.y !== null && a.y !== '') return { y: h.int(a.y, undefined, -64, 320, 'y') }
      return { depth: h.int(a.depth, 10, 1, 120, 'depth') }
    },
    farm: (a) => ({ radius: h.int(a.radius, 16, 4, 48, 'radius') }),
    fish: (a) => ({
      seconds: h.int(a.seconds, 60, 10, 900, 'seconds'),
      catches: a.catches === undefined || a.catches === null ? null : h.int(a.catches, 5, 1, 64, 'catches'),
    }),
    shear: (a) => ({ radius: h.int(a.radius, 16, 4, 48, 'radius') }),
    breed: (a) => {
      const animal = h.mob(a.animal || a.target)
      const itemName = a.item ? h.item(a.item, true).name : BREED_ITEMS[animal]
      if (!itemName) throw new Error(`${animal} için yem belirtmelisin (item)`)
      return { animal, itemName }
    },
    attack: (a) => {
      const exact = h.exactPlayer(a.target)
      if (exact) {
        if (!inst.cfg.allowPvp) throw new Error('oyunculara saldırı kapalı')
        if (exact === ctx.senderPlayer || (inst.cfg.owner && exact.toLowerCase() === inst.cfg.owner.toLowerCase())) {
          throw new Error('sahibine / komutu verene saldırılamaz')
        }
        return { kind: 'player', name: exact, count: 1 }
      }
      const mob = h.mob(a.target)
      return { kind: mob === 'hostile' ? 'hostile' : 'mob', name: mob, count: h.int(a.count, 1, 1, 30, 'count') }
    },
    guard: (a) => ({ radius: h.int(a.radius, 16, 4, 32, 'radius') }),
    shoot: (a) => {
      const mob = h.mob(a.target)
      return { kind: mob === 'hostile' ? 'hostile' : 'mob', name: mob, shots: h.int(a.shots, 3, 1, 30, 'shots') }
    },
    place: (a) => ({ item: h.placeable(a.block), facing: facing(a.facing), delay: a.delay ? h.int(a.delay, 1, 1, 4, 'delay') : null, ...h.coord(a) }),
    break: (a) => ({ ...h.coord(a) }),
    fill: (a) => {
      const isAir = ['air', 'clear', 'temizle'].includes(normName(a.block))
      const c1 = h.coord(a, 'x1', 'y1', 'z1')
      const c2 = h.coord(a, 'x2', 'y2', 'z2')
      const minX = Math.min(c1.x, c2.x), maxX = Math.max(c1.x, c2.x)
      const minY = Math.min(c1.y, c2.y), maxY = Math.max(c1.y, c2.y)
      const minZ = Math.min(c1.z, c2.z), maxZ = Math.max(c1.z, c2.z)
      const vol = (maxX - minX + 1) * (maxY - minY + 1) * (maxZ - minZ + 1)
      if (vol > MAX_FILL) throw new Error(`alan çok büyük (${vol} blok); en fazla ${MAX_FILL} blok`)
      const mode = ['solid', 'hollow', 'walls', 'floor'].includes(normName(a.mode)) ? normName(a.mode) : 'solid'
      return { clear: isAir, item: isAir ? null : h.placeable(a.block), minX, maxX, minY, maxY, minZ, maxZ, mode, volume: vol }
    },
    shelter: (a) => ({
      size: normName(a.size) === 'medium' ? 'medium' : 'small',
      item: a.block ? h.placeable(a.block) : null,
    }),
    equip: (a) => {
      const slot = a.slot ? SLOT_ALIASES[normName(a.slot)] : 'hand'
      if (!slot) throw new Error('slot hand/head/torso/legs/feet/off-hand olmalı')
      return { item: h.item(a.item, true), slot }
    },
    drop: (a) => ({ item: h.item(a.item, true), count: h.countOrAll(a.count) }),
    give: (a) => ({ item: h.item(a.item, true), count: h.countOrAll(a.count), target: h.player(a.target) }),
    craft: (a) => ({ item: h.item(a.item), count: h.int(a.count, 1, 1, 512, 'count') }),
    smelt: (a) => ({ item: h.item(a.item, true), count: h.int(a.count, 1, 1, 64, 'count') }),
    use_item: (a) => ({ item: a.item ? h.item(a.item, true) : null, ...(a.x !== undefined && a.z !== undefined ? { pos: h.coord(a) } : {}) }),
    store: (a) => ({ item: h.item(a.item, true), count: h.countOrAll(a.count ?? 'all'), ...(a.x !== undefined && a.z !== undefined ? { pos: h.coord(a) } : {}) }),
    take: (a) => ({ item: h.item(a.item), count: h.countOrAll(a.count ?? 'all'), ...(a.x !== undefined && a.z !== undefined ? { pos: h.coord(a) } : {}) }),
    trade: (a) => ({ item: h.item(a.item), count: h.int(a.count, 1, 1, 64, 'count') }),
    activate_block: (a) => {
      if (a.block) return { ...h.blocks(a.block) }
      if (a.x !== undefined && a.z !== undefined) return { pos: h.coord(a) }
      throw new Error('block adı ya da x,y,z gerekli')
    },
    find: (a) => {
      if (a.block) return { kind: 'block', ...h.blocks(a.block) }
      if (a.player) return { kind: 'player', name: h.player(a.player) }
      if (a.entity) return { kind: 'entity', name: h.mob(a.entity) }
      throw new Error('block, entity ya da player alanlarından biri gerekli')
    },
    chat: (a) => ({ text: h.text(a.text), target: a.target ? h.player(a.target) : null }),
    command: (a) => {
      if (!ctx.trusted || !inst.cfg.allowCommands) throw new Error('komut çalıştırma kapalı ya da yetkin yok')
      let t = h.text(a.text)
      if (!t.startsWith('/')) t = '/' + t
      return { text: t }
    },
    door: (a) => {
      const k = normName(a.kind || 'any')
      const kind = { door: 'door', kapı: 'door', kapi: 'door', trapdoor: 'trapdoor', tuzak: 'trapdoor', tuzak_kapı: 'trapdoor', tuzak_kapi: 'trapdoor', gate: 'gate', fence_gate: 'gate', any: 'any' }[k]
      if (!kind) throw new Error('kind door/trapdoor/gate/any olmalı')
      const open = a.open === undefined || a.open === null ? null : !(a.open === false || a.open === 'false' || a.open === 'kapat')
      return { kind, open, ...(a.x !== undefined && a.z !== undefined ? { pos: h.coord(a) } : {}) }
    },
    enchant: (a) => {
      let choice = 'best'
      if (a.choice !== undefined && a.choice !== 'best') choice = h.int(a.choice, 3, 1, 3, 'choice')
      return { item: h.item(a.item, true), choice }
    },
    anvil: (a) => {
      const out = { item: h.item(a.item, true) }
      if (a.with) out.with = h.item(a.with, true)
      if (a.name) out.name = h.text(a.name, 50)
      if (!out.with && !out.name) throw new Error('with (ikinci eşya) ya da name (yeni ad) gerekli')
      return out
    },
    fill_bottles: (a) => ({ count: h.int(a.count, 3, 1, 27, 'count') }),
    brew: (a) => ({ item: h.item(a.item, true), count: h.int(a.count, 3, 1, 3, 'count') }),
    drink: (a) => ({ potion: a.potion ? normName(a.potion) : null }),
    nether_portal: (a) => ({ enter: !(a.enter === false || a.enter === 'false') }),
    build: (a) => {
      if (!Array.isArray(a.blocks) || !a.blocks.length) throw new Error('blocks bir dolu dizi olmalı')
      if (a.blocks.length > MAX_BUILD) throw new Error(`en fazla ${MAX_BUILD} blok verilebilir (${a.blocks.length} verildi); yapıyı parçalara böl`)
      const seen = new Set()
      const list = []
      const bad = []
      a.blocks.forEach((e, i) => {
        try {
          if (!e || typeof e !== 'object') throw new Error('nesne değil')
          const x = h.int(e.x, undefined, -32, 32, 'x')
          const y = h.int(e.y, undefined, -8, 48, 'y')
          const z = h.int(e.z, undefined, -32, 32, 'z')
          const key = `${x},${y},${z}`
          if (seen.has(key)) return
          seen.add(key)
          list.push({ x, y, z, item: h.placeable(e.block), facing: facing(e.facing), delay: e.delay ? h.int(e.delay, 1, 1, 4, 'delay') : null })
        } catch (err) { bad.push(`#${i + 1}: ${err.message}`) }
      })
      if (bad.length) throw new Error(`geçersiz bloklar -> ${bad.slice(0, 4).join('; ')}${bad.length > 4 ? ` (+${bad.length - 4} tane daha)` : ''}`)
      return { list, offset: h.int(a.offset, 2, 1, 16, 'offset') }
    },
    write_sign: (a) => {
      const raw = Array.isArray(a.text) ? a.text.join('|') : String(a.text ?? '')
      const lines = raw.split('|').map((l) => l.trim().slice(0, 15)).slice(0, 4)
      if (!lines.join('').length) throw new Error('text boş olamaz')
      return { text: lines.join('\n'), ...(a.x !== undefined && a.z !== undefined ? { pos: h.coord(a) } : {}) }
    },
    schematic: (a) => {
      const file = Sch.resolveFile(a.file)
      if (!file) throw new Error(`şematik bulunamadı: "${a.file}". Mevcut: ${Sch.listFiles().map((f) => f.name).join(', ') || 'hiç dosya yok (panelden yükle)'}`)
      const rotate = Number(a.rotate ?? 0)
      if (![0, 90, 180, 270].includes(rotate)) throw new Error('rotate 0, 90, 180 ya da 270 olmalı')
      // Not: eski "mode":"command" artık yok; şematik her zaman botun kendi elleriyle kurulur
      const out = { file, rotate, offset: h.int(a.offset, 3, 1, 64, 'offset'), dy: h.int(a.dy, 0, -16, 16, 'dy'),
        withAir: a.with_air === true || a.withAir === true || a.clear === true, partial: a.partial === true }
      if (a.x !== undefined && a.z !== undefined && a.y !== undefined) out.pos = h.coord(a)
      return out
    },
    schematic_info: (a) => {
      const file = Sch.resolveFile(a.file)
      if (!file) throw new Error(`şematik bulunamadı: "${a.file}". Mevcut: ${Sch.listFiles().map((f) => f.name).join(', ') || 'hiç dosya yok'}`)
      return { file }
    },
    list_schematics: () => ({}),
    download_schematic: (a) => {
      if (!ctx.trusted) throw new Error('yetkin yok')
      let u
      try { u = new URL(String(a.url)) } catch (e) { throw new Error('url geçersiz') }
      if (!['http:', 'https:'].includes(u.protocol)) throw new Error('sadece http/https bağlantıları')
      const name = Sch.sanitizeName(a.name || decodeURIComponent(u.pathname.split('/').pop() || ''))
      return { url: u.toString(), name }
    },
    web_search: (a) => {
      const q = String(a.query ?? '').replace(/\s+/g, ' ').trim()
      if (q.length < 3) throw new Error('query en az 3 karakter olmalı')
      return { query: q.slice(0, 200) }
    },
    crystal_pvp: (a) => {
      if (!inst.cfg.allowPvp) throw new Error('oyunculara saldırı kapalı (panelden aç)')
      const target = h.exactPlayer(a.target)
      if (!target) throw new Error(`"${a.target}" adlı oyuncu çevrimiçi değil`)
      if (target === ctx.senderPlayer || (inst.cfg.owner && target.toLowerCase() === inst.cfg.owner.toLowerCase())) throw new Error('sahibine / komutu verene saldırılamaz')
      return { target, seconds: h.int(a.seconds, 120, 10, 600, 'seconds') }
    },
    make_farm: (a) => {
      const crop = { wheat: 'wheat', buğday: 'wheat', bugday: 'wheat', carrot: 'carrots', carrots: 'carrots', havuç: 'carrots', havuc: 'carrots', potato: 'potatoes', potatoes: 'potatoes', patates: 'potatoes', beetroot: 'beetroots', beetroots: 'beetroots', pancar: 'beetroots' }[normName(a.crop || 'wheat')]
      if (!crop) throw new Error('crop wheat/carrots/potatoes/beetroots olmalı')
      return { crop, radius: h.int(a.radius, 4, 2, 6, 'radius'), offset: h.int(a.offset, 2, 1, 16, 'offset') }
    },
    house: (a) => {
      const size = ['small', 'medium', 'large'].includes(normName(a.size)) ? normName(a.size) : 'small'
      // Malzeme verilmediyse envanterdeki en bol yapı bloğunu hepsi için kullan (yeterliyse)
      let auto = null
      if (!a.wall && !a.floor && !a.roof) {
        const need = { small: 95, medium: 170, large: 240 }[size]
        const BUILD_OK = /(_planks|^cobblestone|^stone$|^stone_bricks|^bricks|^dirt|^cobbled_deepslate|^deepslate_bricks|^sandstone|^smooth_stone|^netherrack|^spruce_planks)$/
        const tot = {}
        bot.inventory.items().forEach((i) => { if (BUILD_OK.test(i.name)) tot[i.name] = (tot[i.name] || 0) + i.count })
        const best = Object.entries(tot).sort((x, y) => y[1] - x[1])[0]
        if (best && best[1] >= need) auto = best[0]
      }
      const W = a.wall || auto || 'oak_planks'
      return {
        size,
        wall: h.placeable(W), floor: h.placeable(a.floor || auto || a.wall || 'cobblestone'), roof: h.placeable(a.roof || auto || a.wall || 'oak_planks'),
        glass: h.placeable(a.glass || 'glass'), door: h.placeable(a.door || 'oak_door'), offset: h.int(a.offset, 2, 1, 16, 'offset'),
      }
    },
    wait: (a) => ({ seconds: h.int(a.seconds, 3, 1, 120, 'seconds') }),
  }

  if (rawActions === undefined || rawActions === null) return { out, errors }
  if (!Array.isArray(rawActions)) return { out, errors: ['"actions" bir dizi (array) olmalı.'] }
  if (rawActions.length > MAX_ACTIONS) errors.push(`En fazla ${MAX_ACTIONS} eylem verilebilir, fazlası atıldı.`)

  rawActions.slice(0, MAX_ACTIONS).forEach((a, i) => {
    const tag = `eylem #${i + 1}`
    if (!a || typeof a !== 'object' || Array.isArray(a)) { errors.push(`${tag}: nesne olmalı.`); return }
    let type = normName(a.type)
    type = TYPE_ALIASES[type] || type
    if (!N[type]) {
      errors.push(`${tag}: bilinmeyen eylem tipi "${a.type}". Geçerli tipler: ${Object.keys(N).join(', ')}`)
      return
    }
    try {
      out.push({ type, ...N[type](a) })
    } catch (e) {
      errors.push(`${tag} (${type}): ${e.message}`)
    }
  })
  return { out, errors }
}

module.exports = { ACTION_DOCS, MAX_ACTIONS, MAX_FILL, validateActions }
