/**
 * Per-frame instrumentation, and the file you can take away and argue with.
 *
 * Measurement comes before tuning here, and it paid off: the offline harness built on these same records found
 * four design errors before any hardware existed. This is the live counterpart
 * - the same fields, gathered from a real camera instead of a synthetic one.
 *
 * Two rules it exists to enforce:
 *
 *   - no throughput claim without a measurement from here
 *   - report the FULL SPAN, and if a best window is quoted, quote the span
 *     beside it. The gap between the two is a measure of how much of the
 *     channel is being lost to aiming rather than to physics, and quoting only
 *     the good window makes an interaction problem look like a solved one.
 */

const MAX_RECORDS = 20_000

export function createTelemetry(context = {}) {
  const started = performance.now()
  const records = []

  let framesCaptured = 0
  let framesGeometry = 0
  let framesDecoded = 0
  let bytesDecoded = 0
  let droppedForBackpressure = 0

  /** Rolling window, as [timeMs, bytes, decoded] triples. */
  const window = []
  const WINDOW_MS = 5000
  let bestWindowRate = 0

  /** Per density: frames whose geometry was found, and frames that read. */
  const byDensity = {}

  const spatial = new Float64Array(64)
  const spatialCount = new Int32Array(64)
  const confidence = new Int32Array(10)

  return {
    context,

    countCaptured() {
      framesCaptured++
    },

    countDropped() {
      droppedForBackpressure++
    },

    /**
     * One decode attempt, successful or not.
     *
     * Failed attempts matter more than successful ones for diagnosis - a run
     * where geometry never locks looks identical in a success-only log to one
     * where the camera was never pointed at anything.
     */
    record(entry) {
      const at = performance.now() - started
      if (entry.geometry) framesGeometry++
      if (entry.geometry && entry.profile) {
        const tally = (byDensity[entry.profile] ??= { seen: 0, read: 0 })
        tally.seen++
        if (entry.codewordsDecoded > 0) tally.read++
      }
      if (entry.ok) {
        framesDecoded++
        bytesDecoded += entry.payloadBytes ?? 0
      }

      if (entry.confidenceHistogram) {
        for (let i = 0; i < 10; i++) confidence[i] += entry.confidenceHistogram[i]
      }
      if (entry.spatial) {
        for (let i = 0; i < 64; i++) {
          spatial[i] += entry.spatial[i]
          spatialCount[i]++
        }
      }

      window.push([at, entry.ok ? (entry.payloadBytes ?? 0) : 0, entry.ok ? 1 : 0])
      while (window.length && at - window[0][0] > WINDOW_MS) window.shift()
      if (at > WINDOW_MS) {
        let sum = 0
        for (const [, bytes] of window) sum += bytes
        bestWindowRate = Math.max(bestWindowRate, sum / (WINDOW_MS / 1000))
      }

      if (records.length < MAX_RECORDS) {
        records.push({ at: Math.round(at), ...entry, confidenceHistogram: undefined, spatial: undefined })
      }
    },

    snapshot() {
      const elapsed = Math.max(0.001, (performance.now() - started) / 1000)
      const recentDecodeRate = () => {
        if (window.length < 2) return 0
        const span = (window[window.length - 1][0] - window[0][0]) / 1000
        if (span <= 0.5) return 0
        let decoded = 0
        for (const entry of window) decoded += entry[2]
        return decoded / span
      }
      const map = new Float32Array(64)
      for (let i = 0; i < 64; i++) map[i] = spatialCount[i] ? spatial[i] / spatialCount[i] : 0

      return {
        elapsedSeconds: elapsed,
        framesCaptured,
        framesGeometry,
        framesDecoded,
        bytesDecoded,
        droppedForBackpressure,
        capturesPerSecond: framesCaptured / elapsed,
        decodesPerSecond: framesDecoded / elapsed,
        /**
         * Decode rate over the last few seconds, not over the whole run.
         *
         * This is the one the back channel reports and the rung selector acts
         * on, and the difference matters. The full-span figure includes however
         * long the user spent aiming before anything decoded, so a receiver
         * managing a true 13 fps after ten seconds of hunting reports about
         * 6 - and the selector concludes it is decoder-limited and refuses to
         * climb, permanently, because the average converges only over minutes.
         */
        recentDecodesPerSecond: recentDecodeRate(),
        /** The honest number: total bytes over the whole run. */
        fullSpanBytesPerSecond: bytesDecoded / elapsed,
        /** The flattering one. Never quote it without the line above. */
        bestWindowBytesPerSecond: bestWindowRate,
        /**
         * How much of the channel is being lost to aiming rather than physics.
         */
        aimingSpread: bytesDecoded > 0 ? bestWindowRate / (bytesDecoded / elapsed) : 0,
        frameYield: framesCaptured ? framesDecoded / framesCaptured : 0,
        geometryYield: framesCaptured ? framesGeometry / framesCaptured : 0,
        byDensity: structuredClone(byDensity),
        camera: context.camera?.resolution ?? null,
        workers: context.workers ?? null,
        confidenceHistogram: [...confidence],
        spatialErrorMap: [...map],
      }
    },

    /** JSONL: a header line of context, then one line per decode attempt. */
    toJSONL() {
      const lines = [JSON.stringify({ kind: 'context', ...context, summary: this.snapshot() })]
      for (const record of records) lines.push(JSON.stringify({ kind: 'frame', ...record }))
      return lines.join('\n')
    },

    download(name = `airbeam-telemetry-${Date.now()}.jsonl`) {
      const blob = new Blob([this.toJSONL()], { type: 'application/x-ndjson' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = name
      document.body.appendChild(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 30_000)
    },
  }
}
