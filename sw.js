/* Paint your Panaji: offline support.
   Online: always fetches the latest files (and refreshes the copy kept on the device).
   Offline: serves the copy kept on the device. */
const CACHE = 'paint-your-panaji-v10';
const CORE = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'manifest.webmanifest',
  'assets/panjim-outline.svg',
  'assets/icon.svg',
  'assets/icon-192.png',
  'assets/icon-512.png',
  'https://fonts.googleapis.com/css2?family=Baloo+2:wght@500;700;800&display=swap',
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // add one by one so a single missing file can't block the rest
    await Promise.all(CORE.map(u => c.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

const isFont = url => url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin && !isFont(url)) return;

  // Fonts never change: device copy first.
  if (isFont(url)) {
    e.respondWith((async () => {
      const c = await caches.open(CACHE);
      const hit = await c.match(req);
      if (hit) return hit;
      try { const r = await fetch(req); c.put(req, r.clone()); return r; }
      catch (_) { return new Response('', { status: 504 }); }
    })());
    return;
  }

  // App files: network first (so updates arrive), device copy if offline or slow.
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    try {
      const r = await Promise.race([
        fetch(req),
        new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 4000)),
      ]);
      if (r && r.ok) c.put(stripSearch(req, url), r.clone());
      return r;
    } catch (_) {
      const hit = await c.match(req, { ignoreSearch: true }) ||
                  (req.mode === 'navigate' && await c.match('index.html'));
      return hit || new Response('Offline and not saved on this device yet.', { status: 503 });
    }
  })());
});

// store "app.js?v=9" as "app.js" so the offline copy is found whatever the version tag
function stripSearch(req, url) {
  if (!url.search) return req;
  return new Request(url.origin + url.pathname);
}
