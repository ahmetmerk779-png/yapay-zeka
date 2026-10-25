'use strict'
// Şematik dosyalarını okur (.schem Sponge v2/v3, .litematic, yapı bloğu .nbt),
// döndürür, malzeme listesini çıkarır ve /setblock-/fill komutlarına derler.

const fs = require('fs')
const path = require('path')
const nbt = require('prismarine-nbt')

const SCHEM_DIR = process.env.SCHEMATIC_DIR || path.join(__dirname, '..', 'schematics')
const EXTS = ['.schem', '.litematic', '.nbt', '.schematic']
const MAX_FILE_BYTES = 20 * 1024 * 1024
const MAX_BLOCKS = 300000

const SKIP_BLOCKS = new Set(['air', 'cave_air', 'void_air', 'structure_void', 'jigsaw', 'structure_block', 'barrier', 'light'])
const NO_ITEM = new Set(['water', 'lava', 'fire', 'soul_fire', 'moving_piston', 'piston_head', 'nether_portal', 'end_portal', 'end_gateway', 'bubble_column', 'frosted_ice', 'tall_seagrass_top'])

const FACING_CW = { north: 'east', east: 'south', south: 'west', west: 'north' }

// ------------------------------------------------------------------ dosya yönetimi
function ensureDir() { fs.mkdirSync(SCHEM_DIR, { recursive: true }) }

function sanitizeName(name) {
  const base = path.basename(String(name || '')).replace(/[^\w.\- ()]/g, '_')
  const ext = path.extname(base).toLowerCase()
  if (!EXTS.includes(ext)) throw new Error(`desteklenmeyen uzantı "${ext}". Desteklenenler: ${EXTS.join(', ')}`)
  if (base.length < 3 || base.length > 100) throw new Error('dosya adı çok kısa/uzun')
  return base
}

function listFiles() {
  ensureDir()
  return fs.readdirSync(SCHEM_DIR)
    .filter((f) => EXTS.includes(path.extname(f).toLowerCase()))
    .map((f) => ({ name: f, size: fs.statSync(path.join(SCHEM_DIR, f)).size }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

// "ev", "Ev.schem", "EV.SCHEM" gibi girdileri gerçek dosyaya eşle
function resolveFile(input) {
  const files = listFiles().map((f) => f.name)
  const q = String(input || '').trim().toLowerCase()
  if (!q) return null
  const exact = files.find((f) => f.toLowerCase() === q)
  if (exact) return exact
  const noExt = files.filter((f) => path.basename(f, path.extname(f)).toLowerCase() === q)
  if (noExt.length === 1) return noExt[0]
  const part = files.filter((f) => f.toLowerCase().includes(q))
  return part.length === 1 ? part[0] : null
}

function saveFile(name, buffer) {
  ensureDir()
  if (buffer.length > MAX_FILE_BYTES) throw new Error('dosya 20 MB sınırını aşıyor')
  const safe = sanitizeName(name)
  fs.writeFileSync(path.join(SCHEM_DIR, safe), buffer)
  return safe
}

function deleteFile(name) {
  const f = resolveFile(name)
  if (!f) throw new Error('dosya bulunamadı')
  fs.unlinkSync(path.join(SCHEM_DIR, f))
  return f
}

// ------------------------------------------------------------------ ayrıştırma
function parseBlockString(s) {
  const m = String(s).match(/^([^\[]+)(?:\[(.*)\])?$/)
  const name = m[1].replace(/^minecraft:/, '')
  const props = {}
  if (m[2]) m[2].split(',').forEach((kv) => { const [k, v] = kv.split('='); if (k) props[k.trim()] = (v || '').trim() })
  return { name, props }
}

function pushBlock(out, x, y, z, name, props) {
  if (SKIP_BLOCKS.has(name)) return
  out.push({ x, y, z, name, props: props || {} })
  if (out.length > MAX_BLOCKS) throw new Error(`şematik çok büyük (${MAX_BLOCKS} bloktan fazla)`)
}

function decodeVarints(bytes, expected) {
  const out = new Array(expected)
  let n = 0
  let value = 0
  let shift = 0
  for (let i = 0; i < bytes.length && n < expected; i++) {
    const b = bytes[i] & 0xff
    value |= (b & 0x7f) << shift
    if (b & 0x80) { shift += 7; if (shift > 35) throw new Error('bozuk varint verisi') } else { out[n++] = value; value = 0; shift = 0 }
  }
  if (n !== expected) throw new Error(`blok verisi eksik (${n}/${expected})`)
  return out
}

function parseSponge(d) {
  if (d.Schematic) d = d.Schematic
  const W = d.Width, H = d.Height, L = d.Length
  const pal = (d.Blocks && d.Blocks.Palette) || d.Palette
  const data = (d.Blocks && d.Blocks.Data) || d.BlockData
  if (!W || !H || !L || !pal || !data) throw new Error('Sponge .schem alanları eksik')
  const inv = []
  for (const [str, id] of Object.entries(pal)) inv[id] = parseBlockString(str)
  const ids = decodeVarints(data, W * H * L)
  const blocks = []
  for (let y = 0; y < H; y++) {
    for (let z = 0; z < L; z++) {
      for (let x = 0; x < W; x++) {
        const b = inv[ids[(y * L + z) * W + x]]
        if (b) pushBlock(blocks, x, y, z, b.name, b.props)
      }
    }
  }
  return { size: { x: W, y: H, z: L }, blocks }
}

function parseStructureNbt(d) {
  const size = d.size
  const palette = d.palette || (d.palettes && d.palettes[0])
  if (!size || !palette || !d.blocks) throw new Error('yapı .nbt alanları eksik')
  const blocks = []
  for (const b of d.blocks) {
    const p = palette[b.state]
    if (!p) continue
    const props = {}
    if (p.Properties) for (const [k, v] of Object.entries(p.Properties)) props[k] = String(v)
    pushBlock(blocks, b.pos[0], b.pos[1], b.pos[2], String(p.Name).replace(/^minecraft:/, ''), props)
  }
  return { size: { x: size[0], y: size[1], z: size[2] }, blocks }
}

function longToBig(pair) {
  return (BigInt(pair[0] >>> 0) << 32n) | BigInt(pair[1] >>> 0)   // [hi, lo], işaretsiz
}

function parseLitematic(d) {
  if (!d.Regions) throw new Error('litematic Regions alanı yok')
  const all = []
  for (const region of Object.values(d.Regions)) {
    const sx = region.Size.x, sy = region.Size.y, sz = region.Size.z
    const ax = Math.abs(sx), ay = Math.abs(sy), az = Math.abs(sz)
    const ox = region.Position.x + (sx < 0 ? sx + 1 : 0)
    const oy = region.Position.y + (sy < 0 ? sy + 1 : 0)
    const oz = region.Position.z + (sz < 0 ? sz + 1 : 0)
    const pal = region.BlockStatePalette.map((p) => {
      const props = {}
      if (p.Properties) for (const [k, v] of Object.entries(p.Properties)) props[k] = String(v)
      return { name: String(p.Name).replace(/^minecraft:/, ''), props }
    })
    const bits = Math.max(2, Math.ceil(Math.log2(pal.length)))
    const mask = (1n << BigInt(bits)) - 1n
    const longs = region.BlockStates.map(longToBig)
    for (let y = 0; y < ay; y++) {
      for (let z = 0; z < az; z++) {
        for (let x = 0; x < ax; x++) {
          const i = (y * az + z) * ax + x
          const start = i * bits
          const idx = Math.floor(start / 64)
          const off = BigInt(start % 64)
          let v = longs[idx] >> off
          if (Number(off) + bits > 64 && longs[idx + 1] !== undefined) v |= longs[idx + 1] << (64n - off)
          const p = pal[Number(v & mask)]
          if (p) all.push({ x: ox + x, y: oy + y, z: oz + z, name: p.name, props: p.props })
        }
      }
    }
  }
  if (!all.length) throw new Error('litematic boş')
  const minX = Math.min(...all.map((b) => b.x)), minY = Math.min(...all.map((b) => b.y)), minZ = Math.min(...all.map((b) => b.z))
  const blocks = []
  let maxX = 0, maxY = 0, maxZ = 0
  for (const b of all) {
    const x = b.x - minX, y = b.y - minY, z = b.z - minZ
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z)
    pushBlock(blocks, x, y, z, b.name, b.props)
  }
  return { size: { x: maxX + 1, y: maxY + 1, z: maxZ + 1 }, blocks }
}

async function parseBuffer(buffer, ext) {
  let parsed
  try { parsed = (await nbt.parse(buffer)).parsed } catch (e) { throw new Error(`dosya okunamadı (bozuk ya da NBT değil): ${e.message}`) }
  const d = nbt.simplify(parsed)
  let out
  if (ext === '.litematic') out = parseLitematic(d)
  else if (ext === '.schem') out = parseSponge(d)
  else if (ext === '.nbt') out = parseStructureNbt(d)
  else throw new Error('Eski .schematic biçimi desteklenmiyor. WorldEdit/Litematica ile .schem ya da .litematic olarak dışa aktar.')
  out.blocks.sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x)
  return out
}

async function load(input) {
  const file = resolveFile(input)
  if (!file) throw new Error(`şematik bulunamadı: "${input}". Mevcut: ${listFiles().map((f) => f.name).join(', ') || 'hiç dosya yok'}`)
  const buffer = fs.readFileSync(path.join(SCHEM_DIR, file))
  const ext = path.extname(file).toLowerCase()
  const s = await parseBuffer(buffer, ext)
  if (!s.blocks.length) throw new Error('şematikte yerleştirilecek blok yok')
  return { file, ...s }
}

// ------------------------------------------------------------------ döndürme
function rotateProps(props, turns) {
  let p = { ...props }
  for (let t = 0; t < turns; t++) {
    const q = {}
    for (const [k, v] of Object.entries(p)) {
      if (k === 'facing' && FACING_CW[v]) q.facing = FACING_CW[v]
      else if (k === 'axis') q.axis = v === 'x' ? 'z' : v === 'z' ? 'x' : v
      else if (k === 'rotation' && /^\d+$/.test(v)) q.rotation = String((Number(v) + 4) % 16)
      else if (FACING_CW[k]) q[FACING_CW[k]] = v      // duvar/çit/redstone bağlantıları (north=... -> east=...)
      else q[k] = v
    }
    p = q
  }
  return p
}

// Saat yönünde derece (0/90/180/270), yukarıdan bakışla
function rotate(schem, deg) {
  const turns = (((Math.round(deg / 90) % 4) + 4) % 4)
  if (!turns) return schem
  let { size, blocks } = schem
  for (let t = 0; t < turns; t++) {
    const nsize = { x: size.z, y: size.y, z: size.x }
    blocks = blocks.map((b) => ({ ...b, x: size.z - 1 - b.z, z: b.x, props: rotateProps(b.props, 1) }))
    size = nsize
  }
  blocks.sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x)
  return { ...schem, size, blocks }
}

// ------------------------------------------------------------------ malzemeler
const ITEM_RENAMES = {
  redstone_wire: 'redstone', tripwire: 'string', potatoes: 'potato', carrots: 'carrot', wheat: 'wheat_seeds',
  beetroots: 'beetroot_seeds', melon_stem: 'melon_seeds', pumpkin_stem: 'pumpkin_seeds', attached_melon_stem: 'melon_seeds',
  attached_pumpkin_stem: 'pumpkin_seeds', sweet_berry_bush: 'sweet_berries', cocoa: 'cocoa_beans', kelp_plant: 'kelp',
  bamboo_sapling: 'bamboo', tall_seagrass: 'seagrass', big_dripleaf_stem: 'big_dripleaf', water_cauldron: 'cauldron',
  lava_cauldron: 'cauldron', powder_snow_cauldron: 'cauldron', wall_torch: 'torch', soul_wall_torch: 'soul_torch',
  redstone_wall_torch: 'redstone_torch', cave_vines: 'glow_berries', cave_vines_plant: 'glow_berries',
  weeping_vines_plant: 'weeping_vines', twisting_vines_plant: 'twisting_vines',
}

function blockToItem(b, mcData) {
  const n = b.name
  const p = b.props || {}
  if (SKIP_BLOCKS.has(n) || NO_ITEM.has(n)) return null
  if (p.half === 'upper' || p.part === 'head') return null    // kapı üst yarısı, yatak başı
  let item = ITEM_RENAMES[n] || n
  item = item.replace(/_wall_(sign|hanging_sign|banner|head|skull)$/, '_$1')
  if (n.startsWith('potted_')) item = 'flower_pot'
  let count = 1
  if (/_slab$/.test(n) && p.type === 'double') count = 2
  else if (n === 'snow' && p.layers) count = Number(p.layers) || 1
  else if (n === 'candle' || /_candle$/.test(n)) count = Number(p.candles) || 1
  else if (n === 'sea_pickle') count = Number(p.pickles) || 1
  else if (n === 'turtle_egg') count = Number(p.eggs) || 1
  if (!mcData.itemsByName[item]) return { unknown: n }
  return { item, count }
}

function materials(schem, mcData) {
  const need = {}
  const unknown = {}
  for (const b of schem.blocks) {
    const r = blockToItem(b, mcData)
    if (!r) continue
    if (r.unknown) unknown[r.unknown] = (unknown[r.unknown] || 0) + 1
    else need[r.item] = (need[r.item] || 0) + r.count
  }
  return { need, unknown }
}

function missingMaterials(need, haveFn) {
  return Object.entries(need).map(([item, k]) => ({ item, need: k, have: haveFn(item) })).filter((m) => m.have < m.need)
}

// ------------------------------------------------------------------ komutlar
const stateString = (b) => {
  const keys = Object.keys(b.props || {}).sort()
  return `minecraft:${b.name}${keys.length ? `[${keys.map((k) => `${k}=${b.props[k]}`).join(',')}]` : ''}`
}

// blocks: {x,y,z,...} (şematik koordinatı), origin: dünya koordinatı. Aynı satırdaki ardışık aynı blokları /fill ile birleştirir.
function compileCommands(blocks, origin) {
  const cmds = []
  const sorted = [...blocks].sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x)
  let i = 0
  while (i < sorted.length) {
    const b = sorted[i]
    const st = stateString(b)
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1].y === b.y && sorted[j + 1].z === b.z && sorted[j + 1].x === sorted[j].x + 1 && stateString(sorted[j + 1]) === st) j++
    const len = j - i + 1
    const x1 = origin.x + b.x, y = origin.y + b.y, z = origin.z + b.z
    if (len >= 3) cmds.push(`/fill ${x1} ${y} ${z} ${x1 + len - 1} ${y} ${z} ${st}`)
    else for (let k = i; k <= j; k++) cmds.push(`/setblock ${origin.x + sorted[k].x} ${y} ${z} ${st}`)
    i = j + 1
  }
  return cmds
}

// Bölgeyi havayla temizleyen /fill komutları (komut başına en fazla 32768 blok)
function clearCommands(origin, size) {
  const cmds = []
  const area = size.x * size.z
  const step = Math.max(1, Math.floor(32768 / area))
  for (let y = 0; y < size.y; y += step) {
    const y2 = Math.min(size.y - 1, y + step - 1)
    cmds.push(`/fill ${origin.x} ${origin.y + y} ${origin.z} ${origin.x + size.x - 1} ${origin.y + y2} ${origin.z + size.z - 1} minecraft:air`)
  }
  return cmds
}

function describe(schem, mcData, haveFn) {
  const { need, unknown } = materials(schem, mcData)
  const top = Object.entries(need).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([i, k]) => `${i} x${k}`).join(', ')
  const missing = haveFn ? missingMaterials(need, haveFn) : []
  const unk = Object.keys(unknown)
  return {
    need, unknown, missing,
    text: `${schem.file}: boyut ${schem.size.x}x${schem.size.y}x${schem.size.z}, ${schem.blocks.length} blok. Malzeme: ${top || 'yok'}` +
      (unk.length ? `. Bilinmeyen bloklar: ${unk.slice(0, 5).join(', ')}` : '') +
      (haveFn ? (missing.length ? `. EKSİK: ${missing.slice(0, 8).map((m) => `${m.item} (${m.have}/${m.need})`).join(', ')}` : '. Tüm malzemeler envanterde') : ''),
  }
}

module.exports = {
  SCHEM_DIR, EXTS, MAX_FILE_BYTES, listFiles, resolveFile, saveFile, deleteFile, sanitizeName, ensureDir,
  load, parseBuffer, parseBlockString, rotate, rotateProps, materials, missingMaterials, blockToItem,
  compileCommands, clearCommands, stateString, describe,
}
