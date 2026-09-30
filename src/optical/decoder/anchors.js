/**
 * Find the four corner anchors in a captured image and recover the geometry.
 *
 * Everything downstream has been taking the code-space-to-image transform as
 * given, which is fine for the offline harness and useless with a camera. This
 * is the part that earns it.
 *
 * ## Anchors are found by being COLOURLESS, not by being bright
 *
 * The obvious discriminator is brightness, and it is the wrong one. Data cells
 * are drawn in a saturated palette whose brightest member, yellow, has a luma
 * of 0.886 against white's 1.0 - a 13% gap that vignetting, exposure or a
 * white-balance error erases without effort.
 *
 * Every palette colour has at least one channel at zero, so `min/max` across
 * the three channels is 0 for all of them and 1 for white. Thresholding that
 * ratio separates anchors from payload with an enormous margin, and it is
 * invariant to brightness altogether - which means it survives the vignette
 * and exposure variation that would defeat a luma threshold.
 *
 * ## The grid size comes from the anchors, not from the header
 *
 * There is a circularity here worth naming. The header says which profile is
 * in use, and therefore how many cells there are. But placing the header in
 * the image needs the transform, and building the transform needs the anchor
 * positions in *code space*, which needs the cell count.
 *
 * It is broken by measuring instead of assuming: an anchor is a known 7 cells
 * across, so its pixel width gives pixels per cell directly, and the anchor
 * spacing then tells which rung that scale belongs to. The header - decoded
 * afterwards - confirms it or overrides it.
 *
 * Both halves of that are less direct than they sound, and a real capture is
 * what showed why. The anchor's pixel width runs about 11% high, because a
 * white anchor bleeds outward under blur and the achromatic mask accepts the
 * bleed; the anchor spacing has no such bias but cannot name a rung on its own,
 * because every profile is near 16:9. So the width is a prior and the spacing
 * does the geometry, and no quad is committed to until the two agree. See the
 * selection loop in findGeometry.
 */

import { PROFILES, layoutFor } from '../airblock/grid.js'
import { homographyFromQuad } from './homography.js'

/**
 * The anchor edge, in cells, shared by every grid profile.
 *
 * Geometry recovery needs this BEFORE it knows which profile it is looking at -
 * an anchor's pixel width divided by its cell width is what gives pixels per
 * cell, and that is what identifies the profile. So the value cannot come from
 * the profile, and every profile must agree on it.
 *
 * Asserted rather than assumed. A rung added with a different anchor size would
 * otherwise skew pixels-per-cell by the ratio of the two, which shifts the
 * estimated grid dimensions and either selects the wrong profile or fails the
 * match outright - silently, presenting as "that one rung never decodes".
 */
export const ANCHOR_SIZE = PROFILES[0].anchorSize

for (const profile of PROFILES) {
  if (profile.anchorSize !== ANCHOR_SIZE) {
    throw new Error(
      `Grid profile ${profile.id} has anchorSize ${profile.anchorSize}, but geometry ` +
        `recovery measures the anchor before it knows the profile and so needs every ` +
        `profile to share one (${ANCHOR_SIZE}).`,
    )
  }
}

export const DETECT = {
  /** min/max channel ratio above which a pixel is treated as colourless. */
  achromatic: 0.62,
  /**
   * Luma floor, as a fraction of the brightest pixel found in the image.
   *
   * Set above the one blend that can counterfeit an anchor. Of the six pairs
   * in the palette only green against magenta averages to something the
   * achromatic test accepts - (128,128,128), min/max exactly 1 - and defocus
   * puts that grey along every boundary between the two. Its luma is half
   * white's, so a floor above 0.5 excludes it; a real anchor dimmed by the
   * harness's own 0.35 corner vignette still sits at 0.65.
   *
   * 0.52 is as high as it goes: measured against the suite, 0.55 costs the
   * `max` rung, whose anchors are small enough that blur alone dims them. So
   * the margin over the counterfeit is 4%, and it thins as a capture softens.
   * Going higher needs a floor that knows the anchor's own scale rather than
   * one shared by the whole image - worth doing if false rings return.
   */
  relativeLuma: 0.52,
  /** Smallest anchor candidate, as a fraction of total image pixels. */
  minAreaFraction: 0.00008,
  /** Largest, to reject a blown-out highlight covering half the frame. */
  maxAreaFraction: 0.05,
  /** How far from square an anchor's bounding box may be. */
  maxAspect: 1.7,
}

/**
 * Colourless-and-bright mask.
 *
 * Returns the mask plus the brightest luma seen, because the luma floor is
 * relative - an absolute one would fail on a dim capture and throw away half
 * the panel on a bright one.
 */
export function achromaticMask(data, width, height, settings = DETECT) {
  const mask = new Uint8Array(width * height)
  let brightest = 1

  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    const r = data[p]
    const g = data[p + 1]
    const b = data[p + 2]
    const luma = 0.299 * r + 0.587 * g + 0.114 * b
    if (luma > brightest) brightest = luma
  }

  const floor = brightest * settings.relativeLuma
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    const r = data[p]
    const g = data[p + 1]
    const b = data[p + 2]
    const luma = 0.299 * r + 0.587 * g + 0.114 * b
    if (luma < floor) continue
    const max = r > g ? (r > b ? r : b) : g > b ? g : b
    const min = r < g ? (r < b ? r : b) : g < b ? g : b
    if (max > 0 && min / max >= settings.achromatic) mask[i] = 1
  }

  return { mask, brightest }
}

/**
 * Connected components, four-neighbour, iterative.
 *
 * Iterative rather than recursive on purpose: a blown-out region can be tens
 * of thousands of pixels and a recursive fill would blow the stack on exactly
 * the malformed input that most needs handling.
 */
export function components(mask, width, height, settings = DETECT) {
  const seen = new Uint8Array(mask.length)
  const stack = new Int32Array(mask.length)
  const found = []
  const minArea = mask.length * settings.minAreaFraction
  const maxArea = mask.length * settings.maxAreaFraction

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue

    let top = 0
    stack[top++] = start
    seen[start] = 1

    let area = 0
    let sumX = 0
    let sumY = 0
    let minX = width
    let maxX = -1
    let minY = height
    let maxY = -1

    while (top > 0) {
      const index = stack[--top]
      const x = index % width
      const y = (index / width) | 0

      area++
      sumX += x
      sumY += y
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y

      if (x > 0 && mask[index - 1] && !seen[index - 1]) (seen[index - 1] = 1), (stack[top++] = index - 1)
      if (x < width - 1 && mask[index + 1] && !seen[index + 1]) (seen[index + 1] = 1), (stack[top++] = index + 1)
      if (y > 0 && mask[index - width] && !seen[index - width]) (seen[index - width] = 1), (stack[top++] = index - width)
      if (y < height - 1 && mask[index + width] && !seen[index + width]) (seen[index + width] = 1), (stack[top++] = index + width)
    }

    if (area < minArea || area > maxArea) continue
    const boxW = maxX - minX + 1
    const boxH = maxY - minY + 1
    const aspect = boxW > boxH ? boxW / boxH : boxH / boxW
    if (aspect > settings.maxAspect) continue

    found.push({
      area,
      // Pixel `i` covers the continuous interval [i, i+1) and so is centred at
      // i + 0.5. The transform this feeds works in that continuous space, so
      // the half pixel has to be added back or every anchor centre lands
      // half a pixel up and to the left - which is a uniform offset the
      // homography cannot see and drift refinement has to pay for.
      cx: sumX / area + 0.5,
      cy: sumY / area + 0.5,
      minX,
      maxX,
      minY,
      maxY,
      boxW,
      boxH,
      // A ring is hollow: a 7-cell square outline one cell thick fills about
      // 49% of its bounding box. A solid blob fills nearly all of it, which is
      // how a specular highlight gets rejected.
      fill: area / (boxW * boxH),
    })
  }

  return found
}

/** Which candidate contains another's centre - used to pair rings with centres. */
function containsPoint(box, x, y) {
  return x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY
}

/**
 * Mask occupancy of a ring's central 3x3 cells, as a fraction.
 *
 * This is what tells the orientation anchor from the other three, and it is
 * measured rather than inferred for a reason. The previous test asked whether a
 * separate connected component sat inside the ring and treated its ABSENCE as
 * "this is the orientation anchor" - so a hollow specular reflection, which has
 * no inner component either, was indistinguishable from the real corner. Two of
 * those in one frame and orientation fails outright.
 *
 * Absence was also the normal case for the genuine dot. The dot is one cell,
 * and `minAreaFraction` is a fraction of the WHOLE IMAGE: at 1080p the floor is
 * about 166 px while a cell at a working distance covers 80-120, so the dot
 * usually never became a component at all. The old test read the real anchor
 * correctly by accident, for the same reason it read glare incorrectly.
 *
 * Occupancy has neither problem. A solid 3x3 centre fills its window; a single
 * dot fills about 1/9 of it; and nothing here depends on the component floor.
 */
function centreOccupancy(mask, width, height, ring) {
  const cell = (ring.boxW + ring.boxH) / 2 / ANCHOR_SIZE
  const half = Math.max(1, Math.round((cell * 3) / 2))
  const cx = Math.round(ring.cx)
  const cy = Math.round(ring.cy)

  let on = 0
  let total = 0
  for (let y = cy - half; y <= cy + half; y++) {
    if (y < 0 || y >= height) continue
    for (let x = cx - half; x <= cx + half; x++) {
      if (x < 0 || x >= width) continue
      total++
      on += mask[y * width + x]
    }
  }
  return total ? on / total : 0
}

/**
 * Occupancy below which a centre reads as a single dot rather than a solid
 * block. A 3x3 window over a solid centre is near 1; over one dot in nine
 * cells it is near 0.11. Half way is a wide margin either side.
 */
const DOT_OCCUPANCY = 0.5

/**
 * How far below its siblings the orientation dot's centre must sit, as a
 * fraction of their median. Measured: 0.11 for a real quad, 0.85 for noise.
 */
const DOT_RATIO = 0.5

/**
 * Quad validation gates. See the reasoning at the selection loop below; both
 * are measured against real mongrel quads rather than chosen.
 */
const SKEW_LIMIT = 0.03
const SCALE_LIMIT = 0.3
const SPREAD_LIMIT = 2.0

/**
 * Sort four anchors into top-left, top-right, bottom-left, bottom-right.
 *
 * The orientation anchor - the one with a single dot rather than a solid block
 * at its centre - is the bottom-right by construction, and it is what makes a
 * rotated capture readable at all rather than decoding to noise. Once it is
 * identified the rest follow: the far corner is the top-left, and a cross
 * product separates the remaining two.
 */
function orient(rings) {
  const marked = rings.filter((r) => r.orientation)
  if (marked.length !== 1) {
    return { ok: false, reason: `expected 1 orientation anchor, found ${marked.length}` }
  }

  const br = marked[0]
  const rest = rings.filter((r) => r !== br)

  let tl = rest[0]
  let best = -1
  for (const candidate of rest) {
    const d = (candidate.cx - br.cx) ** 2 + (candidate.cy - br.cy) ** 2
    if (d > best) {
      best = d
      tl = candidate
    }
  }

  const others = rest.filter((r) => r !== tl)
  if (others.length !== 2) return { ok: false, reason: 'could not separate the corners' }

  // Cross product of (tl -> br) with (tl -> candidate). The top-right lies on
  // one side of the main diagonal and the bottom-left on the other.
  const dx = br.cx - tl.cx
  const dy = br.cy - tl.cy
  const cross = (p) => dx * (p.cy - tl.cy) - dy * (p.cx - tl.cx)
  const [tr, bl] = cross(others[0]) < 0 ? [others[0], others[1]] : [others[1], others[0]]

  return { ok: true, tl, tr, bl, br }
}

/**
 * Recover geometry from a captured image.
 *
 * @param {{data: Uint8ClampedArray, width: number, height: number}} image
 * @param {object} [options]
 * @param {string[]} [options.allow] restrict the profile search
 * @returns {{ok: true, transform: Float64Array, profile: string, pxPerCell: number,
 *            tilt: number, corners: object, telemetry: object}
 *          | {ok: false, reason: string, telemetry: object}}
 */
/**
 * How closely two rings must agree in size to be called the same kind of thing.
 *
 * Compared on edge length rather than area, because foreshortening acts on
 * length once and on area twice: a steep angle that shortens a far anchor by a
 * fifth shrinks its area by more than a third, and an area test tight enough
 * to exclude a dock icon then throws away a real anchor. Measured against the
 * tilted captures in the anchor suite, which is where an area test failed.
 */
const SIZE_AGREEMENT = 0.62

/** Mean edge length of a ring's bounding box. */
const ringSize = (r) => (r.boxW + r.boxH) / 2

/** Most quads one frame may score, so a noisy frame costs bounded time. */
const QUAD_BUDGET = 2000

/**
 * The quads worth scoring: three solid centres and one dot, of agreeing size.
 *
 * These were once every quad from the ten LARGEST rings, and ten is a number a
 * room can beat: ten bright hollow things bigger than the anchors, which a
 * phone held small in a lit office supplies, push all four anchors out of the
 * pool and the code is never found (a field failure on 2026-09-10). Size rank was only ever a proxy. What makes four rings anchors
 * is the pattern - the quad test below requires exactly one dot among three
 * solid centres - and size agreement: the spread gate below rejects any quad
 * whose edges differ by more than SPREAD_LIMIT, so no quad it could accept
 * has mean sizes further apart than that either.
 *
 * So the rings split into solid centres and dots, and a quad is three solids
 * and a dot within SPREAD_LIMIT of one another. That is a superset of what the
 * gates can accept from any pool, and clutter - hollow, so every piece of it a
 * "dot" - can only compete for the one dot slot among anchors of its own size.
 * Largest first, so the budget is spent where anchors usually are.
 */
function* candidateQuads(rings) {
  const bySize = (a, b) => ringSize(b) - ringSize(a)
  const solids = rings.filter((r) => !r.orientation).sort(bySize)
  const dots = rings.filter((r) => r.orientation).sort(bySize)
  let budget = QUAD_BUDGET
  for (let a = 0; a < solids.length; a++) {
    const floor = ringSize(solids[a]) / SPREAD_LIMIT
    for (let b = a + 1; b < solids.length && ringSize(solids[b]) >= floor; b++) {
      for (let c = b + 1; c < solids.length && ringSize(solids[c]) >= floor; c++) {
        const ceiling = ringSize(solids[c]) * SPREAD_LIMIT
        for (const dot of dots) {
          const size = ringSize(dot)
          if (size < floor || size > ceiling) continue
          if (budget-- <= 0) return
          yield [solids[a], solids[b], solids[c], dot]
        }
      }
    }
  }
}

export function findGeometry(image, options = {}) {
  const settings = { ...DETECT, ...options.detect }

  /**
   * Tracking: look where the anchors were last frame before looking everywhere.
   *
   * The full search is a mask over every pixel and a flood fill over the result,
   * 15-17 ms a frame on every rung and nearly all of it spent on the room around
   * the code. A hand-held camera moves the anchors a few pixels between frames,
   * so four windows around the previous ones, each three anchors across, cover
   * about a twentieth of a 720p capture. What is found there goes through the
   * same quad validation as a full search, so tracking cannot lock onto
   * anything a full search would have refused, and a miss falls through to the
   * full search.
   */
  const previous = options.previous?.corners
  if (previous) {
    const tracked = locate(image, options, trackedRings(image, previous, settings))
    if (tracked.ok) {
      tracked.telemetry.tracked = true
      return tracked
    }
  }
  return locate(image, options, ringsIn(image, settings))
}

/** Every ring in the image: the full search. */
function ringsIn(image, settings) {
  const { data, width, height } = image
  const { mask, brightest } = achromaticMask(data, width, height, settings)
  const candidates = components(mask, width, height, settings)
  return { rings: ringsFrom(candidates, mask, width, height), candidates: candidates.length, brightest }
}

/**
 * Rings in windows around the previous anchors: each window is cropped out and
 * searched as an image of its own, then its rings are moved back into place.
 */
function trackedRings(image, corners, settings) {
  const { data, width, height } = image
  const rings = []
  let candidates = 0
  let brightest = 1
  for (const ring of [corners.tl, corners.tr, corners.bl, corners.br]) {
    const margin = Math.max(ring.boxW, ring.boxH)
    const x0 = Math.max(0, ring.minX - margin)
    const y0 = Math.max(0, ring.minY - margin)
    const x1 = Math.min(width, ring.maxX + 1 + margin)
    const y1 = Math.min(height, ring.maxY + 1 + margin)
    const w = x1 - x0
    const h = y1 - y0
    if (w <= 0 || h <= 0) continue
    const crop = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++) {
      const from = ((y0 + y) * width + x0) * 4
      crop.set(data.subarray(from, from + w * 4), y * w * 4)
    }
    // The size gates are fractions of the image, so they are rescaled to keep
    // meaning the same number of pixels in a crop.
    const scale = (width * height) / (w * h)
    const local = {
      ...settings,
      minAreaFraction: settings.minAreaFraction * scale,
      maxAreaFraction: settings.maxAreaFraction * scale,
    }
    const found = ringsIn({ data: crop, width: w, height: h }, local)
    candidates += found.candidates
    brightest = Math.max(brightest, found.brightest)
    for (const r of found.rings) {
      rings.push({
        ...r,
        cx: r.cx + x0,
        cy: r.cy + y0,
        ringCx: r.ringCx + x0,
        ringCy: r.ringCy + y0,
        minX: r.minX + x0,
        maxX: r.maxX + x0,
        minY: r.minY + y0,
        maxY: r.maxY + y0,
      })
    }
  }
  return { rings, candidates, brightest }
}

/**
 * Rings are hollow; the block or dot at an anchor's centre is a separate
 * component sitting inside one. Pair them up - the inner component is the
 * better centroid where it exists - but decide orientation from the mask.
 */
function ringsFrom(candidates, mask, width, height) {
  const rings = []
  for (const outer of candidates) {
    // A ring is hollow and fills roughly half its bounding box. A solid blob
    // - a specular highlight, or an anchor's own inner block - fills nearly
    // all of it.
    if (outer.fill > 0.8) continue
    let inner = null
    for (const other of candidates) {
      if (other === outer || other.area >= outer.area) continue
      if (containsPoint(outer, other.cx, other.cy)) {
        if (!inner || other.area > inner.area) inner = other
      }
    }
    const occupancy = centreOccupancy(mask, width, height, outer)
    const orientation = occupancy < DOT_OCCUPANCY

    /**
     * Which centroid to trust.
     *
     * The ring touches the payload on two of its four sides, and under blur a
     * white anchor bleeding into a saturated neighbour makes desaturated
     * pixels that the achromatic mask accepts - so the ring's mask grows
     * inward asymmetrically and its centroid drifts. The solid 3x3 block at
     * the centre is fenced off by the anchor's own dark gap on all four sides,
     * so it has no such bias. Measured, per corner: ring 0.8-1.1 px of error
     * against the true centre, inner block 0.44-0.75 px.
     *
     * The orientation anchor is the exception. Its centre is a single cell,
     * and at that size quantisation costs more than the ring's bias does, so
     * there the ring wins (0.30 px against 1.00 px).
     */
    const useInner = inner && !orientation
    rings.push({
      ...outer,
      cx: useInner ? inner.cx : outer.cx,
      cy: useInner ? inner.cy : outer.cy,
      ringCx: outer.cx,
      ringCy: outer.cy,
      inner,
      occupancy,
      orientation,
    })
  }
  return rings
}

/** Choose the anchors among `found.rings` and recover the geometry from them. */
function locate(image, options, found) {
  const { width, height } = image
  const { rings } = found
  const telemetry = { candidates: found.candidates, brightest: found.brightest }

  if (found.candidates < 4) {
    return { ok: false, reason: `only ${found.candidates} anchor candidate(s)`, telemetry }
  }

  telemetry.rings = rings.length
  if (rings.length < 4) {
    return { ok: false, reason: `only ${rings.length} anchor ring(s)`, telemetry }
  }

  /**
   * Which four candidates are the anchors, and which rung they belong to.
   *
   * Taking the four largest and committing to them is what a specular
   * reflection defeats: glare on the sending screen makes a hollow blob that
   * can be larger than an anchor, so it displaces a real corner from the top
   * four and there is no second chance. Measured on one failing capture, the
   * largest ring in the frame was a 110x143 glare streak of area 4357 against
   * real anchors of 1529-1758.
   *
   * So the four are chosen by whether they VALIDATE rather than by size alone.
   * Every plausible quad (candidateQuads) is scored against every allowed rung
   * and the best consistent one wins, which rejects glare on the arithmetic
   * instead of on a threshold.
   *
   * ## The scale, and why the anchor box alone is not enough
   *
   * An anchor is a known ANCHOR_SIZE cells across, so its pixel box gives
   * pixels per cell without knowing the rung - which is the only reason the
   * rung can be identified at all. But that estimate runs high: a white anchor
   * against a saturated neighbour bleeds outward under blur and the achromatic
   * mask accepts the bleed, so the box grows. Measured on the same capture,
   * 8.95 px/cell from the boxes against a true 8.09 from the anchor spacing -
   * 11% high, which was enough on its own to push the rung match past a gate
   * expressed on cell counts and lose every frame while px/tile and squareness
   * both still read healthy.
   *
   * The anchor SPACING carries no such bias, because bleed moves both edges of
   * a ring outward and leaves its centre where it was. It cannot name the rung
   * by itself - every profile is near 16:9, so the span ratio only separates
   * the rungs by about 1% - but for a GIVEN rung it pins the scale exactly.
   * So the box is used as a prior with an honest tolerance and the spans do
   * the geometry, rather than the box doing both.
   */
  const anchorSize = ANCHOR_SIZE
  const allowed = options.allow ?? PROFILES.map((p) => p.id)

  let best = null
  let nearest = null
  for (const quad of candidateQuads(rings)) {
    /**
     * Three solid centres and one dot, judged against each other.
     *
     * The orientation flag alone is not enough to say these are anchors.
     * Enumerating quads is a multiple-comparisons problem - 210 quads
     * times five rungs is a thousand chances for four unrelated blobs to
     * line up - and measured on pure noise it accepted 47% of frames,
     * because random blobs CAN satisfy skew and scale by luck.
     *
     * What they cannot fake is the anchor pattern itself. A real quad is
     * three white 3x3 centres and one single dot; a noise quad is four
     * things of whatever the mask density happens to be. So the test is
     * the RATIO rather than a threshold, which needs no calibration and
     * survives any exposure: measured, a real dot sits at 0.09 against
     * siblings of 0.79-0.83, a ratio of 0.11, while noise quads sit at
     * 0.47 against 0.50-0.59, a ratio of 0.85. Half way between is
     * nowhere near either.
     */
    const occ = quad.map((r) => r.occupancy).sort((x, y) => x - y)
    if (!(occ[0] < DOT_RATIO * occ[2])) continue

    const oriented = orient(quad)
    if (!oriented.ok) continue
    const { tl, tr, bl, br } = oriented

    /**
     * All four anchors are the same size in code space, so their pixel
     * extents have to agree.
     *
     * Size AGREEMENT rather than size ordering is the load-bearing
     * invariant, and photographs of a real desk are what establish it:
     * a white browser window, a menu bar, the dock's brighter icons and
     * a monitor bezel are all achromatic, all bright, and all far bigger
     * than a seven-cell anchor, so "take the four largest" picks the
     * room and discards the code. The four anchors are drawn
     * IDENTICALLY; nothing else in shot agrees with them.
     *
     * It also rejects a quad of two real corners plus two pieces of
     * glare, which otherwise scores WELL - averaging eight edges over a
     * mongrel quad lands near the right scale by luck, and the span
     * ratio barely separates the rungs.
     *
     * Measured spread, as max edge over min edge: 1.00 square-on and
     * 1.67 at the harness's strongest keystone, which already reports a
     * tilt of 0.17 against the 0.12 the aiming guidance allows. The real
     * anchors in a failing capture measured 1.33. Mongrel quads in the
     * same frames measured 2.37 to 5.07, so 2.0 separates them with room
     * on both sides.
     */
    const edges = [tl.boxW, tl.boxH, tr.boxW, tr.boxH, bl.boxW, bl.boxH, br.boxW, br.boxH]
    if (Math.max(...edges) / Math.min(...edges) > SPREAD_LIMIT) continue

    // The box prior, from all four anchors' own pixel extents.
    const boxCell = edges.reduce((x, y) => x + y, 0) / edges.length / anchorSize
    if (!(boxCell > 0)) continue

    const spanX = Math.hypot(tr.cx - tl.cx, tr.cy - tl.cy)
    const spanY = Math.hypot(bl.cx - tl.cx, bl.cy - tl.cy)

    // Tilt, for the telemetry and the aiming guidance. Not a gate: a
    // legitimate capture reaches 0.229 across the rungs and a mongrel
    // quad measured 0.239, so it cannot separate them. Skew below can.
    const bottomEdge = Math.hypot(br.cx - bl.cx, br.cy - bl.cy)
    const rightEdge = Math.hypot(br.cx - tr.cx, br.cy - tr.cy)
    const tilt = Math.max(
      Math.abs(spanX - bottomEdge) / Math.max(spanX, bottomEdge),
      Math.abs(spanY - rightEdge) / Math.max(spanY, rightEdge),
    )

    for (const id of allowed) {
      const layout = layoutFor(id)
      // Anchor centres sit anchorSize/2 cells inside each corner, so the
      // centre-to-centre span is exactly (cols - anchorSize) cells.
      const cellX = spanX / (layout.cols - anchorSize)
      const cellY = spanY / (layout.rows - anchorSize)
      if (!(cellX > 0) || !(cellY > 0)) continue

      /**
       * The two axes measure the same cell, so disagreement means this
       * quad is not this rung's four corners.
       *
       * This is the sharpest test available, and the reason is that both
       * spans start at the SAME corner: perspective foreshortening
       * shortens tl->tr and tl->bl by nearly the same factor, so it
       * cancels almost exactly. Measured across all five rungs, four
       * keystones up to 0.12/0.07, two blur levels, two white balances
       * and a half-pixel shift, the worst legitimate skew was 0.006 -
       * while mongrel quads holding three real corners and one piece of
       * glare measured 0.124 to 0.130, twenty times larger.
       *
       * 0.03 is therefore a five-fold margin over anything legitimate
       * and a four-fold margin under anything spurious seen so far.
       */
      const skew = Math.abs(cellX - cellY) / Math.max(cellX, cellY)

      // The scale prior gets a generous tolerance on purpose: the prior
      // is the biased measurement and the spans are not.
      const cell = (cellX + cellY) / 2
      const scaleError = Math.abs(cell - boxCell) / boxCell

      const score = skew + scaleError

      /**
       * The closest thing to an answer seen, gates or no gates.
       *
       * Kept purely so a refusal can say what it nearly accepted. A
       * geometry failure reporting only a candidate count is what made
       * the field failure this selection exists for slow to diagnose:
       * "no four form a known grid" is true and useless, while "the
       * closest were a normal grid at 8.48 px/cell, off by 13% between
       * axes and 1% against the anchor size" says a reflection is
       * standing in for a corner.
       */
      if (!nearest || score < nearest.score) {
        nearest = { score, skew, scaleError, profile: id, pxPerCell: cell }
      }

      if (skew > SKEW_LIMIT || scaleError > SCALE_LIMIT) continue
      if (!best || score < best.score) {
        best = { score, skew, scaleError, tilt, profile: id, pxPerCell: cell, tl, tr, bl, br }
      }
    }
  }

  if (!best) {
    if (nearest) {
      const layout = layoutFor(nearest.profile)
      telemetry.nearestProfile = nearest.profile
      telemetry.estimatedCols = layout.cols
      telemetry.estimatedRows = layout.rows
      telemetry.skew = nearest.skew
      telemetry.scaleError = nearest.scaleError
      telemetry.pxPerCell = nearest.pxPerCell
    }
    return {
      ok: false,
      reason: nearest
        ? `no four of ${rings.length} anchor ring(s) form a known grid; the closest ` +
          `were a ${nearest.profile} grid at ${nearest.pxPerCell.toFixed(2)} px/cell, ` +
          `off by ${(nearest.skew * 100).toFixed(0)}% between axes and ` +
          `${(nearest.scaleError * 100).toFixed(0)}% against the anchor size`
        : `no four of ${rings.length} anchor ring(s) form a known grid`,
      telemetry,
    }
  }

  const { tl, tr, bl, br } = best
  const profile = best.profile
  const pxPerCell = best.pxPerCell
  telemetry.pxPerCell = pxPerCell
  telemetry.skew = best.skew
  telemetry.scaleError = best.scaleError

  const layout = layoutFor(profile)
  telemetry.estimatedCols = layout.cols
  telemetry.estimatedRows = layout.rows

  // Anchor centres in code space. Cell (x, y) spans [x, x+1), so a 7-cell
  // anchor filling cells 0..6 spans [0, 7) and its centre is at 3.5 - not at
  // 3. Half a cell of error here is several pixels at the panel edge, which is
  // enough to lose every frame while the profile detection still looks right.
  const half = layout.anchorSize / 2
  const src = [
    [half, half],
    [layout.cols - half, half],
    [half, layout.rows - half],
    [layout.cols - half, layout.rows - half],
  ]
  const dst = [
    [tl.cx, tl.cy],
    [tr.cx, tr.cy],
    [bl.cx, bl.cy],
    [br.cx, br.cy],
  ]

  let transform
  try {
    transform = homographyFromQuad(src, dst)
  } catch (error) {
    return { ok: false, reason: String(error.message || error), telemetry }
  }

  // Tilt, as the fractional disagreement between opposite edges. A square-on
  // capture has both pairs equal; perspective makes the far edge shorter. This
  // is what the aiming guidance turns into "straighten up". Computed during
  // quad selection, where the same edges were already to hand.
  const tilt = best.tilt

  telemetry.tilt = tilt
  telemetry.profileError = best.score

  // Whether the code's long edge (tl -> tr) lies along the capture's SHORT one
  // - an upright phone before a laptop webcam, or a laptop panel before an
  // upright phone. That caps px/tile at 1/1.78 of what the same distance would
  // give lined up (see emitter.js), and no amount of moving closer recovers it.
  const across = (Math.abs(tr.cy - tl.cy) > Math.abs(tr.cx - tl.cx)) !== (height > width)

  return {
    ok: true,
    transform,
    profile,
    pxPerCell,
    tilt,
    across,
    corners: { tl, tr, bl, br },
    telemetry,
  }
}
