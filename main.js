/**
 * Runtime: the only place where the state machine, the transports and the DOM
 * meet.
 *
 * The machine decides what state we are in. `resourcesFor` says what should be
 * running in that state. This file diffs that declaration against what is
 * actually running and starts or stops the difference. Every camera,
 * microphone and connection is started and stopped from here, so a resource
 * cannot leak just because somebody added a transition and forgot the
 * matching cleanup.
 */

import { createStore, resourcesFor, screenFor } from './src/state/machine.js'
import { State, Role, Event } from './src/state/events.js'
import { buildScreen } from './src/ui/screens.js'
import {
  createFrameEncoder,
  blocksPerFrame,
  BLOCK_BYTES,
  FOUNTAIN_OVERHEAD,
} from './src/optical/fountain.js'
import { startEmitter } from './src/optical/emitter.js'
import { startScanner } from './src/optical/scanner.js'
import { createReassembler, fileUrl } from './src/optical/reassembler.js'
import { createTelemetry } from './src/optical/telemetry.js'
import { startBeacon, startBeaconReader } from './src/optical/backchannel.js'
import { createGuide, chooseProfile } from './src/optical/guidance.js'
import { wrapFile, validateFile } from './src/lib/envelope.js'
import { sha256Hex, shortDigest } from './src/lib/bytes.js'
import { layoutFor, LADDER } from './src/optical/airblock/grid.js'
import { capacityFor, FORMAT_VERSION } from './src/optical/airblock/frame.js'
import { OPTICAL, TRANSFER, WAVE } from './src/config.js'
import { startWaveEmitter, startWaveListener, unlockAudio } from './src/audio/wave.js'
import { startWifiSender, startWifiReceiver, MAX_FILE_BYTES as WIFI_MAX_BYTES } from './src/net/wifi.js'

const root = document.getElementById('app')
const announcer = document.getElementById('announcer')
const store = createStore()

/**
 * Long-lived DOM nodes. These are moved between screens rather than rebuilt,
 * because re-creating the <video> would restart the camera and re-creating the
 * canvas would drop the emitter's render target mid-frame.
 */
const surfaces = {
  canvas: Object.assign(document.createElement('canvas'), { className: 'beam' }),
  video: Object.assign(document.createElement('video'), { playsInline: true, muted: true }),
  beacon: Object.assign(document.createElement('canvas'), { className: 'beacon' }),
  beaconVideo: Object.assign(document.createElement('video'), { playsInline: true, muted: true }),
}

// The viewfinder takes the camera's shape (see .viewfinder in styles.css). Set
// on the root so it survives the move from the aiming screen to receiving.
for (const type of ['loadedmetadata', 'resize']) {
  surfaces.video.addEventListener(type, () => {
    const { videoWidth: w, videoHeight: h } = surfaces.video
    if (w && h) document.documentElement.style.setProperty('--camera-aspect', String(w / h))
  })
}

/** Everything that exists only for the duration of one transfer. */
let session = null

/** Handles to running resources, keyed the same way as resourcesFor(). */
const running = { emitter: null, wave: null, scanner: null, listener: null, wifi: null, backchannel: null, wakeLock: null }
const timers = new Map()

// ------------------------------------------------------------------ timers

function armTimer(name, ms, fn) {
  clearTimer(name)
  timers.set(name, setTimeout(fn, ms))
}

function clearTimer(name) {
  const id = timers.get(name)
  if (id) clearTimeout(id)
  timers.delete(name)
}

function clearAllTimers() {
  for (const id of timers.values()) clearTimeout(id)
  timers.clear()
}

// --------------------------------------------------------------- resources

/**
 * A sender with no status code sweeps the ladder instead of guessing.
 *
 * Rung selection is the whole point of the back channel: the receiver is the
 * only device that knows how many capture pixels per tile it is getting. A
 * sender that never hears one has no basis for ANY rung, and every fixed
 * answer is wrong somewhere:
 *
 *   - The floor (`far`) was the original answer. Measured on a real run, a
 *     receiver reporting 15.5 px per tile - twice what `normal` needs - sat
 *     there for two minutes at 15 KB/s while `max` would have carried 149.
 *   - The configured default is wrong the other way. If the receiver can only
 *     manage `far` or `soft`, a sender pinned at `normal` delivers NOTHING,
 *     for as long as anyone is willing to hold the camera up.
 *
 * So it stops guessing. The frame header is self-describing and the receiver
 * recovers the grid from anchor spacing on every frame, so it follows a rung
 * change it was never told about - which means the sender can simply cycle,
 * and let the receiver's own decode yield do the selecting. Frames on a rung
 * too dense to read fail and cost one frame slot; under a fountain that is all
 * they cost.
 *
 * Measured against a receiver that reads every rung up to a ceiling and drops
 * the rest, 400 kB, one sample a cell (`test/pipeline.mjs` prints this):
 *
 *   receiver reads up to    sweeping    pinned at `normal`
 *   far                        5 KB/s        never
 *   soft                      11 KB/s        never
 *   normal                    22 KB/s       51 KB/s
 *   dense                     43 KB/s       46 KB/s
 *   max                       63 KB/s       47 KB/s
 *
 * Sweeping is not a free win and the table says where it loses: a receiver
 * whose ceiling is exactly the pinned rung pays about 2x for the frames spent
 * elsewhere. What it buys is the first two rows, where a fixed choice above
 * the ceiling delivers nothing whatsoever - and the top row, because a blind
 * sender pinned to a safe rung can never climb to the one the receiver could
 * actually have read.
 *
 * It stops the moment a status arrives. `chooseProfile` is strictly better
 * informed than sweeping and takes over from wherever the sweep left off.
 */
const SWEEP_GRACE_MS = 5000
const SWEEP_DWELL_MS = 1000

/**
 * Advance one rung, then book the next move.
 *
 * Re-armed from inside rather than run on an interval, so that the timer
 * bookkeeping in this file stays one-shot - and so a state transition, which
 * clears every timer, ends the sweep without needing to know it existed.
 */
function sweepRung() {
  const emitter = session?.emitter
  if (!emitter) return
  emitter.setProfile(LADDER[(LADDER.indexOf(emitter.profile) + 1) % LADDER.length])
  armTimer('sweep', SWEEP_DWELL_MS, sweepRung)
}

/**
 * Hold the sweep off for a while. Called on every status the sender reads, so
 * a live back channel keeps pushing it out of reach and a dead one lets it
 * start.
 */
function deferSweep() {
  armTimer('sweep', SWEEP_GRACE_MS, sweepRung)
}

/** The sender could not open a camera at all, so it will never hear anything. */
function blindSender(reason) {
  report(
    'backchannel',
    `${reason} Without it this device cannot tell how well the other one is ` +
      `reading, so it is cycling through every density in turn, and the other ` +
      `device will read whichever ones its camera can manage. Pick one in ` +
      `Transfer settings if you already know which works.`,
  )
}

const starters = {
  async emitter() {
    if (!session?.encoder) return () => {}
    const handle = startEmitter(
      surfaces.canvas,
      session.encoder,
      (progress) => {
        store.send({ type: Event.SEND_PROGRESS, progress })
      },
      { turned: codeTurned },
    )
    session.emitter = handle
    return () => {
      handle.stop()
      session.emitter = null
    }
  },

  async scanner() {
    session.telemetry = createTelemetry({
      role: 'receiver',
      profile: OPTICAL.profile,
      formatVersion: FORMAT_VERSION,
      startedAt: new Date().toISOString(),
    })

    let lastPaint = 0
    const guide = createGuide()

    const scanner = await startScanner(
      surfaces.video,
      (result) => {
        session.telemetry.countCaptured()
        session.telemetry.context.workers ??= result.workers
        session.telemetry.record({
          ok: result.ok,
          stage: result.stage,
          decodeMs: result.decodeMs,
          dropped: result.dropped,
          duplicates: result.duplicates,
          ...(result.telemetry ?? {}),
        })

        // A partly decoded frame carries a payload too: its whole blocks count.
        if (result.payload && accept('air', result.payload)) return

        // Every result feeds the guide, which remembers what read recently.
        const guidance = guide(result.telemetry, result.stage, result.reason)
        session.guidance = guidance

        // Progress repaints are throttled: the worker can answer many times a
        // second and re-rendering the panel on every result is wasted work.
        const now = performance.now()
        if (now - lastPaint < 200) return
        lastPaint = now

        if (store.get().state === State.AIMING) {
          store.send({ type: Event.GUIDANCE, guidance, diagnostics: session.telemetry.snapshot() })
        } else {
          store.send({
            type: Event.RECEIVE_PROGRESS,
            progress: { ...session.reassembler.progress(), codec: session.reassembler.codec },
            diagnostics: session.telemetry.snapshot(),
            guidance,
          })
        }
      },
      {
        facing: cameraFacing,
        onError: (reason) => report('scanner', reason),
      },
    )

    if (scanner.controls) {
      session.telemetry.context.camera = scanner.controls
      // Worth surfacing rather than burying: the transfer works either way, but
      // a run measured with focus hunting is not comparable with one measured
      // without, and the user is the only one who can move to a device that
      // allows it.
      if (scanner.controls.playError) {
        store.send({
          type: Event.DEGRADED,
          capability: 'videoPlayback',
          reason:
            `The camera preview was not allowed to start (${scanner.controls.playError}). ` +
            'On iOS that usually stops frames arriving at all. Reload the page and tap ' +
            'Receive again without switching apps in between.',
        })
      }
      if (!scanner.controls.focusLocked) {
        store.send({
          type: Event.DEGRADED,
          capability: 'focusLock',
          reason: 'This browser will not let AirBeam lock the camera focus, so the picture may drift in and out.',
        })
      }
    }

    return scanner.stop
  },

  /** Sender: the file as sound. Its own encoder, sized for a 140-byte message. */
  async wave() {
    const handle = await startWaveEmitter(session.waveEncoder, (progress) =>
      store.send({ type: Event.SEND_PROGRESS, progress }),
    )
    return handle.stop
  },

  /** Receiver on Wave: the microphone, in place of the camera. */
  async listener() {
    const handle = await startWaveListener(
      (message) => {
        if (accept('wave', message)) return
        // The camera's own repaint would show this too, but only while the
        // camera is delivering frames, and a Wave receive may be why it is not.
        if (store.get().state === State.TRANSFERRING_RECEIVE) {
          store.send({
            type: Event.RECEIVE_PROGRESS,
            progress: { ...session.reassembler.progress(), codec: session.reassembler.codec },
          })
        }
      },
      { onError: (reason) => report('listener', reason) },
    )
    return handle.stop
  },

  /**
   * Wi-Fi, either side: a chirped handshake, then the file over a data
   * channel. The link reports its own ending, so there is no reassembler and
   * nothing to sweep; a failure of any kind is the transfer's.
   */
  async wifi() {
    const onError = (reason) => report('wifi', reason)
    if (store.get().role === Role.SENDER) {
      const progress = (p) => store.send({ type: Event.SEND_PROGRESS, progress: p })
      const handle = await startWifiSender(session.file, {
        onPhase: progress,
        onProgress: progress,
        onDone: () => store.send({ type: Event.DONE_SEEN }),
        onError,
      })
      session.wifi = handle
      return handle.stop
    }
    const handle = await startWifiReceiver({
      // Hearing a sender is what "frames seen" means here.
      onPhase: (p) => {
        store.send({ type: Event.FRAMES_SEEN })
        store.send({ type: Event.RECEIVE_PROGRESS, progress: p })
      },
      onProgress: (p) => {
        armReceiveTimeout()
        store.send({ type: Event.RECEIVE_PROGRESS, progress: p })
      },
      // DTLS has already checked every byte; verifying only hands the file on.
      onFile: (file) => {
        session.reassembler = { finalize: async () => ({ ok: true, file }) }
        store.send({ type: Event.PAYLOAD_ASSEMBLED })
      },
      onError,
    })
    return handle.stop
  },

  /**
   * The back channel. Which half runs depends on the role: the receiver paints
   * a status code, the sender reads one.
   */
  async backchannel() {
    const machine = store.get()

    if (machine.role === Role.RECEIVER) {
      const handle = startBeacon(surfaces.beacon, () => ({
        // Learned from the frames: a receiver has no digest of its own, and
        // reporting 0 made the sender discard every status but one in 64.
        session: session?.reassembler?.transferTag ?? 0,
        done: store.get().state === State.COMPLETE || store.get().state === State.VERIFYING,
        progress: progressFraction(store.get()),
        pxPerTile: session?.guidance?.pxPerTile ?? 0,
        confidence: session?.guidance?.confidence ?? 0,
        // How fast this device can actually decode, which is what stops the
        // sender climbing to a rung we cannot keep up with.
        decodeFps: session?.telemetry?.snapshot().recentDecodesPerSecond ?? 0,
      }))
      return handle.stop
    }

    // Sender: read the receiver's code with the front camera.
    const reader = await startBeaconReader(
      surfaces.beaconVideo,
      (status) => {
        store.send({ type: Event.BACKCHANNEL_STATUS, status })

        if (status.session !== session?.sessionTag) return
        // Stop sweeping only while chooseProfile has a reading to act on. A
        // receiver that has lost the code reports 0 px/tile, chooseProfile
        // answers "stay", and holding the sweep off then pins the sender to a
        // rung the receiver cannot find - for as long as the beacon is in view.
        if (status.pxPerTile > 0) deferSweep()
        if (status.done) {
          store.send({ type: Event.DONE_SEEN })
          return
        }

        // Live rung selection. This is the whole point of the back channel:
        // the receiver knows what its camera can resolve and the sender cannot
        // possibly guess it.
        const wanted = chooseProfile(status, session.emitter?.profile ?? OPTICAL.profile)
        if (wanted && session.emitter && wanted !== session.emitter.profile) {
          session.emitter.setProfile(wanted)
        }
      },
      { onError: (reason) => blindSender(reason) },
    )
    return reader.stop
  },

  async wakeLock() {
    if (!('wakeLock' in navigator)) return () => {}

    let lock = null
    let released = false

    const acquire = async () => {
      if (released) return
      try {
        lock = await navigator.wakeLock.request('screen')
      } catch {
        // Not fatal - the screen may just dim during a long transfer.
      }
    }

    // The platform drops a screen wake lock whenever the page is hidden and
    // does not restore it on return, so a transfer that survives the user
    // glancing at another app would silently lose its lock and let the screen
    // sleep partway through. Re-taking it on visibility change is the only way
    // to keep it for the length of a multi-minute transfer.
    const onVisible = () => {
      if (document.visibilityState === 'visible') acquire()
    }
    document.addEventListener('visibilitychange', onVisible)

    await acquire()

    return () => {
      released = true
      document.removeEventListener('visibilitychange', onVisible)
      lock?.release().catch(() => {})
    }
  },
}

/**
 * A frame payload from either channel. Returns true once the file is whole.
 *
 * Each channel has its own reassembler because their blocks differ in size -
 * a Wave block is 117 bytes and an Air one about two thousand - and a fountain
 * decoder keys on the block count, so one channel's blocks are noise to the
 * other's. Whichever channel is moving is the one the progress bar follows.
 */
function accept(channel, payload) {
  const reassembler = session.channels[channel]
  // Progress, so the stall deadline moves.
  if (store.get().state === State.TRANSFERRING_RECEIVE) armReceiveTimeout()
  const done = reassembler.push(payload)
  if (!reassembler.started) return false
  session.reassembler = reassembler
  // The first frame that parses is what tells a waiting receiver that a
  // transfer has begun; after that this is a no-op.
  store.send({ type: Event.FRAMES_SEEN })
  if (done) store.send({ type: Event.PAYLOAD_ASSEMBLED })
  return done
}

/**
 * Give up on a receive that has gone quiet.
 *
 * A stall, not a duration: the timer is pushed back every time a frame is
 * decoded, so a slow transfer is never cut off, and one whose sender has gone
 * away fails in a bounded time with an explanation. A minute rather than the
 * thirty seconds that suited Air: Wave delivers one message every five, and a
 * sender switching over needs someone to notice and tap.
 */
const RECEIVE_STALL_MS = 60_000

function armReceiveTimeout() {
  armTimer('receive', RECEIVE_STALL_MS, () => store.send({ type: Event.TIMEOUT }))
}

/**
 * Blocks a frame carries on the least capacious rung, which is the packing the
 * send deadline assumes. Computed across the ladder rather than assumed to be
 * the first rung, so adding a sparser rung cannot quietly shorten deadlines.
 */
function smallestPacking() {
  let fewest = Infinity
  for (const id of LADDER) {
    fewest = Math.min(fewest, blocksPerFrame(capacityFor(layoutFor(id), OPTICAL.parity).payloadBytes, BLOCK_BYTES))
  }
  return Math.max(1, fewest)
}

/**
 * Fraction of the transfer complete, from whichever side is asking.
 *
 * Against the fountain's real requirement, not against `k`: collecting `k`
 * blocks is not the same as being able to solve them, so dividing by `k` alone
 * reports 100% with a quarter of the transfer still to run. The `done` flag in
 * the same status code is the only thing that means finished.
 */
function progressFraction(machine) {
  const progress = machine.context.progress
  if (!progress?.need) return 0
  const want = progress.need * FOUNTAIN_OVERHEAD
  return Math.max(0, Math.min(0.99, (progress.have ?? 0) / want))
}

/**
 * A resource could not start. Required ones fail the transfer; optional ones
 * only mark it degraded, and the affected screen explains what is missing.
 *
 * Whether it was required is decided against the state we are in *now*, not
 * the one that asked for it. Starting a capture device is asynchronous, so a
 * refusal can easily arrive after the machine has moved on.
 */
function report(capability, reason) {
  const mode = resourcesFor(store.get())[capability]
  if (!mode) return // no longer wanted; the refusal is moot
  if (mode === 'optional') {
    store.send({ type: Event.DEGRADED, capability, reason })
  } else {
    store.send({ type: Event.FAULT, reason })
  }
}

/**
 * Bring the world in line with what the current state says should be running.
 * Starts are awaited in sequence so that a rapid transition cannot leave two
 * copies of a resource alive.
 */
let reconciling = Promise.resolve()

function reconcile(machine) {
  const wanted = resourcesFor(machine)

  reconciling = reconciling.then(async () => {
    // Stop first, so a camera is released before another opens.
    for (const name of Object.keys(running)) {
      if (!wanted[name] && running[name]) {
        try {
          running[name]()
        } catch {
          /* already gone */
        }
        running[name] = null
      }
    }
    for (const name of Object.keys(running)) {
      if (wanted[name] && !running[name]) {
        // Placeholder prevents a second start slipping in while this awaits.
        running[name] = () => {}
        try {
          running[name] = await starters[name](wanted[name])
        } catch (error) {
          running[name] = null
          report(name, String(error?.message || error))
        }
      }
    }
  })

  return reconciling
}

// ---------------------------------------------------------- entry effects

/** Side effects that fire once, on entering a state. */
async function onEnter(machine, previous) {
  const { state, role, context } = machine

  // Wi-Fi keeps its own connect deadline, and a dropped channel fails at once.
  if (state === State.TRANSFERRING_SEND && context.mode === 'wifi') return

  if (state === State.TRANSFERRING_SEND && context.mode === 'wave') {
    // One block per message, and nothing to sweep: the receiver hears every
    // protocol at once.
    const ideal = context.outgoing.waveMessages * (WAVE.messageSeconds + WAVE.gapSeconds) * 1000
    const budget = Math.max(TRANSFER.doneTimeoutFloorMs, ideal * TRANSFER.doneTimeoutFactor)
    armTimer('done', budget, () => store.send({ type: Event.TIMEOUT }))
    return
  }

  if (state === State.TRANSFERRING_SEND) {
    // The SMALLEST rung's packing - and with the sweep below the emitter
    // genuinely spends time down there. Deliberately the pessimistic reading:
    // this is a deadline, not an estimate.
    const frames = Math.max(1, Math.ceil((context.outgoing?.blocks ?? 1) / smallestPacking()))
    const ideal = (frames * FOUNTAIN_OVERHEAD * 1000) / OPTICAL.frameRate
    const budget = Math.max(TRANSFER.doneTimeoutFloorMs, ideal * TRANSFER.doneTimeoutFactor)
    armTimer('done', budget, () => store.send({ type: Event.TIMEOUT }))
    // Starts the sweep unless a status turns up first. Armed here rather than
    // only from blindSender, because a camera that opens and never finds a
    // beacon is the commoner blindness by far: the receiver defaults to its
    // rear lens, which points its screen away from this one.
    deferSweep()
    return
  }

  if (state === State.TRANSFERRING_RECEIVE) {
    /**
     * The receiver needs its own deadline.
     *
     * Without one it sits here forever on a transfer that has stopped - the
     * sender's tab closed, or the phone put down - holding the camera and the
     * wake lock and showing partial progress, and the FAILED path for it was
     * unreachable. Rearmed on every progress event below, so it only fires
     * after a genuine stall rather than capping the transfer's length.
     */
    armReceiveTimeout()
    return
  }

  if (state === State.VERIFYING) {
    const outcome = await session.reassembler.finalize()
    if (outcome.ok) {
      // Measured here rather than when the measurements are saved, which is
      // however long the received screen was open later.
      if (session.telemetry) {
        session.telemetry.context.completed = {
          fileBytes: outcome.file.size,
          seconds: session.telemetry.snapshot().elapsedSeconds,
        }
      }
      store.send({ type: Event.VERIFY_OK, incoming: outcome.file })
    } else {
      store.send({ type: Event.VERIFY_FAILED, reason: outcome.reason })
    }
    return
  }

  if (state === State.COMPLETE && role === Role.RECEIVER) {
    // No automatic download. The received screen puts the file on a link the
    // user taps, which is the only form iOS Safari honours - see fileUrl().
    chime()
    return
  }

  if (state === State.IDLE && previous?.state !== State.IDLE) endSession()
}

/** Drop the session, and with it the encoders and everything they hold. */
function endSession() {
  session = null
}

/**
 * Two notes when a file lands.
 *
 * Nothing about the LINK makes a sound - the transfer is optical in both
 * directions and that does not change. This is only the receiver telling its
 * holder the job is done, because the phone is pointed away from its own
 * screen at that moment and cannot be watched.
 *
 * Synthesised rather than shipped as an asset: two oscillators is less than
 * the <audio> element and the file it would need. Failure is ignored - a
 * browser that blocks the AudioContext still completed the transfer.
 */
function chime() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    const at = ctx.currentTime
    // A rising fifth reads as "done" where a single tone reads as "attention".
    for (const [note, when] of [[880, 0], [1320, 0.12]]) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.frequency.value = note
      osc.type = 'sine'
      // Ramped, not switched: a square-edged gate on a sine is an audible click.
      gain.gain.setValueAtTime(0.0001, at + when)
      gain.gain.exponentialRampToValueAtTime(0.2, at + when + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.0001, at + when + 0.18)
      osc.connect(gain).connect(ctx.destination)
      osc.start(at + when)
      osc.stop(at + when + 0.2)
    }
    setTimeout(() => ctx.close().catch(() => {}), 600)
  } catch {
    /* no audio available; the download prompt is still the real signal */
  }
}

// ------------------------------------------------------------------ actions

function loadSetting(key, fallback) {
  try {
    const raw = localStorage.getItem(`airbeam.${key}`)
    return raw === null ? fallback : JSON.parse(raw)
  } catch {
    return fallback
  }
}

function saveSetting(key, value) {
  try {
    localStorage.setItem(`airbeam.${key}`, JSON.stringify(value))
  } catch {
    /* private browsing; settings just will not persist */
  }
}

/**
 * Restore a setting only if it is still a value this build understands.
 *
 * Without this, a stored setting from an older build is a startup crash rather
 * than a stale preference: `layoutFor` throws on an unknown grid id, and it is
 * called from the idle screen, so the app lands on a blank page with no way to
 * reach the settings that would fix it. Rung names have already changed once
 * during development.
 */
function loadValid(key, fallback, isValid) {
  const value = loadSetting(key, fallback)
  if (isValid(value)) return value
  saveSetting(key, fallback)
  return fallback
}

/**
 * Which lens the receiver reads with.
 *
 * `environment` - the back camera - is the default because it is the better
 * instrument: higher resolution and a real autofocus, where a front camera is
 * often fixed-focus and wide enough that the code fills a fraction of the
 * frame. px/tile is the number that decides whether anything decodes at all,
 * and the back lens wins it.
 *
 * The cost is the optical back channel, which needs the receiver's SCREEN
 * pointed at the sender and so only works on the front camera. That trade is
 * only worth taking when the sender has a camera to read the beacon with -
 * a desktop usually does not - so it is offered as a flip rather than imposed.
 */
let cameraFacing = loadValid('facing', 'environment', (v) => v === 'user' || v === 'environment')

/**
 * Whether the sender paints its code a quarter turn round.
 *
 * Worth a setting rather than a guess, because the sender cannot see the
 * thing it depends on. What decides it is the shape of the RECEIVER's capture
 * frame, and the sender learns that only over the back channel - which needs
 * the receiver's screen pointed back at it, and the receiver defaults to its
 * back lens precisely because that lens reads better. So in the common setup
 * there is no channel to carry it and the person holding the phone is the only
 * one who knows. See emitter.js for what it buys: 1.78x px/tile for a phone
 * held upright.
 */
let codeTurned = loadValid('turned', false, (v) => typeof v === 'boolean')

OPTICAL.profile = loadValid('profile', OPTICAL.profile, (v) => LADDER.includes(v))

const actions = {
  settings: {
    get profile() {
      return OPTICAL.profile
    },
    get turned() {
      return codeTurned
    },
  },

  setProfile(value) {
    OPTICAL.profile = value
    saveSetting('profile', value)
    // An explicit choice ends the blind sweep, or the setting would be undone
    // a second later and the panel would fight whoever used it.
    clearTimer('sweep')
    session?.emitter?.setProfile(value)
  },
  /**
   * Turn the code, mid-transfer if need be.
   *
   * Cheap to change at any moment: the receiver reads orientation off the
   * corner anchors on every frame, so it follows a turn without being told and
   * without losing the frames already in flight.
   */
  setTurned(value) {
    codeTurned = Boolean(value)
    saveSetting('turned', codeTurned)
    session?.emitter?.setTurned(codeTurned)
  },

  /** The screens' own preferences: whether the intro has been seen, and the technical details. */
  ui: { get: loadSetting, set: saveSetting },

  get facing() {
    return cameraFacing
  },

  /**
   * Swap lenses without leaving the aiming screen.
   *
   * The scanner is stopped and restarted rather than reconfigured: a facing
   * change is a different MediaStreamTrack, and applyConstraints cannot move
   * between physical cameras. Going through reconcile() keeps the single
   * owner of the camera - nothing else here opens or closes one.
   */
  async flipCamera() {
    cameraFacing = cameraFacing === 'user' ? 'environment' : 'user'
    saveSetting('facing', cameraFacing)
    if (!running.scanner) return
    try {
      running.scanner()
    } catch {
      /* already gone */
    }
    running.scanner = null
    await reconcile(store.get())
    render(store.get())
  },

  async pickFile(file) {
    const problem = validateFile(file, WIFI_MAX_BYTES)
    if (problem) {
      store.send({ type: Event.FAULT, reason: problem })
      return
    }

    // Past what light and sound can carry, only Wi-Fi is offered - and it
    // reads the file as it sends, so nothing here reads, hashes or encodes it.
    if (file.size > TRANSFER.maxFileBytes) {
      endSession()
      session = { file }
      store.send({
        type: Event.FILE_READY,
        outgoing: { name: file.name, size: file.size, digest: '', shortDigest: '', blocks: 0, blocksPerFrame: 1, waveMessages: Infinity, air: false },
      })
      return
    }

    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const digest = await sha256Hex(bytes)
      const envelope = wrapFile({ name: file.name, type: file.type, bytes, digest })

      /**
       * The block size is fixed for the whole transfer and the same on every
       * rung: the decoder keys on the block count, so it cannot change once
       * frames are going out, however much the rung or the parity does.
       * BLOCK_BYTES is chosen to fill all five rungs; see fountain.js.
       */
      const encoder = await createFrameEncoder(envelope, BLOCK_BYTES)
      const capacity = capacityFor(layoutFor(OPTICAL.profile), OPTICAL.parity)
      // Wave's own blocks, one per 140-byte message, and always the fountain
      // since it is the codec that compresses. Not built past 1 MB -
      // deflating a big file twice for a channel that tops out near 17 KB is
      // wasted seconds; a file that compresses 60:1 is the ceiling this costs.
      const waveEncoder =
        envelope.length <= 1024 * 1024 ? await createFrameEncoder(envelope, WAVE.messageBytes) : null

      endSession()
      session = {
        file,
        encoder,
        waveEncoder,
        digest,
        // Six bits of the file checksum every block carries, so the receiver's
        // status code can say which transfer it is talking about without
        // spending much of its 24 bits. The receiver reads the same bits.
        sessionTag: encoder.checksum & 0x3f,
        telemetry: createTelemetry({
          role: 'sender',
          profile: OPTICAL.profile,
          formatVersion: FORMAT_VERSION,
          frameRate: OPTICAL.frameRate,
          startedAt: new Date().toISOString(),
        }),
      }

      store.send({
        type: Event.FILE_READY,
        outgoing: {
          name: file.name,
          size: file.size,
          digest,
          shortDigest: shortDigest(digest),
          blocks: encoder.blocks,
          codec: encoder.codec,
          // Frames carry many blocks, so the wall-clock estimate needs to
          // know how many - otherwise it over-states the time by that factor.
          blocksPerFrame: Math.max(1, blocksPerFrame(capacity.payloadBytes, BLOCK_BYTES)),
          waveMessages: waveEncoder ? Math.ceil(waveEncoder.blocks * WAVE.overhead) : Infinity,
        },
      })
    } catch (error) {
      store.send({ type: Event.FAULT, reason: String(error?.message || error) })
    }
  },

  /**
   * Air, Wave or Wi-Fi, on either side. Unlocks audio here because this is the
   * tap: for playback on a Wave sender, for the microphone on a receiver, and
   * for both on Wi-Fi, which chirps and listens on each side.
   */
  chooseMode(mode) {
    if (mode === 'wave') unlockAudio(store.get().role === Role.SENDER ? { playback: true } : undefined)
    if (mode === 'wifi') unlockAudio()
    store.send({ type: Event.CHOOSE_MODE, mode })
  },

  chooseReceiver() {
    unlockAudio()
    endSession()
    session = {
      channels: { air: createReassembler(null, null), wave: createReassembler(null, null, WAVE.messageBytes) },
    }
    store.send({ type: Event.CHOOSE_RECEIVER })
  },

  /** The sender checked the match number on both screens. */
  confirmWifi() {
    session?.wifi?.confirm()
  },

  forceComplete() {
    store.send({ type: Event.FORCE_COMPLETE })
  },

  fileUrl,

  /**
   * Hand the telemetry over as a file.
   *
   * The point of the instrumentation is that a claim about throughput can be
   * checked by someone else, which needs the records to leave the device.
   */
  downloadTelemetry() {
    session?.telemetry?.download()
  },

  reset() {
    store.send({ type: Event.RESET })
  },
}

// ------------------------------------------------------------------ render

let current = { name: null, view: null }

function render(machine) {
  const name = screenFor(machine)
  if (name === current.name && current.view) {
    current.view.update(machine)
    return
  }
  current.view?.dispose?.()
  const view = buildScreen(name, machine, actions, surfaces)
  current = { name, view }
  root.replaceChildren(view.node)
  // Only the change of screen is spoken: a live region over the whole app
  // read out every progress repaint.
  announcer.textContent = view.node.querySelector('h1, h2')?.textContent ?? ''
}

store.subscribe((machine, previous) => {
  // A change of channel mid-send is handled as re-entering the state, so its
  // resources and deadline are rebuilt for the new one.
  if (machine.state !== previous.state || machine.context.mode !== previous.context.mode) {
    clearAllTimers()
    reconcile(machine)
    onEnter(machine, previous).catch((error) =>
      store.send({ type: Event.FAULT, reason: String(error?.message || error) }),
    )
  }
  render(machine)
})

const onLocalhost = ['localhost', '127.0.0.1'].includes(location.hostname)

if (onLocalhost) {
  // Handle for driving the machine through states without a second device.
  // Only on this machine, where nobody but the developer is looking.
  window.__airbeam = { store, actions, surfaces, get session() { return session } }
}

const devRoute = new URLSearchParams(location.search)

// The harnesses load only when asked for, so they cost the app nothing.
if (devRoute.has('wifi-loopback')) {
  import('./src/dev/wifi-loopback.js').then(({ runWifiLoopback }) => runWifiLoopback(root))
} else if (devRoute.has('loopback')) {
  import('./src/dev/loopback.js').then(({ runLoopback }) => runLoopback(root))
} else {
  render(store.get())
  reconcile(store.get())
}

// -------------------------------------------------------------------- PWA

if ('serviceWorker' in navigator && !onLocalhost) {
  window.addEventListener('load', () => {
    // Relative, so the worker sits beside index.html and its scope covers the
    // app whether it is served from the domain root or a project subpath.
    navigator.serviceWorker.register('sw.js').catch(() => {
      // Offline support is a nicety here; the app works fine without it.
    })
  })
}
