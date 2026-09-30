/** Small byte helpers shared by the audio and optical layers. */

const HEX = '0123456789abcdef'

export function toHex(bytes) {
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 15]
  }
  return out
}

/**
 * SHA-256 of a Uint8Array, as a lowercase hex string.
 * Requires a secure context - crypto.subtle is undefined on plain http.
 */
export async function sha256Hex(bytes) {
  if (!globalThis.crypto?.subtle) {
    throw new Error('crypto.subtle unavailable: open the app over https or localhost')
  }
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return toHex(new Uint8Array(digest))
}

/**
 * A digest prefix, for the places that cannot afford all 64 hex characters.
 *
 * The full SHA-256 travels inside the envelope and is what actually verifies a
 * transfer. This shorter form is for display, and for the tests and the
 * loopback harness where a digest is announced out of band to check that
 * reading frames off the wrong screen is caught. 64 bits is ample for spotting
 * a garbled transfer; it is NOT a defence against a deliberately crafted
 * collision. See the security note in the README.
 */
export const DIGEST_PREFIX_CHARS = 16

export function shortDigest(hex) {
  return hex.slice(0, DIGEST_PREFIX_CHARS)
}

/** Concatenate byte arrays into one fresh buffer. */
export function concatBytes(parts) {
  let total = 0
  for (const part of parts) total += part.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/**
 * Copy a slice into a buffer that starts at byte offset zero.
 *
 * Code that reads through `bytes.buffer` sees the whole backing buffer, not
 * the view, so a subarray handed to it silently decodes garbage. Pass views
 * through here first.
 */
export function detach(bytes, start = 0, end = bytes.length) {
  return bytes.slice(start, end)
}

export function readU32(bytes, offset) {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>> 0
  )
}

export function writeU32(bytes, offset, value) {
  bytes[offset] = (value >>> 24) & 0xff
  bytes[offset + 1] = (value >>> 16) & 0xff
  bytes[offset + 2] = (value >>> 8) & 0xff
  bytes[offset + 3] = value & 0xff
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '?'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '--'
  const total = Math.round(ms / 1000)
  const mins = Math.floor(total / 60)
  const secs = total % 60
  if (mins === 0) return `${secs}s`
  return `${mins}m ${String(secs).padStart(2, '0')}s`
}
