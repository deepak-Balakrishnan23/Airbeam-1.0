/**
 * Open the camera and take manual control of it where the platform allows.
 *
 * A camera's frame rate is limited by its auto-exposure and auto-focus
 * behaviour, so optimising decoder algorithms while autoexposure is hunting is
 * optimising the wrong stage.
 *
 * The offline harness sharpens what to expect from it, though. Ablating each
 * degradation separately, the only one that costs measurable symbol errors is
 * DEFOCUS - vignetting, noise, keystone, white-balance drift and framing each
 * cost zero. So of the locks below, focus is the one that buys throughput.
 * Exposure and white balance are still worth taking because a fixed short
 * exposure cuts motion blur (which is not the same thing as defocus) and
 * because a camera that has stopped hunting delivers frames at a steady rate -
 * but neither should be expected to move the error rate on its own.
 *
 * What is actually granted is recorded and reported. Safari grants almost none
 * of this, and a lock that was silently not obtained would poison every later
 * measurement - a telemetry file that says "focus locked" when it was not is
 * worse than one that says nothing.
 */

import { OPTICAL } from '../config.js'

/** How long to wait for play() before carrying on without it. */
const PLAY_TIMEOUT_MS = 2000

/**
 * Constraints worth asking for, in the order they are applied.
 *
 * Applied as one batch first, then individually for whatever the batch
 * rejected. Browsers reject an entire applyConstraints call if any single
 * member is unsupported, so asking for everything at once and stopping there
 * would mean one unsupported key costing all the rest.
 */
function desiredControls(capabilities) {
  const wanted = {}

  if (capabilities.focusMode?.includes('manual')) {
    wanted.focusMode = 'manual'
    if (capabilities.focusDistance) {
      // Near the close end of the range: the working distance for this is a
      // phone held towards a screen across a desk, not a landscape.
      const { min, max } = capabilities.focusDistance
      wanted.focusDistance = min + (max - min) * OPTICAL.camera.focusHint
    }
  } else if (capabilities.focusMode?.includes('single-shot')) {
    // Second best: focus once and stop, rather than hunting continuously.
    wanted.focusMode = 'single-shot'
  }

  if (capabilities.exposureMode?.includes('manual')) {
    wanted.exposureMode = 'manual'
    if (capabilities.exposureTime) {
      // Short, to cut motion blur from an unsteady hand. The target is a
      // bright, static-per-frame panel, so there is light to spare.
      const { min, max } = capabilities.exposureTime
      wanted.exposureTime = Math.max(min, Math.min(max, max * OPTICAL.camera.exposureHint))
    }
    if (capabilities.iso) {
      const { min, max } = capabilities.iso
      wanted.iso = Math.min(max, min * 2)
    }
  }

  if (capabilities.whiteBalanceMode?.includes('manual')) {
    wanted.whiteBalanceMode = 'manual'
  }

  return wanted
}

/**
 * Apply what we can and report what stuck.
 *
 * Every key is verified against `getSettings()` afterwards rather than trusted
 * because the call resolved - some platforms accept a constraint and quietly
 * ignore it.
 */
async function applyControls(track, size) {
  const capabilities = typeof track.getCapabilities === 'function' ? track.getCapabilities() : {}
  const wanted = desiredControls(capabilities)
  const granted = {}
  const refused = {}

  // applyConstraints replaces the whole set, so every call carries the size
  // too: a call with the focus alone lets the browser pick any resolution.
  if (Object.keys(wanted).length) {
    try {
      await track.applyConstraints({ ...size, advanced: [wanted] })
    } catch {
      // Fall through to the per-key pass below.
    }
    for (const [key, value] of Object.entries(wanted)) {
      try {
        await track.applyConstraints({ ...size, advanced: [{ [key]: value }] })
      } catch (error) {
        refused[key] = String(error?.name || error)
      }
    }
  }

  const settings = typeof track.getSettings === 'function' ? track.getSettings() : {}
  for (const key of Object.keys(wanted)) {
    if (settings[key] !== undefined) granted[key] = settings[key]
    else if (!refused[key]) refused[key] = 'accepted but not reported'
  }

  return {
    capabilities: Object.keys(capabilities),
    wanted,
    granted,
    refused,
    settings,
    /** Whether focus is actually pinned - the one that matters for throughput. */
    focusLocked: settings.focusMode === 'manual' || settings.focusMode === 'single-shot',
    frameRate: settings.frameRate ?? null,
    resolution: settings.width && settings.height ? [settings.width, settings.height] : null,
  }
}

/** A phone or tablet held upright. Desk cameras are landscape whatever the window. */
function isUpright() {
  const media = globalThis.matchMedia
  if (!media) return false
  return media('(pointer: coarse)').matches && media('(orientation: portrait)').matches
}

/**
 * If the camera came up smaller than it can go, ask again the way up it is.
 *
 * Belt and braces for the square ideal above: a browser that still delivered
 * less than `long` on the long side, from a camera that reports more, is asked
 * for exactly its own orientation at `long`. Kept only if it is bigger.
 */
async function raiseResolution(track, size, long) {
  const before = track.getSettings?.() ?? {}
  const got = Math.max(before.width ?? 0, before.height ?? 0)
  const caps = track.getCapabilities?.() ?? {}
  const most = Math.max(caps.width?.max ?? 0, caps.height?.max ?? 0)
  if (!got || got >= long || most < long) return size

  const short = Math.round((long * 9) / 16)
  const upright = (before.height ?? 0) > (before.width ?? 0)
  const wanted = {
    ...size,
    width: { ideal: upright ? short : long },
    height: { ideal: upright ? long : short },
  }
  try {
    await track.applyConstraints(wanted)
    const after = track.getSettings?.() ?? {}
    if (Math.max(after.width ?? 0, after.height ?? 0) > got) return wanted
    await track.applyConstraints(size)
  } catch {
    /* keeps what it had */
  }
  return size
}

/**
 * Open a camera stream.
 *
 * @param {HTMLVideoElement} video
 * @param {object} [options]
 * @param {'user'|'environment'} [options.facing] `user` - the front camera - is
 *   the default, because it is what lets the receiver's screen face the
 *   sender's and makes the optical back channel possible at all.
 * @returns {Promise<{ok: true, stop: () => void, controls: object, track: MediaStreamTrack}
 *          | {ok: false, reason: string}>}
 */
export async function openCamera(video, options = {}) {
  const facing = options.facing ?? 'user'
  let stream

  // Preflight. On an insecure origin the browser does not merely refuse the
  // camera - it removes navigator.mediaDevices entirely, so the call below
  // throws a TypeError about reading a property of undefined and the user is
  // told nothing about the actual cause. This is the single most common way
  // the app fails: `npm run dev` prints a LAN address, that address is not a
  // secure context, and the receiver dies with a message about `getUserMedia`.
  if (!navigator.mediaDevices?.getUserMedia) {
    if (!window.isSecureContext) {
      return {
        ok: false,
        reason:
          `This page is on ${window.location.origin}, which browsers treat as insecure, ` +
          'so they hide the camera from it. Open AirBeam over HTTPS or on localhost. ' +
          '(`npm run dev` prints a LAN address that will never work for the receiver.)',
      }
    }
    return { ok: false, reason: 'This browser does not support camera capture.' }
  }

  /**
   * The size is asked for the way up the device is held.
   *
   * A browser picks the camera mode "closest" to an ideal by summing each
   * side's relative distance from it, and a phone held upright offers its
   * modes upright. Against an ideal of 1920 x 1080, 720 x 1280 scores 0.78
   * and 1080 x 1920 scores 0.88 - so an upright iPhone was handed 720p, and
   * the field test of 2026-09-12 read the densest code at 4 to 5 px a tile
   * where 1080p gives 6 to 7.
   *
   * Not as a square, which was the first fix: Safari crops and scales to
   * whatever it is asked for, so 1920 x 1920 came back square and upscaled,
   * and the next field test read nothing at all, at 11% classifier confidence.
   * `resizeMode: none` asks for the camera's own modes only, where supported.
   */
  const long = options.longSide ?? OPTICAL.camera.longSide
  const short = Math.round((long * 9) / 16)
  const upright = isUpright()
  let size = {
    width: { ideal: upright ? short : long },
    height: { ideal: upright ? long : short },
    frameRate: { ideal: options.frameRate ?? OPTICAL.camera.frameRate },
    resizeMode: { ideal: 'none' },
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facing }, ...size },
      audio: false,
    })
  } catch (error) {
    return { ok: false, reason: describe(error) }
  }

  video.srcObject = stream
  video.setAttribute('playsinline', '') // iOS will not inline-play without it
  video.muted = true

  /**
   * A refused play() is not survivable, whatever the old comment here said.
   *
   * It claimed frames could still be grabbed from a paused element. That is
   * true on desktop and false on iOS, where a paused video never advances and
   * never reaches HAVE_CURRENT_DATA - so the decode loop waits for a frame
   * that cannot arrive, forever, in silence. Recorded and reported rather than
   * swallowed; the scanner's stall watchdog catches the rest.
   */
  /**
   * ...and a play() that never settles is worse than one that rejects.
   *
   * Measured, not assumed: given a track that opens but delivers no frames,
   * `video.play()` neither resolves nor rejects. openCamera then never
   * returns, so the scanner never starts, so the stall watchdog below it never
   * runs - and because reconcile() awaits this, no later state change can
   * start anything either. The whole app sits on "Looking" forever with
   * nothing to show for it.
   *
   * Playing is not a precondition for grabbing frames, so the wait is bounded
   * and the outcome recorded. Whatever the truth turns out to be, the decode
   * loop gets to start and say so.
   */
  let playError = null
  try {
    await Promise.race([
      video.play(),
      new Promise((resolve) => setTimeout(() => resolve((playError = 'timed out')), PLAY_TIMEOUT_MS)),
    ])
  } catch (error) {
    playError = String(error?.name || error)
  }

  const [track] = stream.getVideoTracks()
  if (track) size = await raiseResolution(track, size, long)
  const controls = track ? await applyControls(track, size) : { granted: {}, refused: {} }
  controls.playError = playError
  controls.label = track?.label ?? null

  return {
    ok: true,
    track,
    controls,
    stop() {
      for (const t of stream.getTracks()) t.stop()
      video.srcObject = null
    },
  }
}

function describe(error) {
  if (error?.name === 'NotAllowedError') {
    return 'Camera access was blocked. AirBeam needs it to read the other screen.'
  }
  if (error?.name === 'NotFoundError') return 'No camera found on this device.'
  if (error?.name === 'NotReadableError') return 'The camera is already in use by another app.'
  if (error?.name === 'OverconstrainedError') {
    return 'This camera cannot provide a usable resolution.'
  }
  return `Could not open the camera: ${error?.message || error}`
}
