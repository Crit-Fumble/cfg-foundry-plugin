/**
 * make-level-bg.mjs — generate two RGBA-with-alpha PNG fixtures used by the 3D
 * overlay spec to demonstrate native v14 Level backgrounds at different
 * elevations, and transparency between floors:
 *
 *   level-ground.png — opaque checkerboard "ground floor" map (full alpha).
 *   level-upper.png  — an opaque stone "upper floor" frame with a TRANSPARENT
 *                      centre hole, so in 3D the ground floor shows through it.
 *
 *   node tests/integration/make-level-bg.mjs
 *
 * Writes to tests/fixtures/. Tiny zero-dependency PNG encoder (zlib + a CRC32)
 * so this needs no image library.
 */
import { deflateSync } from 'zlib'
import { writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT = join(__dirname, '../fixtures')
mkdirSync(OUT, { recursive: true })

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  const stride = 1 + width * 4
  const raw = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0 // filter: none
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4)
  }
  const idat = deflateSync(raw, { level: 9 })
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

const W = 512
const H = 512
function paint(fn) {
  const buf = Buffer.alloc(W * H * 4)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [r, g, b, a] = fn(x, y)
      const i = (y * W + x) * 4
      buf[i] = r
      buf[i + 1] = g
      buf[i + 2] = b
      buf[i + 3] = a
    }
  }
  return buf
}

// Ground floor: fully opaque earthy checkerboard so it reads as a solid floor.
const ground = paint((x, y) => {
  const sq = ((x >> 6) + (y >> 6)) & 1
  return sq ? [92, 112, 72, 255] : [72, 92, 56, 255]
})
writeFileSync(join(OUT, 'level-ground.png'), encodePNG(W, H, ground))

// Upper floor: an opaque stone frame (outer ~22%) with a transparent centre, so
// in 3D you see straight through the hole down to the ground floor below.
const border = Math.round(W * 0.22)
const upper = paint((x, y) => {
  const inFrame = x < border || x >= W - border || y < border || y >= H - border
  if (!inFrame) return [0, 0, 0, 0] // transparent hole → ground shows through
  const grain = (((x * 7 + y * 13) % 24) | 0) - 12
  return [150 + grain, 142 + grain, 132 + grain, 255]
})
writeFileSync(join(OUT, 'level-upper.png'), encodePNG(W, H, upper))

console.log('[make-level-bg] wrote level-ground.png + level-upper.png to', OUT)
