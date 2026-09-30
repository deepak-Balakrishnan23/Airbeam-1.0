/**
 * A synthetic camera, for measuring the decoder without one.
 *
 * This is the offline half of the instrumentation. It takes a rendered frame and produces what a phone
 * would plausibly have captured of it - off-axis, defocused, vignetted, noisy,
 * white-balanced wrongly, and misaligned by a fraction of a cell - so that
 * every claim about the decoder can be reproduced in a test rather than
 * demonstrated once on a desk.
 *
 * It is not a substitute for real captures. It cannot produce specular
 * highlights, rolling-shutter skew, or the exposure oscillation an unlocked
 * camera does, and it models defocus as a Gaussian, which a real lens is not.
 * What it is good for is A/B: the same capture through two code paths, where
 * the differences are the thing being measured and the absolute numbers are
 * not.
 */

import { seeded } from '../src/lib/random.js'
import { homographyFromQuad, invert3x3 } from '../src/optical/decoder/homography.js'

function project(h, x, y, out) {
  const w = h[6] * x + h[7] * y + h[8]
  out[0] = (h[0] * x + h[1] * y + h[2]) / w
  out[1] = (h[3] * x + h[4] * y + h[5]) / w
}

/** Separable Gaussian blur over an RGBA buffer, in place-safe fashion. */
function blurRGBA(data, width, height, sigma) {
  if (sigma <= 0) return data
  const radius = Math.max(1, Math.ceil(sigma * 3))
  const kernel = new Float32Array(radius * 2 + 1)
  let sum = 0
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma))
    kernel[i + radius] = v
    sum += v
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum

  const tmp = new Float32Array(data.length)
  const out = new Uint8ClampedArray(data.length)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0
      let g = 0
      let b = 0
      for (let k = -radius; k <= radius; k++) {
        const sx = Math.min(width - 1, Math.max(0, x + k))
        const p = (y * width + sx) * 4
        const w = kernel[k + radius]
        r += data[p] * w
        g += data[p + 1] * w
        b += data[p + 2] * w
      }
      const p = (y * width + x) * 4
      tmp[p] = r
      tmp[p + 1] = g
      tmp[p + 2] = b
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0
      let g = 0
      let b = 0
      for (let k = -radius; k <= radius; k++) {
        const sy = Math.min(height - 1, Math.max(0, y + k))
        const p = (sy * width + x) * 4
        const w = kernel[k + radius]
        r += tmp[p] * w
        g += tmp[p + 1] * w
        b += tmp[p + 2] * w
      }
      const p = (y * width + x) * 4
      out[p] = r
      out[p + 1] = g
      out[p + 2] = b
      out[p + 3] = 255
    }
  }
  return out
}

export const CLEAN = {
  captureWidth: 1280,
  captureHeight: 720,
  /** Fraction of the capture frame's short edge the code spans. */
  fill: 0.94,
  /** Perspective, as a fraction of the code's width/height. 0 is square-on. */
  tiltX: 0,
  tiltY: 0,
  /**
   * Defocus, in CAPTURE pixels.
   *
   * Capture pixels, not render pixels, because that is where a lens PSF
   * physically acts and it is the only unit in which two profiles at different
   * render resolutions can be compared. It is applied in render space at
   * `blurSigma / scale`, which is equivalent and also serves as the prefilter
   * the resampling below would otherwise need.
   */
  blurSigma: 0,
  /** Radial falloff at the corners, 0..1. */
  vignette: 0,
  /** Additive Gaussian noise, in 0..255 units. */
  noise: 0,
  /** Per-channel gain, for white-balance drift. */
  whiteBalance: [1, 1, 1],
  /**
   * Chroma retained, 0..1, where 1 leaves the colour alone.
   *
   * This is veiling glare, and it is the degradation this harness was missing.
   * A camera pointed at a bright panel scatters light inside the lens and
   * across the panel's own front surface, which adds a roughly uniform
   * grey-ish pedestal to every pixel. Luma survives it; chromaticity does not,
   * because the pedestal is a share of every channel and so drags every colour
   * toward neutral.
   *
   * Nothing here modelled that, so the decoder's colour stage was only ever
   * measured against fully saturated captures and its dependence on absolute
   * palette constants never showed up offline. Measured on a phone
   * photographing a laptop panel, with a neutral white point: 23% of the ideal
   * chroma spread retained on the red axis and 34% on the blue. See palette.js.
   */
  saturation: 1,
  /** Sub-pixel offset in capture pixels, applied after everything else. */
  shiftX: 0,
  shiftY: 0,
  seed: 1,
}

/**
 * Photograph a rendered frame.
 *
 * @param {{data: Uint8ClampedArray, width: number, height: number, layout: object}} rendered
 * @param {object} [options] merged over CLEAN
 * @returns {{data: Uint8ClampedArray, width: number, height: number,
 *            transform: Float64Array}} transform maps code space (cell units)
 *            to capture pixels - the ground truth the anchor detector will one
 *            day have to recover on its own.
 */
export function capture(rendered, options = {}) {
  const config = { ...CLEAN, ...options }
  const { layout } = rendered
  const {
    captureWidth: cw,
    captureHeight: ch,
    fill,
    tiltX,
    tiltY,
    blurSigma,
    vignette,
    noise,
    whiteBalance,
    saturation,
    shiftX,
    shiftY,
    seed,
  } = config

  // Where the code's four corners land in the capture, in code space units.
  const { cols, rows } = layout
  const aspect = layout.codeWidth / layout.codeHeight
  let boxW = cw * fill
  let boxH = boxW / aspect
  if (boxH > ch * fill) {
    boxH = ch * fill
    boxW = boxH * aspect
  }
  const left = (cw - boxW) / 2 + shiftX
  const top = (ch - boxH) / 2 + shiftY

  /**
   * Keystone: the far edge of an off-axis panel is genuinely SHORTER than the
   * near one.
   *
   * The first version of this displaced two opposite corners inward, which
   * looks like perspective and is not - it leaves both pairs of opposite edges
   * exactly the same length, so it is a shear. That made it useless for
   * testing anything that measures foreshortening, and it silently reported
   * zero tilt to the detector's own tilt metric.
   *
   * `tiltX` shortens the right edge relative to the left, `tiltY` the bottom
   * relative to the top.
   */
  const insetY = boxH * tiltX
  const insetX = boxW * tiltY
  const dst = [
    [left, top],
    [left + boxW, top + insetY],
    [left + insetX, top + boxH],
    [left + boxW - insetX, top + boxH - insetY],
  ]
  const src = [
    [0, 0],
    [cols, 0],
    [0, rows],
    [cols, rows],
  ]
  const transform = homographyFromQuad(src, dst)

  // Capture pixel -> render pixel, via code space.
  const toCode = invert3x3(transform)

  // Capture pixels per render pixel. Converting the PSF through this is what
  // makes `blurSigma` mean the same physical thing for every profile.
  const scale = boxW / layout.codeWidth
  const renderSigma = blurSigma / scale
  const source = renderSigma > 0
    ? blurRGBA(rendered.data, rendered.width, rendered.height, renderSigma)
    : rendered.data

  const data = new Uint8ClampedArray(cw * ch * 4)
  const rng = seeded(seed)
  const point = new Float64Array(2)
  const cx = cw / 2
  const cy = ch / 2
  const maxRadius = Math.hypot(cx, cy)

  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const out = (y * cw + x) * 4
      data[out + 3] = 255

      project(toCode, x + 0.5, y + 0.5, point)
      const rx = layout.originX + point[0] * layout.pitch
      const ry = layout.originY + point[1] * layout.pitch

      let r = 0
      let g = 0
      let b = 0
      if (rx >= 0 && ry >= 0 && rx < rendered.width - 1 && ry < rendered.height - 1) {
        const x0 = rx | 0
        const y0 = ry | 0
        const fx = rx - x0
        const fy = ry - y0
        const p00 = (y0 * rendered.width + x0) * 4
        const p10 = p00 + 4
        const p01 = p00 + rendered.width * 4
        const p11 = p01 + 4
        for (let c = 0; c < 3; c++) {
          const top0 = source[p00 + c] + (source[p10 + c] - source[p00 + c]) * fx
          const bottom = source[p01 + c] + (source[p11 + c] - source[p01 + c]) * fx
          const value = top0 + (bottom - top0) * fy
          if (c === 0) r = value
          else if (c === 1) g = value
          else b = value
        }
      }

      // Radial falloff. This is the bias a global threshold cannot follow, and
      // therefore the whole reason the local threshold exists.
      if (vignette > 0) {
        const radius = Math.hypot(x - cx, y - cy) / maxRadius
        const gain = 1 - vignette * radius * radius
        r *= gain
        g *= gain
        b *= gain
      }

      // Contract toward this pixel's own luma, which leaves brightness alone
      // and takes chroma out - the shape veiling glare actually has.
      if (saturation < 1) {
        const grey = 0.299 * r + 0.587 * g + 0.114 * b
        r = grey + (r - grey) * saturation
        g = grey + (g - grey) * saturation
        b = grey + (b - grey) * saturation
      }

      r *= whiteBalance[0]
      g *= whiteBalance[1]
      b *= whiteBalance[2]

      if (noise > 0) {
        // Box-Muller, one pair per pixel, third channel reuses the first.
        const u1 = Math.max(1e-9, rng())
        const u2 = rng()
        const mag = noise * Math.sqrt(-2 * Math.log(u1))
        const n1 = mag * Math.cos(2 * Math.PI * u2)
        const n2 = mag * Math.sin(2 * Math.PI * u2)
        r += n1
        g += n2
        b += n1
      }

      data[out] = r
      data[out + 1] = g
      data[out + 2] = b
    }
  }

  return { data, width: cw, height: ch, transform, config, scale }
}

/**
 * A channel with a classifier attached, for the frame layer alone.
 *
 * Errors land uniformly at random. Confidence is drawn from overlapping ranges
 * - lower where the classifier got it wrong, higher where it did not, but not
 * cleanly separated, plus a false-alarm rate on cells that were fine. A model
 * with perfectly informative confidences would prove nothing: the whole
 * question is whether an imperfect signal is still worth acting on.
 *
 * Unpainted cells (0xff, the frame layer's BLANK) are left alone.
 */
export function injectSymbolErrors(cells, layout, { errorRate, rng, falseAlarmRate = 0.05 }) {
  const out = cells.slice()
  const confidences = new Float32Array(cells.length).fill(1)
  let injected = 0

  for (const raster of layout.dataCells) {
    if (out[raster] === 0xff) continue
    if (rng() < errorRate) {
      out[raster] = (out[raster] + 1 + Math.floor(rng() * 63)) % 64
      injected++
      confidences[raster] = rng() * 0.45
    } else if (rng() < falseAlarmRate) {
      confidences[raster] = rng() * 0.4
    } else {
      confidences[raster] = 0.4 + rng() * 0.6
    }
  }
  return { cells: out, confidences, injected }
}
