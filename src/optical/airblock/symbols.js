/**
 * The 16 symbol tiles. GENERATED - do not edit by hand.
 *
 * Produced by scripts/gen-symbols.mjs, which anneals for the worst-case
 * classifier margin through a model of the whole capture chain - supersampled
 * tile, defocus, resampling to a handful of capture pixels, sub-pixel offset,
 * threshold - rather than for Hamming distance between the crisp bitmaps.
 * Resampling, not defocus, is the dominant filter; see that file.
 *
 * Regenerate with: npm run symbols
 *
 *   worst margin over all modelled conditions   14 bits
 *   at                                          1 (symbol, condition) pair(s)
 *   minimum distance between canonical hashes   16 bits
 *   ink fraction                                0.500 - 0.500
 *
 * By modelled condition:
 *
 *    8 px/tile  sigma 0.0 bits  shift (0, 0)  margin 16
 *    8 px/tile  sigma 0.0 bits  shift (0.35, 0)  margin 16
 *    8 px/tile  sigma 0.0 bits  shift (0, 0.35)  margin 16
 *    8 px/tile  sigma 0.0 bits  shift (0.35, 0.35)  margin 16
 *    8 px/tile  sigma 0.6 bits  shift (0, 0)  margin 16
 *    8 px/tile  sigma 0.6 bits  shift (0.35, 0)  margin 16
 *    8 px/tile  sigma 0.6 bits  shift (0, 0.35)  margin 16
 *    8 px/tile  sigma 0.6 bits  shift (0.35, 0.35)  margin 16
 *    8 px/tile  sigma 1.2 bits  shift (0, 0)  margin 16
 *    8 px/tile  sigma 1.2 bits  shift (0.35, 0)  margin 16
 *    8 px/tile  sigma 1.2 bits  shift (0, 0.35)  margin 16
 *    8 px/tile  sigma 1.2 bits  shift (0.35, 0.35)  margin 14
 *   12 px/tile  sigma 0.0 bits  shift (0, 0)  margin 16
 *   12 px/tile  sigma 0.0 bits  shift (0.35, 0)  margin 16
 *   12 px/tile  sigma 0.0 bits  shift (0, 0.35)  margin 16
 *   12 px/tile  sigma 0.0 bits  shift (0.35, 0.35)  margin 16
 *   12 px/tile  sigma 0.6 bits  shift (0, 0)  margin 16
 *   12 px/tile  sigma 0.6 bits  shift (0.35, 0)  margin 16
 *   12 px/tile  sigma 0.6 bits  shift (0, 0.35)  margin 16
 *   12 px/tile  sigma 0.6 bits  shift (0.35, 0.35)  margin 16
 *   12 px/tile  sigma 1.2 bits  shift (0, 0)  margin 16
 *   12 px/tile  sigma 1.2 bits  shift (0.35, 0)  margin 16
 *   12 px/tile  sigma 1.2 bits  shift (0, 0.35)  margin 16
 *   12 px/tile  sigma 1.2 bits  shift (0.35, 0.35)  margin 16
 *
 * Below the objective, for reference - this is the resolution cliff, and the
 * grid profiles exist to keep the receiver off it:
 *
 *    5 px/tile  sigma 0.0 bits  shift (0, 0)  margin 16
 *    5 px/tile  sigma 0.0 bits  shift (0.35, 0)  margin 8
 *    5 px/tile  sigma 0.0 bits  shift (0, 0.35)  margin 8
 *    5 px/tile  sigma 0.0 bits  shift (0.35, 0.35)  margin 0
 *    5 px/tile  sigma 0.6 bits  shift (0, 0)  margin 16
 *    5 px/tile  sigma 0.6 bits  shift (0.35, 0)  margin 8
 *    5 px/tile  sigma 0.6 bits  shift (0, 0.35)  margin 8
 *    5 px/tile  sigma 0.6 bits  shift (0.35, 0.35)  margin 2
 *    5 px/tile  sigma 1.2 bits  shift (0, 0)  margin 14
 *    5 px/tile  sigma 1.2 bits  shift (0.35, 0)  margin 8
 *    5 px/tile  sigma 1.2 bits  shift (0, 0.35)  margin 6
 *    5 px/tile  sigma 1.2 bits  shift (0.35, 0.35)  margin 2
 *    6 px/tile  sigma 0.0 bits  shift (0, 0)  margin 16
 *    6 px/tile  sigma 0.0 bits  shift (0.35, 0)  margin 14
 *    6 px/tile  sigma 0.0 bits  shift (0, 0.35)  margin 14
 *    6 px/tile  sigma 0.0 bits  shift (0.35, 0.35)  margin 10
 *    6 px/tile  sigma 0.6 bits  shift (0, 0)  margin 16
 *    6 px/tile  sigma 0.6 bits  shift (0.35, 0)  margin 14
 *    6 px/tile  sigma 0.6 bits  shift (0, 0.35)  margin 14
 *    6 px/tile  sigma 0.6 bits  shift (0.35, 0.35)  margin 10
 *    6 px/tile  sigma 1.2 bits  shift (0, 0)  margin 16
 *    6 px/tile  sigma 1.2 bits  shift (0.35, 0)  margin 8
 *    6 px/tile  sigma 1.2 bits  shift (0, 0.35)  margin 10
 *    6 px/tile  sigma 1.2 bits  shift (0.35, 0.35)  margin 8
 *
 * The ink fraction band is load-bearing twice over. It makes the receiver's
 * 15x15-cell local box mean a valid decision level with no occupancy estimate,
 * and it makes the canonical hash below identical to the bitmap it came from -
 * thresholding a crisp tile at its own mean reproduces the bitmap exactly only
 * when half its bits are lit.
 */

/** Tile edge in bits. The 64 bits are also exactly the hash width. */
export const SYMBOL_BITS = 8

/** Number of distinct symbols, so 4 of the 6 bits per tile. */
export const SYMBOL_COUNT = 16

/**
 * Row-major 8x8 bitmaps, one Uint8Array of 0/1 per symbol.
 *
 *    0  ######..
 *       ######..
 *       ........
 *       ........
 *       ..######
 *       ..######
 *       ##....##
 *       ##....##
 *
 *    1  ##......
 *       ##......
 *       ########
 *       ########
 *       ....##..
 *       ....##..
 *       ..####..
 *       ..####..
 *
 *    2  ####..##
 *       ####..##
 *       ..######
 *       ..######
 *       ..##....
 *       ..##....
 *       ......##
 *       ......##
 *
 *    3  ..##..##
 *       ..##..##
 *       ..##..##
 *       ..##..##
 *       ##....##
 *       ##....##
 *       ....####
 *       ....####
 *
 *    4  ######..
 *       ######..
 *       ......##
 *       ......##
 *       ##..##..
 *       ##..##..
 *       ##..##..
 *       ##..##..
 *
 *    5  ....####
 *       ....####
 *       ..####..
 *       ..####..
 *       ....##..
 *       ....##..
 *       ####..##
 *       ####..##
 *
 *    6  ##....##
 *       ##....##
 *       ##....##
 *       ##....##
 *       ######..
 *       ######..
 *       ##......
 *       ##......
 *
 *    7  ##....##
 *       ##....##
 *       ..####..
 *       ..####..
 *       ..######
 *       ..######
 *       ..##....
 *       ..##....
 *
 *    8  ..######
 *       ..######
 *       ####....
 *       ####....
 *       ..##..##
 *       ..##..##
 *       ....##..
 *       ....##..
 *
 *    9  ##..##..
 *       ##..##..
 *       ......##
 *       ......##
 *       ########
 *       ########
 *       ....##..
 *       ....##..
 *
 *   10  ....##..
 *       ....##..
 *       ##..##..
 *       ##..##..
 *       ##..##..
 *       ##..##..
 *       ##..####
 *       ##..####
 *
 *   11  ######..
 *       ######..
 *       ..##..##
 *       ..##..##
 *       ......##
 *       ......##
 *       ####....
 *       ####....
 *
 *   12  ##..####
 *       ##..####
 *       ##..##..
 *       ##..##..
 *       ....####
 *       ....####
 *       ......##
 *       ......##
 *
 *   13  ..##....
 *       ..##....
 *       ..######
 *       ..######
 *       ##..##..
 *       ##..##..
 *       ####....
 *       ####....
 *
 *   14  ......##
 *       ......##
 *       ##..####
 *       ##..####
 *       ..##....
 *       ..##....
 *       ..######
 *       ..######
 *
 *   15  ####....
 *       ####....
 *       ####....
 *       ####....
 *       ####....
 *       ####....
 *       ##....##
 *       ##....##
 */
export const SYMBOL_BITMAPS = [
  // 0: ######.. ######.. ........ ........ ..###### ..###### ##....## ##....##
  Uint8Array.from([1,1,1,1,1,1,0,0,1,1,1,1,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,1,1,1,1,0,0,1,1,1,1,1,1,1,1,0,0,0,0,1,1,1,1,0,0,0,0,1,1]),
  // 1: ##...... ##...... ######## ######## ....##.. ....##.. ..####.. ..####..
  Uint8Array.from([1,1,0,0,0,0,0,0,1,1,0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0,0,1,1,0,0,0,0,0,0,1,1,0,0,0,0,1,1,1,1,0,0,0,0,1,1,1,1,0,0]),
  // 2: ####..## ####..## ..###### ..###### ..##.... ..##.... ......## ......##
  Uint8Array.from([1,1,1,1,0,0,1,1,1,1,1,1,0,0,1,1,0,0,1,1,1,1,1,1,0,0,1,1,1,1,1,1,0,0,1,1,0,0,0,0,0,0,1,1,0,0,0,0,0,0,0,0,0,0,1,1,0,0,0,0,0,0,1,1]),
  // 3: ..##..## ..##..## ..##..## ..##..## ##....## ##....## ....#### ....####
  Uint8Array.from([0,0,1,1,0,0,1,1,0,0,1,1,0,0,1,1,0,0,1,1,0,0,1,1,0,0,1,1,0,0,1,1,1,1,0,0,0,0,1,1,1,1,0,0,0,0,1,1,0,0,0,0,1,1,1,1,0,0,0,0,1,1,1,1]),
  // 4: ######.. ######.. ......## ......## ##..##.. ##..##.. ##..##.. ##..##..
  Uint8Array.from([1,1,1,1,1,1,0,0,1,1,1,1,1,1,0,0,0,0,0,0,0,0,1,1,0,0,0,0,0,0,1,1,1,1,0,0,1,1,0,0,1,1,0,0,1,1,0,0,1,1,0,0,1,1,0,0,1,1,0,0,1,1,0,0]),
  // 5: ....#### ....#### ..####.. ..####.. ....##.. ....##.. ####..## ####..##
  Uint8Array.from([0,0,0,0,1,1,1,1,0,0,0,0,1,1,1,1,0,0,1,1,1,1,0,0,0,0,1,1,1,1,0,0,0,0,0,0,1,1,0,0,0,0,0,0,1,1,0,0,1,1,1,1,0,0,1,1,1,1,1,1,0,0,1,1]),
  // 6: ##....## ##....## ##....## ##....## ######.. ######.. ##...... ##......
  Uint8Array.from([1,1,0,0,0,0,1,1,1,1,0,0,0,0,1,1,1,1,0,0,0,0,1,1,1,1,0,0,0,0,1,1,1,1,1,1,1,1,0,0,1,1,1,1,1,1,0,0,1,1,0,0,0,0,0,0,1,1,0,0,0,0,0,0]),
  // 7: ##....## ##....## ..####.. ..####.. ..###### ..###### ..##.... ..##....
  Uint8Array.from([1,1,0,0,0,0,1,1,1,1,0,0,0,0,1,1,0,0,1,1,1,1,0,0,0,0,1,1,1,1,0,0,0,0,1,1,1,1,1,1,0,0,1,1,1,1,1,1,0,0,1,1,0,0,0,0,0,0,1,1,0,0,0,0]),
  // 8: ..###### ..###### ####.... ####.... ..##..## ..##..## ....##.. ....##..
  Uint8Array.from([0,0,1,1,1,1,1,1,0,0,1,1,1,1,1,1,1,1,1,1,0,0,0,0,1,1,1,1,0,0,0,0,0,0,1,1,0,0,1,1,0,0,1,1,0,0,1,1,0,0,0,0,1,1,0,0,0,0,0,0,1,1,0,0]),
  // 9: ##..##.. ##..##.. ......## ......## ######## ######## ....##.. ....##..
  Uint8Array.from([1,1,0,0,1,1,0,0,1,1,0,0,1,1,0,0,0,0,0,0,0,0,1,1,0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0,0,1,1,0,0,0,0,0,0,1,1,0,0]),
  // 10: ....##.. ....##.. ##..##.. ##..##.. ##..##.. ##..##.. ##..#### ##..####
  Uint8Array.from([0,0,0,0,1,1,0,0,0,0,0,0,1,1,0,0,1,1,0,0,1,1,0,0,1,1,0,0,1,1,0,0,1,1,0,0,1,1,0,0,1,1,0,0,1,1,0,0,1,1,0,0,1,1,1,1,1,1,0,0,1,1,1,1]),
  // 11: ######.. ######.. ..##..## ..##..## ......## ......## ####.... ####....
  Uint8Array.from([1,1,1,1,1,1,0,0,1,1,1,1,1,1,0,0,0,0,1,1,0,0,1,1,0,0,1,1,0,0,1,1,0,0,0,0,0,0,1,1,0,0,0,0,0,0,1,1,1,1,1,1,0,0,0,0,1,1,1,1,0,0,0,0]),
  // 12: ##..#### ##..#### ##..##.. ##..##.. ....#### ....#### ......## ......##
  Uint8Array.from([1,1,0,0,1,1,1,1,1,1,0,0,1,1,1,1,1,1,0,0,1,1,0,0,1,1,0,0,1,1,0,0,0,0,0,0,1,1,1,1,0,0,0,0,1,1,1,1,0,0,0,0,0,0,1,1,0,0,0,0,0,0,1,1]),
  // 13: ..##.... ..##.... ..###### ..###### ##..##.. ##..##.. ####.... ####....
  Uint8Array.from([0,0,1,1,0,0,0,0,0,0,1,1,0,0,0,0,0,0,1,1,1,1,1,1,0,0,1,1,1,1,1,1,1,1,0,0,1,1,0,0,1,1,0,0,1,1,0,0,1,1,1,1,0,0,0,0,1,1,1,1,0,0,0,0]),
  // 14: ......## ......## ##..#### ##..#### ..##.... ..##.... ..###### ..######
  Uint8Array.from([0,0,0,0,0,0,1,1,0,0,0,0,0,0,1,1,1,1,0,0,1,1,1,1,1,1,0,0,1,1,1,1,0,0,1,1,0,0,0,0,0,0,1,1,0,0,0,0,0,0,1,1,1,1,1,1,0,0,1,1,1,1,1,1]),
  // 15: ####.... ####.... ####.... ####.... ####.... ####.... ##....## ##....##
  Uint8Array.from([1,1,1,1,0,0,0,0,1,1,1,1,0,0,0,0,1,1,1,1,0,0,0,0,1,1,1,1,0,0,0,0,1,1,1,1,0,0,0,0,1,1,1,1,0,0,0,0,1,1,0,0,0,0,1,1,1,1,0,0,0,0,1,1]),
]

/**
 * Canonical hashes as [high, low] 32-bit halves - the same bits as the bitmaps
 * above, packed for the classifier's popcount comparison. Index is the
 * symbol's 4-bit value.
 */
export const SYMBOL_HASHES = [
  [0xc3c3fcfc, 0x00003f3f], // 0
  [0x3c3c3030, 0xffff0303], // 1
  [0xc0c00c0c, 0xfcfccfcf], // 2
  [0xf0f0c3c3, 0xcccccccc], // 3
  [0x33333333, 0xc0c03f3f], // 4
  [0xcfcf3030, 0x3c3cf0f0], // 5
  [0x03033f3f, 0xc3c3c3c3], // 6
  [0x0c0cfcfc, 0x3c3cc3c3], // 7
  [0x3030cccc, 0x0f0ffcfc], // 8
  [0x3030ffff, 0xc0c03333], // 9
  [0xf3f33333, 0x33333030], // 10
  [0x0f0fc0c0, 0xcccc3f3f], // 11
  [0xc0c0f0f0, 0x3333f3f3], // 12
  [0x0f0f3333, 0xfcfc0c0c], // 13
  [0xfcfc0c0c, 0xf3f3c0c0], // 14
  [0xc3c30f0f, 0x0f0f0f0f], // 15
]

/** Flat Int32Array of the same hashes, for a tight classifier inner loop. */
export const SYMBOL_HASHES_FLAT = Int32Array.from([
  0xc3c3fcfc | 0, 0x00003f3f | 0,
  0x3c3c3030 | 0, 0xffff0303 | 0,
  0xc0c00c0c | 0, 0xfcfccfcf | 0,
  0xf0f0c3c3 | 0, 0xcccccccc | 0,
  0x33333333 | 0, 0xc0c03f3f | 0,
  0xcfcf3030 | 0, 0x3c3cf0f0 | 0,
  0x03033f3f | 0, 0xc3c3c3c3 | 0,
  0x0c0cfcfc | 0, 0x3c3cc3c3 | 0,
  0x3030cccc | 0, 0x0f0ffcfc | 0,
  0x3030ffff | 0, 0xc0c03333 | 0,
  0xf3f33333 | 0, 0x33333030 | 0,
  0x0f0fc0c0 | 0, 0xcccc3f3f | 0,
  0xc0c0f0f0 | 0, 0x3333f3f3 | 0,
  0x0f0f3333 | 0, 0xfcfc0c0c | 0,
  0xfcfc0c0c | 0, 0xf3f3c0c0 | 0,
  0xc3c30f0f | 0, 0x0f0f0f0f | 0,
])

/** Worst margin the generator achieved across all modelled conditions, in bits. */
export const WORST_BLURRED_MARGIN = 14

/**
 * Capture pixels per tile the set was optimised for, least first.
 *
 * The receiver's measured px/cell, scaled by the tile fraction of the pitch,
 * has to stay at or above the first of these. Below it the classifier is not
 * merely uncertain but systematically wrong, so the aiming guidance treats it
 * as a hard floor rather than a preference.
 */
export const PX_PER_TILE_RANGE = [8, 12]

/** Minimum pairwise distance between canonical hashes, in bits. */
export const MIN_CRISP_DISTANCE = 16

/** Logical glyph resolution before upsampling into the tile. */
export const GLYPH_BITS = 4

/** Ink fraction of each symbol, in bitmap order. */
export const SYMBOL_INK = [0.5000, 0.5000, 0.5000, 0.5000, 0.5000, 0.5000, 0.5000, 0.5000, 0.5000, 0.5000, 0.5000, 0.5000, 0.5000, 0.5000, 0.5000, 0.5000]
