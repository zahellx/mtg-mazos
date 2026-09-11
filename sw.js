// Service worker: cachea el app shell para que funcione offline.
// El JSON de mazos se sirve network-first (para coger lo último que publicó el Action),
// con fallback a caché si no hay red.
const CACHE = "mtg-mazos-v56";
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
  // cache:"reload" -> ignora la caché HTTP del navegador al instalar una versión
  // nueva; si no, se podían cachear los ficheros VIEJOS y no actualizaba nunca.
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" }))))
      .then(() => self.skipWaiting())
  );
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
      // Copia cruda ANTES de interpretar: así sabemos si Android manda algo o no.
      let raw = null;
      const ct = e.request.headers.get("content-type") || "";
      try { raw = await e.request.clone().arrayBuffer(); } catch (_) {}
      debug.push({ contentType: ct.slice(0, 80), cuerpoBytes: raw ? raw.byteLength : -1 });
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
      // Rescate: si el lector estándar no sacó nada pero SÍ hay cuerpo, lo
      // troceamos a mano (multipart) y nos quedamos con la parte más grande.
      if (!text && raw && raw.byteLength > 0) {
        try {
          const decoded = new TextDecoder("utf-8").decode(raw);
          const bm = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/);
          const boundary = bm ? (bm[1] || bm[2]).trim() : null;
          const trozos = boundary ? decoded.split("--" + boundary) : [decoded];
          let mejor = "";
          for (const t of trozos) {
            const i = t.indexOf("\r\n\r\n");
            const cuerpo = i >= 0 ? t.slice(i + 4) : t;
            const limpio = cuerpo.replace(/\r\n$/, "");
            if (limpio.length > mejor.length) mejor = limpio;
          }
          if (mejor.trim().length > 20) { text = mejor; debug.push({ rescate: "multipart a mano", bytes: mejor.length }); }
        } catch (err2) { debug.push({ rescateError: err2.message }); }
      }
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

  // Resto (app shell): cache-first. ignoreSearch para que app.js?v=53 case con
  // el app.js cacheado (los ?v= son solo para saltarse la caché del navegador).
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request))
  );
});
