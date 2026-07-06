// Cargador de imágenes de cartas robusto: pide los datos en lote (/cards/collection)
// y usa la URL del CDN (cards.scryfall.io), que es estática y la cachea el service
// worker. Soporta printing exacto vía data-sid (Scryfall ID de TU copia) para que la
// foto coincida con la carta física; si no hay sid, resuelve por nombre.
(function () {
  const KEY = "mtg-img-cache-v2";
  const PLACEHOLDER = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
  const namedUrl = (name) => `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}&format=image&version=small`;
  const sidUrl = (sid) => `https://api.scryfall.com/cards/${encodeURIComponent(sid)}?format=image&version=small`;

  let cache = {};
  try { cache = JSON.parse(localStorage.getItem(KEY)) || {}; } catch { cache = {}; }
  const persist = (() => { let t = null; return () => { if (t) return; t = setTimeout(() => { t = null; try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch {} }, 500); }; })();

  const pending = {}; // key -> [img,...]
  const queue = new Map(); // key -> {sid?, name?}
  let timer = null;

  const keyOf = (sid, name) => (sid ? "id:" + sid : "nm:" + name);

  function setImg(img, url, sid, name) {
    img.onerror = () => { img.onerror = null; img.src = sid ? sidUrl(sid) : namedUrl(name); }; // último recurso
    img.src = url;
  }
  function apply(key, sid, name) {
    const url = cache[key];
    (pending[key] || []).forEach((img) => setImg(img, url || (sid ? sidUrl(sid) : namedUrl(name)), sid, name));
    delete pending[key];
  }

  async function flush() {
    timer = null;
    const items = [...queue.values()].filter((it) => !(keyOf(it.sid, it.name) in cache));
    queue.clear();
    for (let i = 0; i < items.length; i += 75) {
      const batch = items.slice(i, i + 75);
      try {
        const res = await fetch("https://api.scryfall.com/cards/collection", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ identifiers: batch.map((it) => (it.sid ? { id: it.sid } : { name: it.name })) }),
        });
        if (res.ok) {
          const data = await res.json();
          (data.data || []).forEach((c) => {
            const u = c.image_uris?.small || c.image_uris?.normal || c.card_faces?.[0]?.image_uris?.small;
            if (!u) return;
            cache["id:" + c.id] = u;
            cache["nm:" + c.name] = cache["nm:" + c.name] || u;
            apply("id:" + c.id, c.id, c.name);
            apply("nm:" + c.name, null, c.name);
          });
        }
      } catch {}
      // Las que no resolvieron: fallback directo (se cachea la URL del endpoint).
      batch.forEach((it) => {
        const k = keyOf(it.sid, it.name);
        if (!(k in cache)) { cache[k] = it.sid ? sidUrl(it.sid) : namedUrl(it.name); apply(k, it.sid, it.name); }
      });
      persist();
      if (i + 75 < items.length) await new Promise((r) => setTimeout(r, 100));
    }
  }

  window.mtgImg = {
    load(root) {
      (root || document).querySelectorAll("img[data-name]:not([data-img-done]), img[data-sid]:not([data-img-done])").forEach((img) => {
        img.setAttribute("data-img-done", "1");
        const sid = img.getAttribute("data-sid") || null;
        const name = img.getAttribute("data-name") || "";
        const k = keyOf(sid, name);
        if (cache[k]) { setImg(img, cache[k], sid, name); return; }
        (pending[k] = pending[k] || []).push(img);
        queue.set(k, { sid, name });
        if (!timer) timer = setTimeout(flush, 60);
      });
    },
    placeholder: PLACEHOLDER,
  };

  // Carga automática: observa el DOM y resuelve cualquier <img data-name|data-sid> nuevo.
  function observe() {
    window.mtgImg.load(document);
    let lt = null;
    const scan = () => { if (lt) return; lt = setTimeout(() => { lt = null; window.mtgImg.load(document); }, 30); };
    new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState !== "loading") observe();
  else document.addEventListener("DOMContentLoaded", observe);
})();
