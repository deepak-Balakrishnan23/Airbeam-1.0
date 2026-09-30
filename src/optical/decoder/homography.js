/**
 * The plane-to-plane maths the anchor detector needs: a homography from four
 * point pairs, and a 3x3 inverse. The synthetic camera in test/degrade.mjs uses the
 * same solver to photograph a frame, so the two cannot drift apart.
 */

/** Solve an n x n system by Gaussian elimination with partial pivoting. */
function solve(a, b, n) {
  for (let col = 0; col < n; col++) {
    let pivot = col
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(a[row * n + col]) > Math.abs(a[pivot * n + col])) pivot = row
    }
    if (Math.abs(a[pivot * n + col]) < 1e-12) throw new Error('degenerate point correspondence')
    if (pivot !== col) {
      for (let k = 0; k < n; k++) {
        const t = a[col * n + k]
        a[col * n + k] = a[pivot * n + k]
        a[pivot * n + k] = t
      }
      const t = b[col]
      b[col] = b[pivot]
      b[pivot] = t
    }
    for (let row = col + 1; row < n; row++) {
      const factor = a[row * n + col] / a[col * n + col]
      if (!factor) continue
      for (let k = col; k < n; k++) a[row * n + k] -= factor * a[col * n + k]
      b[row] -= factor * b[col]
    }
  }
  const x = new Float64Array(n)
  for (let row = n - 1; row >= 0; row--) {
    let acc = b[row]
    for (let k = row + 1; k < n; k++) acc -= a[row * n + k] * x[k]
    x[row] = acc / a[row * n + row]
  }
  return x
}

/**
 * Homography mapping four source points to four destination points.
 */
export function homographyFromQuad(src, dst) {
  const a = new Float64Array(64)
  const b = new Float64Array(8)

  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i]
    const [u, v] = dst[i]
    const r0 = i * 2
    const r1 = r0 + 1
    a[r0 * 8 + 0] = x
    a[r0 * 8 + 1] = y
    a[r0 * 8 + 2] = 1
    a[r0 * 8 + 6] = -u * x
    a[r0 * 8 + 7] = -u * y
    b[r0] = u
    a[r1 * 8 + 3] = x
    a[r1 * 8 + 4] = y
    a[r1 * 8 + 5] = 1
    a[r1 * 8 + 6] = -v * x
    a[r1 * 8 + 7] = -v * y
    b[r1] = v
  }

  const h = solve(a, b, 8)
  return Float64Array.from([h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1])
}

/** Inverse of a 3x3, for mapping capture pixels back to the source. */
export function invert3x3(m) {
  const [a, b, c, d, e, f, g, h, i] = m
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
  if (Math.abs(det) < 1e-12) throw new Error('singular transform')
  return Float64Array.from([
    (e * i - f * h) / det,
    (c * h - b * i) / det,
    (b * f - c * e) / det,
    (f * g - d * i) / det,
    (a * i - c * g) / det,
    (c * d - a * f) / det,
    (d * h - e * g) / det,
    (b * g - a * h) / det,
    (a * e - b * d) / det,
  ])
}
