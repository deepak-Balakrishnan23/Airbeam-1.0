/**
 * Event and state names. Kept in one place so a typo becomes an undefined
 * import rather than a transition that silently never fires.
 */

export const State = {
  IDLE: 'idle',
  /**
   * Receiver has the camera open and is hunting for a code.
   *
   * This is where the aiming guidance lives - distance, tilt and glare, from
   * measurements the geometry pass produces anyway. It replaced a state that
   * waited for an acoustic offer, and it earns its keep far better: the largest
   * measured gap in a channel like this one is user behaviour, not decoding.
   */
  AIMING: 'aiming',
  /** Sender has a file and is being asked how to send it: Air, Wave or Wi-Fi. */
  CHOOSING: 'choosing',
  TRANSFERRING_SEND: 'transferring-send',
  TRANSFERRING_RECEIVE: 'transferring-receive',
  VERIFYING: 'verifying',
  COMPLETE: 'complete',
  FAILED: 'failed',
}

export const Role = {
  SENDER: 'sender',
  RECEIVER: 'receiver',
}

export const Event = {
  // Intent
  CHOOSE_SENDER: 'CHOOSE_SENDER',
  CHOOSE_RECEIVER: 'CHOOSE_RECEIVER',
  FILE_READY: 'FILE_READY',
  /** Send by `air` (the camera) or `wave` (sound); also switches mid-send. */
  CHOOSE_MODE: 'CHOOSE_MODE',
  RESET: 'RESET',
  ABORT: 'ABORT',
  FORCE_COMPLETE: 'FORCE_COMPLETE',

  // Optical layer
  /** The camera read a frame, so a transfer is underway. */
  FRAMES_SEEN: 'FRAMES_SEEN',
  SEND_PROGRESS: 'SEND_PROGRESS',
  RECEIVE_PROGRESS: 'RECEIVE_PROGRESS',
  PAYLOAD_ASSEMBLED: 'PAYLOAD_ASSEMBLED',
  /** Live aiming measurements, while the receiver is still hunting. */
  GUIDANCE: 'GUIDANCE',

  // Back channel, receiver -> sender
  /** The receiver's status code says it has the whole file. */
  DONE_SEEN: 'DONE_SEEN',
  /** Progress and link quality read off the receiver's screen. */
  BACKCHANNEL_STATUS: 'BACKCHANNEL_STATUS',

  // Verification
  VERIFY_OK: 'VERIFY_OK',
  VERIFY_FAILED: 'VERIFY_FAILED',

  // Anything that went wrong
  TIMEOUT: 'TIMEOUT',
  FAULT: 'FAULT',
  /** An optional capability could not be started; the transfer continues. */
  DEGRADED: 'DEGRADED',
}
