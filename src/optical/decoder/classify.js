/**
 * Turn one sampled tile into a value and a confidence.
 *
 * This module decides nothing. It reports `{value, confidence}` and the
 * erasure policy in frame.js is what turns a confidence into a flag. Keeping
 * that boundary means the policy can be retuned against telemetry without
 * anyone touching image code, and it means this file has no opinion about
 * error correction at all.
 *
 * Colour is decided from the tile's summed r/g/b, against thresholds the
 * frame supplies (palette.js says why those come from the picture rather than
 * from constants). The symbol is decided from the tile's own 64 samples,
 * independently of the colour (balancedThreshold).
 */

import { SYMBOL_HASHES_FLAT, SYMBOL_COUNT } from '../airblock/symbols.js'
import { classifyColour } from '../airblock/palette.js'
import { valueOf } from '../airblock/grid.js'

/**
 * Bits of hash margin at which the symbol decision is considered certain.
 *
 * The generated set has 24 bits of separation between crisp hashes and holds a
 * 6 bit worst-case margin under blur and half-a-bit of misalignment. Twelve -
 * half the crisp separation, twice the worst modelled margin - is the point
 * past which the second-best symbol is not a plausible alternative. It is a
 * knob: the erasure floor is expressed against this scale, so moving it moves
 * how many cells get flagged.
 */
export const MARGIN_SCALE = 12

function popcount(v) {
  v = v - ((v >>> 1) & 0x55555555)
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333)
  v = (v + (v >>> 4)) & 0x0f0f0f0f
  return (v * 0x01010101) >>> 24
}

/**
 * Hash 64 luma samples against a threshold.
 *
 * Bit order matches the generator's: sample index i is bit i, low half first.
 * A mismatch here produces a decoder that reads every symbol as the wrong one
 * with perfectly plausible confidence, so the layout test pins it.
 */
export function hashTile(samples, threshold) {
  let lo = 0
  let hi = 0
  for (let i = 0; i < 32; i++) {
    if (samples[i] > threshold) lo |= 1 << i
  }
  for (let i = 32; i < 64; i++) {
    if (samples[i] > threshold) hi |= 1 << (i - 32)
  }
  return [hi >>> 0, lo >>> 0]
}

/**
 * Nearest symbol to a hash, with the margin to the runner-up.
 *
 * @returns {{symbol: number, confidence: number, margin: number}}
 */
export function classifySymbol(hi, lo) {
  let best = 0
  let bestDistance = 65
  let secondDistance = 65

  for (let s = 0; s < SYMBOL_COUNT; s++) {
    const d =
      popcount(hi ^ (SYMBOL_HASHES_FLAT[s * 2] >>> 0)) +
      popcount(lo ^ (SYMBOL_HASHES_FLAT[s * 2 + 1] >>> 0))
    if (d < bestDistance) {
      secondDistance = bestDistance
      bestDistance = d
      best = s
    } else if (d < secondDistance) {
      secondDistance = d
    }
  }

  const margin = secondDistance - bestDistance
  return { symbol: best, margin, confidence: Math.max(0, Math.min(1, margin / MARGIN_SCALE)) }
}

const scratch = new Float32Array(64)

/**
 * The symbol threshold a tile sets for itself.
 *
 * Every glyph lights exactly 32 of its 64 sample positions, so the boundary
 * between the 32nd and 33rd brightest samples is where "lit" starts, whatever
 * colour the tile is and however the vignette dims it. This replaced the
 * local box mean scaled by the decided colour's luma, which moved the symbol
 * threshold by up to 2.1x on a wrong colour decision and did not follow a
 * blurred tile's own balance. Measured at each rung's cliff over 30 captures,
 * paired against the old threshold on the same captures: blocks delivered on
 * `far` 65.6% to 89.4%, on `normal` 78.5% to 89.8%, on `dense` 97.2% to
 * 99.7%.
 *
 * It costs time, and that was judged worth it: `max` decodes in about 150 ms
 * against 106 with a full geometry search in Node, because a blurred tile's
 * 32nd value takes a selection; in a browser four workers still decode it 21
 * times a second through a video, above the sender's 15. Any pivot
 * with exactly 32 samples above it defines the same split, so the pivot only
 * decides how fast the answer comes: in one pass when it balances, with a
 * small buffer when it is a few samples off, and by quickselect otherwise.
 * The result does not depend on it.
 */
export function balancedThreshold(samples, pivot) {
  let above = 0
  let lowestAbove = Infinity
  let highestBelow = -Infinity
  for (let i = 0; i < 64; i++) {
    const v = samples[i]
    if (v > pivot) {
      above++
      if (v < lowestAbove) lowestAbove = v
    } else if (v > highestBelow) highestBelow = v
  }
  if (above === 32) return (highestBelow + lowestAbove) / 2

  // A few too many on one side: the split is set by the d-th and (d+1)-th
  // values of that side counted from the pivot, which one pass with a small
  // sorted buffer finds.
  const d = above - 32
  if (d >= -4 && d <= 4) {
    const want = Math.abs(d) + 1
    let held = 0
    for (let i = 0; i < 64; i++) {
      const v = samples[i]
      // Above the pivot keep the smallest, below it the largest (negated, so
      // one ascending buffer serves both).
      if (d > 0 ? !(v > pivot) : v > pivot) continue
      const key = d > 0 ? v : -v
      if (held === want && key >= scratch[want - 1]) continue
      let at = held < want ? held++ : want - 1
      while (at > 0 && scratch[at - 1] > key) {
        scratch[at] = scratch[at - 1]
        at--
      }
      scratch[at] = key
    }
    return d > 0 ? (scratch[d - 1] + scratch[d]) / 2 : (-scratch[-d] + -scratch[-d - 1]) / 2
  }

  scratch.set(samples)
  const k = 31
  let lo = 0
  let hi = 63
  while (lo < hi) {
    const mid = scratch[(lo + hi) >> 1]
    let i = lo
    let j = hi
    while (i <= j) {
      while (scratch[i] < mid) i++
      while (scratch[j] > mid) j--
      if (i <= j) {
        const t = scratch[i]
        scratch[i] = scratch[j]
        scratch[j] = t
        i++
        j--
      }
    }
    if (k <= j) hi = j
    else if (k >= i) lo = i
    else break
  }
  // Everything past index 31 is now at least scratch[31]; the smallest of it
  // is the 33rd value.
  let next = Infinity
  for (let n = 32; n < 64; n++) if (scratch[n] < next) next = scratch[n]
  return (scratch[31] + next) / 2
}

/**
 * The whole per-cell decision.
 *
 * @param {Float32Array} samples 64 luma means, in bitmap order
 * @param {number} pivot a first guess at the symbol threshold - the tile's
 *   mean - which decides how fast it is found and not what it is
 * @param {number} sumR summed red over the tile
 * @param {number} sumG summed green
 * @param {number} sumB summed blue
 * @param {object} [chroma] the frame's chroma reference, from estimateChroma
 * @returns {{value: number, confidence: number, symbolMargin: number,
 *            colourConfidence: number}}
 */
export function classifyCell(samples, pivot, sumR, sumG, sumB, chroma) {
  const colour = classifyColour(sumR, sumG, sumB, chroma)
  const [hi, lo] = hashTile(samples, balancedThreshold(samples, pivot))
  const symbol = classifySymbol(hi, lo)

  // The weaker of the two decisions governs: the cell's value carries both,
  // so a coin-flip colour makes the whole value doubtful however crisp the
  // symbol looked.
  return {
    value: valueOf(symbol.symbol, colour.value),
    confidence: Math.min(symbol.confidence, colour.confidence),
    symbolMargin: symbol.margin,
    colourConfidence: colour.confidence,
  }
}
