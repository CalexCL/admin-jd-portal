const CACHE_NAME = 'myeden-jd-static-admin-v1.0.0'
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './portal-data.js',
  './manifest.webmanifest',
  './assets/icon.svg',
  './data/employee-data.json'
]

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin) return

  if (url.pathname.endsWith('/admin-config.json') || url.pathname.endsWith('/data/admin-data.enc.json')) {
    event.respondWith(fetch(event.request, { cache: 'no-store' }))
    return
  }

  if (url.pathname.endsWith('/data/employee-data.json') || url.pathname.endsWith('/portal-data.js') || url.pathname.endsWith('/app.js')) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone()
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy))
          return response
        })
        .catch(() => caches.match(event.request))
    )
    return
  }

  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match('./index.html')))
    return
  }

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => {
      if (response.ok) {
        const copy = response.clone()
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy))
      }
      return response
    }))
  )
})
