// Service worker: cachea el app shell para que funcione offline.
// El JSON de mazos se sirve network-first (para coger lo último que publicó el Action),
// con fallback a caché si no hay red.
const CACHE = "mtg-mazos-v52";
const SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./deck-builder.html",
  "./deck-builder.js",
  "./sync.js",
  "./img.js",
  "./card-modal.js",
  "./styles.css",
  "./manifest.webmanifest",
  "./manifest-deckbuilder.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-db-192.png",
  "./icons/icon-db-512.png",
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

  // Share Target (Android): ManaBox comparte el CSV -> lo guardamos y abrimos la app.
  if (e.request.method === "POST" && url.pathname.endsWith("/share-target")) {
    e.respondWith((async () => {
      const debug = [];
      let text = "";
      try {
        const form = await e.request.formData();
        // Tolerante: vale cualquier campo, sea fichero o texto (ManaBox puede
        // no usar el nombre "csv"). Guardamos qué llegó para poder diagnosticar.
        for (const [name, val] of form.entries()) {
          if (val && typeof val === "object" && typeof val.text === "function") {
            let t = "";
            try { t = await val.text(); } catch (_) {}
            debug.push({ campo: name, tipo: "fichero", mime: val.type || "?", bytes: t.length });
            if (!text && t.trim()) text = t;
          } else {
            const s = String(val || "");
            debug.push({ campo: name, tipo: "texto", bytes: s.length, muestra: s.slice(0, 60) });
          }
        }
        if (!text) { // ¿algún campo de texto que parezca un CSV?
          for (const [, val] of form.entries()) {
            const s = typeof val === "string" ? val : "";
            if (s.includes(",") && s.includes("\n")) { text = s; break; }
          }
        }
      } catch (err) { debug.push({ error: err.message }); }
      try {
        const cache = await caches.open(CACHE);
        await cache.put("shared-csv", new Response(text, { headers: { "Content-Type": "text/csv" } }));
        await cache.put("shared-csv-debug", new Response(JSON.stringify(debug), { headers: { "Content-Type": "application/json" } }));
      } catch (_) {}
      return Response.redirect("./index.html?shared=1", 303);
    })());
    return;
  }

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
