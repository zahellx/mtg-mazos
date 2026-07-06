// Cargador de imágenes de cartas robusto: en vez de pegarle al endpoint de imagen de
// Scryfall una vez por carta (que se limita a 429 y con muchas se quedan sin cargar),
// pide los datos en lote (/cards/collection) y usa la URL del CDN (cards.scryfall.io),
// que es estática y la cachea el service worker. Cachea las URLs por nombre en localStorage.
(function () {
  const KEY = "mtg-img-cache-v1";
  const PLACEHOLDER = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
  const namedUrl = (name) => `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}&format=image&version=small`;

  let cache = {};
  try { cache = JSON.parse(localStorage.getItem(KEY)) || {}; } catch { cache = {}; }
  const persist = (() => { let t = null; return () => { if (t) return; t = setTimeout(() => { t = null; try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch {} }, 500); }; })();

  const pending = {}; // name -> [img,...]
  const queue = new Set();
  let timer = null;

  function setImg(img, url, name) {
    img.onerror = () => { img.onerror = null; img.src = namedUrl(name); }; // último recurso
    img.src = url;
  }
  function apply(name) {
    const url = cache[name];
    (pending[name] || []).forEach((img) => setImg(img, url || namedUrl(name), name));
    delete pending[name];
  }

  async function flush() {
    timer = null;
    const names = [...queue].filter((n) => !(n in cache));
    queue.clear();
    for (let i = 0; i < names.length; i += 75) {
      const batch = names.slice(i, i + 75);
      try {
        const res = await fetch("https://api.scryfall.com/cards/collection", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ identifiers: batch.map((name) => ({ name })) }),
        });
        if (res.ok) {
          const data = await res.json();
          (data.data || []).forEach((c) => {
            const u = c.image_uris?.small || c.image_uris?.normal || c.card_faces?.[0]?.image_uris?.small;
            if (u) { cache[c.name] = u; apply(c.name); }
          });
        }
      } catch {}
      // Las que no resolvieron por nombre exacto: fallback al endpoint named (se cachea).
      batch.forEach((n) => { if (!(n in cache)) { cache[n] = namedUrl(n); apply(n); } });
      persist();
      if (i + 75 < names.length) await new Promise((r) => setTimeout(r, 100));
    }
  }

  window.mtgImg = {
    // Registra los <img data-name="..."> de un contenedor y les asigna su imagen.
    load(root) {
      (root || document).querySelectorAll("img[data-name]:not([data-img-done])").forEach((img) => {
        img.setAttribute("data-img-done", "1");
        const name = img.getAttribute("data-name");
        if (cache[name]) { setImg(img, cache[name], name); return; }
        (pending[name] = pending[name] || []).push(img);
        queue.add(name);
        if (!timer) timer = setTimeout(flush, 60);
      });
    },
    placeholder: PLACEHOLDER,
  };

  // Carga automática: observa el DOM y resuelve cualquier <img data-name> que aparezca.
  function observe() {
    window.mtgImg.load(document);
    let lt = null;
    const scan = () => { if (lt) return; lt = setTimeout(() => { lt = null; window.mtgImg.load(document); }, 30); };
    new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState !== "loading") observe();
  else document.addEventListener("DOMContentLoaded", observe);
})();
