/**
 * The reverse link: the receiver paints a small status code, the sender reads
 * it with its front camera.
 *
 * A fountain code needs no feedback to be CORRECT, which is its virtue. What
 * feedback buys is knowing when to stop and knowing which rung of the grid
 * ladder to use - and the second of those is worth a lot. The receiver knows
 * how many capture pixels it is getting per tile; the sender cannot guess it,
 * because it depends on the other device's camera and on how someone is
 * holding it. Measured, that difference is worth about 2.3x throughput between
 * a 720p and a 1080p receiver.
 *
 * ## Why this is not the main codec at a small size
 *
 * Reusing airblock for this looked free and is not. The smallest sensible airblock
 * grid still needs four 7x7 anchors and four 15-symbol header strips - 256
 * cells of overhead before a single payload symbol - and to carry one RS(63,51)
 * codeword it needs 63 more. That is a 20x16 grid to move three bytes, and it
 * would need a special-cased decode path to skip the header it does not need.
 *
 * So this is its own format, and a deliberately crude one:
 *
 *   - a white border ring, which is what the detector locks onto. White is
 *     colourless and the payload never is, so the same min/max channel test
 *     that finds the main code's anchors finds this too, and for the same
 *     reason: it survives exposure and white-balance error that a brightness
 *     threshold would not.
 *   - inside it, a 12x2 grid of palette-coloured cells. 24 cells, two bits
 *     each, carrying the 24-bit status TWICE.
 *
 * The redundancy is repetition rather than algebra, because at three bytes a
 * frame there is nothing to gain from being clever: the two copies must agree,
 * AND two consecutive frames must agree, before anything acts on it. A status
 * that is wrong is worse than a status that is late - a spurious "done" flag
 * would cut off a transfer mid-file.
 *
 * ## Field layout, 32 bits
 *
 *   31..26  session tag - six bits of the file's digest
 *   25      done
 *   24..18  progress, in percent
 *   17..13  px per tile, in halves (0 to 15.5)
 *   12..9   mean classifier confidence, in sixteenths
 *    8..4   frames per second the receiver can actually DECODE
 *    3..0   reserved
 *
 * The decode rate is here because of a measurement that contradicted the
 * obvious assumption. Decode cost scales with the cell count, so a denser rung
 * does not simply mean more throughput: measured in a browser worker, `dense`
 * managed 12.9 fps for 109 KB/s while `max` managed 7.7 fps for 98 - the denser
 * rung was SLOWER. Without this field the sender would happily climb to a rung
 * the receiver cannot keep up with and lose throughput doing it.
 */

import { PALETTE, classifyColour } from './airblock/palette.js'
import { achromaticMask, components } from './decoder/anchors.js'
import { openCamera } from './camera.js'

/**
 * Data cells. 32 of them carry the 32-bit status twice - the top half is one
 * copy, the bottom half the other.
 *
 * 8x4 rather than 16x2: the same cell count in a much more compact badge, and
 * a shape someone can actually frame. A long thin strip has to be held level
 * to stay in shot, and it runs out of screen before it runs out of cells.
 */
const COLS = 8
const ROWS = 4
const DATA_CELLS = COLS * ROWS
const BITS = 32

/**
 * Cell size and border thickness, in screen pixels.
 *
 * BORDER is even so that the white ring's own thickness, BORDER/2, stays a
 * whole number of pixels at every scale. It was briefly odd, which put the
 * inner black rectangle at a fractional coordinate and made the beacon
 * undetectable at odd scales and fine at even ones - the kind of bug that
 * looks like a detector problem and is not.
 */
const CELL = 26
const BORDER = 14

export const BEACON_WIDTH = COLS * CELL + BORDER * 2
export const BEACON_HEIGHT = ROWS * CELL + BORDER * 2

// ------------------------------------------------------------------ encode --

export function packStatus({
  session = 0,
  done = false,
  progress = 0,
  pxPerTile = 0,
  confidence = 0,
  decodeFps = 0,
}) {
  const percent = Math.max(0, Math.min(100, Math.round(progress * 100)))
  const halves = Math.max(0, Math.min(31, Math.round(pxPerTile * 2)))
  const sixteenths = Math.max(0, Math.min(15, Math.round(confidence * 15)))
  const fps = Math.max(0, Math.min(31, Math.round(decodeFps)))

  // >>> 0 because the session tag reaches bit 31 and a signed shift would make
  // the whole thing negative, which then packs and unpacks differently.
  return (
    (((session & 0x3f) << 26) |
      ((done ? 1 : 0) << 25) |
      ((percent & 0x7f) << 18) |
      ((halves & 0x1f) << 13) |
      ((sixteenths & 0x0f) << 9) |
      ((fps & 0x1f) << 4)) >>>
    0
  )
}

export function unpackStatus(bits) {
  return {
    session: (bits >>> 26) & 0x3f,
    done: ((bits >>> 25) & 1) === 1,
    progress: ((bits >>> 18) & 0x7f) / 100,
    pxPerTile: ((bits >>> 13) & 0x1f) / 2,
    confidence: ((bits >>> 9) & 0x0f) / 15,
    decodeFps: (bits >>> 4) & 0x1f,
  }
}

/** 32 bits -> 32 two-bit cells, the payload written out twice. */
function cellsFor(bits) {
  const cells = new Uint8Array(DATA_CELLS)
  for (let i = 0; i < BITS / 2; i++) {
    const value = (bits >>> (BITS - 2 - i * 2)) & 0x03
    cells[i] = value
    cells[i + BITS / 2] = value
  }
  return cells
}

/**
 * Draw a status code into a plain RGBA buffer.
 *
 * Kept pure and canvas-free for the same reason the main renderer is: it means
 * the reader can be tested against the writer's exact output in Node, with no
 * browser and no camera. A back channel that is only ever exercised by two
 * real devices in a room is one whose failures are discovered in the room.
 *
 * @param {number} bits packed status
 * @param {number} [scale] device pixels per design pixel, for a bigger target
 * @returns {{data: Uint8ClampedArray, width: number, height: number}}
 */
export function renderBeacon(bits, scale = 1) {
  const width = BEACON_WIDTH * scale
  const height = BEACON_HEIGHT * scale
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 3; i < data.length; i += 4) data[i] = 255

  // Integer bounds throughout: a fractional row index would step through the
  // buffer at a fractional offset and write nothing where it was meant to.
  const box = (x0, y0, w, h, r, g, b) => {
    const left = Math.max(0, Math.round(x0))
    const top = Math.max(0, Math.round(y0))
    const right = Math.min(width, Math.round(x0 + w))
    const bottom = Math.min(height, Math.round(y0 + h))
    for (let y = top; y < bottom; y++) {
      let p = (y * width + left) * 4
      for (let x = left; x < right; x++, p += 4) {
        data[p] = r
        data[p + 1] = g
        data[p + 2] = b
      }
    }
  }

  // White border ring on black, which is what the reader locks onto.
  box(0, 0, width, height, 255, 255, 255)
  const inset = (BORDER / 2) * scale
  box(inset, inset, width - inset * 2, height - inset * 2, 0, 0, 0)

  const cells = cellsFor(bits)
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const [r, g, b] = PALETTE[cells[y * COLS + x]].rgb
      box(
        (BORDER + x * CELL) * scale,
        (BORDER + y * CELL) * scale,
        CELL * scale,
        CELL * scale,
        r,
        g,
        b,
      )
    }
  }

  return { data, width, height }
}

/**
 * Paint a status code and keep it up to date.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {() => object} read called each tick for the current status
 */
export function startBeacon(canvas, read) {
  canvas.width = BEACON_WIDTH
  canvas.height = BEACON_HEIGHT
  const ctx = canvas.getContext('2d', { alpha: false })
  ctx.imageSmoothingEnabled = false

  let stopped = false
  let timer = 0

  const paint = () => {
    if (stopped) return
    const image = renderBeacon(packStatus(read() ?? {}))
    ctx.putImageData(new ImageData(image.data, image.width, image.height), 0, 0)
  }

  paint()
  // Four times a second is far more often than the status meaningfully
  // changes, and cheap - the whole code is a few hundred pixels.
  timer = setInterval(paint, 250)

  return {
    stop() {
      stopped = true
      clearInterval(timer)
    },
  }
}

// ------------------------------------------------------------------ decode --

/**
 * Find the beacon's border ring and read the cells inside it.
 *
 * No homography: the code is small, both devices are roughly facing each
 * other, and a beacon seen at enough of an angle to matter is one whose cells
 * are too small to read anyway. The bounding box of the ring is enough.
 */
export function readBeacon(image) {
  const { mask } = achromaticMask(image.data, image.width, image.height, {
    achromatic: 0.62,
    relativeLuma: 0.5,
  })
  const found = components(mask, image.width, image.height, {
    minAreaFraction: 0.0004,
    maxAreaFraction: 0.4,
    // The ring is much wider than tall, so the squareness test the main anchor
    // detector uses would throw it away.
    maxAspect: 12,
  })

  const target = BEACON_WIDTH / BEACON_HEIGHT
  let best = null
  let bestScore = Infinity

  for (const candidate of found) {
    // Hollow, so a solid bright object is not mistaken for the border.
    if (candidate.fill > 0.75) continue

    /**
     * Reject anything touching the frame edge.
     *
     * A partly visible beacon is the dangerous case, not the useless one. Its
     * border still reads as a hollow rectangle of roughly the right shape, and
     * the grid derived from its truncated bounding box is uniformly
     * mis-scaled - so BOTH copies of the payload shift by the same amount,
     * agree with each other, and the whole point of writing it twice is
     * defeated. Measured: a beacon clipped by a quarter read back as a valid
     * status with the wrong progress and the wrong px/tile.
     *
     * A beacon that is genuinely at the edge of frame is one the user can
     * move, and being told nothing is far better than being told a number
     * that is wrong.
     */
    if (
      candidate.minX <= 1 ||
      candidate.minY <= 1 ||
      candidate.maxX >= image.width - 2 ||
      candidate.maxY >= image.height - 2
    ) {
      continue
    }

    const aspect = candidate.boxW / candidate.boxH
    const score = Math.abs(aspect - target) / target
    // Tight, because the aspect is the only shape check there is and a
    // truncated border is exactly what a loose one lets through.
    if (score < 0.12 && score < bestScore) {
      bestScore = score
      best = candidate
    }
  }

  if (!best) return { ok: false, reason: 'no beacon border found' }

  // The ring's bounding box is the whole code, border included, so the data
  // grid is inset by the border's share of it.
  const insetX = (best.boxW * BORDER) / BEACON_WIDTH
  const insetY = (best.boxH * BORDER) / BEACON_HEIGHT
  const gridX = best.minX + insetX
  const gridY = best.minY + insetY
  const cellW = (best.boxW - insetX * 2) / COLS
  const cellH = (best.boxH - insetY * 2) / ROWS
  if (cellW < 3 || cellH < 3) return { ok: false, reason: 'beacon too small to read' }

  const values = new Uint8Array(DATA_CELLS)
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      // Average the middle half of each cell, staying clear of the edges where
      // neighbours bleed in.
      const x0 = Math.round(gridX + (x + 0.25) * cellW)
      const x1 = Math.round(gridX + (x + 0.75) * cellW)
      const y0 = Math.round(gridY + (y + 0.25) * cellH)
      const y1 = Math.round(gridY + (y + 0.75) * cellH)

      let r = 0
      let g = 0
      let b = 0
      for (let py = y0; py < y1; py++) {
        if (py < 0 || py >= image.height) continue
        for (let px = x0; px < x1; px++) {
          if (px < 0 || px >= image.width) continue
          const p = (py * image.width + px) * 4
          r += image.data[p]
          g += image.data[p + 1]
          b += image.data[p + 2]
        }
      }
      values[y * COLS + x] = classifyColour(r, g, b).value
    }
  }

  // The two copies must agree. This is the whole error control: a status that
  // is wrong is worse than one that is late, because a spurious done flag
  // would cut a transfer off mid-file.
  for (let i = 0; i < BITS / 2; i++) {
    if (values[i] !== values[i + BITS / 2]) {
      return { ok: false, reason: 'beacon copies disagree' }
    }
  }

  let bits = 0
  for (let i = 0; i < BITS / 2; i++) bits = ((bits << 2) | values[i]) >>> 0

  return { ok: true, status: unpackStatus(bits), bits }
}

/**
 * Watch for a status code on the camera.
 *
 * Two consecutive frames must agree before anything is reported, on top of the
 * two copies within a frame. Both checks exist for the same reason: this
 * channel's only job is to say "stop" and "change rung", and being wrong about
 * either is worse than being slow.
 *
 * @param {HTMLVideoElement} video
 * @param {(status: object) => void} onStatus
 */
export async function startBeaconReader(video, onStatus, options = {}) {
  const camera = await openCamera(video, { facing: 'user', longSide: 1280 })
  if (!camera.ok) {
    options.onError?.(camera.reason)
    return { stop: () => {} }
  }

  const surface = document.createElement('canvas')
  const ctx = surface.getContext('2d', { alpha: false, willReadFrequently: true })

  let stopped = false
  let timer = 0
  let lastBits = null

  const poll = () => {
    if (stopped) return
    const width = video.videoWidth
    const height = video.videoHeight
    if (!width || !height) return

    if (surface.width !== width || surface.height !== height) {
      surface.width = width
      surface.height = height
    }
    ctx.drawImage(video, 0, 0, width, height)
    const frame = ctx.getImageData(0, 0, width, height)

    const outcome = readBeacon({ data: frame.data, width, height })
    if (!outcome.ok) {
      lastBits = null
      return
    }
    if (outcome.bits === lastBits) onStatus(outcome.status)
    lastBits = outcome.bits
  }

  // Three times a second. The status changes slowly and this is competing with
  // the emitter for the main thread.
  timer = setInterval(poll, 330)

  return {
    stop() {
      stopped = true
      clearInterval(timer)
      camera.stop()
    },
  }
}
