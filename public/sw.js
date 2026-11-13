/* Offline support: everything the app loads from its own address is kept in the cache. */
const CACHE = 'pocherk-app-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('pocherk-app-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  // the recogniser model is cached by the app itself
  if (req.url.includes('/models/')) return;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(req);
      const fresh = fetch(req).then((res) => {
        if (res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => hit);
      // pages and scripts: fresh when online, cached when offline
      return req.mode === 'navigate' || req.destination === 'script' || req.destination === 'worker' ? (await fresh) || hit : hit || fresh;
    }),
  );
});
