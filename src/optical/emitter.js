/**
 * The sending half of the optical link: paint airblock frames at a steady rate.
 *
 * ## No WebGL, in the end
 *
 * This was designed around WebGL2 with an instanced quad per cell and a
 * pre-tinted sprite atlas, on the assumption that a per-cell draw loop could
 * not hold 15 fps at ten thousand cells. Then the reference renderer was
 * measured: 1.7 ms per frame on the sparsest rung and 7.3 ms on the densest,
 * which is 2.5% to 11% of a 15 fps budget. Writing bytes into a typed array is
 * simply not expensive.
 *
 * So there is no shader code, no texture upload, no atlas and no fallback path
 * for contexts without WebGL - one renderer that works everywhere. Worth
 * recording as a deleted plan rather than a road not taken, because the
 * instinct to reach for the GPU was wrong by an order of magnitude.
 *
 * ## Render size is not panel size
 *
 * A frame is rendered at its profile's resolution, which is sized for the
 * receiver's camera, and then scaled up with nearest-neighbour to fill the
 * panel. Rendering at the panel's native resolution instead would put fewer
 * capture pixels on each tile, not more - see the note in grid.js.
 */

import { layoutFor, DEFAULT_PROFILE } from './airblock/grid.js'
import { encodeFrame, capacityFor } from './airblock/frame.js'
import { renderFrame } from './airblock/render.js'
import { OPTICAL } from '../config.js'

/**
 * Hold each frame for a whole number of display refreshes.
 *
 * Painting whenever 66.7 ms have passed lands a 15 fps sender on four
 * refreshes of a 60 Hz panel or five, depending on which side of the interval
 * a callback's timestamp falls, so the rate the camera sees wobbles and runs
 * slow. So the refresh interval is measured - the median of recent
 * animation-frame intervals, which ignores a dropped callback and follows a
 * 120 Hz panel - and each frame is held for the whole number of refreshes
 * nearest the requested rate, counted from timestamps rather than callbacks.
 *
 * @returns {(now: number, frameRate: number) => boolean} true when a new frame
 *   is due at animation-frame time `now`
 */
export function createPacer() {
  const intervals = []
  let lastTick = 0
  let lastPaint = -Infinity
  return (now, frameRate) => {
    if (lastTick) {
      intervals.push(now - lastTick)
      if (intervals.length > 16) intervals.shift()
    }
    lastTick = now
    const refresh = intervals.length ? [...intervals].sort((a, b) => a - b)[intervals.length >> 1] : 1000 / 60
    const hold = Math.max(1, Math.round(1000 / frameRate / refresh))
    if (Math.round((now - lastPaint) / refresh) < hold) return false
    lastPaint = now
    return true
  }
}

/**
 * Start the display loop.
 *
 * @param {HTMLCanvasElement} canvas visible canvas to draw into
 * @param {{next: (bytes: number) => Uint8Array, blocks: number, codec: string}} source
 *   frame source; `next` is given the payload capacity and returns that many
 *   bytes or fewer
 * @param {(stats: object) => void} [onFrame]
 * @param {object} [options]
 * @returns {{stop: () => void, setProfile: (id: string) => void}}
 */
export function startEmitter(canvas, source, onFrame, options = {}) {
  let profile = options.profile ?? OPTICAL.profile ?? DEFAULT_PROFILE
  const parity = options.parity ?? OPTICAL.parity
  let turned = options.turned ?? false
  let layout = layoutFor(profile)
  let capacity = capacityFor(layout, parity)

  // One buffer per profile, reused across frames. Reallocating a four-megabyte
  // typed array fifteen times a second is the one part of this that would
  // actually cost something.
  //
  // A blind sender now sweeps the whole ladder, so these fill up rather than
  // holding the one or two rungs a transfer used to touch: about 19 MB of
  // buffer and as much again in canvas backing, held for the transfer. Kept
  // rather than evicted because the sweep returns to every rung every five
  // seconds, so an eviction policy would just reallocate them all on a cycle.
  const buffers = new Map()
  const offscreens = new Map()

  const surfaceFor = (id) => {
    let surface = offscreens.get(id)
    if (surface) return surface
    const target = layoutFor(id).profile
    const element = document.createElement('canvas')
    element.width = target.width
    element.height = target.height
    surface = { element, ctx: element.getContext('2d', { alpha: false }) }
    offscreens.set(id, surface)
    return surface
  }

  const bufferFor = (id) => {
    let buffer = buffers.get(id)
    if (buffer) return buffer
    const target = layoutFor(id).profile
    buffer = new Uint8ClampedArray(target.width * target.height * 4)
    buffers.set(id, buffer)
    return buffer
  }

  const visible = canvas.getContext('2d', { alpha: false })
  // Nearest-neighbour. Smoothing the upscale would blur exactly the tile edges
  // the camera on the other side is trying to resolve.
  visible.imageSmoothingEnabled = false

  let stopped = false
  let rafId = 0
  let framesShown = 0
  let renderMs = 0
  const due = createPacer()

  const paint = () => {
    const payload = source.next(capacity.payloadBytes)
    const { cells } = encodeFrame(payload, { profile, parity })

    const started = performance.now()
    const image = renderFrame(cells, { profile, into: bufferFor(profile) })
    const surface = surfaceFor(profile)
    surface.ctx.putImageData(new ImageData(image.data, image.width, image.height), 0, 0)
    renderMs = performance.now() - started

    /**
     * The canvas backing store IS the render size, and the panel-filling
     * upscale is left to CSS with `image-rendering: pixelated`. Doing it here
     * instead would mean picking an integer scale and letterboxing the
     * remainder, for no gain: the browser's nearest-neighbour upscale is the
     * same operation, done on the compositor.
     *
     * `turned` paints the same frame a quarter turn clockwise, which is a
     * throughput decision rather than a cosmetic one. Every rung is near 16:9,
     * so a phone held in portrait against a landscape panel can only ever fill
     * the short axis of its own capture: the code's long edge lands on the
     * frame's short edge and px/tile falls by the frame's aspect ratio. Turning
     * the code lines the two long axes up. Measured against a 1080x1920
     * capture at 0.9 fill on the default rung, 6.6 px/tile becomes 11.7 - a
     * 1.78x gain, which is about two rungs of the ladder, for no extra light
     * and no change of distance.
     *
     * The decoder needs nothing for this. Orientation is recovered from the
     * corner anchor's own asymmetry, so a turned frame is indistinguishable
     * from a phone held sideways - which is the case it already had to handle.
     */
    const wide = turned ? image.height : image.width
    const high = turned ? image.width : image.height
    // Both change together - a turn swaps the dimensions - so one test covers
    // the class as well, and neither touches the DOM on a frame that is the
    // same shape as the last.
    if (canvas.width !== wide || canvas.height !== high) {
      canvas.width = wide
      canvas.height = high
      visible.imageSmoothingEnabled = false
      canvas.classList.toggle('turned', turned)
    }

    if (turned) {
      visible.save()
      visible.translate(wide, 0)
      visible.rotate(Math.PI / 2)
      visible.drawImage(surface.element, 0, 0)
      visible.restore()
    } else {
      visible.drawImage(surface.element, 0, 0)
    }

    framesShown++
    onFrame?.({
      framesShown,
      profile,
      parity,
      payloadBytes: capacity.payloadBytes,
      turned,
      codewords: layout.codewordCount,
      renderMs,
      bytesPerSecond: capacity.payloadBytes * OPTICAL.frameRate,
      blocks: source.blocks,
      codec: source.codec,
    })
  }

  const tick = (now) => {
    if (stopped) return
    rafId = requestAnimationFrame(tick)
    if (due(now, OPTICAL.frameRate)) paint()
  }

  rafId = requestAnimationFrame(tick)

  return {
    stop() {
      stopped = true
      cancelAnimationFrame(rafId)
    },
    /**
     * Move a rung on the ladder mid-transfer.
     *
     * The receiver finds out from the frame's own header, which is the reason
     * the format carries one - it has to be able to follow a change it did not
     * ask for and was not told about in advance.
     */
    setProfile(id) {
      if (id === profile) return
      profile = id
      layout = layoutFor(profile)
      capacity = capacityFor(layout, parity)
    },
    /** Quarter-turn the emitted frame, for a receiver holding a phone upright. */
    setTurned(value) {
      turned = Boolean(value)
    },
    get turned() {
      return turned
    },
    get profile() {
      return profile
    },
    get capacity() {
      return capacity
    },
  }
}
