'use strict'
// Hızlı kontrol: tüm kaynak dosyaların sözdizimini denetler. Kullanım: npm test
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const files = [path.join(__dirname, '..', 'server.js')]
const dir = path.join(__dirname, '..', 'src')
for (const f of fs.readdirSync(dir)) if (f.endsWith('.js')) files.push(path.join(dir, f))
let bad = 0
for (const f of files) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }) } catch (e) { bad++; console.error('HATA:', f, String(e.stderr || e.message).split('\n').slice(0, 4).join('\n')) }
}
console.log(bad ? `${bad} dosyada sözdizimi hatası var` : `${files.length} dosya temiz`)
process.exit(bad ? 1 : 0)
