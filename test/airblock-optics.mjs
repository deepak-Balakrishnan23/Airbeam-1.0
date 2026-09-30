/**
 * The whole optical chain, offline: render, photograph, sample, classify,
 * correct.
 *
 * This is the offline half of the instrumentation, doing double duty as a
 * regression test. It is the
 * most valuable file in the suite - not because the assertions are clever, but
 * because it found four real design errors before any hardware existed:
 *
 *   - a grid profile whose wide gutter cost 79% of the cells and bought
 *     nothing, because capture pixels per tile does not depend on the pitch
 *   - a symbol set annealed against a blur model an order of magnitude milder
 *     than the channel applies, which failed at 8% symbol errors
 *   - a half-pixel coordinate convention mismatch that the drift search
 *     silently absorbed, so the symptom was a decoder that mysteriously needed
 *     drift refinement on a pixel-perfect image
 *   - an interleave stride that coincided with the number of data cells per
 *     row, stacking a codeword into a vertical column
 *
 * None of those would have been obvious from a phone. Two of them would have
 * looked like "the camera is not good enough".
 */

import { encodeFrame, decodeFrame, capacityFor, readHeader } from '../src/optical/airblock/frame.js'
import { renderFrame } from '../src/optical/airblock/render.js'
import { sampleFrame } from '../src/optical/decoder/sample.js'
import { capture } from './degrade.mjs'
import {
  layoutFor,
  LADDER,
  DEFAULT_PROFILE,
  PROFILES,
  pxPerTile,
  pxPerTileAt,
  REFERENCE_CAPTURE,
} from '../src/optical/airblock/grid.js'
import { PX_PER_TILE_RANGE } from '../src/optical/airblock/symbols.js'

let failures = 0
const check = (label, ok, detail = '') => {
  if (ok) return
  failures++
  console.log(`   FAIL ${label}${detail ? ` - ${detail}` : ''}`)
}

// The condition the profile table's numbers are quoted at, so every figure
// printed below is directly comparable with the published ladder.
const CAMERA = {
  captureWidth: REFERENCE_CAPTURE.width,
  captureHeight: REFERENCE_CAPTURE.height,
  fill: REFERENCE_CAPTURE.fill,
}

function payloadFor(bytes) {
  const out = new Uint8Array(bytes)
  for (let i = 0; i < bytes; i++) out[i] = (i * 31 + 7) & 255
  return out
}

/**
 * One end-to-end pass. Returns the decode outcome plus the ground-truth symbol
 * error rate, which the decoder itself cannot know and which is the only
 * honest way to tell "the classifier is struggling" from "the error correction
 * is doing its job".
 */
function roundTrip(profile, degradation = {}, sampling = {}) {
  const layout = layoutFor(profile)
  const capacity = capacityFor(layout)
  const payload = payloadFor(Math.min(3000, capacity.payloadBytes))
  const { cells } = encodeFrame(payload, { profile })
  const rendered = renderFrame(cells, { profile })
  const shot = capture(rendered, { ...CAMERA, ...degradation })
  const read = sampleFrame(shot, { profile, transform: shot.transform, sampling })
  const out = decodeFrame(read.values, read.confidences, { profile })

  let wrong = 0
  let total = 0
  for (const raster of layout.dataCells) {
    if (cells[raster] === 0xff) continue
    total++
    if (read.values[raster] !== cells[raster]) wrong++
  }

  return {
    ok: out.ok,
    exact: out.ok && payload.every((b, i) => b === out.payload[i]),
    yield: out.telemetry.yield,
    rescued: out.telemetry.codewordsRetried,
    symbolErrorRate: wrong / total,
    meanConfidence: read.telemetry.meanConfidence,
    pxPerTile: pxPerTile(layout, read.telemetry.pxPerCell * layout.rows),
    header: readHeader(read.values, read.confidences, layout),
    payloadBytes: capacity.payloadBytes,
  }
}

// ------------------------------------------------------ the clean baseline --

{
  const run = roundTrip(DEFAULT_PROFILE)
  check('clean capture decodes', run.ok && run.exact, `yield ${run.yield}`)
  check('clean capture is error-free', run.symbolErrorRate === 0, `${(run.symbolErrorRate * 100).toFixed(2)}%`)
  check('clean confidence is high', run.meanConfidence > 0.95, run.meanConfidence.toFixed(3))
  // The header has to survive a real capture, not just a synthetic cell array.
  check('header reads off a photograph', run.header.profile === DEFAULT_PROFILE, run.header.reason ?? '')
  check('all four corners agree', run.header.corners.decoded === 4, JSON.stringify(run.header.corners))
}

// ------------------------------------------------------------ veiling glare --

/**
 * Chroma contracted toward grey, which is what a real camera hands back.
 *
 * This is the case that shipped broken. The colour stage compared each tile
 * against the IDEAL fully saturated palette and normalised its margin by that
 * palette's own separation, which is exact on a synthetic capture and wrong on
 * every real one - so nothing in this file caught it. A phone photographing a
 * laptop panel retained 23% of the ideal chroma spread on the red axis and 34%
 * on the blue, with a neutral white point, and the consequences were total:
 * green became unreachable and every cell's confidence was capped at about a
 * quarter of its true value.
 *
 * The floor is deliberately below what that capture measured. Decoding has to
 * survive worse than the worst thing seen in the field, not exactly it: 12%
 * and 6% of the chroma are well below it, and failed outright while the
 * colour estimator had a fixed floor on the spread (palette.js).
 */
for (const saturation of [0.6, 0.35, 0.2, 0.12, 0.06]) {
  const run = roundTrip(DEFAULT_PROFILE, { saturation, blurSigma: 0.8, noise: 2, vignette: 0.3 })
  check(
    `decodes with only ${Math.round(saturation * 100)}% of the chroma left`,
    run.ok && run.exact,
    `${(run.symbolErrorRate * 100).toFixed(2)}% errors, confidence ${run.meanConfidence.toFixed(3)}`,
  )
  // Confidence has to stay honest as well as high enough to decode: it gates
  // the erasure policy at 0.35 and the aiming guidance at 0.5, and a
  // systematically deflated one silently disables both.
  check(
    `confidence survives ${Math.round(saturation * 100)}% chroma`,
    run.meanConfidence > 0.6,
    run.meanConfidence.toFixed(3),
  )
  console.log(
    `   saturation ${saturation}: ${(run.symbolErrorRate * 100).toFixed(2)}% errors, ` +
      `confidence ${run.meanConfidence.toFixed(3)}, ${run.ok ? 'decoded' : 'FAILED'}`,
  )
}

/**
 * And the other side of that: a capture with no colour left at all must not
 * come back confident. Noise split into two "modes" looks like colour to a
 * two-means estimator, and without the separation test it read every cell
 * with a mean confidence near 0.68, which would switch off both the erasure
 * flags and the aiming guidance's "the link is not really working".
 */
{
  const run = roundTrip(DEFAULT_PROFILE, { saturation: 0, blurSigma: 0.8, noise: 2, vignette: 0.3 })
  check('a colourless capture does not decode', !run.ok)
  check('a colourless capture is not confident', run.meanConfidence < 0.5, run.meanConfidence.toFixed(3))
  console.log(`   saturation 0: confidence ${run.meanConfidence.toFixed(3)}, ${run.ok ? 'decoded' : 'failed, as it should'}`)
}

/**
 * A frame carrying far less payload than its capacity is zero-padded, and
 * symbol zero is green - so a partly filled frame is mostly one colour. Any
 * estimator that takes a MEAN rather than locating the two modes reads a
 * badly displaced threshold off such a frame. Measured before the fix: a
 * 3000-byte payload in a 5622-byte frame is 60% green, which moved the red
 * share's threshold from 0.25 to 0.136 and cost a third of the confidence on a
 * capture that had classified every single cell correctly.
 */
{
  const layout = layoutFor(DEFAULT_PROFILE)
  const capacity = capacityFor(layout)
  const short = roundTrip(DEFAULT_PROFILE, { saturation: 0.35, blurSigma: 0.8, noise: 2 })
  check(
    'a partly filled frame does not skew the colour thresholds',
    short.meanConfidence > 0.6,
    `${short.meanConfidence.toFixed(3)} on ${Math.min(3000, capacity.payloadBytes)} of ` +
      `${capacity.payloadBytes} B`,
  )
}

// --------------------------------------------------- a realistic photograph --

const REALISTIC = {
  blurSigma: 1.2,
  vignette: 0.35,
  noise: 2.5,
  tiltX: 0.02,
  tiltY: 0.01,
  shiftX: 0.45,
  shiftY: 0.35,
  whiteBalance: [1.0, 0.94, 1.1],
  fill: 0.9,
}

{
  const run = roundTrip(DEFAULT_PROFILE, REALISTIC)
  check('a realistic photograph decodes', run.ok && run.exact, `yield ${run.yield.toFixed(3)}`)
  console.log(
    `   realistic: ${(run.symbolErrorRate * 100).toFixed(2)}% symbol errors, ` +
      `confidence ${run.meanConfidence.toFixed(3)}, ${run.rescued} codeword(s) rescued by erasures`,
  )
}

// ------------------------------------------------- the tile's own threshold --

/**
 * The per-tile symbol threshold, as an assertion rather than an assumption.
 *
 * It replaced a 15x15-cell box mean scaled by the decided colour's luma, whose
 * whole claim was following vignetting: under 0.65 of it the box mean decoded
 * exactly at a mean confidence of 0.962, against 0.936 for one global
 * threshold. The tile's own threshold has to do at least as well there, and
 * decode a flat field too.
 */
{
  const heavy = roundTrip(DEFAULT_PROFILE, { vignette: 0.65, blurSigma: 1.0, noise: 2 })
  const flat = roundTrip(DEFAULT_PROFILE, { blurSigma: 1.0 })
  console.log(
    `   vignette 0.65: ${(heavy.symbolErrorRate * 100).toFixed(2)}% errors (conf ${heavy.meanConfidence.toFixed(3)}, ` +
      `${heavy.ok ? 'decoded' : 'FAILED'})  flat: ${(flat.symbolErrorRate * 100).toFixed(2)}% errors ` +
      `(conf ${flat.meanConfidence.toFixed(3)}, ${flat.ok ? 'decoded' : 'FAILED'})`,
  )
  check('the tile threshold decodes under heavy vignette', heavy.ok && heavy.exact)
  check(
    'and is at least as confident there as the box mean it replaced',
    heavy.meanConfidence >= 0.962,
    heavy.meanConfidence.toFixed(3),
  )
  check('the tile threshold decodes a flat field', flat.ok && flat.exact)
}

// ----------------------------------------------- drift refinement earns it --

{
  const shifted = { shiftX: 0.5, shiftY: 0.5, blurSigma: 1.0, vignette: 0.3, noise: 2 }
  const on = roundTrip(DEFAULT_PROFILE, shifted, { driftRefine: true })
  const off = roundTrip(DEFAULT_PROFILE, shifted, { driftRefine: false })
  console.log(
    `   half-pixel offset: drift on ${(on.symbolErrorRate * 100).toFixed(2)}% errors ` +
      `(conf ${on.meanConfidence.toFixed(3)})  vs  off ${(off.symbolErrorRate * 100).toFixed(2)}% ` +
      `(conf ${off.meanConfidence.toFixed(3)})`,
  )
  check(
    'drift refinement improves confidence',
    on.meanConfidence > off.meanConfidence,
    `${on.meanConfidence.toFixed(3)} vs ${off.meanConfidence.toFixed(3)}`,
  )
}

// -------------------------------------------------- the ladder is honest ----

/**
 * Every rung must decode at the blur it advertises, and the numbers in the
 * profile table must be the numbers the code produces.
 *
 * These are published in a comment that people will make decisions from, so
 * they get asserted rather than trusted.
 */
console.log('   ladder:')
for (const id of LADDER) {
  const profile = PROFILES.find((p) => p.id === id)
  const run = roundTrip(id, {
    blurSigma: profile.blurTolerance,
    vignette: 0.3,
    noise: 2,
    tiltX: 0.02,
    tiltY: 0.01,
    shiftX: 0.45,
    shiftY: 0.35,
    whiteBalance: [1.0, 0.94, 1.1],
  })
  console.log(
    `     ${id.padEnd(7)} ${String(run.payloadBytes).padStart(6)} B  ` +
      `${((run.payloadBytes * 15) / 1024).toFixed(0).padStart(3)} KB/s  ` +
      `px/tile ${run.pxPerTile.toFixed(1).padStart(4)}  at sigma ${profile.blurTolerance}: ` +
      `${(run.symbolErrorRate * 100).toFixed(2)}% errors, ${run.ok ? 'decoded' : 'FAILED'}`,
  )
  check(`${id} decodes at its advertised blur tolerance`, run.ok && run.exact)

  /**
   * The table's px/tile is a REFERENCE-CONDITION figure - square-on, at the
   * reference fill - so it is checked against `pxPerTileAt`, not against what
   * this particular capture measured. The measured value legitimately differs:
   * keystone shortens one edge, so the local scale at the corner where
   * telemetry samples it is not the mean scale. Asserting the two are equal
   * would be asserting that perspective does not exist.
   */
  check(
    `${id} table px/tile matches the reference condition`,
    Math.abs(pxPerTileAt(layoutFor(id)) - profile.pxPerTileAt720) < 0.25,
    `${pxPerTileAt(layoutFor(id)).toFixed(1)} vs ${profile.pxPerTileAt720}`,
  )
  // And the rung must be comfortable at its tolerance, not scraping through -
  // that is the whole point of declaring it below the cliff.
  check(
    `${id} has margin at its declared tolerance`,
    run.symbolErrorRate < 0.012,
    `${(run.symbolErrorRate * 100).toFixed(2)}% symbol errors`,
  )
}

// The cliff must be where the table says it is: a rung should decode at its
// declared tolerance and fail somewhere at or beyond its recorded cliff.
console.log('   cliff check:')
for (const id of LADDER) {
  const profile = PROFILES.find((p) => p.id === id)
  const beyond = roundTrip(id, {
    blurSigma: profile.measuredCliff + 0.4,
    vignette: 0.35,
    noise: 2.5,
    tiltX: 0.02,
    tiltY: 0.01,
    shiftX: 0.45,
    shiftY: 0.35,
    whiteBalance: [1.0, 0.94, 1.1],
  })
  console.log(
    `     ${id.padEnd(7)} at sigma ${(profile.measuredCliff + 0.4).toFixed(1)} ` +
      `(0.4 past its cliff): ${(beyond.symbolErrorRate * 100).toFixed(2)}% errors, ` +
      `${beyond.ok ? 'decoded' : 'failed'}`,
  )
  check(`${id} does not decode well past its cliff`, !beyond.ok, 'decoded anyway - the table understates it')
}

// ------------------------------------- px/tile is the knob, not a cliff ----

/**
 * The same rung, two cameras.
 *
 * This is the measurement that justifies the back channel existing at all. The
 * densest rung is unusable on a 720p camera at anything but sharp focus, and
 * comfortable on a 1080p one - a 2.3x throughput difference the sender has no
 * way to guess. It is also the check that keeps the "no cliff" claim in
 * grid.js honest: if a future symbol set makes sub-8 px/tile genuinely
 * impossible rather than merely fragile, the first line here starts failing.
 */
{
  const layout = layoutFor('max')
  const shared = { vignette: 0.35, noise: 2.5, tiltX: 0.02, shiftX: 0.45, shiftY: 0.35, fill: 0.9 }

  const sharp = roundTrip('max', { ...shared, blurSigma: 0.6 })
  check('the densest rung works at 720p in sharp focus', sharp.ok && sharp.exact, `${sharp.pxPerTile.toFixed(1)} px/tile`)
  check('and it really is below the annealed range', sharp.pxPerTile < PX_PER_TILE_RANGE[0], sharp.pxPerTile.toFixed(1))

  const soft720 = roundTrip('max', { ...shared, blurSigma: 1.2 })
  check('but not at 720p with moderate defocus', !soft720.ok, `${(soft720.symbolErrorRate * 100).toFixed(2)}% errors`)

  // The same rung, the same defocus, a better camera.
  const rendered = renderFrame(encodeFrame(payloadFor(3000), { profile: 'max' }).cells, { profile: 'max' })
  const shot = capture(rendered, { captureWidth: 1920, captureHeight: 1080, ...shared, blurSigma: 1.2 })
  const read = sampleFrame(shot, { profile: 'max', transform: shot.transform })
  const out = decodeFrame(read.values, read.confidences, { profile: 'max' })
  const px = pxPerTile(layout, read.telemetry.pxPerCell * layout.rows)
  console.log(
    `   densest rung at sigma 1.2:  720p (${soft720.pxPerTile.toFixed(1)} px/tile) ` +
      `${soft720.ok ? 'decoded' : 'FAILED'}  ->  1080p (${px.toFixed(1)} px/tile) ${out.ok ? 'decoded' : 'FAILED'}`,
  )
  check('the same rung and defocus decodes on a 1080p camera', out.ok, `${px.toFixed(1)} px/tile`)
}

console.log(failures ? `airblock-optics: ${failures} check(s) failed` : 'airblock-optics: the optical chain holds end to end')
process.exitCode = failures ? 1 : 0
