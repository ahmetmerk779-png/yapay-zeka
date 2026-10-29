'use strict'
// Yapay zekanın ürettiği JSON eylemlerini doğrular ve düzeltir.
// Amaç: bota hatalı/geçersiz hiçbir şey ulaşmasın. Hatalar açıklamalı olarak
// modele geri gönderilip bir kez daha düzelttirilir.

const MAX_ACTIONS = 10
const MAX_FILL = 1000
const Sch = require('./schematic')
let Skills = null
try { Skills = require('./skills') } catch (e) { /* skills.js yoksa skill eylemi kapalı */ }
const MAX_BUILD = 300

// [tip, örnek JSON, açıklama]  -> hem sistem istemine hem doğrulamaya temel
const ACTION_DOCS = [
  // Hareket
  ['follow', '{"type":"follow","target":"sender","distance":2}', 'oyuncuyu sürekli takip et (distance 1-10 blok mesafe)'],
  ['goto_player', '{"type":"goto_player","target":"sender"}', 'oyuncunun yanına git'],
  ['goto', '{"type":"goto","x":0,"y":64,"z":0}', 'koordinata git (y opsiyonel)'],
  ['goto_block', '{"type":"goto_block","block":"crafting_table"}', 'en yakın bloğun yanına git'],
  ['wander', '{"type":"wander","radius":20,"seconds":30}', 'rastgele gez / çevreyi keşfet'],
  ['look_at', '{"type":"look_at","target":"sender"}', 'oyuncuya ya da mob\'a bak (veya x,y,z ver)'],
  ['turn', '{"type":"turn","direction":"right","degrees":90}', 'kafayı/gövdeyi yumuşakça çevir (right/left, derece; pitch opsiyonel: + yukarı, - aşağı)'],
  ['face', '{"type":"face","direction":"north"}', 'bir yöne dön: north/south/east/west/up/down/forward/back'],
  ['look_around', '{"type":"look_around","seconds":6}', 'etrafa bakın (kafa çevirerek çevreyi tara)'],
  ['walk', '{"type":"walk","direction":"forward","blocks":8,"sprint":false}', 'baktığın yöne göre elle yürü (forward/back/left/right); engelde zıplar, uçurum/lavda durur'],
  ['flee', '{"type":"flee","from":"zombie","blocks":24}', 'birinden/bir şeyden kaç (oyuncu adı, mob adı ya da "hostile")'],
  ['circle', '{"type":"circle","target":"sender","radius":4,"seconds":15}', 'birinin etrafında dön (yan adım, mesafeyi korur)'],
  ['emote', '{"type":"emote","kind":"wave"}', 'jest: wave (el salla), nod (evet), shake (hayır), dance (dans), crouch (çömel-kalk)'],
  ['chop_tree', '{"type":"chop_tree","count":1}', 'ağacı tamamen kes (alttan üste), düşenleri topla, fidan varsa yeniden dik'],
  ['plant', '{"type":"plant","item":"oak_sapling","radius":8,"count":4}', 'fidan/tohum/havuç/patates ek (fidan toprağa, ekin sürülmüş tarlaya)'],
  ['bone_meal', '{"type":"bone_meal","radius":8,"count":10}', 'ekin/fidanlara kemik tozu uygula'],
  ['redstone', '{"type":"redstone","kind":"line","length":10}', 'HAZIR REDSTONE devresi (baktığın yöne kurar): kind=line (kol + toz hattı + lamba, uzunsa tekrarlayıcı), lamp (kol + 2 toz + lamba), pressure_door (demir kapı + iki yanda basınç plakası). Gerekenler: redstone, lever, repeater, redstone_lamp, iron_door, stone_pressure_plate. Başka devreler için build ile tek tek blok koy'],
  ['bridge', '{"type":"bridge","blocks":10}', 'baktığın yöne köprü kur (boşluk üstünde çömelerek ilerler; item opsiyonel)'],
  ['pillar_up', '{"type":"pillar_up","height":6}', 'zıplayıp altına blok koyarak yukarı çık (kule)'],
  ['throw_item', '{"type":"throw_item","item":"ender_pearl","target":"sender","count":1}', 'eşya fırlat (ender_pearl, snowball, egg, splash_potion); target ya da x,y,z, yoksa ileri'],
  ['bucket', '{"type":"bucket","mode":"place","fluid":"water"}', 'kova: mode pickup (sudan/lavdan doldur) ya da place (su/lav koy; x,y,z opsiyonel)'],
  ['light_area', '{"type":"light_area","radius":12,"spacing":5}', 'karanlık yerlere meşale koy (torch gerekir)'],
  ['patrol', '{"type":"patrol","points":[{"x":0,"z":0},{"x":20,"z":0}],"loops":3}', 'noktalar arasında devriye gez'],
  ['shield', '{"type":"shield","seconds":5}', 'kalkan kaldır ve tut'],
  ['drop_junk', '{"type":"drop_junk","keep":0}', 'gereksiz eşyaları (toprak, çakıl, çürük et...) at; items ile liste verilebilir'],
  ['armor', '{"type":"armor"}', 'envanterdeki en iyi zırhı giy'],
  ['build_shape', '{"type":"build_shape","shape":"tower","block":"cobblestone","width":5,"height":8}', 'hazır şekil kur: wall, tower, pyramid, stairs, platform, circle, cube (width/height/length)'],
  ['skill', '{"type":"skill","name":"get_iron_pickaxe"}', 'HAZIR YETENEK (300+ isim, zincirleme eylemler). Kalıplar: gather_<kaynak>[_adet] (gather_iron, gather_sand), craft_<eşya>[_adet], get_<wooden|stone|iron|golden|diamond>_<pickaxe|axe|shovel|hoe|sword>, get_<iron|golden|diamond>_<helmet|chestplate|leggings|boots|armor_set>, house_<small|medium|large>_<blok>, build_<wall|tower|pyramid|stairs|platform|circle|cube>_<blok>, hunt_<hayvan>[_adet], cook_<çiğ_eşya>, duel_<stil>, face_<yön>, turn_<left|right>_<derece>, walk_<yön>_<blok>, emote_<tür>, plant_<eşya>, chop_tree_<n>, bridge_<n>, tower_<n>, light_up_<r>, cleanup, wear_armor, eat_best, hunt_hostile. Birden çok adımlı işi tek eylemle yap; biri başarısızsa durur'],
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
  ['web_search', '{"type":"web_search","query":"how to make a piston door","topic":"redstone","deep":false}', 'Bilmediğin bir şeyi araştır (önce yerel tarif/blok bilgisi, sonra Minecraft Wiki + web). topic: recipe/mechanic/redstone/pvp/build/farm/mob; deep:true = sayfayı derin oku. Sonuç [ARAŞTIRMA SONUCU] olarak gelir'],
  ['crystal_pvp', '{"type":"crystal_pvp","target":"OyuncuAdi","seconds":120}', 'oyuncuyla kristal PvP (end_crystal + obsidyen/bedrock gerekir; sadece açıkça istenirse)'],
  ['duel', '{"type":"duel","target":"sender","style":"sword","seconds":120}', 'oyuncuyla PvP düellosu ("benimle pvp at" = target sender). style: sword/axe/mace/spear/pot(netherite pot)/uhc/smp/crystal/elytra_mace/auto. Kritik, W-tap, yan adım, kalkan kırma, totem, altın elma, iksir, ok, rüzgar topu+mace içerir'],
  ['custom', '{"type":"custom","name":"ag_at","desc":"hedefin ayağına ağ koy","steps":[{"op":"equip","item":"cobweb"},{"op":"look","at":"player","name":"sender"},{"op":"use"}]}', 'LİSTEDE OLMAYAN bir isteği kendi adımlarınla yap. op: equip{item}, use{item?,hold(ms)}, use_on{dx,dy,dz}, look{at:down|up|player|mob,name}, control{state:forward|back|left|right|jump|sprint|sneak,on,ms}, wait{ms}, say{message}, action{action:{mevcut eylem},optional}, repeat{times,steps}, if{cond:{kind:health_below|health_above|food_below|has_item|no_item|on_ground,value|item},then,else}. Başarılı olursa name ile kaydedilir; sonra {"type":"custom","name":"..."} ile tekrar çağrılır (kayıtlı_makrolar listesine bak)'],
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
  rotate: 'turn', spin: 'turn', head: 'look_around', scan: 'look_around', run_away: 'flee', escape: 'flee', orbit: 'circle', strafe: 'circle', gesture: 'emote', dance: 'emote', wave: 'emote', go_forward: 'walk', step: 'walk', macro: 'custom', script: 'custom', sequence: 'custom', routine: 'custom', pvp: 'duel', spar: 'duel', fight_me: 'duel', duello: 'duel', portal: 'nether_portal', enchanting: 'enchant', brewing: 'brew', potion: 'brew', construct: 'build',
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

// ---- Ad çözümleme: aileler (taş = tüm taş türleri), bulanık eşleştirme, öneriler
const ownKeys = (md, kind) => Object.keys(kind === 'block' ? md.blocksByName : kind === 'item' ? md.itemsByName : md.entitiesByName)
const names = (md, re) => ownKeys(md, 'block').filter((k) => re.test(k))
const BLOCK_FAMILIES = {
  taş: ['stone', 'cobblestone', 'andesite', 'diorite', 'granite', 'deepslate', 'cobbled_deepslate', 'tuff', 'blackstone'],
  tas: ['stone', 'cobblestone', 'andesite', 'diorite', 'granite', 'deepslate', 'cobbled_deepslate', 'tuff', 'blackstone'],
  stone: ['stone', 'cobblestone', 'andesite', 'diorite', 'granite', 'deepslate', 'cobbled_deepslate', 'tuff', 'blackstone'],
  rock: ['stone', 'cobblestone', 'andesite', 'diorite', 'granite', 'deepslate', 'cobbled_deepslate', 'tuff'],
  kaya: ['stone', 'cobblestone', 'andesite', 'diorite', 'granite', 'deepslate', 'tuff'],
  kum: ['sand', 'red_sand'], sand: ['sand', 'red_sand'],
  toprak: ['dirt', 'grass_block', 'coarse_dirt', 'podzol', 'rooted_dirt', 'mud', 'dirt_path'], dirt: ['dirt', 'grass_block', 'coarse_dirt', 'podzol', 'rooted_dirt'],
  çim: ['grass_block'], cim: ['grass_block'], grass: ['grass_block'],
  yaprak: (md) => names(md, /_leaves$/), leaves: (md) => names(md, /_leaves$/), leaf: (md) => names(md, /_leaves$/),
  cam: (md) => names(md, /(^glass$|_stained_glass$)/), glass: (md) => names(md, /(^glass$|_stained_glass$)/),
  yün: (md) => names(md, /_wool$/), yun: (md) => names(md, /_wool$/), wool: (md) => names(md, /_wool$/),
  tahta: (md) => names(md, /_planks$/), planks: (md) => names(md, /_planks$/),
  maden: (md) => [...names(md, /_ore$/), 'ancient_debris'], cevher: (md) => [...names(md, /_ore$/), 'ancient_debris'], ore: (md) => [...names(md, /_ore$/), 'ancient_debris'], ores: (md) => [...names(md, /_ore$/), 'ancient_debris'],
  çiçek: ['dandelion', 'poppy', 'azure_bluet', 'oxeye_daisy', 'cornflower', 'allium', 'blue_orchid', 'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip', 'lily_of_the_valley', 'sunflower', 'lilac', 'rose_bush', 'peony'],
  cicek: ['dandelion', 'poppy', 'azure_bluet', 'oxeye_daisy', 'cornflower', 'allium', 'blue_orchid', 'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip'], flower: ['dandelion', 'poppy', 'azure_bluet', 'oxeye_daisy', 'cornflower', 'allium', 'blue_orchid'],
  mantar: ['brown_mushroom', 'red_mushroom', 'brown_mushroom_block', 'red_mushroom_block'], mushroom: ['brown_mushroom', 'red_mushroom'],
  buz: ['ice', 'packed_ice', 'blue_ice'], ice: ['ice', 'packed_ice', 'blue_ice'], kar: ['snow', 'snow_block', 'powder_snow'], snow: ['snow', 'snow_block'],
  kumtaşı: ['sandstone', 'red_sandstone'], kumtasi: ['sandstone', 'red_sandstone'], sandstone: ['sandstone', 'red_sandstone'],
  bitki: ['short_grass', 'tall_grass', 'fern', 'large_fern'], şeker_kamışı: ['sugar_cane'], seker_kamisi: ['sugar_cane'], kamış: ['sugar_cane'],
  bambu: ['bamboo'], kaktüs: ['cactus'], kaktus: ['cactus'], balkabağı: ['pumpkin'], balkabagi: ['pumpkin'], karpuz: ['melon'], kil: ['clay'],
  buğday: ['wheat'], bugday: ['wheat'], havuç: ['carrots'], havuc: ['carrots'], patates: ['potatoes'], mercan: (md) => names(md, /coral/),
  nether: ['netherrack'], netherrack: ['netherrack'], ruh_kumu: ['soul_sand'], cam_levha: (md) => names(md, /glass_pane$/), tuğla: ['bricks', 'stone_bricks'], tugla: ['bricks', 'stone_bricks'],
}

function lev(a, b) {
  if (a === b) return 0
  const m = a.length
  const n = b.length
  if (!m) return n
  if (!n) return m
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[n]
}

// Adı en yakın geçerli kimliklere eşle: sondaki -s/-es, ön/son ek, içerme, yazım hatası (levenshtein)
function suggestNames(raw, all, limit = 4) {
  const n = String(raw).toLowerCase().replace(/[\s-]+/g, '_')
  const singular = n.replace(/(es|s)$/, '')
  const scored = []
  for (const k of all) {
    let sc = 99
    if (k === n || k === singular) sc = 0
    else if (k.startsWith(n) || k.endsWith('_' + n) || k.endsWith(n)) sc = 1 + (k.length - n.length) / 100
    else if (k.includes(n) || (singular.length > 2 && k.includes(singular))) sc = 2 + (k.length - n.length) / 100
    else {
      const d = Math.min(lev(n, k), lev(singular, k))
      if (d <= Math.max(1, Math.floor(n.length / 4))) sc = 3 + d
    }
    if (sc < 99) scored.push([sc, k])
  }
  return scored.sort((a, b) => a[0] - b[0]).slice(0, limit).map((x) => x[1])
}
const didYouMean = (raw, all) => { const s = suggestNames(raw, all); return s.length ? ` Şunu mu demek istedin: ${s.join(', ')}?` : '' }

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

const ITEM_SYNONYMS_EXTRA = {
  odun_kömürü: 'charcoal', çömlek: 'flower_pot', halat: 'lead', ip: 'string', iplik: 'string', kemik: 'bone', barut: 'gunpowder', deri: 'leather', kağıt: 'paper', kitap: 'book',
  yumurta: 'egg', süt: 'milk_bucket', sut: 'milk_bucket', şeker: 'sugar', seker: 'sugar', buğday: 'wheat', bugday: 'wheat', havuç: 'carrot', havuc: 'carrot', patates: 'potato',
  elma_altın: 'golden_apple', altın_elma: 'golden_apple', altin_elma: 'golden_apple', totem: 'totem_of_undying', ender_incisi: 'ender_pearl', pearl: 'ender_pearl', inci: 'ender_pearl',
  rüzgar_topu: 'wind_charge', ruzgar_topu: 'wind_charge', örümcek_ağı: 'cobweb', ag: 'cobweb', ağ: 'cobweb', gürz: 'mace', mizrak: 'spear', mızrak: 'spear', zırh: 'iron_chestplate',
  miğfer: 'iron_helmet', migfer: 'iron_helmet', göğüslük: 'iron_chestplate', gogusluk: 'iron_chestplate', pantolon: 'iron_leggings', bot: 'iron_boots', çizme: 'iron_boots', cizme: 'iron_boots',
  tohum: 'wheat_seeds', fidan: 'oak_sapling', kemik_tozu: 'bone_meal', elytra: 'elytra', roket: 'firework_rocket', havai_fişek: 'firework_rocket', tnt: 'tnt', merdiven: 'ladder',
  çit: 'oak_fence', cit: 'oak_fence', levha: 'oak_slab', basamak: 'oak_stairs', cam: 'glass', yün: 'white_wool', yun: 'white_wool', boya: 'white_dye', harita: 'map', pusula: 'compass', saat: 'clock',
  tüy: 'feather', tuy: 'feather', kömür_blok: 'coal_block', demir_külçe: 'iron_ingot', altın_külçe: 'gold_ingot', bakır: 'copper_ingot', bakir: 'copper_ingot', elmas_kazma: 'diamond_pickaxe',
}
for (const [k, v] of Object.entries(ITEM_SYNONYMS_EXTRA)) if (!ITEM_SYNONYMS[k]) ITEM_SYNONYMS[k] = v

const MOB_SYNONYMS = {
  zombiler: 'zombie', zombilere: 'zombie', iskeletler: 'skeleton', creeper: 'creeper', patlayıcı: 'creeper', sürüngen: 'creeper', enderman: 'enderman', balık: 'cod', balik: 'cod',
  ghast: 'ghast', blaze: 'blaze', piglin: 'piglin', golem: 'iron_golem', demir_golem: 'iron_golem', kurbağa: 'frog', kurbaga: 'frog', arı: 'bee', ari: 'bee', papağan: 'parrot', papagan: 'parrot',
  ahtapot: 'squid', yunus: 'dolphin', panda: 'panda', tilki: 'fox', keçi: 'goat', keci: 'goat', ayı: 'polar_bear', hostile: 'hostile', canavar: 'hostile', düşman: 'hostile', dusman: 'hostile',
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

// Modelin değişik şekillerde yazdığı eylem alanlarını standarda getir (params iç içe, [x,y,z] dizisi, amount/qty...)
function flattenAction(a) {
  let o = { ...a }
  for (const k of ['params', 'parameters', 'args', 'arguments', 'data', 'options', 'input']) {
    if (o[k] && typeof o[k] === 'object' && !Array.isArray(o[k])) { const inner = o[k]; delete o[k]; o = { ...inner, ...o } }
  }
  if (typeof o.type !== 'string' || !o.type) {
    const t = [o.action, o.act, o.kind, o.name].find((x) => typeof x === 'string' && x)
    if (t) o.type = t
  }
  for (const k of ['pos', 'position', 'coords', 'coordinates', 'location', 'at', 'xyz']) {
    const v = o[k]
    if (v === undefined || v === null) continue
    if (Array.isArray(v) && v.length >= 3) { if (o.x === undefined) { o.x = v[0]; o.y = v[1]; o.z = v[2] } }
    else if (typeof v === 'object' && (v.x !== undefined || v.z !== undefined)) { if (o.x === undefined) { o.x = v.x; o.y = v.y; o.z = v.z } }
    else if (typeof v === 'string') { const nums = v.match(/-?\d+(?:\.\d+)?/g); if (nums && nums.length >= 3 && o.x === undefined) { o.x = Number(nums[0]); o.y = Number(nums[1]); o.z = Number(nums[2]) } }
  }
  if (o.count === undefined) { const c = [o.amount, o.qty, o.quantity, o.number, o.n, o.times].find((x) => x !== undefined); if (c !== undefined) o.count = c }
  if (o.target === undefined) { const t = [o.player, o.user, o.username, o.who, o.entity, o.victim].find((x) => typeof x === 'string' && x); if (t) o.target = t }
  const res = [o.resource, o.material, o.thing, o.object].find((x) => typeof x === 'string' && x)
  if (res) { if (o.block === undefined) o.block = res; if (o.item === undefined) o.item = res }
  if (typeof o.name === 'string' && o.name && o.type !== 'set_home' && o.type !== 'go_home' && o.type !== 'custom' && o.type !== 'skill' && o.type !== 'schematic' && o.type !== 'download_schematic') {
    if (o.item === undefined) o.item = o.name
    if (o.block === undefined) o.block = o.name
  }
  if (typeof o.query !== 'string') { const q = [o.search, o.question, o.topic_query, o.q].find((x) => typeof x === 'string' && x); if (q) o.query = q }
  return o
}

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
      const fam = BLOCK_FAMILIES[n0]
      if (fam && !md.blocksByName[n0] || (fam && ['stone', 'dirt', 'sand', 'glass', 'planks', 'ice'].includes(n0))) {
        const list = (typeof fam === 'function' ? fam(md) : fam).filter((x) => md.blocksByName[x])
        const defsF = list.map((x) => md.blocksByName[x])
        if (defsF.length) return { defs: defsF, label: n0 }
      }
      const n = BLOCK_SYNONYMS[n0] || n0
      let def = md.blocksByName[n] || md.blocksByName[n.replace(/(es|s)$/, '')]
      if (!def) {
        const m = suggestNames(n, Object.keys(md.blocksByName), 1)
        if (m.length) def = md.blocksByName[m[0]]
      }
      if (!def) throw new Error(`"${raw}" geçerli bir Minecraft blok kimliği değil.${didYouMean(n, Object.keys(md.blocksByName))} (örn. oak_log, cobblestone, iron_ore)`)
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
      let def = md.itemsByName[n] || md.itemsByName[n.replace(/(es|s)$/, '')]
      if (!def) {
        const m = suggestNames(n, Object.keys(md.itemsByName), 1)
        if (m.length) def = md.itemsByName[m[0]]
      }
      if (!def) throw new Error(`"${raw}" geçerli bir Minecraft eşya kimliği değil.${didYouMean(n, Object.keys(md.itemsByName))} (örn. iron_sword, bread, cobblestone)`)
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
      const m = suggestNames(n, Object.keys(md.entitiesByName), 3)
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
    follow: (a) => ({ target: h.player(a.target), distance: h.int(a.distance, 2, 1, 10, 'distance'), sprint: !(a.sprint === false || a.sprint === 'false') }),
    goto_player: (a) => ({ target: h.player(a.target), distance: h.int(a.distance, 2, 1, 10, 'distance') }),
    turn: (a) => {
      let deg = a.degrees === undefined || a.degrees === '' ? 90 : h.num(a.degrees, 'degrees')
      let dir = normName(a.direction || (deg < 0 ? 'left' : 'right'))
      if (['sola', 'left', 'l'].includes(dir)) dir = 'left'
      else if (['saga', 'sağa', 'right', 'r'].includes(dir)) dir = 'right'
      else throw new Error('direction left/right olmalı')
      deg = Math.min(360, Math.abs(deg))
      return { direction: dir, degrees: deg, pitch: a.pitch === undefined || a.pitch === '' ? null : Math.max(-89, Math.min(89, h.num(a.pitch, 'pitch'))) }
    },
    face: (a) => {
      const MAP = { kuzey: 'north', guney: 'south', güney: 'south', dogu: 'east', doğu: 'east', bati: 'west', batı: 'west', yukari: 'up', yukarı: 'up', asagi: 'down', aşağı: 'down', ileri: 'forward', geri: 'back', arka: 'back', on: 'forward', ön: 'forward' }
      const d0 = normName(a.direction || a.target)
      const d = MAP[d0] || d0
      if (!['north', 'south', 'east', 'west', 'up', 'down', 'forward', 'back'].includes(d)) throw new Error('direction north/south/east/west/up/down/forward/back olmalı')
      return { direction: d }
    },
    look_around: (a) => ({ seconds: h.int(a.seconds, 6, 1, 60, 'seconds') }),
    walk: (a) => {
      const MAP = { ileri: 'forward', geri: 'back', sag: 'right', sağ: 'right', sol: 'left', saga: 'right', sağa: 'right', sola: 'left' }
      const d0 = normName(a.direction || 'forward')
      const d = MAP[d0] || d0
      if (!['forward', 'back', 'left', 'right'].includes(d)) throw new Error('direction forward/back/left/right olmalı')
      return { direction: d, blocks: h.int(a.blocks, 5, 1, 64, 'blocks'), sprint: a.sprint === true || a.sprint === 'true', sneak: a.sneak === true || a.sneak === 'true' }
    },
    flee: (a) => {
      const raw = a.from ?? a.target
      const n = normName(raw)
      if (!n || n === 'hostile' || n === 'hostiles' || n === 'dusman' || n === 'düşman') return { kind: 'hostile', name: 'hostile', blocks: h.int(a.blocks, 24, 8, 64, 'blocks'), seconds: h.int(a.seconds, 8, 2, 60, 'seconds') }
      const exact = h.exactPlayer(raw)
      if (exact) return { kind: 'player', name: exact, blocks: h.int(a.blocks, 24, 8, 64, 'blocks'), seconds: h.int(a.seconds, 8, 2, 60, 'seconds') }
      return { kind: 'mob', name: h.mob(raw), blocks: h.int(a.blocks, 24, 8, 64, 'blocks'), seconds: h.int(a.seconds, 8, 2, 60, 'seconds') }
    },
    circle: (a) => ({ target: h.player(a.target), radius: h.int(a.radius, 4, 2, 10, 'radius'), seconds: h.int(a.seconds, 15, 3, 120, 'seconds'), direction: normName(a.direction) === 'left' ? 'left' : 'right' }),
    emote: (a) => {
      const MAP = { selam: 'wave', el_salla: 'wave', wave: 'wave', nod: 'nod', evet: 'nod', shake: 'shake', hayir: 'shake', hayır: 'shake', dance: 'dance', dans: 'dance', crouch: 'crouch', comel: 'crouch', çömel: 'crouch' }
      const k = MAP[normName(a.kind || 'wave')]
      if (!k) throw new Error('kind wave/nod/shake/dance/crouch olmalı')
      return { kind: k }
    },
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
    collect: (a) => {
      let b = h.blocks(a.block || a.ore)
      // Tek bir ağaç türü istense bile (oak_log) herhangi bir odun kabul edilir: yakında o tür yoksa bot boşuna dolaşmasın
      if (b.defs.length === 1 && /_log$/.test(b.defs[0].name)) {
        b = { defs: Object.values(md.blocksByName).filter((x) => x.name.endsWith('_log') && !x.name.startsWith('stripped_')), label: 'odun' }
      }
      return { ...b, count: h.int(a.count, 8, 1, 512, 'count') }
    },
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
          throw new Error('komutu verene attack ile saldırılmaz; düello için duel eylemini kullan')
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
      const TOPICS = { recipe: 'recipe crafting ingredients', tarif: 'recipe crafting ingredients', mechanic: 'mechanics how it works', mekanik: 'mechanics how it works', redstone: 'redstone design tutorial', pvp: 'pvp combat tutorial', build: 'build tutorial guide', yapi: 'build tutorial guide', farm: 'farm design tutorial', mob: 'mob behavior drops spawning' }
      const topic = TOPICS[normName(a.topic || '')] || ''
      return { query: q.slice(0, 200), topic, deep: a.deep === true || a.deep === 'true' }
    },
    crystal_pvp: (a) => {
      const target = h.player(a.target)
      const friendly = target === ctx.senderPlayer || !!(inst.cfg.owner && target.toLowerCase() === inst.cfg.owner.toLowerCase())
      if (!friendly && !inst.cfg.allowPvp) throw new Error('oyunculara saldırı kapalı (panelden aç)')
      if (!onlinePlayers().includes(target)) throw new Error(`"${a.target}" adlı oyuncu çevrimiçi değil`)
      return { target, friendly, seconds: h.int(a.seconds, 120, 10, 600, 'seconds') }
    },
    duel: (a) => {
      const target = h.player(a.target)
      if (!onlinePlayers().includes(target)) throw new Error(`"${target}" adlı oyuncu çevrimiçi değil`)
      // Komutu veren / sahip kendi isteğiyle düello yapıyorsa panel izni gerekmez; başkasına saldırı için gerekir
      const friendly = target === ctx.senderPlayer || !!(inst.cfg.owner && target.toLowerCase() === inst.cfg.owner.toLowerCase())
      if (!friendly && !inst.cfg.allowPvp) throw new Error('başka oyunculara saldırı kapalı (panelden "Oyunculara saldırı"yı aç)')
      const raw = normName(a.style || 'auto').replace(/[\s-]+/g, '_')
      const STYLE = {
        sword: 'sword', kilic: 'sword', kılıç: 'sword', axe: 'axe', balta: 'axe', sword_axe: 'sword',
        mace: 'mace', spear: 'spear', mizrak: 'spear', mızrak: 'spear',
        pot: 'pot', net_pot: 'pot', netherite_pot: 'pot', nethpot: 'pot', nethpvp: 'pot', potion: 'pot',
        uhc: 'uhc', smp: 'smp', diamond_smp: 'smp', crystal: 'crystal', kristal: 'crystal', cpvp: 'crystal',
        elytra_mace: 'elytra_mace', eltyra_mace: 'elytra_mace', elytra: 'elytra_mace', auto: 'auto',
      }
      return { target, friendly, style: STYLE[raw] || 'auto', seconds: h.int(a.seconds, 120, 10, 900, 'seconds') }
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
        if (best) auto = best[0]   // yetmezse inşa sırasında envanterdeki diğer bloklarla tamamlanır
      }
      // Bilinmeyen blok adı evi iptal etmesin: otomatik/varsayılan bloğa düş
      const pick = (v, def) => { if (!v) return h.placeable(def); try { return h.placeable(v) } catch (e) { return h.placeable(def) } }
      const W = a.wall || auto || 'oak_planks'
      return {
        size,
        wall: pick(W, auto || 'oak_planks'), floor: pick(a.floor || auto || a.wall || 'cobblestone', auto || 'cobblestone'), roof: pick(a.roof || auto || a.wall || 'oak_planks', auto || 'oak_planks'),
        glass: h.placeable(a.glass || 'glass'), door: h.placeable(a.door || 'oak_door'), offset: h.int(a.offset, 2, 1, 16, 'offset'),
      }
    },
    custom: (a) => {
      const name = String(a.name || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32)
      let rawSteps = a.steps
      if (!Array.isArray(rawSteps) || !rawSteps.length) {
        const m = inst.macros && inst.macros[name]
        if (!m) throw new Error('custom için steps dizisi ver (ya da kayıtlı makro adını yaz)')
        rawSteps = m.steps
      }
      const budget = { n: 0 }
      const num = (v, def, min, max, label) => h.int(v, def, min, max, label)
      const ITEM = (v) => h.item(v, true).name
      const normSteps = (list, depth) => {
        if (!Array.isArray(list)) throw new Error('steps/then/else dizi olmalı')
        if (depth > 3) throw new Error('iç içe adım derinliği en fazla 3')
        return list.map((st) => {
          if (!st || typeof st !== 'object') throw new Error('adım nesne olmalı')
          if (++budget.n > 60) throw new Error('en fazla 60 adım yazılabilir')
          const op = normName(st.op)
          switch (op) {
            case 'equip': return { op, item: ITEM(st.item), slot: ['hand', 'off-hand', 'head', 'torso', 'legs', 'feet'].includes(st.slot) ? st.slot : 'hand' }
            case 'use': return { op, item: st.item ? ITEM(st.item) : null, hold: num(st.hold ?? st.ms, 0, 0, 4000, 'hold') }
            case 'use_on': {
              const rel = st.dx !== undefined || st.dy !== undefined || st.dz !== undefined
              return rel ? { op, rel: true, x: num(st.dx, 0, -8, 8, 'dx'), y: num(st.dy, 0, -8, 8, 'dy'), z: num(st.dz, 0, -8, 8, 'dz') }
                : { op, rel: false, x: num(st.x, undefined, -30000000, 30000000, 'x'), y: num(st.y, undefined, -64, 320, 'y'), z: num(st.z, undefined, -30000000, 30000000, 'z') }
            }
            case 'look': {
              const at = normName(st.at || 'down')
              if (at === 'down' || at === 'up') return { op, at }
              if (at === 'coord') return { op, at, x: num(st.x, undefined, -30000000, 30000000, 'x'), y: num(st.y, undefined, -64, 320, 'y'), z: num(st.z, undefined, -30000000, 30000000, 'z') }
              if (at === 'mob') return { op, at, name: h.mob(st.name) }
              return { op, at: 'player', name: st.name ? h.player(st.name) : 'sender' }
            }
            case 'control': {
              const state = normName(st.state)
              if (!['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'].includes(state)) throw new Error('control state forward/back/left/right/jump/sprint/sneak olmalı')
              return { op, state, on: !(st.on === false || st.on === 'false'), ms: num(st.ms, 0, 0, 5000, 'ms') }
            }
            case 'wait': return { op, ms: num(st.ms, 500, 50, 10000, 'ms') }
            case 'say': case 'chat': return { op: 'say', message: String(st.message || '').slice(0, 200) }
            case 'action': {
              const inner = st.action
              if (!inner || typeof inner !== 'object') throw new Error('action adımında action nesnesi gerekli')
              if (normName(inner.type) === 'custom' || TYPE_ALIASES[normName(inner.type)] === 'custom') throw new Error('custom içinde custom çağrılamaz')
              const v = validateActions(inst, [inner], ctx)
              if (v.errors.length) throw new Error(v.errors.join(' | '))
              return { op, action: v.out[0], optional: st.optional === true }
            }
            case 'repeat': return { op, times: num(st.times, 1, 1, 20, 'times'), steps: normSteps(st.steps, depth + 1) }
            case 'if': {
              const c = st.cond || {}
              const kind = normName(c.kind)
              if (!['health_below', 'health_above', 'food_below', 'has_item', 'no_item', 'on_ground'].includes(kind)) throw new Error('cond.kind geçersiz')
              const cond = { kind }
              if (kind === 'has_item' || kind === 'no_item') cond.item = ITEM(c.item)
              else if (kind !== 'on_ground') cond.value = num(c.value, 10, 0, 20, 'value')
              return { op, cond, then: normSteps(st.then || [], depth + 1), else: normSteps(st.else || [], depth + 1) }
            }
            default: throw new Error(`bilinmeyen op "${st.op}" (equip, use, use_on, look, control, wait, say, action, repeat, if)`)
          }
        })
      }
      const steps = normSteps(rawSteps, 0)
      return { name: name || 'gecici', desc: String(a.desc || '').slice(0, 100), steps, save: a.save !== false && !!name && Array.isArray(a.steps) }
    },
    chop_tree: (a) => ({ count: h.int(a.count, 1, 1, 20, 'count') }),
    plant: (a) => ({ item: h.item(a.item || 'wheat_seeds', true), radius: h.int(a.radius, 8, 2, 24, 'radius'), count: h.int(a.count, 8, 1, 64, 'count') }),
    bone_meal: (a) => ({ radius: h.int(a.radius, 8, 2, 24, 'radius'), count: h.int(a.count, 10, 1, 64, 'count') }),
    redstone: (a) => {
      const kind = { line: 'line', hat: 'line', lamp: 'lamp', lamba: 'lamp', pressure_door: 'pressure_door', door: 'pressure_door', kapı: 'pressure_door', kapi: 'pressure_door', plate_door: 'pressure_door' }[normName(a.kind || 'line')]
      if (!kind) throw new Error('kind line / lamp / pressure_door olmalı')
      return { kind, length: h.int(a.length, 10, 1, 40, 'length'), offset: h.int(a.offset, 2, 1, 16, 'offset') }
    },
    bridge: (a) => ({ blocks: h.int(a.blocks, 10, 1, 64, 'blocks'), item: a.item ? h.placeable(a.item) : null }),
    pillar_up: (a) => ({ height: h.int(a.height, 6, 1, 40, 'height'), item: a.item ? h.placeable(a.item) : null }),
    throw_item: (a) => {
      const item = h.item(a.item || 'ender_pearl', true)
      const count = h.int(a.count, 1, 1, 16, 'count')
      if (a.target !== undefined && a.target !== null && a.target !== '') return { item, count, kind: 'player', name: h.player(a.target) }
      if (a.x !== undefined && a.z !== undefined) return { item, count, kind: 'pos', ...h.coord(a) }
      return { item, count, kind: 'forward' }
    },
    bucket: (a) => {
      const mode = normName(a.mode || 'place') === 'pickup' || normName(a.mode) === 'fill' ? 'pickup' : 'place'
      const fluid = normName(a.fluid || 'water') === 'lava' ? 'lava' : 'water'
      const hasPos = a.x !== undefined && a.z !== undefined
      return { mode, fluid, ...(hasPos ? h.coord(a) : { x: null, y: null, z: null }) }
    },
    light_area: (a) => ({ radius: h.int(a.radius, 12, 4, 32, 'radius'), spacing: h.int(a.spacing, 5, 3, 10, 'spacing'), max: h.int(a.max, 30, 1, 100, 'max') }),
    patrol: (a) => {
      if (!Array.isArray(a.points) || a.points.length < 1) throw new Error('points dizisi gerekli: [{"x":0,"z":0}, ...]')
      if (a.points.length > 8) throw new Error('en fazla 8 nokta')
      return { points: a.points.map((p) => ({ x: h.num(p.x, 'x'), z: h.num(p.z, 'z') })), loops: h.int(a.loops, 1, 1, 20, 'loops'), seconds: h.int(a.seconds, 180, 10, 600, 'seconds') }
    },
    shield: (a) => ({ seconds: h.int(a.seconds, 5, 1, 60, 'seconds') }),
    drop_junk: (a) => ({ keep: h.int(a.keep, 0, 0, 64, 'keep'), items: Array.isArray(a.items) ? a.items.slice(0, 20).map((x) => h.item(x, true).name) : null }),
    armor: () => ({}),
    build_shape: (a) => {
      const MAP = { duvar: 'wall', kule: 'tower', piramit: 'pyramid', merdiven: 'stairs', zemin: 'platform', platform: 'platform', daire: 'circle', kup: 'cube', küp: 'cube' }
      const s0 = normName(a.shape)
      const shape = MAP[s0] || s0
      if (!['wall', 'tower', 'pyramid', 'stairs', 'platform', 'circle', 'cube'].includes(shape)) throw new Error('shape wall/tower/pyramid/stairs/platform/circle/cube olmalı')
      const width = h.int(a.width ?? a.size, 5, 1, 21, 'width')
      const height = h.int(a.height, 4, 1, 24, 'height')
      const length = h.int(a.length, width, 1, 21, 'length')
      const item = h.placeable(a.block || a.item || 'cobblestone')
      return { shape, item, width, height, length, offset: h.int(a.offset, 2, 1, 16, 'offset') }
    },
    skill: (a) => {
      if (!Skills) throw new Error('skills.js yüklenemedi')
      const steps = Skills.resolve(a.name, a.count)
      if (!steps) throw new Error(`"${a.name}" adlı yetenek yok. Kalıplar: ${Skills.PATTERNS}`)
      const r = N.custom({ name: String(a.name).slice(0, 30), desc: String(a.name).slice(0, 60), save: false, steps: steps.map((x) => ({ op: 'action', action: x })) })
      return { ...r, save: false, long: true }
    },
    wait: (a) => ({ seconds: h.int(a.seconds, 3, 1, 120, 'seconds') }),
  }

  if (rawActions === undefined || rawActions === null) return { out, errors }
  if (!Array.isArray(rawActions)) return { out, errors: ['"actions" bir dizi (array) olmalı.'] }
  if (rawActions.length > MAX_ACTIONS) errors.push(`En fazla ${MAX_ACTIONS} eylem verilebilir, fazlası atıldı.`)

  rawActions.slice(0, MAX_ACTIONS).forEach((a0, i) => {
    const tag = `eylem #${i + 1}`
    if (!a0 || typeof a0 !== 'object' || Array.isArray(a0)) { errors.push(`${tag}: nesne olmalı.`); return }
    const a = flattenAction(a0)
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
