/**
 * Anchor detection and geometry recovery.
 *
 * Every other test in this suite hands the sampler the exact transform that
 * produced the image, which is the one thing a camera can never do. This is
 * the file that closes that gap: it detects the anchors, recovers the profile
 * and the homography from the pixels alone, and then decodes through the
 * recovered geometry rather than the true one.
 */

import { encodeFrame, decodeFrame, capacityFor, readHeader } from '../src/optical/airblock/frame.js'
import { renderFrame } from '../src/optical/airblock/render.js'
import { sampleFrame } from '../src/optical/decoder/sample.js'
import { capture } from './degrade.mjs'
import { seeded } from '../src/lib/random.js'
import { findGeometry } from '../src/optical/decoder/anchors.js'
import { layoutFor, LADDER, PROFILES, REFERENCE_CAPTURE } from '../src/optical/airblock/grid.js'

let failures = 0
const check = (label, ok, detail = '') => {
  if (ok) return
  failures++
  console.log(`   FAIL ${label}${detail ? ` - ${detail}` : ''}`)
}

const project = (h, x, y) => {
  const w = h[6] * x + h[7] * y + h[8]
  return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w]
}

const CAMERA = {
  captureWidth: REFERENCE_CAPTURE.width,
  captureHeight: REFERENCE_CAPTURE.height,
  fill: REFERENCE_CAPTURE.fill,
}

function shootFrame(profile, degradation = {}) {
  const layout = layoutFor(profile)
  const capacity = capacityFor(layout)
  const payload = new Uint8Array(Math.min(2000, capacity.payloadBytes))
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 17 + 3) & 255
  const { cells } = encodeFrame(payload, { profile })
  const rendered = renderFrame(cells, { profile })
  return { layout, payload, shot: capture(rendered, { ...CAMERA, ...degradation }) }
}

/** Worst disagreement between the recovered and true transform, in pixels. */
function geometryError(layout, truth, recovered) {
  let worst = 0
  const probes = [
    [0, 0],
    [layout.cols, 0],
    [0, layout.rows],
    [layout.cols, layout.rows],
    [layout.cols / 2, layout.rows / 2],
  ]
  for (const [cx, cy] of probes) {
    const [tx, ty] = project(truth, cx, cy)
    const [rx, ry] = project(recovered, cx, cy)
    worst = Math.max(worst, Math.hypot(tx - rx, ty - ry))
  }
  return worst
}

// ------------------------------------ every rung, detected from pixels only --

console.log('   rung     detected  geom err  px/cell  header    decode')
for (const profile of LADDER) {
  const { layout, payload, shot } = shootFrame(profile, {
    blurSigma: 0.8,
    vignette: 0.4,
    noise: 2,
    whiteBalance: [1.0, 0.95, 1.08],
  })

  const found = findGeometry(shot)
  check(`${profile} detected`, found.ok, found.reason ?? '')
  if (!found.ok) continue

  // The profile has to come out of the anchor spacing, before any header is
  // read - that is what breaks the circularity between geometry and format.
  check(`${profile} profile identified from geometry`, found.profile === profile, found.profile)

  const error = geometryError(layout, shot.transform, found.transform)
  const read = sampleFrame(shot, { profile: found.profile, transform: found.transform })
  const header = readHeader(read.values, read.confidences, layout)
  const out = decodeFrame(read.values, read.confidences, { profile: found.profile })

  console.log(
    `   ${profile.padEnd(8)} ${found.profile.padEnd(9)} ${error.toFixed(2).padStart(6)}px  ` +
      `${found.pxPerCell.toFixed(2).padStart(7)}  ${(header.profile ?? 'FAILED').padEnd(9)} ${out.ok ? 'ok' : 'FAIL'}`,
  )

  /**
   * The bar is "small enough for drift refinement to finish off", not
   * "sub-pixel".
   *
   * Per-cell refinement searches +/-7 px in 0.35 px steps, so a couple of
   * pixels of residual is squarely within what it is there for. This check
   * exists to catch a systematic blunder - it has already caught two, a
   * half-cell error in the anchor centre convention and a half-pixel error in
   * the centroid convention, each of which put every frame out of reach - not
   * to chase the last fraction of a pixel. Chasing it was tried: eroding the
   * mask to remove the defocus halo made this worse, not better.
   */
  check(`${profile} geometry is close enough to refine`, error < 2.5, `${error.toFixed(2)}px`)
  check(`${profile} header agrees with the geometry`, header.profile === profile, header.reason ?? '')
  check(`${profile} decodes through recovered geometry`, out.ok && payload.every((b, i) => b === out.payload[i]))
}

// ------------------------------------------------------------- perspective --

/**
 * Keystone, which is what an off-axis capture actually does - the far edge is
 * genuinely shorter than the near one.
 *
 * Worth being explicit about, because the first version of the degradation
 * model displaced two opposite corners inward instead. That looks like
 * perspective and is a shear: both pairs of opposite edges stay exactly the
 * same length, so it tests nothing that measures foreshortening and reported
 * zero tilt to the detector.
 */
console.log('   perspective:')
for (const [tiltX, tiltY] of [
  [0.02, 0],
  [0.05, 0.02],
  [0.09, 0.05],
]) {
  const { layout, payload, shot } = shootFrame('normal', { tiltX, tiltY, blurSigma: 0.8, noise: 2 })
  const found = findGeometry(shot)
  check(`tilt ${tiltX}/${tiltY} detected`, found.ok, found.reason ?? '')
  if (!found.ok) continue

  const read = sampleFrame(shot, { profile: found.profile, transform: found.transform })
  const out = decodeFrame(read.values, read.confidences, { profile: found.profile })
  console.log(
    `     tilt ${tiltX}/${tiltY}  reported ${found.tilt.toFixed(3)}  ` +
      `geom err ${geometryError(layout, shot.transform, found.transform).toFixed(2)}px  ` +
      `conf ${read.telemetry.meanConfidence.toFixed(3)}  ${out.ok ? 'decoded' : 'FAILED'}`,
  )
  // The metric has to actually respond, or the aiming guidance is decoration.
  check(`tilt ${tiltX}/${tiltY} is reported nonzero`, found.tilt > 0.01, found.tilt.toFixed(3))
  check(`tilt ${tiltX}/${tiltY} still decodes`, out.ok && payload.every((b, i) => b === out.payload[i]))
}

// A square-on capture must report no tilt, or the guidance will nag forever.
{
  const { shot } = shootFrame('normal', { blurSigma: 0.8 })
  const found = findGeometry(shot)
  check('square-on reports near-zero tilt', found.ok && found.tilt < 0.01, found.tilt?.toFixed(3))
}

// ------------------------------------------------------------ a turned code --

/**
 * A quarter-turned capture must decode exactly as well as an upright one.
 *
 * Two things ride on this and neither was covered. The emitter can paint the
 * code a quarter turn round, which is worth 1.78x in capture pixels per tile
 * to a phone held upright against a landscape panel (see emitter.js) - and it
 * only costs nothing because the decoder recovers orientation from the corner
 * anchor's own asymmetry rather than being told. The same code path is what
 * makes a phone held sideways work at all, which is how both field recordings
 * were actually shot, and nothing here exercised it.
 *
 * Turning the CAPTURE rather than the render is deliberate: it is the same
 * pixels either way, and it keeps the degradation model out of it.
 */
function turnClockwise(shot) {
  const { width, height, data } = shot
  const out = new Uint8ClampedArray(data.length)
  for (let y = 0; y < width; y++) {
    for (let x = 0; x < height; x++) {
      const src = ((height - 1 - x) * width + y) * 4
      const dst = (y * height + x) * 4
      out[dst] = data[src]
      out[dst + 1] = data[src + 1]
      out[dst + 2] = data[src + 2]
      out[dst + 3] = 255
    }
  }
  return { data: out, width: height, height: width }
}

for (const profile of ['far', 'normal', 'max']) {
  const { payload, shot } = shootFrame(profile, { blurSigma: 0.8, vignette: 0.3, noise: 2 })
  const upright = findGeometry(shot)
  let turned = turnClockwise(shot)
  for (let quarter = 1; quarter <= 4; quarter++) {
    const found = findGeometry(turned)
    check(`${profile} detected at ${quarter * 90} degrees`, found.ok, found.reason ?? '')
    if (found.ok) {
      check(`${profile} reads the same rung at ${quarter * 90} degrees`, found.profile === profile, found.profile)
      // The same code at the same distance: turning the picture cannot change
      // how many capture pixels landed on a tile.
      check(
        `${profile} measures the same scale at ${quarter * 90} degrees`,
        Math.abs(found.pxPerCell - upright.pxPerCell) < 0.35,
        `${found.pxPerCell.toFixed(2)} vs ${upright.pxPerCell.toFixed(2)}`,
      )
      const read = sampleFrame(turned, { profile: found.profile, transform: found.transform })
      const out = decodeFrame(read.values, read.confidences, { profile: found.profile })
      check(
        `${profile} decodes at ${quarter * 90} degrees`,
        out.ok && payload.every((b, i) => b === out.payload[i]),
        `conf ${read.telemetry.meanConfidence.toFixed(3)}`,
      )
      // Turning the picture turns its frame too, so the code still lies along it.
      check(`${profile} is not across its frame at ${quarter * 90} degrees`, found.across === false)
    }
    turned = turnClockwise(turned)
  }
}

/**
 * A tall code in a WIDE frame is across: an upright phone before a laptop
 * webcam. The receiver has to say "turn it sideways" rather than "move
 * closer", because the code's long edge already spans the frame's short one.
 */
{
  const tall = turnClockwise(shootFrame('far', { blurSigma: 0.8, noise: 2 }).shot)
  const wide = { width: tall.width * 2, height: tall.height, data: new Uint8ClampedArray(tall.width * 2 * tall.height * 4) }
  for (let y = 0; y < tall.height; y++) {
    wide.data.set(tall.data.subarray(y * tall.width * 4, (y + 1) * tall.width * 4), (y * wide.width + tall.width / 2) * 4)
  }
  const found = findGeometry(wide)
  check('a tall code in a wide frame is reported across', found.ok && found.across === true, found.reason ?? '')
}

// ------------------------------------------------------- framing and refusal --

// Detection must survive the code not filling the frame.
for (const fill of [0.95, 0.8, 0.6, 0.45]) {
  const { payload, shot } = shootFrame('far', { fill, blurSigma: 0.8, noise: 2 })
  const found = findGeometry(shot)
  check(`detected at ${fill} fill`, found.ok, found.reason ?? '')
  if (!found.ok) continue
  const read = sampleFrame(shot, { profile: found.profile, transform: found.transform })
  const out = decodeFrame(read.values, read.confidences, { profile: found.profile })
  check(`decodes at ${fill} fill`, out.ok && payload.every((b, i) => b === out.payload[i]), `px/cell ${found.pxPerCell.toFixed(1)}`)
}

/**
 * Refusal matters as much as detection.
 *
 * A detector that returns a confident transform for an image with no code in
 * it produces a whole frame of plausible garbage, which then has to be caught
 * by error correction that was budgeted for a few bad symbols. Better to say
 * no.
 */
{
  const blank = { data: new Uint8ClampedArray(1280 * 720 * 4), width: 1280, height: 720 }
  for (let i = 3; i < blank.data.length; i += 4) blank.data[i] = 255
  check('a black frame is refused', !findGeometry(blank).ok)

  const white = { data: new Uint8ClampedArray(1280 * 720 * 4).fill(255), width: 1280, height: 720 }
  check('a blown-out frame is refused', !findGeometry(white).ok)

  /**
   * Noise, which is the case most likely to produce spurious components.
   *
   * SEEDED, and repeated, because an unseeded single field is how a real
   * regression got through: a quad-enumerating selector accepted 47% of random
   * fields - 210 quads times five rungs is a thousand chances for four
   * unrelated blobs to agree on a scale - and one `Math.random()` field per run
   * passed often enough to look green for a whole afternoon. A detector that
   * locks onto noise reports healthy geometry for a frame with no code in it.
   */
  // The same generator degrade.js uses. A generator written in plain doubles
  // is NOT good enough here: a large multiply leaves 2^53 and loses the low
  // bits, so the field comes out structured rather than random and the check
  // passes for the wrong reason. random.js works in exact 32-bit integers.
  let acceptedNoise = 0
  for (let trial = 0; trial < 12; trial++) {
    const rand = seeded(1 + trial * 7919)
    const noise = { data: new Uint8ClampedArray(1280 * 720 * 4), width: 1280, height: 720 }
    for (let i = 0; i < noise.data.length; i += 4) {
      const v = rand() * 255
      noise.data[i] = v
      noise.data[i + 1] = v
      noise.data[i + 2] = v
      noise.data[i + 3] = 255
    }
    if (findGeometry(noise).ok) acceptedNoise++
  }
  check('no field of noise is accepted', acceptedNoise === 0, `${acceptedNoise} of 12 accepted`)

  // Only three anchors visible: the code is half out of shot. Must refuse
  // rather than fit a transform to whatever it can see.
  const { shot } = shootFrame('normal', { blurSigma: 0.8 })
  const cropped = { ...shot, data: shot.data.slice() }
  for (let y = 0; y < 260; y++) {
    for (let x = 0; x < cropped.width; x++) {
      const p = (y * cropped.width + x) * 4
      cropped.data[p] = cropped.data[p + 1] = cropped.data[p + 2] = 0
    }
  }
  const partial = findGeometry(cropped)
  check('a partly visible code is refused', !partial.ok, partial.ok ? 'accepted' : partial.reason)
}

/**
 * Specular reflection on the sending screen.
 *
 * This is the failure that motivated validated quad selection, and it was
 * found in a real capture rather than reasoned about: glare on a laptop panel
 * makes a bright HOLLOW blob, which passes the solid-blob rejection, can be
 * larger than an anchor, and has nothing at its centre - so under the old
 * inner-component test it read as the orientation anchor. Two of those and
 * orientation fails; worse, a quad of three real corners plus one blob fits a
 * rung closely enough on scale alone to return a confidently wrong transform.
 *
 * Both outcomes are checked for, because the second is the dangerous one: a
 * wrong grid decodes to a full frame of plausible garbage while px/tile and
 * squareness both still read healthy, which is indistinguishable from a soft
 * picture from the outside.
 */
{
  const glare = (shot, cx, cy, outer, thickness) => {
    const out = { ...shot, data: shot.data.slice() }
    for (let y = cy - outer; y <= cy + outer; y++) {
      for (let x = cx - outer; x <= cx + outer; x++) {
        if (x < 0 || y < 0 || x >= out.width || y >= out.height) continue
        const edge = Math.max(Math.abs(x - cx), Math.abs(y - cy))
        if (edge < outer - thickness) continue
        const p = (y * out.width + x) * 4
        out.data[p] = out.data[p + 1] = out.data[p + 2] = 255
      }
    }
    return out
  }

  const { layout, shot } = shootFrame('normal', { blurSigma: 1.0, noise: 2 })
  const truth = findGeometry(shot)
  check('the unglared reference locks', truth.ok, truth.reason ?? '')

  // A hollow streak in open payload, larger than an anchor. The real one
  // measured 110x143 against anchors of about 60x60.
  const beside = glare(shot, (shot.width * 0.55) | 0, (shot.height * 0.5) | 0, 62, 8)
  const found = findGeometry(beside)
  check('glare beside the code does not displace an anchor', found.ok, found.reason ?? '')
  check(
    'glare beside the code still reads the right rung',
    !found.ok || found.profile === 'normal',
    `read ${found.profile}`,
  )
  if (found.ok && truth.ok) {
    const drift = Math.hypot(
      found.corners.tl.cx - truth.corners.tl.cx,
      found.corners.tl.cy - truth.corners.tl.cy,
    )
    check('glare beside the code leaves the corners put', drift < 2, `${drift.toFixed(2)} px`)
  }

  // Two of them, so the old "no inner component means orientation anchor"
  // test would see three orientation anchors rather than one.
  const twice = glare(
    glare(shot, (shot.width * 0.45) | 0, (shot.height * 0.4) | 0, 58, 7),
    (shot.width * 0.6) | 0,
    (shot.height * 0.62) | 0,
    64,
    9,
  )
  const pair = findGeometry(twice)
  check('two glare blobs do not defeat orientation', pair.ok, pair.reason ?? '')
  check(
    'two glare blobs still read the right rung',
    !pair.ok || pair.profile === 'normal',
    `read ${pair.profile}`,
  )

  // Glare landing ON a corner destroys that anchor outright. Nothing can
  // recover it, so the only acceptable answers are a correct lock or a
  // refusal - never a different rung.
  const onCorner = glare(shot, (shot.width * 0.11) | 0, (shot.height * 0.1) | 0, 70, 10)
  const hit = findGeometry(onCorner)
  check(
    'glare over a corner never invents a rung',
    !hit.ok || hit.profile === 'normal',
    `read ${hit.profile}`,
  )
  if (hit.ok) {
    const read = sampleFrame(onCorner, { profile: hit.profile, transform: hit.transform })
    const header = readHeader(read.values, read.confidences, layout)
    check(
      'a lock through corner glare agrees with the header',
      header.ok === false || header.profile === hit.profile,
      `geometry ${hit.profile}, header ${header.profile}`,
    )
  }
}


// ------------------------------------------ bright clutter around the code --

/**
 * A photograph of a screen contains the room the screen is in.
 *
 * Anchors used to be chosen as the four largest colourless blobs, on the
 * assumption that clutter is smaller than an anchor. A real capture of a
 * desktop says otherwise: a white browser window, a menu bar, a dock icon and
 * a monitor bezel are all achromatic, all bright, and all bigger than a
 * seven-cell anchor. On a recording of a failing transfer the detector found
 * twelve rings and four candidate orientation marks in a frame containing
 * exactly four anchors.
 *
 * So the selector must key on the anchors agreeing with EACH OTHER about size,
 * not on being the biggest thing in the room.
 */
{
  const profile = 'normal'
  const layout = layoutFor(profile)
  const payload = Uint8Array.from({ length: 512 }, (_, i) => (i * 31) & 255)
  const { cells } = encodeFrame(payload, { profile })
  const rendered = renderFrame(cells, { profile })
  const shot = capture(rendered, { blurSigma: 0.8, noise: 2, fill: 0.62 })

  const clean = findGeometry(shot)
  check('clutter test: the clean capture locks first', clean.ok, clean.reason ?? '')

  // White rectangles around the panel, each far larger than an anchor.
  const anchorPx = clean.telemetry.pxPerCell * 7
  const withClutter = {
    data: Uint8ClampedArray.from(shot.data),
    width: shot.width,
    height: shot.height,
  }
  // Hollow, because that is what real clutter looks like to a ring detector:
  // a window border, a bezel and an icon outline all enclose something darker,
  // which is exactly the outer/inner pairing an anchor is recognised by.
  const box = (x0, y0, w, h) => {
    const edge = Math.max(2, Math.round(anchorPx / 6))
    for (let y = y0; y < Math.min(y0 + h, withClutter.height); y++) {
      for (let x = x0; x < Math.min(x0 + w, withClutter.width); x++) {
        const border =
          x < x0 + edge || x >= x0 + w - edge || y < y0 + edge || y >= y0 + h - edge
        const p = (y * withClutter.width + x) * 4
        withClutter.data[p] = border ? 252 : 8
        withClutter.data[p + 1] = border ? 252 : 8
        withClutter.data[p + 2] = border ? 250 : 10
      }
    }
  }
  const big = Math.round(anchorPx * 2.5)
  box(2, 2, withClutter.width - 4, big) // a menu bar across the top
  box(2, withClutter.height - big - 2, withClutter.width - 4, big) // a dock
  box(2, big + 6, big, big) // a window corner
  box(withClutter.width - big - 2, big + 6, big, big) // and another

  const cluttered = findGeometry(withClutter)
  check(
    'the code is still found among bigger bright objects',
    cluttered.ok && cluttered.profile === profile,
    cluttered.reason ?? `profile ${cluttered.profile}, ${cluttered.telemetry.rings} ring(s)`,
  )
}

// ---------------------------------------- ten of them, and a tracked frame --

/**
 * Ten bright hollow objects, each a larger ring than an anchor.
 *
 * Four were survivable when anchors were chosen from the ten largest rings;
 * ten were not, and a phone held small in a lit office supplies ten. Anchors
 * are now chosen by pattern and size agreement, so the count does not matter.
 */
{
  const profile = 'normal'
  const layout = layoutFor(profile)
  const payload = Uint8Array.from({ length: 512 }, (_, i) => (i * 31) & 255)
  const { cells } = encodeFrame(payload, { profile })
  const shot = capture(renderFrame(cells, { profile }), { blurSigma: 0.8, noise: 2, fill: 0.6 })
  const room = { data: Uint8ClampedArray.from(shot.data), width: shot.width, height: shot.height }
  const anchorPx = ((shot.width * 0.6) / layout.cols) * 7
  const size = Math.round(Math.min(anchorPx * 2.5, (shot.height * 0.4) / 2 - 12))
  const box = (x0, y0) => {
    for (let y = y0; y < y0 + size; y++) {
      for (let x = x0; x < x0 + size; x++) {
        const edge = x < x0 + 3 || x >= x0 + size - 3 || y < y0 + 3 || y >= y0 + size - 3
        const p = (y * room.width + x) * 4
        room.data[p] = room.data[p + 1] = room.data[p + 2] = edge ? 250 : 12
      }
    }
  }
  for (const f of [0.05, 0.4, 0.75]) {
    box(8, Math.round(f * (room.height - size)))
    box(room.width - size - 8, Math.round(f * (room.height - size)))
  }
  for (const f of [0.35, 0.6]) {
    box(Math.round(f * (room.width - size)), 6)
    box(Math.round(f * (room.width - size)), room.height - size - 6)
  }
  const found = findGeometry(room)
  check(
    'the code is found among ten bigger hollow objects',
    found.ok && found.profile === profile,
    found.reason ?? `profile ${found.profile}, ${found.telemetry.rings} ring(s)`,
  )
}

/**
 * Tracking finds what a full search finds, and a miss falls back to one.
 *
 * The next frame, a hand's jitter along, searched only around the previous
 * anchors: it must come back tracked, with the same corners to a small
 * fraction of a pixel. Windows put somewhere else must miss and still find the
 * code, by the full search.
 */
{
  const profile = 'normal'
  const first = shootFrame(profile, { blurSigma: 0.8, noise: 2 })
  const next = shootFrame(profile, { blurSigma: 0.8, noise: 2, shiftX: 2, shiftY: 1.5, seed: 9 })
  const previous = findGeometry(first.shot)
  const image = next.shot
  const full = findGeometry(image)
  const tracked = findGeometry(image, { previous })
  const off = (a, b) =>
    Math.max(...['tl', 'tr', 'bl', 'br'].map((k) => Math.hypot(a.corners[k].cx - b.corners[k].cx, a.corners[k].cy - b.corners[k].cy)))
  check('a steady frame is tracked', tracked.ok && tracked.telemetry.tracked === true, tracked.reason ?? '')
  check('tracking finds the same corners', tracked.ok && full.ok && off(tracked, full) < 0.05, tracked.ok && full.ok ? `${off(tracked, full).toFixed(3)} px` : '')

  const elsewhere = {
    corners: Object.fromEntries(
      Object.entries(previous.corners).map(([k, r]) => [k, { ...r, minX: r.minX + 4 * r.boxW, maxX: r.maxX + 4 * r.boxW }]),
    ),
  }
  const missed = findGeometry(image, { previous: elsewhere })
  check('a miss falls back to the full search', missed.ok && !missed.telemetry.tracked && missed.profile === profile, missed.reason ?? '')
}

console.log(failures ? `airblock-anchors: ${failures} check(s) failed` : 'airblock-anchors: geometry recovers from pixels alone')
process.exitCode = failures ? 1 : 0
