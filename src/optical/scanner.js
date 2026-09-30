/**
 * The receiving half of the optical link: pull frames off a camera and hand
 * them to the decode worker.
 *
 * Where frames come from is kept separate from what happens to them, which is
 * what lets the whole receive path be exercised in one browser tab against the
 * emitter's own canvas, with no camera involved (see src/dev/loopback.js).
 *
 * ## One frame in flight per worker
 *
 * A worker is sent a frame only once it has answered the previous one.
 * Frames the camera produces in between are dropped and counted rather than
 * queued. Under a fountain code that is exactly the right thing to do: the
 * receiver needs a certain NUMBER of distinct frames and does not care which,
 * so a dropped frame costs nothing, whereas a queue that grows during a slow
 * patch would spend the rest of the transfer decoding stale pictures of the
 * screen.
 */

import { openCamera } from './camera.js'
import { OPTICAL } from '../config.js'

/**
 * Decode workers by default: most of the cores, leaving one for the page, and
 * no more than four. Measured through the loopback harness on `max` at 60 fps
 * on an 8-core M2: one worker decoded 11.6 frames a second, four decoded 41.8
 * (the browser may under-report cores, hence the floor of one).
 */
const DEFAULT_WORKERS = Math.max(1, Math.min(4, (globalThis.navigator?.hardwareConcurrency ?? 2) - 1))

/** Frame source backed by a live <video> element. */
export function videoSource(video) {
  return {
    get width() {
      return video.videoWidth
    },
    get height() {
      return video.videoHeight
    },
    get ready() {
      return video.readyState >= video.HAVE_CURRENT_DATA
    },
    drawable: video,
    video,
  }
}

/** Frame source backed by a canvas, for loopback testing without a camera. */
export function canvasSource(canvas) {
  return {
    get width() {
      return canvas.width
    },
    get height() {
      return canvas.height
    },
    get ready() {
      return canvas.width > 0 && canvas.height > 0
    },
    drawable: canvas,
  }
}

/**
 * Feed frames from `source` through the worker.
 *
 * @param {object} source from videoSource or canvasSource
 * @param {(result: object) => void} onResult called for every decode attempt,
 *   successful or not - a run where geometry never locks has to be
 *   distinguishable from one where the camera was never pointed at anything
 * @param {object} [options]
 * @param {number} [options.workers] decode workers, one frame in flight each
 * @param {'raf'} [options.capture] poll on animation frames even where video
 *   frame callbacks exist
 * @returns {() => void} stop function
 */
export function startDecodeLoop(source, onResult, options = {}) {
  let stopped = false
  let rafId = 0
  let nextId = 1
  let dropped = 0
  let duplicates = 0

  /**
   * Workers, one frame in flight each.
   *
   * Frames are independent under a fountain code, so N workers decode N at
   * once and the order results come back in does not matter. The bound is the
   * same as with one: a frame is sent only to an idle worker, and the newest
   * is dropped when none is.
   */
  const pool = Array.from({ length: Math.max(1, options.workers ?? DEFAULT_WORKERS) }, () => ({
    worker: new Worker(new URL('./decoder/worker.js', import.meta.url), { type: 'module' }),
    busy: false,
  }))
  for (const slot of pool) {
    slot.worker.onmessage = (event) => {
      slot.busy = false
      if (stopped) return
      onResult({ ...event.data, dropped, duplicates, workers: pool.length })
    }
    slot.worker.onerror = (event) => {
      slot.busy = false
      if (stopped) return
      onResult({ ok: false, stage: 'worker', reason: event.message || 'decode worker failed' })
    }
  }

  /**
   * Which camera frame is on screen, where the browser can say.
   *
   * requestAnimationFrame is not tied to the camera, so polling on it submits
   * the same camera frame again whenever a decode finishes inside one camera
   * interval - more often with more workers. `requestVideoFrameCallback` fires
   * once per new frame, so where it exists it is what drives
   * submission. Measured with four workers through a <video>: polling
   * submitted 42 repeats in 606 results, frame callbacks none, at the same
   * decode rate. Either way it counts presented frames, which is how a repeat
   * is recognised and counted.
   */
  const video = source.video
  const byFrame = options.capture !== 'raf' && typeof video?.requestVideoFrameCallback === 'function'
  let presented = 0
  let lastSubmitted = -1
  let lastFrameAt = 0
  let frameCallback = 0
  if (typeof video?.requestVideoFrameCallback === 'function') {
    const onFrame = (now, metadata) => {
      if (stopped) return
      presented = metadata.presentedFrames
      lastFrameAt = performance.now()
      frameCallback = video.requestVideoFrameCallback(onFrame)
      const size = byFrame && check(lastFrameAt)
      if (size) submit(size)
    }
    frameCallback = video.requestVideoFrameCallback(onFrame)
  }

  /**
   * Pixels always travel as an ImageBitmap, which carries the picture the way
   * the element shows it.
   *
   * `new VideoFrame(video)` was tried here and it failed the
   * first field test outright: an iPhone receiving by Air stayed on "Looking"
   * with the whole code sharp in its viewfinder. On iOS a camera frame comes
   * out in the sensor's landscape orientation while reporting the element's
   * portrait size, so the worker drew it stretched, and a stretched anchor
   * fails the aspect gate. The shape check could not see it. What VideoFrame
   * saved was under 0.2 ms of main thread a frame.
   */

  /**
   * A camera that is open but delivering nothing must say so.
   *
   * The loop used to `return` silently whenever the source was not ready, so a
   * video element that never produced a frame - a play() the platform refused,
   * a track that opened and stalled - span forever without ever calling
   * onResult. No result meant no telemetry, and no telemetry meant the aiming
   * screen kept showing its initial "point the camera at the other screen".
   * Every one of those failures was indistinguishable from simply not aiming,
   * which is the worst possible thing for a message whose entire job is to say
   * what to do next.
   */
  const STALL_MS = 1500
  let firstTickAt = 0
  let lastReadyAt = 0
  let stallReported = false

  const reportStall = (now, reason) => {
    if (stallReported) return
    stallReported = true
    onResult({ ok: false, stage: 'camera', reason, dropped })
  }

  /** The source's size once it has a picture, reporting a stall that lasts. */
  const check = (now) => {
    if (!firstTickAt) firstTickAt = now

    if (!source.ready) {
      if (now - (lastReadyAt || firstTickAt) > STALL_MS) {
        reportStall(
          now,
          'The camera is open but not sending any pictures. On iOS this usually ' +
            'means the video was not allowed to start playing. Leave and re-enter ' +
            'the receiving screen, or reload the page.',
        )
      }
      return null
    }

    // Driven by frame callbacks, a track that freezes stops the callbacks, and
    // with them every result: that has to be reported as loudly as not-ready.
    if (byFrame && now - (lastFrameAt || firstTickAt) > STALL_MS) {
      reportStall(now, 'The camera stopped sending pictures.')
      return null
    }

    lastReadyAt = now
    stallReported = false

    const { width, height } = source
    if (!width || !height) {
      if (now - firstTickAt > STALL_MS) {
        reportStall(now, 'The camera reported a picture with no size (0x0).')
      }
      return null
    }
    return { width, height }
  }

  const tick = () => {
    if (stopped) return
    rafId = requestAnimationFrame(tick)
    const size = check(performance.now())
    if (size && !byFrame) submit(size)
  }

  const submit = async ({ width, height }) => {
    const slot = pool.find((s) => !s.busy)
    if (!slot) {
      dropped++
      return
    }
    if (frameCallback && presented === lastSubmitted) duplicates++
    lastSubmitted = presented
    slot.busy = true

    try {
      // Main-thread time spent handing the frame over: the synchronous slices
      // only, not the wait for the bitmap to resolve. createImageBitmap gives
      // the worker the pixels without a main-thread getImageData, which on a
      // 720p frame is a couple of megabytes we would otherwise copy twice.
      let t = performance.now()
      const pending = createImageBitmap(source.drawable)
      let captureMs = performance.now() - t
      const bitmap = await pending
      t = performance.now()
      if (stopped) {
        bitmap.close?.()
        return
      }
      slot.worker.postMessage(
        {
          id: nextId++,
          bitmap,
          options: {
            allow: options.allow,
            parity: options.parity ?? OPTICAL.parity,
            sampling: options.sampling,
            useErasures: options.useErasures,
          },
          captureMs: captureMs + (performance.now() - t),
        },
        [bitmap],
      )
    } catch (error) {
      slot.busy = false
      onResult({ ok: false, stage: 'capture', reason: String(error?.message || error) })
    }
  }

  rafId = requestAnimationFrame(tick)

  return () => {
    if (stopped) return
    stopped = true
    cancelAnimationFrame(rafId)
    if (frameCallback) video.cancelVideoFrameCallback?.(frameCallback)
    for (const slot of pool) slot.worker.terminate()
  }
}

/**
 * Open the camera and start decoding from it.
 *
 * @returns {Promise<{stop: () => void, controls: object}>}
 */
export async function startScanner(video, onResult, options = {}) {
  const camera = await openCamera(video, options)
  if (!camera.ok) {
    options.onError?.(camera.reason)
    return { stop: () => {}, controls: null }
  }

  const stopLoop = startDecodeLoop(videoSource(video), onResult, options)

  return {
    controls: camera.controls,
    stop() {
      stopLoop()
      camera.stop()
    },
  }
}
