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
      video: { facingMode: useBack ? { ideal: "environment" } : "user", width: { ideal: 1920 } },
    });
    $("cam").srcObject = stream;
    await $("cam").play();
    status("Cámara lista. Encuadra el nombre y pulsa Escanear.");
  } catch (err) {
    status("❌ No pude abrir la cámara: " + err.message + ". Usa el buscador de abajo.");
  }
}
function stopCam() { if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; } }
const status = (m) => { $("scanStatus").innerHTML = m; };

// Recorta la franja del nombre (parte superior de la carta) y la prepara para OCR.
function cropTitle() {
  const v = $("cam");
  const W = v.videoWidth, H = v.videoHeight;
  if (!W) return null;
  // La guía en pantalla cubre el 86% de ancho y una franja fina centrada arriba.
  const w = Math.round(W * 0.86), h = Math.round(H * 0.11);
  const x = Math.round((W - w) / 2), y = Math.round(H * 0.30);
  const c = document.createElement("canvas");
  c.width = w * 2; c.height = h * 2; // escalar ayuda al OCR
  const ctx = c.getContext("2d");
  ctx.drawImage(v, x, y, w, h, 0, 0, c.width, c.height);
  // Blanco y negro con contraste: el OCR mejora mucho.
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const g = 0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2];
    const v2 = g > 125 ? 255 : 0;
    d[i] = d[i + 1] = d[i + 2] = v2;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

let worker = null;
async function getWorker() {
  if (worker) return worker;
  status("Descargando el reconocimiento de texto… (solo la primera vez)");
  await new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
    s.onload = res; s.onerror = () => rej(new Error("no pude cargar el OCR"));
    document.head.appendChild(s);
  });
  worker = await Tesseract.createWorker("eng");
  await worker.setParameters({ tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz' ,-" });
  return worker;
}

async function scan() {
  const btn = $("shotBtn"); btn.disabled = true;
  try {
    const c = cropTitle();
    if (!c) { status("❌ La cámara no está lista."); return; }
    const w = await getWorker();
    status("🔎 Leyendo el nombre…");
    const { data } = await w.recognize(c);
    const texto = (data.text || "").split("\n").map((s) => s.trim()).filter(Boolean)[0] || "";
    if (!texto) { status("No he leído nada. Acerca más el nombre y evita reflejos."); return; }
    status(`Leído: <b>${esc(texto)}</b>`);
    const cand = bestMatches(texto);
    if (!cand.length) { status(`No reconozco “${esc(texto)}”. Pruébalo a mano abajo.`); return; }
    showCandidates(cand);
  } catch (err) {
    status("❌ " + err.message);
  } finally { btn.disabled = false; }
}

// ── Resultados ────────────────────────────────────────────────────────────────
function showCandidates(cand) {
  $("results").innerHTML = `<div class="section-h">¿Cuál es?</div>` + cand.map((c) => `
    <div class="cm-row" data-pick="${esc(c.name)}">
      <img loading="lazy" data-name="${esc(c.name)}" src="${window.mtgImg ? window.mtgImg.placeholder : ""}" alt="${esc(c.name)}" />
      <div class="cm-name">${esc(c.name)}${inWishlist(c.name) ? ' <span class="cm-badge">⭐ en tu lista</span>' : ""}</div>
      <div class="cm-qty">${Math.round(c.score * 100)}%</div>
    </div>`).join("");
  if (window.mtgImg) window.mtgImg.load($("results"));
  $("results").querySelectorAll("[data-pick]").forEach((el) => { el.onclick = () => openCard(el.dataset.pick); });
}

async function openCard(name) {
  $("results").innerHTML = `<div class="empty"><div class="big">⏳</div><div>Cargando ${esc(name)}…</div></div>`;
  let card = null;
  try {
    const r = await fetch(`https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}`);
    if (r.ok) card = await r.json();
  } catch (_) {}
  if (!card) { $("results").innerHTML = `<div class="empty">❌ No pude cargar la carta.</div>`; return; }
  await getFx();
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

  $("results").innerHTML = `
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

// ── Pendientes ────────────────────────────────────────────────────────────────
function addPending(name) {
  pending = pending.filter((p) => p.name !== name);
  pending.unshift({ name, ts: Date.now() });
  if (pending.length > 50) pending = pending.slice(0, 50);
  save(PENDING_KEY, pending);
  renderPending();
}
function renderPending() {
  $("historyTitle").textContent = pending.length ? `📋 Escaneadas (${pending.length})` : "";
  $("history").innerHTML = pending.map((p) => `
    <div class="cm-row" data-pick="${esc(p.name)}">
      <img loading="lazy" data-name="${esc(p.name)}" src="${window.mtgImg ? window.mtgImg.placeholder : ""}" alt="${esc(p.name)}" />
      <div class="cm-name">${esc(p.name)}${inWishlist(p.name) ? ' <span class="cm-badge">⭐</span>' : ""}</div>
      <button class="cm-x" data-del="${esc(p.name)}" title="Quitar">×</button>
    </div>`).join("");
  if (window.mtgImg) window.mtgImg.load($("history"));
  $("history").querySelectorAll("[data-pick]").forEach((el) => {
    el.onclick = (e) => { if (e.target.dataset.del) return; openCard(el.dataset.pick); };
  });
  $("history").querySelectorAll("[data-del]").forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); pending = pending.filter((p) => p.name !== b.dataset.del); save(PENDING_KEY, pending); renderPending(); };
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

// ── Arranque ──────────────────────────────────────────────────────────────────
async function init() {
  renderPending();
  renderPresets();
  loadNames();
  getFx().then(() => { if (pending.length) renderPending(); });

  $("shotBtn").onclick = scan;
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

  startCam();
  document.addEventListener("visibilitychange", () => { if (document.hidden) stopCam(); });
}

if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
init();
