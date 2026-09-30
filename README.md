# AirBeam

Send a file between two devices in the same room, three ways:

| | how | best for |
| --- | --- | --- |
| **Wi-Fi** | a short chirp connects them, then a direct, encrypted link over the local network | anything, fast, when both are on the same Wi-Fi |
| **Light** | one screen flashes a pattern, the other device reads it with its camera | no network at all, up to 20 MiB |
| **Sound** | one device plays the file as tones, the other listens | small notes and links, nothing to aim |

No server, no account, no pairing code, and nothing to install: it is a web
page. Pick a file and choose how it travels; on the other device, tap
**Receive a file** and choose the same.

## Running it

https://airbeam-seven.vercel.app/

```bash
npm run dev         # http://localhost:5173
npm run dev:https   # the same over HTTPS, for phones on the LAN
npm test            # the whole suite, in Node
```

Node 18 or later. There are no dependencies and no build: the browser loads the
modules as they are, and the repository is the site.

**HTTPS is required.** The camera, the microphone and `crypto.subtle` need a
secure context. `localhost` counts; `http://192.168.x.x` does not, so a phone on
the LAN needs `npm run dev:https`. It writes a self-signed certificate for every
LAN address into `.certs/`; accept the warning once on the phone. Deleting
`.certs/` goes back to plain HTTP.

**Deploying** is copying the repository to any static HTTPS host, with no build
command and the repository root as the output. Every path is relative, so it
runs from a domain root or a subpath.

Two in-browser harnesses, neither needing a second device:

* `/?loopback` - the whole light path in one tab: the decoder reads the
  sender's own canvas. Proves the format round-trips, nothing optical.
* `/?wifi-loopback` - both ends of the Wi-Fi link in one tab, the handshake
  handed across instead of chirped. The rate is one machine's, a ceiling.

## Light

Each frame is a grid of 8×8-pixel tiles on black. A tile carries **six bits**:
one of sixteen glyphs (four bits) in one of four colours (two bits). Four white
ring anchors mark the corners, one of them distinct so orientation is never in
doubt.

Six bits is **one Reed-Solomon symbol over GF(2⁶)**, so a misread tile is
exactly one symbol error, and the classifier's per-tile confidence maps straight
onto erasure flags. Each 63-symbol codeword carries 12 parity symbols: six
errors, twelve erasures, or any mix with `2e + E ≤ 12`. Codewords are
interleaved within each quadrant, so a capture torn between two frames still
delivers the blocks of both. A 24-bit header (version, rung, symbol and colour
counts, parity) sits in all four corners, majority-voted, so a format mismatch
is never silent.

**The grid is a ladder** of five rungs that differ only in cell count. Fewer
cells means more camera pixels per tile and more tolerance for blur:

| rung | payload/frame | at 15 fps | 720p px/tile | tolerates σ |
| --- | --- | --- | --- | --- |
| far | 2,065 B | 30 KB/s | 12.5 | 2.0 px |
| soft | 3,442 B | 50 KB/s | 9.8 | 1.6 px |
| **normal** | **5,622 B** | **82 KB/s** | **7.8** | **1.4 px** |
| dense | 8,682 B | 127 KB/s | 6.3 | 1.0 px |
| max | 13,043 B | 191 KB/s | 5.2 | 0.6 px |

σ is the largest camera blur, in capture pixels, at which a whole frame still
decodes, measured by `test/airblock-optics.mjs` against a synthetic camera.
Each rung renders at the size its target camera resolves and is scaled up to
fill the display: rendering at the panel's resolution would put *fewer* camera
pixels on each tile, not more.

**Reading it back**, in a pool of workers (up to four) with one frame in flight
each; frames that arrive while all are busy are dropped, which a fountain code
does not mind:

1. Find the anchors by being colourless rather than bright: every palette
   colour has a zero channel, so white stands out under any exposure. The next
   frame is searched only near the last anchors.
2. Recover the grid from the anchor spacing - an anchor is seven cells across.
3. Sample each tile and let it set its own threshold: every glyph lights 32 of
   its 64 sample points, so the level between the 32nd and 33rd is "lit".
4. Refine alignment per cell, in confidence order.
5. Decide colour from the tile's chromaticity, against thresholds the frame
   supplies itself.
6. Correct: every codeword plain first, erasure flags only as a retry.

**The payload** is an envelope - name, type, SHA-256 and the file - deflated
with the browser's `CompressionStream` and fountain-coded into 344-byte blocks,
each with its own CRC-32. 344 bytes fills every rung to at least 97.6%, and a
frame carries as many blocks as fit, so the rung can change mid-transfer. A
frame that failed in one place still delivers every block it did not touch.
The receiver checks the SHA-256 before offering the file.

**The back channel.** The receiver paints a small status code - progress,
camera pixels per tile, confidence, decode rate and a done flag, written twice -
which the sender reads with its front camera to pick the rung and to know when
to stop. It needs the receiver's screen facing the sender, so it works with the
receiver's front camera. Without it the sender cycles through the rungs and the
receiver reads whichever its camera manages.

**Aiming guidance** comes from numbers the decoder already computes: pixels per
tile (distance), homography edge disagreement (tilt) and clipping (glare).

## Sound

The same fountain, one 140-byte block per message: a chirp found with a matched
filter, then eight bands of eight tones at once, coded with the same
Reed-Solomon over GF(64). A message takes 1.36 s, about 85 bytes of file a
second, so it is offered up to about fifteen minutes (roughly 75 KB after
compression). Either side can switch between light and sound mid-transfer.

## Wi-Fi

A browser cannot find another device on a network by itself, so the two first
swap a WebRTC offer and answer - over sound, one 140-byte message each way. The
ICE credentials, the DTLS fingerprint and the local addresses fit in one
message; the rest of the description is the same for every data channel and is
rebuilt. The sender plays its offer and leaves a gap, the receiver answers into
it, and a lost answer is simply given again. No server and no internet: host
addresses only.

Then the file goes device to device in 64 KB messages with backpressure,
encrypted by DTLS. The receiver says `done` when the byte count is whole, and
that is what the sender shows as Delivered. Anyone in earshot could answer the
chirp, so both screens show a three-digit match number from the two
fingerprints, and the sender sends nothing until the person sending confirms
the other screen shows the same number. Files over the 20 MiB light limit go by Wi-Fi only, up to 1 GiB.

The microphone opens before the connection, so browsers offer the real LAN
address rather than only an mDNS name. Networks that keep their clients apart,
as guest networks often do, cannot connect; the sender says so after 20 s.

## Safety

* The page loads nothing but its own files, under a Content-Security-Policy
  that allows no other origin, no plugins and no inline script.
* Everything another device sends is checked before use: Reed-Solomon, CRCs
  and bounded counts on light and sound, a CRC and length checks on the Wi-Fi
  handshake, and a size cap on the Wi-Fi header.
* A received file's type is the sender's word, and "Open it" opens it as this
  page. Only images, audio, video, plain text and PDF keep their type; anything
  else, HTML and SVG included, is handed over as plain bytes to save.
* Nothing is saved without a tap.

## The state machine

`src/state/machine.js` is pure: state and event in, next state out. Each state
declares the resources it needs - camera, emitter, microphone, speaker, Wi-Fi
link, back channel, wake lock - as required or optional, and `main.js`
reconciles what is running against that on every transition. A required
resource that will not start fails the transfer; an optional one degrades it
and the screen says what is missing. Nothing can be started twice or leaked.

## Limits

* **Light and sound are not encrypted.** Any camera or microphone nearby gets
  the same file. Wi-Fi is encrypted.
* Light is capped at 20 MiB (minutes of holding a camera steady), Wi-Fi at 1 GiB.
* One file per transfer, and no resume after closing the tab.
* The light back channel needs the screens facing each other.
* Manual camera focus and exposure are best-effort; Safari grants little.
* On iOS the camera preview needs `playsinline` (handled), and installing to
  the home screen is manual, via the Share sheet.

## Layout

```
index.html  main.js       the page, and the runtime that wires the machine to the transports
sw.js                     offline shell
src/
  config.js               tuning knobs
  state/                  the machine and its events: pure, no I/O
  optical/
    airblock/             the light codec, DOM-free: GF(64), Reed-Solomon, grid,
                          glyphs, palette, frame, reference renderer
    decoder/              anchors, homography, sampling, classification, the worker
    emitter.js            paints frames
    camera.js             focus, exposure and white-balance locks
    scanner.js            camera -> decode workers
    backchannel.js        the receiver's status code, written and read
    guidance.js           measurements -> aiming advice
    telemetry.js          per-frame records, saved from the receiving screen
    fountain.js           the outer code: 344-byte blocks with CRCs
    reassembler.js        blocks -> file, then verify
  audio/wave.js           sound: the modem
  net/wifi.js             Wi-Fi: the handshake and the data channel
  ui/                     one screen per state
  lib/                    bytes, hashing, compression, seeded random numbers, the envelope
  dev/                    the two in-browser harnesses
test/                     Node suite: fields, correction limits, geometry, the whole
                          light chain through a synthetic camera (degrade.mjs),
                          sound, Wi-Fi, imports
scripts/                  dev server, dev certificate, glyph and icon generators
public/                   manifest and icons
```

Every line is this project's own: no dependencies, no build tool, and
`test/imports.mjs` fails if the page loads anything that is not a file of this
repository.

All rights reserved.
