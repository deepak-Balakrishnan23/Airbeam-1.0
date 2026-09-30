/**
 * Reed-Solomon over GF(64), with erasures.
 *
 * One code symbol is one tile. That alignment is the whole reason for working
 * in GF(64) rather than GF(256), and it buys two things:
 *
 *   - a misread tile is exactly one symbol error, never a straddle across two
 *   - the per-tile confidence the classifier already produces maps 1:1 onto
 *     symbol reliability, so erasure flags are *exact* rather than a guess
 *
 * The second matters more than it looks. RS corrects up to `n-k` erasures but
 * only `(n-k)/2` errors - twice as many positions for a known-suspect symbol
 * as for an unknown one. The classifier knows which tiles it was unsure about,
 * so that factor of two is available for free.
 *
 * Decoding is the textbook chain: syndromes, Forney syndromes to fold in the
 * erasures, Berlekamp-Massey for the unknown error positions, Chien search for
 * the roots, Forney for the magnitudes. The final syndrome recheck is what
 * makes a successful decode a near-zero-false-accept signal, which is why the
 * format carries no CRC of its own.
 */

import { EXP, LOG, mul, div, inv, pow2, polyMul, polyEval } from './gf64.js'

/** Symbols per codeword. 63 = 2^6 - 1, the natural RS length for this field. */
export const N = 63
/** Data symbols per codeword at the default rate. 12 parity -> rate 0.8095. */
export const K = 51

/**
 * Polynomials in this file are LOW-power-first: p[i] is the coefficient of
 * x^i. Codewords are the opposite - c[0] is the highest power - because that
 * is the order symbols travel in. The two conversions live in `locatorFor` and
 * the Chien search, and nowhere else.
 */

/** Generator polynomial for `nsym` parity symbols, high-power-first. */
function generatorPoly(nsym) {
  let g = Uint8Array.from([1])
  for (let i = 0; i < nsym; i++) g = polyMul(g, Uint8Array.from([1, pow2(i)]))
  return g
}

const generatorCache = new Map()

function generator(nsym) {
  let g = generatorCache.get(nsym)
  if (!g) {
    g = generatorPoly(nsym)
    generatorCache.set(nsym, g)
  }
  return g
}

/**
 * Systematic encode: returns n symbols, message first, then parity.
 *
 * @param {Uint8Array} message k symbols, each 0-63
 * @param {number} n codeword length (<= 63; shorter is a shortened code)
 * @param {number} k message length
 */
export function encode(message, n = N, k = K) {
  if (message.length !== k) {
    throw new Error(`RS encode expected ${k} symbols, got ${message.length}`)
  }
  const nsym = n - k
  const g = generator(nsym)
  const out = new Uint8Array(n)
  out.set(message, 0)

  // Synthetic division of message * x^nsym by g, keeping the remainder in place.
  for (let i = 0; i < k; i++) {
    const coef = out[i]
    if (coef === 0) continue
    const lc = LOG[coef]
    for (let j = 1; j < g.length; j++) {
      if (g[j] !== 0) out[i + j] ^= EXP[LOG[g[j]] + lc]
    }
  }
  out.set(message, 0) // division clobbered the message half; restore it
  return out
}

/**
 * The locator for codeword position `j` in a length-`n` codeword.
 *
 * Position 0 carries the highest power of x, so its locator is the highest
 * power of the field generator. Getting this backwards produces a decoder that
 * corrects the mirror image of the real errors, which the round-trip test
 * catches immediately.
 */
const locatorFor = (j, n) => pow2(n - 1 - j)

/** S[i] = C(a^i) for i in 0..nsym-1, low-power-first. */
function syndromes(codeword, nsym) {
  const out = new Uint8Array(nsym)
  for (let i = 0; i < nsym; i++) out[i] = polyEval(codeword, pow2(i))
  return out
}

/** Multiply two low-first polynomials, truncating at x^limit. */
function convolve(a, b, limit) {
  const out = new Uint8Array(limit)
  for (let i = 0; i < a.length && i < limit; i++) {
    if (a[i] === 0) continue
    const la = LOG[a[i]]
    for (let j = 0; j < b.length && i + j < limit; j++) {
      if (b[j] !== 0) out[i + j] ^= EXP[la + LOG[b[j]]]
    }
  }
  return out
}

/** Erasure locator L(x) = prod (1 + X_e x), low-first. */
function erasureLocator(positions, n) {
  let poly = Uint8Array.from([1])
  for (const j of positions) {
    poly = convolve(poly, Uint8Array.from([1, locatorFor(j, n)]), poly.length + 1)
  }
  return poly
}

/**
 * Berlekamp-Massey. Returns the error locator, low-first with sigma[0] == 1,
 * or null if the sequence has no consistent locator of correctable degree.
 */
function berlekampMassey(seq, maxDegree) {
  let sigma = Uint8Array.from([1])
  let prev = Uint8Array.from([1])
  let L = 0
  let shift = 1
  let b = 1

  for (let r = 0; r < seq.length; r++) {
    let delta = seq[r]
    for (let i = 1; i <= L; i++) {
      if (sigma[i] && seq[r - i]) delta ^= mul(sigma[i], seq[r - i])
    }

    if (delta === 0) {
      shift++
      continue
    }

    const scale = div(delta, b)
    const candidate = new Uint8Array(Math.max(sigma.length, prev.length + shift))
    candidate.set(sigma, 0)
    for (let i = 0; i < prev.length; i++) {
      if (prev[i] !== 0) candidate[i + shift] ^= mul(prev[i], scale)
    }

    if (2 * L <= r) {
      const old = sigma
      sigma = candidate
      prev = old
      L = r + 1 - L
      b = delta
      shift = 1
    } else {
      sigma = candidate
      shift++
    }
  }

  // Trim trailing zeros so the degree is honest.
  let deg = sigma.length - 1
  while (deg > 0 && sigma[deg] === 0) deg--
  if (deg !== L) return null // inconsistent: more errors than the code can see
  if (L > maxDegree) return null
  return sigma.subarray(0, L + 1)
}

/** Chien search: codeword positions j where locator(x) vanishes at X_j^-1. */
function findRoots(locator, n) {
  const found = []
  for (let j = 0; j < n; j++) {
    const xInv = inv(locatorFor(j, n))
    // Horner over a low-first polynomial.
    let acc = 0
    for (let i = locator.length - 1; i >= 0; i--) acc = mul(acc, xInv) ^ locator[i]
    if (acc === 0) found.push(j)
  }
  return found
}

/** Formal derivative in characteristic 2: only odd-power terms survive. */
function formalDerivative(poly) {
  const out = new Uint8Array(Math.max(1, poly.length - 1))
  for (let i = 1; i < poly.length; i += 2) out[i - 1] = poly[i]
  return out
}

function evalLow(poly, x) {
  let acc = 0
  for (let i = poly.length - 1; i >= 0; i--) acc = mul(acc, x) ^ poly[i]
  return acc
}

/**
 * Correct a received codeword in place-safe fashion.
 *
 * @param {Uint8Array} received n symbols as read off the screen
 * @param {number[]} [erasures] positions the classifier flagged as unreliable
 * @param {number} [n] codeword length
 * @param {number} [k] message length
 * @returns {{ok: true, codeword: Uint8Array, errors: number, erasures: number}
 *          | {ok: false, reason: string}}
 */
export function decode(received, erasures = [], n = N, k = K) {
  const nsym = n - k
  if (received.length !== n) {
    return { ok: false, reason: `expected ${n} symbols, got ${received.length}` }
  }

  // De-duplicate and bounds-check the flags. A classifier bug that flags the
  // same cell twice would otherwise inflate the erasure locator's degree and
  // silently break an otherwise correctable codeword.
  const flagged = [...new Set(erasures)].filter((j) => j >= 0 && j < n)
  if (flagged.length > nsym) {
    return { ok: false, reason: `${flagged.length} erasures exceeds the ${nsym} symbol budget` }
  }

  const S = syndromes(received, nsym)
  if (S.every((s) => s === 0)) {
    // Already a valid codeword. Any flagged positions happened to be right.
    return { ok: true, codeword: received.slice(), errors: 0, erasures: 0 }
  }

  const lambda = erasureLocator(flagged, n)
  const E = flagged.length

  // Forney syndromes: fold the known positions out, leaving a shorter sequence
  // whose locator describes only the errors nobody flagged.
  const T = convolve(S, lambda, nsym)
  const forney = T.subarray(E)

  const maxErrors = Math.floor((nsym - E) / 2)
  const sigma = berlekampMassey(forney, maxErrors)
  if (!sigma) {
    return { ok: false, reason: 'too many errors to locate' }
  }

  const errata = convolve(lambda, sigma, lambda.length + sigma.length - 1)
  const positions = findRoots(errata, n)
  if (positions.length !== errata.length - 1) {
    // Some roots fell outside the codeword: the syndromes describe an error
    // pattern this length of code cannot hold.
    return { ok: false, reason: 'error locator has roots outside the codeword' }
  }

  const omega = convolve(S, errata, nsym)
  const errataPrime = formalDerivative(errata)

  const corrected = received.slice()
  for (const j of positions) {
    const X = locatorFor(j, n)
    const xInv = inv(X)
    const denom = evalLow(errataPrime, xInv)
    if (denom === 0) return { ok: false, reason: 'degenerate error locator' }
    corrected[j] ^= mul(X, div(evalLow(omega, xInv), denom))
  }

  // The recheck is the whole integrity story for this format. A miscorrection
  // has to produce a valid codeword by chance, which for 12 parity symbols is
  // rare enough that no separate checksum is carried.
  if (!syndromes(corrected, nsym).every((s) => s === 0)) {
    return { ok: false, reason: 'correction did not resolve the syndromes' }
  }

  const errorCount = positions.filter((j) => !flagged.includes(j)).length
  return {
    ok: true,
    codeword: corrected,
    errors: errorCount,
    erasures: positions.length - errorCount,
  }
}

/** Just the message half of a corrected codeword. */
export function decodeMessage(received, erasures = [], n = N, k = K) {
  const outcome = decode(received, erasures, n, k)
  if (!outcome.ok) return outcome
  return { ...outcome, message: outcome.codeword.subarray(0, k) }
}

/** Symbols correctable by a code with this much parity, for sanity checks. */
export const capacity = (n = N, k = K) => ({
  parity: n - k,
  maxErrors: Math.floor((n - k) / 2),
  maxErasures: n - k,
})
