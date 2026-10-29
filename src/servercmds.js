'use strict'
// Sunucu komutlarını keşfeder (declare_commands paketi, 1.13+) ve eklentileri tanır.
// Bot hangi komutların (tpa, home, kit, //set ...) kullanılabilir olduğunu böylece bilir.
const PLUGIN_HINTS = [
  ['WorldEdit', ['/set', '/pos1', '/pos2', '/wand', '/replace', '/copy', '/paste', 'worldedit:/set']],
  ['EssentialsX', ['tpa', 'sethome', 'home', 'warp', 'kit', 'back', 'tpaccept', 'nick', 'heal', 'feed', 'essentials:home']],
  ['WorldGuard', ['region', 'rg', 'worldguard:region']],
  ['LuckPerms', ['lp', 'luckperms']],
  ['Multiverse', ['mv', 'mvtp', 'multiverse-core:mv']],
  ['CoreProtect', ['co', 'coreprotect']],
  ['Citizens', ['npc', 'citizens']],
  ['VoxelSniper', ['b', 'vs', 'voxelsniper']],
  ['FastAsyncWorldEdit', ['fawe', 'fastasyncworldedit:fawe']],
  ['Vault/Ekonomi', ['balance', 'bal', 'pay', 'eco']],
  ['Claim (GriefPrevention)', ['claim', 'abandonclaim', 'trust']],
]
const USEFUL = ['tpa', 'tpaccept', 'tpahere', 'home', 'sethome', 'spawn', 'warp', 'kit', 'back', 'fly', 'gamemode', 'gm', 'give', 'tp', 'time', 'weather', 'heal', 'feed', 'god', 'setblock', 'fill', 'clone', '/set', '/pos1', '/pos2', '/replace', '/walls', '/sphere', '/cyl', '/copy', '/paste', '/undo', 'clear', 'effect', 'enchant', 'xp', 'summon', 'kill', 'op', 'ban', 'kick', 'msg', 'sell', 'shop', 'ah', 'bal', 'pay', 'rtp', 'wild']

function flatten(packet) {
  const nodes = packet.nodes || []
  const root = nodes[packet.rootIndex !== undefined ? packet.rootIndex : 0]
  const out = new Set()
  if (!root || !Array.isArray(root.children)) return out
  for (const idx of root.children) {
    const n = nodes[idx]
    if (!n) continue
    const ex = n.extraNodeData
    const name = typeof ex === 'string' ? ex : ex && ex.name
    if (name) out.add(String(name).toLowerCase())
  }
  return out
}

function install(inst, bot) {
  inst.serverCmds = new Set()
  try {
    bot._client.on('declare_commands', (packet) => {
      try {
        inst.serverCmds = flatten(packet)
        inst._opProbeReset = true
        if (inst.log) inst.log('info', `Sunucu komutları algılandı: ${inst.serverCmds.size} komut${inst.plugins().length ? ` (eklentiler: ${inst.plugins().join(', ')})` : ''}`)
      } catch (e) { /* yoksay */ }
    })
  } catch (e) { /* eski protokol: komut listesi alınamaz */ }
  inst.hasCmd = (n) => { const k = String(n).toLowerCase(); return inst.serverCmds.has(k) || (k.startsWith('/') && inst.serverCmds.has(k.slice(1))) }
  inst.plugins = () => PLUGIN_HINTS.filter(([, names]) => names.some((n) => inst.serverCmds.has(n))).map(([p]) => p)
  inst.cmdSummary = (query) => {
    const all = [...inst.serverCmds]
    const q = query ? String(query).toLowerCase() : null
    const hit = q ? all.filter((c) => c.includes(q)) : all.filter((c) => USEFUL.includes(c))
    return { eklentiler: inst.plugins(), komutlar: hit.slice(0, 40), toplam: all.length }
  }
}

module.exports = { install, flatten, PLUGIN_HINTS }
