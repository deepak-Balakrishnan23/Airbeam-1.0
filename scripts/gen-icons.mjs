/**
 * Generates the PWA icons.
 *
 * A PNG encoder written by hand, because the artwork is three circles and a
 * dot. The pixel data is deflated with the same platform compression the app
 * uses for its transfers.
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { deflate } from '../src/lib/compress.js'
import { join } from 'node:path'

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(bytes) {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

async function encodePng(width, height, rgba) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // truecolour with alpha

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', Buffer.from(await deflate(raw))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Coverage of a pixel by a ring, sampled 3x3 for cheap antialiasing. */
function ringCoverage(px, py, cx, cy, radius, thickness) {
  let hits = 0
  for (let sy = 0; sy < 3; sy++) {
    for (let sx = 0; sx < 3; sx++) {
      const dx = px + (sx + 0.5) / 3 - cx
      const dy = py + (sy + 0.5) / 3 - cy
      const d = Math.hypot(dx, dy)
      if (Math.abs(d - radius) <= thickness / 2) hits++
    }
  }
  return hits / 9
}

function discCoverage(px, py, cx, cy, radius) {
  let hits = 0
  for (let sy = 0; sy < 3; sy++) {
    for (let sx = 0; sx < 3; sx++) {
      const dx = px + (sx + 0.5) / 3 - cx
      const dy = py + (sy + 0.5) / 3 - cy
      if (Math.hypot(dx, dy) <= radius) hits++
    }
  }
  return hits / 9
}

function draw(size) {
  const rgba = Buffer.alloc(size * size * 4)
  const c = size / 2
  const unit = size / 512

  // Emitter core, then three rings stepping outward and fading as they go.
  const rings = [
    { radius: 96 * unit, thickness: 26 * unit, alpha: 1.0 },
    { radius: 160 * unit, thickness: 22 * unit, alpha: 0.72 },
    { radius: 224 * unit, thickness: 18 * unit, alpha: 0.44 },
  ]

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4

      // Background: a slight vertical lift so the mark does not read as flat.
      const lift = y / size
      let r = 7 + lift * 6
      let g = 9 + lift * 9
      let b = 13 + lift * 14
      let a = 255

      const paint = (coverage, alpha) => {
        if (coverage <= 0) return
        const k = coverage * alpha
        r = r * (1 - k) + 79 * k
        g = g * (1 - k) + 209 * k
        b = b * (1 - k) + 197 * k
      }

      paint(discCoverage(x, y, c, c, 44 * unit), 1)
      for (const ring of rings) {
        paint(ringCoverage(x, y, c, c, ring.radius, ring.thickness), ring.alpha)
      }

      rgba[i] = Math.round(r)
      rgba[i + 1] = Math.round(g)
      rgba[i + 2] = Math.round(b)
      rgba[i + 3] = a
    }
  }
  return rgba
}

const outDir = new URL('../public/', import.meta.url).pathname
mkdirSync(outDir, { recursive: true })

for (const size of [192, 512]) {
  writeFileSync(join(outDir, `icon-${size}.png`), await encodePng(size, size, draw(size)))
  console.log(`public/icon-${size}.png`)
}
