/**
 * Grid geometry and the generated symbol set.
 *
 * Nothing here is clever; it is all the sort of thing that is obviously true
 * until an off-by-one in the anchor layout silently steals forty data cells and
 * every frame decodes to nonsense with no clue as to why.
 */

import {
  PROFILES,
  LADDER,
  DEFAULT_PROFILE,
  pxPerTile,
  pxPerTileAt,
  REFERENCE_CAPTURE,
  HEADER_N,
  HEADER_K,
  layoutFor,
  slotFor,
  codewordFor,
  cellFor,
  anchorPattern,
  anchorCorners,
  profileIndex,
} from '../src/optical/airblock/grid.js'
import { N, K } from '../src/optical/airblock/rs64.js'
import {
  SYMBOL_BITMAPS,
  SYMBOL_HASHES,
  SYMBOL_COUNT,
  SYMBOL_BITS,
  SYMBOL_INK,
  GLYPH_BITS,
  MIN_CRISP_DISTANCE,
  WORST_BLURRED_MARGIN,
  PX_PER_TILE_RANGE,
} from '../src/optical/airblock/symbols.js'

let failures = 0
const check = (label, ok, detail = '') => {
  if (ok) return
  failures++
  console.log(`   FAIL ${label}${detail ? ` - ${detail}` : ''}`)
}

// ------------------------------------------------------------------ symbols --

check('16 symbols', SYMBOL_COUNT === 16, String(SYMBOL_COUNT))
check('16 bitmaps', SYMBOL_BITMAPS.length === 16)
check('16 hashes', SYMBOL_HASHES.length === 16)

// Ink fraction is load-bearing: the receiver's local box mean is only a valid
// threshold because every symbol lights about half its tile.
for (let i = 0; i < SYMBOL_COUNT; i++) {
  const bits = SYMBOL_BITMAPS[i]
  check(`symbol ${i} is 64 bits`, bits.length === 64, String(bits.length))
  check(`symbol ${i} is binary`, bits.every((b) => b === 0 || b === 1))
  const ink = bits.reduce((a, b) => a + b, 0) / 64
  check(`symbol ${i} ink near half`, ink >= 0.42 && ink <= 0.58, ink.toFixed(3))
  check(`symbol ${i} ink recorded`, Math.abs(ink - SYMBOL_INK[i]) < 1e-6)
}

const popcount = (v) => {
  v = v - ((v >>> 1) & 0x55555555)
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333)
  v = (v + (v >>> 4)) & 0x0f0f0f0f
  return (v * 0x01010101) >>> 24
}
const hamming = (a, b) => popcount(a[0] ^ b[0]) + popcount(a[1] ^ b[1])

{
  let min = Infinity
  const collisions = []
  for (let i = 0; i < SYMBOL_COUNT; i++) {
    for (let j = i + 1; j < SYMBOL_COUNT; j++) {
      const d = hamming(SYMBOL_HASHES[i], SYMBOL_HASHES[j])
      if (d === 0) collisions.push(`${i}=${j}`)
      min = Math.min(min, d)
    }
  }
  check('no two symbols share a hash', collisions.length === 0, collisions.join(','))
  check('crisp separation matches the generator', min === MIN_CRISP_DISTANCE, `${min} vs ${MIN_CRISP_DISTANCE}`)
  // A quarter of the hash width. Below this the classifier has no room for the
  // blur and misalignment the channel actually applies.
  check('crisp separation is at least 16 bits', min >= 16, String(min))
}

// The generator's own worst case, carried into the source so a regeneration
// that quietly makes the set worse fails here rather than on a phone.
check('blurred margin at least 12 bits', WORST_BLURRED_MARGIN >= 12, String(WORST_BLURRED_MARGIN))

/**
 * Every symbol must be a 4x4 glyph upsampled 2x, so each glyph cell is two
 * render pixels rather than one.
 *
 * This is the single change that made the format decodable at a realistic
 * camera PSF, and it is not self-evident from looking at the bitmaps - a
 * regenerated set that lost the constraint would look fine, pass every other
 * check here, and fail on hardware at 8% symbol errors. So it is asserted
 * structurally: within each 2x2 block, all four bits agree.
 */
{
  const factor = SYMBOL_BITS / GLYPH_BITS
  check('glyph upsample factor is an integer', Number.isInteger(factor), String(factor))
  let broken = 0
  for (let i = 0; i < SYMBOL_COUNT; i++) {
    const bits = SYMBOL_BITMAPS[i]
    for (let gy = 0; gy < GLYPH_BITS; gy++) {
      for (let gx = 0; gx < GLYPH_BITS; gx++) {
        const first = bits[gy * factor * SYMBOL_BITS + gx * factor]
        for (let dy = 0; dy < factor; dy++) {
          for (let dx = 0; dx < factor; dx++) {
            if (bits[(gy * factor + dy) * SYMBOL_BITS + gx * factor + dx] !== first) broken++
          }
        }
      }
    }
  }
  check('symbols are low-frequency 4x4 glyphs', broken === 0, `${broken} stray bit(s)`)
}

check('classifier floor is recorded', PX_PER_TILE_RANGE[0] >= 8, String(PX_PER_TILE_RANGE[0]))

// ------------------------------------------------------------------- layout --

for (const profile of PROFILES) {
  const layout = layoutFor(profile.id)
  const label = profile.id
  const cellCount = layout.cols * layout.rows

  check(`${label} profile index round-trips`, PROFILES[profileIndex(label)].id === label)
  check(`${label} pitch`, layout.pitch === profile.tileScale * 8 + profile.gutter)
  check(`${label} code fits the panel`, layout.codeWidth + layout.originX * 2 <= profile.width + layout.pitch)

  // Every cell has exactly one role.
  let anchors = 0
  let headers = 0
  let data = 0
  for (const role of layout.role) {
    if (role === 1) anchors++
    else if (role === 2) headers++
    else data++
  }
  check(`${label} anchor cells`, anchors === 4 * profile.anchorSize ** 2, String(anchors))
  check(`${label} header cells`, headers === 4 * HEADER_N, String(headers))
  check(`${label} roles account for every cell`, anchors + headers + data === cellCount)
  check(`${label} data cell list matches`, layout.dataCells.length === data)

  // Header strips must not have landed on top of an anchor.
  for (const strip of layout.headerStrips) {
    for (const raster of strip.cells) {
      check(`${label} header ${strip.corner} clear of anchors`, layout.role[raster] === 2)
    }
  }

  // Anchors must not have landed on top of each other.
  const corners = anchorCorners(layout)
  check(`${label} four anchors`, corners.length === 4)
  check(`${label} exactly one orientation anchor`, corners.filter((c) => c.orientation).length === 1)
  for (let i = 0; i < corners.length; i++) {
    for (let j = i + 1; j < corners.length; j++) {
      const a = corners[i]
      const b = corners[j]
      const overlap =
        Math.abs(a.x - b.x) < profile.anchorSize && Math.abs(a.y - b.y) < profile.anchorSize
      check(`${label} anchors ${a.name}/${b.name} disjoint`, !overlap)
    }
  }

  // The interleave must be a bijection over the slots it claims. If it is not,
  // two codewords share a cell and both are lost.
  const used = new Int32Array(layout.dataCells.length).fill(-1)
  let clashes = 0
  for (let c = 0; c < layout.codewordCount; c++) {
    for (let s = 0; s < N; s++) {
      const slot = slotFor(layout, c, s)
      check(`${label} slot in range`, slot >= 0 && slot < used.length, String(slot))
      if (used[slot] !== -1) clashes++
      used[slot] = c * N + s
      const back = codewordFor(layout, slot)
      check(`${label} slot inverts`, back.codeword === c && back.symbol === s, `slot ${slot}`)
    }
  }
  check(`${label} interleave is a bijection`, clashes === 0, `${clashes} clash(es)`)

  /**
   * Spread: consecutive symbols of one codeword should be far apart on the
   * panel. That is the entire point of interleaving, so the stride arithmetic
   * is worth checking rather than assuming.
   *
   * Asserted on the mean and on how often pairs land adjacent, not on a hard
   * minimum. The data-cell list skips the anchors and the header strips, so
   * the raster stride distorts near the corners and a handful of consecutive
   * symbols do end up neighbours. That costs a burst there two symbols of one
   * codeword instead of one, which twelve parity symbols absorb without
   * noticing; a systematically small stride would not be, and is what this
   * catches.
   */
  {
    let totalGap = 0
    let pairs = 0
    let adjacent = 0
    for (let c = 0; c < layout.codewordCount; c += Math.max(1, layout.codewordCount >> 4)) {
      for (let sym = 0; sym + 1 < N; sym++) {
        const a = cellFor(layout, slotFor(layout, c, sym))
        const b = cellFor(layout, slotFor(layout, c, sym + 1))
        const gap = Math.abs(a.y - b.y) + Math.abs(a.x - b.x)
        totalGap += gap
        pairs++
        if (gap <= 1) adjacent++
      }
    }
    const mean = totalGap / pairs
    check(`${label} codeword symbols are spread`, mean > 10, `mean gap ${mean.toFixed(1)}`)
    check(
      `${label} adjacent pairs are rare`,
      adjacent / pairs < 0.05,
      `${((adjacent / pairs) * 100).toFixed(1)}%`,
    )
  }

  check(`${label} at least one codeword`, layout.codewordCount >= 1)
  check(`${label} spare slots under a codeword`, layout.spareSlots < N, String(layout.spareSlots))
  check(
    `${label} payload matches codewords`,
    layout.payloadBytes === Math.floor((layout.codewordCount * K * 6) / 8),
  )
}

/**
 * The ladder must be monotonic, and the default must be the densest rung that
 * still clears the classifier's px/tile floor on the camera it targets.
 *
 * Choosing a denser rung than that on arithmetic alone is the trap: below 8
 * capture px per tile the nearest wrong symbol is closer than the right one,
 * so the failure is silent and total rather than gradual.
 */
{
  check('ladder covers every profile', LADDER.length === PROFILES.length)
  for (let i = 1; i < LADDER.length; i++) {
    const lower = layoutFor(LADDER[i - 1])
    const higher = layoutFor(LADDER[i])
    check(
      `ladder ${LADDER[i - 1]} -> ${LADDER[i]} gains payload`,
      higher.payloadBytes > lower.payloadBytes,
    )
    check(
      `ladder ${LADDER[i - 1]} -> ${LADDER[i]} loses px/tile`,
      pxPerTileAt(higher) < pxPerTileAt(lower),
    )
  }

  check('default is normal', DEFAULT_PROFILE === 'normal')

  // Blur tolerance must fall as payload rises. A rung offering both would make
  // the rung below it pointless.
  for (let i = 1; i < LADDER.length; i++) {
    const lower = PROFILES.find((p) => p.id === LADDER[i - 1])
    const higher = PROFILES.find((p) => p.id === LADDER[i])
    check(
      `ladder ${lower.id} -> ${higher.id} trades blur tolerance for payload`,
      higher.blurTolerance <= lower.blurTolerance,
      `${higher.blurTolerance} vs ${lower.blurTolerance}`,
    )
  }

  // The default should not be leaning on drift refinement succeeding: it wants
  // to sit at or near the px/tile range the symbol set was annealed against,
  // on the camera it targets.
  const def = layoutFor(DEFAULT_PROFILE)
  check(
    'default does not depend on perfect alignment at 720p',
    pxPerTileAt(def) >= PX_PER_TILE_RANGE[0] * 0.95,
    pxPerTileAt(def).toFixed(1),
  )
  // Every profile must record a px/tile consistent with what it actually is.
  for (const profile of PROFILES) {
    const measured = pxPerTileAt(layoutFor(profile.id), REFERENCE_CAPTURE)
    check(
      `${profile.id} records its px/tile`,
      Math.abs(measured - profile.pxPerTileAt720) < 0.6,
      `${measured.toFixed(1)} vs ${profile.pxPerTileAt720}`,
    )
  }
}

// ------------------------------------------------------------------ anchors --

{
  const plain = anchorPattern(7, false)
  const oriented = anchorPattern(7, true)
  check('anchor is 7x7', plain.length === 49)

  // Both must have a complete border, or the detector has no edge to lock to.
  for (let i = 0; i < 7; i++) {
    for (const grid of [plain, oriented]) {
      check('anchor border complete', grid[i] === 1 && grid[42 + i] === 1)
      check('anchor border complete', grid[i * 7] === 1 && grid[i * 7 + 6] === 1)
    }
  }

  const litPlain = plain.reduce((a, b) => a + b, 0)
  const litOriented = oriented.reduce((a, b) => a + b, 0)
  check('orientation anchor is distinguishable', litPlain !== litOriented, `${litPlain} vs ${litOriented}`)
  // Comfortably distinguishable, not marginally: this decision is made on a
  // blurred capture before any geometry is known.
  check('orientation difference is large', Math.abs(litPlain - litOriented) >= 6, String(Math.abs(litPlain - litOriented)))
}

check('header code is generous', HEADER_N - HEADER_K >= 8, `${HEADER_N - HEADER_K} parity`)

console.log(failures ? `airblock-layout: ${failures} check(s) failed` : 'airblock-layout: geometry and symbol set are sound')
process.exitCode = failures ? 1 : 0
