/**
 * Arithmetic in GF(2^6) - the 64 element binary field.
 *
 * Six bits is the whole point. An airblock tile carries exactly six bits (four
 * symbol, two colour), so a field of 64 elements makes one tile equal one
 * Reed-Solomon symbol. Packing 6-bit tiles into GF(256) bytes instead would
 * straddle tile boundaries: a single misread tile could corrupt two adjacent
 * code symbols, and per-tile confidence would no longer map onto symbol
 * reliability. Working in GF(64) removes both problems by construction.
 *
 * Primitive polynomial x^6 + x + 1 (0x43). It is primitive over GF(2), so 2 is
 * a generator of the multiplicative group and the exp/log tables below cover
 * every non-zero element exactly once.
 */

export const ORDER = 64
/** Size of the multiplicative group: every non-zero element is 2^k for some k. */
export const UNITS = ORDER - 1 // 63
const POLY = 0x43

/** EXP[i] = 2^i. Doubled in length so a product's exponent never needs a mod. */
export const EXP = new Uint8Array(UNITS * 2)
/** LOG[x] = k such that 2^k == x. LOG[0] is meaningless and left at zero. */
export const LOG = new Uint8Array(ORDER)

{
  let x = 1
  for (let i = 0; i < UNITS; i++) {
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    // Reduce modulo the field polynomial the moment the value outgrows 6 bits.
    if (x & ORDER) x ^= POLY
  }
  for (let i = 0; i < UNITS; i++) EXP[UNITS + i] = EXP[i]
}

/** Addition and subtraction are both XOR in a binary field. */
export const add = (a, b) => a ^ b
export const sub = add

export function mul(a, b) {
  if (a === 0 || b === 0) return 0
  return EXP[LOG[a] + LOG[b]]
}

export function div(a, b) {
  if (b === 0) throw new Error('GF(64) division by zero')
  if (a === 0) return 0
  return EXP[LOG[a] - LOG[b] + UNITS]
}

export function inv(a) {
  if (a === 0) throw new Error('GF(64) has no inverse for zero')
  return EXP[UNITS - LOG[a]]
}

/** 2^k, for any integer k including negatives. */
export function pow2(k) {
  return EXP[((k % UNITS) + UNITS) % UNITS]
}

/** a^n. */
export function pow(a, n) {
  if (a === 0) return n === 0 ? 1 : 0
  return EXP[(((LOG[a] * n) % UNITS) + UNITS) % UNITS]
}

// -------------------------------------------------------------- polynomials

/**
 * Polynomials are Uint8Array coefficient lists, highest power first, matching
 * the codeword layout: index 0 is the coefficient of x^(len-1).
 */

export function polyMul(a, b) {
  const out = new Uint8Array(a.length + b.length - 1)
  for (let i = 0; i < a.length; i++) {
    if (a[i] === 0) continue
    const la = LOG[a[i]]
    for (let j = 0; j < b.length; j++) {
      if (b[j] === 0) continue
      out[i + j] ^= EXP[la + LOG[b[j]]]
    }
  }
  return out
}

export function polyAdd(a, b) {
  const out = new Uint8Array(Math.max(a.length, b.length))
  out.set(a, out.length - a.length)
  for (let i = 0; i < b.length; i++) out[out.length - b.length + i] ^= b[i]
  return out
}

/** Multiply every coefficient by a scalar. */
export function polyScale(a, s) {
  const out = new Uint8Array(a.length)
  if (s === 0) return out
  const ls = LOG[s]
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== 0) out[i] = EXP[LOG[a[i]] + ls]
  }
  return out
}

/** Horner evaluation of a polynomial at x. */
export function polyEval(a, x) {
  let y = 0
  for (let i = 0; i < a.length; i++) y = mul(y, x) ^ a[i]
  return y
}
