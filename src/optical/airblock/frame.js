/**
 * One frame: bytes in, 6-bit cell values out, and back again.
 *
 * This is the layer that never sees a pixel. It takes a payload, produces the
 * value every cell on the panel should display, and on the way back takes cell
 * values plus per-cell confidences and produces the payload. Rendering and
 * sampling live elsewhere entirely, which is what lets the error correction,
 * the interleave, the header and the erasure policy all be tested in Node with
 * injected faults and no camera.
 *
 * ## The self-describing header
 *
 * A format that does not carry its own ecc level, colour count and symbol count
 * in the image leaves the decoder to be told them, and a mismatch is a live
 * cause of total failure with no diagnostic. Twenty-four bits in each of the
 * four corners fixes that. It is RS(15,4), so eleven parity symbols guard four
 * of payload, which is a wildly generous rate and deliberately so: the header
 * is read *before* drift refinement has any high-confidence cells to propagate
 * from, so it is decoded under the worst sampling conditions of the frame.
 *
 * ## The erasure policy
 *
 * This is the one place that turns a confidence into a decision, and the
 * obvious implementation is wrong. RS has to solve for every flagged position
 * whether or not it was actually wrong, so a harmless flag consumes budget
 * exactly like a real error. Flag twelve cells in a codeword that had four
 * ordinary errors and a comfortably correctable codeword becomes a lost one.
 * Measured: flagging unconditionally *lost* frames at a 2% symbol error rate,
 * where nothing needed help in the first place.
 *
 * So the flags are spent only where they are needed. Every codeword is decoded
 * plain first; erasures are a second attempt for the ones that failed. A clean
 * codeword costs one syndrome computation and exits, so the retry is nearly
 * free, and the policy becomes strictly non-negative: it cannot lose a frame it
 * would otherwise have had.
 *
 * Two guards remain on the retry itself: a confidence floor, and a cap below
 * the parity count so unflagged errors still have room inside 2e + E <= n-k.
 *
 * ## Why the error budget is tighter than it looks
 *
 * A frame is all-or-nothing across every codeword - 216 of them on the default
 * profile - because a single hole in the payload leaves nothing the fountain
 * decoder can use. Frame yield is therefore P(codeword decodes)^216, so a
 * useful frame rate needs a per-codeword failure probability under about
 * 1/216. With six correctable errors that means a mean near 1.5 errors per
 * codeword, or roughly a 2% symbol error rate - not the ~10% that "six of
 * sixty-three" suggests when read on its own.
 */

import { N, K, encode as rsEncode, decode as rsDecode } from './rs64.js'
import {
  layoutFor,
  slotFor,
  HEADER_N,
  HEADER_K,
  profileIndex,
  PROFILES,
  DEFAULT_PROFILE,
} from './grid.js'
import { COLOUR_BITS } from './palette.js'
import { SYMBOL_COUNT } from './symbols.js'

/**
 * Format version. Bumped only for a change that breaks decode.
 *
 * 2: the payload is fixed 344-byte blocks with their own CRC and no frame
 * header (fountain.js), and the interleave runs within quadrants (grid.js). A
 * version-1 receiver rejects this header and falls back to its local parity
 * and its own full-panel interleave, so every codeword fails RS and a mixed
 * pair delivers nothing rather than wrong bytes.
 *
 * 3: the interleave's shuffle, the fountain's index sets and the glyph set
 * all come from the app's own generator (random.js), so a version-2 build
 * would draw other glyphs, place symbols elsewhere and mix other blocks. Same
 * refusal, same result.
 */
export const FORMAT_VERSION = 3

/** Cell value meaning "paint nothing here". */
export const BLANK = 0xff

/**
 * Default erasure policy, applied on the retry pass only.
 *
 * `budget` is 8 rather than the full 12 parity symbols so that two unflagged
 * errors still fit inside `2e + E <= 12` after the budget is spent. `floor` is
 * the confidence below which a cell is worth flagging at all. Both want
 * tuning against real telemetry rather than reasoning - they are the knobs the
 * Step 0 harness exists to turn.
 */
export const ERASURE = { budget: 8, floor: 0.35 }

/** Data symbols and payload capacity at a given parity. */
export function capacityFor(layout, parity = N - K) {
  const k = N - parity
  if (k < 1 || parity < 1) throw new Error(`Implausible parity: ${parity}`)
  const dataSymbols = layout.codewordCount * k
  return { k, parity, dataSymbols, payloadBytes: Math.floor((dataSymbols * 6) / 8) }
}

// --------------------------------------------------------------- bit packing

/** Bytes -> 6-bit symbols, MSB first, zero-padded to `count`. */
function bytesToSymbols(bytes, count) {
  const out = new Uint8Array(count)
  for (let i = 0; i < count; i++) {
    const bit = i * 6
    let value = 0
    for (let b = 0; b < 6; b++) {
      const j = bit + b
      const byte = j >> 3
      const shift = 7 - (j & 7)
      value = (value << 1) | (byte < bytes.length ? (bytes[byte] >> shift) & 1 : 0)
    }
    out[i] = value
  }
  return out
}

/** 6-bit symbols -> bytes. Inverse of bytesToSymbols. */
function symbolsToBytes(symbols, byteCount) {
  const out = new Uint8Array(byteCount)
  for (let i = 0; i < symbols.length; i++) {
    const value = symbols[i]
    for (let b = 0; b < 6; b++) {
      const j = i * 6 + b
      const byte = j >> 3
      if (byte >= byteCount) return out
      if ((value >> (5 - b)) & 1) out[byte] |= 1 << (7 - (j & 7))
    }
  }
  return out
}

// -------------------------------------------------------------------- header

/**
 * Header fields, packed MSB-first into 24 bits:
 *
 *   23..20  format version
 *   19..16  grid profile index
 *   15..13  symbol bits  (log2 of the symbol count, so 4 today)
 *   12..11  colour bits
 *   10..5   parity symbols per codeword
 *    4..0   reserved, must be zero
 *
 * Symbol bits gets three, not two: the current set is 16 symbols, so the field
 * holds the value 4, and two bits would truncate it to zero. Three bits also
 * leaves room for a 32-symbol set.
 */
function packHeader({ profile, parity }) {
  const symbolBits = Math.log2(SYMBOL_COUNT)
  const bits =
    ((FORMAT_VERSION & 0xf) << 20) |
    ((profileIndex(profile) & 0xf) << 16) |
    ((symbolBits & 7) << 13) |
    ((COLOUR_BITS & 3) << 11) |
    ((parity & 0x3f) << 5)

  return Uint8Array.from([
    (bits >> 18) & 0x3f,
    (bits >> 12) & 0x3f,
    (bits >> 6) & 0x3f,
    bits & 0x3f,
  ])
}

function unpackHeader(symbols) {
  const bits =
    (symbols[0] << 18) | (symbols[1] << 12) | (symbols[2] << 6) | symbols[3]

  const version = (bits >> 20) & 0xf
  const index = (bits >> 16) & 0xf
  const symbolBits = (bits >> 13) & 7
  const colourBits = (bits >> 11) & 3
  const parity = (bits >> 5) & 0x3f
  const reserved = bits & 0x1f

  if (version !== FORMAT_VERSION) return { ok: false, reason: `unknown format version ${version}` }
  if (reserved !== 0) return { ok: false, reason: 'reserved header bits are not zero' }
  if (!PROFILES[index]) return { ok: false, reason: `unknown grid profile index ${index}` }
  if (symbolBits !== Math.log2(SYMBOL_COUNT)) {
    return { ok: false, reason: `sender used ${1 << symbolBits} symbols, we expect ${SYMBOL_COUNT}` }
  }
  if (colourBits !== COLOUR_BITS) {
    return { ok: false, reason: `sender used ${1 << colourBits} colours, we expect ${1 << COLOUR_BITS}` }
  }
  if (parity < 1 || parity >= N) return { ok: false, reason: `implausible parity ${parity}` }

  return { ok: true, version, profile: PROFILES[index].id, symbolBits, colourBits, parity }
}

/**
 * Recover the header from up to four corner copies.
 *
 * Each copy is decoded independently and the results are voted on. A single
 * RS(15,4) success is already near-certain - eleven parity symbols make a
 * miscorrection that still satisfies the syndromes very unlikely - but a corner
 * lying under a specular highlight can fail entirely, and voting means three
 * good corners outrank one destroyed one at no extra cost.
 */
export function readHeader(cells, confidences, layout) {
  const votes = new Map()
  let attempted = 0
  let decoded = 0

  for (const strip of layout.headerStrips) {
    attempted++
    const received = new Uint8Array(HEADER_N)
    const erasures = []
    let missing = false

    for (let i = 0; i < HEADER_N; i++) {
      const value = cells[strip.cells[i]]
      if (value === BLANK || value === undefined) {
        missing = true
        break
      }
      received[i] = value & 0x3f
      if (confidences && confidences[strip.cells[i]] < ERASURE.floor) erasures.push(i)
    }
    if (missing) continue

    // The header's parity budget is large enough to spend generously here.
    const trimmed = erasures.slice(0, HEADER_N - HEADER_K)
    const outcome = rsDecode(received, trimmed, HEADER_N, HEADER_K)
    if (!outcome.ok) continue

    const fields = unpackHeader(outcome.codeword.subarray(0, HEADER_K))
    if (!fields.ok) continue

    decoded++
    const key = `${fields.profile}/${fields.parity}`
    const entry = votes.get(key) ?? { fields, count: 0 }
    entry.count++
    votes.set(key, entry)
  }

  if (!votes.size) {
    return { ok: false, reason: 'no corner header decoded', attempted, decoded }
  }

  let winner = null
  for (const entry of votes.values()) {
    if (!winner || entry.count > winner.count) winner = entry
  }
  return { ...winner.fields, corners: { attempted, decoded, agreed: winner.count } }
}

// ------------------------------------------------------------------- encode

/**
 * Lay a payload out across the panel.
 *
 * @param {Uint8Array} payload at most `capacityFor(layout, parity).payloadBytes`
 * @param {object} [options]
 * @returns {{cells: Uint8Array, capacity: object}} cells is indexed by raster
 *   position; entries at anchor positions and past the last whole codeword are
 *   BLANK, and the renderer is expected to consult `layout.role` regardless.
 */
export function encodeFrame(payload, { profile = DEFAULT_PROFILE, parity = N - K } = {}) {
  const layout = layoutFor(profile)
  const capacity = capacityFor(layout, parity)

  if (payload.length > capacity.payloadBytes) {
    throw new Error(
      `Payload of ${payload.length} B exceeds the ${capacity.payloadBytes} B this frame holds`,
    )
  }

  const cells = new Uint8Array(layout.cols * layout.rows).fill(BLANK)

  // Header, identically in all four corners.
  const header = rsEncode(packHeader({ profile, parity }), HEADER_N, HEADER_K)
  for (const strip of layout.headerStrips) {
    for (let i = 0; i < HEADER_N; i++) cells[strip.cells[i]] = header[i]
  }

  // Payload -> symbols -> codewords -> interleaved data slots.
  const symbols = bytesToSymbols(payload, capacity.dataSymbols)
  const { codewordCount } = layout

  for (let c = 0; c < codewordCount; c++) {
    const message = symbols.subarray(c * capacity.k, (c + 1) * capacity.k)
    const codeword = rsEncode(message, N, capacity.k)
    for (let s = 0; s < N; s++) {
      cells[layout.dataCells[slotFor(layout, c, s)]] = codeword[s]
    }
  }

  return { cells, capacity, layout }
}

// ------------------------------------------------------------------- decode

/**
 * Recover a payload from sampled cell values.
 *
 * @param {Uint8Array} cells raster-indexed 6-bit values, BLANK where unread
 * @param {Float32Array|null} confidences raster-indexed 0..1, or null to
 *   decode without erasure flagging (the A/B control for Step 3)
 * @param {object} [options]
 * @returns {{ok: boolean, payload?: Uint8Array, telemetry: object}}
 */
export function decodeFrame(cells, confidences, options = {}) {
  const {
    profile = DEFAULT_PROFILE,
    parity = N - K,
    erasures: policy = ERASURE,
    useErasures = true,
  } = options

  const layout = layoutFor(profile)
  const capacity = capacityFor(layout, parity)
  const { codewordCount } = layout

  const symbols = new Uint8Array(capacity.dataSymbols)
  const telemetry = {
    codewordsAttempted: codewordCount,
    codewordsDecoded: 0,
    /** Codewords that failed plain and were rescued by erasure flags. */
    codewordsRetried: 0,
    symbolErrors: 0,
    erasuresUsed: 0,
    erasuresFlagged: 0,
    /** Codewords that failed, by index - the spatial BER map is built from these. */
    failed: [],
  }

  const received = new Uint8Array(N)
  const slotConfidence = new Float32Array(N)

  for (let c = 0; c < codewordCount; c++) {
    for (let s = 0; s < N; s++) {
      const raster = layout.dataCells[slotFor(layout, c, s)]
      const value = cells[raster]
      // An unread cell is the strongest possible erasure candidate: confidence
      // zero rather than a guessed value, so the flag selection below picks it
      // ahead of anything merely doubtful.
      received[s] = value === BLANK ? 0 : value & 0x3f
      slotConfidence[s] = value === BLANK ? 0 : confidences ? confidences[raster] : 1
    }

    // First pass, no flags. Most codewords land here, and a clean one costs
    // only its syndromes before returning.
    let outcome = rsDecode(received, [], N, capacity.k)

    // Second pass, flags spent, only for the ones that actually failed. This
    // ordering is what makes erasure flagging strictly non-negative.
    if (!outcome.ok && useErasures && confidences) {
      const candidates = []
      for (let s = 0; s < N; s++) {
        if (slotConfidence[s] < policy.floor) candidates.push(s)
      }
      if (candidates.length) {
        telemetry.erasuresFlagged += candidates.length
        candidates.sort((a, b) => slotConfidence[a] - slotConfidence[b])
        const flags = candidates.slice(0, Math.min(policy.budget, parity))
        const retry = rsDecode(received, flags, N, capacity.k)
        if (retry.ok) {
          outcome = retry
          telemetry.codewordsRetried++
        }
      }
    }

    if (outcome.ok) {
      telemetry.codewordsDecoded++
      telemetry.symbolErrors += outcome.errors
      telemetry.erasuresUsed += outcome.erasures
      symbols.set(outcome.codeword.subarray(0, capacity.k), c * capacity.k)
    } else {
      telemetry.failed.push(c)
    }
  }

  telemetry.yield = telemetry.codewordsDecoded / codewordCount

  // The payload goes back whether or not every codeword decoded. A failed
  // codeword leaves zeros in its bytes, and the fountain's blocks each carry a
  // CRC, so the blocks it touched are dropped one layer up and every other
  // block in the frame still counts. `ok` still means the whole frame decoded.
  const ok = telemetry.codewordsDecoded === codewordCount
  return {
    ok,
    payload: symbolsToBytes(symbols, capacity.payloadBytes),
    telemetry,
    capacity,
    reason: ok ? undefined : `${telemetry.failed.length} codeword(s) unrecoverable`,
  }
}

/**
 * An 8x8 map of codeword failure rate across the panel.
 *
 * Codewords are interleaved, so a failed codeword is not a place - it is
 * spread over the whole panel. What localises a fault is where its *symbols*
 * were, which is why this is built from cell positions rather than codeword
 * indices. A camera problem shows up here as a corner or an edge; a decoder
 * problem shows up as uniform noise.
 */
export function spatialErrorMap(cells, confidences, layout, buckets = 8) {
  const total = new Int32Array(buckets * buckets)
  const weak = new Int32Array(buckets * buckets)

  for (let i = 0; i < layout.dataCells.length; i++) {
    const raster = layout.dataCells[i]
    const x = raster % layout.cols
    const y = Math.floor(raster / layout.cols)
    const bucket =
      Math.min(buckets - 1, Math.floor((y / layout.rows) * buckets)) * buckets +
      Math.min(buckets - 1, Math.floor((x / layout.cols) * buckets))

    total[bucket]++
    if (cells[raster] === BLANK || (confidences && confidences[raster] < ERASURE.floor)) {
      weak[bucket]++
    }
  }

  const map = new Float32Array(buckets * buckets)
  for (let i = 0; i < map.length; i++) map[i] = total[i] ? weak[i] / total[i] : 0
  return { map, buckets }
}
