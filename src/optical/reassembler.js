/**
 * Turns the stream of decoded frame payloads into a finished file.
 *
 * Sits between the decode worker and the fountain code: strips the frame
 * header, rejects anything that is not ours, feeds the rest to the decoder,
 * and reports progress. Duplicate frames are expected and uninteresting - with
 * a fountain code the sender never stops producing new ones.
 *
 * Nothing has to be arranged in advance. The codec is named in the frame
 * header, the block count comes from the fountain decoder once the first frame
 * lands, and the filename, MIME type and SHA-256 all travel inside the
 * envelope. Everything the receiver needs is in the stream itself, which is
 * what lets a transfer start the moment a camera is pointed at a screen.
 */

import { createFrameDecoder, unframe, blockInfo, BLOCK_BYTES } from './fountain.js'
import { unwrapFile } from '../lib/envelope.js'
import { sha256Hex, shortDigest } from '../lib/bytes.js'

/**
 * @param {object|null} offer optional pre-announced {codec, blocks, digest};
 *   there is no handshake any more, so this is only used by the loopback
 *   harness and the tests
 * @param {object} [stats] optional counter sink
 * @param {number} [blockBytes] the channel's block size: BLOCK_BYTES for the
 *   camera, the Wave message size for Wave
 */
export function createReassembler(offer, stats, blockBytes = BLOCK_BYTES) {
  // With no offer the codec is unknown until the first block arrives, at which
  // point the block names it and the decoder is built to match.
  let codec = offer?.codec ?? null
  let decoder = codec ? createFrameDecoder(codec) : null
  let finished = false
  let transfer = null

  return {
    /** @returns {boolean} true once the payload is fully reassembled */
    push(frameBytes) {
      if (finished) return true

      // Only blocks whose CRC holds come back, so a frame with failed
      // codewords still delivers the rest of itself.
      const blocks = unframe(frameBytes, blockBytes)
      if (!blocks.length) {
        // Another build, junk, or a frame too damaged to leave a block whole.
        stats?.countRejected()
        return false
      }

      // Stopping at the first block that completes the file matters: the
      // fountain decoder's output is only read once, and pushing further blocks
      // into a finished decoder is wasted work.
      for (const block of blocks) {
        const info = blockInfo(block)
        if (!codec) {
          decoder = createFrameDecoder(info.codec)
          codec = info.codec
        }
        /**
         * Blocks from a different transfer are not blocks from this one.
         *
         * The first block's file checksum defines the transfer; anything else
         * is a restarted sender or a second screen, and feeding it to this
         * decoder mixes two files into one. A fountain decoder cannot notice -
         * it needs a COUNT of blocks and has no way to know they describe
         * different things - so it completes, and only the digest at the very
         * end catches it, after the whole transfer has been spent.
         */
        transfer ??= info.checksum
        if (info.codec !== codec || info.checksum !== transfer) {
          stats?.countRejected()
          continue
        }
        const outcome = decoder.accept(block)
        if (!outcome.ok) {
          stats?.countRejected()
          continue
        }
        if (outcome.duplicate) {
          stats?.countDuplicate()
          continue
        }
        if (outcome.done) {
          finished = true
          break
        }
      }
      return finished
    },

    /** True once at least one frame has arrived, so the codec is known. */
    get started() {
      return decoder !== null
    },

    get codec() {
      return codec
    },

    /**
     * Six bits of the transfer's file checksum, which the status code echoes
     * back. The sender takes the same six bits from its encoder.
     */
    get transferTag() {
      return transfer === null ? null : transfer & 0x3f
    },

    progress() {
      if (!decoder) return { have: 0, need: offer?.blocks ?? 0, solved: 0 }
      const { have, need, solved } = decoder.progress()
      // Before the first frame lands there is nothing to go on but a block
      // count announced in advance, if one was.
      return { have, need: need || offer?.blocks || 0, solved }
    },

    /**
     * Pull the reassembled file out and check it. Returns { ok, file } - never
     * throws for an ordinary bad transfer, because "the checksum did not match"
     * is a state the UI shows, not an exception.
     */
    async finalize() {
      /**
       * Two different endings, and they call for different words.
       *
       * `null` means the blocks are not all here - the transfer was cut short.
       * A throw means every block is solved and the result is still wrong,
       * which is a miscorrection that survived the frame's own parity, the
       * frame header's transfer tag, and the block header's self-consistency
       * check. Retrying is worth it for the first and probably not the second.
       */
      let payload = null
      try {
        payload = (await decoder?.result()) ?? null
      } catch (error) {
        return { ok: false, reason: error.message }
      }
      if (!payload) {
        return { ok: false, reason: 'The payload could not be reassembled.' }
      }

      let unwrapped
      try {
        unwrapped = unwrapFile(payload)
      } catch (error) {
        return { ok: false, reason: error.message }
      }

      const digest = await sha256Hex(unwrapped.bytes)

      // The envelope's own digest is the real integrity check: a full-length
      // SHA-256 that travelled inside the payload it describes.
      if (digest !== unwrapped.digest) {
        return {
          ok: false,
          reason: 'The file does not match the checksum carried alongside it.',
        }
      }

      // When a digest was announced in advance, check it too. It catches a
      // different failure: not a corrupt transfer, but having read frames from
      // some other sender's screen entirely.
      if (offer?.digest && shortDigest(digest) !== offer.digest) {
        return {
          ok: false,
          reason: 'The file that arrived is not the one that was announced.',
        }
      }

      return {
        ok: true,
        file: {
          name: unwrapped.name,
          type: unwrapped.type,
          bytes: unwrapped.bytes,
          size: unwrapped.bytes.length,
          digest,
        },
      }
    },
  }
}

/**
 * A blob URL for the finished file, and the means to let it go.
 *
 * Separate from any click, because the click is the part that is unreliable.
 * iOS Safari ignores a synthesised `a.click()` that did not come from a user
 * gesture, and for a blob URL it may navigate to the blob instead of saving
 * it - which unloads this single-page app and loses the transfer. A real
 * anchor the user taps has neither problem, so the URL is handed to the UI and
 * the UI puts it on a link.
 *
 * @returns {{url: string, revoke: () => void}}
 */
export function fileUrl(file) {
  const blob = new Blob([file.bytes], { type: safeType(file.type) })
  const url = URL.createObjectURL(blob)
  return { url, revoke: () => URL.revokeObjectURL(url) }
}

/**
 * Types that are shown, never run: images other than SVG, audio, video, plain
 * text and PDF.
 *
 * The type comes from the other device, and a blob URL belongs to this page's
 * origin - so a file sent as HTML or SVG and opened with "Open it" would run
 * its script as AirBeam. Anything else is handed over as plain bytes, which a
 * browser saves rather than renders.
 */
const SHOWN = /^(image\/(png|jpeg|gif|webp|avif|bmp)|audio\/[\w.+-]+|video\/[\w.+-]+|text\/plain|application\/pdf)$/

export function safeType(type) {
  const base = String(type ?? '').split(';')[0].trim().toLowerCase()
  return SHOWN.test(base) ? base : 'application/octet-stream'
}
