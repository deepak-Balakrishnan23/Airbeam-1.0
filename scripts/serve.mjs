/**
 * The dev server: the repository as it stands, over HTTPS once
 * `npm run dev:https` has made a certificate, over HTTP otherwise.
 *
 * There is no build. Browsers load the modules as they are, so all this has
 * to do is hand files out with the right type and never let them go stale.
 *
 *   node scripts/serve.mjs            HTTPS if .certs/ exists
 *   node scripts/serve.mjs --http     plain HTTP regardless
 *
 * Plain HTTP is a secure context on localhost only, so a phone needs HTTPS.
 */

import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { networkInterfaces } from 'node:os'

const root = fileURLToPath(new URL('..', import.meta.url))
const port = Number(process.env.PORT ?? 5173)
const key = join(root, '.certs', 'key.pem')
const cert = join(root, '.certs', 'cert.pem')
const secure = !process.argv.includes('--http') && existsSync(key) && existsSync(cert)

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.md': 'text/plain; charset=utf-8',
}

async function handle(request, response) {
  let path
  try {
    path = decodeURIComponent(new URL(request.url, 'http://host').pathname)
  } catch {
    path = '/'
  }
  if (path.endsWith('/')) path += 'index.html'
  const file = normalize(join(root, path))
  // Never outside the repository, and never a dotfile: .certs/ holds the
  // private key, and this server answers the whole LAN.
  const hidden = file.slice(root.length).split(sep).some((part) => part.startsWith('.'))
  if (!file.startsWith(root) || hidden) return notFound(response)
  try {
    const body = await readFile(file)
    response.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    })
    response.end(request.method === 'HEAD' ? undefined : body)
  } catch {
    notFound(response)
  }
}

function notFound(response) {
  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  response.end('Not found')
}

const server = secure
  ? createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, handle)
  : createHttpServer(handle)

server.listen(port, '0.0.0.0', () => {
  const scheme = secure ? 'https' : 'http'
  const lan = Object.values(networkInterfaces())
    .flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => `${scheme}://${n.address}:${port}/`)
  console.log(`AirBeam on ${scheme}://localhost:${port}/`)
  for (const url of lan) console.log(`         and ${url}`)
  if (!secure) console.log('Plain HTTP: a phone cannot use its camera here. Run `npm run dev:https` for that.')
})
