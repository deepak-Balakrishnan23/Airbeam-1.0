/**
 * The frame layer: header, interleave, payload, and the erasure policy.
 *
 * The last of those is the reason this file is longer than it looks like it
 * should be. "Flag the low-confidence cells as erasures" is an easy claim to
 * make and a hard one to earn - a flag on a cell that was actually fine costs
 * exactly as much budget as a real error, so an over-eager threshold loses
 * frames rather than saving them. So the erasure path is measured against the
 * same channel with flagging switched off, and the test asserts there is a
 * band where flagging wins. If that band ever closes, the policy is wrong and
 * this fails.
 */

import {
  encodeFrame,
  decodeFrame,
  readHeader,
  capacityFor,
  spatialErrorMap,
  BLANK,
  ERASURE,
  FORMAT_VERSION,
} from '../src/optical/airblock/frame.js'
import { layoutFor, slotFor, DEFAULT_PROFILE, HEADER_N } from '../src/optical/airblock/grid.js'
import { N, K } from '../src/optical/airblock/rs64.js'
import { injectSymbolErrors } from './degrade.mjs'
// Seeded, so a marginal channel does not make this test flaky.
import { seeded } from '../src/lib/random.js'

let failures = 0
const check = (label, ok, detail = '') => {
  if (ok) return
  failures++
  console.log(`   FAIL ${label}${detail ? ` - ${detail}` : ''}`)
}


const layout = layoutFor(DEFAULT_PROFILE)

function randomPayload(bytes, rng) {
  const out = new Uint8Array(bytes)
  for (let i = 0; i < bytes; i++) out[i] = Math.floor(rng() * 256)
  return out
}

// ---------------------------------------------------------------- round trip

{
  const rng = seeded(1)
  const capacity = capacityFor(layout)
  // Tied to the default profile rather than hard-coded, so moving the ladder's
  // default rung does not fail this for the wrong reason.
  check(
    'capacity matches the default profile',
    capacity.payloadBytes === Math.floor((layout.codewordCount * K * 6) / 8),
    String(capacity.payloadBytes),
  )
  check('capacity is a useful size', capacity.payloadBytes > 1024, String(capacity.payloadBytes))

  for (const size of [1, 100, capacity.payloadBytes - 1, capacity.payloadBytes]) {
    const payload = randomPayload(size, rng)
    const { cells } = encodeFrame(payload)
    const out = decodeFrame(cells, null)
    check(`clean round trip at ${size} B`, out.ok && out.telemetry.yield === 1)
    // A short payload is zero-padded to capacity, so compare the prefix.
    check(`bytes intact at ${size} B`, out.ok && payload.every((b, i) => b === out.payload[i]))
  }

  // Over capacity must throw rather than silently truncate a file.
  let threw = false
  try {
    encodeFrame(new Uint8Array(capacity.payloadBytes + 1))
  } catch {
    threw = true
  }
  check('over-capacity payload refused', threw)
}

// Anchors must be left blank for the renderer, and no data may hide under them.
{
  const { cells } = encodeFrame(new Uint8Array(64))
  let anchorsPainted = 0
  let dataBlank = 0
  for (let i = 0; i < cells.length; i++) {
    if (layout.role[i] === 1 && cells[i] !== BLANK) anchorsPainted++
    if (layout.role[i] === 0 && cells[i] === BLANK) dataBlank++
  }
  check('anchors carry no payload', anchorsPainted === 0, String(anchorsPainted))
  check('unused slots are blank', dataBlank === layout.spareSlots, `${dataBlank} vs ${layout.spareSlots}`)
}

// ------------------------------------------------------------------- header

{
  const { cells } = encodeFrame(new Uint8Array(64))
  const header = readHeader(cells, null, layout)
  check('header reads', header.ok !== false && header.profile === DEFAULT_PROFILE, header.reason ?? '')
  check('header version', header.version === FORMAT_VERSION)
  check('header parity', header.parity === N - K, String(header.parity))
  check('all four corners agreed', header.corners.decoded === 4, JSON.stringify(header.corners))

  // Two corners destroyed outright and five symbols corrupted in a third. This
  // is the specular-highlight case: a bright reflection wipes one side of the
  // panel and the header still has to come through.
  const damaged = cells.slice()
  for (const strip of layout.headerStrips.slice(0, 2)) {
    for (const raster of strip.cells) damaged[raster] = BLANK
  }
  const third = layout.headerStrips[2].cells
  for (let i = 0; i < 5; i++) damaged[third[i]] = (damaged[third[i]] + 7) % 64
  const survived = readHeader(damaged, null, layout)
  check('header survives 2 dead corners + 5 errors', survived.ok !== false, survived.reason ?? '')
  check('header still correct after damage', survived.profile === DEFAULT_PROFILE && survived.parity === N - K)

  // Six errors is past RS(15,4)'s five, so that corner must be refused rather
  // than trusted. With the fourth corner intact the header still reads.
  const heavy = cells.slice()
  for (const strip of layout.headerStrips.slice(0, 2)) {
    for (const raster of strip.cells) heavy[raster] = BLANK
  }
  for (let i = 0; i < 6; i++) heavy[third[i]] = (heavy[third[i]] + 11) % 64
  const stillOk = readHeader(heavy, null, layout)
  check('one over-damaged corner does not poison the vote', stillOk.ok !== false, stillOk.reason ?? '')

  // Everything gone must be reported, not guessed at.
  const blanked = cells.slice()
  for (const strip of layout.headerStrips) {
    for (const raster of strip.cells) blanked[raster] = BLANK
  }
  const gone = readHeader(blanked, null, layout)
  check('no header is an explicit failure', gone.ok === false, JSON.stringify(gone))

  // Garbage in every corner must not decode to a plausible header. This is the
  // mode-mismatch failure the self-describing format exists to remove.
  const rng = seeded(9)
  let falseAccepts = 0
  for (let trial = 0; trial < 400; trial++) {
    const noise = cells.slice()
    for (const strip of layout.headerStrips) {
      for (const raster of strip.cells) noise[raster] = Math.floor(rng() * 64)
    }
    if (readHeader(noise, null, layout).ok !== false) falseAccepts++
  }
  check(`random corners rarely read as a header (${falseAccepts}/400)`, falseAccepts <= 4, String(falseAccepts))
}

// ------------------------------------------------------------ variable parity

for (const parity of [8, 12, 16, 24]) {
  const rng = seeded(parity)
  const capacity = capacityFor(layout, parity)
  const payload = randomPayload(capacity.payloadBytes, rng)
  const { cells } = encodeFrame(payload, { parity })
  const header = readHeader(cells, null, layout)
  check(`parity ${parity} announced in the header`, header.parity === parity, String(header.parity))
  const out = decodeFrame(cells, null, { parity })
  check(`parity ${parity} round trips`, out.ok && payload.every((b, i) => b === out.payload[i]))
  check(
    `parity ${parity} costs payload`,
    capacity.payloadBytes < capacityFor(layout, parity - 4).payloadBytes,
  )
}

// -------------------------------------------------- channel simulation + A/B

// The channel model lives in degrade.js, so every test here draws the same errors.
const degrade = (cells, options) => injectSymbolErrors(cells, layout, options)

/**
 * The rates swept here are deliberately low. A frame needs all 216 codewords,
 * so frame yield is P(codeword decodes)^216 and the useful operating band sits
 * near a 2% symbol error rate - an order of magnitude below what "six
 * correctable errors in sixty-three symbols" suggests read on its own. Sweeping
 * 6-12% would only show both columns at zero, which is what the first version
 * of this test did.
 */
console.log('   error rate   plain    with erasures   rescued   (frames of 40)')
let erasureWins = 0
let erasureLosses = 0
let accepted = 0
let acceptedWrong = 0

for (const errorRate of [0.005, 0.01, 0.015, 0.02, 0.025, 0.03, 0.04]) {
  let plain = 0
  let flagged = 0
  let rescued = 0
  const trials = 40

  for (let trial = 0; trial < trials; trial++) {
    const rng = seeded(0xc1a0 + trial * 7919 + Math.round(errorRate * 1000))
    const payload = randomPayload(2048, rng)
    const { cells } = encodeFrame(payload)
    const channel = degrade(cells, { errorRate, rng })

    const withoutFlags = decodeFrame(channel.cells, channel.confidences, { useErasures: false })
    const withFlags = decodeFrame(channel.cells, channel.confidences, { useErasures: true })

    if (withoutFlags.ok && payload.every((b, i) => b === withoutFlags.payload[i])) plain++
    if (withFlags.ok && payload.every((b, i) => b === withFlags.payload[i])) flagged++
    rescued += withFlags.telemetry.codewordsRetried

    // Frame decode is a strong integrity signal but not a perfect one: an
    // over-limit codeword can miscorrect into a valid codeword, which the
    // syndrome recheck cannot see by definition. Measured here rather than
    // assumed away, and the reason nothing downstream trusts a frame on its
    // own - the fountain block carries its own checksum and the envelope
    // carries a SHA-256 over the whole file.
    if (withFlags.ok) {
      accepted++
      if (!payload.every((b, i) => b === withFlags.payload[i])) acceptedWrong++
    }
  }

  console.log(
    `   ${(errorRate * 100).toFixed(1).padStart(4)}%       ${String(plain).padStart(2)}/40      ${String(flagged).padStart(2)}/40` +
      `        ${String(rescued).padStart(5)}`,
  )
  if (flagged > plain) erasureWins++
  if (flagged < plain) erasureLosses++
}

// The claim under test: erasure flagging buys correctable positions somewhere
// in the operating range, and - because it is a retry pass rather than an
// unconditional one - never costs them.
check('erasure flagging wins somewhere in the range', erasureWins >= 1, `${erasureWins} win(s)`)
check('erasure flagging never loses a band', erasureLosses === 0, `${erasureLosses} loss(es)`)
check(
  `frame miscorrection stays rare (${acceptedWrong}/${accepted})`,
  accepted === 0 || acceptedWrong / accepted < 0.02,
  `${acceptedWrong}/${accepted}`,
)

// Pure erasures at known positions: the full 2x. Twelve flagged symbols per
// codeword must recover where six unflagged errors is already the limit.
{
  const rng = seeded(77)
  const payload = randomPayload(2048, rng)
  const { cells } = encodeFrame(payload)
  const damaged = cells.slice()
  const confidences = new Float32Array(cells.length).fill(1)

  // Exactly 12 corrupted symbols in every codeword, all flagged.
  for (let c = 0; c < layout.codewordCount; c++) {
    for (let sym = 0; sym < 12; sym++) {
      const raster = layout.dataCells[slotFor(layout, c, sym)]
      damaged[raster] = (damaged[raster] + 5) % 64
      confidences[raster] = 0
    }
  }
  const out = decodeFrame(damaged, confidences, { erasures: { budget: 12, floor: 0.35 } })
  check('12 flagged errors per codeword recover', out.ok && payload.every((b, i) => b === out.payload[i]), out.reason ?? '')

  // The same damage unflagged is twice the error budget and must fail.
  const unflagged = decodeFrame(damaged, null)
  check('12 unflagged errors per codeword do not', !unflagged.ok)
}

// A frame with one unrecoverable codeword is not whole, but it is not lost:
// every byte outside that codeword's run comes back exactly, and the run
// itself comes back as zeros rather than guesses, which is what lets the block
// CRCs one layer up drop only the blocks it touched.
{
  const rng = seeded(5)
  const payload = randomPayload(2048, rng)
  const { cells } = encodeFrame(payload)
  const damaged = cells.slice()
  for (let sym = 0; sym < 20; sym++) {
    const raster = layout.dataCells[slotFor(layout, 0, sym)]
    damaged[raster] = (damaged[raster] + 3) % 64
  }
  const out = decodeFrame(damaged, null)
  check('one dead codeword means the frame is not whole', !out.ok)
  check('failure names the codeword', out.telemetry.failed.includes(0))
  check('yield is reported', out.telemetry.yield > 0.99 && out.telemetry.yield < 1)
  // Codeword 0 owns bits [0, 306): bytes 0 to 37 whole, and byte 38's top two bits.
  check('the dead codeword comes back as zeros', out.payload.subarray(0, 38).every((b) => b === 0))
  check('every other byte comes back exactly', payload.subarray(39).every((b, i) => b === out.payload[39 + i]))
}

// ---------------------------------------------------------------- telemetry

{
  const rng = seeded(31)
  const { cells } = encodeFrame(randomPayload(2048, rng))
  const confidences = new Float32Array(cells.length).fill(1)

  // Weaken the bottom-right bucket, the way lens falloff and defocus do. The
  // region is expressed in bucket coordinates rather than as a fraction of the
  // panel, so a boundary row cannot end up on the wrong side of the divide and
  // turn an exact assertion into an approximate one.
  const grid = 8
  for (const raster of layout.dataCells) {
    const x = raster % layout.cols
    const y = Math.floor(raster / layout.cols)
    const bx = Math.min(grid - 1, Math.floor((x / layout.cols) * grid))
    const by = Math.min(grid - 1, Math.floor((y / layout.rows) * grid))
    if (bx === grid - 1 && by === grid - 1) confidences[raster] = 0.1
  }

  const { map, buckets } = spatialErrorMap(cells, confidences, layout)
  check('map is 8x8', buckets === 8 && map.length === 64)
  check('weak corner shows up', map[63] > 0.999, map[63].toFixed(3))
  check('healthy corner stays clean', map[0] < 0.05, map[0].toFixed(2))
}

console.log(failures ? `airblock-frame: ${failures} check(s) failed` : 'airblock-frame: header, interleave and erasure policy hold')
process.exitCode = failures ? 1 : 0
