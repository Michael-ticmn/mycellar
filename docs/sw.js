// Service worker for cellar27 PWA.
//
// Strategy:
// - Version is the single source of truth: see version.js.
//   Bumping it changes the SW bytes (via importScripts), browser installs
//   a new SW, controllerchange fires on the client, page reloads.
// - App shell (HTML/CSS/JS/views/icons) cached cache-first, keyed by version.
// - Cross-origin (Supabase REST/Realtime, jsDelivr CDN) → network-only.

importScripts('./version.js');
const CACHE_VERSION = `cellar27-${self.CELLAR_VERSION}`;
const SHELL = [
  './',
  './index.html',
  './version.js',
  './css/styles.css',
  './js/app.js',
  './js/auth.js',
  './js/bottles.js',
  './js/pairings.js',
  './js/scan.js',
  './js/supabase-client.js',
  './js/varietal-windows.js',
  './views/cellar.html',
  './views/add.html',
  './views/scan.html',
  './views/pairing.html',
  './views/flight.html',
  './views/drink-now.html',
  './manifest.webmanifest',
  './icon.svg',
  './icon-maskable.svg',
  './config.public.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
    // Tell every controlled page that a new version is now live.
    const clients = await self.clients.matchAll({ includeUncontrolled: true });
    for (const c of clients) c.postMessage({ type: 'sw-activated', version: self.CELLAR_VERSION });
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return res;
      }).catch(() => cached || Response.error());
    })
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});
