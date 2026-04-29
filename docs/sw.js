// Service worker for cellar27 PWA.
//
// Strategy:
// - App shell (HTML/CSS/JS/views/icons) cached with cache-first.
// - Bump CACHE_VERSION when shell changes; old caches are purged on activate.
// - Everything else (Supabase REST, Realtime, third-party CDN) goes
//   network-only — never cache user data or auth-bearing requests.

const CACHE_VERSION = 'cellar27-v2';
const SHELL = [
  './',
  './index.html',
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
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never cache cross-origin (Supabase, jsDelivr CDN). Always go to network.
  if (url.origin !== self.location.origin) return;

  // Cache-first for the app shell. Fall through to network for anything else
  // we serve from the same origin (e.g. config.local.js if present).
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((res) => {
        // Opportunistically cache successful same-origin GETs (helps offline-load
        // for files that aren't in the static SHELL list).
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return res;
      }).catch(() => cached || Response.error());
    })
  );
});

// Allow the page to trigger an immediate update.
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});
