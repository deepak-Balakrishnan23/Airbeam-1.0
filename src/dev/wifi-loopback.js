/**
 * Wi-Fi in one tab, at /?wifi-loopback (`&bytes=` sets the file size).
 *
 * Both ends of the link run here, with the two signals handed across directly
 * instead of chirped. Everything else is the production path: the SDP packed
 * into one Wave message and rebuilt from it, real RTCPeerConnections, the data
 * channel with its backpressure, and the receiver's checks.
 *
 * What it proves: the rebuilt descriptions are accepted and connect, and the
 * bytes arrive whole. What it cannot: the sound hello between two devices, or
 * Wi-Fi speed - both ends share one machine, so the rate is an upper bound.
 *
 * One substitution: an mDNS candidate is handed over as 127.0.0.1. With no
 * microphone open a browser offers only `<uuid>.local` names, and some
 * embedded browsers cannot resolve even their own. The app always has the
 * microphone open by then, which makes browsers offer the real address.
 */

import { startWifiSender, startWifiReceiver, packSignal, unpackSignal } from '../net/wifi.js'
import { sha256Hex, formatBytes } from '../lib/bytes.js'
import { h, stat } from '../ui/dom.js'

/** What either end plays, both hear a moment later - as over the air. */
function bus() {
  const ears = new Set()
  return {
    async listen(onMessage) {
      ears.add(onMessage)
      return { stop: () => ears.delete(onMessage) }
    },
    async chirper(bytes) {
      const signal = unpackSignal(bytes)
      signal.candidates = signal.candidates.map((c) => (c.address.endsWith('.local') ? { ...c, address: '127.0.0.1' } : c))
      const heard = packSignal(signal)
      return { seconds: 0.05, play: () => setTimeout(() => ears.forEach((ear) => ear(heard.slice())), 20), stop() {} }
    },
  }
}

function randomBytes(n) {
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(i + 65536, n)))
  return out
}

export async function runWifiLoopback(root) {
  const size = Number(new URLSearchParams(location.search).get('bytes')) || 50 * 1024 * 1024
  const line = h('p', {}, `Sending ${formatBytes(size)} to this tab over a data channel…`)
  const stats = h('dl', {})
  root.replaceChildren(h('div', { class: 'screen' }, h('h2', {}, 'Wi-Fi loopback'), line, stats))

  const source = randomBytes(size)
  const file = new File([source], 'loopback.bin', { type: 'application/octet-stream' })
  const via = bus()
  const started = performance.now()
  let connectedAt = 0
  let receiver = null
  let sender = null
  let confirm
  const confirmed = new Promise((resolve) => (confirm = resolve))

  const result = await new Promise((resolve) => {
    const fail = (reason) => resolve({ ok: false, reason })
    startWifiReceiver(
      {
        onPhase() {},
        onProgress(p) {
          connectedAt ||= performance.now()
          line.textContent = `${formatBytes(p.have)} of ${formatBytes(p.size)}, ${formatBytes(p.rate)}/s`
        },
        onFile: (incoming) => resolve({ ok: true, incoming }),
        onError: fail,
      },
      via,
    )
      .then((handle) => {
        receiver = handle
        // The person who would check the match number, standing in.
        const onPhase = (p) => p.phase === 'confirm' && setTimeout(() => sender.confirm())
        return startWifiSender(file, { onPhase, onProgress() {}, onDone: () => confirm(true), onError: fail }, via)
      })
      .then((handle) => (sender = handle))
      .catch((error) => fail(String(error?.message || error)))
  })

  const finished = performance.now()
  let summary
  if (result.ok) {
    // What the sender shows as Delivered: the receiver's 'done', read back.
    const delivered = await Promise.race([confirmed, new Promise((resolve) => setTimeout(() => resolve(false), 3000))])
    const same = (await sha256Hex(new Uint8Array(await result.incoming.bytes.arrayBuffer()))) === (await sha256Hex(source))
    const seconds = (finished - connectedAt) / 1000
    summary = {
      ok: same && delivered,
      delivered,
      bytes: result.incoming.size,
      connectMs: Math.round(connectedAt - started),
      transferSeconds: Number(seconds.toFixed(2)),
      bytesPerSecond: Math.round(result.incoming.size / seconds),
    }
    line.textContent = same ? 'Arrived whole.' : 'Arrived, but the bytes differ.'
    stats.replaceChildren(
      stat('Size', formatBytes(summary.bytes)),
      stat('Connect', `${summary.connectMs} ms`),
      stat('Transfer', `${summary.transferSeconds} s`),
      stat('Rate', `${formatBytes(summary.bytesPerSecond)}/s`),
    )
  } else {
    summary = { ok: false, reason: result.reason }
    line.textContent = `Failed: ${result.reason}`
  }
  // Give the receiver's 'done' a moment to reach the sender before both close.
  setTimeout(() => {
    sender?.stop()
    receiver?.stop()
  }, 1500)
  window.__wifiLoopback = summary
  return summary
}
