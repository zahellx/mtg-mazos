// ── Escáner de cartas: OCR del nombre -> ficha con precio -> Cardmarket filtrado ──
// El precio que mostramos es la referencia de Scryfall (tendencia Cardmarket).
// El precio real por idioma/estado solo está en Cardmarket: por eso los botones
// rápidos abren la carta allí con TUS filtros ya aplicados.
const CARDMARKET_KEY = "mtg-cardmarket-v1";   // wishlist: {nombre: qty | {q, eur}}
const PRESETS_KEY = "mtg-scan-presets-v1";    // botones rápidos de filtros
const PENDING_KEY = "mtg-scan-pending-v1";    // lista de pendientes escaneadas
const FX_KEY = "mtg-fx-v1";                   // cambio EUR->JPY cacheado
const NAMES_KEY = "mtg-card-names-v1";        // catálogo de nombres de Scryfall

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => { localStorage.setItem(k, JSON.stringify(v)); if (window.mtgSync) window.mtgSync.afterImport(); };

let cardmarket = load(CARDMARKET_KEY, {});
let presets = load(PRESETS_KEY, []);
let pending = load(PENDING_KEY, []);
let names = [];           // catálogo de nombres
let fx = load(FX_KEY, null);

// La wishlist admite formato antiguo (número) y nuevo ({q, eur}).
const wishQty = (v) => (typeof v === "object" && v ? (v.q || 1) : (typeof v === "number" ? v : 1));
const wishEur = (v) => (typeof v === "object" && v && v.eur ? Number(v.eur) : null);
const inWishlist = (name) => cardmarket[name] != null;

// ── Dinero ────────────────────────────────────────────────────────────────────
async function getFx() {
  if (fx && Date.now() - fx.ts < 24 * 3600 * 1000) return fx.jpy;
  try {
    const r = await fetch("https://open.er-api.com/v6/latest/EUR");
    const d = await r.json();
    if (d && d.rates && d.rates.JPY) { fx = { jpy: d.rates.JPY, ts: Date.now() }; localStorage.setItem(FX_KEY, JSON.stringify(fx)); }
  } catch (_) {}
  return fx ? fx.jpy : null;
}
const eur = (v) => (v == null ? "—" : `${Number(v).toFixed(2)} €`);
const yen = (v) => (v == null || !fx ? "" : `≈ ¥${Math.round(Number(v) * fx.jpy).toLocaleString("es-ES")}`);

// ── Catálogo de nombres (para acertar con el OCR) ─────────────────────────────
async function loadNames() {
  const cached = load(NAMES_KEY, null);
  if (cached && cached.ts && Date.now() - cached.ts < 30 * 24 * 3600 * 1000) { names = cached.data; return; }
  try {
    const r = await fetch("https://api.scryfall.com/catalog/card-names");
    const d = await r.json();
    names = d.data || [];
    try { localStorage.setItem(NAMES_KEY, JSON.stringify({ ts: Date.now(), data: names })); } catch (_) {}
  } catch (_) { names = []; }
}

// Parecido entre el texto OCR y un nombre real (tolerante a erratas).
function similar(a, b) {
  a = a.toLowerCase(); b = b.toLowerCase();
  if (a === b) return 1;
  if (b.startsWith(a) || a.startsWith(b)) return 0.92;
  if (b.includes(a) || a.includes(b)) return 0.85;
  // Distancia de edición normalizada
  const m = a.length, n = b.length;
  if (!m || !n) return 0;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}

function bestMatches(text, n = 5) {
  const q = text.replace(/[^A-Za-z',\- ]/g, " ").replace(/\s+/g, " ").trim();
  if (q.length < 3 || !names.length) return [];
  return names
    .map((name) => ({ name, score: similar(q, name) }))
    .filter((x) => x.score > 0.55)
    .sort((a, b) => b.score - a.score)
    .slice(0, n);
}

// ── Cámara ────────────────────────────────────────────────────────────────────
let stream = null, useBack = true;
async function startCam() {
  stopCam();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: useBack ? { ideal: "environment" } : "user", width: { ideal: 1280 } },
    });
    $("cam").srcObject = stream;
    await $("cam").play();
  } catch (err) {
    status("❌ No pude abrir la cámara: " + err.message + ". Usa 📁 o el buscador.");
  }
}
function stopCam() { if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; } }
const status = (m) => { $("scanStatus").innerHTML = m; };

// ── Reconocimiento por ILUSTRACIÓN (huella de imagen) ─────────────────────────
// Comparamos la huella de lo que ve la cámara con las de todas las cartas.
// No lee texto: funciona igual en japonés, inglés o lo que sea.
let HASHES = null;   // Uint32Array (2 por carta)
let INDEX = null;    // ["nombre|set|num", ...]
let cargandoBD = null;

function cargarBD() {
  if (cargandoBD) return cargandoBD;
  cargandoBD = (async () => {
    status("Cargando el reconocedor… (solo la primera vez)");
    const [b, t] = await Promise.all([
      fetch("data/art-hashes.bin").then((r) => { if (!r.ok) throw new Error("faltan las huellas"); return r.arrayBuffer(); }),
      fetch("data/art-index.txt").then((r) => r.text()),
    ]);
    const dv = new DataView(b);
    const n = Math.floor(b.byteLength / 8);
    HASHES = new Uint32Array(n * 2);
    for (let i = 0; i < n; i++) { HASHES[i * 2] = dv.getUint32(i * 8); HASHES[i * 2 + 1] = dv.getUint32(i * 8 + 4); }
    INDEX = t.split("\n");
    status(`Reconocedor listo: ${n.toLocaleString("es-ES")} ilustraciones.`);
    return n;
  })().catch((e) => { cargandoBD = null; status("❌ " + e.message + " — lanza el proceso de huellas en GitHub."); throw e; });
  return cargandoBD;
}

const popcount = (x) => { x -= (x >> 1) & 0x55555555; x = (x & 0x33333333) + ((x >> 2) & 0x33333333); x = (x + (x >> 4)) & 0x0f0f0f0f; return (x * 0x01010101) >> 24; };

// Proporciones de la ilustración dentro de una carta (marco moderno).
const ARTE = { x: 0.079, y: 0.112, w: 0.842, h: 0.424 };

const lienzo9 = document.createElement("canvas"); lienzo9.width = 9; lienzo9.height = 8;
const lienzoMed = document.createElement("canvas"); lienzoMed.width = 36; lienzoMed.height = 32;

/** Huella de 64 bits de una región, igual que la calculada en el servidor. */
function huella(fuente, sx, sy, sw, sh) {
  // Reducir en dos pasos da una miniatura más fiel (y la huella coincide mejor).
  const m = lienzoMed.getContext("2d", { willReadFrequently: true });
  m.imageSmoothingEnabled = true; m.imageSmoothingQuality = "high";
  m.drawImage(fuente, sx, sy, sw, sh, 0, 0, 36, 32);
  const c = lienzo9.getContext("2d", { willReadFrequently: true });
  c.imageSmoothingEnabled = true; c.imageSmoothingQuality = "high";
  c.drawImage(lienzoMed, 0, 0, 36, 32, 0, 0, 9, 8);
  const d = c.getImageData(0, 0, 9, 8).data;
  const h = new Uint32Array(2);
  let bit = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const i1 = (y * 9 + x) * 4, i2 = (y * 9 + x + 1) * 4;
      const g1 = 0.299 * d[i1] + 0.587 * d[i1 + 1] + 0.114 * d[i1 + 2];
      const g2 = 0.299 * d[i2] + 0.587 * d[i2 + 1] + 0.114 * d[i2 + 2];
      if (g1 > g2) h[bit >> 5] |= 1 << (31 - (bit & 31));
      bit++;
    }
  }
  return h;
}

/** Busca la carta más parecida. Devuelve {i, dist} o null. */
function buscarHuella(h) {
  if (!HASHES) return null;
  const a = h[0], b = h[1];
  let mejor = 99, idx = -1, segundo = 99;
  for (let i = 0; i < HASHES.length; i += 2) {
    const d = popcount(HASHES[i] ^ a) + popcount(HASHES[i + 1] ^ b);
    if (d < mejor) { segundo = mejor; mejor = d; idx = i >> 1; }
    else if (d < segundo) segundo = d;
  }
  return idx < 0 ? null : { i: idx, dist: mejor, margen: segundo - mejor };
}

/** La guía dibujada en pantalla, en coordenadas del vídeo. */
function marcoCarta(v) {
  const W = v.videoWidth, H = v.videoHeight;
  const h = H * 0.72, w = h * 0.716;          // proporción de una carta real
  return { x: (W - w) / 2, y: (H - h) / 2, w, h };
}

let escaneando = false, cicloId = null;

async function unCiclo() {
  if (!escaneando) return;
  const v = $("cam");
  if (!v.videoWidth) { seguir(); return; }
  try {
    const m = marcoCarta(v);
    // Probamos varios encuadres: así perdona que no centres la carta perfecta.
    const variantes = [0, -0.02, 0.02, -0.04, 0.04];
    let top = null;
    for (const dz of variantes) {
      const ax = m.x + m.w * (ARTE.x - dz), ay = m.y + m.h * (ARTE.y - dz);
      const aw = m.w * (ARTE.w + dz * 2), ah = m.h * (ARTE.h + dz * 2);
      const r = buscarHuella(huella(v, ax, ay, aw, ah));
      if (r && (!top || r.dist < top.dist)) top = r;
    }
    if (top && top.dist <= 12) {
      const [nombre, set, num] = (INDEX[top.i] || "").split("|");
      if (nombre) { await acertadoPorArte(nombre, set, num, top); return; }
    } else if (top) {
      status(`Buscando… <span class="meta">(mejor parecido: ${64 - top.dist}/64)</span>`);
    }
  } catch (err) { status("❌ " + err.message); }
  seguir();
}

async function acertadoPorArte(nombre, set, num, top) {
  let card = null;
  try {
    const r = await fetch(`https://api.scryfall.com/cards/${encodeURIComponent(set)}/${encodeURIComponent(num)}`);
    if (r.ok) card = await r.json();
  } catch (_) {}
  if (!card) { status(`Reconocida ${esc(nombre)} pero no pude cargar sus datos.`); seguir(); return; }
  acertado(card);
}

function pausar() {
  escaneando = false;
  if (cicloId) { clearTimeout(cicloId); cicloId = null; }
  $("shotBtn").textContent = "▶️ Seguir escaneando";
}

async function alternarEscaneo() {
  if (escaneando) { pausar(); status("En pausa."); return; }
  try { await cargarBD(); } catch { return; }
  escaneando = true;
  $("shotBtn").textContent = "⏸️ Pausar";
  status("Escaneando… encuadra la carta en el marco.");
  unCiclo();
}

// ── Resultados ────────────────────────────────────────────────────────────────
function showCandidates(cand) {
  $("detail").innerHTML = `<div class="section-h">¿Cuál es?</div>` + cand.map((c) => `
    <div class="cm-row" data-pick="${esc(c.name)}">
      <img loading="lazy" data-name="${esc(c.name)}" src="${window.mtgImg ? window.mtgImg.placeholder : ""}" alt="${esc(c.name)}" />
      <div class="cm-name">${esc(c.name)}${inWishlist(c.name) ? ' <span class="cm-badge">⭐ en tu lista</span>' : ""}</div>
      <div class="cm-qty">${Math.round(c.score * 100)}%</div>
    </div>`).join("");
  if (window.mtgImg) window.mtgImg.load($("detail"));
  $("detail").querySelectorAll("[data-pick]").forEach((el) => { el.onclick = () => openCard(el.dataset.pick); });
}

async function openCard(name) {
  $("detail").innerHTML = `<div class="empty"><div class="big">⏳</div><div>Cargando ${esc(name)}…</div></div>`;
  let card = null;
  try {
    const r = await fetch(`https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}`);
    if (r.ok) card = await r.json();
  } catch (_) {}
  if (!card) { $("detail").innerHTML = `<div class="empty">❌ No pude cargar la carta.</div>`; return; }
  openCardObj(card);
}

async function openCardObj(card) {
  await getFx();
  status(`✅ ${esc(card.name)}`);
  renderCard(card);
  addPending(card.name);
}

function cmLink(card, preset) {
  let base = (card.purchase_uris && card.purchase_uris.cardmarket) || `https://www.cardmarket.com/en/Magic/Products/Search?searchString=${encodeURIComponent(card.name)}`;
  const u = new URL(base);
  ["referrer", "utm_campaign", "utm_medium", "utm_source"].forEach((p) => u.searchParams.delete(p));
  if (preset) {
    if (preset.locale) u.pathname = u.pathname.replace(/^\/[a-z]{2}\//, `/${preset.locale}/`);
    new URLSearchParams(preset.query || "").forEach((v, k) => u.searchParams.set(k, v));
  }
  return u.toString();
}

function renderCard(card) {
  const precio = card.prices && card.prices.eur ? Number(card.prices.eur) : null;
  const precioFoil = card.prices && card.prices.eur_foil ? Number(card.prices.eur_foil) : null;
  const w = cardmarket[card.name];
  const objetivo = wishEur(w);
  const img = (card.image_uris && card.image_uris.normal) || (card.card_faces && card.card_faces[0].image_uris && card.card_faces[0].image_uris.normal) || "";

  const aviso = w != null ? `
    <div class="wish-alert">
      <div class="wish-title">⭐ ¡Está en tu lista de Cardmarket!</div>
      <div>Quieres <b>${wishQty(w)}</b> copia(s)${objetivo != null
        ? ` · tu precio objetivo: <b>${eur(objetivo)}</b> <span class="yen">${yen(objetivo)}</span>` : " · sin precio objetivo puesto"}</div>
      ${objetivo != null && precio != null ? `<div class="wish-verdict ${precio <= objetivo ? "good" : "bad"}">
        ${precio <= objetivo ? "✅ La referencia está por debajo de tu objetivo" : "⚠️ La referencia está por encima de tu objetivo"}
      </div>` : ""}
    </div>` : "";

  const botones = presets.length
    ? presets.map((p, i) => `<a class="btn cm-quick" href="${esc(cmLink(card, p))}" target="_blank" rel="noopener">🛒 ${esc(p.name)}</a>`).join("")
    : `<a class="btn" href="${esc(cmLink(card, null))}" target="_blank" rel="noopener">🛒 Ver en Cardmarket</a>
       <div class="note">Configura tus filtros con el ⚙️ para tener botones rápidos.</div>`;

  $("detail").innerHTML = `
    ${aviso}
    <div class="scan-card">
      ${img ? `<img class="scan-img" src="${img}" alt="${esc(card.name)}" />` : ""}
      <div class="scan-info">
        <div class="scan-name">${esc(card.name)} <span class="meta">${esc(card.mana_cost || "")}</span></div>
        <div class="scan-type">${esc(card.type_line || "")} · ${esc((card.set_name || "").slice(0, 28))}</div>
        <div class="price-big">${eur(precio)} <span class="yen">${yen(precio)}</span></div>
        ${precioFoil != null ? `<div class="meta">✨ Foil: ${eur(precioFoil)} <span class="yen">${yen(precioFoil)}</span></div>` : ""}
        <div class="note">Precio de referencia (tendencia). El real por idioma y estado, en Cardmarket.</div>
      </div>
    </div>
    <div class="cm-quick-wrap">${botones}</div>
    <div class="cm-actions" style="margin-top:10px">
      <button class="btn secondary" id="addWish">${w != null ? "⭐ Ya está en tu lista" : "➕ Añadir a mi lista"}</button>
      <a class="btn secondary" style="text-decoration:none;text-align:center" href="${esc(card.scryfall_uri || "#")}" target="_blank" rel="noopener">🔎 Scryfall</a>
    </div>`;
  const aw = $("addWish");
  if (aw) aw.onclick = () => {
    if (cardmarket[card.name] == null) { cardmarket[card.name] = 1; save(CARDMARKET_KEY, cardmarket); renderCard(card); }
  };
}

// ── Sesión de escaneo (se acumula, como el montón de cartas) ─────────────────
function addSesion(card) {
  const precio = card.prices && card.prices.eur ? Number(card.prices.eur) : null;
  pending.unshift({
    name: card.name, id: card.id, eur: precio, ts: Date.now(),
    set: (card.set || "").toUpperCase(), num: card.collector_number || "",
  });
  if (pending.length > 200) pending = pending.slice(0, 200);
  save(PENDING_KEY, pending);
  renderPending();
}

function renderPending() {
  const n = pending.length;
  const total = pending.reduce((acc, p) => acc + (p.eur || 0), 0);
  $("sessionTitle").textContent = n ? `📋 Sesión · ${n} carta(s)` : "Sesión vacía";
  $("sessionTotal").innerHTML = n ? `${eur(total)} <span class="yen">${yen(total)}</span>` : "";
  $("sessionActions").style.display = n ? "flex" : "none";
  $("session").innerHTML = pending.map((p, i) => `
    <div class="cm-row" data-pick="${esc(p.name)}">
      <img loading="lazy" data-name="${esc(p.name)}" src="${window.mtgImg ? window.mtgImg.placeholder : ""}" alt="${esc(p.name)}" />
      <div class="cm-name">${esc(p.name)}${inWishlist(p.name) ? ' <span class="cm-badge">⭐</span>' : ""}
        <div class="note">${esc(p.set)} ${esc(p.num)}</div></div>
      <div class="cm-qty">${p.eur != null ? eur(p.eur) : "—"}<div class="yen">${p.eur != null ? yen(p.eur) : ""}</div></div>
      <button class="cm-x" data-del="${i}" title="Quitar">×</button>
    </div>`).join("");
  if (window.mtgImg) window.mtgImg.load($("session"));
  $("session").querySelectorAll("[data-pick]").forEach((el) => {
    el.onclick = (e) => { if (e.target.dataset.del !== undefined) return; openCard(el.dataset.pick); };
  });
  $("session").querySelectorAll("[data-del]").forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); pending.splice(+b.dataset.del, 1); save(PENDING_KEY, pending); renderPending(); };
  });
}

// ── Ajustes: presets de filtros de Cardmarket ─────────────────────────────────
function renderPresets() {
  const info = $("cmInfo");
  info.innerHTML = presets.length
    ? presets.map((p, i) => `<div class="cm-row"><div class="cm-name">🛒 ${esc(p.name)}<div class="note">${esc(p.query || "(sin filtros)")}</div></div>
        <button class="cm-x" data-dp="${i}">×</button></div>`).join("")
    : "<div class='note'>Todavía no has guardado ningún filtro.</div>";
  info.querySelectorAll("[data-dp]").forEach((b) => {
    b.onclick = () => { presets.splice(+b.dataset.dp, 1); save(PRESETS_KEY, presets); renderPresets(); };
  });
}

function savePreset() {
  const raw = $("cmUrl").value.trim();
  if (!raw) return;
  let u;
  try { u = new URL(raw); } catch { alert("Esa no parece una URL de Cardmarket."); return; }
  const params = new URLSearchParams(u.search);
  ["idProduct", "searchString", "referrer", "utm_campaign", "utm_medium", "utm_source"].forEach((p) => params.delete(p));
  const locale = (u.pathname.match(/^\/([a-z]{2})\//) || [])[1] || "es";
  const nombre = prompt("Nombre del botón (ej. “ES · NM”, “España”, “Barato”):", `Filtro ${presets.length + 1}`);
  if (!nombre) return;
  presets.push({ name: nombre, query: params.toString(), locale });
  save(PRESETS_KEY, presets);
  $("cmUrl").value = "";
  renderPresets();
}

// ── Escanear una foto (sin cámara en vivo) ────────────────────────────────────
async function escanearImagen(file) {
  pausar();
  status("🔎 Analizando la foto…");
  try {
    await cargarBD();
    const bmp = await createImageBitmap(file);
    let top = null;
    // La carta puede ocupar todo el encuadre o parte: probamos varias escalas.
    for (const f of [1, 0.9, 0.8]) {
      const w = bmp.width * f, h = bmp.height * f;
      const x = (bmp.width - w) / 2, y = (bmp.height - h) / 2;
      const r = buscarHuella(huella(bmp, x + w * ARTE.x, y + h * ARTE.y, w * ARTE.w, h * ARTE.h));
      if (r && (!top || r.dist < top.dist)) top = r;
    }
    if (top && top.dist <= 14) {
      const [nombre, set, num] = (INDEX[top.i] || "").split("|");
      await acertadoPorArte(nombre, set, num, top);
    } else {
      status("No la reconozco en la foto. Prueba con la carta más centrada o busca por nombre.");
    }
  } catch (err) { status("❌ " + err.message); }
}

// ── Arranque ──────────────────────────────────────────────────────────────────
async function init() {
  renderPending();
  renderPresets();
  loadNames();
  getFx().then(() => { if (pending.length) renderPending(); });

  $("shotBtn").onclick = alternarEscaneo;

  // Acciones sobre la sesión
  $("sesClear").onclick = () => { if (confirm("¿Vaciar la sesión?")) { pending = []; save(PENDING_KEY, pending); renderPending(); } };
  $("sesCopy").onclick = async () => {
    const txt = pending.map((p) => `1 ${p.name}`).join("\n");
    if (!txt) return;
    try { await navigator.clipboard.writeText(txt); alert(`📋 Copiadas ${pending.length} cartas.`); }
    catch { prompt("Copia la lista:", txt); }
  };
  $("sesWish").onclick = () => {
    let n = 0;
    pending.forEach((p) => { if (cardmarket[p.name] == null) { cardmarket[p.name] = 1; n++; } });
    save(CARDMARKET_KEY, cardmarket);
    renderPending();
    alert(n ? `⭐ ${n} carta(s) añadidas a tu lista de Cardmarket.` : "Ya estaban todas en tu lista.");
  };

  // Plan C: una foto (de la galería o hecha al momento) en vez de vídeo.
  $("fileBtn").onclick = () => $("fileInput").click();
  $("fileInput").onchange = (e) => {
    const f = e.target.files[0]; e.target.value = "";
    if (f) escanearImagen(f);
  };
  $("camBtn").onclick = () => { useBack = !useBack; startCam(); };
  $("manualGo").onclick = () => {
    const t = $("manualName").value.trim();
    if (!t) return;
    const cand = bestMatches(t);
    if (cand.length) showCandidates(cand); else status("No encuentro esa carta.");
  };
  $("manualName").onkeydown = (e) => { if (e.key === "Enter") $("manualGo").click(); };

  $("cfgBtn").onclick = () => { $("scanView").classList.add("hidden"); $("cfgView").classList.remove("hidden"); stopCam(); };
  $("cfgBack").onclick = () => { $("cfgView").classList.add("hidden"); $("scanView").classList.remove("hidden"); startCam(); };
  $("cmSave").onclick = savePreset;
  $("cmClearF").onclick = () => { if (confirm("¿Borrar todos los filtros guardados?")) { presets = []; save(PRESETS_KEY, presets); renderPresets(); } };

  startCam().then(() => alternarEscaneo());
  document.addEventListener("visibilitychange", () => { if (document.hidden) { pausar(); stopCam(); } });
}

if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
init();
