'use strict'
// OP ise yapıları /fill ve /setblock ile kurar (çok daha hızlı, malzeme gerekmez).
// Yetki otomatik denenir; sonuç doğrulanır, olmayan bloklar normal yerleştirmeye düşer.
// Kapatmak: OPBUILD=0 ya da panelde cfg.opBuild=false. Zorla açmak: cfg.opBuild=true.
const { Vec3 } = require('vec3')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const NOT_CMD = /(stairs|slab|door|fence|_wall$|trapdoor|button|plate|sign|_bed$|head|skull|banner|chest|barrel|shulker|pot$|ladder|vine|rail|torch|lantern|carpet|pane|bars|sapling|flower|crop|furnace|table|anvil|command|campfire|candle|coral|fan|lever|redstone|piston|observer|hopper|dispenser|dropper|bell|cauldron|water|lava|fire|portal|cake|egg|lichen|moss_carpet|kelp|grass$|fern)/

function enabled(inst) {
  if (process.env.OPBUILD === '0') return false
  if (inst.cfg && inst.cfg.opBuild === false) return false
  if (inst.cfg && inst.cfg.allowCommands === false) return false
  return true
}

// Yetki + mod tespiti. Sunucu, komut ağacını (declare_commands) oyuncunun yetkisine göre süzerek gönderir:
// setblock+fill varsa OP'dir (vanilla modu); yoksa WorldEdit (//set) varsa o kullanılır. Ağaç yoksa zararsız bir /setblock ile yoklanır.
async function available(inst) {
  if (!enabled(inst)) return false
  const bot = inst.bot
  if (inst.cfg && inst.cfg.opBuild === true) { inst._op = { v: true, mode: 'vanilla', t: Date.now() }; return true }
  const now = Date.now()
  if (inst._opProbeReset) { inst._op = null; inst._opProbeReset = false }
  if (inst._op && now - inst._op.t < 600000) return inst._op.v
  const has = (n) => (inst.hasCmd ? inst.hasCmd(n) : false)
  if (inst.serverCmds && inst.serverCmds.size) {
    let mode = null
    if (has('setblock') && has('fill')) mode = 'vanilla'
    else if (has('//set') && has('//pos1') && has('//pos2')) mode = 'we'
    inst._op = { v: !!mode, mode, t: now }
    if (inst.log) inst.log('info', mode === 'vanilla' ? 'OP yetkisi var: yapılarda /fill ve /setblock kullanılacak.' : mode === 'we' ? 'WorldEdit var: yapılarda //pos1 //pos2 //set kullanılacak.' : 'OP/WorldEdit yetkisi yok: bloklar elle konacak.')
    return !!mode
  }
  const p = bot.entity.position.floored()
  const spot = [p, p.offset(0, 1, 0)].find((q) => { const b = bot.blockAt(q); return b && b.name === 'air' })
  if (!spot) return false   // ölçemedik; sonraki seferde dene
  let verdict = null
  const onMsg = (m) => {
    const s = String(m || '')
    if (/^(?:\[[^\]]*\]\s*)*<?\w{3,16}>?\s*(?:»|:|>)\s/.test(s)) return   // oyuncu sohbeti, sistem yanıtı değil
    if (/could not set|changed the block|successfully|no blocks were/i.test(s)) verdict = true
    else if (/unknown or incomplete|do not have permission|permission|yetkin|izin|bilinmeyen|geçersiz komut/i.test(s)) verdict = false
  }
  bot.on('messagestr', onMsg)
  try {
    bot.chat(`/setblock ${spot.x} ${spot.y} ${spot.z} air`)
    const t0 = Date.now()
    while (verdict === null && Date.now() - t0 < 2500) await sleep(100)
  } finally { bot.removeListener('messagestr', onMsg) }
  inst._op = { v: verdict === true, mode: verdict === true ? 'vanilla' : null, t: now }
  if (inst.log) inst.log('info', verdict === true ? 'OP yetkisi var: yapılarda /fill ve /setblock kullanılacak.' : 'OP yetkisi yok (ya da komut yanıtı alınamadı): bloklar elle konacak.')
  return inst._op.v
}

function cmdOk(inst, t) {
  if (t.kind && t.kind !== 'normal') return false
  if (t.hints && Object.keys(t.hints).length) return false
  const def = inst.mcData.blocksByName[t.blockName]
  return !!def && def.boundingBox === 'block' && !NOT_CMD.test(t.blockName)
}

// Hücreleri (x,y,z,block) açgözlü biçimde kutulara birleştir
function boxes(cells) {
  const map = new Map(cells.map((c) => [`${c.x},${c.y},${c.z}`, c]))
  const seen = new Set()
  const key = (x, y, z) => `${x},${y},${z}`
  const free = (x, y, z, blk) => { const c = map.get(key(x, y, z)); return c && c.block === blk && !seen.has(key(x, y, z)) }
  const out = []
  const sorted = [...map.values()].sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x)
  for (const c of sorted) {
    if (seen.has(key(c.x, c.y, c.z))) continue
    const blk = c.block
    let x2 = c.x
    while (free(x2 + 1, c.y, c.z, blk) && x2 - c.x < 31) x2++
    let z2 = c.z
    const rowOk = (z) => { for (let x = c.x; x <= x2; x++) if (!free(x, c.y, z, blk)) return false; return true }
    while (rowOk(z2 + 1) && z2 - c.z < 31) z2++
    let y2 = c.y
    const slabOk = (y) => { for (let z = c.z; z <= z2; z++) for (let x = c.x; x <= x2; x++) if (!free(x, y, z, blk)) return false; return true }
    while (slabOk(y2 + 1) && y2 - c.y < 31) y2++
    for (let y = c.y; y <= y2; y++) for (let z = c.z; z <= z2; z++) for (let x = c.x; x <= x2; x++) seen.add(key(x, y, z))
    out.push({ x1: c.x, y1: c.y, z1: c.z, x2, y2, z2, block: blk })
  }
  return out
}

async function runBoxes(inst, list, cancelled) {
  const bot = inst.bot
  let n = 0
  for (const b of list.slice(0, 150)) {
    if (cancelled && cancelled()) break
    const single = b.x1 === b.x2 && b.y1 === b.y2 && b.z1 === b.z2
    if (inst._op && inst._op.mode === 'we') {
      bot.chat(`//pos1 ${b.x1},${b.y1},${b.z1}`); await sleep(250)
      bot.chat(`//pos2 ${b.x2},${b.y2},${b.z2}`); await sleep(250)
      bot.chat(`//set ${b.block}`)
    } else {
      bot.chat(single ? `/setblock ${b.x1} ${b.y1} ${b.z1} ${b.block}` : `/fill ${b.x1} ${b.y1} ${b.z1} ${b.x2} ${b.y2} ${b.z2} ${b.block}`)
    }
    n++
    await sleep(350)
  }
  await sleep(500)
  return n
}

/** todo: placeMany hedefleri. Komutla yapılıp doğrulananları döndürür (kalanlar elle konur). */
async function placeTargets(inst, todo, cancelled) {
  const done = new Set()
  if (todo.length < 6 || !(await available(inst))) return done
  const cand = todo.filter((t) => cmdOk(inst, t))
  if (cand.length < 6) return done
  const cells = cand.map((t) => ({ x: t.pos.x, y: t.pos.y, z: t.pos.z, block: t.blockName }))
  const n = await runBoxes(inst, boxes(cells), cancelled)
  if (inst.log) inst.log('action', `OP inşa: ${n} komut gönderildi`)
  for (const t of cand) {
    const b = inst.bot.blockAt(new Vec3(t.pos.x, t.pos.y, t.pos.z))
    if (b && b.name === t.blockName) done.add(t)
  }
  return done
}

/** Konumları havaya çevirir (temizlik). Temizlenen konum sayısını döndürür, yetki yoksa -1. */
async function clearPositions(inst, positions, cancelled) {
  if (positions.length < 4 || !(await available(inst))) return -1
  const bot = inst.bot
  const cells = positions.filter((p) => { const b = bot.blockAt(p); return b && b.name !== 'air' && b.name !== 'bedrock' })
    .map((p) => ({ x: p.x, y: p.y, z: p.z, block: 'air' }))
  if (!cells.length) return 0
  await runBoxes(inst, boxes(cells), cancelled)
  return cells.filter((c) => { const b = bot.blockAt(new Vec3(c.x, c.y, c.z)); return b && b.name === 'air' }).length
}

// Kendi oyun modunu değiştir (OP gerekir). Başarılıysa true.
async function setGamemode(inst, mode) {
  if (!enabled(inst)) return false
  const bot = inst.bot
  const cur = () => (bot.game && bot.game.gameMode) || ''
  if (cur() === mode) return true
  const has = (n) => (inst.hasCmd ? inst.hasCmd(n) : false)
  let allowed = false
  if (inst.serverCmds && inst.serverCmds.size) allowed = has('gamemode') || has('gm')
  else allowed = await available(inst)
  if (!allowed) return false
  bot.chat(`/gamemode ${mode}`)
  const t0 = Date.now()
  while (cur() !== mode && Date.now() - t0 < 4000) await sleep(150)
  if (cur() !== mode && has('gm')) { bot.chat(`/gm ${mode}`); const t1 = Date.now(); while (cur() !== mode && Date.now() - t1 < 3000) await sleep(150) }
  return cur() === mode
}

module.exports = { available, setGamemode, placeTargets, clearPositions, boxes, cmdOk }
