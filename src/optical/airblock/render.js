/**
 * Paint a frame's cell values into a plain RGBA pixel buffer.
 *
 * Deliberately not a canvas. This is the reference renderer: it runs in Node,
 * which is what lets the whole optical chain - render, degrade, sample,
 * classify, correct - be measured offline with no browser and no camera. The
 * WebGL emitter in the browser is a faster path to the same pixels, and this
 * function is what it is checked against.
 *
 * Anchors are painted across the full cell pitch rather than the tile, so a
 * corner reads as a solid white ring with no gutter gaps in it. They are white,
 * which is not a palette colour, so the detector never has to tell an anchor
 * from a bright data cell.
 */

import { layoutFor, anchorPattern, anchorCorners, symbolOf, colourOf } from './grid.js'
import { PALETTE } from './palette.js'
import { SYMBOL_BITMAPS, SYMBOL_BITS } from './symbols.js'
import { BLANK } from './frame.js'

/**
 * @param {Uint8Array} cells raster-indexed 6-bit values, BLANK to leave dark
 * @param {object} [options]
 * @param {string} [options.profile]
 * @param {Uint8ClampedArray} [options.into] reuse a buffer across frames
 * @returns {{data: Uint8ClampedArray, width: number, height: number, layout: object}}
 */
export function renderFrame(cells, { profile, into } = {}) {
  const layout = layoutFor(profile)
  const { width, height } = layout.profile
  const { pitch, tile, originX, originY, cols, rows } = layout
  const scale = layout.profile.tileScale

  const data = into ?? new Uint8ClampedArray(width * height * 4)
  // Black ground, fully opaque. The gutters and quiet zone are this colour, and
  // so is every cell the frame chose not to paint.
  data.fill(0)
  for (let i = 3; i < data.length; i += 4) data[i] = 255

  const putBlock = (x0, y0, w, h, r, g, b) => {
    for (let y = y0; y < y0 + h; y++) {
      if (y < 0 || y >= height) continue
      let index = (y * width + x0) * 4
      for (let x = x0; x < x0 + w; x++, index += 4) {
        if (x < 0 || x >= width) continue
        data[index] = r
        data[index + 1] = g
        data[index + 2] = b
      }
    }
  }

  // Anchors first: they own their cells outright and no payload hides beneath.
  for (const corner of anchorCorners(layout)) {
    const pattern = anchorPattern(layout.anchorSize, corner.orientation)
    for (let cy = 0; cy < layout.anchorSize; cy++) {
      for (let cx = 0; cx < layout.anchorSize; cx++) {
        if (!pattern[cy * layout.anchorSize + cx]) continue
        putBlock(
          originX + (corner.x + cx) * pitch,
          originY + (corner.y + cy) * pitch,
          pitch,
          pitch,
          255,
          255,
          255,
        )
      }
    }
  }

  // Data and header cells.
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const raster = y * cols + x
      if (layout.role[raster] === 1) continue
      const value = cells[raster]
      if (value === BLANK || value === undefined) continue

      const bitmap = SYMBOL_BITMAPS[symbolOf(value)]
      const [r, g, b] = PALETTE[colourOf(value)].rgb
      const px = originX + x * pitch
      const py = originY + y * pitch

      for (let by = 0; by < SYMBOL_BITS; by++) {
        for (let bx = 0; bx < SYMBOL_BITS; bx++) {
          if (!bitmap[by * SYMBOL_BITS + bx]) continue
          putBlock(px + bx * scale, py + by * scale, scale, scale, r, g, b)
        }
      }
    }
  }

  return { data, width, height, layout, tile }
}
