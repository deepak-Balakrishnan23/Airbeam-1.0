/**
 * The envelope is what makes the optical stream self-describing, and with no
 * handshake at all it is the ONLY thing carrying the file's name, type and
 * checksum. So it is worth proving the check is real: that a tampered payload
 * is actually caught, not just that a clean one passes.
 *
 * That mattered less when a chirp announced the file first and there was a
 * second, independent digest to compare against. Now there is one, and it
 * travels inside the payload it describes.
 */

import { wrapFile, unwrapFile, validateFile } from '../src/lib/envelope.js'
import { createFrameEncoder, BLOCK_BYTES } from '../src/optical/fountain.js'
import { createReassembler, safeType } from '../src/optical/reassembler.js'
import { sha256Hex } from '../src/lib/bytes.js'
import { layoutFor, DEFAULT_PROFILE } from '../src/optical/airblock/grid.js'
import { capacityFor } from '../src/optical/airblock/frame.js'

/** One frame's payload on the default rung; every encoder call needs it. */
const FRAME_CAPACITY = capacityFor(layoutFor(DEFAULT_PROFILE)).payloadBytes

let failures = 0
const check = (label, condition, extra = '') => {
  if (condition) {
    console.log(`  ok    ${label} ${extra}`)
  } else {
    failures++
    console.log(`  FAIL  ${label} ${extra}`)
  }
}

const bytes = new TextEncoder().encode('the quick brown fox jumps over the lazy dog'.repeat(50))
const digest = await sha256Hex(bytes)

// 1. round trip preserves everything
{
  const envelope = wrapFile({ name: 'ünïcode 文件.png', type: 'image/png', bytes, digest })
  const out = unwrapFile(envelope)
  check(
    'round trip',
    out.name === 'ünïcode 文件.png' &&
      out.type === 'image/png' &&
      out.digest === digest &&
      out.bytes.length === bytes.length &&
      out.bytes.every((b, i) => b === bytes[i]),
  )
}

// 2. a wrong digest is refused at wrap time rather than shipped
{
  let threw = false
  try {
    wrapFile({ name: 'a', type: 'b', bytes, digest: 'not-a-digest' })
  } catch {
    threw = true
  }
  check('malformed digest rejected', threw)
}

// 3. truncated and corrupt envelopes are rejected, not misread
{
  const envelope = wrapFile({ name: 'a.bin', type: 'application/octet-stream', bytes, digest })

  const truncated = envelope.slice(0, 20)
  let truncThrew = false
  try {
    unwrapFile(truncated)
  } catch {
    truncThrew = true
  }
  check('truncated envelope rejected', truncThrew)

  const wrongMagic = envelope.slice()
  wrongMagic[0] ^= 0xff
  let magicThrew = false
  try {
    unwrapFile(wrongMagic)
  } catch {
    magicThrew = true
  }
  check('wrong magic rejected', magicThrew)
}

// 4. the end-to-end check catches a payload that was altered in flight
{
  const envelope = wrapFile({ name: 'a.bin', type: 'application/octet-stream', bytes, digest })

  // Flip one bit of the file body, leaving the digest field intact - exactly
  // what a silently corrupted transfer would look like.
  const tampered = envelope.slice()
  tampered[tampered.length - 10] ^= 0x01

  const encoder = await createFrameEncoder(tampered, BLOCK_BYTES, 'lt')
  const reassembler = createReassembler(null, null)
  let guard = 0
  while (guard++ < encoder.blocks * 40) {
    if (reassembler.push(encoder.next(FRAME_CAPACITY))) break
  }

  const outcome = await reassembler.finalize()
  check('tampered payload refused', outcome.ok === false, `(${outcome.reason ?? 'accepted!'})`)
}

// 5. a clean payload through the same path is accepted
{
  const envelope = wrapFile({ name: 'a.bin', type: 'application/octet-stream', bytes, digest })
  const encoder = await createFrameEncoder(envelope, BLOCK_BYTES, 'lt')
  const reassembler = createReassembler(null, null)
  let guard = 0
  while (guard++ < encoder.blocks * 40) {
    if (reassembler.push(encoder.next(FRAME_CAPACITY))) break
  }

  const outcome = await reassembler.finalize()
  check(
    'clean payload accepted',
    outcome.ok === true && outcome.file.digest === digest && outcome.file.name === 'a.bin',
  )
}

// 6. a digest announced out of band, naming a different file, is caught even
//    when the envelope itself is internally consistent. Nothing announces one
//    any more, but the loopback harness and these tests can, and the check
//    catches reading frames off some other sender's screen entirely.
{
  const envelope = wrapFile({ name: 'a.bin', type: 'application/octet-stream', bytes, digest })
  const encoder = await createFrameEncoder(envelope, BLOCK_BYTES, 'lt')
  const wrongOffer = { blocks: encoder.blocks, codec: 'lt', digest: 'ffffffffffffffff' }
  const reassembler = createReassembler(wrongOffer, null)
  let guard = 0
  while (guard++ < encoder.blocks * 40) {
    if (reassembler.push(encoder.next(FRAME_CAPACITY))) break
  }

  const outcome = await reassembler.finalize()
  check('mismatched offer refused', outcome.ok === false, `(${outcome.reason ?? 'accepted!'})`)
}

// 7. empty files are refused up front
{
  check('empty file rejected', validateFile({ size: 0, name: 'x' }) !== null)
  check('missing file rejected', validateFile(null) !== null)
}

// 8. every transfer now takes the same path, so there is no size threshold and
//    nothing that decides between two of them
{
  const config = await import('../src/config.js')
  check('no acoustic handshake threshold remains', config.AUDIO === undefined)
  check('no transfer mode chooser remains', config.chooseTransferMode === undefined)

  /**
   * The cap is what the fountain can carry, and the message has to say so.
   *
   * It was once the receiver's decoder heap (a quadratic decoder, long gone);
   * it is now patience. The refusal must not name an old reason: a message
   * naming the wrong one sends whoever hits it to fix the wrong thing.
   */
  const limit = config.TRANSFER.maxFileBytes
  check('there is a file size cap', Number.isFinite(limit), `(${limit})`)
  check('the cap is 20 MiB, what the fountain can carry', limit === 20 * 1024 * 1024, `(${limit} bytes)`)
  check('a file at the cap is allowed', validateFile({ size: limit, name: 'x' }) === null)
  const refusal = validateFile({ size: limit + 1, name: 'x' })
  check('one byte over is refused', refusal !== null)
  check('the refusal explains why', /most one transfer can carry/i.test(refusal ?? ''), refusal ?? '')
  check('the refusal no longer blames memory', !/memory/i.test(refusal ?? ''), refusal ?? '')

  // The cap is only honest if a file AT it goes through the fountain:
  // incompressible bytes, the envelope around them and deflate's framing.
  const worst = new Uint8Array(limit)
  for (let i = 0; i < worst.length; i += 65536) crypto.getRandomValues(worst.subarray(i, i + 65536))
  const wrapped = wrapFile({ name: 'x'.repeat(200), type: 'application/octet-stream', bytes: worst, digest: 'a'.repeat(64) })
  let fits = null
  try {
    const encoder = await createFrameEncoder(wrapped, BLOCK_BYTES)
    fits = encoder.next(FRAME_CAPACITY).length === FRAME_CAPACITY ? null : 'short frame'
  } catch (error) {
    fits = error.message
  }
  check('a file at the cap fits the fountain', fits === null, fits ?? '')
}

// The type is the sender's word, and "Open it" opens the file as this page.
for (const type of ['text/html', 'image/svg+xml', 'application/xhtml+xml', 'text/xml', 'text/javascript', 'TEXT/HTML; charset=utf-8', '', undefined]) {
  check(`a received ${type || 'untyped'} file is only ever bytes`, safeType(type) === 'application/octet-stream', safeType(type))
}
for (const type of ['image/png', 'image/jpeg', 'video/mp4', 'audio/mpeg', 'application/pdf', 'text/plain']) {
  check(`a received ${type} file can still be opened`, safeType(type) === type)
}
check('parameters and case are dropped', safeType('Text/Plain; charset=utf-8') === 'text/plain')

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall envelope checks passed')
process.exitCode = failures ? 1 : 0
