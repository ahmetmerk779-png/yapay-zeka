'use strict'
// Hazır yetenek kütüphanesi: isimden kalıpla (gather_iron, get_iron_pickaxe, house_small_oak_planks ...)
// mevcut eylemlerden oluşan zincirler üretir. Yeni mekanik değil, hazır kompozisyondur; zincirin
// bir adımı başarısız olursa durur ve sebebini söyler. Her adım normal doğrulamadan geçer.

const act = (type, extra = {}) => ({ type, ...extra })

// ---- toplama: isim -> [blok, 'collect'|'mine', varsayılan adet]
const GATHER = {
  wood: ['oak_log', 'collect', 8], oak: ['oak_log', 'collect', 8], spruce: ['spruce_log', 'collect', 8], birch: ['birch_log', 'collect', 8],
  jungle: ['jungle_log', 'collect', 8], acacia: ['acacia_log', 'collect', 8], dark_oak: ['dark_oak_log', 'collect', 8], cherry: ['cherry_log', 'collect', 8], mangrove: ['mangrove_log', 'collect', 8],
  stone: ['stone', 'collect', 16], cobblestone: ['cobblestone', 'collect', 16], dirt: ['dirt', 'collect', 16], sand: ['sand', 'collect', 16], red_sand: ['red_sand', 'collect', 16],
  gravel: ['gravel', 'collect', 16], clay: ['clay', 'collect', 16], sandstone: ['sandstone', 'collect', 16], granite: ['granite', 'collect', 16], diorite: ['diorite', 'collect', 16],
  andesite: ['andesite', 'collect', 16], tuff: ['tuff', 'collect', 16], calcite: ['calcite', 'collect', 8], deepslate: ['deepslate', 'collect', 16], cobbled_deepslate: ['cobbled_deepslate', 'collect', 16],
  netherrack: ['netherrack', 'collect', 16], soul_sand: ['soul_sand', 'collect', 8], soul_soil: ['soul_soil', 'collect', 8], basalt: ['basalt', 'collect', 16], blackstone: ['blackstone', 'collect', 16],
  glowstone: ['glowstone', 'collect', 8], obsidian: ['obsidian', 'collect', 10], end_stone: ['end_stone', 'collect', 16], sugar_cane: ['sugar_cane', 'collect', 16], bamboo: ['bamboo', 'collect', 16],
  cactus: ['cactus', 'collect', 8], kelp: ['kelp', 'collect', 16], pumpkin: ['pumpkin', 'collect', 4], melon: ['melon', 'collect', 8], brown_mushroom: ['brown_mushroom', 'collect', 4],
  red_mushroom: ['red_mushroom', 'collect', 4], vine: ['vine', 'collect', 8], hay_block: ['hay_block', 'collect', 4], snow: ['snow_block', 'collect', 8], ice: ['ice', 'collect', 8],
  coal: ['coal_ore', 'mine', 16], iron: ['iron_ore', 'mine', 10], copper: ['copper_ore', 'mine', 16], gold: ['gold_ore', 'mine', 8], redstone: ['redstone_ore', 'mine', 16],
  lapis: ['lapis_ore', 'mine', 12], diamond: ['diamond_ore', 'mine', 5], emerald: ['emerald_ore', 'mine', 3], quartz: ['nether_quartz_ore', 'mine', 16],
  ancient_debris: ['ancient_debris', 'mine', 4], nether_gold: ['nether_gold_ore', 'mine', 16],
}

const MATS = ['wooden', 'stone', 'iron', 'golden', 'diamond']
const TOOLS = { pickaxe: 3, axe: 3, shovel: 1, hoe: 2, sword: 2 }
const PIECES = { helmet: 5, chestplate: 8, leggings: 7, boots: 4 }
const ARMOR_MATS = ['iron', 'golden', 'diamond']
const SHAPES = ['wall', 'tower', 'pyramid', 'stairs', 'platform', 'circle', 'cube']
const ANIMALS = ['cow', 'pig', 'chicken', 'sheep', 'rabbit', 'horse', 'cod', 'salmon', 'squid']
const RAW = ['beef', 'porkchop', 'chicken', 'mutton', 'rabbit', 'cod', 'salmon', 'potato', 'kelp', 'iron_ore', 'raw_iron', 'raw_gold', 'raw_copper', 'sand', 'cobblestone', 'clay_ball', 'netherrack', 'cactus', 'oak_log']
const STYLES = ['sword', 'axe', 'mace', 'spear', 'pot', 'uhc', 'smp', 'crystal', 'elytra_mace', 'auto']
const DIRS8 = ['north', 'south', 'east', 'west', 'up', 'down', 'forward', 'back']
const EMOTES = ['wave', 'nod', 'shake', 'dance', 'crouch']
const SIZES = ['small', 'medium', 'large']
const BUILD_MATS = ['cobblestone', 'oak_planks', 'spruce_planks', 'birch_planks', 'stone_bricks', 'bricks', 'sandstone', 'deepslate_bricks', 'dirt', 'glass']

// ---- araç zincirleri
const woodPhase = () => [act('collect', { block: 'oak_log', count: 6 }), act('craft', { item: 'oak_planks', count: 20 }), act('craft', { item: 'stick', count: 8 }), act('craft', { item: 'crafting_table', count: 1 })]
const toWoodenPickaxe = () => [...woodPhase(), act('craft', { item: 'wooden_pickaxe', count: 1 })]
const toStonePickaxe = () => [...toWoodenPickaxe(), act('collect', { block: 'cobblestone', count: 14 }), act('craft', { item: 'stone_pickaxe', count: 1 }), act('craft', { item: 'furnace', count: 1 })]
const smeltPhase = (raw, n) => [act('mine', { block: 'coal_ore', count: 2 }), act('smelt', { item: raw, count: n })]
const toIronPickaxe = () => [...toStonePickaxe(), act('mine', { block: 'iron_ore', count: 3 }), ...smeltPhase('raw_iron', 3), act('craft', { item: 'iron_pickaxe', count: 1 })]

function toolChain(mat, tool) {
  const n = TOOLS[tool]
  const out = `${mat}_${tool}`
  if (mat === 'wooden') return [...woodPhase(), act('craft', { item: out, count: 1 })]
  if (mat === 'stone') return [...toWoodenPickaxe(), act('collect', { block: 'cobblestone', count: n + 2 }), act('craft', { item: out, count: 1 })]
  if (mat === 'iron') return [...toStonePickaxe(), act('mine', { block: 'iron_ore', count: n }), ...smeltPhase('raw_iron', n), act('craft', { item: out, count: 1 })]
  if (mat === 'golden') return [...toIronPickaxe(), act('mine', { block: 'gold_ore', count: n }), ...smeltPhase('raw_gold', n), act('craft', { item: out, count: 1 })]
  return [...toIronPickaxe(), act('mine', { block: 'diamond_ore', count: n }), act('craft', { item: out, count: 1 })]   // diamond
}
function armorChain(mat, piece) {
  const pieces = piece === 'armor_set' ? Object.keys(PIECES) : [piece]
  const n = pieces.reduce((s, p) => s + PIECES[p], 0)
  const out = []
  if (mat === 'diamond') out.push(...toIronPickaxe(), act('mine', { block: 'diamond_ore', count: n }))
  else if (mat === 'golden') out.push(...toIronPickaxe(), act('mine', { block: 'gold_ore', count: n }), ...smeltPhase('raw_gold', n))
  else out.push(...toStonePickaxe(), act('mine', { block: 'iron_ore', count: n }), ...smeltPhase('raw_iron', n))
  pieces.forEach((p) => out.push(act('craft', { item: `${mat}_${p}`, count: 1 })))
  out.push(act('armor'))
  return out
}

// Kalıp -> adımlar (ham eylem nesneleri) ya da null
function resolve(rawName, count) {
  const name = String(rawName || '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  const n = Number.isFinite(Number(count)) && Number(count) > 0 ? Math.round(Number(count)) : null
  let m

  if ((m = name.match(/^gather_(.+?)(?:_(\d+))?$/)) && GATHER[m[1]]) {
    const [block, kind, def] = GATHER[m[1]]
    return [act(kind, { block, count: Number(m[2]) || n || def })]
  }
  if ((m = name.match(/^craft_(.+?)(?:_(\d+))?$/))) return [act('craft', { item: m[1], count: Number(m[2]) || n || 1 })]
  if ((m = name.match(/^get_(wooden|stone|iron|golden|diamond)_(pickaxe|axe|shovel|hoe|sword)$/))) return toolChain(m[1], m[2])
  if ((m = name.match(/^get_(iron|golden|diamond)_(helmet|chestplate|leggings|boots|armor_set)$/))) return armorChain(m[1], m[2])
  if ((m = name.match(/^house_(small|medium|large)_(.+)$/))) return [act('house', { size: m[1], wall: m[2], floor: m[2], roof: m[2] })]
  if ((m = name.match(/^build_(wall|tower|pyramid|stairs|platform|circle|cube)_(.+)$/))) return [act('build_shape', { shape: m[1], block: m[2], width: 5, height: 5 })]
  if ((m = name.match(/^hunt_(.+?)(?:_(\d+))?$/))) {
    const animal = m[1]
    const cnt = Number(m[2]) || n || 3
    return [act('attack', { target: animal, count: cnt }), act('pickup', { radius: 14 })]
  }
  if ((m = name.match(/^cook_(.+?)(?:_(\d+))?$/))) return [act('smelt', { item: m[1] === 'beef' ? 'beef' : m[1], count: Number(m[2]) || n || 8 })]
  if ((m = name.match(/^duel_(.+)$/))) return [act('duel', { target: 'sender', style: m[1], seconds: 120 })]
  if ((m = name.match(/^face_(.+)$/))) return [act('face', { direction: m[1] })]
  if ((m = name.match(/^turn_(left|right)_(\d+)$/))) return [act('turn', { direction: m[1], degrees: Number(m[2]) })]
  if ((m = name.match(/^walk_(forward|back|left|right)_(\d+)$/))) return [act('walk', { direction: m[1], blocks: Number(m[2]) })]
  if ((m = name.match(/^emote_(.+)$/))) return [act('emote', { kind: m[1] })]
  if ((m = name.match(/^plant_(.+)$/))) return [act('plant', { item: m[1], radius: 8, count: n || 8 })]
  if ((m = name.match(/^throw_(.+)$/))) return [act('throw_item', { item: m[1], target: 'sender', count: n || 1 })]
  if ((m = name.match(/^chop_trees?_(\d+)$/))) return [act('chop_tree', { count: Number(m[1]) })]
  if ((m = name.match(/^guard_(\d+)$/))) return [act('guard', { radius: Number(m[1]) })]
  if ((m = name.match(/^bridge_(\d+)$/))) return [act('bridge', { blocks: Number(m[1]) })]
  if ((m = name.match(/^tower_(\d+)$/))) return [act('pillar_up', { height: Number(m[1]) })]
  if ((m = name.match(/^light_up_(\d+)$/))) return [act('light_area', { radius: Number(m[1]) })]
  const FIXED = {
    cleanup: [act('drop_junk')], wear_armor: [act('armor')], eat_best: [act('eat')], harvest_all: [act('farm', { radius: 16 })],
    hunt_hostile: [act('attack', { target: 'hostile', count: n || 5 })], flee_hostile: [act('flee', { from: 'hostile' })],
    look_around: [act('look_around', { seconds: 6 })], shield_up: [act('shield', { seconds: 8 })], water_pickup: [act('bucket', { mode: 'pickup', fluid: 'water' })],
    water_place: [act('bucket', { mode: 'place', fluid: 'water' })], lava_pickup: [act('bucket', { mode: 'pickup', fluid: 'lava' })], bone_all: [act('bone_meal', { radius: 10, count: 20 })],
    go_home: [act('go_home', { name: 'home' })], set_home: [act('set_home', { name: 'home' })], sleep_now: [act('sleep')], loot_chest: [act('inspect_chest')],
  }
  return FIXED[name] || null
}

// Kaç farklı yetenek adı üretilebiliyor (dokümantasyon / test için)
function catalog() {
  const names = []
  Object.keys(GATHER).forEach((k) => names.push(`gather_${k}`))
  MATS.forEach((mt) => Object.keys(TOOLS).forEach((t) => names.push(`get_${mt}_${t}`)))
  ARMOR_MATS.forEach((mt) => [...Object.keys(PIECES), 'armor_set'].forEach((p) => names.push(`get_${mt}_${p}`)))
  SIZES.forEach((s) => BUILD_MATS.forEach((b) => names.push(`house_${s}_${b}`)))
  SHAPES.forEach((s) => BUILD_MATS.forEach((b) => names.push(`build_${s}_${b}`)))
  ANIMALS.forEach((a) => names.push(`hunt_${a}`))
  RAW.forEach((r) => names.push(`cook_${r}`))
  STYLES.forEach((s) => names.push(`duel_${s}`))
  DIRS8.forEach((d) => names.push(`face_${d}`))
  ;['left', 'right'].forEach((s) => [30, 45, 90, 135, 180, 270].forEach((d) => names.push(`turn_${s}_${d}`)))
  ;['forward', 'back', 'left', 'right'].forEach((s) => [3, 5, 10, 20, 40].forEach((d) => names.push(`walk_${s}_${d}`)))
  EMOTES.forEach((e) => names.push(`emote_${e}`))
  ;[1, 3, 5, 10].forEach((c) => names.push(`chop_tree_${c}`))
  ;[8, 16, 32].forEach((c) => { names.push(`guard_${c}`); names.push(`bridge_${c}`); names.push(`tower_${c}`); names.push(`light_up_${c}`) })
  names.push('cleanup', 'wear_armor', 'eat_best', 'harvest_all', 'hunt_hostile', 'flee_hostile', 'look_around', 'shield_up', 'water_pickup', 'water_place', 'lava_pickup', 'bone_all', 'go_home', 'set_home', 'sleep_now', 'loot_chest')
  return names
}

const PATTERNS = 'gather_<kaynak>[_adet] (gather_iron, gather_sand, gather_diamond), craft_<eşya>[_adet], get_<wooden|stone|iron|golden|diamond>_<pickaxe|axe|shovel|hoe|sword>, get_<iron|golden|diamond>_<helmet|chestplate|leggings|boots|armor_set>, house_<small|medium|large>_<blok>, build_<wall|tower|pyramid|stairs|platform|circle|cube>_<blok>, hunt_<hayvan>[_adet], cook_<çiğ_eşya>, duel_<stil>, face_<yön>, turn_<left|right>_<derece>, walk_<yön>_<blok>, emote_<tür>, plant_<eşya>, throw_<eşya>, chop_tree_<n>, guard_<r>, bridge_<n>, tower_<n>, light_up_<r>, cleanup, wear_armor, eat_best, harvest_all, hunt_hostile, flee_hostile, look_around, shield_up, water_pickup, water_place, bone_all'

module.exports = { resolve, catalog, PATTERNS }
