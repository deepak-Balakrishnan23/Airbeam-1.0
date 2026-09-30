/**
 * Wi-Fi: the handshake that has to fit one Wave message each way, and the
 * machine paths for the third mode.
 *
 * WebRTC itself cannot run here. What can: real browsers' SDP squeezed into
 * 140 bytes and rebuilt, a corrupted message refused, and the states and
 * resources a Wi-Fi transfer walks through - without Air or Wave moving.
 */

import {
  signalFromSdp,
  sdpFromSignal,
  packSignal,
  unpackSignal,
  matchNumber,
  OFFER,
  ANSWER,
} from '../src/net/wifi.js'
import { WAVE } from '../src/config.js'
import { transition, initialMachine, resourcesFor, screenFor } from '../src/state/machine.js'
import { State, Event } from '../src/state/events.js'

let failures = 0
const check = (label, ok, detail = '') => {
  if (ok) return
  failures++
  console.log(`   FAIL ${label}${detail ? ` - ${detail}` : ''}`)
}

const FP =
  '7B:8B:F0:65:5F:78:E2:51:3B:AC:6F:F3:3F:46:1B:35:DC:B8:5F:64:1A:24:C2:43:F0:A1:58:D0:A1:2C:19:08'

// Chrome after gathering, with a microphone open: a raw LAN address, an mDNS
// name, IPv6 and TCP - only the first two are worth carrying.
const chrome = `v=0
o=- 4611731400430051336 2 IN IP4 127.0.0.1
s=-
t=0 0
a=group:BUNDLE 0
a=extmap-allow-mixed
a=msid-semantic: WMS
m=application 9 UDP/DTLS/SCTP webrtc-datachannel
c=IN IP4 0.0.0.0
a=candidate:1467250027 1 udp 2122260223 192.168.1.23 51514 typ host generation 0 network-id 1 network-cost 10
a=candidate:2442956191 1 udp 2122194687 9b36eaac-bb2e-49bb-bb78-21c41c499900.local 60125 typ host generation 0 network-id 2
a=candidate:3121212121 1 udp 2122129151 fd00::1c2b:3a4d 51515 typ host generation 0 network-id 3
a=candidate:1467250027 1 tcp 1518280447 192.168.1.23 9 typ host tcptype active generation 0 network-id 1
a=ice-ufrag:VbTq
a=ice-pwd:m4gwbKpHDx9eWgm1FnD5ioq1
a=ice-options:trickle
a=fingerprint:sha-256 ${FP}
a=setup:actpass
a=mid:0
a=sctp-port:5000
a=max-message-size:262144
`.replace(/\n/g, '\r\n')

// Safari answering: mDNS only, `active`.
const safari = `v=0
o=- 7003262473441392823 2 IN IP4 127.0.0.1
s=-
t=0 0
a=group:BUNDLE 0
m=application 9 UDP/DTLS/SCTP webrtc-datachannel
c=IN IP4 0.0.0.0
a=candidate:842163049 1 udp 1677729535 1f2e3d4c-5b6a-4978-8695-a4b3c2d1e0f9.local 49152 typ host generation 0
a=ice-ufrag:Qx7k
a=ice-pwd:Zr8uY1nq2vX0bWc3dE4fG5hJ
a=fingerprint:sha-256 ${FP.split(':').reverse().join(':')}
a=setup:active
a=mid:0
a=sctp-port:5000
a=max-message-size:262144
`.replace(/\n/g, '\r\n')

// Firefox: longer credentials, the fingerprint at session level, UDP in capitals.
const firefox = `v=0
o=mozilla...THIS_IS_SDPARTA-128.0 5402874183942541712 0 IN IP4 0.0.0.0
s=-
t=0 0
a=fingerprint:sha-256 ${FP}
a=group:BUNDLE 0
a=ice-options:trickle
a=msid-semantic:WMS *
m=application 50000 UDP/DTLS/SCTP webrtc-datachannel
c=IN IP4 192.168.1.40
a=candidate:0 1 UDP 2122252543 192.168.1.40 50000 typ host
a=candidate:1 1 TCP 2105524479 192.168.1.40 9 typ host tcptype active
a=sendrecv
a=end-of-candidates
a=ice-pwd:e2b0b5d8a4ec1f1f0f2d7d3c5b9a1e8f
a=ice-ufrag:1a2b3c4d
a=mid:0
a=setup:actpass
a=sctp-port:5000
a=max-message-size:1073741823
`.replace(/\n/g, '\r\n')

console.log('--- one message each way ---')
for (const [name, sdp, kind] of [
  ['chrome offer', chrome, OFFER],
  ['safari answer', safari, ANSWER],
  ['firefox offer', firefox, OFFER],
]) {
  const signal = signalFromSdp(sdp)
  const nonce = 0xdeadbeef
  const bytes = packSignal({ kind, nonce, ...signal })
  const back = unpackSignal(bytes)
  check(`${name}: exactly one Wave message`, bytes.length === WAVE.messageBytes, `${bytes.length} bytes`)
  check(`${name}: unpacks`, back !== null)
  if (!back) continue
  check(`${name}: kind and nonce`, back.kind === kind && back.nonce === nonce)
  check(`${name}: credentials`, back.ufrag === signal.ufrag && back.pwd === signal.pwd)
  check(`${name}: fingerprint`, back.fingerprint.join() === signal.fingerprint.join())
  check(`${name}: setup`, back.setup === signal.setup)
  check(
    `${name}: candidates`,
    JSON.stringify(back.candidates) === JSON.stringify(signal.candidates),
    JSON.stringify(back.candidates),
  )

  // The rebuilt description carries everything ICE and DTLS need.
  const rebuilt = sdpFromSignal(back)
  check(`${name}: rebuilt ufrag`, rebuilt.includes(`a=ice-ufrag:${signal.ufrag}\r\n`))
  check(`${name}: rebuilt pwd`, rebuilt.includes(`a=ice-pwd:${signal.pwd}\r\n`))
  check(`${name}: rebuilt setup`, rebuilt.includes(`a=setup:${signal.setup}\r\n`))
  check(`${name}: rebuilt data channel`, rebuilt.includes('m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n'))
  for (const c of signal.candidates) {
    check(`${name}: rebuilt candidate ${c.address}`, rebuilt.includes(` udp 2122260223 ${c.address} ${c.port} typ host`))
  }
  console.log(`${name.padEnd(14)} ${signal.candidates.length} candidate(s), ${bytes.length} bytes`)
}

const chromeSignal = signalFromSdp(chrome)
check('only UDP host candidates, IPv6 left out', chromeSignal.candidates.length === 2, JSON.stringify(chromeSignal.candidates))
check('fingerprint in the SDP form', sdpFromSignal(chromeSignal).includes(`a=fingerprint:sha-256 ${FP}\r\n`))
check('firefox fingerprint found at session level', signalFromSdp(firefox).fingerprint.length === 32)

console.log('--- refusals ---')
const good = packSignal({ kind: OFFER, nonce: 1, ...chromeSignal })
for (const at of [0, 3, 40, 120, WAVE.messageBytes - 1]) {
  const bad = good.slice()
  bad[at] ^= 0x10
  check(`a flipped byte at ${at} is refused`, unpackSignal(bad) === null)
}
check('a Wave file block is refused', unpackSignal(new Uint8Array(WAVE.messageBytes).fill(7)) === null)
check('a short message is refused', unpackSignal(good.subarray(0, 60)) === null)

// Too many candidates: the ones that do not fit are dropped, never the message.
const crowded = {
  ...chromeSignal,
  candidates: Array.from({ length: 20 }, (_, i) => ({ address: `10.0.0.${i + 1}`, port: 40000 + i })),
}
const squeezed = unpackSignal(packSignal({ kind: OFFER, nonce: 2, ...crowded }))
check('crowded candidates still pack', squeezed !== null && squeezed.candidates.length > 0)
check('the first candidates are the ones kept', squeezed?.candidates[0].address === '10.0.0.1')
let threw = false
try {
  signalFromSdp(chrome.replace('sha-256', 'sha-1'))
} catch {
  threw = true
}
check('a fingerprint that is not sha-256 is refused', threw)

console.log('--- match number ---')
const a = chromeSignal.fingerprint
const b = signalFromSdp(safari).fingerprint
check('three digits', /^\d{3}$/.test(matchNumber(a, b)), matchNumber(a, b))
check('the same on both devices', matchNumber(a, b) === matchNumber(b, a))
console.log(`match ${matchNumber(a, b)}`)

console.log('--- the machine ---')
const outgoing = { name: 'a.bin', size: 5, digest: '', blocks: 0, waveMessages: Infinity, air: false }
let sender = transition(initialMachine(), { type: Event.FILE_READY, outgoing })
sender = transition(sender, { type: Event.CHOOSE_MODE, mode: 'wifi' })
check('sender: Wi-Fi starts sending', sender.state === State.TRANSFERRING_SEND && sender.context.mode === 'wifi')
check('sender: only the Wi-Fi link runs', JSON.stringify(resourcesFor(sender)) === JSON.stringify({ wifi: 'required', wakeLock: 'optional' }))
check('sender: Wi-Fi screen', screenFor(sender) === 'wifi')
check('sender: done confirms', transition(sender, { type: Event.DONE_SEEN }).context.confirmed === true)
const dropped = transition(sender, { type: Event.FAULT, reason: 'The connection dropped.' })
check('sender: retry on Wi-Fi from a failure', transition(dropped, { type: Event.CHOOSE_MODE, mode: 'wifi' }).state === State.TRANSFERRING_SEND)

let receiver = transition(initialMachine(), { type: Event.CHOOSE_RECEIVER })
receiver = transition(receiver, { type: Event.CHOOSE_MODE, mode: 'wifi' })
check('receiver: waits on Wi-Fi', receiver.state === State.AIMING && receiver.context.mode === 'wifi')
check('receiver: no camera, no Wave listener', JSON.stringify(resourcesFor(receiver)) === JSON.stringify({ wifi: 'required', wakeLock: 'optional' }))
check('receiver: Wi-Fi screen', screenFor(receiver) === 'wifi')
const hearing = transition(receiver, { type: Event.FRAMES_SEEN })
check('receiver: the link survives into receiving', resourcesFor(hearing).wifi === 'required' && screenFor(hearing) === 'wifi')

// Air and Wave are untouched.
let air = transition(transition(initialMachine(), { type: Event.FILE_READY, outgoing }), { type: Event.CHOOSE_MODE, mode: 'air' })
check('air still flashes', resourcesFor(air).emitter === 'required' && screenFor(air) === State.TRANSFERRING_SEND)
let wave = transition(transition(initialMachine(), { type: Event.CHOOSE_RECEIVER }), { type: Event.CHOOSE_MODE, mode: 'wave' })
check('wave still listens', resourcesFor(wave).listener === 'required' && screenFor(wave) === 'listening')

console.log(failures ? `\n${failures} check(s) failed` : '\nwifi ok')
process.exit(failures ? 1 : 0)
