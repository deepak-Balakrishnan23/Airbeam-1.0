/**
 * The reverse link: the receiver's status code, written and read.
 *
 * The back channel's whole job is to say "stop" and "change rung". Both are
 * decisions that are worse to get wrong than to get late - a spurious done flag
 * cuts a transfer off mid-file, and a spurious rung change costs frames while
 * both ends disagree about the format. So the interesting tests here are the
 * refusals, not the successes.
 */

import {
  packStatus,
  unpackStatus,
  renderBeacon,
  readBeacon,
  BEACON_WIDTH,
  BEACON_HEIGHT,
} from '../src/optical/backchannel.js'
import { chooseProfile, assess, createGuide, Level } from '../src/optical/guidance.js'
import { LADDER, PROFILES } from '../src/optical/airblock/grid.js'

let failures = 0
const check = (label, ok, detail = '') => {
  if (ok) return
  failures++
  console.log(`   FAIL ${label}${detail ? ` - ${detail}` : ''}`)
}

// ------------------------------------------------------------------ packing --

for (const status of [
  { session: 0, done: false, progress: 0, pxPerTile: 0, confidence: 0, decodeFps: 0 },
  { session: 63, done: true, progress: 1, pxPerTile: 15.5, confidence: 1, decodeFps: 31 },
  { session: 21, done: false, progress: 0.42, pxPerTile: 8, confidence: 0.6, decodeFps: 13 },
  { session: 7, done: true, progress: 0.99, pxPerTile: 11.5, confidence: 0.8667, decodeFps: 8 },
]) {
  const round = unpackStatus(packStatus(status))
  check('session survives', round.session === status.session, `${round.session}`)
  check('done survives', round.done === status.done)
  check('progress survives', Math.abs(round.progress - status.progress) <= 0.01, `${round.progress}`)
  check('px/tile survives', Math.abs(round.pxPerTile - status.pxPerTile) <= 0.25, `${round.pxPerTile}`)
  check('confidence survives', Math.abs(round.confidence - status.confidence) <= 0.04, `${round.confidence}`)
  check('decode rate survives', round.decodeFps === status.decodeFps, `${round.decodeFps}`)
}

// The session tag occupies the top bits, so a full tag must not make the packed
// value negative and unpack as something else entirely.
{
  const bits = packStatus({ session: 63, done: true, progress: 1, pxPerTile: 15.5, confidence: 1, decodeFps: 31 })
  check('packed status stays unsigned', bits > 0, String(bits))
  check('a full session tag round-trips', unpackStatus(bits).session === 63)
}

// Out-of-range inputs must clamp rather than corrupt neighbouring fields, which
// is how a bad px/tile reading would turn into a false done flag.
{
  const bits = packStatus({ session: 999, done: true, progress: 5, pxPerTile: 900, confidence: 9 })
  const round = unpackStatus(bits)
  check('overlarge values clamp', round.done === true && round.progress <= 1 && round.pxPerTile <= 15.5)
  const negative = unpackStatus(packStatus({ progress: -1, pxPerTile: -5, confidence: -1 }))
  check('negative values clamp', negative.progress === 0 && negative.pxPerTile === 0 && negative.confidence === 0)
}

// ------------------------------------------------------- write, then read it --

/** Place a rendered beacon into a larger dark frame, as a camera would see it. */
function inFrame(image, frameW, frameH, atX, atY) {
  const data = new Uint8ClampedArray(frameW * frameH * 4)
  for (let i = 3; i < data.length; i += 4) data[i] = 255
  for (let y = 0; y < image.height; y++) {
    const ty = atY + y
    if (ty < 0 || ty >= frameH) continue
    for (let x = 0; x < image.width; x++) {
      const tx = atX + x
      if (tx < 0 || tx >= frameW) continue
      const from = (y * image.width + x) * 4
      const to = (ty * frameW + tx) * 4
      data[to] = image.data[from]
      data[to + 1] = image.data[from + 1]
      data[to + 2] = image.data[from + 2]
    }
  }
  return { data, width: frameW, height: frameH }
}

console.log('   scale  size            read back')
for (const scale of [1, 2, 3]) {
  const wanted = { session: 37, done: false, progress: 0.63, pxPerTile: 9.5, confidence: 0.8 }
  const bits = packStatus(wanted)
  const image = renderBeacon(bits, scale)
  // Centred in a frame comfortably larger than the beacon. A scale that did
  // not fit would be REFUSED rather than misread - which is correct, and is
  // exactly what the clipping check below covers - so it must not be the
  // accidental subject of this test.
  const frameW = Math.max(1280, image.width + 80)
  const frameH = Math.max(720, image.height + 80)
  check(`scale ${scale} fits the test frame`, image.width < frameW && image.height < frameH)
  const frame = inFrame(
    image,
    frameW,
    frameH,
    Math.round((frameW - image.width) / 2),
    Math.round((frameH - image.height) / 2),
  )

  const outcome = readBeacon(frame)
  console.log(
    `   ${String(scale).padStart(5)}  ${String(image.width)}x${image.height}`.padEnd(23) +
      (outcome.ok
        ? `session ${outcome.status.session}, ${Math.round(outcome.status.progress * 100)}%, ` +
          `${outcome.status.pxPerTile} px/tile`
        : `FAILED - ${outcome.reason}`),
  )
  check(`beacon reads at scale ${scale}`, outcome.ok, outcome.reason ?? '')
  if (outcome.ok) {
    check(`beacon exact at scale ${scale}`, outcome.bits === bits, `${outcome.bits} vs ${bits}`)
  }
}

// Placed at the very edge of the frame, which is where a phone propped against
// something actually puts it.
{
  const bits = packStatus({ session: 5, done: true, progress: 1 })
  const image = renderBeacon(bits, 2)
  for (const [x, y] of [
    [3, 3],
    [1280 - image.width - 3, 3],
    [3, 720 - image.height - 3],
  ]) {
    const outcome = readBeacon(inFrame(image, 1280, 720, x, y))
    check(`beacon reads at (${x}, ${y})`, outcome.ok && outcome.bits === bits, outcome.reason ?? '')
  }
}

// ---------------------------------------------------------------- refusals --

{
  const black = { data: new Uint8ClampedArray(640 * 480 * 4), width: 640, height: 480 }
  for (let i = 3; i < black.data.length; i += 4) black.data[i] = 255
  check('an empty frame is refused', !readBeacon(black).ok)

  const white = { data: new Uint8ClampedArray(640 * 480 * 4).fill(255), width: 640, height: 480 }
  check('a blown-out frame is refused', !readBeacon(white).ok)

  // A beacon too small to resolve must be refused rather than guessed at.
  const shrunk = { data: new Uint8ClampedArray(40 * 20 * 4), width: 40, height: 20 }
  for (let i = 3; i < shrunk.data.length; i += 4) shrunk.data[i] = 255
  check('a beacon too small is refused', !readBeacon(shrunk).ok)

  /**
   * A partly visible beacon must be refused, not read.
   *
   * This is the failure the two-copy check cannot catch: a clipped border gives
   * a uniformly mis-scaled grid, so both copies shift together and agree with
   * each other while being wrong. Found by accident, and worth a permanent
   * test - it produced a plausible status with the wrong progress and the wrong
   * px/tile, and the same shift could have flipped the done bit.
   */
  const clipBits = packStatus({ session: 37, done: false, progress: 0.63, pxPerTile: 9.5 })
  const clipImage = renderBeacon(clipBits, 3)
  for (const [x, y, label] of [
    [-160, 200, 'off the left'],
    [1280 - clipImage.width + 160, 200, 'off the right'],
    [200, -80, 'off the top'],
  ]) {
    const outcome = readBeacon(inFrame(clipImage, 1280, 720, x, y))
    check(
      `a beacon ${label} is refused, not misread`,
      !outcome.ok || outcome.bits === clipBits,
      outcome.ok ? `accepted wrong bits (${outcome.bits} vs ${clipBits})` : '',
    )
  }

  /**
   * Corrupting one copy must be caught.
   *
   * This is the entire error control on this channel: the payload is written
   * twice and both copies must agree. Without it a single misread cell could
   * flip the done bit and truncate a transfer.
   */
  const bits = packStatus({ session: 9, done: false, progress: 0.5 })
  const image = renderBeacon(bits, 3)
  // Repaint one data cell of the first copy in a different palette colour.
  const cellPx = 26 * 3
  const border = 14 * 3
  for (let y = border + 4; y < border + cellPx - 4; y++) {
    for (let x = border + 4; x < border + cellPx - 4; x++) {
      const p = (y * image.width + x) * 4
      image.data[p] = 255
      image.data[p + 1] = 0
      image.data[p + 2] = 255
    }
  }
  const outcome = readBeacon(inFrame(image, 1280, 720, 300, 200))
  check(
    'a single corrupted cell is refused, not guessed',
    !outcome.ok || outcome.bits === bits,
    outcome.ok ? `accepted wrong bits ${outcome.bits}` : '',
  )
}

// -------------------------------------------------- rung selection is sane --

/**
 * The ladder must not oscillate.
 *
 * Climbing needs headroom plus a confident classifier; dropping needs only that
 * the current rung is struggling. If a rung can be climbed to and then
 * immediately dropped from, the link spends the transfer changing format
 * instead of moving bytes, which is worse than sitting on the lower rung.
 */
{
  check('a struggling link drops a rung', chooseProfile({ pxPerTile: 8, confidence: 0.3 }, 'normal') === 'soft')

  /**
   * A receiver that cannot keep up must not be pushed further.
   *
   * Decode cost scales with the cell count, so climbing spends frames per
   * second to buy bytes per frame at roughly the same rate - measured, `dense`
   * at 12.9 fps beat `max` at 7.7 fps on total throughput. So once the
   * receiver's CPU is the constraint rather than the sender's frame rate, there
   * is nothing up the ladder worth having.
   */
  check(
    'a decoder-limited receiver is not pushed higher',
    chooseProfile({ pxPerTile: 30, confidence: 0.95, decodeFps: 6 }, 'normal', 15) === null,
  )
  check(
    'a receiver keeping up may still climb',
    chooseProfile({ pxPerTile: 30, confidence: 0.95, decodeFps: 15 }, 'normal', 15) === 'dense',
  )
  check(
    'an unreported decode rate does not block climbing',
    chooseProfile({ pxPerTile: 30, confidence: 0.95, decodeFps: 0 }, 'normal', 15) === 'dense',
  )
  check(
    'a decoder-limited receiver still gets dropped when struggling',
    chooseProfile({ pxPerTile: 8, confidence: 0.3, decodeFps: 4 }, 'normal', 15) === 'soft',
  )
  check('the bottom rung cannot drop further', chooseProfile({ pxPerTile: 8, confidence: 0.2 }, 'far') === null)
  check('a comfortable link stays put without headroom', chooseProfile({ pxPerTile: 8, confidence: 0.95, decodeFps: 30 }, 'normal', 15) === null)
  check('a roomy link climbs', chooseProfile({ pxPerTile: 16, confidence: 0.95, decodeFps: 30 }, 'normal', 15) === 'dense')
  check('the top rung cannot climb further', chooseProfile({ pxPerTile: 30, confidence: 0.99, decodeFps: 30 }, 'max', 15) === null)
  check('an unknown rung is left alone', chooseProfile({ pxPerTile: 16, confidence: 0.95, decodeFps: 30 }, 'nonsense', 15) === null)
  check('no reading means no change', chooseProfile({ pxPerTile: 0, confidence: 0.9 }, 'normal') === null)
  // Measured on an upright phone before a 1080p webcam: 0.79 confidence, and
  // not one frame decoded. Staying put there is a transfer that never ends.
  check(
    'a rung below its own px/tile drops at middling confidence',
    chooseProfile({ pxPerTile: 6.9, confidence: 0.79 }, 'soft') === 'far',
  )

  // No rung may be climbed to and then immediately dropped from at the same
  // measurement. Checked across the whole ladder rather than argued about.
  for (const id of LADDER) {
    const profile = PROFILES.find((p) => p.id === id)
    const climbed = chooseProfile({ pxPerTile: profile.pxPerTileAt720 * 2.2, confidence: 0.95, decodeFps: 30 }, id, 15)
    if (!climbed) continue
    const next = PROFILES.find((p) => p.id === climbed)
    // What the receiver would then measure on the rung it just climbed to.
    const measured = profile.pxPerTileAt720 * 2.2 * (next.pxPerTileAt720 / profile.pxPerTileAt720)
    const back = chooseProfile({ pxPerTile: measured, confidence: 0.95, decodeFps: 30 }, climbed, 15)
    check(`${id} -> ${climbed} does not bounce straight back`, back !== id, `bounced to ${back}`)
  }
}

// ------------------------------------------------------- guidance messaging --

{
  check('no geometry asks the user to aim', assess(null, 'geometry').level === Level.PROBLEM)

  /**
   * A device-side failure must never be reported as an aiming problem.
   *
   * These three stages arrive with no telemetry, exactly like a camera pointed
   * at a wall, and used to render the same "point the camera at the other
   * screen" - which sent four field tests chasing distance and angle while the
   * real fault was that no frame ever reached the decoder.
   */
  const aimText = assess(null, 'geometry').message
  for (const [stage, reason] of [
    ['camera', 'not delivering'],
    ['capture', 'createImageBitmap failed'],
    ['worker', 'boom'],
  ]) {
    const got = assess(null, stage, reason)
    check(`${stage} does not masquerade as an aiming problem`, got.message !== aimText, got.message)
    check(`${stage} carries its reason through`, got.message.includes(reason), got.message)
  }
  const tooFar = assess({ geometry: true, pxPerTile: 4, tilt: 0, meanConfidence: 0.9 }, 'correction')
  check('too far says move closer', tooFar.level === Level.PROBLEM && /closer/i.test(tooFar.message), tooFar.message)
  const onEnd = assess({ geometry: true, pxPerTile: 4, tilt: 0, meanConfidence: 0.9, across: true, portrait: false }, 'correction')
  check('a code across a wide camera says turn sideways', /sideways/i.test(onEnd.message) && !/closer/i.test(onEnd.message), onEnd.message)
  const skewed = assess({ geometry: true, pxPerTile: 10, tilt: 0.3, meanConfidence: 0.9 }, 'correction')
  check('tilt says straighten up', /square/i.test(skewed.message), skewed.message)
  const soft = assess({ geometry: true, pxPerTile: 10, tilt: 0, meanConfidence: 0.2 }, 'correction')
  check('low confidence blames focus, not distance', /soft|steady/i.test(soft.message), soft.message)
  const good = assess({ geometry: true, pxPerTile: 9, tilt: 0.01, meanConfidence: 0.95 }, 'decoded')
  check('a working link says so', good.level === Level.GOOD && good.ready, good.message)
  const roomy = assess({ geometry: true, pxPerTile: 20, tilt: 0.01, meanConfidence: 0.95 }, 'decoded')
  check('a very close link never suggests backing off', roomy.level === Level.GOOD && !/back/i.test(roomy.message), roomy.message)

  // A cycling sender: a sparse frame reads, then a dense one is too fine.
  const guide = createGuide(1500)
  guide({ geometry: true, pxPerTile: 14, tilt: 0, meanConfidence: 0.9 }, 'decoded', null, 1000)
  const fine = guide({ geometry: true, pxPerTile: 4.5, tilt: 0, meanConfidence: 0.9 }, 'correction', null, 1500)
  check('a dense frame between readable ones is advice, not "move closer"', fine.level === Level.ADVICE && !/move closer/i.test(fine.message), fine.message)
  const later = guide({ geometry: true, pxPerTile: 4.5, tilt: 0, meanConfidence: 0.9 }, 'correction', null, 4000)
  check('and once nothing has read for a while, it is a problem again', later.level === Level.PROBLEM && /closer/i.test(later.message), later.message)
}

console.log(failures ? `backchannel: ${failures} check(s) failed` : 'backchannel: status code and rung selection hold')
process.exitCode = failures ? 1 : 0
