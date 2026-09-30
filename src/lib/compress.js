/**
 * Deflate and inflate with the platform's own CompressionStream.
 *
 * The 'deflate' format is RFC 1950: deflate with a two-byte header and a
 * checksum, what the fountain's blocks have always carried. Browsers have it
 * since Chrome 80, Safari 16.4 and Firefox 113, and Node since 18.
 */

async function pipe(bytes, stream) {
  const piped = new Blob([bytes]).stream().pipeThrough(stream)
  return new Uint8Array(await new Response(piped).arrayBuffer())
}

export const deflate = (bytes) => pipe(bytes, new CompressionStream('deflate'))

/** Rejects on corrupt input, which callers treat as a failed transfer. */
export const inflate = (bytes) => pipe(bytes, new DecompressionStream('deflate'))
