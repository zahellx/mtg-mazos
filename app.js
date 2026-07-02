// ── Estado ────────────────────────────────────────────────────────────────
const BASICS = new Set(["Plains", "Island", "Swamp", "Mountain", "Forest", "Wastes",
  "Snow-Covered Plains", "Snow-Covered Island", "Snow-Covered Swamp", "Snow-Covered Mountain", "Snow-Covered Forest"]);
const COLLECTION_KEY = "mtg-collection-v1";

let decksData = null;       // { generatedAt, decks: [{name, commander, cards:[{name, quantity, type}]}] }
let usage = {};             // cardName -> { total, decks: [{name, quantity}] }
let collection = {};        // cardName -> copias poseídas (total)
let currentDeck = null;

// ── Utilidades ──────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const norm = (s) => s.trim().toLowerCase();
const hasCollection = () => Object.keys(collection).length > 0;

function loadCollection() {
  try { collection = JSON.parse(localStorage.getItem(COLLECTION_KEY)) || {}; }
  catch { collection = {}; }
}
function ownedOf(name) {
  // ManaBox a veces guarda caras dobles como "A // B"; probamos el nombre completo y la cara frontal.
  return collection[name] ?? collection[name.split(" // ")[0]] ?? 0;
}

// ── Parseo CSV (robusto: comillas, comas y saltos de línea dentro de campos) ──
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c === "\r") { /* ignore */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function importCSV(text) {
  const rows = parseCSV(text).filter((r) => r.length > 1);
  if (!rows.length) throw new Error("CSV vacío");
  const header = rows[0].map((h) => norm(h));
  const idxName = header.indexOf("name");
  const idxQty = header.indexOf("quantity");
  const idxType = header.indexOf("binder type");
  if (idxName < 0 || idxQty < 0) throw new Error("No encuentro columnas Name/Quantity. ¿Es un export de ManaBox?");

  const map = {};
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const name = (r[idxName] || "").trim();
    if (!name) continue;
    const binderType = idxType >= 0 ? norm(r[idxType] || "") : "";
    if (binderType === "list") continue; // wishlists, no son cartas físicas
    const qty = parseInt(r[idxQty], 10) || 0;
    map[name] = (map[name] || 0) + qty;
  }
  collection = map;
  localStorage.setItem(COLLECTION_KEY, JSON.stringify(map));
}

// ── Cálculo de uso entre mazos ────────────────────────────────────────────────
function computeUsage() {
  usage = {};
  for (const deck of decksData.decks) {
    for (const card of deck.cards) {
      if (!usage[card.name]) usage[card.name] = { total: 0, decks: [] };
      usage[card.name].total += card.quantity;
      usage[card.name].decks.push({ name: deck.name, quantity: card.quantity });
    }
  }
}

// Para un mazo: cartas que le FALTAN (no tienes copias libres para él) y dónde están.
//   - location "in-decks": tienes copia(s) pero están en otros mazos -> dónde buscarla.
//   - location "nowhere":  no tienes la carta en la colección -> no está en ningún mazo.
function missingForDeck(deck, includeBasics) {
  const out = [];
  for (const card of deck.cards) {
    if (!includeBasics && BASICS.has(card.name)) continue;
    const u = usage[card.name];
    const owned = ownedOf(card.name);
    if (owned >= u.total) continue;               // tienes copias de sobra para todos los mazos -> no falta
    const others = u.decks.filter((d) => d.name !== deck.name);
    out.push({
      name: card.name,
      type: card.type || "",
      owned,
      needed: u.total,
      others,
      location: owned <= 0 ? "nowhere" : (others.length ? "in-decks" : "short"),
    });
  }
  // Primero las que sí puedes localizar en otro mazo, luego por nombre
  const rank = { "in-decks": 0, short: 1, nowhere: 2 };
  out.sort((a, b) => (rank[a.location] - rank[b.location]) || a.name.localeCompare(b.name));
  return out;
}

function deckMissingCount(deck) {
  return missingForDeck(deck, false).length;
}

// ── Render ────────────────────────────────────────────────────────────────────
function imgUrl(name) {
  return `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}&format=image&version=small`;
}

function renderCollectionStatus() {
  const names = Object.keys(collection).length;
  if (!names) {
    $("collectionStatus").textContent = "Sin colección importada todavía. Sin ella, todas las cartas compartidas salen como faltantes.";
    return;
  }
  const total = Object.values(collection).reduce((a, b) => a + b, 0);
  $("collectionStatus").innerHTML = `Colección cargada: <b>${names}</b> cartas distintas (${total} copias). <a href="#" id="reimport">Reimportar</a>`;
  $("reimport").onclick = (e) => { e.preventDefault(); $("csvInput").click(); };
}

function renderDecks(filter = "") {
  const grid = $("deckGrid");
  grid.innerHTML = "";
  const f = norm(filter);
  const decks = decksData.decks
    .filter((d) => !f || norm(d.name).includes(f))
    .slice()
    .sort((a, b) => deckMissingCount(b) - deckMissingCount(a) || a.name.localeCompare(b.name));

  for (const deck of decks) {
    const known = hasCollection();
    const count = known ? deckMissingCount(deck) : null;
    const el = document.createElement("div");
    el.className = "deck-card";
    el.innerHTML = `
      <div class="info">
        <div class="name">${escapeHtml(deck.name)}</div>
        <div class="sub">${deck.commander ? "👑 " + escapeHtml(deck.commander) : deck.cards.length + " cartas"}</div>
      </div>
      <div class="badge ${!known ? "" : count ? "some" : "zero"}">${!known ? "–" : count || "✓"}</div>`;
    el.onclick = () => openDeck(deck);
    grid.appendChild(el);
  }
}

function renderConflicts() {
  const includeBasics = $("basicsToggle").checked;
  const filter = norm($("cardSearch").value);
  let list = missingForDeck(currentDeck, includeBasics);
  if (filter) list = list.filter((c) => norm(c.name).includes(filter));

  const wrap = $("conflictList");
  if (!hasCollection()) {
    wrap.innerHTML = `<div class="empty"><div class="big">📦</div>
      <div>Importa tu colección de ManaBox para ver qué cartas le faltan a este mazo y en cuáles están.</div>
      <button class="btn" style="margin-top:16px;max-width:280px" onclick="document.getElementById('csvInput').click()">Importar colección (CSV)</button></div>`;
    return;
  }
  if (!list.length) {
    wrap.innerHTML = `<div class="empty"><div class="big">✅</div>
      <div>No le falta ninguna carta a este mazo${Object.keys(collection).length ? "" : ".<br>(Importa tu colección para que el cálculo sea real)"}</div></div>`;
    return;
  }
  wrap.innerHTML = list.map((c) => {
    let locHtml;
    if (c.location === "in-decks") {
      locHtml = `<div class="c-counts"><span class="loc">📍 Está en:</span></div>
        <div class="chips">${c.others.map((o) => `<span class="chip">${escapeHtml(o.name)}${o.quantity > 1 ? " ×" + o.quantity : ""}</span>`).join("")}</div>`;
    } else if (c.location === "nowhere") {
      locHtml = `<div class="c-counts"><span class="loc bad">🛒 No la tienes — no está en ningún mazo</span></div>`;
    } else { // short: solo este mazo la usa, pero te faltan copias
      locHtml = `<div class="c-counts"><span class="loc warn">⚠️ Te faltan ${c.needed - c.owned} copia(s) — no está en ningún otro mazo</span></div>`;
    }
    return `
    <div class="conflict">
      <img loading="lazy" src="${imgUrl(c.name)}" alt="${escapeHtml(c.name)}" onerror="this.style.visibility='hidden'" />
      <div class="c-info">
        <div class="c-name">${escapeHtml(c.name)}${c.type ? ` <span class="meta">· ${escapeHtml(c.type)}</span>` : ""}</div>
        ${locHtml}
      </div>
    </div>`;
  }).join("");
}

function openDeck(deck) {
  currentDeck = deck;
  $("homeView").classList.add("hidden");
  $("deckView").classList.remove("hidden");
  $("backBtn").classList.remove("hidden");
  $("title").textContent = deck.name;
  $("cardSearch").value = "";
  window.scrollTo(0, 0);
  renderConflicts();
}

function goHome() {
  currentDeck = null;
  $("deckView").classList.add("hidden");
  $("homeView").classList.remove("hidden");
  $("backBtn").classList.add("hidden");
  $("title").textContent = "Mis Mazos MTG";
  renderDecks($("deckSearch").value);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Consume el CSV recibido vía "Compartir" de Android (Share Target).
async function consumeSharedCSV() {
  try {
    const res = await caches.match("shared-csv");
    if (!res) return false;
    const text = await res.text();
    // Borra la entrada temporal de todas las cachés donde pueda estar.
    for (const name of await caches.keys()) {
      const c = await caches.open(name);
      await c.delete("shared-csv");
    }
    if (text && text.trim()) { importCSV(text); return true; }
  } catch (_) { /* ignore */ }
  return false;
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  loadCollection();

  // Si venimos de "Compartir" desde ManaBox, importa el CSV recibido.
  let sharedImported = false;
  if (new URLSearchParams(location.search).get("shared")) {
    sharedImported = await consumeSharedCSV();
    history.replaceState(null, "", location.pathname);
  }
  try {
    const res = await fetch("data/decks-data.json", { cache: "no-cache" });
    decksData = await res.json();
  } catch (e) {
    $("deckGrid").innerHTML = `<div class="empty"><div class="big">⚠️</div><div>No pude cargar los mazos.<br>${escapeHtml(e.message)}</div></div>`;
    return;
  }
  computeUsage();

  const d = new Date(decksData.generatedAt);
  $("syncMeta").textContent = `Mazos de Archidekt · actualizados ${d.toLocaleDateString("es-ES", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`;

  renderCollectionStatus();
  renderDecks();

  if (sharedImported) {
    setTimeout(() => alert(`✅ Colección importada desde ManaBox: ${Object.keys(collection).length} cartas distintas.`), 100);
  }

  $("importBtn").onclick = () => $("csvInput").click();
  $("csvInput").onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        importCSV(reader.result);
        renderCollectionStatus();
        renderDecks($("deckSearch").value);
        if (currentDeck) renderConflicts();
        alert(`✅ Colección importada: ${Object.keys(collection).length} cartas distintas.`);
      } catch (err) {
        alert("❌ " + err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  $("backBtn").onclick = goHome;
  $("deckSearch").oninput = (e) => renderDecks(e.target.value);
  $("cardSearch").oninput = renderConflicts;
  $("basicsToggle").onchange = renderConflicts;
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

init();
