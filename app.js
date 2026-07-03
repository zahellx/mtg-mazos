// ── Estado ────────────────────────────────────────────────────────────────
const BASICS = new Set(["Plains", "Island", "Swamp", "Mountain", "Forest", "Wastes",
  "Snow-Covered Plains", "Snow-Covered Island", "Snow-Covered Swamp", "Snow-Covered Mountain", "Snow-Covered Forest"]);
const COLLECTION_KEY = "mtg-collection-v1";   // {name: totalQty} (compat)
const COLLECTION_DATA_KEY = "mtg-collection-data-v1"; // {byName, deckFolders, pool, printings}
const ORDERS_KEY = "mtg-orders-v1";           // {cardName: true} cartas pedidas
const CARDMARKET_KEY = "mtg-cardmarket-v1";   // {cardName: qty} lista para comprar en Cardmarket

let decksData = null;       // { generatedAt, decks: [{name, manaboxFolder, commander, cards:[{name, quantity, type}]}] }
let collection = {};        // cardName -> copias poseídas (total, todos los binders no-list)
let deckFolders = {};       // folderName -> { cardName: qty }  (Binder Type = deck)
let pool = {};              // cardName -> qty en binders NO-deck (archivador, bundles...)
let printings = [];         // [{scryfallId, name, foil, qty, setCode, collectorNumber, purchasePrice}]
let orders = {};            // cardName -> true (marcada como pedida)
let cardmarket = {};        // cardName -> qty (en la lista de compra de Cardmarket)
let selected = new Set();   // selección actual en la vista "Faltan"
let currentDeck = null;

// ── Utilidades ──────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const norm = (s) => s.trim().toLowerCase();
const hasCollection = () => Object.keys(collection).length > 0;

function loadCollection() {
  try { collection = JSON.parse(localStorage.getItem(COLLECTION_KEY)) || {}; }
  catch { collection = {}; }
  try {
    const d = JSON.parse(localStorage.getItem(COLLECTION_DATA_KEY)) || {};
    deckFolders = d.deckFolders || {};
    pool = d.pool || {};
    printings = d.printings || [];
  } catch { deckFolders = {}; pool = {}; printings = []; }
  try { orders = JSON.parse(localStorage.getItem(ORDERS_KEY)) || {}; } catch { orders = {}; }
  try { cardmarket = JSON.parse(localStorage.getItem(CARDMARKET_KEY)) || {}; } catch { cardmarket = {}; }
}
function saveOrders() {
  localStorage.setItem(ORDERS_KEY, JSON.stringify(orders));
  if (window.mtgSync) window.mtgSync.afterImport();
}
function saveCardmarket() {
  localStorage.setItem(CARDMARKET_KEY, JSON.stringify(cardmarket));
  if (window.mtgSync) window.mtgSync.afterImport();
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
  const col = (...names) => { for (const n of names) { const i = header.indexOf(n); if (i >= 0) return i; } return -1; };
  const idxName = col("name");
  const idxQty = col("quantity");
  const idxType = col("binder type");
  const idxBinder = col("binder name");
  const idxFoil = col("foil");
  const idxSet = col("set code", "set");
  const idxCn = col("collector number");
  const idxSid = col("scryfall id");
  const idxPrice = col("purchase price", "price");
  if (idxName < 0 || idxQty < 0) throw new Error("No encuentro columnas Name/Quantity. ¿Es un export de ManaBox?");

  const byName = {};
  const folders = {};
  const poolMap = {};
  const prints = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const name = (r[idxName] || "").trim();
    if (!name) continue;
    const binderType = idxType >= 0 ? norm(r[idxType] || "") : "";
    if (binderType === "list") continue; // wishlists, no son cartas físicas
    const qty = parseInt(r[idxQty], 10) || 0;
    if (qty <= 0) continue;
    const binderName = idxBinder >= 0 ? (r[idxBinder] || "").trim() : "";

    byName[name] = (byName[name] || 0) + qty;
    if (binderType === "deck") {
      (folders[binderName] = folders[binderName] || {});
      folders[binderName][name] = (folders[binderName][name] || 0) + qty;
    } else {
      poolMap[name] = (poolMap[name] || 0) + qty;
    }

    const sid = idxSid >= 0 ? (r[idxSid] || "").trim() : "";
    if (sid) {
      prints.push({
        scryfallId: sid,
        name,
        foil: idxFoil >= 0 ? norm(r[idxFoil] || "") === "foil" : false,
        qty,
        setCode: idxSet >= 0 ? (r[idxSet] || "").trim() : "",
        collectorNumber: idxCn >= 0 ? (r[idxCn] || "").trim() : "",
        purchasePrice: idxPrice >= 0 ? parseFloat(r[idxPrice]) || 0 : 0,
      });
    }
  }
  collection = byName;
  deckFolders = folders;
  pool = poolMap;
  printings = prints;
  localStorage.setItem(COLLECTION_KEY, JSON.stringify(byName));
  localStorage.setItem(COLLECTION_DATA_KEY, JSON.stringify({ deckFolders: folders, pool: poolMap, printings: prints }));
}

// ── Cambios por mazo: Archidekt vs carpeta física del mazo en ManaBox ─────────
//   toAdd:    cartas que pide Archidekt y no están (o faltan) en la carpeta del mazo.
//   toRemove: cartas que están en la carpeta del mazo pero no las pide Archidekt (o sobran).
function changesForDeck(deck) {
  const folder = deckFolders[deck.manaboxFolder || deck.name] || {};
  const target = {};
  deck.cards.forEach((c) => { target[c.name] = c.quantity; });

  const toAdd = [], toRemove = [];
  for (const c of deck.cards) {
    const have = folder[c.name] || 0;
    if (have < c.quantity) {
      const n = c.quantity - have;
      const inPool = pool[c.name] || 0; // ¿lo tienes suelto en archivador/bundles?
      toAdd.push({ name: c.name, qty: n, type: c.type || "", basic: BASICS.has(c.name), inPool });
    }
  }
  for (const [name, have] of Object.entries(folder)) {
    const want = target[name] || 0;
    if (have > want) toRemove.push({ name, qty: have - want, basic: BASICS.has(name) });
  }
  const bySeverity = (a, b) => Number(a.basic) - Number(b.basic) || a.name.localeCompare(b.name);
  toAdd.sort(bySeverity);
  toRemove.sort(bySeverity);
  return { toAdd, toRemove, folderKnown: Object.keys(folder).length > 0 };
}

// Mapa carpeta física de ManaBox -> nombre(s) de mazo(s) que la usan.
let folderToDeckNames = {};
function computeFolderMap() {
  folderToDeckNames = {};
  for (const deck of decksData.decks) {
    const f = deck.manaboxFolder || deck.name;
    (folderToDeckNames[f] = folderToDeckNames[f] || []).push(deck.name);
  }
}
const folderLabel = (folderName) => (folderToDeckNames[folderName] || []).join(" / ") || folderName;
const myFolderOf = (deck) => deckFolders[deck.manaboxFolder || deck.name] || {};

// Para un mazo: cartas que le FALTAN físicamente (las pide Archidekt pero no están
// en su carpeta de ManaBox) y DÓNDE están físicamente (en qué otra carpeta de mazo).
//   - location "in-decks": está físicamente en la carpeta de otro(s) mazo(s).
//   - location "pool":     la tienes suelta en un binder que no es de mazo.
//   - location "nowhere":  no la tienes en ningún sitio.
function missingForDeck(deck, includeBasics) {
  const myFolderName = deck.manaboxFolder || deck.name;
  const myFolder = deckFolders[myFolderName] || {};
  const out = [];
  for (const card of deck.cards) {
    if (!includeBasics && BASICS.has(card.name)) continue;
    const have = myFolder[card.name] || 0;
    if (have >= card.quantity) continue;          // está físicamente en este mazo -> no falta
    const needed = card.quantity - have;

    // ¿En qué otras carpetas de mazo está físicamente?
    const locations = [];
    for (const [folderName, cards] of Object.entries(deckFolders)) {
      if (folderName === myFolderName) continue;
      const q = cards[card.name] || 0;
      if (q > 0) locations.push({ folder: folderName, name: folderLabel(folderName), qty: q });
    }
    const inPool = pool[card.name] || 0;
    const location = locations.length ? "in-decks" : (inPool > 0 ? "pool" : "nowhere");
    out.push({ name: card.name, type: card.type || "", needed, locations, inPool, location });
  }
  const rank = { "in-decks": 0, pool: 1, nowhere: 2 };
  out.sort((a, b) => (rank[a.location] - rank[b.location]) || a.name.localeCompare(b.name));
  return out;
}

// Nº de cartas que faltan; null si no hay carpeta física de este mazo en ManaBox.
function deckMissingCount(deck) {
  if (Object.keys(myFolderOf(deck)).length === 0) return null;
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
    .sort((a, b) => (deckMissingCount(b) || 0) - (deckMissingCount(a) || 0) || a.name.localeCompare(b.name));

  for (const deck of decks) {
    const count = hasCollection() ? deckMissingCount(deck) : null; // null = sin carpeta física
    const el = document.createElement("div");
    el.className = "deck-card";
    el.innerHTML = `
      <div class="info">
        <div class="name">${escapeHtml(deck.name)}</div>
        <div class="sub">${deck.commander ? "👑 " + escapeHtml(deck.commander) : deck.cards.length + " cartas"}</div>
      </div>
      <div class="badge ${count == null ? "" : count ? "some" : "zero"}">${count == null ? "–" : count || "✓"}</div>`;
    el.onclick = () => openDeck(deck);
    grid.appendChild(el);
  }
}

let lastMissingList = []; // faltantes visibles actuales (para Cardmarket / pedidas)

function renderConflicts() {
  const includeBasics = $("basicsToggle").checked;
  const filter = norm($("cardSearch").value);
  let list = missingForDeck(currentDeck, includeBasics);
  if (filter) list = list.filter((c) => norm(c.name).includes(filter));
  if ($("hideOrdered").checked) list = list.filter((c) => !orders[c.name]);
  lastMissingList = list;

  const wrap = $("conflictList");
  $("selectionBar").classList.add("hidden");
  if (!hasCollection()) {
    wrap.innerHTML = `<div class="empty"><div class="big">📦</div>
      <div>Importa tu colección de ManaBox para ver qué cartas le faltan a este mazo y en cuáles están.</div>
      <button class="btn" style="margin-top:16px;max-width:280px" onclick="document.getElementById('csvInput').click()">Importar colección (CSV)</button></div>`;
    return;
  }
  if (Object.keys(myFolderOf(currentDeck)).length === 0) {
    wrap.innerHTML = `<div class="empty"><div class="big">🗂️</div>
      <div>No encuentro la carpeta física <b>“${escapeHtml(currentDeck.manaboxFolder || currentDeck.name)}”</b> en tu ManaBox (Binder Type = deck).<br>
      Crea esa carpeta en ManaBox con las cartas de este mazo para poder comparar.</div></div>`;
    return;
  }
  if (!list.length) {
    wrap.innerHTML = `<div class="empty"><div class="big">✅</div>
      <div>No le falta ninguna carta a este mazo: todo está en su carpeta física.</div></div>`;
    return;
  }
  wrap.innerHTML = list.map((c) => {
    let locHtml;
    if (c.location === "in-decks") {
      locHtml = `<div class="c-counts"><span class="loc">📍 Está en:</span></div>
        <div class="chips">${c.locations.map((o) => `<span class="chip">${escapeHtml(o.name)}${o.qty > 1 ? " ×" + o.qty : ""}</span>`).join("")}</div>`;
    } else if (c.location === "pool") {
      locHtml = `<div class="c-counts"><span class="loc warn">📦 La tienes suelta en tu colección (${c.inPool}) — no en un mazo</span></div>`;
    } else {
      locHtml = `<div class="c-counts"><span class="loc bad">🛒 No la tienes — no está en ningún mazo</span></div>`;
    }
    const isOrdered = !!orders[c.name];
    const inCM = cardmarket[c.name] != null;
    const badges = (isOrdered ? ' <span class="ord-badge">🛒 pedida</span>' : "") +
      (inCM ? ' <span class="cm-badge">📋 Cardmarket</span>' : "");
    return `
    <div class="conflict${isOrdered ? " ordered" : ""}">
      <input type="checkbox" class="sel" data-name="${escapeHtml(c.name)}" ${selected.has(c.name) ? "checked" : ""} />
      <img loading="lazy" src="${imgUrl(c.name)}" alt="${escapeHtml(c.name)}" onerror="this.style.visibility='hidden'" />
      <div class="c-info">
        <div class="c-name">${escapeHtml(c.name)}${c.needed > 1 ? ` ×${c.needed}` : ""}${badges}${c.type ? ` <span class="meta">· ${escapeHtml(c.type)}</span>` : ""}</div>
        ${locHtml}
      </div>
    </div>`;
  }).join("");

  wrap.querySelectorAll(".sel").forEach((cb) => {
    cb.onchange = () => { cb.checked ? selected.add(cb.dataset.name) : selected.delete(cb.dataset.name); updateSelectionBar(); };
  });
  updateSelectionBar();
}

function updateSelectionBar() {
  // Solo cuentan las seleccionadas que siguen visibles.
  const visible = new Set(lastMissingList.map((c) => c.name));
  selected = new Set([...selected].filter((n) => visible.has(n)));
  const bar = $("selectionBar");
  if (selected.size === 0 || currentTab !== "missing") { bar.classList.add("hidden"); return; }
  $("selCount").textContent = selected.size;
  bar.classList.remove("hidden");
}

function selectedNeeded() {
  // Cantidad a pedir de cada seleccionada (según lo que falta en la lista actual).
  const byName = {};
  lastMissingList.forEach((c) => { if (selected.has(c.name)) byName[c.name] = c.needed; });
  return byName;
}

// Añade las seleccionadas a la lista de Cardmarket (qty = lo que más pide un mazo).
function addSelectedToCardmarket() {
  const need = selectedNeeded();
  const names = Object.keys(need);
  if (!names.length) return;
  names.forEach((n) => { cardmarket[n] = Math.max(cardmarket[n] || 0, need[n] || 1); });
  saveCardmarket();
  selected.clear();
  renderConflicts();
  alert(`📋 ${names.length} carta(s) añadidas a la lista de Cardmarket.\nVe a Deck Builder → “Lista Cardmarket” para copiarla entera.`);
}

function markSelectedOrdered() {
  const need = selectedNeeded();
  const names = Object.keys(need);
  if (!names.length) return;
  let removedFromCM = false;
  names.forEach((n) => { orders[n] = need[n] || 1; if (cardmarket[n] != null) { delete cardmarket[n]; removedFromCM = true; } });
  saveOrders();
  if (removedFromCM) saveCardmarket(); // al pedirla, sale de la lista de "por comprar"
  selected.clear();
  renderConflicts();
  alert(`🛒 ${names.length} carta(s) marcadas como pedidas.`);
}

function toggleSelectAll() {
  const visible = lastMissingList.map((c) => c.name);
  const allSel = visible.length && visible.every((n) => selected.has(n));
  if (allSel) selected.clear();
  else visible.forEach((n) => selected.add(n));
  renderConflicts();
}

let currentTab = "missing";

function renderChanges() {
  const wrap = $("changesList");
  if (!hasCollection()) {
    wrap.innerHTML = `<div class="empty"><div class="big">📦</div>
      <div>Importa tu colección de ManaBox para comparar el mazo físico con Archidekt.</div></div>`;
    return;
  }
  const { toAdd, toRemove, folderKnown } = changesForDeck(currentDeck);
  const filter = norm($("cardSearch").value);
  const showBasics = $("basicsToggle").checked;
  const flt = (arr) => arr.filter((c) => (showBasics || !c.basic) && (!filter || norm(c.name).includes(filter)));
  const add = flt(toAdd), rem = flt(toRemove);

  if (!folderKnown) {
    wrap.innerHTML = `<div class="empty"><div class="big">🗂️</div>
      <div>No encuentro una carpeta física llamada <b>“${escapeHtml(currentDeck.manaboxFolder || currentDeck.name)}”</b> en tu ManaBox (Binder Type = deck).<br>
      Crea esa carpeta en ManaBox con las cartas del mazo para poder comparar.</div></div>`;
    return;
  }
  if (!add.length && !rem.length) {
    wrap.innerHTML = `<div class="empty"><div class="big">✅</div><div>El mazo físico coincide con Archidekt.</div></div>`;
    return;
  }
  const row = (c, kind) => `
    <div class="change-row">
      <img loading="lazy" src="${imgUrl(c.name)}" alt="${escapeHtml(c.name)}" onerror="this.style.visibility='hidden'" />
      <div class="cr-info">
        <div class="cr-name">${escapeHtml(c.name)}</div>
        <div class="cr-sub">${kind === "add"
          ? (c.basic ? "Tierra básica" : (c.inPool ? `Tienes ${c.inPool} suelta(s) en tu pool` : "No la tienes suelta"))
          : "Sobra en la carpeta del mazo"}</div>
      </div>
      <div class="qbadge ${kind === "add" ? "add" : "rem"}">${kind === "add" ? "+" : "−"}${c.qty}</div>
    </div>`;
  wrap.innerHTML =
    (add.length ? `<div class="change-section"><h3>➕ Meter en el mazo (${add.length})</h3>${add.map((c) => row(c, "add")).join("")}</div>` : "") +
    (rem.length ? `<div class="change-section"><h3>➖ Sacar del mazo (${rem.length})</h3>${rem.map((c) => row(c, "rem")).join("")}</div>` : "");
}

function renderDeckTab() {
  const missing = currentTab === "missing";
  $("conflictList").classList.toggle("hidden", !missing);
  $("changesList").classList.toggle("hidden", missing);
  $("selectAllBtn").classList.toggle("hidden", !missing);
  $("hideOrdered").closest(".toggle").classList.toggle("hidden", !missing);
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === currentTab));
  if (missing) { renderConflicts(); } else { $("selectionBar").classList.add("hidden"); renderChanges(); }
}

function openDeck(deck) {
  currentDeck = deck;
  currentTab = "missing";
  selected.clear();
  $("homeView").classList.add("hidden");
  $("priceView").classList.add("hidden");
  $("deckView").classList.remove("hidden");
  $("backBtn").classList.remove("hidden");
  $("title").textContent = deck.name;
  $("cardSearch").value = "";
  window.scrollTo(0, 0);
  renderDeckTab();
}

function openPrices() {
  currentDeck = null;
  $("homeView").classList.add("hidden");
  $("deckView").classList.add("hidden");
  $("priceView").classList.remove("hidden");
  $("backBtn").classList.remove("hidden");
  $("title").textContent = "Movimientos de precio";
  window.scrollTo(0, 0);
  renderPrices();
}

function goHome() {
  currentDeck = null;
  $("deckView").classList.add("hidden");
  $("priceView").classList.add("hidden");
  $("homeView").classList.remove("hidden");
  $("backBtn").classList.add("hidden");
  $("title").textContent = "Mis Mazos MTG";
  renderDecks($("deckSearch").value);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ── Price movers: fotos de precio de Scryfall guardadas localmente ──────────────
const PRICE_SNAP_KEY = "mtg-price-snapshots-v1";
const WINDOW_DAYS = 14;   // comparar hoy vs ~N días atrás
const MIN_PRICE = 0.5;    // ignora cartas por debajo de esto (ruido)
const MIN_PCT = 5;        // cambio mínimo en % para mostrar
const MIN_ABS = 0.3;      // ...o cambio mínimo en € (basta uno)
const MAX_SNAPS = 30;     // fotos que conservamos

const dateStr = (dt) => { const p = (n) => String(n).padStart(2, "0"); return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`; };
function minusDays(s, days) { const [y, m, d] = s.split("-").map(Number); const t = Date.UTC(y, m - 1, d) - days * 86400000; return dateStr(new Date(t)); }
function loadSnaps() { try { return JSON.parse(localStorage.getItem(PRICE_SNAP_KEY)) || {}; } catch { return {}; } }
const keyOf = (p) => `${p.scryfallId}|${p.foil ? "f" : "n"}`;

async function takeSnapshot(onProgress) {
  const sids = [...new Set(printings.map((p) => p.scryfallId))];
  if (!sids.length) throw new Error("No hay printings con Scryfall ID. Reimporta el CSV de ManaBox (debe incluir la columna Scryfall ID).");
  const priceById = {};
  for (let i = 0; i < sids.length; i += 75) {
    const batch = sids.slice(i, i + 75);
    const res = await fetch("https://api.scryfall.com/cards/collection", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ identifiers: batch.map((id) => ({ id })) }),
    });
    if (res.ok) {
      const data = await res.json();
      (data.data || []).forEach((c) => { priceById[c.id] = { n: parseFloat(c.prices?.eur) || 0, f: parseFloat(c.prices?.eur_foil) || 0 }; });
    }
    if (onProgress) onProgress(Math.min(i + 75, sids.length), sids.length);
    if (i + 75 < sids.length) await new Promise((r) => setTimeout(r, 100));
  }
  const snap = {};
  for (const p of printings) {
    const pr = priceById[p.scryfallId];
    if (!pr) continue;
    const price = p.foil ? pr.f : pr.n;
    if (price >= MIN_PRICE) snap[keyOf(p)] = Math.round(price * 100) / 100;
  }
  const snaps = loadSnaps();
  snaps[dateStr(new Date())] = snap;
  const dates = Object.keys(snaps).sort();
  while (dates.length > MAX_SNAPS) delete snaps[dates.shift()];
  localStorage.setItem(PRICE_SNAP_KEY, JSON.stringify(snaps));
  return snap;
}

function computeMovers() {
  const snaps = loadSnaps();
  const dates = Object.keys(snaps).sort();
  if (dates.length < 2) return { rows: [], dates };
  const nowDate = dates[dates.length - 1];
  const now = snaps[nowDate];
  const refTarget = minusDays(nowDate, WINDOW_DAYS);
  let refDate = dates[0];
  for (const d of dates) { if (d < nowDate && d <= refTarget) refDate = d; }
  if (refDate === nowDate) refDate = dates[0];
  const ref = snaps[refDate];

  const qty = {}, meta = {};
  for (const p of printings) {
    const k = keyOf(p);
    qty[k] = (qty[k] || 0) + p.qty;
    if (!meta[k]) meta[k] = { name: p.name, foil: p.foil, setCode: p.setCode, scryfallId: p.scryfallId };
  }
  const rows = [];
  for (const k of Object.keys(now)) {
    const pnow = now[k], pref = ref[k];
    if (!pref || pref <= 0 || pnow < MIN_PRICE) continue;
    const abs = pnow - pref, pct = (abs / pref) * 100;
    if (Math.abs(pct) < MIN_PCT && Math.abs(abs) < MIN_ABS) continue;
    rows.push({ ...(meta[k] || {}), priceNow: pnow, priceRef: pref, abs, pct, qty: qty[k] || 1 });
  }
  return { rows, dates, nowDate, refDate };
}

function renderPrices() {
  const status = $("priceStatus");
  const snaps = loadSnaps();
  const dates = Object.keys(snaps).sort();
  if (!hasCollection()) {
    status.textContent = "Importa tu colección primero.";
    $("priceList").innerHTML = "";
    return;
  }
  if (!dates.length) {
    status.textContent = "Aún no hay fotos de precio. Pulsa “Actualizar precios ahora”.";
  } else if (dates.length === 1) {
    status.innerHTML = `1 foto (${dates[0]}). Necesitas otra en un día distinto para ver movimientos.`;
  } else {
    const { nowDate, refDate } = computeMovers();
    status.innerHTML = `${dates.length} fotos · comparando <b>${refDate}</b> → <b>${nowDate}</b>`;
  }

  const { rows } = computeMovers();
  const down = $("downToggle").checked;
  const filter = norm($("priceSearch").value);
  let list = rows.filter((r) => (down ? r.pct < 0 : r.pct > 0) && (!filter || norm(r.name).includes(filter)));
  list.sort((a, b) => (down ? (a.abs * a.qty) - (b.abs * b.qty) : (b.abs * b.qty) - (a.abs * a.qty)));

  const wrap = $("priceList");
  if (!list.length) {
    wrap.innerHTML = dates.length >= 2
      ? `<div class="empty"><div class="big">🤷</div><div>Sin ${down ? "bajadas" : "subidas"} relevantes entre las dos fotos.</div></div>`
      : "";
    return;
  }
  wrap.innerHTML = list.map((r) => {
    const cls = r.pct >= 0 ? "up" : "down";
    const sign = r.pct >= 0 ? "+" : "";
    return `<div class="price-row">
      <img loading="lazy" src="https://api.scryfall.com/cards/${encodeURIComponent(r.scryfallId)}?format=image&version=small" alt="${escapeHtml(r.name)}" onerror="this.style.visibility='hidden'" />
      <div class="p-info">
        <div class="p-name">${escapeHtml(r.name)}${r.foil ? " ✨" : ""}</div>
        <div class="p-sub">${escapeHtml(r.setCode.toUpperCase())} · ${r.priceRef.toFixed(2)}€ → ${r.priceNow.toFixed(2)}€ · x${r.qty}</div>
      </div>
      <div class="delta">
        <div class="pct ${cls}">${sign}${r.pct.toFixed(0)}%</div>
        <div class="abs">${sign}${r.abs.toFixed(2)}€</div>
      </div>
    </div>`;
  }).join("");
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
  computeFolderMap();

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
        if (currentDeck) renderDeckTab();
        if (window.mtgSync) window.mtgSync.afterImport();
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
  $("cardSearch").oninput = () => renderDeckTab();
  $("basicsToggle").onchange = () => renderDeckTab();
  $("hideOrdered").onchange = () => renderDeckTab();
  $("selectAllBtn").onclick = toggleSelectAll;
  $("addCardmarket").onclick = addSelectedToCardmarket;
  $("markOrdered").onclick = markSelectedOrdered;

  document.querySelectorAll(".tab").forEach((t) => {
    t.onclick = () => { currentTab = t.dataset.tab; $("cardSearch").value = ""; selected.clear(); renderDeckTab(); };
  });

  $("pricesNav").onclick = openPrices;
  $("priceSearch").oninput = renderPrices;
  $("downToggle").onchange = renderPrices;
  $("snapshotBtn").onclick = async () => {
    const btn = $("snapshotBtn");
    btn.disabled = true;
    const label = btn.textContent;
    try {
      await takeSnapshot((done, total) => { btn.textContent = `Consultando precios… ${done}/${total}`; });
      renderPrices();
      if (window.mtgSync) window.mtgSync.afterImport();
    } catch (err) {
      alert("❌ " + err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  };
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

init();
