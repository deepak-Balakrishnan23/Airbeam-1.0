/**
 * Offline shell for AirBeam.
 *
 * Network first for everything, the cache only when the network fails. There
 * is no build and so no content-hashed file names: a module keeps its name
 * across deploys, and serving it from the cache first would pin a visitor to
 * whatever they loaded the first time.
 *
 * It lives beside index.html because a worker's scope is the folder it is
 * served from. Nothing here touches transfer data. Files being sent never
 * leave the page.
 */

const CACHE = 'airbeam-v2'

/**
 * The app may be served from a subpath, so the shell URL is derived from the
 * worker's own registration rather than hardcoded to the domain root.
 */
const SHELL = new URL('./index.html', self.registration.scope).pathname

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll([self.registration.scope, SHELL]))
      .catch(() => {}),
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone()
          caches.open(CACHE).then((cache) => cache.put(request, copy))
        }
        return response
      })
      .catch(() =>
        caches.match(request).then((hit) => hit || (request.mode === 'navigate' ? caches.match(SHELL) : Response.error())),
      ),
  )
})
