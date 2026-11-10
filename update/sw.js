// Offline support: app shell + campsite data are precached; map tiles you have
// viewed are cached as you browse (so pan/zoom your trip area on Wi-Fi first).
// Our own files are fetched fresh whenever you are online (so updates show up
// on the next open) and fall back to the saved copy when you are not.
const VERSION = 'v3';
const SHELL = 'adk-shell-' + VERSION;
const TILES = 'adk-tiles-v1';
const MAX_TILES = 4000;
const NET_WAIT_MS = 3000; // on a weak signal, give up waiting after this long and use the saved copy

const SHELL_FILES = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'manifest.webmanifest',
  'data/campsites.json',
  'vendor/leaflet/leaflet.js',
  'vendor/leaflet/leaflet.css',
  'vendor/leaflet/images/layers.png',
  'vendor/leaflet/images/layers-2x.png',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

const TILE_HOSTS = ['tile.openstreetmap.org', 'tile.opentopomap.org'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(SHELL_FILES.map((f) => new Request(f, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== SHELL && k !== TILES).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

async function trimTiles(cache) {
  const keys = await cache.keys();
  if (keys.length > MAX_TILES) {
    await Promise.all(keys.slice(0, keys.length - MAX_TILES).map((k) => cache.delete(k)));
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Map tiles: cache-first, fill the cache as the user browses.
  if (TILE_HOSTS.some((h) => url.hostname.endsWith(h))) {
    event.respondWith(
      caches.open(TILES).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        try {
          const res = await fetch(req);
          if (res && res.ok) {
            cache.put(req, res.clone());
            if (Math.random() < 0.05) trimTiles(cache);
          }
          return res;
        } catch (err) {
          return new Response('', { status: 504, statusText: 'offline' });
        }
      })
    );
    return;
  }

  // Our own files: network first (always the newest copy), saved copy as the fallback.
  if (url.origin === self.location.origin) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(SHELL);
        const net = fetch(req, { cache: 'no-cache' }).then((res) => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        });
        const quiet = net.catch(() => null);
        const timer = new Promise((resolve) => setTimeout(() => resolve(null), NET_WAIT_MS));
        const first = await Promise.race([quiet, timer]);
        if (first && first.ok) return first;
        const hit = await cache.match(req, { ignoreSearch: true });
        if (hit) return hit;
        const late = first || (await quiet);
        if (late) return late;
        if (req.mode === 'navigate') {
          const index = await cache.match('index.html');
          if (index) return index;
        }
        return Response.error();
      })()
    );
  }
});
