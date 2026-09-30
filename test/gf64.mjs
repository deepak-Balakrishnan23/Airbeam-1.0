/**
 * Field axioms for GF(2^6).
 *
 * This is table-generation code, and a wrong primitive polynomial produces
 * tables that look plausible and fail only deep inside the Reed-Solomon
 * decoder, where the symptom is "some frames do not decode" rather than
 * anything pointing back here. Checking the axioms directly is much cheaper
 * than debugging that.
 */

import {
  ORDER,
  UNITS,
  EXP,
  LOG,
  add,
  mul,
  div,
  inv,
  pow,
  pow2,
  polyMul,
  polyEval,
  polyAdd,
  polyScale,
} from '../src/optical/airblock/gf64.js'

let failures = 0

function check(label, condition, detail = '') {
  if (condition) return
  failures++
  console.log(`   FAIL ${label}${detail ? ` - ${detail}` : ''}`)
}

// 2 must generate the whole multiplicative group: 63 distinct non-zero powers.
{
  const seen = new Set()
  for (let i = 0; i < UNITS; i++) seen.add(EXP[i])
  check('2 generates all 63 units', seen.size === UNITS, `saw ${seen.size}`)
  check('zero is never a power of 2', !seen.has(0))
}

// exp and log must invert each other.
for (let x = 1; x < ORDER; x++) {
  check('EXP[LOG[x]] == x', EXP[LOG[x]] === x, `x=${x}`)
}

// Every non-zero element has a multiplicative inverse.
for (let a = 1; a < ORDER; a++) {
  check('a * inv(a) == 1', mul(a, inv(a)) === 1, `a=${a}`)
  check('div(a, a) == 1', div(a, a) === 1, `a=${a}`)
}

// Zero and one behave.
for (let a = 0; a < ORDER; a++) {
  check('a * 0 == 0', mul(a, 0) === 0, `a=${a}`)
  check('a * 1 == a', mul(a, 1) === a, `a=${a}`)
  check('a + a == 0', add(a, a) === 0, `a=${a}`)
  check('a^0 == 1', pow(a, 0) === 1, `a=${a}`)
}

// Commutativity, associativity, distributivity over the full table.
for (let a = 0; a < ORDER; a++) {
  for (let b = 0; b < ORDER; b++) {
    check('mul commutes', mul(a, b) === mul(b, a), `${a},${b}`)
    for (let c = 0; c < ORDER; c += 7) {
      check('mul associates', mul(mul(a, b), c) === mul(a, mul(b, c)), `${a},${b},${c}`)
      check(
        'mul distributes over add',
        mul(a, add(b, c)) === add(mul(a, b), mul(a, c)),
        `${a},${b},${c}`,
      )
    }
  }
}

// div is the inverse of mul.
for (let a = 0; a < ORDER; a++) {
  for (let b = 1; b < ORDER; b++) {
    check('div undoes mul', div(mul(a, b), b) === a, `${a},${b}`)
  }
}

// pow agrees with repeated multiplication, and pow2 with EXP.
for (let a = 1; a < ORDER; a++) {
  let acc = 1
  for (let n = 0; n < 10; n++) {
    check('pow matches repeated mul', pow(a, n) === acc, `a=${a} n=${n}`)
    acc = mul(acc, a)
  }
}
for (let k = -70; k < 70; k++) {
  check('pow2 wraps', pow2(k) === pow(2, ((k % UNITS) + UNITS) % UNITS), `k=${k}`)
}

// Polynomial helpers. (x - 1)(x - 1) = x^2 + 1 in characteristic 2.
{
  const p = polyMul(Uint8Array.from([1, 1]), Uint8Array.from([1, 1]))
  check('poly square', p.length === 3 && p[0] === 1 && p[1] === 0 && p[2] === 1, [...p].join(','))
}

// A polynomial with a known root evaluates to zero there.
for (let r = 1; r < ORDER; r++) {
  const p = polyMul(Uint8Array.from([1, r]), Uint8Array.from([1, mul(r, 2)]))
  check('root evaluates to zero', polyEval(p, r) === 0, `r=${r}`)
}

// polyAdd must align on the low-order end, not the high.
{
  const s = polyAdd(Uint8Array.from([1, 2, 3]), Uint8Array.from([4, 5]))
  check('polyAdd aligns low', s.length === 3 && s[0] === 1 && s[1] === (2 ^ 4) && s[2] === (3 ^ 5), [...s].join(','))
}

// polyScale by zero annihilates; by one is identity.
{
  const a = Uint8Array.from([9, 0, 17, 63])
  check('scale by 0', polyScale(a, 0).every((v) => v === 0))
  check('scale by 1', polyScale(a, 1).every((v, i) => v === a[i]))
  check('scale composes', polyScale(polyScale(a, 5), 7).every((v, i) => v === polyScale(a, mul(5, 7))[i]))
}

console.log(failures ? `gf64: ${failures} check(s) failed` : 'gf64: all field axioms hold')
process.exitCode = failures ? 1 : 0
