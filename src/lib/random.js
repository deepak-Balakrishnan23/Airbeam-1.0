/**
 * Seeded random numbers, for everything that must come out the same twice:
 * the fountain's index sets, the frame interleave, the synthetic camera, the
 * symbol search, the tests.
 *
 * A counter that steps by an odd constant, so it visits every 32-bit value
 * once per 2^32 draws, fed through a mixer of three xor-shifts and two
 * multiplies. The shifts and multipliers came out of a search for the mixer
 * whose output bits each flip closest to half the time when any single input
 * bit flips: over 200,000 inputs the worst of the 1,024 input-output pairs is
 * 0.0035 from a half, which is the sampling noise of the test itself.
 *
 * That is the property the fountain leans on. Its seeds are handed out one
 * after another, and a seed one higher must start an unrelated stream.
 */

const STEP = 0x199ef481

/** A 32-bit value to an unrelated 32-bit value. */
export function mix32(x) {
  x ^= x >>> 15
  x = Math.imul(x, 0xc9d7a9a7)
  x ^= x >>> 16
  x = Math.imul(x, 0x9928e4bb)
  x ^= x >>> 17
  return x >>> 0
}

/** Floats in [0, 1) from a 32-bit seed. */
export function seeded(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + STEP) >>> 0
    return mix32(state) / 0x100000000
  }
}
