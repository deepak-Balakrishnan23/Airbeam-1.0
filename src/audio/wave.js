/**
 * Wave: the same fountain frames as the optical link, carried by sound.
 *
 * The modem is this app's own, built from textbook parts and the Reed-Solomon
 * code the optical format already has.
 *
 * ## One message
 *
 *   chirp | guard | period 0 | period 1 | ... | period P-1
 *
 * The chirp is a linear sweep across the data band. The receiver runs a
 * matched filter for it, which finds the message start to a sample even under
 * noise and echo, so the data needs no sync pattern of its own.
 *
 * Each period plays one tone in each of `bands` bands of `tones` tones, all at
 * once. Tones sit exactly 1/window apart, so over a window of exactly that
 * length every tone but the one sent contributes nothing to a bin: the
 * receiver measures the energy of each tone, and the loudest in a band wins.
 * With 8 tones a band carries 3 bits, and two bands carry one GF(64) symbol.
 *
 * A tone lasts its whole period, window plus guard, and the receiver's window
 * starts half a guard in. So an echo shorter than half a guard, or a timing
 * error that small, only ever adds more of the same tone to the window.
 *
 * ## Coding
 *
 * A message is cut into GF(64) symbols and Reed-Solomon coded, four codewords
 * of 63 with 16 parity each. Codewords are interleaved so every period holds
 * one symbol of each, and the band pair a codeword lands on rotates each
 * period: a burst of noise or a notch in the room's response costs every
 * codeword a little instead of one codeword everything. A codeword that fails
 * is retried with its least certain symbols flagged as erasures, which RS
 * corrects at twice the rate of errors it has to find. A message that still
 * decodes wrong is caught by the fountain block's own CRC.
 *
 * Measured in simulated rooms: see WAVE in config.js.
 */

import { WAVE } from '../config.js'
import { encode as rsEncode, decode as rsDecode } from '../optical/airblock/rs64.js'

/**
 * The tone plan. Window 1/60 s and guard 1/300 s are whole numbers of samples
 * at both 44.1 and 48 kHz (735 + 147 and 800 + 160), so neither end
 * accumulates rounding across a message.
 */
const PLAN = {
  /** Lowest tone, Hz. Phone speakers are weak below about 1 kHz. */
  base: 1500,
  /** Tone spacing, Hz. The window is its inverse. */
  spacing: 60,
  tones: 8,
  bands: 8,
  /** Seconds of extra tone around each window, for echo and timing. */
  guard: 1 / 300,
  /** Seconds of sweep at the start of each message. */
  chirp: 0.1,
  /** RS parity symbols per codeword. */
  parity: 16,
}

/** Matched filter score that counts as a chirp: its cosine similarity. */
const LOCK_SCORE = 0.35
/** Seconds to keep looking past a peak for a stronger one, before locking. */
const LOCK_HOLD = 0.01
/** Raised-cosine ramp at each end of the chirp and the data, seconds. */
const RAMP = 0.005

const modems = new Map()

/**
 * A modem for one I/O sample rate. No DOM, so it runs under Node as well.
 *
 * @returns {Promise<{encode: (bytes: Uint8Array) => Float32Array,
 *   decoder: () => (samples: Float32Array) => Uint8Array[], seconds: number}>}
 */
export function loadModem(sampleRate) {
  if (!modems.has(sampleRate)) modems.set(sampleRate, Promise.resolve(createModem(sampleRate)))
  return modems.get(sampleRate)
}

/** Exported for the tests and for trying other plans; the app uses loadModem. */
export function createModem(sampleRate, plan = PLAN, messageBytes = WAVE.messageBytes) {
  const { base, spacing, tones, bands, guard, parity } = plan
  const bitsPerBand = Math.log2(tones)
  const bandsPerSymbol = 6 / bitsPerBand
  const perPeriod = bands / bandsPerSymbol
  if (!Number.isInteger(bandsPerSymbol) || !Number.isInteger(perPeriod)) {
    throw new Error('A plan must make whole GF(64) symbols from whole bands.')
  }

  const dataSymbols = Math.ceil((messageBytes * 8) / 6)
  const codewords = Math.ceil(dataSymbols / (63 - parity))
  const k = Math.ceil(dataSymbols / codewords)
  const n = k + parity
  const periods = Math.ceil((codewords * n) / perPeriod)

  const window = 1 / spacing
  const period = window + guard
  const dataAt = plan.chirp + guard
  const seconds = dataAt + periods * period
  const top = base + (tones * bands - 1) * spacing
  const at = (s) => Math.round(s * sampleRate)
  const length = at(seconds)
  const volume = WAVE.volume

  /**
   * Where symbol i of codeword c travels: an index into period * perPeriod
   * cells. Consecutive symbols go to consecutive codewords, and each period's
   * cells rotate by one band pair.
   */
  const place = new Int32Array(codewords * n)
  for (let t = 0; t < place.length; t++) {
    const p = Math.floor(t / perPeriod)
    place[t] = p * perPeriod + (((t % perPeriod) + p) % perPeriod)
  }
  const cellOf = (c, i) => place[i * codewords + c]

  const chirp = (s) => {
    const t = s / sampleRate
    return Math.sin(2 * Math.PI * (base * t + ((top - base) * t * t) / (2 * plan.chirp)))
  }
  const ramp = (s, count) => {
    const edge = Math.min(s, count - 1 - s)
    const width = at(RAMP)
    return edge >= width ? 1 : 0.5 - 0.5 * Math.cos((Math.PI * edge) / width)
  }

  // ---------------------------------------------------------------- encode --

  function encode(bytes) {
    if (bytes.length !== messageBytes) throw new Error(`Wave sends ${messageBytes}-byte messages, not ${bytes.length}.`)
    const symbols = toSymbols(bytes, codewords * k)
    const cells = new Uint8Array(periods * perPeriod)
    for (let c = 0; c < codewords; c++) {
      const word = rsEncode(symbols.subarray(c * k, (c + 1) * k), n, k)
      for (let i = 0; i < n; i++) cells[cellOf(c, i)] = word[i]
    }

    const out = new Float32Array(length)
    const chirpLength = at(plan.chirp)
    for (let s = 0; s < chirpLength; s++) out[s] = volume * ramp(s, chirpLength) * chirp(s)

    // Phase runs on across periods, so a tone change is a bend, not a click.
    const amplitude = volume / bands
    const phases = new Float64Array(bands)
    for (let p = 0; p < periods; p++) {
      const from = at(dataAt + p * period)
      const to = at(dataAt + (p + 1) * period)
      for (let b = 0; b < bands; b++) {
        const cell = cells[p * perPeriod + Math.floor(b / bandsPerSymbol)]
        const shift = bitsPerBand * (bandsPerSymbol - 1 - (b % bandsPerSymbol))
        const tone = (cell >> shift) & (tones - 1)
        const step = (2 * Math.PI * (base + (b * tones + tone) * spacing)) / sampleRate
        let phase = phases[b]
        for (let s = from; s < to; s++) {
          out[s] += amplitude * Math.sin(phase)
          phase += step
        }
        phases[b] = phase % (2 * Math.PI)
      }
    }
    const dataFrom = at(dataAt)
    for (let s = dataFrom; s < length; s++) out[s] *= ramp(s - dataFrom, length - dataFrom)
    return out
  }

  // ---------------------------------------------------------------- decode --

  // The chirp as the receiver hears it, spectrum conjugated once for the filter.
  const template = new Float32Array(at(plan.chirp))
  for (let s = 0; s < template.length; s++) template[s] = ramp(s, template.length) * chirp(s)
  let templateEnergy = 0
  for (const v of template) templateEnergy += v * v
  const size = 2 ** Math.ceil(Math.log2(template.length * 2))
  const step = size - template.length + 1
  const fft = fftOf(size)
  const tRe = new Float64Array(size)
  const tIm = new Float64Array(size)
  tRe.set(template)
  fft(tRe, tIm)

  // One cosine and sine table per tone, for a window's worth of samples.
  const windowLength = at(window)
  const cosines = []
  const sines = []
  for (let f = 0; f < tones * bands; f++) {
    const w = (2 * Math.PI * (base + f * spacing)) / sampleRate
    cosines.push(Float32Array.from({ length: windowLength }, (_, s) => Math.cos(w * s)))
    sines.push(Float32Array.from({ length: windowLength }, (_, s) => Math.sin(w * s)))
  }

  /** Cell values and how sure each is, for a message starting at `start` in `x`. */
  function demodulate(x, start) {
    const values = new Uint8Array(periods * perPeriod)
    const sure = new Float32Array(periods * perPeriod).fill(1)
    const energy = new Float64Array(tones)
    for (let p = 0; p < periods; p++) {
      const from = start + at(dataAt + p * period + guard / 2)
      for (let b = 0; b < bands; b++) {
        let first = 0
        for (let t = 0; t < tones; t++) {
          const cos = cosines[b * tones + t]
          const sin = sines[b * tones + t]
          let re = 0
          let im = 0
          for (let s = 0; s < windowLength; s++) {
            re += x[from + s] * cos[s]
            im += x[from + s] * sin[s]
          }
          energy[t] = re * re + im * im
          if (energy[t] > energy[first]) first = t
        }
        let second = first === 0 ? 1 : 0
        for (let t = 0; t < tones; t++) if (t !== first && energy[t] > energy[second]) second = t
        const cell = p * perPeriod + Math.floor(b / bandsPerSymbol)
        const shift = bitsPerBand * (bandsPerSymbol - 1 - (b % bandsPerSymbol))
        values[cell] |= first << shift
        sure[cell] = Math.min(sure[cell], 1 - energy[second] / (energy[first] || 1))
      }
    }
    return { values, sure }
  }

  /** The message's bytes, or null if any codeword cannot be corrected. */
  function correct({ values, sure }) {
    const symbols = new Uint8Array(codewords * k)
    const word = new Uint8Array(n)
    const confidence = new Float32Array(n)
    for (let c = 0; c < codewords; c++) {
      for (let i = 0; i < n; i++) {
        word[i] = values[cellOf(c, i)]
        confidence[i] = sure[cellOf(c, i)]
      }
      let outcome = rsDecode(word, [], n, k)
      if (!outcome.ok) {
        // Never more flags than half the parity. With every parity symbol
        // spent on erasures, any word at all "decodes": the rest of it simply
        // defines a codeword. Half leaves eight symbols to check the answer.
        const doubtful = [...word.keys()].sort((a, b) => confidence[a] - confidence[b])
        for (const flags of [parity / 4, parity / 2]) {
          outcome = rsDecode(word, doubtful.slice(0, flags), n, k)
          if (outcome.ok) break
        }
      }
      if (!outcome.ok) return null
      symbols.set(outcome.codeword.subarray(0, k), c * k)
    }
    return fromSymbols(symbols, messageBytes)
  }

  /** A receiver: push samples in any block size, get back whole messages. */
  function decoder() {
    let buffer = new Float32Array(size * 4)
    let origin = 0 // stream index of buffer[0]
    let end = 0 // stream index one past the last sample held
    let scan = 0 // next lag the matched filter looks at
    let best = null
    let lock = -1
    const re = new Float64Array(size)
    const im = new Float64Array(size)
    const energy = new Float64Array(size + 1)

    const append = (samples) => {
      if (end + samples.length - origin > buffer.length) {
        // Everything before the earliest position still needed can go.
        const keep = Math.min(scan, lock >= 0 ? lock : Infinity, best ? best.lag : Infinity)
        const live = end - keep
        if (live + samples.length > buffer.length) {
          const next = new Float32Array((live + samples.length) * 2)
          next.set(buffer.subarray(keep - origin, end - origin))
          buffer = next
        } else buffer.copyWithin(0, keep - origin, end - origin)
        origin = keep
      }
      buffer.set(samples, end - origin)
      end += samples.length
    }

    /** Filter one block of lags from `scan`; returns true if it locked. */
    const filter = () => {
      const x = buffer.subarray(scan - origin, scan - origin + size)
      re.set(x)
      im.fill(0)
      fft(re, im)
      for (let i = 0; i < size; i++) {
        const r = re[i] * tRe[i] + im[i] * tIm[i]
        const m = im[i] * tRe[i] - re[i] * tIm[i]
        re[i] = r
        im[i] = -m // conjugate, so a forward transform inverts it
      }
      fft(re, im)
      for (let i = 0; i < size; i++) energy[i + 1] = energy[i] + x[i] * x[i]
      const hold = at(LOCK_HOLD)
      for (let m = 0; m < step; m++) {
        const lag = scan + m
        if (best && lag > best.lag + hold) {
          lock = best.lag
          best = null
          return true
        }
        const e = energy[m + template.length] - energy[m]
        const score = re[m] / size / Math.sqrt(templateEnergy * e + 1e-12)
        if (score >= LOCK_SCORE && score > (best?.score ?? 0)) best = { score, lag }
      }
      scan += step
      return false
    }

    return (samples) => {
      append(samples)
      const found = []
      for (;;) {
        if (lock >= 0) {
          if (end < lock + length) break
          const bytes = correct(demodulate(buffer, lock - origin))
          if (bytes) found.push(bytes)
          scan = bytes ? lock + length : lock + at(LOCK_HOLD) + 1
          lock = -1
        } else if (end - scan >= size) {
          filter()
        } else break
      }
      return found
    }
  }

  return { encode, decoder, seconds }
}

// ----------------------------------------------------------------- helpers --

/** Bytes to 6-bit symbols, most significant bit first, zero-padded to `count`. */
function toSymbols(bytes, count) {
  const out = new Uint8Array(count)
  for (let bit = 0; bit < count * 6; bit++) {
    const value = bit >> 3 < bytes.length ? (bytes[bit >> 3] >> (7 - (bit & 7))) & 1 : 0
    out[Math.floor(bit / 6)] |= value << (5 - (bit % 6))
  }
  return out
}

function fromSymbols(symbols, length) {
  const out = new Uint8Array(length)
  for (let bit = 0; bit < length * 8; bit++) {
    const value = (symbols[Math.floor(bit / 6)] >> (5 - (bit % 6))) & 1
    out[bit >> 3] |= value << (7 - (bit & 7))
  }
  return out
}

/** An in-place radix-2 FFT of one fixed size, over separate real and imaginary arrays. */
function fftOf(size) {
  const bits = Math.log2(size)
  const reverse = new Uint32Array(size)
  for (let i = 1; i < size; i++) reverse[i] = (reverse[i >> 1] >> 1) | ((i & 1) << (bits - 1))
  const cos = Float64Array.from({ length: size / 2 }, (_, i) => Math.cos((2 * Math.PI * i) / size))
  const sin = Float64Array.from({ length: size / 2 }, (_, i) => -Math.sin((2 * Math.PI * i) / size))
  return (re, im) => {
    for (let i = 0; i < size; i++) {
      const j = reverse[i]
      if (j > i) {
        ;[re[i], re[j]] = [re[j], re[i]]
        ;[im[i], im[j]] = [im[j], im[i]]
      }
    }
    for (let half = 1; half < size; half <<= 1) {
      const stride = size / (half * 2)
      for (let i = 0; i < size; i += half * 2) {
        for (let j = 0; j < half; j++) {
          const wr = cos[j * stride]
          const wi = sin[j * stride]
          const a = i + j
          const b = a + half
          const tr = re[b] * wr - im[b] * wi
          const ti = re[b] * wi + im[b] * wr
          re[b] = re[a] - tr
          im[b] = im[a] - ti
          re[a] += tr
          im[a] += ti
        }
      }
    }
  }
}

// ------------------------------------------------------------------ browser --

let context = null

/**
 * Create and resume the AudioContext. Call it synchronously inside a tap.
 *
 * Browsers start a context suspended until a user gesture, and by the time the
 * runtime gets round to starting this resource it may be several awaits - a
 * camera permission prompt, even - away from the tap that asked for it.
 *
 * `playback` also stops the iPhone's ringer switch muting the sender: Safari
 * treats Web Audio as ambient sound unless told otherwise.
 */
export function unlockAudio({ playback = false } = {}) {
  if (playback && navigator.audioSession) navigator.audioSession.type = 'playback'
  const Ctor = window.AudioContext || window.webkitAudioContext
  if (!Ctor) return null
  context ??= new Ctor()
  context.resume?.().catch(() => {})
  return context
}

/**
 * Play frames from `source` back to back until stopped.
 *
 * @param {{next: (bytes: number) => Uint8Array}} source a frame encoder
 * @param {(progress: {messagesSent: number}) => void} [onMessage]
 */
export async function startWaveEmitter(source, onMessage) {
  const ctx = unlockAudio({ playback: true })
  if (!ctx) throw new Error('This browser cannot play generated sound.')
  const modem = await loadModem(ctx.sampleRate)

  let stopped = false
  let playing = null
  let messagesSent = 0

  const play = (when) => {
    if (stopped) return
    const samples = modem.encode(source.next(WAVE.messageBytes))
    const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate)
    buffer.getChannelData(0).set(samples)
    const node = ctx.createBufferSource()
    node.buffer = buffer
    node.connect(ctx.destination)
    node.onended = () => {
      node.disconnect()
      onMessage?.({ messagesSent: ++messagesSent })
      play(ctx.currentTime + WAVE.gapSeconds)
    }
    node.start(when)
    playing = node
  }
  play(ctx.currentTime + 0.05)

  return {
    stop() {
      stopped = true
      try {
        playing?.stop()
      } catch {
        /* never started */
      }
    },
  }
}

/**
 * Listen on the microphone and hand every decoded message to `onMessage`.
 *
 * ScriptProcessorNode is deprecated and still implemented everywhere; moving
 * the modem into an AudioWorklet is a lot of machinery for a decoder that
 * costs a few milliseconds a message.
 */
export async function startWaveListener(onMessage, options = {}) {
  const ctx = unlockAudio()
  if (!ctx || !navigator.mediaDevices?.getUserMedia) {
    options.onError?.('This browser cannot listen for sound, so it cannot receive by sound.')
    return { stop() {} }
  }
  // A page that sent earlier asked for playback; capture needs the default back.
  if (navigator.audioSession) navigator.audioSession.type = 'auto'

  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      // All three are hostile to data over sound; echo cancellation in
      // particular will erase the signal outright.
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    })
  } catch (error) {
    options.onError?.(
      error?.name === 'NotAllowedError'
        ? 'Microphone access was blocked, so this device cannot hear the other one. Allow the microphone for this site, or receive by light.'
        : `Could not open the microphone (${error?.message || error}), so this device cannot hear the other one.`,
    )
    return { stop() {} }
  }

  await ctx.resume?.().catch(() => {})
  const push = (await loadModem(ctx.sampleRate)).decoder()

  const source = ctx.createMediaStreamSource(stream)
  const processor = ctx.createScriptProcessor(4096, 1, 1)
  // A processor must reach the destination to run at all, and the microphone
  // must not come back out of the speaker - so through a muted gain.
  const mute = ctx.createGain()
  mute.gain.value = 0
  processor.onaudioprocess = (event) => {
    for (const message of push(event.inputBuffer.getChannelData(0))) onMessage(message)
  }
  source.connect(processor)
  processor.connect(mute)
  mute.connect(ctx.destination)

  return {
    stop() {
      processor.onaudioprocess = null
      source.disconnect()
      processor.disconnect()
      mute.disconnect()
      for (const track of stream.getTracks()) track.stop()
    },
  }
}
