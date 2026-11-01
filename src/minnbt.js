'use strict'
// Hafif NBT okuyucu: büyük dizileri (LongArray/ByteArray/IntArray) nesne dizisi yerine düz typed array olarak tutar.
// 3 MB'lık bir litematic'i prismarine-nbt ile açmak yüzlerce MB bellek ister (her long için [hi,lo] dizisi); bu okuyucu ~10 kat az kullanır.
const zlib = require('zlib')

function parse(input) {
  let buf = Buffer.isBuffer(input) ? input : Buffer.from(input)
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf)
  else if (buf[0] === 0x78) buf = zlib.inflateSync(buf)
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let p = 0
  const str = () => { const n = dv.getUint16(p); p += 2; const s = buf.toString('utf8', p, p + n); p += n; return s }
  function payload(t) {
    switch (t) {
      case 1: return dv.getInt8(p++)
      case 2: { const v = dv.getInt16(p); p += 2; return v }
      case 3: { const v = dv.getInt32(p); p += 4; return v }
      case 4: { const hi = dv.getInt32(p); const lo = dv.getInt32(p + 4); p += 8; return [hi, lo] }
      case 5: { const v = dv.getFloat32(p); p += 4; return v }
      case 6: { const v = dv.getFloat64(p); p += 8; return v }
      case 7: { const n = dv.getInt32(p); p += 4; const a = buf.subarray(p, p + n); p += n; return a }
      case 8: return str()
      case 9: {
        const it = dv.getInt8(p++); const n = dv.getInt32(p); p += 4
        const a = new Array(n)
        for (let i = 0; i < n; i++) a[i] = payload(it)
        return a
      }
      case 10: {
        const o = {}
        for (;;) { const tt = dv.getInt8(p++); if (tt === 0) break; const k = str(); o[k] = payload(tt) }
        return o
      }
      case 11: { const n = dv.getInt32(p); p += 4; const a = new Int32Array(n); for (let i = 0; i < n; i++) a[i] = dv.getInt32(p + i * 4); p += n * 4; return a }
      case 12: {
        // her long için (alt 32, üst 32) sırasıyla; litematic bit akışı doğrudan buradan okunur
        const n = dv.getInt32(p); p += 4
        const w = new Uint32Array(n * 2)
        for (let i = 0; i < n; i++) { w[2 * i + 1] = dv.getUint32(p + i * 8); w[2 * i] = dv.getUint32(p + i * 8 + 4) }
        p += n * 8
        w.isLongWords = true
        return w
      }
      default: throw new Error('bilinmeyen NBT etiketi: ' + t)
    }
  }
  const rootType = dv.getInt8(p++)
  if (rootType !== 10) throw new Error('NBT kökü compound değil')
  str()
  return payload(10)
}

module.exports = { parse }
