/* Road to C1 — service worker: offline app shell, background updates. */
const VERSION = 'rc1-v2';
const SHELL = [
  './', 'index.html', 'app.js', 'data.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-192.png', 'icons/maskable-512.png',
  'icons/apple-touch-icon.png', 'icons/favicon-32.png',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' bypasses the HTTP cache so a new version never precaches stale files
  e.waitUntil(caches.open(VERSION)
    .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// A redirected response must not be used to answer a navigation, or Chrome refuses to open the page.
const clean = (res) => (res && res.redirected
  ? res.blob().then((b) => new Response(b, { status: res.status, statusText: res.statusText, headers: res.headers }))
  : Promise.resolve(res));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || !url.pathname.startsWith(new URL('./', location).pathname)) return;

  if (req.mode === 'navigate') {
    // Network first (fresh app), fall back to the cached shell when offline.
    e.respondWith((async () => {
      const cache = await caches.open(VERSION);
      try {
        const res = await fetch(req);
        if (res.ok) { const c = await clean(res.clone()); await cache.put('index.html', c.clone()); return clean(res); }
        const cached = await cache.match('index.html');
        return cached || res;
      } catch (err) {
        return (await cache.match('index.html')) || (await cache.match('./')) || Response.error();
      }
    })());
    return;
  }

  // Assets: cache first, refresh in the background.
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const cached = await cache.match(req, { ignoreSearch: true });
    const network = fetch(req).then(async (res) => {
      if (res.ok && res.type === 'basic') await cache.put(req, (await clean(res.clone())));
      return res;
    });
    if (cached) { e.waitUntil(network.catch(() => {})); return cached; }
    try { return await network; } catch (err) { return Response.error(); }
  })());
});
