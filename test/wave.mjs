/**
 * Wave: a file over sound, end to end through the app's own modem.
 *
 * The browser half - an AudioContext, a speaker, a microphone - cannot run
 * here. Everything between them can: fountain frames become waveforms, the
 * waveforms cross a lossy, noisy, resampled "room", and the reassembler has to
 * produce the exact file. Plus the state machine paths that ask Air or Wave.
 */

import { loadModem, createModem } from '../src/audio/wave.js'
import { WAVE } from '../src/config.js'
import { seeded } from '../src/lib/random.js'
import { wrapFile } from '../src/lib/envelope.js'
import { sha256Hex } from '../src/lib/bytes.js'
import { createFrameEncoder } from '../src/optical/fountain.js'
import { createReassembler } from '../src/optical/reassembler.js'
import { transition, initialMachine, resourcesFor, screenFor } from '../src/state/machine.js'
import { State, Role, Event } from '../src/state/events.js'

let failures = 0
const check = (label, ok, detail = '') => {
  if (ok) return
  failures++
  console.log(`   FAIL ${label}${detail ? ` - ${detail}` : ''}`)
}

/** Linear resampling: two devices never share a clock or a rate. */
function resample(x, from, to) {
  const y = new Float32Array(Math.floor((x.length * to) / from))
  for (let i = 0; i < y.length; i++) {
    const t = (i * from) / to
    const k = t | 0
    y[i] = (x[k] ?? 0) * (1 - (t - k)) + (x[k + 1] ?? 0) * (t - k)
  }
  return y
}

const random = seeded(7)
const noise = () => random() - 0.5

/** Feed a signal in blocks the size an audio stack would pick. */
function listen(push, signal, block = 4096) {
  const heard = []
  for (let i = 0; i < signal.length; i += block) heard.push(...push(signal.subarray(i, i + block)))
  return heard
}

// ------------------------------------------------------------- one message --

/**
 * Across a rate mismatch in both directions, because a Mac at 44.1 kHz and an
 * iPhone at 48 kHz is the case, and in whatever block size the audio stack
 * hands over.
 */
for (const [txRate, rxRate, block] of [[44100, 48000, 4096], [48000, 44100, 4096], [48000, 48000, 128], [44100, 44100, 1000]]) {
  const bytes = Uint8Array.from({ length: WAVE.messageBytes }, (_, i) => (i * 29 + 5) & 255)
  const wave = (await loadModem(txRate)).encode(bytes)
  const signal = new Float32Array(wave.length + rxRate)
  signal.set(resample(wave, txRate, rxRate), 3000)
  const heard = listen((await loadModem(rxRate)).decoder(), signal, block)
  check(
    `${txRate} Hz sender heard by a ${rxRate} Hz receiver in ${block}-sample blocks`,
    heard.length === 1 && heard[0].every((b, i) => b === bytes[i]),
    `${heard.length} message(s)`,
  )
}

/**
 * A room that bends the signal: a table reflection nearly as loud as the
 * sound itself, later echoes, and a sender whose clock runs 300 ppm fast. The
 * chirp has to find the start through the echoes and the guard has to absorb
 * the drift. Then a room past saving, with a late echo two thirds as loud as
 * the sound: it must hear nothing rather than hear something wrong.
 */
for (const [label, echoes, hear] of [
  ['heard through echoes and clock drift', [[0, 0.3], [0.5, 0.2], [3, 0.12], [12, 0.08]], true],
  ['a room past saving yields nothing, not a wrong message', [[0, 0.3], [0.5, 0.15], [3, 0.3], [12, 0.2]], false],
]) {
  const bytes = Uint8Array.from({ length: WAVE.messageBytes }, (_, i) => (i * 7 + 1) & 255)
  const dry = resample((await loadModem(44100)).encode(bytes), 44100, 48000 * 1.0003)
  const wet = new Float32Array(dry.length + 48000)
  for (const [ms, gain] of echoes) {
    const at = 2000 + Math.round(ms * 48)
    for (let i = 0; i < dry.length; i++) wet[at + i] += gain * dry[i]
  }
  for (let i = 0; i < wet.length; i++) wet[i] += noise() * 0.02
  const heard = listen((await loadModem(48000)).decoder(), wet)
  const right = heard.filter((h) => h.every((b, i) => b === bytes[i])).length
  check(label, right === heard.length && heard.length === (hear ? 1 : 0), `${heard.length} heard, ${right} right`)
}

{
  const silence = new Float32Array(48000 * 20)
  for (let i = 0; i < silence.length; i++) silence[i] = noise() * 0.1
  check('twenty seconds of noise decode to nothing', listen((await loadModem(48000)).decoder(), silence).length === 0)
  const { seconds } = createModem(48000)
  check('the time estimate knows how long a message is', Math.abs(seconds - WAVE.messageSeconds) < 0.01, `${seconds} s against ${WAVE.messageSeconds}`)
}

// ------------------------------------------------- a whole file, over a room --

{
  // Incompressible, so deflate cannot shrink it to a block or two and the
  // fountain has real work to do.
  const text = Uint8Array.from({ length: 800 }, () => (noise() * 256 + 128) & 255)
  const digest = await sha256Hex(text)
  const envelope = wrapFile({ name: 'note.txt', type: 'text/plain', bytes: text, digest })
  const encoder = await createFrameEncoder(envelope, WAVE.messageBytes, 'lt')

  const tx = await loadModem(44100)
  const push = (await loadModem(48000)).decoder()
  const reassembler = createReassembler(null, null, WAVE.messageBytes)

  // A third of the messages never arrive - a cough, a door - and the rest
  // arrive resampled, under noise. The fountain must not care which.
  let sent = 0
  let done = false
  while (!done && sent < 200) {
    const frame = encoder.next(WAVE.messageBytes)
    sent++
    if (sent % 3 === 0) continue
    const wave = resample(tx.encode(frame), 44100, 48000)
    const signal = new Float32Array(wave.length + Math.round(WAVE.gapSeconds * 48000))
    for (let i = 0; i < wave.length; i++) signal[i] = wave[i] * 0.6 + noise() * 0.04
    for (const message of listen(push, signal)) done = reassembler.push(message) || done
  }
  const outcome = done ? await reassembler.finalize() : { ok: false, reason: 'never completed' }
  check('a file survives a lossy, noisy, resampled room', outcome.ok, outcome.reason)
  if (outcome.ok) {
    check('and arrives byte for byte', outcome.file.bytes.every((b, i) => b === text[i]) && outcome.file.name === 'note.txt')
  }
  console.log(`   ${text.length} B in ${encoder.blocks} blocks, done after ${sent} messages sent (a third dropped)`)
}

// ------------------------------------------------------ asking Air or Wave --

{
  const outgoing = { name: 'a', size: 1, blocks: 1, waveMessages: 2 }
  let m = transition(initialMachine(), { type: Event.FILE_READY, outgoing })
  check('a picked file asks how to send it', m.state === State.CHOOSING && m.role === Role.SENDER, m.state)

  m = transition(m, { type: Event.CHOOSE_MODE, mode: 'wave' })
  check('choosing Wave starts sending by sound', m.state === State.TRANSFERRING_SEND && m.context.mode === 'wave')
  check('Wave plays sound and paints nothing', resourcesFor(m).wave && !resourcesFor(m).emitter)
  check('Wave has its own screen', screenFor(m) === 'transferring-send-wave', screenFor(m))

  m = transition(m, { type: Event.CHOOSE_MODE, mode: 'air' })
  check('a sender can switch channel mid-send', m.state === State.TRANSFERRING_SEND && resourcesFor(m).emitter && !resourcesFor(m).wave)

  m = transition(m, { type: Event.TIMEOUT })
  m = transition(m, { type: Event.CHOOSE_MODE, mode: 'wave' })
  check('a failed Air send can retry as Wave', m.state === State.TRANSFERRING_SEND && m.context.mode === 'wave' && !m.context.fault)

  // The receiver is asked too, and opens only the device its answer needs.
  const asked = transition(initialMachine(), { type: Event.CHOOSE_RECEIVER })
  check('a receiver is asked how it is coming', asked.state === State.CHOOSING && asked.role === Role.RECEIVER && screenFor(asked) === 'choosing-receive', screenFor(asked))
  const air = transition(asked, { type: Event.CHOOSE_MODE, mode: 'air' })
  check('Air opens the camera and not the microphone', air.state === State.AIMING && resourcesFor(air).scanner && !resourcesFor(air).listener)
  const wave = transition(asked, { type: Event.CHOOSE_MODE, mode: 'wave' })
  check('Wave opens the microphone and not the camera', wave.state === State.AIMING && resourcesFor(wave).listener && !resourcesFor(wave).scanner && screenFor(wave) === 'listening', screenFor(wave))
  const switched = transition(air, { type: Event.CHOOSE_MODE, mode: 'wave' })
  check('a receiver can switch before anything arrives', switched.state === State.AIMING && resourcesFor(switched).listener && !resourcesFor(switched).scanner)
  const hearing = transition(wave, { type: Event.FRAMES_SEEN })
  check('a Wave receive has its own screen', screenFor(hearing) === 'transferring-receive-wave' && resourcesFor(hearing).listener && !resourcesFor(hearing).scanner, screenFor(hearing))
  const toAir = transition(hearing, { type: Event.CHOOSE_MODE, mode: 'air' })
  check('and can switch to Air mid-receive', toAir.state === State.TRANSFERRING_RECEIVE && resourcesFor(toAir).scanner && !resourcesFor(toAir).listener)
  const failedReceiver = transition(air, { type: Event.FAULT, reason: 'x' })
  const retried = transition(failedReceiver, { type: Event.CHOOSE_MODE, mode: 'wave' })
  check('a failed receive retries on the other channel, still receiving', retried.state === State.AIMING && retried.role === Role.RECEIVER && resourcesFor(retried).listener && !retried.context.fault)
  const resumed = transition(failedReceiver, { type: Event.CHOOSE_MODE, mode: 'air' })
  check('or keeps going on the same one', resumed.state === State.AIMING && resourcesFor(resumed).scanner && !resumed.context.fault)
  let stalledSend = transition(initialMachine(), { type: Event.FILE_READY, outgoing })
  stalledSend = transition(transition(stalledSend, { type: Event.CHOOSE_MODE, mode: 'air' }), { type: Event.TIMEOUT })
  const keptSending = transition(stalledSend, { type: Event.CHOOSE_MODE, mode: 'air' })
  check('a sender that timed out can keep sending', keptSending.state === State.TRANSFERRING_SEND && keptSending.context.mode === 'air' && !keptSending.context.fault)
}

console.log(failures ? `wave: ${failures} check(s) failed` : 'wave: files cross by sound, and both channels are offered')
process.exitCode = failures ? 1 : 0
