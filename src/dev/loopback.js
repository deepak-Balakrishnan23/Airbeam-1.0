/**
 * The optical stage in isolation, at /?loopback.
 *
 * Runs the whole thing inside one tab with no camera: a generated test file
 * goes through the real fountain encoder, the real emitter, the real decode
 * worker - anchor detection, sampling, classification, Reed-Solomon and all -
 * and the real reassembler, and comes out the other side to be checked against
 * its SHA-256.
 *
 * The only thing standing in for reality is where the frames come from: the
 * decode loop reads the emitter's own canvas instead of a camera. Everything
 * downstream of those pixels is the production path.
 *
 * What this proves: the bytes survive the round trip, the two halves agree on
 * the format, and the worker plumbing works in a real browser. What it cannot
 * prove: anything optical. There is no lens, no glare, no motion blur and no
 * autofocus, so a 100% decode rate here says nothing about how the link
 * behaves between two actual devices. For that, use `npm test` - which runs
 * the same chain through a synthetic camera with defocus, vignetting, noise and
 * keystone - or /?replay with a real photograph.
 */

import { createFrameEncoder, unframe, BLOCK_BYTES } from '../optical/fountain.js'
import { startEmitter } from '../optical/emitter.js'
import { startDecodeLoop, canvasSource, videoSource } from '../optical/scanner.js'
import { createReassembler } from '../optical/reassembler.js'
import { createTelemetry } from '../optical/telemetry.js'
import { wrapFile } from '../lib/envelope.js'
import { sha256Hex, formatBytes, formatDuration } from '../lib/bytes.js'
import { OPTICAL } from '../config.js'
import { LADDER, layoutFor } from '../optical/airblock/grid.js'
import { capacityFor } from '../optical/airblock/frame.js'
import { h, stat } from '../ui/dom.js'

/** A file with both compressible and incompressible parts, like a real one. */
function makeTestFile(bytes) {
  const out = new Uint8Array(bytes)
  const preamble = new TextEncoder().encode('AirBeam loopback test payload. '.repeat(40))
  out.set(preamble.subarray(0, Math.min(preamble.length, bytes)), 0)
  for (let i = preamble.length; i < bytes; i += 65536) {
    crypto.getRandomValues(out.subarray(i, Math.min(i + 65536, bytes)))
  }
  return out
}

export async function runLoopback(root) {
  const params = new URLSearchParams(location.search)
  const sizeBytes = Number(params.get('bytes') || 200_000)
  const profile = params.get('profile') || OPTICAL.profile
  if (LADDER.includes(profile)) OPTICAL.profile = profile
  // Measurement knobs: `fps` for a faster sender,
  // `workers` to size the pool (default: the app's), `video` for the camera
  // path by piping the canvas through a <video>, and `capture=raf` to poll on
  // animation frames there instead of taking video frame callbacks.
  if (Number(params.get('fps')) > 0) OPTICAL.frameRate = Number(params.get('fps'))
  const workers = Number(params.get('workers')) || undefined
  const capture = params.get('capture') === 'raf' ? 'raf' : undefined
  const throughVideo = params.has('video')

  const layout = layoutFor(OPTICAL.profile)
  const capacity = capacityFor(layout, OPTICAL.parity)

  const canvas = Object.assign(document.createElement('canvas'), { className: 'beam' })
  canvas.width = layout.profile.width
  canvas.height = layout.profile.height

  const original = makeTestFile(sizeBytes)
  const digest = await sha256Hex(original)
  const envelope = wrapFile({
    name: 'loopback.bin',
    type: 'application/octet-stream',
    bytes: original,
    digest,
  })

  // The block size and the fountain the app uses.
  const encoder = await createFrameEncoder(envelope, BLOCK_BYTES)
  const blocksPerFrame = unframe(encoder.next(capacity.payloadBytes), BLOCK_BYTES).length
  const reassembler = createReassembler(null, null)
  const telemetry = createTelemetry({ role: 'loopback', profile: OPTICAL.profile })

  const status = h('dl', {})
  const verdict = h('p', { class: 'lede' }, 'Running…')

  root.replaceChildren(
    h(
      'div',
      { class: 'screen' },
      h('header', {}, h('h1', {}, 'AirBeam'), h('span', { class: 'pulse warn' }, 'Loopback')),
      h('h2', {}, 'Optical stage, one tab, no camera'),
      h(
        'p',
        { class: 'note' },
        `${formatBytes(sizeBytes)} through the ${OPTICAL.profile} rung: ` +
          `${layout.cols}x${layout.rows} cells, ${formatBytes(capacity.payloadBytes)} per frame, ` +
          `${layout.codewordCount} codewords, ` +
          `${blocksPerFrame} block(s) of ${formatBytes(BLOCK_BYTES)} each. ` +
          'Add ?bytes=… or ?profile=… to change it.',
      ),
      h('div', { class: 'beam-wrap' }, canvas),
      verdict,
      h('dl', {}, status),
      h('p', { class: 'note' }, 'No lens, no glare, no motion. Numbers here are a ceiling.'),
    ),
  )

  const startedAt = performance.now()
  let finished = false

  // `?loopback&turned` runs the quarter-turned emitter path, which is the only
  // part of it that needs a real canvas: the rotation happens in a 2d context,
  // so Node cannot exercise it and the decode side cannot tell the difference.
  const turned = new URLSearchParams(location.search).has('turned')
  const emitter = startEmitter(canvas, encoder, null, { turned })

  const paint = () => {
    const progress = reassembler.progress()
    const snapshot = telemetry.snapshot()
    status.replaceChildren(
      stat('Blocks', `${progress.have} of ${progress.need || '?'}`),
      stat('Frames read', `${snapshot.framesDecoded} of ${snapshot.framesCaptured}`),
      stat('Geometry found', `${(snapshot.geometryYield * 100).toFixed(0)}%`),
      stat('Rate (full span)', `${formatBytes(snapshot.fullSpanBytesPerSecond)}/s`),
      stat('Elapsed', formatDuration(performance.now() - startedAt)),
    )
  }

  let source = canvasSource(canvas)
  if (throughVideo) {
    const video = Object.assign(document.createElement('video'), {
      muted: true,
      playsInline: true,
      srcObject: canvas.captureStream(),
    })
    // In the page, because a video that is never composited may never fire
    // its frame callbacks.
    video.style.width = '160px'
    root.firstChild.append(video)
    await video.play()
    source = videoSource(video)
  }

  /**
   * What the capture path and the worker pool are judged on, readable from a script as window.__loopback:
   * decoded frames a second over the last five seconds, main-thread capture
   * time, worker read and decode time, and repeats of one camera frame.
   */
  const stats = { workers, capture: throughVideo && !capture ? 'frame' : 'raf', throughVideo, results: [], dropped: 0, duplicates: 0 }
  window.__loopback = stats
  const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[xs.length >> 1] : null)
  stats.summary = () => {
    const now = performance.now()
    const recent = stats.results.filter((r) => now - r.at < 5000)
    const decoded = recent.filter((r) => r.ok || r.payload)
    const span = recent.length > 1 ? (recent[recent.length - 1].at - recent[0].at) / 1000 : 0
    return {
      workers: stats.workers,
      capture: stats.capture,
      throughVideo,
      resultsPerSecond: span ? (recent.length - 1) / span : 0,
      decodedPerSecond: span ? Math.max(0, decoded.length - 1) / span : 0,
      captureMs: median(recent.map((r) => r.captureMs).filter((v) => v != null)),
      readMs: median(recent.map((r) => r.readMs).filter((v) => v != null)),
      decodeMs: median(recent.map((r) => r.decodeMs).filter((v) => v != null)),
      dropped: stats.dropped,
      duplicates: stats.duplicates,
      results: stats.results.length,
    }
  }

  const stopLoop = startDecodeLoop(source, async (result) => {
    stats.results.push({ at: performance.now(), ok: result.ok, payload: Boolean(result.payload), captureMs: result.captureMs, readMs: result.readMs, decodeMs: result.decodeMs })
    stats.workers = result.workers ?? stats.workers
    stats.dropped = result.dropped ?? stats.dropped
    stats.duplicates = result.duplicates ?? stats.duplicates
    if (finished) return
    telemetry.countCaptured()
    telemetry.record({
      ok: result.ok,
      stage: result.stage,
      decodeMs: result.decodeMs,
      ...(result.telemetry ?? {}),
    })

    if (result.payload && reassembler.push(result.payload)) {
      finished = true
      stopLoop()
      emitter.stop()

      const outcome = await reassembler.finalize()
      const elapsed = performance.now() - startedAt
      const matches =
        outcome.ok &&
        outcome.file.bytes.length === original.length &&
        outcome.file.bytes.every((b, i) => b === original[i])

      verdict.className = matches ? 'lede good' : 'lede bad'
      verdict.textContent = matches
        ? `Round trip exact: ${formatBytes(sizeBytes)} in ${formatDuration(elapsed)} ` +
          `(${formatBytes((sizeBytes * 1000) / elapsed)}/s).`
        : `FAILED: ${outcome.reason ?? 'bytes did not match'}`
    }

    paint()
  }, { workers, capture })

  paint()
  const ticker = setInterval(paint, 500)
  setTimeout(() => clearInterval(ticker), 10 * 60 * 1000)
}
