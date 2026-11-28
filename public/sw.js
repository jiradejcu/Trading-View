// Service worker: makes the app installable and keeps working offline with the
// last data it saw. Bump VERSION to drop old caches.
const VERSION = 'v2';
const SHELL = `lagline-shell-${VERSION}`;
const DATA = `lagline-data-${VERSION}`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL).then((c) => c.addAll(['./', 'manifest.webmanifest', 'icons/icon-192.png'])),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== SHELL && k !== DATA).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

// Network first, falling back to the cache (used for pages and market data).
async function networkFirst(request, cacheName, fallbackUrl) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch (err) {
    const hit = (await cache.match(request)) || (fallbackUrl && (await cache.match(fallbackUrl)));
    if (hit) return hit;
    throw err;
  }
}

// Cache first, refreshing in the background (hashed JS/CSS, icons).
async function staleWhileRevalidate(request) {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(request);
  const fresh = fetch(request).then((res) => {
    if (res.ok) cache.put(request, res.clone());
    return res;
  });
  if (hit) {
    fresh.catch(() => {});
    return hit;
  }
  return fresh;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, SHELL, './'));
  } else if (url.pathname.includes('/api/') || url.pathname.includes('/data/')) {
    event.respondWith(networkFirst(request, DATA));
  } else {
    event.respondWith(staleWhileRevalidate(request));
  }
});
