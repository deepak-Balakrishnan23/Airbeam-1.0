/**
 * Turning decoder measurements into something a person can act on.
 *
 * The largest gap in a channel like this one is user behaviour: aiming,
 * distance and hand stability cost more throughput than any decode-side change.
 *
 * So this module exists to close that spread, and every message it produces is
 * tied to a number the decoder already had to compute:
 *
 *   px/tile  from the anchor spacing - the honest measure of "close enough",
 *            and what decides how much defocus the current rung can absorb
 *   tilt     from the disagreement between opposite edges of the homography
 *   glare    from how much of the frame is clipped at full brightness
 *   yield    certified codewords, not a fabricated bar
 *
 * One message at a time, worst first. A panel listing four simultaneous
 * complaints is one nobody reads.
 */

import { GUIDANCE, OPTICAL } from '../config.js'
import { PROFILES, LADDER } from './airblock/grid.js'

export const Level = { GOOD: 'good', ADVICE: 'advice', PROBLEM: 'problem' }

/**
 * Assess one decode attempt.
 *
 * @param {object|null} telemetry the worker's per-frame telemetry, if geometry
 *   was found at all
 * @param {string} stage where the attempt got to: geometry, correction, decoded
 * @returns {{level: string, message: string, pxPerTile: number, tilt: number,
 *            confidence: number, ready: boolean}}
 */
export function assess(telemetry, stage, reason) {
  if (!telemetry?.geometry) {
    const blank = { pxPerTile: 0, tilt: 0, confidence: 0, ready: false, level: Level.PROBLEM }

    /**
     * Only `geometry` means "you are not pointing it at the code".
     *
     * Everything else that arrives without telemetry is a fault in this
     * device, and saying "point the camera at the other screen" to someone
     * whose camera is not delivering frames at all sends them to move furniture
     * around for a problem that no amount of aiming can fix. Four failed field
     * tests were spent on exactly that, so these now report themselves.
     */
    if (stage === 'camera') {
      return { ...blank, message: reason || 'The camera is not delivering pictures.' }
    }
    if (stage === 'capture') {
      return {
        ...blank,
        message: `This browser could not read a picture from the camera${reason ? ` (${reason})` : ''}.`,
      }
    }
    if (stage === 'worker') {
      return {
        ...blank,
        message: `The decoder stopped${reason ? `: ${reason}` : ''}. Reload the page.`,
      }
    }

    return {
      ...blank,
      message: 'Point the camera at the other screen, so the whole code is in frame.',
    }
  }

  const pxPerTile = telemetry.pxPerTile ?? 0
  const tilt = telemetry.tilt ?? 0
  const confidence = telemetry.meanConfidence ?? 0

  const base = { pxPerTile, tilt, confidence, ready: stage === 'decoded' }

  // Worst first. Distance leads because it is the one that makes decoding
  // impossible rather than merely unreliable, and because it is the easiest
  // thing for a person to change.
  if (pxPerTile < GUIDANCE.minPxPerTile) {
    return {
      ...base,
      level: Level.PROBLEM,
      // Across, "move closer" is advice nobody can take: the code's long edge
      // already spans the frame's short side, and the fix is a quarter turn.
      message: !telemetry.across
        ? 'Move closer, or fill more of the frame with the code.'
        : telemetry.portrait
          ? 'The code is lying across this camera, so it only fills the narrow side. ' +
            'Hold this phone sideways, or set "Code on screen" to Upright in the sender\'s Transfer settings.'
          : 'The code is standing on end, so it only fills the short side of this camera. ' +
            'Turn the sending phone sideways, or set "Code on screen" to Flat in its Transfer settings.',
    }
  }
  if (tilt > GUIDANCE.maxTilt) {
    return {
      ...base,
      level: Level.PROBLEM,
      message: 'Hold the camera square to the screen rather than at an angle.',
    }
  }
  if (confidence < GUIDANCE.minConfidence) {
    return {
      ...base,
      level: Level.PROBLEM,
      // Deliberately about focus and glare rather than distance: the harness
      // showed defocus is the only degradation that costs real symbol errors,
      // and by this point distance has already been ruled out above.
      message: 'The picture is soft. Steady the camera, and avoid reflections on the screen.',
    }
  }
  if (stage === 'correction') {
    return {
      ...base,
      level: Level.ADVICE,
      message: 'Almost there. Hold steady.',
    }
  }
  // There used to be a "you could move back and it would go faster" here, for
  // plenty of pixels a tile. It is never true: backing off only takes pixels
  // away, and with a sender cycling densities it cost the denser ones (field
  // test of 2026-09-12, where it alternated with "move closer").
  return { ...base, level: Level.GOOD, message: 'Reading.' }
}

/**
 * Guidance that holds still while a sender cycles its densities.
 *
 * A sender that cannot see this device's status code shows every density in
 * turn, and this camera may read the sparse ones and not the dense. Judged a
 * frame at a time, the advice then flips between "move closer" on a dense
 * frame and "reading" on a sparse one, several times a second, and someone
 * following it moves back and forth (the field test of 2026-09-12). While any
 * frame has read in the last `holdMs`, a frame too fine to resolve is advice
 * to fill more of the frame, not a problem.
 */
export function createGuide(holdMs = 1500) {
  let readAt = -Infinity
  return (telemetry, stage, reason, now = performance.now()) => {
    const guidance = assess(telemetry, stage, reason)
    if (guidance.level !== Level.PROBLEM) {
      readAt = now
      return guidance
    }
    if (now - readAt < holdMs && telemetry?.geometry && guidance.pxPerTile < GUIDANCE.minPxPerTile && !telemetry.across) {
      return {
        ...guidance,
        level: Level.ADVICE,
        message: 'Reading. Fill more of the frame with the code and the denser frames will read too.',
      }
    }
    return guidance
  }
}

/**
 * Pick a rung on the grid ladder from what the receiver reports.
 *
 * This is what the back channel is for. The receiver knows how many capture
 * pixels it is getting per tile and how confident its classifier is; the
 * sender knows neither and cannot guess, because it depends on the other
 * device's camera and on how someone is holding it.
 *
 * Deliberately asymmetric. Climbing needs headroom on the rung above plus a
 * confident classifier; dropping needs only that the current rung is
 * struggling. Getting this backwards produces a link that oscillates between
 * two rungs, which is worse than sitting on the lower one.
 *
 * ## Denser is not always faster
 *
 * The obvious assumption - more payload per frame means more throughput - is
 * wrong, and measurably so. Decode cost scales with the cell count, so a
 * denser rung buys bytes per frame and spends frames per second at roughly the
 * same rate. Measured in a browser worker: `dense` decoded at 12.9 fps for 109
 * KB/s, while `max` decoded at 7.7 fps for 98 KB/s. The denser rung was slower.
 *
 * So a receiver that is already decoder-limited gains nothing by climbing, and
 * loses defocus tolerance for the privilege. The rule is simple: only climb
 * while the SENDER's frame rate is the constraint. Once the receiver's CPU is,
 * there is nothing up there.
 *
 * @param {{pxPerTile: number, confidence: number, decodeFps?: number}} status
 * @param {string} current profile id in use
 * @param {number} [senderFps] frames per second the sender is emitting
 * @returns {string|null} the profile to switch to, or null to stay
 */
export function chooseProfile(status, current, senderFps = OPTICAL.frameRate) {
  const index = LADDER.indexOf(current)
  if (index === -1) return null

  const pxPerTile = status.pxPerTile ?? 0
  const confidence = status.confidence ?? 0
  if (!pxPerTile) return null

  // Struggling: drop a rung. Confidence is the main signal, because a rung can
  // be too dense for the defocus even at a good distance. But mean confidence
  // alone reads fine on a rung that never decodes - measured, `soft` at 6.9
  // px/tile averages 0.79 and fails every frame - so a rung below its own
  // reference px/tile drops too unless the classifier is certain. A climb
  // lands at 1.15x the reference, so this cannot undo one.
  const here = PROFILES.find((p) => p.id === current)
  const starved = pxPerTile < here.pxPerTileAt720 && confidence < 0.85
  if ((confidence < 0.55 || starved) && index > 0) return LADDER[index - 1]

  if (confidence > 0.85 && index < LADDER.length - 1) {
    // Already decoder-limited: there is nothing to gain up the ladder, because
    // the extra bytes per frame come straight back out of the frame rate.
    // Reported as 0 by a receiver too old to measure it, which is treated as
    // "unknown" and allowed to climb on the geometry alone.
    const decodeFps = status.decodeFps ?? 0
    if (decodeFps > 0 && decodeFps < senderFps * 0.9) return null

    // Otherwise climb, but only if the next rung's own px/tile requirement is
    // met with room to spare. px/tile scales with cell count, so the next rung
    // up will see it fall by the ratio of the two.
    const next = PROFILES.find((p) => p.id === LADDER[index + 1])
    const projected = pxPerTile * (next.pxPerTileAt720 / here.pxPerTileAt720)
    // A 15% margin over the rung's own reference figure, so a small change in
    // how the phone is held does not immediately undo the decision.
    if (projected > next.pxPerTileAt720 * 1.15) return next.id
  }

  return null
}
