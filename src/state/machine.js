/**
 * The transfer state machine.
 *
 * This module is pure: it knows nothing about the DOM or the camera. It takes
 * the current state plus an event and returns the next state. Side effects are
 * not performed here - each state simply declares which resources it wants
 * running (see `resourcesFor`), and the runtime in main.js reconciles reality
 * against that declaration on every transition.
 *
 * Doing it that way means a resource can never be started twice or leaked by a
 * transition nobody thought about: the desired set is derived from the state,
 * not accumulated by hand.
 *
 * ## What the acoustic handshake used to do, and what replaced it
 *
 * There were three more states here: one that played an offer tone, one that
 * listened for it, and one where a human looked at an Accept prompt. They are
 * gone with the audio channel.
 *
 * Only one of them was doing real work. The offer and its acknowledgement only
 * ever fired for files over 10 MB, and every ordinary transfer already skipped
 * them - the optical stream carries the filename, type and checksum, so the
 * camera alone was always enough. What is genuinely lost is the chance to
 * DECLINE before any bytes move; the download at the end is still a deliberate
 * action, so nothing reaches disk unasked, but a receiver can no longer refuse
 * in advance.
 *
 * The confirmation tone was doing real work, and its replacement is the optical
 * back channel: the receiver paints a small status code on its own screen and
 * the sender reads it. That also carries live link quality, which sound never
 * did, and which is what lets the sender pick a rung on the grid ladder instead
 * of guessing.
 */

import { State, Role, Event } from './events.js'

export function initialMachine() {
  return {
    state: State.IDLE,
    role: null,
    context: {
      /** File the sender picked, plus its bytes and digest. */
      outgoing: null,
      /** Reassembled + verified file, on the receiving side. */
      incoming: null,
      /** Live counters for the progress screens. */
      progress: null,
      /** Human-readable explanation when state is FAILED. */
      fault: null,
      /** Diagnostics surfaced in the UI for tuning. */
      diagnostics: null,
      /** Live aiming measurements, while the receiver is hunting. */
      guidance: null,
      /** What the receiver's status code last said, on the sending side. */
      backchannel: null,
      /**
       * Whether the send ended because the receiver said it had the file, as
       * opposed to the user deciding it had.
       *
       * Recorded here rather than inferred from the last status code, because
       * the two are not the same thing: the status that arrives alongside the
       * done flag may not be the last one stored, and reading staleness as
       * "unconfirmed" told people their transfer had probably failed when it
       * had just succeeded.
       */
      confirmed: false,
      /** Optional capabilities that failed to start, keyed by name. */
      degraded: null,
      /**
       * How the file travels: 'air' (the camera), 'wave' (sound) or 'wifi'. Asked on
       * both sides, and it decides which capture device the receiver opens.
       */
      mode: null,
    },
  }
}

/** Every state maps to exactly one screen, keyed by state, role and mode. */
export function screenFor({ state, role, context }) {
  if (state === State.COMPLETE) {
    return role === Role.SENDER ? 'delivered' : 'received'
  }
  if (state === State.CHOOSING && role === Role.RECEIVER) return 'choosing-receive'
  if (context.mode === 'wifi' && [State.TRANSFERRING_SEND, State.AIMING, State.TRANSFERRING_RECEIVE].includes(state)) {
    return 'wifi'
  }
  if (context.mode === 'wave') {
    if (state === State.TRANSFERRING_SEND) return 'transferring-send-wave'
    if (state === State.AIMING) return 'listening'
    if (state === State.TRANSFERRING_RECEIVE) return 'transferring-receive-wave'
  }
  return state
}

/**
 * Resources a state needs running. The runtime starts anything listed that is
 * not already up and stops anything up that is no longer listed.
 *
 *   emitter      - the flashing airblock canvas
 *   scanner      - camera capture feeding the decode worker
 *   wave         - the same frames played as sound
 *   listener     - microphone feeding the sound decoder
 *   wifi         - the Wi-Fi link: a chirped handshake, then a data channel
 *   backchannel  - receiver: paint a status code; sender: read one
 *   wakeLock     - keep the screen on while it is doing the talking
 *
 * Each is marked 'required' or 'optional'. A required resource that will not
 * start fails the transfer; an optional one that will not start degrades it and
 * says so in the UI.
 *
 * The back channel is optional on both sides, deliberately. It is the only
 * thing that tells the sender it can stop, and the only thing that lets the
 * sender adapt the grid rung - but a transfer where it never starts still
 * works, falling back to an estimate and a button. A feature that improves a
 * transfer should not be able to prevent one.
 */
export function resourcesFor({ state, role, context }) {
  // One link from the first chirp to the last byte, so it outlives the move
  // from waiting to receiving.
  if (context.mode === 'wifi' && [State.TRANSFERRING_SEND, State.AIMING, State.TRANSFERRING_RECEIVE].includes(state)) {
    return { wifi: 'required', wakeLock: 'optional' }
  }
  switch (state) {
    case State.AIMING:
      /**
       * Nothing arriving yet, on the channel the receiver chose: the camera for
       * Air, the microphone for Wave, never both. Both at once asked iOS for
       * two permissions to use one, and left a receiver that chose sound
       * pointing a camera at the desk and being told to aim it.
       */
      return context.mode === 'wave'
        ? { listener: 'required', wakeLock: 'optional' }
        : { scanner: 'required', wakeLock: 'optional' }

    case State.TRANSFERRING_SEND:
      return context.mode === 'wave'
        ? { wave: 'required', wakeLock: 'optional' }
        : { emitter: 'required', backchannel: 'optional', wakeLock: 'optional' }

    case State.TRANSFERRING_RECEIVE:
      return context.mode === 'wave'
        ? { listener: 'required', wakeLock: 'optional' }
        : { scanner: 'required', backchannel: 'optional', wakeLock: 'optional' }

    case State.VERIFYING:
    case State.COMPLETE:
      /**
       * The receiver keeps painting its status code after it has the file.
       *
       * The done flag is the only thing that tells the sender to stop, and it
       * can only be true in these two states - so tearing the beacon down on
       * the way into them meant it could never be shown, and the sender always
       * ran to its timeout or waited for someone to tap Done. The camera is
       * released either way; only the small canvas keeps updating.
       */
      return role === Role.RECEIVER ? { backchannel: 'optional' } : {}

    default:
      return {}
  }
}

const fail = (machine, fault) => ({
  ...machine,
  state: State.FAILED,
  context: { ...machine.context, fault },
})

/**
 * @param {object} machine current machine value
 * @param {{type: string, [k: string]: any}} event
 * @returns {object} next machine value (the same object if nothing applied)
 */
export function transition(machine, event) {
  const { state, role, context } = machine

  // Events that are meaningful from anywhere.
  switch (event.type) {
    case Event.RESET:
      return initialMachine()
    case Event.ABORT:
      return fail(machine, event.reason || 'Transfer cancelled.')
    case Event.FAULT:
      return fail(machine, event.reason || 'Something went wrong.')
    case Event.DEGRADED:
      return {
        ...machine,
        context: {
          ...machine.context,
          degraded: { ...(machine.context.degraded || {}), [event.capability]: event.reason },
        },
      }
    default:
      break
  }

  switch (state) {
    case State.IDLE: {
      if (event.type === Event.CHOOSE_SENDER) {
        return { ...machine, role: Role.SENDER }
      }
      if (event.type === Event.CHOOSE_RECEIVER) {
        return { ...machine, role: Role.RECEIVER, state: State.CHOOSING }
      }
      if (event.type === Event.FILE_READY) {
        // The stream describes itself, so the only thing to settle first is
        // which way it travels.
        return {
          ...machine,
          role: Role.SENDER,
          state: State.CHOOSING,
          context: { ...context, outgoing: event.outgoing },
        }
      }
      return machine
    }

    case State.CHOOSING: {
      if (event.type === Event.CHOOSE_MODE) {
        const next = role === Role.RECEIVER ? State.AIMING : State.TRANSFERRING_SEND
        return { ...machine, state: next, context: { ...context, mode: event.mode } }
      }
      return machine
    }

    case State.AIMING: {
      // Switching channel before anything has arrived: the runtime reads the
      // new mode as a new set of resources, so the camera and the microphone
      // swap over.
      if (event.type === Event.CHOOSE_MODE && event.mode !== context.mode) {
        return { ...machine, context: { ...context, mode: event.mode, guidance: null } }
      }
      if (event.type === Event.GUIDANCE) {
        return {
          ...machine,
          context: { ...context, guidance: event.guidance, diagnostics: event.diagnostics ?? context.diagnostics },
        }
      }
      if (event.type === Event.FRAMES_SEEN) {
        return { ...machine, state: State.TRANSFERRING_RECEIVE }
      }
      return machine
    }

    case State.TRANSFERRING_SEND: {
      if (event.type === Event.SEND_PROGRESS) {
        return { ...machine, context: { ...context, progress: event.progress } }
      }
      if (event.type === Event.BACKCHANNEL_STATUS) {
        return { ...machine, context: { ...context, backchannel: event.status } }
      }
      // Switching channel mid-send. The runtime treats a new mode like a new
      // state, so resources and timers are rebuilt for it.
      if (event.type === Event.CHOOSE_MODE && event.mode !== context.mode) {
        return { ...machine, context: { ...context, mode: event.mode, progress: null, backchannel: null } }
      }
      // The receiver's status code is what ends the send. Without it the sender
      // waits for its own timeout, or for the user to say so.
      if (event.type === Event.DONE_SEEN) {
        return { ...machine, state: State.COMPLETE, context: { ...context, confirmed: true } }
      }
      if (event.type === Event.FORCE_COMPLETE) {
        return { ...machine, state: State.COMPLETE, context: { ...context, confirmed: false } }
      }
      if (event.type === Event.TIMEOUT) {
        return fail(
          machine,
          'The receiver never confirmed. It may not have collected enough frames. ' +
            'Try again with the devices closer together.',
        )
      }
      return machine
    }

    case State.TRANSFERRING_RECEIVE: {
      // Switching mid-receive keeps each channel's reassembler, so switching
      // back resumes where that channel left off. The two cannot pool their
      // blocks, which are different sizes.
      if (event.type === Event.CHOOSE_MODE && event.mode !== context.mode) {
        return { ...machine, context: { ...context, mode: event.mode, guidance: null } }
      }
      if (event.type === Event.RECEIVE_PROGRESS) {
        return {
          ...machine,
          context: {
            ...context,
            progress: event.progress,
            diagnostics: event.diagnostics ?? context.diagnostics,
            guidance: event.guidance ?? context.guidance,
          },
        }
      }
      if (event.type === Event.PAYLOAD_ASSEMBLED) {
        // The bytes are still inside the reassembler at this point; the
        // verifying state is what pulls them out and checks them.
        return { ...machine, state: State.VERIFYING }
      }
      if (event.type === Event.TIMEOUT) {
        return fail(machine, 'Gave up waiting for the rest of the file.')
      }
      return machine
    }

    case State.VERIFYING: {
      if (event.type === Event.VERIFY_OK) {
        return {
          ...machine,
          state: State.COMPLETE,
          context: { ...context, incoming: event.incoming },
        }
      }
      if (event.type === Event.VERIFY_FAILED) {
        /**
         * Say WHICH check failed.
         *
         * finalize() distinguishes three quite different endings - a corrupt
         * block, a payload that does not match the digest travelling inside
         * it, and a file that is not the one announced - and this used to
         * replace all three with one sentence. They call for different things:
         * the first is a bad capture worth retrying, the third means frames
         * from two different transfers were mixed and retrying identically
         * will fail identically.
         */
        return fail(
          machine,
          `${event.reason ?? 'The file did not survive the trip.'} Nothing has been saved.`,
        )
      }
      return machine
    }

    case State.FAILED: {
      // A send that ran out of time gets a second try on the other channel;
      // the file is still in hand, so nothing needs picking again.
      if (event.type === Event.CHOOSE_MODE && role === Role.SENDER && context.outgoing) {
        return {
          ...machine,
          state: State.TRANSFERRING_SEND,
          context: { ...context, mode: event.mode, fault: null, progress: null, backchannel: null },
        }
      }
      // A receive that could not open its device, or went quiet, gets the same
      // second try, on either channel. The reassemblers outlive the failure
      // (main.js drops them only on the way back to idle), so going on with
      // the same channel keeps every block already read - a 2 MB transfer
      // that stalled for a minute resumes rather than starts again.
      if (event.type === Event.CHOOSE_MODE && role === Role.RECEIVER) {
        return {
          ...machine,
          state: State.AIMING,
          context: { ...context, mode: event.mode, fault: null, progress: null, guidance: null, degraded: null },
        }
      }
      return machine
    }

    case State.COMPLETE:
      return machine

    default:
      return machine
  }
}

/** Wraps the reducer in a subscribable store. */
export function createStore() {
  let machine = initialMachine()
  const listeners = new Set()

  return {
    get() {
      return machine
    },
    send(event) {
      const next = transition(machine, event)
      if (next === machine) return machine
      const previous = machine
      machine = next
      for (const listener of listeners) listener(machine, previous, event)
      return machine
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
