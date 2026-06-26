// Service worker: cachea el app shell para que funcione offline.
// El JSON de mazos se sirve network-first (para coger lo último que publicó el Action),
// con fallback a caché si no hay red.
const CACHE = "mtg-mazos-v1";
const SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  // Imágenes de Scryfall: cache-first (se reutilizan offline una vez vistas).
  if (url.hostname.endsWith("scryfall.com") || url.hostname.endsWith("scryfall.io")) {
    e.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const hit = await cache.match(e.request);
        if (hit) return hit;
        try {
          const res = await fetch(e.request);
          if (res.ok) cache.put(e.request, res.clone());
          return res;
        } catch { return hit || Response.error(); }
      })
    );
    return;
  }

  // decks-data.json: network-first.
  if (url.pathname.endsWith("decks-data.json")) {
    e.respondWith(
      fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  // Resto (app shell): cache-first.
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
