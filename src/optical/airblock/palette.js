/**
 * The four tile colours, and how the receiver decides between them.
 *
 * Two bits of every tile's six are carried by colour. The decode order is the
 * part worth understanding, because it is the opposite of the obvious one:
 *
 *   1. colour, from the tile's SUMMED chromaticity. Sum the raw r, g and b of
 *      every pixel in the tile and normalise by the total. The backdrop is
 *      black, so the sum is dominated by whatever pixels were lit. No
 *      binarisation, and no dependence on brightness at all.
 *
 *   2. symbol, from luma, thresholded at a level the now-known colour scales.
 *
 * Deciding colour first is what lets the palette stay fully saturated. The
 * alternative - four colours of matched luma, so one threshold serves every
 * cell - costs either half the panel's light output or half its chroma
 * separation, because the sRGB gamut is a cone.
 *
 * ## The palette is two independent bits, not four points
 *
 * Written as chromaticity shares, the four entries are the corners of a
 * square: the RED share separates {green, cyan} from {yellow, magenta}, and
 * the BLUE share separates {green, yellow} from {cyan, magenta}. Green share
 * is redundant. So the colour decision is not "which of four points is
 * nearest" but two independent threshold decisions, and the palette's own
 * index order already IS that two-bit encoding - red share is the high bit.
 *
 * That reformulation is what makes the decision survive a camera, because a
 * threshold can be taken from the picture while an absolute reference cannot.
 * The previous implementation compared each tile against the IDEAL fully
 * saturated chromaticities and normalised the margin by their ideal minimum
 * separation. A real capture does not deliver that. Measured on a phone
 * photographing a laptop panel - with a neutral white point, so this is not a
 * white balance error - the chromaticity cloud retained 23% of the ideal
 * spread on the red axis and 34% on the blue, its centre sitting at
 * (0.310, 0.268) rather than the ideal (0.25, 0.25).
 *
 * Two things followed, and both were fatal rather than merely degrading:
 *
 *   - green is the entry farthest from the cloud centre, so under contraction
 *     its ideal reference became unreachable and NO tile classified as green.
 *     A quarter of every frame was wrong before error correction started.
 *
 *   - every margin was deflated by the same factor, so colour confidence
 *     averaged 0.24 against 0.83 in the offline harness. Since a cell's
 *     confidence is the weaker of its colour and symbol decisions, that capped
 *     every cell in the frame however crisp its glyph, drowned the erasure
 *     policy's 0.35 floor, and held the aiming guidance permanently below the
 *     0.5 it needs to start a transfer.
 *
 * The thresholds are now estimated from the frame, by locating the two modes
 * of each share directly rather than by averaging.
 *
 * Averaging is the obvious choice and it is wrong here, which is worth
 * recording because the local luma threshold DOES rely on it. Luma can: every
 * symbol lights half its tile by construction, so the mean of a neighbourhood
 * sits at the midpoint of the eye whatever the payload happens to be. Colour
 * has no such invariant. It would need the four colours to appear about
 * equally, and a frame carrying a payload shorter than its capacity is
 * zero-padded - symbol zero being green, a partly filled frame is mostly
 * green. Measured on a clean 3000-byte payload in a 5622-byte frame: 60%
 * green against 13% each of the others, which drags the mean of the red share
 * from 0.25 down to 0.136 and costs a third of the confidence on a capture
 * that classified every single cell correctly.
 *
 * Two-means locating the modes is immune to that, because it measures where
 * the populations ARE rather than where their centre of mass is. Confidence is
 * then the distance from the midpoint in units of the half-separation, which
 * makes it scale-free - and on an ideal capture the modes land exactly on 0
 * and 0.5, returning exactly the ideal constants, so nothing about the offline
 * measurements changes.
 *
 * Which 2-bit value maps to which colour is otherwise arbitrary and
 * deliberately not optimised. A tile's six bits are ONE GF(64) symbol, so a
 * colour confusion is a single symbol error whether it flipped one bit or two.
 * Minimising the bit distance between confusable colours would be optimising a
 * quantity the error correction cannot see.
 */

/** Bits of each tile carried by colour. */
export const COLOUR_BITS = 2

/**
 * Saturated, maximally separated in chromaticity, and as bright as the display
 * will go. Minimum pairwise chromaticity distance is 0.707; green and magenta
 * are further apart still at 1.22.
 */
export const PALETTE = [
  { name: 'green', rgb: [0, 255, 0] },
  { name: 'cyan', rgb: [0, 255, 255] },
  { name: 'yellow', rgb: [255, 255, 0] },
  { name: 'magenta', rgb: [255, 0, 255] },
]

/**
 * The reference an ideal capture produces, and the default for any caller that
 * has no frame to estimate from.
 *
 * Both thresholds are the mean of the palette's own shares - 0.25, halfway
 * between the 0 and 0.5 the two modes sit at - and both scales are the mean
 * distance from that threshold, which is also 0.25 because every entry is
 * exactly one step away. So an ideal tile scores a margin of exactly 1.
 */
export const IDEAL_CHROMA = { u: 0.25, v: 0.25, scaleU: 0.25, scaleV: 0.25 }

/**
 * How far apart the two modes of a share must sit, in units of the scatter
 * within each, before they are trusted as colour rather than noise.
 *
 * Without a test like this a frame carrying no colour at all - a monochrome
 * panel - has its noise split into two "modes" and divided by their tiny
 * separation, and comes back as confident bits. That is worse than low
 * confidence, because the erasure policy and the aiming guidance both rely on
 * confidence being honest.
 *
 * It used to be a floor on the separation itself, 10% of the ideal, and that
 * threw away captures that were perfectly readable: at 0.12 saturation the
 * separation is 9.6% of the ideal, every frame fell back to the ideal
 * thresholds, every cell read as one colour and nothing decoded, while the
 * same frames with no floor decoded whole with no colour errors at all. A
 * fixed floor is also wrong the other way, because the separation noise alone
 * produces grows with the noise. The ratio does not: measured on `normal` and
 * `max` at noise 2 and 5, a colourless capture splits at 1.19 to 1.22, and
 * every capture that decoded measured 1.98 or more (0.04 saturation at noise
 * 5; 0.12 saturation measures 3.2 to 3.6). 1.6 sits between.
 */
const MIN_SEPARATION = 1.6

/**
 * Fewest lit cells worth estimating from. Below this the frame is mostly dark -
 * a payload far shorter than the frame's capacity, so most cells are BLANK -
 * and the ideal reference is the better guess.
 */
const MIN_CHROMA_CELLS = 64

/**
 * Locate the two modes of one share by two-means, and return the threshold
 * between them with the half-separation and the scatter within the modes.
 *
 * Lloyd's algorithm in one dimension, seeded from the observed extremes, which
 * converges in a handful of passes. Returns null when the populations cannot
 * be separated - one mode empty, or no spread at all - which happens on a
 * frame that genuinely carries one colour and where there is nothing to
 * estimate.
 */
function twoModes(share, cells) {
  let low = Infinity
  let high = -Infinity
  for (const i of cells) {
    const v = share[i]
    if (v < low) low = v
    if (v > high) high = v
  }
  if (!(high > low)) return null

  let a = low
  let b = high
  for (let pass = 0; pass < 12; pass++) {
    const mid = (a + b) / 2
    let sumA = 0
    let countA = 0
    let sumB = 0
    let countB = 0
    for (const i of cells) {
      const v = share[i]
      if (v < mid) {
        sumA += v
        countA++
      } else {
        sumB += v
        countB++
      }
    }
    if (!countA || !countB) return null
    const nextA = sumA / countA
    const nextB = sumB / countB
    const settled = Math.abs(nextA - a) < 1e-6 && Math.abs(nextB - b) < 1e-6
    a = nextA
    b = nextB
    if (settled) break
  }

  // The scatter of each share about its own mode, pooled.
  const threshold = (a + b) / 2
  let scatter = 0
  for (const i of cells) {
    const d = share[i] - (share[i] < threshold ? a : b)
    scatter += d * d
  }
  return { threshold, scale: (b - a) / 2, deviation: Math.sqrt(scatter / cells.length) }
}

/**
 * Estimate a frame's chroma reference from its own tiles.
 *
 * Only LIT cells may be passed. A dark cell carries no colour, so its share is
 * either exactly zero or, under noise, a near-grey value sitting right on the
 * threshold - and either way including it moves the threshold it was supposed
 * to help place. This is the same exclusion the local luma threshold makes for
 * the anchors, and for the same reason.
 *
 * @param {Float32Array} u per-cell red share
 * @param {Float32Array} v per-cell blue share
 * @param {number[]} cells indices of the lit cells to estimate over
 */
export function estimateChroma(u, v, cells) {
  if (cells.length < MIN_CHROMA_CELLS) return IDEAL_CHROMA

  const red = twoModes(u, cells)
  const blue = twoModes(v, cells)
  if (!red || !blue) return IDEAL_CHROMA

  if (red.scale < MIN_SEPARATION * red.deviation || blue.scale < MIN_SEPARATION * blue.deviation) {
    return IDEAL_CHROMA
  }

  return {
    u: red.threshold,
    v: blue.threshold,
    scaleU: red.scale,
    scaleV: blue.scale,
  }
}

/**
 * The colour of a summed (r, g, b), with a confidence.
 *
 * Two threshold decisions against `reference`, and the confidence is the
 * weaker of the two margins expressed in units of the reference's own spread.
 * One means both bits are unambiguous; zero means a tile sits on a threshold
 * and the classifier is guessing. That number is what becomes an erasure flag
 * one layer up - it is reported, never acted on here.
 *
 * The weaker margin governs rather than the average, because a tile whose red
 * bit is a coin flip is not trustworthy however clean its blue bit was.
 *
 * @param {number} r summed red across the tile
 * @param {number} g summed green
 * @param {number} b summed blue
 * @param {object} [reference] from estimateChroma; ideal if omitted
 * @returns {{value: number, confidence: number}}
 */
export function classifyColour(r, g, b, reference = IDEAL_CHROMA) {
  const total = r + g + b
  if (total <= 0) return { value: 0, confidence: 0 }

  const marginU = (r / total - reference.u) / reference.scaleU
  const marginV = (b / total - reference.v) / reference.scaleV

  // Red share is the high bit, blue the low one, which is the palette's own
  // index order: green 00, cyan 01, yellow 10, magenta 11.
  const value = (marginU > 0 ? 2 : 0) | (marginV > 0 ? 1 : 0)
  const margin = Math.min(Math.abs(marginU), Math.abs(marginV))

  return { value, confidence: Math.max(0, Math.min(1, margin)) }
}
