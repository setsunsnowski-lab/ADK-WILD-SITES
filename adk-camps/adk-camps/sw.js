// Offline support: app shell + campsite data are precached; map tiles you have
// viewed are cached as you browse (so pan/zoom your trip area on Wi-Fi first).
const VERSION = 'v2';
const SHELL = 'adk-shell-' + VERSION;
const TILES = 'adk-tiles-v1';
const MAX_TILES = 4000;

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
    caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting())
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

  // Our own files: serve from cache, refresh in the background.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.open(SHELL).then(async (cache) => {
        const hit = await cache.match(req, { ignoreSearch: true });
        const refresh = fetch(req)
          .then((res) => {
            if (res && res.ok) cache.put(req, res.clone());
            return res;
          })
          .catch(() => null);
        if (hit) {
          event.waitUntil(refresh);
          return hit;
        }
        const res = await refresh;
        if (res) return res;
        if (req.mode === 'navigate') return (await cache.match('index.html')) || Response.error();
        return Response.error();
      })
    );
  }
});
