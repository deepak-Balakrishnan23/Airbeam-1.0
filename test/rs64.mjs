/**
 * Reed-Solomon over GF(64): the correction limits, exactly.
 *
 * The interesting cases are all at the boundary. A decoder that corrects 5 of
 * 6 errors looks fine in a round-trip test and loses roughly half the frames on
 * real hardware, and one that "corrects" past its limit is worse than one that
 * fails - it hands back plausible wrong bytes. So each limit is tested at the
 * boundary and one past it, and the one-past case asserts *detection*, not
 * success.
 */

import { encode, decode, decodeMessage, N, K, capacity } from '../src/optical/airblock/rs64.js'

let failures = 0
const check = (label, ok, detail = '') => {
  if (ok) return
  failures++
  console.log(`   FAIL ${label}${detail ? ` - ${detail}` : ''}`)
}

const rand = (n) => Math.floor(Math.random() * n)
const randomMessage = (k) => Uint8Array.from({ length: k }, () => rand(64))
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i])

/** Pick `count` distinct positions in [0, n). */
function positions(count, n) {
  const pool = new Set()
  while (pool.size < count) pool.add(rand(n))
  return [...pool]
}

/** Flip `at` positions to a different symbol. */
function corrupt(codeword, at) {
  const out = codeword.slice()
  for (const j of at) out[j] = (out[j] + 1 + rand(63)) % 64
  return out
}

const { parity, maxErrors, maxErasures } = capacity()
check('12 parity symbols', parity === 12, String(parity))
check('6 correctable errors', maxErrors === 6, String(maxErrors))
check('12 correctable erasures', maxErasures === 12, String(maxErasures))

// ------------------------------------------------------------- round trip --

for (let trial = 0; trial < 200; trial++) {
  const message = randomMessage(K)
  const codeword = encode(message)
  check('codeword length', codeword.length === N, String(codeword.length))
  check('systematic prefix', same(codeword.subarray(0, K), message))
  const outcome = decodeMessage(codeword)
  check('clean decode', outcome.ok && same(outcome.message, message))
  check('clean decode reports no errors', outcome.ok && outcome.errors === 0)
}

// ------------------------------------------------------- errors, no flags --

for (let count = 0; count <= maxErrors; count++) {
  let ok = 0
  for (let trial = 0; trial < 300; trial++) {
    const message = randomMessage(K)
    const received = corrupt(encode(message), positions(count, N))
    const outcome = decodeMessage(received)
    if (outcome.ok && same(outcome.message, message)) ok++
  }
  check(`${count} errors always corrected`, ok === 300, `${ok}/300`)
}

// One past the limit must be *detected*. A handful of miscorrections is
// mathematically unavoidable; a large fraction would mean the syndrome recheck
// is not doing its job.
{
  let silentlyWrong = 0
  const trials = 2000
  for (let trial = 0; trial < trials; trial++) {
    const message = randomMessage(K)
    const received = corrupt(encode(message), positions(maxErrors + 1, N))
    const outcome = decodeMessage(received)
    if (outcome.ok && !same(outcome.message, message)) silentlyWrong++
  }
  const rate = silentlyWrong / trials
  check(`7 errors rarely miscorrect (${(rate * 100).toFixed(2)}%)`, rate < 0.01, `${silentlyWrong}/${trials}`)
}

// ---------------------------------------------------------- erasures only --

for (const count of [1, 6, 11, maxErasures]) {
  let ok = 0
  for (let trial = 0; trial < 300; trial++) {
    const message = randomMessage(K)
    const at = positions(count, N)
    const received = corrupt(encode(message), at)
    const outcome = decodeMessage(received, at)
    if (outcome.ok && same(outcome.message, message)) ok++
  }
  check(`${count} erasures always corrected`, ok === 300, `${ok}/300`)
}

// Thirteen erasures is past the budget and must be refused outright, not
// attempted - attempting it is how you get plausible wrong bytes.
{
  const message = randomMessage(K)
  const at = positions(maxErasures + 1, N)
  const outcome = decode(corrupt(encode(message), at), at)
  check('13 erasures refused', !outcome.ok, outcome.ok ? 'accepted' : outcome.reason)
}

// -------------------------------------------------------------- the mix ----

// 2e + E <= 12 is the real constraint. Walk the whole boundary.
for (let e = 0; e <= maxErrors; e++) {
  const E = parity - 2 * e
  let ok = 0
  for (let trial = 0; trial < 200; trial++) {
    const message = randomMessage(K)
    const all = positions(e + E, N)
    const flagged = all.slice(0, E)
    const received = corrupt(encode(message), all)
    const outcome = decodeMessage(received, flagged)
    if (outcome.ok && same(outcome.message, message)) ok++
  }
  check(`2*${e} + ${E} = 12 corrected`, ok === 200, `${ok}/200`)
}

// One symbol past the boundary in the mixed case.
for (let e = 1; e <= maxErrors; e++) {
  const E = parity - 2 * e + 1
  let silentlyWrong = 0
  const trials = 400
  for (let trial = 0; trial < trials; trial++) {
    const message = randomMessage(K)
    const all = positions(e + E, N)
    const flagged = all.slice(0, E)
    const received = corrupt(encode(message), all)
    const outcome = decodeMessage(received, flagged)
    if (outcome.ok && !same(outcome.message, message)) silentlyWrong++
  }
  check(
    `2*${e} + ${E} = 13 rarely miscorrects`,
    silentlyWrong / trials < 0.02,
    `${silentlyWrong}/${trials}`,
  )
}

/**
 * Flagging a cell that was actually fine is NOT free.
 *
 * RS has to solve for every flagged position whether or not it was wrong, so a
 * harmless flag consumes erasure budget exactly like a real one. This is the
 * trap behind the erasure work: an over-eager confidence threshold spends the
 * budget on cells that would have decoded anyway and *loses* frames. It is the
 * reason the frame layer caps flags per codeword below the parity count rather
 * than at it.
 */
{
  // 3 real errors + 6 harmless flags = 2*3 + 6 = 12. Exactly affordable.
  let ok = 0
  for (let trial = 0; trial < 300; trial++) {
    const message = randomMessage(K)
    const all = positions(9, N)
    const flagged = all.slice(0, 6)
    const errorsAt = all.slice(6)
    const outcome = decodeMessage(corrupt(encode(message), errorsAt), flagged)
    if (outcome.ok && same(outcome.message, message)) ok++
  }
  check('3 errors + 6 harmless flags = 12, affordable', ok === 300, `${ok}/300`)
}
{
  // 4 real errors + 6 harmless flags = 14. Over budget, and the flags are what
  // pushed it over - unflagged, 4 errors would have been comfortably inside.
  let recovered = 0
  for (let trial = 0; trial < 300; trial++) {
    const message = randomMessage(K)
    const all = positions(10, N)
    const flagged = all.slice(0, 6)
    const errorsAt = all.slice(6)
    const received = corrupt(encode(message), errorsAt)

    const withFlags = decodeMessage(received, flagged)
    if (withFlags.ok && same(withFlags.message, message)) recovered++

    // The same received word with no flags at all must succeed - which is the
    // whole point: the flags actively cost us this codeword.
    const without = decodeMessage(received)
    check('4 errors alone are correctable', without.ok && same(without.message, message))
  }
  check(
    'harmless flags can push a correctable codeword over budget',
    recovered < 300,
    `${recovered}/300 recovered, expected some losses`,
  )
}

// Duplicate and out-of-range flags must not corrupt an otherwise fine decode.
{
  const message = randomMessage(K)
  const at = [3, 3, 3, 9, -1, 999]
  const received = corrupt(encode(message), [3, 9])
  const outcome = decodeMessage(received, at)
  check('duplicate/out-of-range flags tolerated', outcome.ok && same(outcome.message, message))
}

// --------------------------------------------------- shortened header code --

// The self-describing header uses RS(15,4): 11 parity, so 5 correctable errors.
{
  const n = 15
  const k = 4
  for (let count = 0; count <= 5; count++) {
    let ok = 0
    for (let trial = 0; trial < 300; trial++) {
      const message = randomMessage(k)
      const received = corrupt(encode(message, n, k), positions(count, n))
      const outcome = decodeMessage(received, [], n, k)
      if (outcome.ok && same(outcome.message, message)) ok++
    }
    check(`RS(15,4) corrects ${count} errors`, ok === 300, `${ok}/300`)
  }
}

// Wrong length in must be refused rather than read off the end of the array.
{
  const outcome = decode(new Uint8Array(10))
  check('short codeword refused', !outcome.ok)
}

console.log(failures ? `rs64: ${failures} check(s) failed` : 'rs64: all correction limits hold')
process.exitCode = failures ? 1 : 0
