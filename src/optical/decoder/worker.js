/**
 * The decode chain, off the main thread.
 *
 * Sampling a frame costs tens of milliseconds - tens of thousands of bilinear
 * reads plus a classifier pass - and the main thread is busy drawing the UI and
 * pulling frames off the camera. Running the chain here means a slow decode
 * costs throughput and never smoothness.
 *
 * The protocol is deliberately one-in-flight. The main thread sends a frame
 * only when this worker has answered the last one, so there is no queue to grow
 * unboundedly when decoding is slower than capture. Frames the camera produced
 * meanwhile are simply not sent, and are counted - a fountain code does not
 * care which frames arrive, only how many, so dropping the newest is free and
 * dropping the oldest would be worse.
 */

import { findGeometry } from './anchors.js'
import { sampleFrame } from './sample.js'
import { decodeFrame, spatialErrorMap, readHeader } from '../airblock/frame.js'
import { layoutFor } from '../airblock/grid.js'

let surface = null
let context = null

/**
 * The last geometry this worker found, so the next frame can be tracked from
 * it (anchors.js). Cleared on a miss, so a lost code costs one full search.
 */
let previous = null

/** Reused across frames; allocating a canvas per frame is a real cost. */
function surfaceFor(width, height) {
  if (!surface || surface.width !== width || surface.height !== height) {
    surface = new OffscreenCanvas(width, height)
    context = surface.getContext('2d', { alpha: false, willReadFrequently: true })
  }
  return context
}

function decode(image, options) {
  const geometry = findGeometry(image, { allow: options.allow, previous })
  previous = geometry.ok ? geometry : null
  if (!geometry.ok) {
    return { ok: false, stage: 'geometry', reason: geometry.reason, telemetry: geometry.telemetry }
  }

  const layout = layoutFor(geometry.profile)
  const read = sampleFrame(image, {
    profile: geometry.profile,
    transform: geometry.transform,
    sampling: options.sampling,
  })

  /**
   * The header supplies the parity, which nothing else can.
   *
   * Geometry recovers the grid from anchor spacing, but it cannot see how many
   * of each codeword's 63 symbols are parity - and getting that wrong splits
   * every codeword at the wrong place, so all of them fail while the geometry
   * and the per-cell confidences look perfectly healthy. Taking it from the
   * receiver's own local setting instead means a sender that changed parity is
   * simply undecodable, which is exactly the silent mode mismatch the
   * self-describing header exists to remove.
   *
   * A header that will not decode is not fatal - the local setting is a
   * reasonable guess and four corners have to be unreadable for it to come to
   * that - but a header that decodes and names a DIFFERENT profile is. The
   * header cells were sampled through the grid geometry chose, so if it read
   * cleanly and disagrees about which grid that was, one of the two is wrong
   * and there is nothing to gain from guessing which.
   */
  const header = readHeader(read.values, read.confidences, layout)
  const headerOk = header.ok !== false

  if (headerOk && header.profile !== geometry.profile) {
    return {
      ok: false,
      stage: 'header',
      reason: `geometry read a ${geometry.profile} grid but its header says ${header.profile}`,
      telemetry: { geometry: true, profile: geometry.profile, tilt: geometry.tilt },
    }
  }

  const parity = headerOk ? header.parity : options.parity
  const out = decodeFrame(read.values, read.confidences, {
    profile: geometry.profile,
    parity,
    useErasures: options.useErasures !== false,
  })

  const spatial = spatialErrorMap(read.values, read.confidences, layout)

  return {
    ok: out.ok,
    stage: out.ok ? 'decoded' : 'correction',
    reason: out.reason,
    // A partly decoded frame still carries whole blocks; the block CRCs sort
    // them out on the main thread. Nothing decoded means nothing to send.
    payload: out.telemetry.codewordsDecoded ? out.payload : null,
    profile: geometry.profile,
    telemetry: {
      geometry: true,
      profile: geometry.profile,
      parity,
      headerCorners: headerOk ? header.corners.decoded : 0,
      pxPerCell: geometry.pxPerCell,
      pxPerTile: geometry.pxPerCell * (layout.tile / layout.pitch),
      tilt: geometry.tilt,
      tracked: Boolean(geometry.telemetry.tracked),
      across: geometry.across,
      portrait: image.height > image.width,
      meanConfidence: read.telemetry.meanConfidence,
      weakCells: read.telemetry.weakCells,
      confidenceHistogram: read.telemetry.confidenceHistogram,
      globalDriftX: read.telemetry.globalDriftX,
      globalDriftY: read.telemetry.globalDriftY,
      refined: read.telemetry.refined,
      refineHits: read.telemetry.refineHits,
      codewordsAttempted: out.telemetry.codewordsAttempted,
      codewordsDecoded: out.telemetry.codewordsDecoded,
      codewordsRetried: out.telemetry.codewordsRetried,
      symbolErrors: out.telemetry.symbolErrors,
      erasuresUsed: out.telemetry.erasuresUsed,
      yield: out.telemetry.yield,
      spatial: spatial.map,
      payloadBytes: out.ok ? out.payload.length : 0,
    },
  }
}

self.onmessage = async (event) => {
  const { id, bitmap, options = {}, captureMs } = event.data
  const started = performance.now()

  try {
    // Read the dimensions BEFORE closing: a closed ImageBitmap reports zero
    // width and height, so using bitmap.width after close() asks for a
    // zero-sized region and getImageData refuses.
    const width = bitmap.width
    const height = bitmap.height
    const ctx = surfaceFor(width, height)
    ctx.drawImage(bitmap, 0, 0)
    bitmap.close?.()
    const image = ctx.getImageData(0, 0, width, height)
    const readMs = performance.now() - started

    const result = decode({ data: image.data, width: image.width, height: image.height }, options)
    result.decodeMs = performance.now() - started
    result.readMs = readMs
    result.captureMs = captureMs

    // The payload is transferred rather than copied; nothing here needs it
    // afterwards.
    const transfer = result.payload ? [result.payload.buffer] : []
    self.postMessage({ id, ...result }, transfer)
  } catch (error) {
    bitmap.close?.()
    self.postMessage({
      id,
      ok: false,
      stage: 'worker',
      reason: String(error?.message || error),
      decodeMs: performance.now() - started,
      captureMs,
    })
  }
}
