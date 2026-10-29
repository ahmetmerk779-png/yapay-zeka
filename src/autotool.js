'use strict'
// Otomatik alet: her bot.dig öncesi o blok için en hızlı aleti kuşanır (yol bulucunun kazmaları dahil).
// - Süreleri blok.digTime ile hesaplar (zımbırtı yok, oyunun kendi formülü)
// - Hızı birbirine yakın aletlerden ucuz olanı seçer (netherite kazmayı toprağa harcamaz)
// - Bozulmak üzere (<=2 kullanım) alet kullanmaz; <=12 kalınca uyarır
// Kapatmak: AUTOTOOL=0 ya da inst.cfg.autoTool=false ("auto_tool" eylemi ile de açılıp kapanır)
const TOOL = /(_pickaxe|_axe|_shovel|_hoe|_sword)$|^shears$/

function remaining(it) {
  try {
    const max = it.maxDurability
    const used = it.durabilityUsed
    if (typeof max === 'number' && typeof used === 'number' && max > 0) return max - used
  } catch (e) { /* yoksay */ }
  return null
}

function install(inst) {
  const bot = inst.bot
  if (!bot || bot._autoTool || process.env.AUTOTOOL === '0') return
  bot._autoTool = true
  const prev = bot.dig.bind(bot)
  const warned = new Map()

  const timeWith = (block, it) => {
    const inWater = !!(bot.entity && bot.entity.isInWater)
    const notOnGround = !(bot.entity && bot.entity.onGround)
    let ench = []
    try { ench = (it && it.enchants) || [] } catch (e) { ench = [] }
    const effects = (bot.entity && bot.entity.effects) || {}
    try { return block.digTime(it ? it.type : null, false, inWater, notOnGround, ench, effects) } catch (e) { return Infinity }
  }

  function pick(block) {
    if (!block || typeof block.digTime !== 'function') return null
    if (bot.game && bot.game.gameMode === 'creative') return null
    const handT = timeWith(block, null)
    const cands = []
    for (const it of bot.inventory.items()) {
      if (!TOOL.test(it.name)) continue
      const rem = remaining(it)
      if (rem !== null && rem <= 2) continue
      const t = timeWith(block, it)
      if (Number.isFinite(t)) cands.push({ it, t, max: it.maxDurability || 0 })
    }
    if (!cands.length) return null
    const bestT = Math.min(...cands.map((c) => c.t))
    if (Number.isFinite(handT) && handT <= bestT * 1.05) return null   // eller zaten yeterince hızlı
    const near = cands.filter((c) => c.t <= bestT * 1.15)
    near.sort((a, b) => a.max - b.max || a.t - b.t)                      // yakın hızdakilerden en ucuz malzeme
    return near[0].it
  }

  bot.dig = async function autoToolDig(block, ...rest) {
    try {
      if (!(inst.cfg && inst.cfg.autoTool === false)) {
        const tool = pick(block)
        const held = bot.heldItem
        if (tool && (!held || held.type !== tool.type || held.slot !== tool.slot) ) await bot.equip(tool, 'hand')
      }
    } catch (e) { /* alet seçilemese de kırmayı dene */ }
    const r = await prev(block, ...rest)
    try {
      const held = bot.heldItem
      if (held && TOOL.test(held.name)) {
        const rem = remaining(held)
        const key = held.name
        if (rem !== null && rem <= 12 && Date.now() - (warned.get(key) || 0) > 60000) {
          warned.set(key, Date.now())
          if (inst.narrate) inst.narrate(`${held.name} bozulmak üzere (${rem} kullanım kaldı).`, 'info')
        }
      }
    } catch (e) { /* yoksay */ }
    return r
  }
}

module.exports = { install, TOOL, remaining }
