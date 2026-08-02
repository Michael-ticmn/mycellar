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
  './js/dist/app.bundle.js',
  './views/cellar.html',
  './views/add.html',
  './views/manage.html',
  './views/pairing.html',
  './views/flight.html',
  './views/drink-now.html',
  './views/share.html',
  './views/guest.html',
  './views/planned.html',
  './views/bottle.html',
  './vendor/qrcode.min.js',
  './manifest.webmanifest',
  './icon.svg',
  './icon-maskable.svg',
  './config.public.js',
];

self.addEventListener('install', (event) => {
  // Do NOT call skipWaiting() here — we want the new SW to enter the
  // 'waiting' state so the page can show an "Update ready" banner. The
  // page sends a 'skipWaiting' message on user tap, which is handled
  // by the message listener below.
  //
  // cache:'reload' on each Request forces the install fetch to bypass
  // the browser's HTTP cache. Without it, addAll happily caches stale
  // bytes that the browser had from a prior visit — symptom is "new
  // version label, but CSS/view changes haven't taken effect."
  // Individual put()s rather than addAll(), for two reasons.
  //
  // 1. addAll is one atomic batch, and it rejects with InvalidAccessError
  //    ("Entry already exists") if anything else writes the same cache key
  //    while the batch is open. That happens on a first visit to a route whose
  //    view is also in SHELL — the page fetches views/guest.html, the fetch
  //    handler below put()s it, and the concurrent addAll blows up. Install
  //    then fails entirely: no offline shell, and no update banner until a
  //    later visit happens not to race.
  // 2. addAll is all-or-nothing, so one 404 in SHELL would sink the whole
  //    install. A missing view is worth skipping, not failing over.
  //
  // cache:'reload' still bypasses the HTTP cache, so we don't install stale
  // bytes — that part is unchanged and load-bearing.
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    await Promise.all(SHELL.map(async (url) => {
      try {
        const res = await fetch(new Request(url, { cache: 'reload' }));
        if (res && res.ok) await cache.put(url, res);
        else console.warn('[cellar27 sw] skipped', url, res && res.status);
      } catch (e) {
        console.warn('[cellar27 sw] failed to cache', url, e);
      }
    }));
  })());
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

  // HTML / views → network-first. Means a content tweak shows up immediately
  // on the next view load without waiting for a SW activation cycle. Falls
  // back to cache for offline.
  const isHTML = request.destination === 'document'
              || /\.(html|webmanifest)$/i.test(url.pathname)
              || url.pathname.endsWith('/');
  if (isHTML) {
    event.respondWith((async () => {
      try {
        const res = await fetch(request);
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return res;
      } catch {
        const cached = await caches.match(request);
        return cached || Response.error();
      }
    })());
    return;
  }

  // Everything else (JS, CSS, icons, …) → cache-first, keyed by CACHE_VERSION.
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
