/**
 * The outer code: turning a file into an endless stream of frame payloads.
 *
 * The camera cannot ask the screen to resend a particular frame - there is no
 * back channel for that once the loop starts, and the back channel that does
 * exist carries status, not requests. That single fact drives the design:
 *
 *   Luby-Transform coding, with dense random subsets for small files. Each block is an XOR of a random subset of the source
 *     blocks, and the stream never repeats itself. The receiver collects
 *     blocks until it can solve the system, by peeling and then elimination:
 *     0.2% more than the block count at 6,396 blocks, 3% at 33. A frame lost
 *     to glare, motion blur or a passing hand costs nothing at all.
 *
 * Plain chunks on a loop would make a missed frame cost a whole cycle; a
 * fountain never makes the receiver wait for any particular block.
 *
 * ## Framing: fixed-size blocks and nothing else
 *
 * A frame payload is `floor(capacity / blockBytes)` blocks laid end to end,
 * then zeros. There is no frame header, no block count and no length prefix:
 * all of it follows from the two sizes, so nothing at the head of a frame can
 * take the rest of the frame down with it. Every block checks itself:
 *
 *   0  4  seed - the block id; the fountain derives its index set from it
 *   4  4  codec in the top four bits, payload length in the other 28
 *   8  4  CRC-32 of the file, mixed with k: which transfer this block is from
 *   12 ..  slice
 *   -4 4  CRC-32 of everything before it
 *
 * The CRC is what lets a frame deliver part of itself. When a codeword fails
 * its Reed-Solomon decode the frame layer leaves zeros in its bytes, so every
 * block that touched it fails its CRC and is dropped, and every other block in
 * the frame still counts. It also catches the block a miscorrected codeword
 * would otherwise slip through - which, before this, only the SHA-256 at the
 * very end could see, after the whole transfer had been spent.
 *
 * The block size is fixed for a transfer, because the decoder keys on the
 * block count `k`, and it is the same on every rung so the back channel can
 * move rungs mid-transfer. BLOCK_BYTES below is chosen to fill all five: see
 * the table there.
 */

import { deflate, inflate } from '../lib/compress.js'
import { seeded } from '../lib/random.js'
import { detach, readU32, writeU32 } from '../lib/bytes.js'

/**
 * The block size every optical frame is cut into.
 *
 * The rung payloads are 2,065 / 3,442 / 5,622 / 8,682 / 13,043 bytes, and a
 * block size has to leave little of any of them over. Searched from 200 to
 * 1,400, only 344 and its double fill every rung, because 2,064 = 6 x 344 and
 * 3,440 = 10 x 344:
 *
 *    block    far    soft   normal  dense   max    k for 2 MB   LT overhead
 *    2,060   100%    60%    73%     95%    95%       1,028      1.176x
 *      344   99.9%  99.9%   97.9%   99.1%  97.6%     6,396      1.065x
 *
 * (2,060 is what the old smallest-rung rule gave; overhead measured with this
 * file's LT, 2 MB, 7 seeds.) Smaller blocks also mean a larger k, where LT is
 * measurably more efficient, and a failed codeword now costs one 344-byte
 * block instead of half a frame. Wave uses its own size: one sound message is
 * one block.
 */
export const BLOCK_BYTES = 344

/**
 * Seed, codec and length, file checksum, then the CRC trailer: sixteen bytes a
 * block, fixed whatever the block's degree. Fixed size is the point - the old
 * format spent four bytes per index, a block's size followed its degree, and
 * the bottom rung could only carry blocks of degree ten or less, which
 * truncated the soliton and left the fountain unable to cover k.
 */
const HEADER = 12
const TRAILER = 4
const OVERHEAD = HEADER + TRAILER

/**
 * Codec tags, in the top four bits of the length word. A tag this build does
 * not know is skipped, block by block.
 */
const TAG = { lt: 2 }
const TAG_NAME = { 2: 'lt' }
const LENGTH_MASK = 0x0fffffff

/**
 * Ceiling on the block count a frame may claim.
 *
 * `k` arrives from a camera. The consistency check in `accept` already pins it
 * against `bytes`, which bounds it near 2 million on its own - but the first
 * block to arrive sizes two arrays from it, so one miscorrected frame could
 * otherwise cost 30 MB and a visible stall before anything noticed. A million
 * is sixty times the largest transfer the file cap allows.
 */
const MAX_SOURCE_BLOCKS = 1_000_000

/** Payload bytes a block of `blockBytes` carries, after its header and CRC. */
function sliceOf(blockBytes) {
  const slice = blockBytes - OVERHEAD
  if (slice < 64) throw new Error(`A ${blockBytes} B block is too small to carry a slice`)
  return slice
}

/** How many whole blocks a frame of `capacity` bytes holds. */
export function blocksPerFrame(capacity, blockBytes) {
  return Math.floor(capacity / blockBytes)
}

/** Write a block's header and seal it with its CRC. */
function seal(block, seed, codec, length, checksum) {
  writeU32(block, 0, seed)
  writeU32(block, 4, ((TAG[codec] << 28) | (length & LENGTH_MASK)) >>> 0)
  writeU32(block, 8, checksum)
  const end = block.length - TRAILER
  writeU32(block, end, crc32(block.subarray(0, end), 0))
  return block
}

/** Blocks laid end to end into a frame payload of exactly `capacity` bytes. */
function frameOf(blocks, capacity) {
  const out = new Uint8Array(capacity)
  blocks.forEach((block, i) => out.set(block, i * block.length))
  return out
}

/**
 * The blocks in a frame payload whose CRC checks out, each a copy.
 *
 * Partial by design: a frame with failed codewords hands over zeros where they
 * were, those blocks fail here, and the rest are exactly as good as a block
 * from a perfect frame. Junk, a truncated frame, or a frame from an older
 * build simply yields fewer blocks, or none.
 */
export function unframe(bytes, blockBytes) {
  const blocks = []
  if (!bytes) return blocks
  for (let start = 0; start + blockBytes <= bytes.length; start += blockBytes) {
    const end = start + blockBytes - TRAILER
    if (crc32(bytes.subarray(start, end), 0) !== readU32(bytes, end)) continue
    if (!TAG_NAME[bytes[start + 4] >>> 4]) continue
    blocks.push(detach(bytes, start, start + blockBytes))
  }
  return blocks
}

/** Which codec and which transfer a block belongs to. */
export function blockInfo(block) {
  return { codec: TAG_NAME[block[4] >>> 4], checksum: readU32(block, 8) }
}

/** A block's header fields and a view of its slice. */
function readBlock(block) {
  return {
    seed: readU32(block, 0),
    length: readU32(block, 4) & LENGTH_MASK,
    checksum: readU32(block, 8),
    slice: block.subarray(HEADER, block.length - TRAILER),
  }
}

/**
 * Blocks the fountain needs, as a multiple of `k`, for estimates and bars.
 *
 * Measured with this file's decoder, peeling finished by elimination, 30%
 * of blocks dropped: median 1.002x at k = 6,396 (p90 1.007x, worst in 15
 * runs 1.032x), 1.003x at k = 1,028, 1.008x at k = 400, 1.016x at k = 128
 * and 1.03x at k = 33 (40 runs each). 1.02 leaves the bar short of done in
 * all but the unlucky runs. Wave's own figure is in config.js.
 *
 * A bar that jumps to done from 98% is fine; one that sits at 100% is what
 * people report as a hang.
 *
 * Anything reporting progress must divide by this rather than by `k`. `have
 * === k` is not done, and dividing by `k` is what pinned the receiver's bar at
 * 100% for the last quarter of every transfer - measured on a real run, the
 * bar read 100% at 866 blocks of 852 with 26 seconds still to run.
 */
export const FOUNTAIN_OVERHEAD = 1.02

// ---------------------------------------------------------------- fountain --

/**
 * Degrees come from a ROBUST soliton distribution, not the ideal one.
 *
 * The ideal soliton is the textbook distribution and it is a bad one to ship:
 * its expected ripple - the pool of degree-one blocks the peeling decoder eats
 * from - is exactly 1, so the decode stalls whenever that pool empties, which
 * is most of the time. Measured against the previous implementation at k=891,
 * one run in three needed past 1.5x the block count and the worst needed 3x.
 * The robust distribution adds a spike at k/R that keeps the ripple stocked,
 * and costs a few percent of mean degree to do it.
 *
 * `c` and `delta` are the two knobs, and they were swept rather than reasoned
 * about - the literature's range for `c` spans an order of magnitude and the
 * best value moves with the block count. Median blocks needed, as a multiple
 * of k, over 41 runs a cell:
 *
 *     c      k=33   k=201   k=873   k=4109
 *   0.03     1.394   1.219   1.112   1.061
 *   0.05     1.364   1.194   1.132   1.074
 *   0.10     1.424   1.269   1.178   1.112
 *   0.30     1.394   1.316   1.281   1.240
 *
 * delta was swept at 0.01, 0.05 and 0.5; 0.5 won at every k. c = 0.05 is best
 * at the small end and within 2% of best at the large one, so that is the
 * compromise taken. Re-sweep with `test/pipeline.mjs` if the slice size moves,
 * because the slice is what decides k.
 */
const ROBUST_C = 0.05
const ROBUST_DELTA = 0.5

/**
 * Cumulative degree distribution for a block count. Built once per transfer.
 *
 * Once per transfer matters: the previous implementation built two k-length
 * arrays inside every single draw, which at k=891 and thirty blocks a second
 * is 400 kB of garbage per second for a number it throws away.
 */
function solitonCdf(k) {
  const weights = new Float64Array(k + 1)
  weights[1] = 1 / k
  for (let d = 2; d <= k; d++) weights[d] = 1 / (d * (d - 1))

  // R is roughly the expected ripple size the spike is sized to maintain.
  const R = ROBUST_C * Math.log(k / ROBUST_DELTA) * Math.sqrt(k)
  const spike = Math.max(1, Math.min(k, Math.ceil(k / R)))
  for (let d = 1; d < spike; d++) weights[d] += R / (d * k)
  weights[spike] += (R * Math.log(R / ROBUST_DELTA)) / k

  /**
   * Clamped before it is normalised, because the spike term goes negative.
   *
   * `R * ln(R / delta)` is negative whenever R < delta, which happens below
   * k ~= 12. It never outweighs the density it is added to at any k tested, so
   * this changes no number - but `k` is read off a frame the camera decoded,
   * and a single negative weight would make the cumulative array non-monotonic
   * and the binary search below return nonsense. One line, at the only place
   * in this file where a decoded value shapes a computation.
   */
  let total = 0
  for (let d = 1; d <= k; d++) {
    if (weights[d] < 0) weights[d] = 0
    total += weights[d]
  }
  let running = 0
  for (let d = 1; d <= k; d++) {
    running += weights[d] / total
    weights[d] = running
  }
  // Guard the last entry against float drift, so a draw of 0.9999... lands.
  weights[k] = 1
  return weights
}

/**
 * A seeded generator is the whole reason a block no longer carries its indices.
 *
 * Both ends derive the same index set from the same 32-bit seed, so a block's
 * header is a fixed sixteen bytes however many source blocks it mixes in. That
 * is not a saving, it is the fix for a real bug: the old format spent four
 * bytes per index, so a frame could only carry a block whose degree fitted the
 * room left over - on the bottom rung, exactly ten. Every fatter block was
 * discarded and redrawn, which truncated the distribution at degree 10 and
 * left the fountain unable to cover k. Measured at k=891 on that rung: 2.6x
 * the block count needed, against 1.3x everywhere else, and 11 KB/s against
 * a possible 135.
 *
 * Seeds are handed out consecutively, so the generator must turn a +1 into an
 * unrelated stream; `seeded` in random.js is built and measured for exactly
 * that.
 */

/**
 * Transfers of at most this many blocks use dense index sets instead.
 *
 * Every source block goes into a block with probability one half. Solved by
 * elimination, such a code needs about one block over k and four at the 90th
 * percentile at any size, where LT's sparse sets leave some source block
 * uncovered at small k: 30 runs a cell, extra blocks median / p90 / worst,
 *
 *              k=33      k=64      k=128      k=256      k=512
 *   LT        4/11/19   3/14/34   4/11/47    3/9/11     3/10/11
 *   dense     1/3/4     1/4/6     1/4/5      1/4/6      1/4/6
 *
 * Dense costs k/2 slice XORs a block on both ends, which is nothing at Wave's
 * sizes and small files on Air, and grows with k, so LT takes over above 256.
 */
const DENSE_MAX = 256

/** The source blocks a seed mixes together. Both ends run this identically. */
function indicesFor(seed, k, cdf) {
  const random = seeded(seed)
  if (k <= DENSE_MAX) {
    const indices = new Set()
    for (let i = 0; i < k; i++) if (random() < 0.5) indices.add(i)
    if (!indices.size) indices.add(Math.floor(random() * k))
    return indices
  }

  // Binary search the cumulative distribution.
  const draw = random()
  let lo = 1
  let hi = k
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (cdf[mid] < draw) lo = mid + 1
    else hi = mid
  }

  const indices = new Set()
  while (indices.size < lo) indices.add(Math.floor(random() * k))
  return indices
}

/**
 * CRC-32 of the file, mixed with the block count.
 *
 * Not the integrity check - that is the SHA-256 inside the envelope, and it is
 * checked in the verify state. This one's job is to tell two transfers apart:
 * blocks from a different file with the same block count are structurally
 * indistinguishable, and feeding them to one decoder completes it with
 * nonsense. The frame header's transfer tag is eight bits of the same idea;
 * these are thirty-two more, for four bytes a block.
 */
const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let crc = i
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    table[i] = crc >>> 0
  }
  return table
})()

export function crc32(bytes, mix) {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]) & 0xff]
  return (crc ^ mix ^ 0xffffffff) >>> 0
}

/** XOR `source` into `target`, four bytes at a time where both line up. */
function xorInto(target, source) {
  const n = target.length
  if ((n & 3) === 0 && (target.byteOffset & 3) === 0 && (source.byteOffset & 3) === 0) {
    const to = new Int32Array(target.buffer, target.byteOffset, n >> 2)
    const from = new Int32Array(source.buffer, source.byteOffset, n >> 2)
    for (let i = 0; i < to.length; i++) to[i] ^= from[i]
  } else {
    for (let i = 0; i < n; i++) target[i] ^= source[i]
  }
}

/** Blocks for one frame, or an error when not even one fits. */
function countFor(capacity, blockBytes) {
  const count = blocksPerFrame(capacity, blockBytes)
  if (count < 1) throw new Error(`A ${capacity} B frame is too small to carry a ${blockBytes} B block`)
  return count
}

async function fountainEncoder(data, blockBytes) {
  const sliceBytes = sliceOf(blockBytes)
  const compressed = await deflate(data)
  const k = Math.max(1, Math.ceil(compressed.length / sliceBytes))
  const checksum = crc32(data, k)
  const cdf = solitonCdf(k)

  // Consecutive from a random start: no repeats within a transfer, so the
  // receiver's de-duplication is a Set of integers rather than a hash of an
  // index list, and a restarted sender does not replay the same stream.
  let seed = (Math.random() * 0x100000000) >>> 0
  let emitted = 0

  const build = () => {
    const block = new Uint8Array(blockBytes)
    const payload = block.subarray(HEADER, HEADER + sliceBytes)
    // XORed straight out of the compressed bytes, so nothing holds a second
    // padded copy of the file. The tail slice is short and the rest of the
    // payload stays zero, which is the padding.
    for (const index of indicesFor(seed, k, cdf)) {
      const start = index * sliceBytes
      const span = Math.min(sliceBytes, compressed.length - start)
      for (let i = 0; i < span; i++) payload[i] ^= compressed[start + i]
    }
    seal(block, seed, 'lt', compressed.length, checksum)
    seed = (seed + 1) >>> 0
    emitted++
    return block
  }

  return {
    codec: 'lt',
    blocks: k,
    blockBytes,
    checksum,
    get emitted() {
      return emitted
    },
    /** Fill the frame: as many whole blocks as fit, then zeros. */
    next(capacity) {
      const blocks = []
      for (let i = countFor(capacity, blockBytes); i > 0; i--) blocks.push(build())
      return frameOf(blocks, capacity)
    },
  }
}

/**
 * A peeling decoder, holding one copy of each block, finished by elimination.
 *
 * The decoder this replaced is where the file size cap came from. It indexed
 * its pending blocks by a string join of their index list, and kept one such
 * string per SUBSET of every block's indices -
 * so a degree-d block cost d strings of about 7d characters, and the ideal
 * soliton's degree tail put the expected cost per block at O(k). Times O(k)
 * blocks, that is the quadratic heap the cap was measured against: 378 MB for
 * a 2 MB file, 1.2 GB for 5 MB.
 *
 * Here a block is its index Set and its slice, and an index carries the set of
 * blocks still waiting on it. Peak heap is the file plus the blocks not yet
 * peeled, and briefly a copy of those while elimination runs - linear, about
 * 3x the payload at the very end.
 */
function fountainDecoder() {
  /** Set once by the first block that arrives; every later one must match. */
  let meta = null
  let cdf = null
  /** solved[i] is source block i, or null. */
  let solved = null
  let solvedCount = 0
  let received = 0
  /** `received` at the last elimination attempt. */
  let tried = 0
  const seen = new Set()
  /** source index -> the pending blocks that still mix it in. */
  const waiting = new Map()

  const register = (entry) => {
    for (const index of entry.indices) {
      const set = waiting.get(index)
      if (set) set.add(entry)
      else waiting.set(index, new Set([entry]))
    }
  }

  /** Solve one source block and cascade into everything that was waiting. */
  const peel = (index, data) => {
    const queue = [[index, data]]
    while (queue.length) {
      const [at, value] = queue.pop()
      if (solved[at]) continue
      solved[at] = value
      solvedCount++

      const blocked = waiting.get(at)
      if (!blocked) continue
      waiting.delete(at)
      for (const entry of blocked) {
        if (!entry.indices.has(at)) continue
        xorInto(entry.data, value)
        entry.indices.delete(at)
        if (entry.indices.size !== 1) continue
        const last = entry.indices.values().next().value
        entry.indices.clear()
        waiting.get(last)?.delete(entry)
        if (!solved[last]) queue.push([last, entry.data])
      }
    }
  }

  /**
   * Finish a stalled decode by elimination, once there are enough blocks.
   *
   * Peeling alone needs 1.05x to 1.07x of k on Air, because the robust
   * soliton keeps it going only with blocks to spare. Every pending block is
   * still one linear equation over the unsolved source blocks, though, and at
   * k plus a handful the system is almost always solvable. Solving it densely
   * is cubic in k; instead this peels on, and whenever peeling stalls it
   * "inactivates" one source block from the smallest pending equation: treats
   * it as a variable, carried along as one bit in every equation it touches,
   * which lets peeling restart. At the end the equations left over constrain
   * only the inactivated blocks, a small dense system solved by Gauss-Jordan
   * elimination. A few hundred inactivations at k = 6,396.
   *
   * Two passes: the first on the bits alone, to see whether the system is
   * solvable yet, the second with the slices, only when it is. The solved
   * inactivated blocks then go to `peel`, and the ordinary cascade finishes
   * everything else.
   */
  const eliminate = () => {
    const entries = new Set()
    for (const set of waiting.values()) for (const entry of set) entries.add(entry)
    const eqs = [...entries]
    const count = eqs.length
    const eqsOf = new Map()
    const degree = new Int32Array(count)
    const lastOf = new Int32Array(count) // XOR of the unsolved indices left in each equation
    eqs.forEach((entry, i) => {
      degree[i] = entry.indices.size
      for (const index of entry.indices) {
        lastOf[i] ^= index
        const list = eqsOf.get(index)
        if (list) list.push(i)
        else eqsOf.set(index, [i])
      }
    })
    // An unsolved block in no pending equation cannot be found yet.
    if (eqsOf.size !== meta.k - solvedCount) return false

    const run = (withData) => {
      const deg = degree.slice()
      const last = lastOf.slice()
      const used = new Uint8Array(count)
      const done = new Set()
      const data = withData ? eqs.map((entry) => entry.data.slice()) : null
      let width = 1
      let bits = Array.from({ length: count }, () => new Uint32Array(width))
      const inactive = []
      const ones = []
      for (let i = 0; i < count; i++) if (deg[i] === 1) ones.push(i)

      const resolve = (index, pivot) => {
        const column = pivot < 0 ? inactive.length - 1 : -1
        for (const i of eqsOf.get(index)) {
          if (used[i]) continue
          deg[i]--
          last[i] ^= index
          if (pivot >= 0) {
            const a = bits[i]
            const b = bits[pivot]
            for (let w = 0; w < width; w++) a[w] ^= b[w]
            if (data) xorInto(data[i], data[pivot])
          } else bits[i][column >> 5] ^= 1 << (column & 31)
          if (deg[i] === 1) ones.push(i)
        }
      }

      let remaining = eqsOf.size
      while (remaining) {
        while (ones.length) {
          const i = ones.pop()
          if (used[i] || deg[i] !== 1) continue
          const index = last[i]
          used[i] = 1
          done.add(index)
          remaining--
          resolve(index, i)
        }
        if (!remaining) break

        let smallest = -1
        for (let i = 0; i < count; i++) {
          if (used[i] || deg[i] < 2 || (smallest >= 0 && deg[i] >= deg[smallest])) continue
          smallest = i
          if (deg[i] === 2) break
        }
        if (smallest < 0) return null
        let index = -1
        for (const candidate of eqs[smallest].indices) {
          if (!done.has(candidate)) {
            index = candidate
            break
          }
        }
        inactive.push(index)
        if (inactive.length > width * 32) {
          width *= 2
          bits = bits.map((row) => {
            const wider = new Uint32Array(width)
            wider.set(row)
            return wider
          })
        }
        done.add(index)
        remaining--
        resolve(index, -1)
      }

      // What is left constrains the inactivated blocks alone: Gauss-Jordan.
      const rows = []
      for (let i = 0; i < count; i++) if (!used[i]) rows.push(i)
      const pivotFor = []
      for (let column = 0, top = 0; column < inactive.length; column++, top++) {
        const w = column >> 5
        const bit = 1 << (column & 31)
        let found = -1
        for (let r = top; r < rows.length; r++) {
          if (bits[rows[r]][w] & bit) {
            found = r
            break
          }
        }
        if (found < 0) return null
        ;[rows[top], rows[found]] = [rows[found], rows[top]]
        const pivot = rows[top]
        for (let r = 0; r < rows.length; r++) {
          const row = rows[r]
          if (r === top || !(bits[row][w] & bit)) continue
          for (let x = 0; x < width; x++) bits[row][x] ^= bits[pivot][x]
          if (data) xorInto(data[row], data[pivot])
        }
        pivotFor.push(pivot)
      }
      return inactive.map((index, column) => [index, data?.[pivotFor[column]]])
    }

    if (!run(false)) return false
    for (const [index, value] of run(true)) peel(index, value)
    return solvedCount === meta.k
  }

  return {
    codec: 'lt',
    accept(block) {
      const { seed, length: bytes, checksum, slice } = readBlock(block)
      const sliceBytes = slice.length

      /**
       * Bounded before anything is allocated. The block's CRC already
       * vouches for these fields, but the first block sizes two arrays from
       * them, so a length that asks for absurd memory is refused outright.
       */
      const k = Math.ceil(bytes / sliceBytes)
      if (bytes < 1 || k > MAX_SOURCE_BLOCKS) return { ok: false }

      if (!meta) {
        meta = { k, bytes, checksum, sliceBytes }
        cdf = solitonCdf(k)
        solved = new Array(k).fill(null)
      } else if (
        k !== meta.k ||
        bytes !== meta.bytes ||
        checksum !== meta.checksum ||
        sliceBytes !== meta.sliceBytes
      ) {
        // Another transfer, or a miscorrection. Either way not ours.
        return { ok: false }
      }

      if (seen.has(seed)) return { ok: true, duplicate: true }
      seen.add(seed)
      received++

      // A copy rather than the view: the slice is XORed in place from here on.
      const data = slice.slice()
      const indices = indicesFor(seed, meta.k, cdf)

      for (const index of indices) {
        if (!solved[index]) continue
        xorInto(data, solved[index])
        indices.delete(index)
      }

      if (indices.size > 1) register({ indices, data })
      else if (indices.size === 1) peel(indices.values().next().value, data)

      /**
       * Elimination from k plus 0.2%, where it starts to succeed, then again
       * every half a percent of k, until it does or peeling gets there first.
       * An attempt that fails costs only the bit pass: 20 ms at k = 6,405 in
       * Node, 0.6 s at 20 MiB's 63,958. The one that succeeds costs about five
       * times that, once, at the end of the transfer.
       */
      const start = meta.k + Math.ceil(meta.k / 500)
      if (solvedCount < meta.k && received >= start && received - tried >= Math.ceil(meta.k / 200)) {
        tried = received
        eliminate()
      }
      return { ok: true, done: solvedCount === meta.k }
    },

    /**
     * Progress is reported as blocks *collected*, not blocks *solved*.
     *
     * A peeling decoder cannot start until a degree-one block turns up, and it
     * then advances in bursts as each one unblocks a cascade. The robust
     * soliton keeps that pool stocked far better than the ideal one did, but
     * the count still moves in steps, so the smooth, monotonic number is the
     * one the bar follows. `solved` is reported for the diagnostics panel.
     *
     * Whatever reads this must divide by FOUNTAIN_OVERHEAD, not by `need`.
     */
    progress() {
      return { have: received, need: meta?.k ?? 0, solved: solvedCount }
    },

    /**
     * The file, or null if it is not all here yet.
     *
     * Throws when every block is solved and the result is still wrong, which
     * means a block was miscorrected in a way that survived every check above.
     * The caller turns that into a user-facing failure - see reassembler.
     */
    async result() {
      if (!meta || solvedCount !== meta.k) return null

      const joined = new Uint8Array(meta.bytes)
      for (let i = 0; i < meta.k; i++) {
        const start = i * meta.sliceBytes
        joined.set(solved[i].subarray(0, Math.min(meta.sliceBytes, meta.bytes - start)), start)
      }

      const out = await inflate(joined)
      if (crc32(out, meta.k) !== meta.checksum) {
        throw new Error('The reassembled blocks failed their internal checksum.')
      }
      return out
    },
  }
}


// ------------------------------------------------------------------ public --

/**
 * Async because the fountain deflates the envelope first, with the platform's
 * CompressionStream.
 *
 * @param {Uint8Array} data the envelope to send
 * @param {number} blockBytes BLOCK_BYTES for the optical frames, the message
 *   size for Wave
 */
export async function createFrameEncoder(data, blockBytes) {
  return fountainEncoder(data, blockBytes)
}

/** A fountain decoder; its `result()` may return a promise. */
export function createFrameDecoder() {
  return fountainDecoder()
}
