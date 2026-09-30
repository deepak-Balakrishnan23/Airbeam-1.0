/**
 * The sender's frame pacing, against simulated display timelines.
 *
 * The old rule painted whenever 66.7 ms had passed. On a 60 Hz panel that is
 * four refreshes or five depending on which side of the interval a timestamp
 * lands, so the rate wobbles and runs slow. Frames must now be held for a
 * whole number of refreshes, the same number every time, on any panel rate,
 * through timestamp jitter and a dropped callback.
 */

import { createPacer } from '../src/optical/emitter.js'
import { seeded } from '../src/lib/random.js'

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`)
  if (!ok) failures++
}

/** Refreshes each frame was held for, over ten seconds of animation frames. */
function holds(hz, jitterMs, due, { drop = -1 } = {}) {
  const rng = seeded(7)
  const refresh = 1000 / hz
  const painted = []
  for (let n = 0; n < hz * 10; n++) {
    if (n === drop) continue // a callback the browser never delivered
    const now = n * refresh + (rng() - 0.5) * jitterMs
    if (due(now)) painted.push(n)
  }
  return painted.slice(1).map((n, i) => n - painted[i])
}

const oldRule = () => {
  let last = -Infinity
  return (now) => (now - last >= 1000 / 15 ? ((last = now), true) : false)
}
const counts = (list) => [...new Set(list)].sort().map((h) => `${h}x${list.filter((x) => x === h).length}`).join(' ')

for (const [hz, want] of [
  [60, 4],
  [120, 8],
  [90, 6],
]) {
  const pacer = createPacer()
  const got = holds(hz, 1, (now) => pacer(now, 15))
  check(`${hz} Hz holds every frame for ${want} refreshes`, got.every((h) => h === want), counts(got))
}

{
  const pacer = createPacer()
  const got = holds(60, 1, (now) => pacer(now, 15), { drop: 301 })
  check('a dropped callback does not stretch the next frame', got.every((h) => h === 4), counts(got))
}

const before = holds(60, 1, oldRule())
console.log(`  old rule at 60 Hz with 1 ms of jitter: holds ${counts(before)}`)

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall emitter checks passed')
process.exitCode = failures ? 1 : 0
