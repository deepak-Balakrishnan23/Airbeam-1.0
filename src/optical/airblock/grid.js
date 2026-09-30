/**
 * Where every cell sits on the panel, and which code symbol it carries.
 *
 * Two things live here and nothing else does: the profile table (how big a
 * cell is and therefore how many fit) and the interleave (which codeword a
 * given cell belongs to).
 *
 * ## Render resolution is matched to the CAMERA, not to the panel
 *
 * This is the thing that is easy to get backwards, and getting it backwards
 * costs everything. What decides whether a symbol can be read is how many
 * CAPTURE pixels its 8x8 tile spans, and that is
 *
 *     tile_render_px  x  (capture_resolution / render_resolution)
 *
 * so it depends on the tile's size in render pixels and on the ratio of the
 * two resolutions. It does not depend on the cell pitch at all. Two
 * consequences, both measured rather than reasoned:
 *
 *   - Widening the gutter to reduce cell count is pure loss. An earlier
 *     profile used a 12 px pitch around an 8 px tile and had exactly the same
 *     capture pixels per tile as a 9 px pitch around the same tile, while
 *     holding 79% fewer cells.
 *
 *   - Rendering at the panel's native resolution is also loss, whenever the
 *     panel out-resolves the camera. A 1920 wide panel read by a 720p camera
 *     puts an 8 px tile into about 5 capture pixels, which the symbol
 *     classifier can only just read, and only in sharp focus. See the ladder
 *     below for what each density actually costs.
 *
 * So the tile is always 8 px and the gutter always 1, and the density knob is
 * the RENDER RESOLUTION, which the emitter then scales up to fill whatever
 * panel it is actually on. Each profile is sized so that its target camera
 * lands near 8 capture pixels per tile.
 *
 * ## Why interleave, and why by permutation rather than by stride
 *
 * No codeword may own a small region of the panel. That is deliberate and
 * it is the opposite of what you want on a channel running *above* its
 * correction threshold, where errors should be concentrated into sacrificial
 * codewords. This channel runs below threshold - sub-1% symbol error,
 * comfortably corrected - and below threshold the inequality runs the other
 * way: spreading a burst across many codewords so each absorbs one or two
 * errors beats letting a few drown.
 *
 * The obvious implementation is a stride: codeword `c` takes every
 * `codewordCount`-th data cell. It has a failure mode. The anchors and header
 * strips remove cells from some rows and not others, so the number of data
 * cells per row varies - and when that count coincides with the stride, the
 * stride lands one row straight down and a codeword's symbols stack into a
 * vertical column. Measured on the `soft` profile, where the anchor bands
 * leave exactly 90 data cells per row against a stride of 90: 19% of
 * consecutive symbol pairs were immediate neighbours. A vertical smear there
 * would take out one codeword instead of being shared across ninety.
 *
 * Any stride can collide with some row length, and the row lengths change
 * whenever the anchor or header layout does. So the order is a permutation
 * instead - deterministic, seeded from the profile id, so both ends derive the
 * same one from the header alone.
 *
 * ## Why the permutation runs within quadrants
 *
 * A permutation over the whole panel is fatal to a torn capture. A rolling
 * shutter that catches the switch between two frames returns the top of one
 * and the bottom of the next, every codeword then holds symbols from both, and
 * a torn frame delivered nothing. So the permutation runs within each quadrant,
 * and codewords go to quadrants in contiguous ranges; a block's bytes come
 * from a run of consecutive codewords, so nearly every block lives in one
 * quadrant. A tear along the midline in either direction leaves each quadrant
 * from one frame, and the blocks of both frames are valid fountain blocks.
 * Quadrants rather than halves because the phone may be turned against the
 * panel, which turns a tear along sensor rows into one down the code's columns.
 *
 * It has a price, and it is paid deliberately. Near
 * a rung's blur cliff the errors are uneven across the panel - keystone makes
 * one side's tiles smaller, vignetting darkens the corners - and a codeword
 * confined to a quadrant averages them over a quarter of the panel instead of
 * all of it. Measured through the synthetic camera: torn frames from 0% to
 * 83-97% of blocks (rows) and 50-92% (columns), against, at each rung's blur
 * cliff and averaged over four permutations of each kind, 0.8 to 2 points of
 * blocks on `soft`, `normal` and `dense` and 3 points gained on `far`. A
 * single permutation moves that cell by as much as 25 points, which is how
 * the experiment first measured a cost of 7.
 *
 * Quadrants are not a whole number of codewords, and giving each only the
 * codewords that fit inside it would cost up to three a frame - on `far` a
 * whole block, since its 2,065 bytes hold six 344-byte blocks with a byte to
 * spare. So the cuts fall where each quadrant's cells run out, rounded to a
 * codeword, and the codeword either side of a cut may take a few cells from
 * the neighbouring quadrant.
 */

import { N, K } from './rs64.js'
import { mix32, seeded } from '../../lib/random.js'

/** Symbol tile edge, in bits. Fixed by the 64-bit hash. */
export const TILE_BITS = 8

/**
 * Header code. RS(15,4) over GF(64): 4 data symbols is 24 bits of header, and
 * 11 parity symbols corrects 5 errors in 15 - which it needs, because the
 * header is read before drift refinement has anything to work with.
 */
export const HEADER_N = 15
export const HEADER_K = 4

/** Interleave partitions: the quadrants TL, TR, BL, BR, in codeword order. */
export const PARTITIONS = 4

/**
 * @typedef {object} Profile
 * @property {string} id
 * @property {number} tileScale display pixels per symbol bit
 * @property {number} gutter dark pixels between adjacent tiles
 * @property {number} width render target width (NOT the panel width)
 * @property {number} height render target height
 * @property {number} margin quiet-zone width, in cells
 * @property {number} anchorSize corner anchor edge, in cells
 * @property {number} pxPerTileAt720 measured capture px per tile, 720p camera
 * @property {number} blurTolerance capture-pixel PSF sigma to select this rung at
 * @property {number} measuredCliff largest sigma that still decodes, 720p
 */

/**
 * A ladder, not a menu.
 *
 * Every profile uses an 8 px tile and a 1 px gutter - the tile because a
 * symbol needs roughly one capture pixel per glyph cell to survive, and the
 * gutter because widening it measurably makes things WORSE as well as smaller.
 * (Blur roughly conserves energy locally: a densely packed grid holds its mean
 * level while a sparse one bleeds into dark gutters and biases the threshold
 * high. Measured at sigma 1.4: 0.8% symbol errors at gutter 1, 5.1% at
 * gutter 3.)
 *
 * So the only thing that varies is how many cells there are, which sets how
 * many capture pixels each tile gets, which is the single knob trading
 * throughput against blur tolerance:
 *
 *   rung     payload   KB/s@15fps |  720p camera        1080p camera
 *                                 |  px/tile  cliff     px/tile  cliff
 *   far       2065 B      30      |   12.5     2.2       18.7     2.4
 *   soft      3442 B      50      |    9.8     1.6       14.8     2.4
 *   normal    5622 B      82      |    7.8     1.4       11.7     2.0
 *   dense     8682 B     127      |    6.3     1.0        9.5     1.6
 *   max      13043 B     191      |    5.2     0.6        7.8     1.4
 *
 * `cliff` is the largest capture-pixel PSF sigma at which a whole frame still
 * decodes, measured end to end through the offline harness against a capture
 * carrying vignetting, noise, keystone, white-balance drift and a half-pixel
 * offset. `measuredCliff` records the 720p column.
 *
 * The 720p column was re-swept after the colour decision was moved onto
 * thresholds taken from the frame rather than the ideal palette's constants
 * (see palette.js). Only `far` moved, from 2.0 to 2.2; the other four rungs
 * measured exactly where they already sat. The 1080p column was NOT re-swept
 * and is still the original measurement, so it now understates the top rung by
 * at least as much as the 720p column did.
 *
 * `blurTolerance` is deliberately ONE STEP BELOW the cliff, and that is the
 * number anything automatic should use. At the cliff itself a rung sits right
 * on the frame error budget - `normal` at sigma 1.4 measures about 1.9% symbol
 * errors against a budget near 2% - so it decodes or does not depending on
 * details as small as a 0.05 change in vignetting. A rung selected at its
 * cliff would oscillate; selected at its tolerance it holds.
 *
 * `normal` is the default: safe on a 720p camera and comfortable on a 1080p
 * one. The 1080p column is the whole argument for the back channel - a
 * receiver with a 1080p camera can run `max` at a defocus tolerance `normal`
 * only just manages at 720p, a 2.3x throughput difference the sender cannot
 * possibly guess on its own.
 *
 * Note what the table does NOT say. There is no cliff in px/tile. The symbol
 * set's own margin goes negative below about 8 capture pixels per tile, but
 * only when the sample points are half a pixel out - and per-cell drift
 * refinement gets the residual well below that, which is what makes the bottom
 * two rungs usable at all. Take drift refinement away and the ladder loses its
 * lower half.
 *
 * The ladder is meant to be climbed at runtime: the receiver measures px/tile
 * and mean confidence and reports them over the back channel, and the sender
 * moves a rung. That is the whole reason the format carries a self-describing
 * header - the receiver has to be able to follow a change it did not ask for.
 */
export const PROFILES = [
  { id: 'far', tileScale: 1, gutter: 1, width: 756, height: 425, margin: 1, anchorSize: 7, pxPerTileAt720: 12.5, blurTolerance: 2.0, measuredCliff: 2.2 },
  { id: 'soft', tileScale: 1, gutter: 1, width: 954, height: 537, margin: 1, anchorSize: 7, pxPerTileAt720: 9.8, blurTolerance: 1.4, measuredCliff: 1.6 },
  { id: 'normal', tileScale: 1, gutter: 1, width: 1200, height: 675, margin: 1, anchorSize: 7, pxPerTileAt720: 7.8, blurTolerance: 1.2, measuredCliff: 1.4 },
  { id: 'dense', tileScale: 1, gutter: 1, width: 1476, height: 830, margin: 1, anchorSize: 7, pxPerTileAt720: 6.3, blurTolerance: 0.8, measuredCliff: 1.0 },
  { id: 'max', tileScale: 1, gutter: 1, width: 1800, height: 1012, margin: 1, anchorSize: 7, pxPerTileAt720: 5.2, blurTolerance: 0.6, measuredCliff: 0.6 },
]

/** Rungs in ascending payload order, which is descending robustness. */
export const LADDER = ['far', 'soft', 'normal', 'dense', 'max']

export const DEFAULT_PROFILE = 'normal'

/** Profile id -> index, which is what travels in the 4-bit header field. */
export const profileIndex = (id) => PROFILES.findIndex((p) => p.id === id)

const layouts = new Map()

/**
 * The full derived layout for a profile. Computed once and cached: it involves
 * building a few tables of tens of thousands of entries, and every frame on
 * both sides needs the same ones.
 */
export function layoutFor(id = DEFAULT_PROFILE) {
  const cached = layouts.get(id)
  if (cached) return cached

  const profile = PROFILES.find((p) => p.id === id)
  if (!profile) throw new Error(`Unknown grid profile: ${id}`)

  const { tileScale, gutter, width, height, margin, anchorSize } = profile
  const tile = TILE_BITS * tileScale
  const pitch = tile + gutter

  const cols = Math.floor(width / pitch) - margin * 2
  const rows = Math.floor(height / pitch) - margin * 2
  if (cols < anchorSize * 2 + HEADER_N || rows < anchorSize * 2 + 2) {
    throw new Error(`Grid profile ${id} is too small to hold its own anchors`)
  }

  // 0 data, 1 anchor, 2 header. Anchors and header are claimed first; whatever
  // is left over, in raster order, is the payload.
  const role = new Uint8Array(cols * rows)

  const corners = [
    { name: 'tl', ax: 0, ay: 0, hx: 0, hy: anchorSize },
    { name: 'tr', ax: cols - anchorSize, ay: 0, hx: cols - HEADER_N, hy: anchorSize },
    { name: 'bl', ax: 0, ay: rows - anchorSize, hx: 0, hy: rows - anchorSize - 1 },
    {
      name: 'br',
      ax: cols - anchorSize,
      ay: rows - anchorSize,
      hx: cols - HEADER_N,
      hy: rows - anchorSize - 1,
    },
  ]

  const headerStrips = []
  for (const corner of corners) {
    for (let y = 0; y < anchorSize; y++) {
      for (let x = 0; x < anchorSize; x++) {
        role[(corner.ay + y) * cols + corner.ax + x] = 1
      }
    }
    const strip = new Int32Array(HEADER_N)
    for (let i = 0; i < HEADER_N; i++) {
      const index = corner.hy * cols + corner.hx + i
      role[index] = 2
      strip[i] = index
    }
    headerStrips.push({ corner: corner.name, cells: strip })
  }

  // Data cells in raster order. Index into this array is the "data slot", and
  // the interleave is expressed purely in slot space - geometry never appears
  // in the codeword arithmetic.
  const dataCells = []
  for (let i = 0; i < role.length; i++) {
    if (role[i] === 0) dataCells.push(i)
  }

  const codewordCount = Math.floor(dataCells.length / N)
  const usedSlots = codewordCount * N
  const dataSymbols = codewordCount * K

  // Data slots quadrant by quadrant - TL, TR, BL, BR - each in raster order.
  const quadrants = Array.from({ length: PARTITIONS }, () => [])
  for (let slot = 0; slot < dataCells.length; slot++) {
    const x = dataCells[slot] % cols
    const y = (dataCells[slot] / cols) | 0
    quadrants[(y >= rows / 2 ? 2 : 0) + (x >= cols / 2 ? 1 : 0)].push(slot)
  }
  const order = quadrants.flat()

  // Codeword ranges, cut where each quadrant's cells run out.
  const partitionCuts = [0]
  let before = 0
  for (let q = 1; q < PARTITIONS; q++) {
    before += quadrants[q - 1].length
    partitionCuts.push(Math.min(codewordCount, Math.round(before / N)))
  }
  partitionCuts.push(codewordCount)

  // Symbol index (c * N + s) <-> data slot: a seeded shuffle within each
  // quadrant's range, seeded from the profile id and the quadrant, so it is
  // reproducible from the header alone and identical on both ends without
  // either transmitting it.
  const position = new Int32Array(usedSlots)
  for (let i = 0; i < usedSlots; i++) position[i] = i
  for (let q = 0; q < PARTITIONS; q++) {
    let seed = mix32(q + 1)
    for (let i = 0; i < id.length; i++) seed = mix32(seed ^ id.charCodeAt(i))
    const next = seeded(seed)
    const start = partitionCuts[q] * N
    const end = partitionCuts[q + 1] * N
    for (let i = end - 1; i > start; i--) {
      const j = start + Math.floor(next() * (i - start + 1))
      const t = position[i]
      position[i] = position[j]
      position[j] = t
    }
  }
  const slotOfSymbol = new Int32Array(usedSlots)
  // Sized to every data slot: the spare ones sit at the end of `order`, which
  // is not the end of raster order, so they are marked rather than implied.
  const symbolAtSlot = new Int32Array(dataCells.length).fill(-1)
  for (let i = 0; i < usedSlots; i++) {
    slotOfSymbol[i] = order[position[i]]
    symbolAtSlot[slotOfSymbol[i]] = i
  }
  // 6 bits per symbol, and the payload is a whole number of bytes.
  const payloadBytes = Math.floor((dataSymbols * 6) / 8)

  const layout = {
    profile,
    id,
    tile,
    pitch,
    cols,
    rows,
    /** Anchor edge in cells, and its pixel edge. */
    anchorSize,
    anchorPixels: anchorSize * pitch,
    /** Pixel offset of cell (0,0) from the render target's top-left. */
    originX: margin * pitch,
    originY: margin * pitch,
    role,
    headerStrips,
    dataCells: Int32Array.from(dataCells),
    /** Slots past the last whole codeword. Painted dark and ignored. */
    spareSlots: dataCells.length - usedSlots,
    codewordCount,
    dataSymbols,
    payloadBytes,
    slotOfSymbol,
    symbolAtSlot,
    /** First codeword of each quadrant's range, then the codeword count. */
    partitionCuts,
    /** Pixel size of the whole code, excluding the quiet zone. */
    codeWidth: cols * pitch,
    codeHeight: rows * pitch,
  }

  layouts.set(id, layout)
  return layout
}

/** Data slot carrying symbol `s` of codeword `c`. */
export const slotFor = (layout, c, s) => layout.slotOfSymbol[c * N + s]

/** Inverse of slotFor: which codeword and symbol a data slot carries, or null for a spare slot. */
export function codewordFor(layout, slot) {
  const packed = layout.symbolAtSlot[slot]
  if (packed < 0) return null
  return { codeword: (packed / N) | 0, symbol: packed % N }
}

/** Cell (x, y) for a data slot. */
export function cellFor(layout, slot) {
  const raster = layout.dataCells[slot]
  return { x: raster % layout.cols, y: Math.floor(raster / layout.cols) }
}

/**
 * Anchor bitmaps, as `anchorSize` x `anchorSize` cell patterns.
 *
 * Three corners carry a ring with a solid centre; the bottom-right carries a
 * ring with a single dot. That asymmetry is what makes orientation
 * unambiguous - without it a code read upside down decodes to noise, and the
 * receiver has no way to tell that rotation was the problem.
 *
 * Anchors are painted white, which is not a palette colour, so the detector
 * never has to distinguish an anchor from a bright data cell.
 */
export function anchorPattern(size, orientation = false) {
  const grid = new Uint8Array(size * size)
  const set = (x, y) => {
    grid[y * size + x] = 1
  }

  for (let i = 0; i < size; i++) {
    set(i, 0)
    set(i, size - 1)
    set(0, i)
    set(size - 1, i)
  }

  if (orientation) {
    set((size - 1) / 2 | 0, (size - 1) / 2 | 0)
  } else {
    for (let y = 2; y < size - 2; y++) {
      for (let x = 2; x < size - 2; x++) set(x, y)
    }
  }
  return grid
}

/** The four anchor positions in cell coordinates, in a fixed order. */
export function anchorCorners(layout) {
  const { cols, rows, anchorSize: a } = layout
  return [
    { name: 'tl', x: 0, y: 0, orientation: false },
    { name: 'tr', x: cols - a, y: 0, orientation: false },
    { name: 'bl', x: 0, y: rows - a, orientation: false },
    { name: 'br', x: cols - a, y: rows - a, orientation: true },
  ]
}

// -------------------------------------------------------------- cell values

/**
 * A cell's six bits split as `colour << 4 | symbol`.
 *
 * The split is only a convention for moving values between the renderer and
 * the classifier - the error correction never sees it, because all six bits
 * are one GF(64) symbol. That is worth restating because it is the reason the
 * split can be chosen for clarity rather than for bit-distance properties.
 */
export const SYMBOL_MASK = 0x0f
export const COLOUR_SHIFT = 4

export const symbolOf = (value) => value & SYMBOL_MASK
export const colourOf = (value) => (value >> COLOUR_SHIFT) & 0x03
export const valueOf = (symbol, colour) => ((colour & 0x03) << COLOUR_SHIFT) | (symbol & SYMBOL_MASK)

/**
 * Capture pixels per tile, given how tall the code appears in the capture.
 *
 * This is the number the aiming guidance shows the user, because it is what
 * decides how much defocus the current rung can absorb - see the ladder above
 * for the measured relationship. It is also what selects a rung: the sender
 * moves up while the receiver reports px/tile above the rung's requirement.
 *
 * @param {object} layout
 * @param {number} codeHeightPx how many capture pixels the code spans vertically
 */
export function pxPerTile(layout, codeHeightPx) {
  const pxPerCell = codeHeightPx / layout.rows
  return pxPerCell * (layout.tile / layout.pitch)
}

/**
 * The reference viewing condition the profile table's numbers are quoted at.
 *
 * Every px/tile figure in this file, and every blur tolerance, is measured
 * here. Quoting them without a stated condition is meaningless - px/tile
 * depends on the camera and on how much of its frame the code fills - and
 * having two slightly different definitions of "fills the frame" in the tests
 * and in the table is how a profile ends up advertising a number it cannot
 * deliver.
 */
export const REFERENCE_CAPTURE = { width: 1280, height: 720, fill: 0.9 }

/**
 * How many capture pixels tall the code appears, for a given camera and fill.
 *
 * The code is letterboxed to fit, so at a wider-than-16:9 aspect it is the
 * WIDTH that limits and the height comes out below `fill * captureHeight`.
 * Assuming otherwise overstates px/tile by about 5%, which is enough to make a
 * rung look like it clears a threshold it does not.
 */
export function codeHeightIn(layout, capture = REFERENCE_CAPTURE) {
  const aspect = layout.codeWidth / layout.codeHeight
  const width = Math.min(capture.width * capture.fill, capture.height * capture.fill * aspect)
  return width / aspect
}

/** Capture pixels per tile under a given viewing condition. */
export function pxPerTileAt(layout, capture = REFERENCE_CAPTURE) {
  return pxPerTile(layout, codeHeightIn(layout, capture))
}
