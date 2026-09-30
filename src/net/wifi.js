/**
 * Wi-Fi: the file over a direct WebRTC data channel on the local network.
 *
 * The fast one of the three. Air and Wave carry the file itself; this carries
 * only a handshake over sound, one Wave message each way, and then the file
 * goes device to device over the LAN, encrypted by DTLS.
 *
 * ## Why a handshake, and why by sound
 *
 * A browser cannot find another device on a network by itself: no broadcast,
 * no mDNS browsing. Two peers have to swap an offer and an answer first, and
 * the usual way is a server. There is none here, so the swap goes over Wave,
 * which needs no aiming and no code to type. Everything a data channel needs
 * from the other side - ICE credentials, the DTLS fingerprint and the host
 * addresses - fits in one 140-byte message, and the rest of the SDP is the
 * same for every data channel, so it is rebuilt rather than sent.
 *
 *   0   2  magic 'WF'
 *   2   1  kind: 1 offer, 2 answer
 *   3   4  nonce, the offer's; the answer repeats it
 *   7   .  ufrag (length byte + ASCII), pwd (length byte + ASCII)
 *   .  32  sha-256 fingerprint
 *   .   1  DTLS setup: actpass, active, passive
 *   .   .  candidate count, then each: tag (4 IPv4, 1 mDNS) + 4 or 16 bytes + port
 *   136 4  CRC-32 of everything before it
 *
 * ## Taking turns on one channel
 *
 * Both devices play and listen through the same air. The sender plays its
 * offer and then leaves a gap; the receiver answers the moment an offer ends,
 * inside that gap. An answer that is lost to a collision is simply given again
 * after the next offer, so the handshake heals itself.
 */

import { WAVE } from '../config.js'
import { loadModem, startWaveListener, unlockAudio } from '../audio/wave.js'
import { crc32 } from '../optical/fountain.js'
import { readU32, writeU32 } from '../lib/bytes.js'

export const OFFER = 1
export const ANSWER = 2

/**
 * Wi-Fi's own file cap. The receiver holds the file until it is saved; past a
 * gigabyte a phone's browser tab is the thing likely to give out.
 */
export const MAX_FILE_BYTES = 1024 * 1024 * 1024

/** Silence after each offer, for the answer: it starts as the offer ends and lasts as long. */
const GAP_SECONDS = 2.5
/** From the first chirp (sender) or the first offer heard (receiver) to an open channel. */
const CONNECT_MS = 20_000
/** Bytes per data channel message; 64 KB is within every current browser's limit. */
const CHUNK = 64 * 1024
/** Bytes read from the file at a time. */
const READ = 1024 * 1024
/** Stop queueing above this much unsent, carry on below the lower mark. */
const HIGH = 4 * 1024 * 1024
const LOW = 1024 * 1024
/** Received chunks are folded into a Blob this often, which a browser may keep on disk. */
const FOLD = 16 * 1024 * 1024

const MAGIC = [0x57, 0x46]
const SETUPS = ['actpass', 'active', 'passive']
const HOST_PRIORITY = 2122260223
const UNREACHABLE =
  'Could not reach the other device over Wi-Fi. Both need to be on the same network, and some ' +
  'guest or office networks keep devices apart. Try light or sound instead.'
const HELLO = 'Wi-Fi connects with a short chirp, so it needs the microphone for a moment.'

// ------------------------------------------------------------------ signal --

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
const MDNS = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\.local$/i

/**
 * What the other side needs out of a local description.
 *
 * Only UDP host candidates: there is no STUN server, so there is nothing
 * else, and a TCP candidate only duplicates a UDP one. IPv6 is left out.
 * Known limit: IPv4 and mDNS cover home and office Wi-Fi; add IPv6 (16 bytes a
 * candidate) if an IPv6-only network turns up.
 */
export function signalFromSdp(sdp) {
  const line = (name) => sdp.match(new RegExp(`^a=${name}:(.+?)\\s*$`, 'm'))?.[1]
  const ufrag = line('ice-ufrag')
  const pwd = line('ice-pwd')
  const fp = line('fingerprint')
  if (!ufrag || !pwd || !fp) throw new Error('The connection offer is missing its credentials.')
  const [algorithm, hex] = fp.split(/\s+/)
  if (algorithm.toLowerCase() !== 'sha-256') throw new Error(`Unsupported DTLS fingerprint: ${algorithm}.`)
  const fingerprint = Uint8Array.from(hex.split(':'), (byte) => parseInt(byte, 16))
  const setup = line('setup') ?? 'actpass'

  const candidates = []
  for (const m of sdp.matchAll(/^a=candidate:\S+ 1 udp \d+ (\S+) (\d+) typ host/gim)) {
    if (IPV4.test(m[1]) || MDNS.test(m[1])) candidates.push({ address: m[1].toLowerCase(), port: Number(m[2]) })
  }
  // A raw address first: it needs no name resolution on the other side.
  candidates.sort((a, b) => IPV4.test(b.address) - IPV4.test(a.address))
  return { ufrag, pwd, fingerprint, setup, candidates }
}

/** One Wave message. Candidates that do not fit are dropped from the end. */
export function packSignal({ kind, nonce, ufrag, pwd, fingerprint, setup, candidates }) {
  const size = WAVE.messageBytes
  const out = new Uint8Array(size)
  const end = size - 4
  let at = 0
  const put = (...bytes) => {
    if (at + bytes.length > end) throw new Error('The connection details do not fit one message.')
    out.set(bytes, at)
    at += bytes.length
  }
  const text = (s) => put(s.length, ...Array.from(s, (c) => c.charCodeAt(0) & 0x7f))

  put(...MAGIC, kind)
  writeU32(out, at, nonce)
  at += 4
  text(ufrag)
  text(pwd)
  if (fingerprint.length !== 32) throw new Error('Expected a sha-256 fingerprint.')
  put(...fingerprint, Math.max(0, SETUPS.indexOf(setup)))

  const countAt = at
  put(0)
  for (const { address, port } of candidates) {
    const v4 = address.match(IPV4)
    const bytes = v4
      ? [4, ...v4.slice(1).map(Number)]
      : [1, ...address.match(MDNS).slice(1).join('').match(/../g).map((h) => parseInt(h, 16))]
    bytes.push(port >> 8, port & 0xff)
    if (at + bytes.length > end) break
    put(...bytes)
    out[countAt]++
  }
  writeU32(out, end, crc32(out.subarray(0, end), 0))
  return out
}

/** A heard message, or null when it is not an intact Wi-Fi signal. */
export function unpackSignal(bytes) {
  const size = WAVE.messageBytes
  if (bytes?.length !== size || bytes[0] !== MAGIC[0] || bytes[1] !== MAGIC[1]) return null
  if (crc32(bytes.subarray(0, size - 4), 0) !== readU32(bytes, size - 4)) return null
  const kind = bytes[2]
  if (kind !== OFFER && kind !== ANSWER) return null
  let at = 7
  const text = () => {
    const n = bytes[at++]
    const s = String.fromCharCode(...bytes.subarray(at, at + n))
    at += n
    return s
  }
  const ufrag = text()
  const pwd = text()
  const fingerprint = bytes.slice(at, at + 32)
  at += 32
  const setup = SETUPS[bytes[at++]]
  if (!setup || !ufrag || !pwd) return null
  const candidates = []
  for (let i = bytes[at++]; i > 0; i--) {
    const tag = bytes[at++]
    let address
    if (tag === 4) {
      address = Array.from(bytes.subarray(at, at + 4)).join('.')
      at += 4
    } else if (tag === 1) {
      const h = Array.from(bytes.subarray(at, at + 16), (b) => b.toString(16).padStart(2, '0')).join('')
      address = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}.local`
      at += 16
    } else {
      return null
    }
    candidates.push({ address, port: (bytes[at] << 8) | bytes[at + 1] })
    at += 2
  }
  if (at > size - 4) return null
  return { kind, nonce: readU32(bytes, 3), ufrag, pwd, fingerprint, setup, candidates }
}

/** The description the other side's browser will accept, from a signal. */
export function sdpFromSignal({ nonce = 0, ufrag, pwd, fingerprint, setup, candidates }) {
  const fp = Array.from(fingerprint, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':')
  return [
    'v=0',
    `o=- ${nonce} 2 IN IP4 127.0.0.1`,
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    `a=ice-ufrag:${ufrag}`,
    `a=ice-pwd:${pwd}`,
    `a=fingerprint:sha-256 ${fp}`,
    `a=setup:${setup}`,
    'a=mid:0',
    'a=sctp-port:5000',
    'a=max-message-size:262144',
    ...candidates.map((c, i) => `a=candidate:${i + 1} 1 udp ${HOST_PRIORITY} ${c.address} ${c.port} typ host`),
    'a=end-of-candidates',
    '',
  ].join('\r\n')
}

/**
 * Three digits both screens show, from both fingerprints in a fixed order. A
 * different number on the other screen means some other device answered.
 */
export function matchNumber(a, b) {
  const [first, second] = a.join() < b.join() ? [a, b] : [b, a]
  const both = new Uint8Array(64)
  both.set(first)
  both.set(second, 32)
  return String(crc32(both, 0) % 1000).padStart(3, '0')
}

// ----------------------------------------------------------------- browser --

/** The local signal, once the host candidates are in the description. */
function gathered(pc) {
  return new Promise((resolve) => {
    const finish = () => resolve(signalFromSdp(pc.localDescription.sdp))
    if (pc.iceGatheringState === 'complete') return finish()
    pc.addEventListener('icegatheringstatechange', () => pc.iceGatheringState === 'complete' && finish())
    // Known limit: host-only gathering takes milliseconds; this only caps a stuck mDNS registration.
    setTimeout(finish, 2000)
  })
}

/**
 * One message, ready to play on demand. Played through the context the tap
 * unlocked, without switching the audio session to playback: the microphone
 * has to keep listening while it plays.
 */
async function chirper(bytes) {
  const ctx = unlockAudio()
  if (!ctx) throw new Error('This browser cannot play generated sound.')
  const samples = (await loadModem(ctx.sampleRate)).encode(bytes)
  let node = null
  return {
    seconds: samples.length / ctx.sampleRate,
    play() {
      const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate)
      buffer.getChannelData(0).set(samples)
      node = ctx.createBufferSource()
      node.buffer = buffer
      node.connect(ctx.destination)
      node.start()
    },
    stop() {
      try {
        node?.stop()
      } catch {
        /* never started */
      }
    },
  }
}

/** The microphone, or an error that says why Wi-Fi needs it. */
async function listen(onMessage) {
  let refused = null
  const listener = await startWaveListener(onMessage, { onError: (reason) => (refused = reason) })
  // The sound listener's refusal speaks of receiving by sound; say the blocked case for Wi-Fi.
  if (refused) throw new Error(`${HELLO} ${/blocked/i.test(refused) ? 'Allow the microphone for this site, or send by light instead.' : refused}`)
  return listener
}

/** How the two signals travel. Sound, except in the one-tab harness. */
const SOUND = { listen, chirper }

const drained = (channel) =>
  new Promise((resolve) => {
    channel.addEventListener('bufferedamountlow', resolve, { once: true })
    channel.addEventListener('close', resolve, { once: true })
  })

/**
 * Send `file`. Hooks: onPhase({phase, match}), onProgress({sent, size, rate}),
 * onDone() once the receiver has every byte, onError(reason).
 *
 * Nothing is sent until `confirm()`. Whoever answers the chirp first gets the
 * connection, and anyone in earshot can answer, so the person sending checks
 * the other screen shows the same match number before a byte leaves.
 */
export async function startWifiSender(file, { onPhase, onProgress, onDone, onError }, via = SOUND) {
  let stopped = false
  let finished = false
  let opened = false
  let timer = 0
  let nonce = null
  let mine = null
  let match = null
  let chirp = null

  // The microphone before the connection: with a capture running, browsers
  // offer the real LAN address instead of only an mDNS name.
  const listener = await via.listen((bytes) => heard(bytes))
  const pc = new RTCPeerConnection({ iceServers: [] })
  const channel = pc.createDataChannel('file')

  const quiet = () => {
    clearTimeout(timer)
    chirp?.stop()
    listener.stop()
  }
  const fail = (reason) => {
    if (stopped || finished) return
    stopped = true
    clearTimeout(deadline)
    quiet()
    pc.close()
    onError(reason)
  }
  const deadline = setTimeout(() => fail(UNREACHABLE), CONNECT_MS)

  async function heard(bytes) {
    const signal = unpackSignal(bytes)
    if (!signal || signal.kind !== ANSWER || signal.nonce !== nonce || match || stopped) return
    match = matchNumber(mine.fingerprint, signal.fingerprint)
    try {
      await pc.setRemoteDescription({ type: 'answer', sdp: sdpFromSignal(signal) })
      onPhase({ phase: 'connecting', match })
    } catch (error) {
      fail(`The other device's answer did not work: ${error?.message || error}`)
    }
  }

  async function send() {
    const chunk = Math.min(CHUNK, pc.sctp?.maxMessageSize || 16 * 1024)
    channel.bufferedAmountLowThreshold = LOW
    channel.send(JSON.stringify({ name: file.name, type: file.type, size: file.size }))
    const started = performance.now()
    for (let offset = 0; offset < file.size && !stopped; offset += READ) {
      const bytes = new Uint8Array(await file.slice(offset, offset + READ).arrayBuffer())
      for (let i = 0; i < bytes.length && !stopped; i += chunk) {
        if (channel.bufferedAmount > HIGH) await drained(channel)
        if (stopped) return
        channel.send(bytes.slice(i, i + chunk))
      }
      const sent = offset + bytes.length
      onProgress({ phase: 'sending', match, sent, size: file.size, rate: sent / ((performance.now() - started) / 1000) })
    }
  }

  channel.binaryType = 'arraybuffer'
  channel.onopen = () => {
    opened = true
    clearTimeout(deadline)
    quiet()
    onPhase({ phase: 'confirm', match })
  }
  channel.onmessage = (event) => {
    if (event.data !== 'done' || finished) return
    finished = true
    onDone()
  }
  channel.onclose = () => fail('The connection dropped before the whole file was across.')

  await pc.setLocalDescription(await pc.createOffer())
  mine = await gathered(pc)
  nonce = crypto.getRandomValues(new Uint32Array(1))[0]
  chirp = await via.chirper(packSignal({ kind: OFFER, nonce, ...mine }))
  const loop = () => {
    if (stopped || opened) return
    chirp.play()
    timer = setTimeout(loop, (chirp.seconds + GAP_SECONDS) * 1000)
  }
  loop()
  onPhase({ phase: 'hello' })

  let confirmed = false
  return {
    /** The person sending has checked the match number: start. */
    confirm() {
      if (confirmed || !opened || stopped) return
      confirmed = true
      send().catch((error) => fail(`Sending stopped: ${error?.message || error}`))
    },
    stop() {
      stopped = true
      clearTimeout(deadline)
      quiet()
      pc.close()
    },
  }
}

/**
 * Wait for a sender, answer it, and receive. Hooks: onPhase({phase, match}),
 * onProgress({have, size, rate}), onFile({name, type, size, bytes, digest}),
 * onError(reason).
 */
export async function startWifiReceiver({ onPhase, onProgress, onFile, onError }, via = SOUND) {
  let stopped = false
  let opened = false
  let done = false
  let pc = null
  let channel = null
  let nonce = null
  let answer = null
  let match = null
  let deadline = 0

  const listener = await via.listen((bytes) => heard(bytes).catch((error) => fail(String(error?.message || error))))

  const quiet = () => {
    answer?.stop()
    listener.stop()
  }
  const fail = (reason) => {
    if (stopped || done) return
    stopped = true
    clearTimeout(deadline)
    quiet()
    pc?.close()
    onError(reason)
  }

  async function heard(bytes) {
    if (opened || stopped) return
    const signal = unpackSignal(bytes)
    if (!signal || signal.kind !== OFFER) return
    if (signal.nonce !== nonce) {
      // The first offer, or a sender that started over: a fresh connection.
      nonce = signal.nonce
      answer?.stop()
      answer = null
      pc?.close()
      const peer = (pc = new RTCPeerConnection({ iceServers: [] }))
      peer.ondatachannel = (event) => receive(event.channel)
      await peer.setRemoteDescription({ type: 'offer', sdp: sdpFromSignal(signal) })
      await peer.setLocalDescription(await peer.createAnswer())
      const mine = await gathered(peer)
      const reply = await via.chirper(packSignal({ kind: ANSWER, nonce: signal.nonce, ...mine }))
      if (peer !== pc || stopped) return // superseded while this was being built
      answer = reply
      match = matchNumber(signal.fingerprint, mine.fingerprint)
      onPhase({ phase: 'connecting', match })
      clearTimeout(deadline)
      deadline = setTimeout(() => fail(UNREACHABLE), CONNECT_MS)
    }
    // Every offer heard gets the answer at once, into the sender's gap.
    answer?.play()
  }

  function receive(incoming) {
    channel = incoming
    channel.binaryType = 'arraybuffer'
    let header = null
    let received = 0
    let started = 0
    let reported = 0
    const folded = []
    let batch = []
    let batchBytes = 0

    const open = () => {
      opened = true
      clearTimeout(deadline)
      quiet()
      onPhase({ phase: 'confirm', match })
    }
    if (channel.readyState === 'open') open()
    else channel.onopen = open

    channel.onmessage = ({ data }) => {
      if (done) return
      if (typeof data === 'string') {
        header = parseHeader(data)
        if (!header) return fail('The other device sent something that is not a file.')
        started = performance.now()
        return onProgress({ phase: 'receiving', match, have: 0, size: header.size, rate: 0 })
      }
      if (!header) return
      batch.push(data)
      batchBytes += data.byteLength
      received += data.byteLength
      if (batchBytes >= FOLD) {
        folded.push(new Blob(batch))
        batch = []
        batchBytes = 0
      }
      const now = performance.now()
      if (received < header.size && now - reported < 200) return
      reported = now
      onProgress({ phase: 'receiving', match, have: received, size: header.size, rate: received / ((now - started) / 1000 || 1) })
      if (received < header.size) return
      done = true
      channel.send('done')
      const type = header.type || 'application/octet-stream'
      onFile({ name: header.name, type, size: received, bytes: new Blob([...folded, ...batch], { type }), digest: '' })
    }
    channel.onclose = () => fail('The connection dropped before the whole file arrived.')
  }

  return {
    stop() {
      const finished = done
      stopped = true
      clearTimeout(deadline)
      quiet()
      channel?.close()
      // Closing the channel still sends what is queued, 'done' included; the
      // connection goes a moment later. Known limit: a fixed second, an explicit
      // acknowledgement if a sender is ever seen to miss it.
      const peer = pc
      if (finished) setTimeout(() => peer?.close(), 1000)
      else peer?.close()
    },
  }
}

/** The file's description, checked: it came from another device. */
function parseHeader(text) {
  try {
    const { name, type, size } = JSON.parse(text)
    if (typeof name !== 'string' || typeof type !== 'string') return null
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_FILE_BYTES) return null
    return { name: name.slice(0, 255), type: type.slice(0, 255), size }
  } catch {
    return null
  }
}
