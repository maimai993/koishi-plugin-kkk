/** 生成探针用的一张合法 PNG（8x8 纯色，CRC 正确），供 probe-qrcode-avatar 当假头像使。 */
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const crcTable = (() => {
  const t = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c >>> 0
  }
  return t
})()

const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

const W = 8
const H = 8
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(W, 0)
ihdr.writeUInt32BE(H, 4)
ihdr[8] = 8   // bit depth
ihdr[9] = 2   // color type: truecolour
const raw = []
for (let y = 0; y < H; y++) {
  raw.push(Buffer.from([0]))
  for (let x = 0; x < W; x++) raw.push(Buffer.from([0x33, 0x66, 0xcc]))
}
const idat = zlib.deflateSync(Buffer.concat(raw))
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0))
])

const out = path.join(__dirname, 'fixtures', 'avatar-probe.png')
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, png)
console.log('写出 ' + out + '（' + png.length + ' 字节）')
