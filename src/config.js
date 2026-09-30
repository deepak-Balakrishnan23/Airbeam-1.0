/**
 * Every number in this file is a tuning knob that wants real-device testing.
 * They are collected here so that dialling the transfer in never means going
 * hunting through the transport code.
 *
 * The optical numbers that are NOT here are the ones that were measured rather
 * than guessed: the grid ladder lives in src/optical/airblock/grid.js beside the
 * measurements that justify it, and the erasure policy lives in frame.js beside
 * the reason it is a retry rather than a tax. Moving a measured value into a
 * config file invites someone to change it without re-running the measurement.
 */

export const OPTICAL = {
  /**
   * Which rung of the grid ladder to start on. See grid.js for the table.
   *
   * `normal` carries 5,622 bytes per frame and tolerates a capture-pixel PSF
   * sigma of 1.2, which is safe on a 720p camera and comfortable on a 1080p
   * one. The back channel moves this at runtime once the receiver has reported
   * what its camera can actually resolve.
   */
  profile: 'normal',

  /**
   * Reed-Solomon parity symbols per 63-symbol codeword.
   *
   * 12 gives rate 0.81 and corrects 6 errors, 12 erasures, or any mix with
   * 2e + E <= 12. Raising it costs payload linearly and buys correction
   * capacity linearly, so it is the right knob for a marginal link - and the
   * one the back channel reaches for before dropping a whole rung.
   */
  parity: 12,

  /**
   * Frames drawn per second while sending.
   *
   * 15 is reliable in ordinary light, and 20 only in bright, even light. At 15
   * fps the default rung is 82 KB/s of raw optical capacity; what arrives
   * depends on frame yield, which is what the telemetry measures.
   *
   * Rendering a frame costs 1.7-7.3 ms depending on the rung, so the display
   * side has plenty of headroom here. The limit is the camera.
   */
  frameRate: 15,

  camera: {
    /**
     * Requested capture size, as the long side, whichever way up the camera is.
     *
     * Higher is genuinely better here, unlike on the display side: capture
     * pixels per tile is what decides how much defocus a rung can absorb, so a
     * 1080p camera is worth about a rung and a half of throughput. Asked for as
     * `ideal` so a device that cannot manage it still starts; see camera.js for
     * why as a square.
     */
    longSide: 1920,

    /** 60 if the platform will give it. More frames is more chances. */
    frameRate: 60,

    /**
     * Where to pin manual focus, as a fraction of the reported range.
     *
     * The working distance is a phone held towards a screen across a desk, so
     * near the close end. Focus is the one manual control the offline harness
     * showed actually moves the error rate - defocus is the only degradation
     * in the model that costs measurable symbol errors.
     */
    focusHint: 0.15,

    /**
     * Manual exposure time, as a fraction of the reported maximum.
     *
     * Short. The target is a bright, static-per-frame panel, so there is light
     * to spare, and a long exposure buys nothing but motion blur from an
     * unsteady hand.
     */
    exposureHint: 0.05,
  },
}

/**
 * Wave: the file over sound, for when the camera cannot lock on.
 *
 * The modem is in src/audio/wave.js. Measured in Node, 140-byte messages sent
 * at 44.1 kHz and heard at 48 kHz, ten messages a cell, signal peak 0.15 of
 * full scale. "room" adds a phone speaker's response, 150 ppm of clock drift
 * and five echoes from 0.5 to 31 ms; "babble" adds low-pitched noise on top.
 * Messages decoded, of ten:
 *
 *              noise level   .005  .01  .02  .04  .08
 *              clean           10   10   10   10   10
 *              room            10   10   10   10    0
 *              babble          10   10   10    0    0
 *
 * Two bands of 64 tones instead of eight of 8 decoded every cell above at
 * 2.62 s a message against 1.36: the plan to fall back to if real rooms prove
 * harsher.
 */
export const WAVE = {
  /** Air time of one message, what createModem reports as `seconds`. */
  messageSeconds: 1.36,
  /** Silence between messages. The chirp is found through echo, so short. */
  gapSeconds: 0.1,
  /** One fountain block a message: 124 bytes of file, 16 of header and CRC. */
  messageBytes: 140,
  /**
   * Messages needed per block, for the time estimate. The fountain at these
   * sizes, 40 runs each with 30% of messages dropped: median 1.125x at k = 8,
   * 1.03x at k = 33, 1.016x at k = 128, 1.008x at k = 400; a small note is
   * one message over more often than not, which 1.1 rounds in.
   */
  overhead: 1.1,
  /** Peak amplitude of a message, of full scale; the rest is headroom. */
  volume: 0.5,
  /**
   * Longest send Wave will offer, in seconds. Patience sets it, as it does
   * for Air: about 75 KB after compression (about 600 blocks of 124 bytes).
   */
  maxSeconds: 15 * 60,
  /**
   * How long Air runs unacknowledged before suggesting Wave instead. Long
   * enough to have aimed: a suggestion from the first seconds reads as an error.
   */
  nudgeAfterMs: 45_000,
}

export const TRANSFER = {
  /**
   * Multiplier on the ideal transfer time before the sender stops waiting.
   *
   * The ideal time already carries the fountain's own overhead - see
   * FOUNTAIN_OVERHEAD in fountain.js, 1.02x. This 6x on top is for the
   * camera: frames lost to glare, motion blur and a passing hand, which is
   * where the real variance is. Only then is the transfer declared dead.
   */
  doneTimeoutFactor: 6,

  /** Floor for the above, so tiny files still get a fair window. */
  doneTimeoutFloorMs: 60_000,

  /**
   * File size cap: 20 MiB, set by patience.
   *
   * 20 MiB is several minutes of holding a camera steady, on a good link.
   * Wi-Fi has its own, larger cap (src/net/wifi.js).
   *
   * Memory is not the limit: the fountain decoder's heap is linear in the
   * file, about three copies of it at the very end, while elimination runs.
   * That last step also holds the receiver's main thread for about 2 s at
   * this cap in Node on an M2, once, as the transfer completes.
   */
  maxFileBytes: 20 * 1024 * 1024,
}

/**
 * Live aiming targets, for the guidance the receiver shows while it hunts.
 *
 * These are the numbers behind "move closer" and "straighten up". They are
 * expressed against measured quantities rather than feelings: px/tile is what
 * decides how much defocus a rung can absorb, and tilt comes straight out of
 * the anchor homography.
 */
export const GUIDANCE = {
  /** Below this many capture pixels per tile, ask the user to move closer. */
  minPxPerTile: 7,
  /** Fractional edge-length disagreement above which to say "straighten up". */
  maxTilt: 0.12,
  /** Mean per-cell confidence below which the link is not really working. */
  minConfidence: 0.5,
  /** Fraction of pixels at full brightness that counts as glare. */
  maxClipped: 0.02,
}
