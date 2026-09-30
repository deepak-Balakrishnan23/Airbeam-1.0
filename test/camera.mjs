/**
 * The camera size negotiation, against fake cameras that behave like the
 * field tests' iPhone and a desk webcam.
 *
 * No browser here, so a camera is a stand-in that chooses among its modes by
 * the spec's fitness distance, with an upright phone's modes upright. Like
 * Safari, it crops and scales to exactly the size asked for unless told
 * `resizeMode: none`. The field tests pinned both behaviours: an ideal of
 * 1920 x 1080 got 720 x 1280 from an upright iPhone, and an ideal of
 * 1920 x 1920 came back square, upscaled, and unreadable.
 */

import { openCamera } from '../src/optical/camera.js'

let failures = 0
const check = (label, ok, detail = '') => {
  if (ok) return
  failures++
  console.log(`   FAIL ${label}${detail ? ` - ${detail}` : ''}`)
}

/** Relative distance of one side from an ideal, as the spec defines it. */
const distance = (actual, ideal) => (ideal === undefined ? 0 : Math.abs(actual - ideal) / Math.max(actual, ideal))

function fakeCamera(modes, { phone }) {
  const requests = []
  let current = null
  const pick = (c = {}) => {
    const native = c.resizeMode?.ideal === 'none' || c.resizeMode === 'none'
    if (!native && c.width?.ideal && c.height?.ideal) return [c.width.ideal, c.height.ideal]
    let best = modes[0]
    let score = Infinity
    for (const [w, h] of modes) {
      const s = distance(w, c.width?.ideal) + distance(h, c.height?.ideal)
      if (s < score) [best, score] = [[w, h], s]
    }
    return best
  }
  const track = {
    label: phone ? 'Back Camera' : 'FaceTime HD Camera',
    getSettings: () => ({ width: current[0], height: current[1] }),
    getCapabilities: () => ({
      width: { max: Math.max(...modes.map((m) => m[0])) },
      height: { max: Math.max(...modes.map((m) => m[1])) },
    }),
    async applyConstraints(c) {
      current = pick(c)
    },
    stop() {},
  }
  globalThis.window = { isSecureContext: true }
  globalThis.matchMedia = (query) => ({
    matches: phone && (query.includes('coarse') || query.includes('portrait')),
  })
  // Node has a read-only navigator of its own.
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        async getUserMedia({ video }) {
          requests.push(video)
          current = pick(video)
          return { getVideoTracks: () => [track], getTracks: () => [track] }
        },
      },
    },
  })
  return { track, requests }
}

const video = { setAttribute() {}, play: async () => {} }
const size = (track) => track.getSettings().width + ' x ' + track.getSettings().height

{
  const { track, requests } = fakeCamera([[480, 640], [720, 1280], [1080, 1920], [2160, 3840]], { phone: true })
  const opened = await openCamera(video, { facing: 'environment' })
  check('an upright phone opens at 1080p, not 720p', size(track) === '1080 x 1920', size(track))
  check('and says so', opened.controls.resolution?.join('x') === '1080x1920', String(opened.controls.resolution))
  const asked = requests[0]
  check('it never asks for a square, which Safari crops to', asked.width.ideal !== asked.height.ideal, JSON.stringify(asked))
}

{
  const { track } = fakeCamera([[640, 480], [1280, 720], [1920, 1080]], { phone: false })
  await openCamera(video, { facing: 'user' })
  check('a desk webcam opens at 1080p landscape', size(track) === '1920 x 1080', size(track))
}

{
  // A camera that still comes up small is asked again, the way up it is.
  const { track } = fakeCamera([[720, 1280], [1080, 1920]], { phone: true })
  navigator.mediaDevices.getUserMedia = async () => {
    await track.applyConstraints({ width: { ideal: 720 }, height: { ideal: 1280 }, resizeMode: { ideal: 'none' } })
    return { getVideoTracks: () => [track], getTracks: () => [track] }
  }
  await openCamera(video, { facing: 'environment' })
  check('a camera that came up at 720p is raised to 1080p', size(track) === '1080 x 1920', size(track))
}

console.log(failures ? `camera: ${failures} check(s) failed` : 'camera: 1080p the way up the device is held, never cropped square')
process.exitCode = failures ? 1 : 0
