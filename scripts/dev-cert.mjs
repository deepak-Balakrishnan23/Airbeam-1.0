/**
 * Generate a self-signed certificate for the dev server.
 *
 * The receiver needs a camera, the camera needs a secure context, and the LAN
 * address the dev server prints is not one. Serving that same address over
 * HTTPS is - even with a certificate nothing trusts, once the warning is
 * accepted. That is the shortest path to a second device that can actually
 * receive.
 *
 * The certificate is written here byte by byte: a P-256 key from node:crypto,
 * and the X.509 structure encoded by hand in DER, which is a tag, a length and
 * the contents, nested. Every LAN address goes into subjectAltName, because
 * iOS ignores the common name entirely and matches on SAN alone, and the
 * certificate says it is for a TLS server, which Apple's clients also require.
 */

import { generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'

const dir = new URL('../.certs/', import.meta.url)
const keyFile = new URL('key.pem', dir)
const certFile = new URL('cert.pem', dir)

if (existsSync(keyFile) && existsSync(certFile)) {
  console.log('.certs/ already present, reusing it')
  process.exit(0)
}

// ------------------------------------------------------------------- DER --

function tlv(tag, ...parts) {
  const body = Buffer.concat(parts)
  const n = body.length
  const length = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff]
  return Buffer.concat([Buffer.from([tag, ...length]), body])
}
const sequence = (...parts) => tlv(0x30, ...parts)
const set = (...parts) => tlv(0x31, ...parts)
const integer = (bytes) => tlv(0x02, bytes[0] & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes)
const utf8 = (text) => tlv(0x0c, Buffer.from(text, 'utf8'))
const octets = (bytes) => tlv(0x04, bytes)
const bitString = (bytes) => tlv(0x03, Buffer.from([0]), bytes)
const explicit = (n, inner) => tlv(0xa0 | n, inner)
/** UTCTime, YYMMDDHHMMSSZ. */
const utcTime = (date) => tlv(0x17, Buffer.from(date.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'))

function oid(dotted) {
  const [first, second, ...rest] = dotted.split('.').map(Number)
  const out = [first * 40 + second]
  for (const value of rest) {
    const groups = [value & 0x7f]
    for (let v = value >>> 7; v; v >>>= 7) groups.unshift((v & 0x7f) | 0x80)
    out.push(...groups)
  }
  return tlv(0x06, Buffer.from(out))
}

// ----------------------------------------------------------- certificate --

const ECDSA_WITH_SHA256 = '1.2.840.10045.4.3.2'
const COMMON_NAME = '2.5.4.3'
const SUBJECT_ALT_NAME = '2.5.29.17'
const EXTENDED_KEY_USAGE = '2.5.29.37'
const BASIC_CONSTRAINTS = '2.5.29.19'
const SERVER_AUTH = '1.3.6.1.5.5.7.3.1'

const addresses = Object.values(networkInterfaces())
  .flat()
  .filter((n) => n && n.family === 'IPv4' && !n.internal)
  .map((n) => n.address)
const ips = ['127.0.0.1', ...addresses]

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const name = sequence(set(sequence(oid(COMMON_NAME), utf8('AirBeam dev'))))
const now = new Date()
const until = new Date(now.getTime() + 825 * 24 * 3600 * 1000)
const serial = randomBytes(16)
serial[0] &= 0x7f

const altNames = [
  tlv(0x82, Buffer.from('localhost')), // [2] dNSName
  ...ips.map((ip) => tlv(0x87, Buffer.from(ip.split('.').map(Number)))), // [7] iPAddress
]

const tbs = sequence(
  explicit(0, integer(Buffer.from([2]))), // version 3
  integer(serial),
  sequence(oid(ECDSA_WITH_SHA256)),
  name, // issuer: itself
  sequence(utcTime(now), utcTime(until)),
  name,
  publicKey.export({ type: 'spki', format: 'der' }),
  explicit(
    3,
    sequence(
      sequence(oid(SUBJECT_ALT_NAME), octets(sequence(...altNames))),
      sequence(oid(EXTENDED_KEY_USAGE), octets(sequence(oid(SERVER_AUTH)))),
      sequence(oid(BASIC_CONSTRAINTS), octets(sequence())), // not a CA
    ),
  ),
)
const certificate = sequence(tbs, sequence(oid(ECDSA_WITH_SHA256)), bitString(sign('sha256', tbs, privateKey)))

const pem = (label, der) =>
  `-----BEGIN ${label}-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`

mkdirSync(dir, { recursive: true })
writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
writeFileSync(certFile, pem('CERTIFICATE', certificate))

console.log(`wrote .certs/ for localhost, ${ips.join(', ')}`)
