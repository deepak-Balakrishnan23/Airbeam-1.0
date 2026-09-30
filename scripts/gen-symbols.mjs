/**
 * Generate the 16 symbol tiles by simulated annealing.
 *
 * Hand-picking a set - drawing a few dozen candidates and keeping the sixteen
 * that perform best together - gives no assurance that a better set does not
 * exist. This searches for one instead.
 *
 * What is actually being maximised is the *classifier margin*, not raw Hamming
 * distance between bitmaps. A tile arrives at the camera blurred and slightly
 * misaligned, gets hashed, and is matched against the canonical hashes. What
 * decides whether that match is right is
 *
 *     margin(i, v) = min_{j != i} H(hash_v(i), hash_0(j)) - H(hash_v(i), hash_0(i))
 *
 * over every degradation `v` the channel plausibly applies. A set with huge
 * clean separation and no margin under blur is worthless; this objective
 * cannot be fooled that way.
 *
 * Two constraints ride along:
 *
 *   - ink fraction pinned near 1/2 for every symbol. That is what makes the
 *     receiver's 15x15-cell local box mean a valid per-cell threshold with no
 *     occupancy estimate. Without it the threshold has to guess what fraction
 *     of the neighbourhood was lit, and the whole local-threshold win erodes.
 *   - no symbol may be a shifted copy of another, since drift refinement moves
 *     the sample window by up to +/-7 px and would turn that into a coin flip.
 *
 * Run with: npm run symbols
 */

import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
// Deterministic, so a regenerated set is byte-identical.
import { seeded } from '../src/lib/random.js'

const BITS = 8 // tile is BITS x BITS render pixels, and the hash is BITS^2 wide

/**
 * Logical resolution of a glyph, before it is upsampled to fill the tile.
 *
 * This is the lever that made the design work, and it is worth spelling out
 * because the obvious alternative is worse.
 *
 * A tile is 8 render pixels across. Search over 64 free bits and one bit is
 * one render pixel, so a camera PSF of one pixel - utterly ordinary - smears
 * adjacent bits together and the pattern is gone. Measured: 8% symbol errors
 * at sigma 1.0 render px, 57% at 1.4, and widening the gutter changed nothing,
 * which ruled out inter-cell bleed and pointed inside the tile.
 *
 * Annealing with realistic blur in the objective helped (57% -> 27%) but not
 * enough, because random bit swaps almost never wander into the small
 * low-frequency corner of a 64-bit space.
 *
 * So the space itself is constrained: a glyph is 4x4, upsampled 2x. Each glyph
 * cell is 2 render pixels, so the same one-pixel PSF is half a cell rather
 * than a whole one. The payload does not change at all - still 4 bits of
 * symbol per tile - and the hash is still 64 bits wide, because the upsampled
 * glyph fills the same 8x8 grid.
 *
 * The alternative was to keep 64 free bits and make the tile 16 render pixels,
 * which buys the same robustness and costs three quarters of the cells.
 */
const GLYPH = 4
const UPSAMPLE = BITS / GLYPH
const COUNT = 16 // 4 bits per tile
const FIELD = 40 // supersampled tile size; divisible by 8 and by enough of PX_PER_TILE
const INK_MIN = 0.42
const INK_MAX = 0.58

// --------------------------------------------------------- capture model ---

/**
 * The actual chain a tile goes through, modelled end to end.
 *
 * The first version of this file modelled "blur" as a Gaussian of up to 0.8
 * bit widths and produced a set that fell apart in the offline harness. The
 * reason is that defocus is not the dominant low-pass here - RESAMPLING is. A
 * tile is 8 render pixels across; a 1920-wide panel captured at 1280 puts that
 * into about five capture pixels, so the receiver reads an 8x8 bitmap through
 * a five-pixel-wide aperture. That is a far heavier filter than any plausible
 * defocus, and it is unavoidable, so it belongs in the model rather than in
 * the list of things that go wrong later.
 *
 * The chain, in order:
 *
 *   1. the bitmap, upsampled to a FIELD x FIELD supersampled tile
 *   2. optional Gaussian defocus, in field pixels
 *   3. each of the receiver's 64 sample points reads ONE capture pixel, which
 *      is an area average of the field over (FIELD/pxPerTile)^2 - this is the
 *      resampling step, and it is what limits how much of an 8x8 pattern
 *      survives
 *   4. a sub-pixel offset on those sample points, in capture pixels
 *   5. threshold at the mean of the 64 samples
 *
 * Step 3 composes the downsample and the receiver's bilinear read into a
 * single box average, which is both faithful and cheap enough to anneal on.
 */

/**
 * Capture pixels across one tile, for the objective.
 *
 * An 8x8 bitmap needs about one capture pixel per bit. Below that, adjacent
 * bit centres share a capture pixel and a half-pixel misalignment moves most
 * of a bit rather than a fraction of one. Measured: at 5 px/tile the worst
 * margin is NEGATIVE - the wrong symbol sits closer than the right one, which
 * no amount of annealing repairs, because the information is not there to
 * begin with.
 *
 * So the objective covers 6 to 12 and the grid profiles are sized to stay
 * inside it. 5 is still reported below as a diagnostic, because knowing where
 * the cliff is matters more than pretending it is elsewhere.
 */
const PX_PER_TILE = [8, 12]

/** Reported but not optimised - this is the cliff edge. */
const DIAGNOSTIC_PX_PER_TILE = [5, 6]

/**
 * Defocus, in BIT WIDTHS - the units that matter.
 *
 * This is the correction that made the difference. The first model expressed
 * defocus in supersampled field pixels, which worked out to about 0.3 of a bit
 * width: mild enough that the annealer was free to produce high-spatial-
 * frequency patterns, which is what maximising Hamming distance on a
 * half-lit bitmap naturally does.
 *
 * The real channel is nothing like that mild. A tile is 8 render pixels across
 * for 8 bits, so one bit IS one render pixel, and a camera PSF of one to one
 * and a half pixels smears ADJACENT BITS WITHIN THE TILE together. Measured
 * against the high-frequency set: 0.01% symbol errors at sigma 0.6 render px,
 * 8% at 1.0, 57% at 1.4. Widening the gutter did not help at all, which is
 * what ruled out inter-cell bleed and pointed at the tile's own interior.
 *
 * So defocus is modelled at up to 1.2 bit widths, which forces the search into
 * low-frequency shapes - large connected strokes rather than fine texture.
 * That is, not coincidentally, what a hand-drawn glyph set looks like: a person
 * draws strokes rather than texture, and strokes are what survive a real lens.
 */
const SIGMAS_IN_BITS = [0, 0.6, 1.2]
const SIGMAS = SIGMAS_IN_BITS.map((sigma) => (sigma * FIELD) / BITS)

/**
 * Sub-pixel sample offsets, in capture pixels.
 *
 * One search step of the sampler's drift refinement, which is the residual a
 * cell that refined successfully should be left with. Larger offsets were
 * tried and are hopeless below 8 px/tile - half a capture pixel at 6 px/tile
 * is most of a bit - which is what set the px/tile floor rather than the other
 * way round.
 */
const SHIFTS = [
  [0, 0],
  [0.35, 0],
  [0, 0.35],
  [0.35, 0.35],
]

const VARIANTS = []
for (const pxPerTile of PX_PER_TILE) {
  for (const sigma of SIGMAS) {
    for (const [dx, dy] of SHIFTS) {
      VARIANTS.push({ pxPerTile, sigma, dx, dy })
    }
  }
}

/** Variants reported after the search but excluded from the objective. */
const DIAGNOSTIC_VARIANTS = []
for (const pxPerTile of DIAGNOSTIC_PX_PER_TILE) {
  for (const sigma of SIGMAS) {
    for (const [dx, dy] of SHIFTS) {
      DIAGNOSTIC_VARIANTS.push({ pxPerTile, sigma, dx, dy })
    }
  }
}

function gaussianKernel(sigma) {
  if (sigma <= 0) return null
  const radius = Math.max(1, Math.ceil(sigma * 3))
  const k = new Float64Array(radius * 2 + 1)
  let sum = 0
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma))
    k[i + radius] = v
    sum += v
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum
  return { k, radius }
}

const KERNELS = new Map(SIGMAS.map((sigma) => [sigma, gaussianKernel(sigma)]))

/** Upsample a GLYPH x GLYPH pattern to the BITS x BITS tile it is drawn as. */
function expand(glyph) {
  const out = new Uint8Array(BITS * BITS)
  for (let y = 0; y < BITS; y++) {
    for (let x = 0; x < BITS; x++) {
      out[y * BITS + x] = glyph[((y / UPSAMPLE) | 0) * GLYPH + ((x / UPSAMPLE) | 0)]
    }
  }
  return out
}

/** Nearest-neighbour upsample of the tile bitmap to the supersampled field. */
function render(bitmap) {
  const out = new Float64Array(FIELD * FIELD)
  const scale = FIELD / BITS
  for (let y = 0; y < FIELD; y++) {
    const sy = Math.floor(y / scale)
    for (let x = 0; x < FIELD; x++) {
      out[y * FIELD + x] = bitmap[sy * BITS + Math.floor(x / scale)]
    }
  }
  return out
}

function blur(field, sigma) {
  const kernel = KERNELS.get(sigma)
  if (!kernel) return field
  const { k, radius } = kernel
  const tmp = new Float64Array(FIELD * FIELD)
  const out = new Float64Array(FIELD * FIELD)

  for (let y = 0; y < FIELD; y++) {
    for (let x = 0; x < FIELD; x++) {
      let acc = 0
      for (let i = -radius; i <= radius; i++) {
        acc += field[y * FIELD + Math.min(FIELD - 1, Math.max(0, x + i))] * k[i + radius]
      }
      tmp[y * FIELD + x] = acc
    }
  }
  for (let y = 0; y < FIELD; y++) {
    for (let x = 0; x < FIELD; x++) {
      let acc = 0
      for (let i = -radius; i <= radius; i++) {
        acc += tmp[Math.min(FIELD - 1, Math.max(0, y + i)) * FIELD + x] * k[i + radius]
      }
      out[y * FIELD + x] = acc
    }
  }
  return out
}

/**
 * Read the 64 sample points a receiver would read, and hash them.
 *
 * Each sample is the mean of the field over one capture pixel's footprint,
 * centred on the bit centre plus the sub-pixel offset. Neighbouring bit
 * centres are `pxPerTile / 8` capture pixels apart, so at pxPerTile 5 several
 * sample points share a capture pixel - the hash genuinely carries less than
 * 64 bits of information, and the objective has to work with that rather than
 * pretend otherwise.
 */
function observedHash(field, { pxPerTile, dx, dy }) {
  const perCapturePixel = FIELD / pxPerTile
  const half = perCapturePixel / 2
  const samples = new Float64Array(64)
  let total = 0

  for (let by = 0; by < BITS; by++) {
    for (let bx = 0; bx < BITS; bx++) {
      // Bit centre in capture pixels, offset, then back into field pixels.
      const cxCapture = ((bx + 0.5) / BITS) * pxPerTile + dx
      const cyCapture = ((by + 0.5) / BITS) * pxPerTile + dy
      const cx = cxCapture * perCapturePixel
      const cy = cyCapture * perCapturePixel

      let acc = 0
      let count = 0
      for (let y = Math.floor(cy - half); y < Math.ceil(cy + half); y++) {
        if (y < 0 || y >= FIELD) continue
        for (let x = Math.floor(cx - half); x < Math.ceil(cx + half); x++) {
          if (x < 0 || x >= FIELD) continue
          acc += field[y * FIELD + x]
          count++
        }
      }
      const value = count ? acc / count : 0
      samples[by * BITS + bx] = value
      total += value
    }
  }

  const threshold = total / 64
  let hi = 0
  let lo = 0
  for (let i = 0; i < 64; i++) {
    if (samples[i] <= threshold) continue
    if (i < 32) lo |= 1 << i
    else hi |= 1 << (i - 32)
  }
  return [hi >>> 0, lo >>> 0]
}

/**
 * The canonical hash is the bitmap itself.
 *
 * Ink fraction is pinned at exactly 1/2, so thresholding a crisp tile at its
 * own mean reproduces the bitmap bit for bit. That makes the template the
 * receiver matches against the bitmap it was drawn from, with no separate
 * "reference hash" that could drift out of step with it.
 */
function canonicalHash(bitmap) {
  let hi = 0
  let lo = 0
  for (let i = 0; i < 64; i++) {
    if (!bitmap[i]) continue
    if (i < 32) lo |= 1 << i
    else hi |= 1 << (i - 32)
  }
  return [hi >>> 0, lo >>> 0]
}

function popcount(v) {
  v = v - ((v >>> 1) & 0x55555555)
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333)
  v = (v + (v >>> 4)) & 0x0f0f0f0f
  return (v * 0x01010101) >>> 24
}

const distance = (a, b) => popcount(a[0] ^ b[0]) + popcount(a[1] ^ b[1])

/** Canonical hash plus one observed hash per modelled variant. */
function hashSet(glyph, variants = VARIANTS) {
  const tile = expand(glyph)
  const fields = new Map()
  for (const sigma of SIGMAS) fields.set(sigma, blur(render(tile), sigma))
  return {
    canonical: canonicalHash(tile),
    observed: variants.map((v) => observedHash(fields.get(v.sigma), v)),
  }
}

// ------------------------------------------------------------- objective ---

/**
 * Worst classifier margin across the whole set, plus how many (symbol,
 * degradation) pairs sit at that worst value.
 *
 * Annealing on the minimum alone plateaus badly - once one pair is the
 * bottleneck, most moves leave the objective untouched and the search stops
 * getting feedback. Counting how many pairs are stuck at the minimum gives it
 * a gradient to follow even while the minimum itself holds still.
 */
function score(hashes) {
  let worst = Infinity
  let atWorst = 0
  for (let i = 0; i < COUNT; i++) {
    for (let v = 0; v < VARIANTS.length; v++) {
      const received = hashes[i].observed[v]
      const own = distance(received, hashes[i].canonical)
      let nearestOther = Infinity
      for (let j = 0; j < COUNT; j++) {
        if (j === i) continue
        const d = distance(received, hashes[j].canonical)
        if (d < nearestOther) nearestOther = d
      }
      const margin = nearestOther - own
      if (margin < worst) {
        worst = margin
        atWorst = 1
      } else if (margin === worst) {
        atWorst++
      }
    }
  }
  return { worst, atWorst }
}

const better = (a, b) => a.worst > b.worst || (a.worst === b.worst && a.atWorst < b.atWorst)

// ----------------------------------------------------------------- search ---

function inkFraction(bitmap) {
  let n = 0
  for (const b of bitmap) n += b
  return n / bitmap.length
}

function randomBitmap(rng) {
  const glyph = new Uint8Array(GLYPH * GLYPH)
  // Start at exactly half lit, so the ink constraint holds from the first move.
  const order = [...glyph.keys()].sort(() => rng() - 0.5)
  for (let i = 0; i < order.length / 2; i++) glyph[order[i]] = 1
  return glyph
}

function anneal({ seed, iterations }) {
  const rng = seeded(seed)
  const bitmaps = Array.from({ length: COUNT }, () => randomBitmap(rng))
  let hashes = bitmaps.map((b) => hashSet(b))
  let current = score(hashes)

  let bestBitmaps = bitmaps.map((b) => b.slice())
  let best = current

  for (let step = 0; step < iterations; step++) {
    const temperature = 2.5 * (1 - step / iterations) + 0.02
    const i = Math.floor(rng() * COUNT)

    // Swap a lit bit for an unlit one, which moves the pattern while holding
    // the ink fraction exactly where it is.
    const lit = []
    const dark = []
    for (let p = 0; p < bitmaps[i].length; p++) (bitmaps[i][p] ? lit : dark).push(p)
    if (!lit.length || !dark.length) continue
    const on = lit[Math.floor(rng() * lit.length)]
    const off = dark[Math.floor(rng() * dark.length)]

    bitmaps[i][on] = 0
    bitmaps[i][off] = 1

    const previousHashes = hashes[i]
    hashes[i] = hashSet(bitmaps[i])
    const candidate = score(hashes)

    const delta = candidate.worst - current.worst
    const accept =
      better(candidate, current) || rng() < Math.exp(delta / Math.max(0.001, temperature))

    if (accept) {
      current = candidate
      if (better(current, best)) {
        best = current
        bestBitmaps = bitmaps.map((b) => b.slice())
      }
    } else {
      bitmaps[i][on] = 1
      bitmaps[i][off] = 0
      hashes[i] = previousHashes
    }
  }

  return { bitmaps: bestBitmaps, score: best }
}

/** Reject a set where any symbol is a shifted copy of another. */
function shiftCollision(bitmaps) {
  for (let i = 0; i < COUNT; i++) {
    for (let j = 0; j < COUNT; j++) {
      if (i === j) continue
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        let identical = true
        for (let y = 0; y < GLYPH && identical; y++) {
          for (let x = 0; x < GLYPH; x++) {
            const sx = x - dx
            const sy = y - dy
            if (sx < 0 || sy < 0 || sx >= GLYPH || sy >= GLYPH) continue
            if (bitmaps[i][y * GLYPH + x] !== bitmaps[j][sy * GLYPH + sx]) {
              identical = false
              break
            }
          }
        }
        if (identical) return `symbol ${i} is a shift of ${j}`
      }
    }
  }
  return null
}

// ------------------------------------------------------------------- main ---

const restarts = Number(process.env.RESTARTS ?? 12)
const iterations = Number(process.env.ITERATIONS ?? 40_000)

let winner = null
for (let r = 0; r < restarts; r++) {
  const attempt = anneal({ seed: 0x5eed + r * 7919, iterations })
  const collision = shiftCollision(attempt.bitmaps)
  if (collision) {
    console.log(`  restart ${r}: rejected - ${collision}`)
    continue
  }
  const ink = attempt.bitmaps.map(inkFraction)
  if (ink.some((f) => f < INK_MIN || f > INK_MAX)) {
    console.log(`  restart ${r}: rejected - ink fraction out of range`)
    continue
  }
  console.log(
    `  restart ${r}: worst margin ${attempt.score.worst} at ${attempt.score.atWorst} pair(s)`,
  )
  if (!winner || better(attempt.score, winner.score)) winner = attempt
}

if (!winner) {
  console.error('No symbol set satisfied the constraints. Raise ITERATIONS or RESTARTS.')
  process.exit(1)
}

const tiles = winner.bitmaps.map(expand)
const hashes = tiles.map(canonicalHash)
const ink = tiles.map(inkFraction)

/**
 * Per-variant worst margin. This is the table that showed the first model was
 * measuring the wrong thing, so it is printed every run rather than kept for a
 * bad day.
 */
function marginTable(variants) {
  const observed = winner.bitmaps.map((b) => hashSet(b, variants))
  return variants.map((v, index) => {
    let worst = Infinity
    for (let i = 0; i < COUNT; i++) {
      const received = observed[i].observed[index]
      const own = distance(received, observed[i].canonical)
      let nearestOther = Infinity
      for (let j = 0; j < COUNT; j++) {
        if (j !== i) nearestOther = Math.min(nearestOther, distance(received, observed[j].canonical))
      }
      worst = Math.min(worst, nearestOther - own)
    }
    return { ...v, worst }
  })
}

const breakdown = marginTable(VARIANTS)
const diagnostics = marginTable(DIAGNOSTIC_VARIANTS)

console.log('\n  worst margin by modelled capture condition:')
for (const b of breakdown) {
  console.log(
    `    ${String(b.pxPerTile).padStart(2)} px/tile  sigma ${(b.sigma / (FIELD / BITS)).toFixed(1)} bits` +
      `  shift (${b.dx}, ${b.dy})  margin ${b.worst}`,
  )
}
console.log('  below the objective (diagnostic only - this is the cliff):')
for (const b of diagnostics) {
  console.log(
    `    ${String(b.pxPerTile).padStart(2)} px/tile  sigma ${(b.sigma / (FIELD / BITS)).toFixed(1)} bits` +
      `  shift (${b.dx}, ${b.dy})  margin ${b.worst}`,
  )
}

let crispMin = Infinity
for (let i = 0; i < COUNT; i++) {
  for (let j = i + 1; j < COUNT; j++) {
    crispMin = Math.min(crispMin, distance(hashes[i], hashes[j]))
  }
}

const here = dirname(fileURLToPath(import.meta.url))
const target = join(here, '..', 'src', 'optical', 'airblock', 'symbols.js')

const rows = tiles.map((bitmap, i) => {
  const art = []
  for (let y = 0; y < BITS; y++) {
    let line = ''
    for (let x = 0; x < BITS; x++) line += bitmap[y * BITS + x] ? '#' : '.'
    art.push(line)
  }
  return { index: i, bitmap, art, hash: hashes[i], ink: ink[i] }
})

const body = `/**
 * The 16 symbol tiles. GENERATED - do not edit by hand.
 *
 * Produced by scripts/gen-symbols.mjs, which anneals for the worst-case
 * classifier margin through a model of the whole capture chain - supersampled
 * tile, defocus, resampling to a handful of capture pixels, sub-pixel offset,
 * threshold - rather than for Hamming distance between the crisp bitmaps.
 * Resampling, not defocus, is the dominant filter; see that file.
 *
 * Regenerate with: npm run symbols
 *
 *   worst margin over all modelled conditions   ${winner.score.worst} bits
 *   at                                          ${winner.score.atWorst} (symbol, condition) pair(s)
 *   minimum distance between canonical hashes   ${crispMin} bits
 *   ink fraction                                ${Math.min(...ink).toFixed(3)} - ${Math.max(...ink).toFixed(3)}
 *
 * By modelled condition:
 *
${breakdown.map((b) => ` *   ${String(b.pxPerTile).padStart(2)} px/tile  sigma ${(b.sigma / (FIELD / BITS)).toFixed(1)} bits  shift (${b.dx}, ${b.dy})  margin ${b.worst}`).join('\n')}
 *
 * Below the objective, for reference - this is the resolution cliff, and the
 * grid profiles exist to keep the receiver off it:
 *
${diagnostics.map((b) => ` *   ${String(b.pxPerTile).padStart(2)} px/tile  sigma ${(b.sigma / (FIELD / BITS)).toFixed(1)} bits  shift (${b.dx}, ${b.dy})  margin ${b.worst}`).join('\n')}
 *
 * The ink fraction band is load-bearing twice over. It makes the receiver's
 * 15x15-cell local box mean a valid decision level with no occupancy estimate,
 * and it makes the canonical hash below identical to the bitmap it came from -
 * thresholding a crisp tile at its own mean reproduces the bitmap exactly only
 * when half its bits are lit.
 */

/** Tile edge in bits. The 64 bits are also exactly the hash width. */
export const SYMBOL_BITS = ${BITS}

/** Number of distinct symbols, so ${Math.log2(COUNT)} of the 6 bits per tile. */
export const SYMBOL_COUNT = ${COUNT}

/**
 * Row-major 8x8 bitmaps, one Uint8Array of 0/1 per symbol.
 *
${rows.map((r) => ` *   ${String(r.index).padStart(2)}  ${r.art.join('\n *       ')}`).join('\n *\n')}
 */
export const SYMBOL_BITMAPS = [
${rows.map((r) => `  // ${r.index}: ${r.art.join(' ')}\n  Uint8Array.from([${[...r.bitmap].join(',')}]),`).join('\n')}
]

/**
 * Canonical hashes as [high, low] 32-bit halves - the same bits as the bitmaps
 * above, packed for the classifier's popcount comparison. Index is the
 * symbol's 4-bit value.
 */
export const SYMBOL_HASHES = [
${rows.map((r) => `  [0x${r.hash[0].toString(16).padStart(8, '0')}, 0x${r.hash[1].toString(16).padStart(8, '0')}], // ${r.index}`).join('\n')}
]

/** Flat Int32Array of the same hashes, for a tight classifier inner loop. */
export const SYMBOL_HASHES_FLAT = Int32Array.from([
${rows.map((r) => `  0x${r.hash[0].toString(16).padStart(8, '0')} | 0, 0x${r.hash[1].toString(16).padStart(8, '0')} | 0,`).join('\n')}
])

/** Worst margin the generator achieved across all modelled conditions, in bits. */
export const WORST_BLURRED_MARGIN = ${winner.score.worst}

/**
 * Capture pixels per tile the set was optimised for, least first.
 *
 * The receiver's measured px/cell, scaled by the tile fraction of the pitch,
 * has to stay at or above the first of these. Below it the classifier is not
 * merely uncertain but systematically wrong, so the aiming guidance treats it
 * as a hard floor rather than a preference.
 */
export const PX_PER_TILE_RANGE = [${PX_PER_TILE.join(', ')}]

/** Minimum pairwise distance between canonical hashes, in bits. */
export const MIN_CRISP_DISTANCE = ${crispMin}

/** Logical glyph resolution before upsampling into the tile. */
export const GLYPH_BITS = ${GLYPH}

/** Ink fraction of each symbol, in bitmap order. */
export const SYMBOL_INK = [${ink.map((f) => f.toFixed(4)).join(', ')}]
`

writeFileSync(target, body)
console.log(
  `\nwrote ${target}\n  worst margin ${winner.score.worst} bits` +
    `  canonical separation ${crispMin} bits` +
    `  ink ${Math.min(...ink).toFixed(3)}-${Math.max(...ink).toFixed(3)}`,
)
