/**
 * Read cell values out of a captured image.
 *
 * Three things happen here, in this order, and the order matters:
 *
 *   1. A global sub-pixel alignment search. Cheap, and it addresses the
 *      dominant term: measured against the generated symbol set, half a bit of
 *      misalignment costs more classifier margin than heavy defocus does.
 *      Systematic misalignment is also the easiest kind to fix,
 *      because every cell shares it.
 *
 *   2. A decision threshold per tile. Every symbol lights exactly half its
 *      tile by construction, so each tile's own 32nd and 33rd samples bracket
 *      the level at which it is lit (classify.js). That follows vignetting,
 *      lens falloff, screen non-uniformity and white-balance drift as closely
 *      as anything can - it is measured at the tile - and it does not depend
 *      on the colour decision. It replaced a 15x15-cell box mean scaled by
 *      the decided colour's luma.
 *
 *   3. Per-cell drift refinement for the cells that are still uncertain,
 *      propagated in confidence order from cells that are not. Geometry here
 *      is per-cell, not per-frame: a single homography cannot describe a
 *      panel photographed off-axis through a lens with its own distortion.
 *
 * Drift refinement can be switched off, because a claim that it helps is
 * worth nothing without the same measurement taken with it absent.
 */

import { layoutFor } from '../airblock/grid.js'
import { BLANK } from '../airblock/frame.js'
import { SYMBOL_BITS } from '../airblock/symbols.js'
import { classifyCell } from './classify.js'
import { estimateChroma } from '../airblock/palette.js'

/** How far a cell's sample window may wander from the predicted position, in px. */
export const MAX_DRIFT_PX = 7

export const SAMPLING = {
  driftRefine: true,
  /** Confidence below which a cell is worth spending a refinement search on. */
  refineFloor: 0.75,
  /**
   * Share of cells under `refineFloor` at which the frame is not refined.
   *
   * Past it the frame is below its resolution or blur cliff, and refining
   * chases noise. Measured over 207 captures of every rung at 720p and 1080p,
   * fill 0.45 to 0.95, blur 0 to 2: above 0.78 refining
   * recovered nothing on average and often cost codewords (0.84 of them to
   * 0.64, 0.77 to 0.44), while taking 60 to 470 ms a frame, time a phone's
   * three decoders needed for the frames they could read. 0.78 gave the most
   * codewords of any cutoff from 0.6 to 0.9.
   */
  hopeless: 0.78,
  /** Sub-pixel step for both searches. */
  driftStep: 0.35,
}

/**
 * Affine transform for an unwarped render: code space (cell units) straight to
 * render pixels. This is what the offline harness uses, and what the camera
 * path degenerates to when the phone is held perfectly square.
 */
export function identityTransform(layout) {
  return Float64Array.from([layout.pitch, 0, layout.originX, 0, layout.pitch, layout.originY, 0, 0, 1])
}

/** Project a code-space point through a 3x3 homography. */
function project(h, cx, cy, out) {
  const w = h[6] * cx + h[7] * cy + h[8]
  out[0] = (h[0] * cx + h[1] * cy + h[2]) / w
  out[1] = (h[3] * cx + h[4] * cy + h[5]) / w
}

/** Rec. 601 luma plane, 0..1. One pass, so bilinear sampling is four reads. */
export function lumaPlane(data, width, height) {
  const out = new Float32Array(width * height)
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = (0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]) / 255
  }
  return out
}

/**
 * Bilinear luma.
 *
 * Sub-pixel accuracy is the point: with nearest-neighbour sampling a drift
 * adjustment does nothing at all until it crosses a whole pixel, which defeats
 * the sub-pixel search that matters most.
 *
 * Coordinates are continuous, with pixel `k` covering `[k, k+1)` and therefore
 * centred at `k + 0.5`. The half-pixel subtraction below converts to the
 * centre-on-integer indexing the interpolation needs. Getting this wrong
 * leaves a uniform half-pixel misalignment across the whole panel - which the
 * global drift search then quietly absorbs, so the symptom is not a broken
 * decode but a decode that inexplicably depends on drift refinement even on a
 * pixel-perfect image.
 */
function sampleLuma(luma, width, height, cx, cy) {
  const x = cx - 0.5
  const y = cy - 0.5
  if (x < 0 || y < 0 || x >= width - 1 || y >= height - 1) return 0
  const x0 = x | 0
  const y0 = y | 0
  const fx = x - x0
  const fy = y - y0
  const i = y0 * width + x0
  const top = luma[i] + (luma[i + 1] - luma[i]) * fx
  const bottom = luma[i + width] + (luma[i + width + 1] - luma[i + width]) * fx
  return top + (bottom - top) * fy
}

/**
 * Sample one tile's 64 bit positions.
 *
 * Luma is interpolated at every position, because the symbol decision needs
 * all 64 and because sub-pixel accuracy is what the drift search is adjusting.
 *
 * Colour is read nearest-neighbour and at only every other position in each
 * axis - 16 of the 64. A tile is drawn in exactly ONE colour, so the sum only
 * has to establish which; sampling all 64 measures the same thing four times
 * over.
 *
 * The 81 ms per frame this was once measured at, which capped the receiver at
 * 12.4 fps against a sender running at 15, was NOT mostly this loop as the
 * note here used to claim. It was the refinement pass in step 3 running on
 * every cell in the frame: colour confidence was collapsing on any real
 * capture (see palette.js), every cell therefore sat below `refineFloor`, and
 * each one bought a nine-point search it did not need. With the colour stage
 * reading honest confidences the same frame samples in 26 ms. The stride is
 * still worth keeping - it is free - but it was not where the time went.
 */
const COLOUR_STRIDE = 2

/** sampleFrame's per-cell buffers, reused from frame to frame. */
let rectified = null

/**
 * Where a tile's 64 bit positions land in the capture, before any drift.
 *
 * Drift is added after projection, so every drift a search tries for one cell
 * shares these: the global alignment tries 25 per probe and refinement 9 per
 * uncertain cell, and each used to project all 64 points through the
 * homography again.
 */
function projectTile(layout, h, x, y, points, point) {
  const bitStep = layout.profile.tileScale / layout.pitch
  for (let by = 0; by < SYMBOL_BITS; by++) {
    const cy = y + (by + 0.5) * bitStep
    for (let bx = 0; bx < SYMBOL_BITS; bx++) {
      project(h, x + (bx + 0.5) * bitStep, cy, point)
      const k = (by * SYMBOL_BITS + bx) * 2
      points[k] = point[0]
      points[k + 1] = point[1]
    }
  }
}

function sampleTile(image, luma, points, driftX, driftY, samples) {
  const { width, height, data } = image
  let sumR = 0
  let sumG = 0
  let sumB = 0
  let total = 0

  for (let by = 0; by < SYMBOL_BITS; by++) {
    const takeColourRow = by % COLOUR_STRIDE === 0
    for (let bx = 0; bx < SYMBOL_BITS; bx++) {
      const k = (by * SYMBOL_BITS + bx) * 2
      const px = points[k] + driftX
      const py = points[k + 1] + driftY

      const value = sampleLuma(luma, width, height, px, py)
      samples[by * SYMBOL_BITS + bx] = value
      total += value

      if (!takeColourRow || bx % COLOUR_STRIDE !== 0) continue
      const ix = px | 0
      const iy = py | 0
      if (ix >= 0 && iy >= 0 && ix < width && iy < height) {
        const p = (iy * width + ix) * 4
        sumR += data[p]
        sumG += data[p + 1]
        sumB += data[p + 2]
      }
    }
  }

  return { mean: total / 64, sumR, sumG, sumB }
}

/**
 * Read a whole frame.
 *
 * @param {{data: Uint8ClampedArray, width: number, height: number}} image
 * @param {object} [options]
 * @param {string} [options.profile]
 * @param {Float64Array} [options.transform] code space -> image pixels
 * @returns {{values: Uint8Array, confidences: Float32Array, telemetry: object}}
 */
export function sampleFrame(image, options = {}) {
  const layout = layoutFor(options.profile)
  const settings = { ...SAMPLING, ...options.sampling }
  const transform = options.transform ?? identityTransform(layout)
  // Stage boundaries, for the telemetry's cost split. Sampling and classifying
  // interleave below, so these are stages rather than pure per-kind totals.
  const t0 = performance.now()
  const luma = options.luma ?? lumaPlane(image.data, image.width, image.height)
  const tLuma = performance.now()

  const { cols, rows, role } = layout
  const cellCount = cols * rows

  const values = new Uint8Array(cellCount).fill(BLANK)
  const confidences = new Float32Array(cellCount)
  const cellMean = new Float32Array(cellCount)
  const valid = new Uint8Array(cellCount)
  const sumR = new Float32Array(cellCount)
  const sumG = new Float32Array(cellCount)
  const sumB = new Float32Array(cellCount)
  const driftX = new Float32Array(cellCount)
  const driftY = new Float32Array(cellCount)

  const samples = new Float32Array(64)
  const point = new Float64Array(2)
  const points = new Float64Array(128)
  let pointsFor = -1
  /**
   * Every cell's 64 samples at its global drift: the capture rectified onto
   * the render grid, once. Classification reads these rather than sampling
   * the whole frame a second time at the same positions. Kept between frames
   * (5.5 MB on `max`), and only cells written this frame are ever read.
   */
  if (!rectified || rectified.samples.length < cellCount * 64) {
    rectified = {
      samples: new Float32Array(cellCount * 64),
      sums: new Float64Array(cellCount * 3),
    }
  }
  const cellSamples = rectified.samples
  // The colour sums at full precision, as a fresh measurement would hand them
  // to the classifier; the Float32 copies above feed the chroma estimate.
  const cellSums = rectified.sums
  const sampled = []

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x
      if (role[i] === 1) continue // anchor: not payload, and white enough to skew the mean
      sampled.push(i)
      valid[i] = 1
    }
  }

  /** Sample one cell at a given drift and store the raw measurements. */
  const measure = (i, dx, dy) => {
    if (pointsFor !== i) {
      projectTile(layout, transform, i % cols, (i / cols) | 0, points, point)
      pointsFor = i
    }
    const out = sampleTile(image, luma, points, dx, dy, samples)
    cellMean[i] = out.mean
    sumR[i] = out.sumR
    sumG[i] = out.sumG
    sumB[i] = out.sumB
    return out
  }

  // ---- 1. global sub-pixel alignment, on a sparse sample of cells ----------

  const telemetry = { globalDriftX: 0, globalDriftY: 0, refined: 0, refineHits: 0 }

  if (settings.driftRefine) {
    // Every 61st cell: coprime with the column count for every profile here,
    // so the probe walks the panel rather than sampling one column of it.
    const probes = []
    for (let n = 0; n < sampled.length; n += 61) probes.push(sampled[n])

    // Probe by probe, so each probe's projection serves all 25 drifts. Every
    // score still sums its probes in the same order, so the choice is the
    // same as sweeping drift by drift.
    const step = settings.driftStep
    const scores = new Float64Array(25)
    for (const i of probes) {
      for (let s = 0; s < 25; s++) {
        const dx = ((s % 5) - 2) * step
        const dy = (((s / 5) | 0) - 2) * step
        const out = measure(i, dx, dy)
        /**
         * Scored on the cell's confidence, against a threshold taken from
         * the probe's own mean. The local box mean does not exist yet, and
         * for choosing between alignments a per-cell level is good enough.
         *
         * Confidence rather than raw symbol margin, and the difference is
         * the clamp: confidence saturates at a margin of MARGIN_SCALE, so
         * the sum counts how many probes are CERTAIN rather than totalling
         * their margins, and an alignment cannot win by being excellent for
         * a few cells and poor for the rest. Tried both once the colour
         * stage stopped capping this - a wash on synthetic captures, and
         * 122 codewords against 110 on a real one.
         */
        const cell = classifyCell(samples, out.mean, out.sumR, out.sumG, out.sumB)
        scores[s] += cell.confidence
      }
    }
    let bestScore = -Infinity
    for (let s = 0; s < 25; s++) {
      if (scores[s] > bestScore) {
        bestScore = scores[s]
        telemetry.globalDriftX = ((s % 5) - 2) * step
        telemetry.globalDriftY = (((s / 5) | 0) - 2) * step
      }
    }
  }

  driftX.fill(telemetry.globalDriftX)
  driftY.fill(telemetry.globalDriftY)
  const tAlign = performance.now()

  // ---- 2. full sample, then the local threshold ---------------------------

  for (const i of sampled) {
    const out = measure(i, driftX[i], driftY[i])
    cellSamples.set(samples, i * 64)
    cellSums[i * 3] = out.sumR
    cellSums[i * 3 + 1] = out.sumG
    cellSums[i * 3 + 2] = out.sumB
  }

  // The frame's mean level, which tells a painted tile from an unpainted one.
  let globalSum = 0
  for (const i of sampled) globalSum += cellMean[i]
  const global = sampled.length ? globalSum / sampled.length : 0
  telemetry.globalMean = global

  /**
   * The frame's own chroma reference: where the two colour thresholds sit and
   * how wide the cloud around them is.
   *
   * Estimated globally rather than over a box neighbourhood like the luma
   * threshold, because the measurement says a local estimate buys nothing
   * here. On the capture this was built from, per-cell box thresholds scored a
   * mean colour confidence of 0.670 against 0.667 for one pair of numbers over
   * the whole panel - so the bias this corrects is a contraction of the whole
   * cloud rather than a gradient across the panel, and two scalars describe it
   * as well as two more integral images would.
   */
  const shareR = new Float32Array(cellCount)
  const shareB = new Float32Array(cellCount)
  const lit = []
  for (const i of sampled) {
    const total = sumR[i] + sumG[i] + sumB[i]
    if (total <= 0) continue
    shareR[i] = sumR[i] / total
    shareB[i] = sumB[i] / total
    // Dark cells are excluded: a frame carrying a payload shorter than its own
    // capacity leaves the remaining cells BLANK and unpainted, and a cell with
    // no light in it has no colour to contribute. A quarter of the frame's own
    // mean level separates a painted tile, which lights half its bits, from
    // one that was never painted at all.
    if (cellMean[i] > global * 0.25) lit.push(i)
  }
  const chroma = estimateChroma(shareR, shareB, lit)
  telemetry.chromaCells = lit.length
  telemetry.chromaU = chroma.u
  telemetry.chromaV = chroma.v
  telemetry.chromaScaleU = chroma.scaleU
  telemetry.chromaScaleV = chroma.scaleV
  const tSample = performance.now()

  // ---- 3. classify, then refine what is still uncertain -------------------

  const classifyAt = (i, dx, dy) => {
    const out = measure(i, dx, dy)
    return classifyCell(samples, out.mean, out.sumR, out.sumG, out.sumB, chroma)
  }

  for (const i of sampled) {
    const tile = cellSamples.subarray(i * 64, i * 64 + 64)
    const cell = classifyCell(tile, cellMean[i], cellSums[i * 3], cellSums[i * 3 + 1], cellSums[i * 3 + 2], chroma)
    values[i] = cell.value
    confidences[i] = cell.confidence
  }
  const tClassify = performance.now()

  let uncertain = 0
  for (const i of sampled) if (confidences[i] < settings.refineFloor) uncertain++
  telemetry.uncertainShare = sampled.length ? uncertain / sampled.length : 0
  telemetry.refineSkipped = telemetry.uncertainShare >= settings.hopeless

  if (settings.driftRefine && !telemetry.refineSkipped) {
    // Confidence order, best first, so a cell being refined can inherit a
    // drift from a neighbour that already resolved cleanly.
    const order = sampled.slice().sort((a, b) => confidences[b] - confidences[a])
    const settled = new Uint8Array(cellCount)

    for (const i of order) {
      settled[i] = 1
      if (confidences[i] >= settings.refineFloor) continue
      telemetry.refined++

      // Seed from the most confident settled neighbour.
      const x = i % cols
      const y = (i / cols) | 0
      let seedX = driftX[i]
      let seedY = driftY[i]
      let seedConfidence = -1
      for (const [nx, ny] of [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ]) {
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue
        const n = ny * cols + nx
        if (!settled[n] || !valid[n]) continue
        if (confidences[n] > seedConfidence) {
          seedConfidence = confidences[n]
          seedX = driftX[n]
          seedY = driftY[n]
        }
      }

      let bestValue = values[i]
      let bestConfidence = confidences[i]
      let bestX = driftX[i]
      let bestY = driftY[i]

      // The first candidate to reach full confidence is the one the search
      // would keep, since nothing can beat it and ties go to the first, so
      // stopping there leaves the choice exactly as nine points make it.
      search: for (let sy = -1; sy <= 1; sy++) {
        for (let sx = -1; sx <= 1; sx++) {
          const dx = seedX + sx * settings.driftStep
          const dy = seedY + sy * settings.driftStep
          if (Math.abs(dx) > MAX_DRIFT_PX || Math.abs(dy) > MAX_DRIFT_PX) continue
          const cell = classifyAt(i, dx, dy)
          if (cell.confidence > bestConfidence) {
            bestConfidence = cell.confidence
            bestValue = cell.value
            bestX = dx
            bestY = dy
            if (bestConfidence >= 1) break search
          }
        }
      }

      if (bestConfidence > confidences[i]) telemetry.refineHits++
      values[i] = bestValue
      confidences[i] = bestConfidence
      driftX[i] = bestX
      driftY[i] = bestY
    }
  }

  // ---- telemetry ----------------------------------------------------------

  const tRefine = performance.now()
  telemetry.stageMs = {
    luma: tLuma - t0,
    align: tAlign - tLuma,
    sample: tSample - tAlign,
    classify: tClassify - tSample,
    refine: tRefine - tClassify,
  }

  let confidenceSum = 0
  let weak = 0
  const histogram = new Int32Array(10)
  for (const i of sampled) {
    confidenceSum += confidences[i]
    if (confidences[i] < 0.35) weak++
    histogram[Math.min(9, (confidences[i] * 10) | 0)]++
  }

  telemetry.cells = sampled.length
  telemetry.meanConfidence = confidenceSum / sampled.length
  telemetry.weakCells = weak
  telemetry.confidenceHistogram = histogram
  // Pixels per cell in the capture, which is the number the aiming guidance
  // compares against a target - it is the honest measure of "close enough".
  const p0 = new Float64Array(2)
  const p1 = new Float64Array(2)
  project(transform, 0, 0, p0)
  project(transform, 1, 0, p1)
  telemetry.pxPerCell = Math.hypot(p1[0] - p0[0], p1[1] - p0[1])

  return { values, confidences, driftX, driftY, telemetry, layout }
}
