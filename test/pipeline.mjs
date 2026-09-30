/**
 * A whole file through the fountain layer, with frames going missing.
 *
 * This is the outer code in isolation: the envelope, the framing, the fountain
 * and the reassembler. The optical layer is not involved -
 * `airblock-optics.mjs` covers that, and mixing the two would make it impossible
 * to tell a coding bug from a classifier one.
 *
 * A frame on the default rung carries sixteen 344-byte blocks, each with its own
 * CRC, so a frame can deliver part of itself.
 */

import {
  createFrameEncoder,
  unframe,
  blocksPerFrame,
  BLOCK_BYTES,
} from '../src/optical/fountain.js'
import { createReassembler } from '../src/optical/reassembler.js'
import { seeded } from '../src/lib/random.js'
import { wrapFile } from '../src/lib/envelope.js'
import { sha256Hex, shortDigest } from '../src/lib/bytes.js'
import { layoutFor, slotFor, DEFAULT_PROFILE, LADDER } from '../src/optical/airblock/grid.js'
import { capacityFor, encodeFrame, decodeFrame } from '../src/optical/airblock/frame.js'

const layout = layoutFor(DEFAULT_PROFILE)
const FRAME_CAPACITY = capacityFor(layout).payloadBytes

async function run({ codec, blockBytes, dropRate, label, withOffer = true, fileBytes = 400_000 }) {
  // Mixed content: compressible text plus incompressible noise, like a real file.
  const text = new TextEncoder().encode('AirBeam test payload. '.repeat(2000))
  const noise = new Uint8Array(Math.max(0, fileBytes - text.length))
  for (let i = 0; i < noise.length; i += 65536) {
    crypto.getRandomValues(noise.subarray(i, Math.min(i + 65536, noise.length)))
  }
  const original = new Uint8Array(text.length + noise.length)
  original.set(text, 0)
  original.set(noise, text.length)

  const digest = await sha256Hex(original)
  const envelope = wrapFile({
    name: 'holiday photo.jpg',
    type: 'image/jpeg',
    bytes: original,
    digest,
  })
  const encoder = await createFrameEncoder(envelope, blockBytes, codec)

  const offer = {
    name: 'holiday photo.jpg',
    size: original.length,
    blocks: encoder.blocks,
    codec,
    digest: shortDigest(digest),
  }

  // withOffer:false is the normal case: nothing is arranged in advance, so the
  // receiver has to learn the codec, the block count and the checksum from the
  // stream itself. The handshake that used to supply them is gone, so this is
  // the path that matters and the other is only kept for the tests.
  const reassembler = createReassembler(withOffer ? offer : null, null, blockBytes)

  let sent = 0
  let delivered = 0
  let done = false
  const cap = encoder.blocks * 40 + 5000

  while (!done && sent < cap) {
    const frame = encoder.next(FRAME_CAPACITY)
    sent++
    if (frame.length !== FRAME_CAPACITY) {
      console.log(`   FAILURE: frame is ${frame.length} B, expected exactly ${FRAME_CAPACITY}`)
      process.exitCode = 1
      return
    }
    if (Math.random() < dropRate) continue // the camera missed this one
    delivered++
    done = reassembler.push(frame)
  }

  const outcome = await reassembler.finalize()
  const bytesMatch =
    outcome.ok &&
    outcome.file.bytes.length === original.length &&
    outcome.file.bytes.every((b, i) => b === original[i])

  const overhead = ((reassembler.progress().have / encoder.blocks - 1) * 100).toFixed(0)
  console.log(
    `${label.padEnd(34)} k=${String(encoder.blocks).padStart(4)}  ` +
      `frames_shown=${String(sent).padStart(5)}  frames_seen=${String(delivered).padStart(5)}  ` +
      `overhead=${overhead.padStart(4)}%  ok=${outcome.ok}  bytes_match=${bytesMatch}  ` +
      `name="${outcome.file?.name ?? '-'}"  type=${outcome.file?.type ?? '-'}`,
  )
  if (!bytesMatch) {
    console.log('   FAILURE:', outcome.reason ?? 'byte mismatch')
    process.exitCode = 1
  }
}

const CAPACITIES = Object.fromEntries(
  LADDER.map((id) => [id, capacityFor(layoutFor(id)).payloadBytes]),
)
const BLOCK = BLOCK_BYTES

console.log(`frame capacity ${FRAME_CAPACITY} B on the ${DEFAULT_PROFILE} rung, block ${BLOCK} B\n`)

console.log('--- fountain, nothing arranged in advance ---')
await run({ codec: 'lt', blockBytes: BLOCK, dropRate: 0, label: 'clean line of sight', withOffer: false })
await run({ codec: 'lt', blockBytes: BLOCK, dropRate: 0.3, label: '30% of frames missed', withOffer: false })
await run({ codec: 'lt', blockBytes: BLOCK, dropRate: 0.7, label: '70% of frames missed', withOffer: false })
await run({ codec: 'lt', blockBytes: BLOCK, dropRate: 0.3, label: '2 MB file, 30% missed', withOffer: false, fileBytes: 2_000_000 })
await run({ codec: 'lt', blockBytes: 4096, dropRate: 0.3, label: '4 kB blocks, 30% missed', withOffer: false })

console.log('\n--- fountain, with a digest announced ---')
await run({ codec: 'lt', blockBytes: BLOCK, dropRate: 0, label: 'clean line of sight' })
await run({ codec: 'lt', blockBytes: BLOCK, dropRate: 0.4, label: '40% of frames missed' })

/**
 * A rung change mid-transfer must keep working.
 *
 * This is the bug that made frames pack multiple blocks in the first place. The
 * block size is fixed for the whole transfer - a Luby-Transform decoder keys on
 * the block count, so it cannot change - but the FRAME size changes whenever
 * the back channel moves a rung. With one block per frame, sized to fill the
 * rung in use at file-pick time, every frame after a drop threw: the emitter
 * froze on its last picture and nothing reported why.
 */
console.log('\n--- a rung change mid-transfer ---')
{
  const file = new Uint8Array(300_000)
  for (let i = 0; i < file.length; i += 65536) {
    crypto.getRandomValues(file.subarray(i, Math.min(i + 65536, file.length)))
  }
  const digest = await sha256Hex(file)
  const envelope = wrapFile({ name: 'r.bin', type: 'application/octet-stream', bytes: file, digest })
  const encoder = await createFrameEncoder(envelope, BLOCK)
  const reassembler = createReassembler(null, null)

  // Walk the whole ladder, in both directions, while the transfer runs.
  const walk = [...LADDER, ...[...LADDER].reverse()]
  let done = false
  let sent = 0
  let blocks = 0
  while (!done && sent < encoder.blocks * 40 + 2000) {
    const rung = walk[sent % walk.length]
    const frame = encoder.next(CAPACITIES[rung])
    sent++
    if (frame.length !== CAPACITIES[rung]) {
      console.log(`   FAILURE: ${rung} frame is ${frame.length} B, expected ${CAPACITIES[rung]}`)
      process.exitCode = 1
      break
    }
    blocks += unframe(frame, BLOCK).length
    done = reassembler.push(frame)
  }

  const outcome = await reassembler.finalize()
  const exact =
    outcome.ok && outcome.file.bytes.length === file.length && outcome.file.bytes.every((b, i) => b === file[i])
  console.log(
    `every rung, alternating       k=${String(encoder.blocks).padStart(4)}  ` +
      `frames=${String(sent).padStart(4)}  blocks=${String(blocks).padStart(5)}  ok=${outcome.ok}  bytes_match=${exact}`,
  )
  if (!exact) {
    console.log('   FAILURE:', outcome.reason ?? 'byte mismatch')
    process.exitCode = 1
  }
}

/**
 * A blind sender sweeping the ladder, against one pinned to a fixed rung.
 *
 * This is the case the back channel cannot cover: the receiver defaults to its
 * rear lens, which points its screen - and the status beacon on it - away from
 * the sender, so the sender never learns what the other end can resolve. Every
 * fixed answer is wrong somewhere, and the interesting failure is not slowness
 * but ZERO: a sender pinned above what the receiver can read delivers nothing
 * at all, for as long as anyone will hold the camera up.
 *
 * Modelled as a ceiling: the receiver reads rungs up to `readable` and drops
 * every frame above it, which is what a rung past its blur tolerance does.
 * Sweeping must finish for every ceiling, including the bottom one.
 */
console.log('\n--- blind sender: sweeping the ladder vs pinning a rung ---')
{
  const FILE = 400_000
  const DWELL = 15 // frames per rung, matching the sender's one-second dwell

  const attempt = async (readable, rungAt) => {
    const bytes = new Uint8Array(FILE)
    for (let i = 0; i < FILE; i += 65536) {
      crypto.getRandomValues(bytes.subarray(i, Math.min(i + 65536, FILE)))
    }
    const encoder = await createFrameEncoder(bytes, BLOCK)
    const reassembler = createReassembler(null)
    const limit = 20000
    let sent = 0
    let read = 0
    while (sent < limit) {
      const rung = rungAt(sent)
      const frame = encoder.next(CAPACITIES[rung])
      sent++
      // Above the ceiling the frame is emitted and simply not decodable.
      if (LADDER.indexOf(rung) > readable) continue
      read++
      if (reassembler.push(frame)) return { done: true, sent, read }
    }
    return { done: false, sent, read }
  }

  for (let readable = 0; readable < LADDER.length; readable++) {
    const sweep = await attempt(readable, (n) => LADDER[Math.floor(n / DWELL) % LADDER.length])
    const pinned = await attempt(readable, () => DEFAULT_PROFILE)
    const rate = (r) => (r.done ? `${((FILE / (r.sent / 15)) / 1024).toFixed(0)} KB/s` : 'never')
    console.log(
      `  reads up to ${LADDER[readable].padEnd(7)} sweep: ${rate(sweep).padStart(8)}` +
        `  pinned at ${DEFAULT_PROFILE}: ${rate(pinned).padStart(8)}`,
    )
    if (!sweep.done) {
      console.log(`   FAILURE: sweeping never finished against a ${LADDER[readable]} ceiling`)
      process.exitCode = 1
    }
  }
}

// Blocks per frame, and how much of each frame is actually used.
console.log('\n--- frame utilisation per rung ---')
{
  const encoder = await createFrameEncoder(new Uint8Array(600_000), BLOCK)
  console.log(`block ${BLOCK} B, k=${encoder.blocks}`)
  for (const rung of LADDER) {
    const capacity = CAPACITIES[rung]
    const blocks = unframe(encoder.next(capacity), BLOCK).length
    const used = (blocks * BLOCK) / capacity
    console.log(
      `  ${rung.padEnd(8)} ${String(capacity).padStart(6)} B  ` +
        `${blocks} blocks/frame  ${(used * 100).toFixed(1)}% used`,
    )
    // The reason the block is 344 bytes: every rung within 5% of full.
    if (used < 0.95) {
      console.log(`   FAILURE: ${rung} uses only ${(used * 100).toFixed(1)}% of its frame`)
      process.exitCode = 1
    }
  }
}

/**
 * Fountain overhead per rung, at a block count a real file actually reaches.
 *
 * The runs above use k around 180, which is small enough to hide the thing
 * this catches. Under the old variable-size block format a frame could only
 * carry a block whose index list fitted the room left after the slice, and on
 * the bottom rung that was exactly ten indices - so `far` drew from a soliton
 * TRUNCATED AT DEGREE 10. Truncation costs coverage, not just variance: mean
 * degree fell to 3.1 against ln(k), and the receiver needed 2-3x `k` blocks
 * where the rest of the ladder needed 1.3x. Measured on a real run: 15 KB/s
 * on a link with headroom for 149.
 *
 * Blocks are all the same size, so no rung truncates anything, and with
 * elimination finishing the decode every rung should need about 1.002x k.
 * The worst of 15 runs at k = 6,396 was 1.032x, so the bound is 1.06x: loose
 * enough not to flake, tight enough that peeling alone (1.05x to 1.13x) or a
 * truncated distribution (2x) fails it.
 */
console.log('\n--- fountain overhead per rung, k near 5,400 ---')
{
  const FILE = 1.7 * 1024 * 1024
  const caps = {}
  for (const rung of LADDER) {
    const capacity = CAPACITIES[rung]
    const data = new Uint8Array(FILE)
    for (let i = 0; i < FILE; i += 65536) {
      crypto.getRandomValues(data.subarray(i, Math.min(i + 65536, FILE)))
    }
    const encoder = await createFrameEncoder(data, BLOCK)
    const reassembler = createReassembler(null)
    let frames = 0
    while (frames < 20000 && !reassembler.push(encoder.next(capacity))) frames++
    frames++
    const { have, need } = reassembler.progress()
    caps[rung] = have / need
    console.log(
      `  ${rung.padEnd(8)} k=${String(need).padStart(4)}  ` +
        `blocks=${String(have).padStart(5)}  ` +
        `overhead=${(have / need).toFixed(2)}x  ` +
        `${blocksPerFrame(capacity, BLOCK)} blocks/frame  ` +
        `${(FILE / (frames / 15) / 1024).toFixed(0)} KB/s @15fps`,
    )
  }
  for (const rung of LADDER) {
    if (caps[rung] > 1.06) {
      console.log(`   FAILURE: ${rung} needed ${caps[rung].toFixed(2)}x k blocks`)
      process.exitCode = 1
    }
  }
}

// A frame far too small for even one block must be refused, not truncated.
{
  const tiny = await createFrameEncoder(new Uint8Array(5000), 4096, 'lt')
  let threw = false
  try {
    tiny.next(64)
  } catch {
    threw = true
  }
  console.log(`\nimpossibly small frame refused: ${threw}`)
  if (!threw) process.exitCode = 1
}

// Every block checks itself: one changed byte costs that block and no other,
// and a frame cut short keeps the blocks that arrived whole.
{
  const encoder = await createFrameEncoder(new Uint8Array(50_000), BLOCK, 'lt')
  const frame = encoder.next(FRAME_CAPACITY)
  const whole = unframe(frame, BLOCK).length
  const altered = frame.slice()
  altered[BLOCK + 100] ^= 0x10 // inside the second block
  const afterFlip = unframe(altered, BLOCK)
  const cut = unframe(frame.slice(0, 2 * BLOCK + 40), BLOCK).length
  const ok = whole === blocksPerFrame(FRAME_CAPACITY, BLOCK) && afterFlip.length === whole - 1 && cut === 2
  console.log(`one flipped byte costs one block: ${afterFlip.length === whole - 1}, truncated frame keeps ${cut} whole blocks`)
  if (!ok) process.exitCode = 1
}

// The framing must survive being handed junk: nothing passes a CRC by accident.
{
  const random = seeded(1)
  const noise = Uint8Array.from({ length: BLOCK * 8 }, () => (random() * 256) | 0)
  const junk = [new Uint8Array(0), new Uint8Array(5), new Uint8Array(BLOCK * 4), noise]
  const rejected = junk.every((bytes) => unframe(bytes, BLOCK).length === 0)
  console.log(`junk rejected by unframe: ${rejected}`)
  if (!rejected) process.exitCode = 1
  console.log(`blocks per frame at ${FRAME_CAPACITY} B, block ${BLOCK} B: ${blocksPerFrame(FRAME_CAPACITY, BLOCK)}`)
}

/**
 * A frame with a dead codeword still delivers every block it did not touch.
 *
 * The whole point of per-block salvage. A codeword owns a contiguous 38.25 bytes of the frame
 * payload, so killing one must leave every block it does not overlap intact,
 * and every block that does arrive must be byte for byte what was sent,
 * because one that passes its CRC with the wrong bytes would poison the
 * fountain. (A block the dead codeword overlaps can still arrive, correctly:
 * the zeros a failed codeword leaves are sometimes what was there.)
 */
{
  const file = new Uint8Array(400_000)
  for (let i = 0; i < file.length; i += 65536) crypto.getRandomValues(file.subarray(i, Math.min(i + 65536, file.length)))
  const encoder = await createFrameEncoder(file, BLOCK)
  const payload = encoder.next(FRAME_CAPACITY)
  const sent = unframe(payload, BLOCK)
  const { cells } = encodeFrame(payload)
  const bitsPerCodeword = 51 * 6
  const same = (a, b) => a.every((x, j) => x === b[j])
  let exact = true
  let delivered = 0
  const deadCodewords = [0, 60, 146]
  for (const dead of deadCodewords) {
    const damaged = cells.slice()
    for (let s = 0; s < 20; s++) {
      const raster = layout.dataCells[slotFor(layout, dead, s)]
      damaged[raster] = (damaged[raster] + 3) % 64
    }
    const out = decodeFrame(damaged, null)
    const got = unframe(out.payload, BLOCK)
    delivered += got.length
    // Which blocks the dead codeword's bits overlap. The last codeword sits in
    // the frame's zero padding, past the last block, and should cost nothing.
    const first = Math.floor(Math.floor((dead * bitsPerCodeword) / 8) / BLOCK)
    const last = Math.floor(Math.floor(((dead + 1) * bitsPerCodeword - 1) / 8) / BLOCK)
    const untouchedArrived = sent.every((block, i) => (i >= first && i <= last) || got.some((g) => same(g, block)))
    const noneWrong = got.every((g) => sent.some((block) => same(g, block)))
    exact &&= !out.ok && untouchedArrived && noneWrong
  }
  console.log(
    `dead codeword costs only its own blocks: ${exact} ` +
      `(${delivered} of ${deadCodewords.length * sent.length} blocks delivered across ${deadCodewords.length} frames)`,
  )
  if (!exact) process.exitCode = 1
}

// Blocks from another transfer must not be mixed into this one.
{
  const a = Uint8Array.from({ length: 120_000 }, (_, i) => (i * 7) & 255)
  const b = Uint8Array.from({ length: 120_000 }, (_, i) => (i * 11 + 3) & 255)
  const encA = await createFrameEncoder(a, BLOCK)
  const encB = await createFrameEncoder(b, BLOCK)

  const mixed = createReassembler(null, null)
  mixed.push(encA.next(FRAME_CAPACITY)) // the first block's checksum defines the transfer
  const afterOwn = mixed.progress().have

  // Whether a push "completes" is not the question - whether the foreign
  // blocks were absorbed at all is.
  for (let i = 0; i < 50; i++) mixed.push(encB.next(FRAME_CAPACITY))
  const afterForeign = mixed.progress().have

  console.log(
    `frames from another transfer ignored: ${afterForeign === afterOwn} ` +
      `(had ${afterOwn} blocks, still ${afterForeign} after 50 foreign frames)`,
  )
  if (afterForeign !== afterOwn) process.exitCode = 1
}

/**
 * A torn capture delivers the blocks of both frames.
 *
 * A rolling shutter that catches the switch between frames returns the top of
 * one and the bottom of the next - or, with the phone turned against the
 * panel, the left of one and the right of the next. With the interleave run
 * within quadrants, each quadrant comes from one frame, and every block that
 * lies inside one arrives. At least 40% on every rung, in both directions;
 * a full-panel interleave delivered none.
 */
{
  const source = await createFrameEncoder(crypto.getRandomValues(new Uint8Array(60_000)), BLOCK)
  let worst = 1
  const lines = []
  for (const rung of LADDER) {
    const layout = layoutFor(rung)
    const capacity = CAPACITIES[rung]
    const a = source.next(capacity)
    const b = source.next(capacity)
    const cellsA = encodeFrame(a, { profile: rung }).cells
    const cellsB = encodeFrame(b, { profile: rung }).cells
    const blocks = blocksPerFrame(capacity, BLOCK)
    const torn = (useB) => {
      const cells = cellsA.map((v, i) => (useB(i % layout.cols, (i / layout.cols) | 0) ? cellsB[i] : v))
      const { payload } = decodeFrame(cells, null, { profile: rung })
      return unframe(payload, BLOCK).length / blocks
    }
    const rows = torn((x, y) => y >= layout.rows / 2)
    const columns = torn((x) => x >= layout.cols / 2)
    worst = Math.min(worst, rows, columns)
    lines.push(`${rung} ${(rows * 100).toFixed(0)}%/${(columns * 100).toFixed(0)}%`)
  }
  console.log(`torn frames deliver (rows/columns): ${lines.join(', ')}`)
  if (worst < 0.4) {
    console.log(`   FAILURE: a torn frame delivered only ${(worst * 100).toFixed(0)}% of its blocks`)
    process.exitCode = 1
  }
}
