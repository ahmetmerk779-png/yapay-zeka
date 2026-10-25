'use strict'
// Kristal PvP karar mantığı (saf fonksiyonlar; Minecraft'a bağlı değil, test edilebilir).
// Not: Bu basit bir sezgisel yaklaşımdır. Gerçek oyuncu seviyesinde hasar hesabı yapmaz.

const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

// Kristalin patlama merkezi: taban bloğunun üstü
const crystalCenter = (base) => ({ x: base.x + 0.5, y: base.y + 1, z: base.z + 0.5 })

// Yaklaşık patlama hasarı katsayısı (0..1): mesafe 12'de sıfır, yakınsa yüksek
function exposure(center, entityPos) {
  const d = dist3(center, entityPos)
  return Math.max(0, 1 - d / 12)
}

/**
 * Kristal koymak için en iyi taban bloğunu seç.
 * bases: [{x,y,z}] (obsidyen/bedrock, üstü boş olanlar)
 * target/me: {x,y,z} ayak konumları
 * Kurallar: hedefe çok yakın, bana yeterince uzak, erişim menzilinde olmalı.
 */
function pickCrystalBase(bases, target, me, opts = {}) {
  const reach = opts.reach ?? 4.5
  const minSelf = opts.minSelfDist ?? 2.2
  const maxTarget = opts.maxTargetDist ?? 4.5
  let best = null
  let bestScore = -Infinity
  const eye = { x: me.x, y: me.y + 1.62, z: me.z }
  for (const b of bases) {
    const c = crystalCenter(b)
    if (dist3(eye, c) > reach) continue
    const dSelf = dist3(c, me)
    const dTarget = dist3(c, target)
    if (dSelf < minSelf || dTarget > maxTarget) continue
    const score = exposure(c, target) * 10 - exposure(c, me) * 6
    if (score > bestScore) { bestScore = score; best = b }
  }
  return best
}

/**
 * Patlatılacak (vurulacak) kristali seç.
 * crystals: [{id, position:{x,y,z}}]; myHealth: can
 * Hedefe zarar verecek ve bana fazla zarar vermeyecekse vur.
 */
function pickCrystalToBreak(crystals, target, me, myHealth, opts = {}) {
  const reach = opts.reach ?? 4.5
  const eye = { x: me.x, y: me.y + 1.62, z: me.z }
  let best = null
  let bestScore = -Infinity
  for (const c of crystals) {
    if (dist3(eye, c.position) > reach) continue
    const dmgTarget = exposure(c.position, target)
    const dmgSelf = exposure(c.position, me)
    if (dmgTarget < 0.15) continue
    // canım düşükse bana yakın kristali vurma
    if (myHealth <= 8 && dmgSelf > 0.55) continue
    if (myHealth <= 12 && dmgSelf > 0.8) continue
    const score = dmgTarget * 10 - dmgSelf * 7
    if (score > bestScore) { bestScore = score; best = c }
  }
  return best
}

module.exports = { dist3, crystalCenter, exposure, pickCrystalBase, pickCrystalToBreak }
