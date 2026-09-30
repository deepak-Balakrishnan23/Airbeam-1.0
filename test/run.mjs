/**
 * Regression suite. No framework - these are scripts that either print a
 * pass line or set a non-zero exit code.
 *
 *   gf64              field axioms for GF(2^6)
 *   rs64              Reed-Solomon correction limits, at and past the boundary
 *   airblock-layout   grid geometry, interleave, and the generated symbol set
 *   airblock-frame    header, payload, and whether erasure flagging earns its keep
 *   airblock-anchors  geometry recovered from pixels alone, plus refusal cases
 *   airblock-optics   the whole optical chain against a synthetic camera
 *   backchannel       the reverse status code, and rung selection
 *   emitter           the sender's frame pacing against simulated displays
 *   camera            the capture size an upright phone camera is asked for
 *   envelope          the self-describing payload wrapper and its integrity check
 *   pipeline          a whole file through the fountain layer with frame loss
 *   wave              a whole file over sound through the modem, and the Air/Wave choice
 *   wifi              the Wi-Fi handshake in one Wave message each way, and its states
 *   imports           every file the page reaches exists, and none is a package
 *
 * `airblock-optics` is the one to read first if something is wrong. It runs the
 * whole chain against a synthetic camera with defocus, vignetting, noise and
 * keystone, and it is where the measurements that shaped the format came from.
 *
 * Run with: npm test
 */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const suites = [
  'gf64.mjs',
  'rs64.mjs',
  'airblock-layout.mjs',
  'airblock-frame.mjs',
  'airblock-anchors.mjs',
  'airblock-optics.mjs',
  'backchannel.mjs',
  'emitter.mjs',
  'camera.mjs',
  'envelope.mjs',
  'pipeline.mjs',
  'wave.mjs',
  'wifi.mjs',
  'imports.mjs',
]

let failed = 0
for (const suite of suites) {
  console.log(`\n=== ${suite} ${'='.repeat(Math.max(0, 58 - suite.length))}`)
  const result = spawnSync(process.execPath, [join(here, suite)], { stdio: 'inherit' })
  if (result.status !== 0) failed++
}

console.log(failed ? `\n${failed} suite(s) failed` : '\nall suites passed')
process.exit(failed ? 1 : 0)
