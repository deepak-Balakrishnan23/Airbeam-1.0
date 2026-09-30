/**
 * The optical stream carries an envelope, not the bare file.
 *
 * The envelope makes the optical stream self-describing: everything the
 * receiver needs to name, type and verify the file travels inside it. That is
 * what lets a transfer begin the moment a camera is pointed at a screen, with
 * nothing arranged in advance and no channel other than the light.
 *
 * It is now the ONLY thing carrying any of it. There was once an acoustic offer
 * that announced the filename, size and a truncated digest before the frames
 * started, which gave the receiver a second, independent digest to compare
 * against. With the audio channel gone there is one digest, and it travels
 * inside the payload it describes - so the check below is not a formality.
 *
 * Layout, all integers big-endian:
 *
 *   0   4   magic "ABE2"
 *   4   2   filename length in UTF-8 bytes
 *   6   2   MIME type length in UTF-8 bytes
 *   8   32  SHA-256 of the file bytes
 *   40  n   filename
 *   ..  m   MIME type
 *   ..  *   file bytes
 *
 * The digest covers the file bytes only, not the envelope, so it means what a
 * person would expect it to mean: the checksum of the thing they sent.
 */

import { concatBytes, readU32, writeU32, toHex } from './bytes.js'
import { TRANSFER } from '../config.js'

const MAGIC = 0x41424532 // "ABE2"
const DIGEST_BYTES = 32
const HEADER_BYTES = 8 + DIGEST_BYTES

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function validateFile(file, cap = TRANSFER.maxFileBytes) {
  if (!file) return 'No file selected.'
  if (file.size === 0) return 'That file is empty.'
  if (file.size > cap) {
    // Named plainly, because "too big" invites someone to raise the constant.
    // The limit is the fountain's block count, not the receiver's memory -
    // see the note in src/config.js.
    const limit = (cap / (1024 * 1024)).toFixed(0)
    return `That file is larger than ${limit} MB, the most one transfer can carry.`
  }
  return null
}

/** Parse a hex digest into bytes. Throws if it is not 64 hex characters. */
function digestToBytes(hex) {
  if (typeof hex !== 'string' || !/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error('Expected a 64 character hex SHA-256.')
  }
  const out = new Uint8Array(DIGEST_BYTES)
  for (let i = 0; i < DIGEST_BYTES; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

export function wrapFile({ name, type, bytes, digest }) {
  const nameBytes = encoder.encode(name || 'file')
  const typeBytes = encoder.encode(type || 'application/octet-stream')

  if (nameBytes.length > 0xffff || typeBytes.length > 0xffff) {
    throw new Error('Filename or MIME type is implausibly long.')
  }

  const header = new Uint8Array(HEADER_BYTES)
  writeU32(header, 0, MAGIC)
  header[4] = (nameBytes.length >>> 8) & 0xff
  header[5] = nameBytes.length & 0xff
  header[6] = (typeBytes.length >>> 8) & 0xff
  header[7] = typeBytes.length & 0xff
  header.set(digestToBytes(digest), 8)

  return concatBytes([header, nameBytes, typeBytes, bytes])
}

export function unwrapFile(envelope) {
  if (envelope.length < HEADER_BYTES) {
    throw new Error('Reassembled payload is too short to be an AirBeam envelope.')
  }
  if (readU32(envelope, 0) !== MAGIC) {
    throw new Error('Reassembled payload is not an AirBeam envelope.')
  }

  const nameLen = (envelope[4] << 8) | envelope[5]
  const typeLen = (envelope[6] << 8) | envelope[7]
  const nameStart = HEADER_BYTES
  const nameEnd = nameStart + nameLen
  const typeEnd = nameEnd + typeLen

  if (typeEnd > envelope.length) {
    throw new Error('AirBeam envelope header describes more data than arrived.')
  }

  return {
    name: decoder.decode(envelope.subarray(nameStart, nameEnd)),
    type: decoder.decode(envelope.subarray(nameEnd, typeEnd)),
    digest: toHex(envelope.subarray(8, 8 + DIGEST_BYTES)),
    bytes: envelope.slice(typeEnd),
  }
}
