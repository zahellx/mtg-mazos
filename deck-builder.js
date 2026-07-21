// ── Deck Builder: reportes sobre la colección (comparte datos con "Mis Mazos") ──
const BASICS = new Set(["Plains", "Island", "Swamp", "Mountain", "Forest", "Wastes",
  "Snow-Covered Plains", "Snow-Covered Island", "Snow-Covered Swamp", "Snow-Covered Mountain", "Snow-Covered Forest"]);
const COLLECTION_KEY = "mtg-collection-v1";
const COLLECTION_DATA_KEY = "mtg-collection-data-v1";

const CARDMARKET_KEY = "mtg-cardmarket-v1";
const ORDERS_KEY = "mtg-orders-v1";
const SELL_KEY = "mtg-sell-v1";
const PROXIES_KEY = "mtg-proxies-v1";

let decksData = null;
let collection = {};      // {name: totalQty}
let deckFolders = {};     // {folder: {name: qty}}
let pool = {};            // {name: qty} en binders no-deck
let cardmarket = {};      // {name: qty} lista de compra
let orders = {};          // {name: qty|true} pedidas
let sellMarks = {};       // {name: true} marcadas "para vender"
let proxies = {};         // {deckName: {cardName: true}} proxies por mazo
let binders = {};         // {binderName: {cardName: qty}} carpetas no-mazo
let priceByName = {};     // cache de precios EUR por nombre (para vendibles)

const $ = (id) => document.getElementById(id);
const norm = (s) => s.trim().toLowerCase();
const hasCollection = () => Object.keys(collection).length > 0;
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const imgUrl = (name) => `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}&format=image&version=small`;
const IMG_PLACEHOLDER = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
const cardImgTag = (name) => {
  const sid = typeof ownedSid === "function" ? ownedSid(name) : null;
  return `<img loading="lazy" data-name="${escapeHtml(name)}"${sid ? ` data-sid="${escapeHtml(sid)}"` : ""} src="${IMG_PLACEHOLDER}" alt="${escapeHtml(name)}" />`;
};

let printingsByName = {};
function loadCollection() {
  try { collection = JSON.parse(localStorage.getItem(COLLECTION_KEY)) || {}; } catch { collection = {}; }
  let prints = [];
  try { const d = JSON.parse(localStorage.getItem(COLLECTION_DATA_KEY)) || {}; deckFolders = d.deckFolders || {}; binders = d.binders || {}; pool = d.pool || {}; prints = d.printings || []; }
  catch { deckFolders = {}; binders = {}; pool = {}; }
  try { cardmarket = JSON.parse(localStorage.getItem(CARDMARKET_KEY)) || {}; } catch { cardmarket = {}; }
  try { orders = JSON.parse(localStorage.getItem(ORDERS_KEY)) || {}; } catch { orders = {}; }
  try { sellMarks = JSON.parse(localStorage.getItem(SELL_KEY)) || {}; } catch { sellMarks = {}; }
  try { proxies = JSON.parse(localStorage.getItem(PROXIES_KEY)) || {}; } catch { proxies = {}; }
  // Índice nombre -> printings que tienes (para foto de tu copia y "Versiones").
  printingsByName = {};
  for (const p of prints) {
    if (!p.scryfallId) continue;
    const arr = (printingsByName[p.name] = printingsByName[p.name] || []);
    const ex = arr.find((x) => x.scryfallId === p.scryfallId && x.foil === p.foil && (x.language || "") === (p.language || ""));
    if (ex) ex.qty += p.qty; else arr.push({ ...p });
  }
}
// Líneas estilo Archidekt con printing exacto e idioma: "2x Nombre (set) 123 *F* [ES]".
function sellLinesFor(name, fallbackQty) {
  const prints = ownedPrintings(name);
  if (!prints.length) return [`${fallbackQty || 1}x ${name}`];
  return prints.map((p) =>
    `${p.qty}x ${name} (${(p.setCode || "?").toLowerCase()})${p.collectorNumber ? " " + p.collectorNumber : ""}${p.foil ? " *F*" : ""} [${(p.language || "EN").toUpperCase()}]`
  );
}
const ownedPrintings = (name) => printingsByName[name] || printingsByName[name.split(" // ")[0]] || [];
const ownedSid = (name) => ownedPrintings(name)[0]?.scryfallId || null;
function saveCardmarket() {
  localStorage.setItem(CARDMARKET_KEY, JSON.stringify(cardmarket));
  if (window.mtgSync) window.mtgSync.afterImport();
}
function saveOrders() {
  localStorage.setItem(ORDERS_KEY, JSON.stringify(orders));
  if (window.mtgSync) window.mtgSync.afterImport();
}
function saveSellMarks() {
  localStorage.setItem(SELL_KEY, JSON.stringify(sellMarks));
  if (window.mtgSync) window.mtgSync.afterImport();
}
const qtyOf = (v) => (typeof v === "number" ? v : 1); // compat con pedidas antiguas ({name:true})
const ownedOf = (name) => collection[name] ?? collection[name.split(" // ")[0]] ?? 0;

// ── CSV (idéntico a Mis Mazos: mismo formato y mismas claves de almacenamiento) ──
function parseCSV(text) {
  const rows = []; let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}
function importCSV(text) {
  const rows = parseCSV(text).filter((r) => r.length > 1);
  if (!rows.length) throw new Error("CSV vacío");
  const h = rows[0].map(norm);
  const col = (...n) => { for (const x of n) { const i = h.indexOf(x); if (i >= 0) return i; } return -1; };
  const iName = col("name"), iQty = col("quantity"), iType = col("binder type"), iBinder = col("binder name");
  if (iName < 0 || iQty < 0) throw new Error("No encuentro columnas Name/Quantity. ¿Es un export de ManaBox?");
  const byName = {}, folders = {}, binderMap = {}, poolMap = {};
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]; const name = (r[iName] || "").trim(); if (!name) continue;
    const bt = iType >= 0 ? norm(r[iType] || "") : ""; if (bt === "list") continue;
    const qty = parseInt(r[iQty], 10) || 0; if (qty <= 0) continue;
    const bn = iBinder >= 0 ? (r[iBinder] || "").trim() : "";
    byName[name] = (byName[name] || 0) + qty;
    if (bt === "deck") { (folders[bn] = folders[bn] || {}); folders[bn][name] = (folders[bn][name] || 0) + qty; }
    else { poolMap[name] = (poolMap[name] || 0) + qty; const b = bn || "Sin carpeta"; (binderMap[b] = binderMap[b] || {}); binderMap[b][name] = (binderMap[b][name] || 0) + qty; }
  }
  collection = byName; deckFolders = folders; pool = poolMap;
  localStorage.setItem(COLLECTION_KEY, JSON.stringify(byName));
  // Conserva printings previos (los escribe "Mis Mazos"); aquí solo actualizamos lo que usamos.
  let prev = {}; try { prev = JSON.parse(localStorage.getItem(COLLECTION_DATA_KEY)) || {}; } catch {}
  localStorage.setItem(COLLECTION_DATA_KEY, JSON.stringify({ deckFolders: folders, binders: binderMap, pool: poolMap, printings: prev.printings || [] }));
}

// ── Cartas vendibles: copias por encima de lo que piden todos los mazos ─────────
function sellableCards() {
  const needed = {};
  decksData.decks.forEach((dk) => dk.cards.forEach((c) => { needed[c.name] = (needed[c.name] || 0) + c.quantity; }));
  const out = [];
  for (const [name, total] of Object.entries(collection)) {
    if (BASICS.has(name)) continue;
    const need = needed[name] || 0;
    const extra = total - need;
    if (extra > 0 && total >= 2) {
      const price = priceByName[name] || 0;
      out.push({ name, total, need, extra, price, value: extra * price });
    }
  }
  out.sort((a, b) => b.value - a.value || b.extra - a.extra || a.name.localeCompare(b.name));
  return out;
}

async function fetchPricesFor(names) {
  const todo = names.filter((n) => priceByName[n] === undefined);
  for (let i = 0; i < todo.length; i += 75) {
    const batch = todo.slice(i, i + 75);
    try {
      const res = await fetch("https://api.scryfall.com/cards/collection", {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ identifiers: batch.map((name) => ({ name })) }),
      });
      if (res.ok) {
        const data = await res.json();
        (data.data || []).forEach((c) => { priceByName[c.name] = parseFloat(c.prices?.eur) || parseFloat(c.prices?.eur_foil) || 0; });
      }
    } catch {}
    // marca como consultadas aunque Scryfall no devuelva precio (evita reintentos infinitos)
    batch.forEach((n) => { if (priceByName[n] === undefined) priceByName[n] = 0; });
    if (i + 75 < todo.length) await new Promise((r) => setTimeout(r, 100));
  }
}

let lastVendiblesList = []; // lista visible actual (para el botón Copiar)

function renderVendibles() {
  if (!hasCollection()) { $("vendiblesStatus").textContent = "Importa tu colección primero."; $("vendiblesList").innerHTML = ""; return; }
  const list0 = sellableCards();
  const filter = norm($("vendiblesSearch").value);
  const minPrice = parseFloat($("vendMinPrice").value) || 0;
  const minCopies = parseInt($("vendMinCopies").value, 10) || 0;
  const onlySel = $("vendOnlySel").checked;

  let list = list0;
  if (filter) list = list.filter((c) => norm(c.name).includes(filter));
  if (minPrice > 0) list = list.filter((c) => c.price >= minPrice);
  if (minCopies > 0) list = list.filter((c) => c.extra >= minCopies);
  if (onlySel) list = list.filter((c) => sellMarks[c.name]);
  lastVendiblesList = list;

  const hasPrices = list0.some((c) => c.price > 0);
  const marked = list0.filter((c) => sellMarks[c.name]);
  const markedVal = marked.reduce((s, c) => s + c.value, 0);
  const totalVal = list0.reduce((s, c) => s + c.value, 0);
  const totalExtra = list0.reduce((s, c) => s + c.extra, 0);
  $("vendiblesStatus").innerHTML = `${list0.length} cartas con sobrantes (${totalExtra} copias)` +
    (hasPrices ? ` · valor ≈ <b>${totalVal.toFixed(2)}€</b>` : ` · pulsa 💶 Precios para valorarlas`) +
    (marked.length ? ` · <span style="color:var(--ok)">✓ ${marked.length} para vender${hasPrices ? ` ≈ <b>${markedVal.toFixed(2)}€</b>` : ""}</span>` : "");

  $("vendiblesList").innerHTML = list.length ? list.map((c) => {
    const on = !!sellMarks[c.name];
    return `
    <div class="price-row${on ? " selling" : ""}" data-card="${escapeHtml(c.name)}">
      <button class="sell-toggle${on ? " on" : ""}" data-sell="${escapeHtml(c.name)}" title="Marcar para vender">✓</button>
      ${cardImgTag(c.name)}
      <div class="p-info">
        <div class="p-name">${escapeHtml(c.name)}</div>
        <div class="p-sub">Tienes ${c.total} · el mazo pide ${c.need} · <b style="color:var(--ok)">sobran ${c.extra}</b></div>
      </div>
      <div class="delta">${c.price > 0 ? `<div class="pct up">${(c.price * c.extra).toFixed(2)}€</div><div class="abs">${c.price.toFixed(2)}€/u</div>` : ""}</div>
    </div>`;
  }).join("") : `<div class="empty"><div class="big">✅</div><div>Nada que mostrar con estos filtros.</div></div>`;

  $("vendiblesList").querySelectorAll(".sell-toggle").forEach((b) => {
    b.onclick = () => {
      const n = b.dataset.sell;
      if (sellMarks[n]) delete sellMarks[n]; else sellMarks[n] = true;
      saveSellMarks();
      renderVendibles();
    };
  });
}

// ── Proxies: dónde tienes proxies y dónde está la carta real ────────────────────
function proxyRows() {
  // carpeta física -> nombre(s) de mazo(s) que la usan (para etiquetar bonito)
  const folderToDecks = {};
  decksData.decks.forEach((dk) => {
    const f = dk.manaboxFolder || dk.name;
    (folderToDecks[f] = folderToDecks[f] || []).push(dk.name);
  });
  const rows = [];
  for (const [deckName, cards] of Object.entries(proxies)) {
    for (const card of Object.keys(cards)) {
      // ¿Dónde está la carta REAL físicamente?
      const inDecks = [];
      for (const [folder, fc] of Object.entries(deckFolders)) {
        const q = fc[card] || 0;
        if (q > 0) inDecks.push({ name: (folderToDecks[folder] || [folder]).join(" / "), qty: q });
      }
      const inBinders = [];
      for (const [bn, bc] of Object.entries(binders)) {
        const q = bc[card] || 0;
        if (q > 0) inBinders.push({ name: bn, qty: q });
      }
      rows.push({ card, deckName, inDecks, inBinders, ownedNone: !inDecks.length && !inBinders.length });
    }
  }
  rows.sort((a, b) => a.card.localeCompare(b.card) || a.deckName.localeCompare(b.deckName));
  return rows;
}

function renderProxies() {
  const all = proxyRows();
  const filter = norm($("prxSearch").value);
  const rows = filter ? all.filter((r) => norm(r.card).includes(filter) || norm(r.deckName).includes(filter)) : all;
  const noOriginal = all.filter((r) => r.ownedNone).length;
  $("prxStatus").innerHTML = `${all.length} proxy(s) en tus mazos` +
    (noOriginal ? ` · <span style="color:var(--bad)">${noOriginal} sin carta original en tu colección</span>` : "");
  const wrap = $("proxiesList");
  if (!rows.length) {
    wrap.innerHTML = `<div class="empty"><div class="big">🎭</div><div>${all.length ? "Nada que mostrar con ese filtro." : "No tienes proxies marcadas. Se marcan desde un mazo → Faltan → seleccionar → 🎭 Proxy."}</div></div>`;
    return;
  }
  const chips = (arr, icon) => arr.map((o) => `<span class="chip">${icon} ${escapeHtml(o.name)}${o.qty > 1 ? " ×" + o.qty : ""}</span>`).join("");
  wrap.innerHTML = rows.map((r) => `
    <div class="conflict" data-card="${escapeHtml(r.card)}">
      ${cardImgTag(r.card)}
      <div class="c-info">
        <div class="c-name">${escapeHtml(r.card)} <span class="prx-badge">🎭 proxy en ${escapeHtml(r.deckName)}</span></div>
        ${r.ownedNone
          ? `<div class="c-counts"><span class="loc bad">🛒 No tienes la carta original</span></div>`
          : `<div class="c-counts"><span class="loc">Original en:</span></div><div class="chips">${chips(r.inDecks, "🗂️")}${chips(r.inBinders, "📦")}</div>`}
      </div>
    </div>`).join("");
}

// ── Toda la colección por precio (marca "para vender" compartida con Vendibles) ──
let colShown = 300; // filas visibles (paginación "Mostrar más")

function renderColeccion() {
  if (!hasCollection()) { $("colStatus").textContent = "Importa tu colección primero."; $("coleccionList").innerHTML = ""; return; }
  const filter = norm($("colSearch").value);
  const minPrice = parseFloat($("colMinPrice").value) || 0;
  const onlySel = $("colOnlySel").checked;

  let list = Object.entries(collection).map(([name, qty]) => ({ name, qty, price: priceByName[name] || 0 }));
  if (filter) list = list.filter((c) => norm(c.name).includes(filter));
  if (minPrice > 0) list = list.filter((c) => c.price >= minPrice);
  if (onlySel) list = list.filter((c) => sellMarks[c.name]);
  list.sort((a, b) => b.price - a.price || a.name.localeCompare(b.name));

  const hasPrices = Object.keys(priceByName).length > 0;
  const marked = list.filter((c) => sellMarks[c.name]);
  const totalVal = list.reduce((s, c) => s + c.price * c.qty, 0);
  $("colStatus").innerHTML = `${list.length} cartas` +
    (hasPrices ? ` · valor ≈ <b>${totalVal.toFixed(2)}€</b>` : ` · pulsa 💶 Precios para ordenar por precio`) +
    (marked.length ? ` · <span style="color:var(--ok)">✓ ${marked.length} para vender</span>` : "");

  const visible = list.slice(0, colShown);
  $("coleccionList").innerHTML = visible.length ? visible.map((c) => {
    const on = !!sellMarks[c.name];
    return `
    <div class="price-row${on ? " selling" : ""}" data-card="${escapeHtml(c.name)}">
      <button class="sell-toggle${on ? " on" : ""}" data-sell="${escapeHtml(c.name)}" title="Marcar para vender">✓</button>
      ${cardImgTag(c.name)}
      <div class="p-info">
        <div class="p-name">${escapeHtml(c.name)}</div>
        <div class="p-sub">×${c.qty} copia(s)</div>
      </div>
      <div class="delta">${c.price > 0 ? `<div class="pct up">${c.price.toFixed(2)}€</div>${c.qty > 1 ? `<div class="abs">${(c.price * c.qty).toFixed(2)}€ total</div>` : ""}` : ""}</div>
    </div>`;
  }).join("") : `<div class="empty"><div class="big">🤷</div><div>Nada que mostrar con estos filtros.</div></div>`;

  $("colMore").classList.toggle("hidden", list.length <= colShown);
  $("coleccionList").querySelectorAll(".sell-toggle").forEach((b) => {
    b.onclick = () => {
      const n = b.dataset.sell;
      if (sellMarks[n]) delete sellMarks[n]; else sellMarks[n] = true;
      saveSellMarks();
      renderColeccion();
    };
  });
}

// ── Conflictos de copias: cartas en varios mazos sin copias suficientes ─────────
function copyConflicts(includeBasics) {
  const usage = {};
  decksData.decks.forEach((dk) => dk.cards.forEach((c) => {
    (usage[c.name] = usage[c.name] || { total: 0, decks: [] });
    usage[c.name].total += c.quantity;
    usage[c.name].decks.push({ name: dk.name, q: c.quantity });
  }));
  const out = [];
  for (const [name, u] of Object.entries(usage)) {
    if (u.decks.length < 2) continue;
    if (!includeBasics && BASICS.has(name)) continue;
    const owned = ownedOf(name);
    if (owned < u.total) out.push({ name, owned, needed: u.total, missing: u.total - owned, decks: u.decks });
  }
  out.sort((a, b) => b.decks.length - a.decks.length || b.missing - a.missing || a.name.localeCompare(b.name));
  return out;
}

function renderConflictos() {
  if (!hasCollection()) { $("conflictosStatus").textContent = "Importa tu colección primero."; $("conflictosList").innerHTML = ""; return; }
  const list0 = copyConflicts($("conflictosBasics").checked);
  const filter = norm($("conflictosSearch").value);
  const list = filter ? list0.filter((c) => norm(c.name).includes(filter)) : list0;
  $("conflictosStatus").innerHTML = `${list0.length} cartas en conflicto (las usan varios mazos y no tienes copias para todos)`;
  $("conflictosList").innerHTML = list.length ? list.map((c) => `
    <div class="conflict" data-card="${escapeHtml(c.name)}">
      ${cardImgTag(c.name)}
      <div class="c-info">
        <div class="c-name">${escapeHtml(c.name)}</div>
        <div class="c-counts">Tienes <span class="have">${c.owned}</span> · necesitan <span class="need">${c.needed}</span> · faltan ${c.missing}</div>
        <div class="chips">${c.decks.map((d) => `<span class="chip">${escapeHtml(d.name)}${d.q > 1 ? " ×" + d.q : ""}</span>`).join("")}</div>
      </div>
    </div>`).join("") : `<div class="empty"><div class="big">✅</div><div>Sin conflictos de copias.</div></div>`;
}

// ── Info / oracle de mazo (Scryfall on-demand) ─────────────────────────────────
let infoCache = {}; // deckName -> [{name, quantity, mana_cost, type_line, oracle_text}]
async function loadDeckInfo(deck) {
  if (infoCache[deck.name]) return infoCache[deck.name];
  const names = deck.cards.map((c) => c.name);
  const meta = {};
  for (let i = 0; i < names.length; i += 75) {
    const batch = names.slice(i, i + 75);
    try {
      const res = await fetch("https://api.scryfall.com/cards/collection", {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ identifiers: batch.map((name) => ({ name })) }),
      });
      if (res.ok) {
        const data = await res.json();
        (data.data || []).forEach((c) => {
          meta[c.name] = {
            mana_cost: c.mana_cost || c.card_faces?.[0]?.mana_cost || "",
            type_line: c.type_line || c.card_faces?.[0]?.type_line || "",
            oracle_text: c.oracle_text || (c.card_faces || []).map((f) => f.oracle_text).filter(Boolean).join("\n//\n") || "",
            cmc: c.cmc ?? 0,
          };
        });
      }
    } catch {}
    if (i + 75 < names.length) await new Promise((r) => setTimeout(r, 100));
  }
  const rows = deck.cards.map((c) => ({ name: c.name, quantity: c.quantity, ...(meta[c.name] || { type_line: c.type || "", cmc: c.cmc || 0, mana_cost: "", oracle_text: "" }) }));
  infoCache[deck.name] = rows;
  return rows;
}

const TYPE_ORDER = ["Creature", "Planeswalker", "Instant", "Sorcery", "Artifact", "Enchantment", "Battle", "Land"];
function primaryType(typeLine) {
  const t = (typeLine || "").split("—")[0];
  for (const k of TYPE_ORDER) if (t.includes(k)) return k;
  return "Otros";
}

async function renderInfo() {
  const deck = decksData.decks.find((d) => d.name === $("infoDeckSelect").value);
  if (!deck) return;
  const wrap = $("infoList");
  wrap.innerHTML = `<div class="empty"><div class="big">⏳</div><div>Cargando textos de ${escapeHtml(deck.name)}…</div></div>`;
  const rows = await loadDeckInfo(deck);
  if ($("infoDeckSelect").value !== deck.name) return; // cambió mientras cargaba
  const filter = norm($("infoSearch").value);
  const list = filter ? rows.filter((r) => norm(r.name).includes(filter) || norm(r.oracle_text).includes(filter)) : rows;

  const groups = {};
  list.forEach((r) => { const g = primaryType(r.type_line); (groups[g] = groups[g] || []).push(r); });
  const order = [...TYPE_ORDER, "Otros"].filter((g) => groups[g]);
  const total = rows.reduce((s, r) => s + r.quantity, 0);

  wrap.innerHTML = `<div class="total-line">${deck.commander ? "👑 " + escapeHtml(deck.commander) + " · " : ""}<b>${total}</b> cartas</div>` +
    order.map((g) => {
      const items = groups[g].sort((a, b) => (a.cmc - b.cmc) || a.name.localeCompare(b.name));
      return `<div class="section-h">${g} (${items.reduce((s, r) => s + r.quantity, 0)})</div>` + items.map((r) => `
        <div class="oracle-row" data-card="${escapeHtml(r.name)}">
          <div class="o-head"><div class="o-name">${r.quantity > 1 ? r.quantity + "× " : ""}${escapeHtml(r.name)}</div><div class="o-cost">${escapeHtml(r.mana_cost)}</div></div>
          <div class="o-type">${escapeHtml(r.type_line)}</div>
          ${r.oracle_text ? `<div class="o-text">${escapeHtml(r.oracle_text)}</div>` : ""}
        </div>`).join("");
    }).join("");
}

// ── Lista Cardmarket ───────────────────────────────────────────────────────────
function cardmarketText() {
  return Object.entries(cardmarket).sort((a, b) => a[0].localeCompare(b[0])).map(([name, qty]) => `${qty} ${name}`).join("\n");
}

// Conjunto de cartas que faltan físicamente en al menos un mazo (Archidekt vs su carpeta ManaBox).
// Mapa cardName -> [mazos donde falta] (está en la lista de Archidekt pero no
// en la carpeta física del mazo).
function neededAnywhere() {
  const need = new Map();
  for (const dk of decksData.decks) {
    const folder = deckFolders[dk.manaboxFolder || dk.name] || {};
    for (const c of dk.cards) {
      if ((folder[c.name] || 0) < c.quantity) {
        if (!need.has(c.name)) need.set(c.name, []);
        need.get(c.name).push(dk.name);
      }
    }
  }
  return need;
}

function renderCardmarketList() {
  let entries = Object.entries(cardmarket).sort((a, b) => a[0].localeCompare(b[0]));
  const totalCopies = entries.reduce((s, [, q]) => s + q, 0);
  const need = neededAnywhere();
  const stale = entries.filter(([n]) => !need.has(n)).map(([n]) => n);
  const onlyStale = $("cmOnlyStale").checked;
  if (onlyStale) entries = entries.filter(([n]) => !need.has(n));

  $("cmStatus").innerHTML = `${Object.keys(cardmarket).length} cartas · ${totalCopies} copias en total` +
    (stale.length ? ` · <span style="color:var(--warn)">⚠️ ${stale.length} no faltan en ningún mazo</span>` : "");
  const wrap = $("cardmarketList");
  if (!entries.length) {
    wrap.innerHTML = onlyStale
      ? `<div class="empty"><div class="big">✅</div><div>Todas las cartas de la lista las necesita algún mazo.</div></div>`
      : `<div class="empty"><div class="big">📋</div><div>Lista vacía. Añádelas desde un mazo (Faltan → 📋 CM) o aquí con el campo de arriba.</div></div>`;
    return;
  }
  // Solo con el filtro activo ofrecemos el borrado en bloque (así no se lleva por
  // delante cartas añadidas a mano que quieras aunque no estén en mazos).
  const bulk = onlyStale && entries.length
    ? `<button class="btn secondary" id="cmPurge" style="margin-bottom:12px;">🧹 Quitar estas ${entries.length} de la lista</button>` : "";
  wrap.innerHTML = bulk + entries.map(([name, qty]) => {
    const decks = need.get(name) || [];
    const ok = !decks.length;
    const where = ok
      ? ` <span class="stale-badge">no falta en ningún mazo</span>`
      : `<div class="chips">${decks.map((d) => `<span class="chip">${escapeHtml(d)}</span>`).join("")}</div>`;
    return `
    <div class="cm-row${ok ? " stale" : ""}" data-card="${escapeHtml(name)}">
      ${cardImgTag(name)}
      <div class="cm-name">${escapeHtml(name)}${where}</div>
      <div class="cm-qty">×${qty}</div>
      <button class="cm-x" data-name="${escapeHtml(name)}" title="Quitar">×</button>
    </div>`;
  }).join("");
  wrap.querySelectorAll(".cm-x").forEach((b) => { b.onclick = () => { delete cardmarket[b.dataset.name]; saveCardmarket(); renderCardmarketList(); }; });
  const purge = $("cmPurge");
  if (purge) purge.onclick = () => {
    if (!confirm(`¿Quitar ${entries.length} carta(s) de la lista de Cardmarket?`)) return;
    entries.forEach(([n]) => delete cardmarket[n]);
    saveCardmarket();
    renderCardmarketList();
  };
}

// Añadir una carta a mano (aunque no esté en ningún mazo). Resuelve el nombre
// exacto vía Scryfall (fuzzy) para evitar erratas.
async function addCardToCardmarket() {
  const raw = $("cmAddName").value.trim();
  const qty = Math.max(1, parseInt($("cmAddQty").value, 10) || 1);
  if (!raw) return;
  const btn = $("cmAddGo"); btn.disabled = true;
  try {
    let name = raw;
    try {
      const res = await fetch(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(raw)}`);
      if (res.ok) name = (await res.json()).name;
      else if (res.status === 404) { alert(`❌ No encuentro ninguna carta parecida a “${raw}”.`); return; }
    } catch {}
    cardmarket[name] = (cardmarket[name] || 0) + qty;
    saveCardmarket();
    $("cmAddName").value = ""; $("cmAddQty").value = "1";
    renderCardmarketList();
  } finally { btn.disabled = false; }
}
async function copyCardmarketAll() {
  const text = cardmarketText();
  if (!text) { alert("La lista está vacía."); return; }
  try { await navigator.clipboard.writeText(text); alert("📋 Lista copiada. Pégala en Cardmarket → Want List → “Añadir varios artículos”."); }
  catch { prompt("Copia esta lista para Cardmarket:", text); }
}
function clearCardmarket() {
  if (!Object.keys(cardmarket).length) return;
  if (!confirm("¿Vaciar toda la lista de Cardmarket?")) return;
  cardmarket = {};
  saveCardmarket();
  renderCardmarketList();
}

// ── Lista de pedidas ───────────────────────────────────────────────────────────
function pedidasText() {
  return Object.entries(orders).sort((a, b) => a[0].localeCompare(b[0])).map(([name, v]) => `${qtyOf(v)} ${name}`).join("\n");
}
function renderPedidasList() {
  const entries = Object.entries(orders).sort((a, b) => a[0].localeCompare(b[0]));
  const totalCopies = entries.reduce((s, [, v]) => s + qtyOf(v), 0);
  $("pedStatus").innerHTML = `${entries.length} cartas · ${totalCopies} copias pedidas`;
  const wrap = $("pedidasList");
  if (!entries.length) {
    wrap.innerHTML = `<div class="empty"><div class="big">🛒</div><div>No hay cartas pedidas. En “Mis Mazos” → pestaña Faltan, selecciona cartas y pulsa “🛒 Pedidas”.</div></div>`;
    return;
  }
  wrap.innerHTML = entries.map(([name, v]) => `
    <div class="cm-row" data-card="${escapeHtml(name)}">
      ${cardImgTag(name)}
      <div class="cm-name">${escapeHtml(name)}</div>
      <div class="cm-qty">×${qtyOf(v)}</div>
      <button class="cm-x" data-name="${escapeHtml(name)}" title="Quitar">×</button>
    </div>`).join("");
  wrap.querySelectorAll(".cm-x").forEach((b) => { b.onclick = () => { delete orders[b.dataset.name]; saveOrders(); renderPedidasList(); }; });
}
async function copyPedidasAll() {
  const text = pedidasText();
  if (!text) { alert("No hay cartas pedidas."); return; }
  try { await navigator.clipboard.writeText(text); alert("📋 Lista de pedidas copiada."); }
  catch { prompt("Lista de pedidas:", text); }
}
function clearPedidas() {
  if (!Object.keys(orders).length) return;
  if (!confirm("¿Vaciar toda la lista de pedidas?")) return;
  orders = {};
  saveOrders();
  renderPedidasList();
}

// Índice de nombres conocidos (inglés) -> nombre exacto, para normalizar lo pegado.
let nameIndexCache = null;
function nameIndex() {
  if (nameIndexCache) return nameIndexCache;
  const idx = {};
  decksData.decks.forEach((dk) => dk.cards.forEach((c) => { idx[c.name.toLowerCase()] = c.name; }));
  Object.keys(collection).forEach((n) => { if (!idx[n.toLowerCase()]) idx[n.toLowerCase()] = n; });
  nameIndexCache = idx;
  return idx;
}

// Parsea un pedido pegado de Cardmarket. Usa la 2ª línea de cada bloque (nombre en inglés).
function parseCardmarketOrder(text) {
  const lines = text.split(/\r?\n/).map((s) => s.trim());
  const res = {}; let qty = null, expect = false;
  for (const line of lines) {
    if (!line) continue;
    if (/nombre.*precio/i.test(line)) continue; // cabecera
    const m = line.match(/^(\d+)\s*x\b\s*(.*)$/i);
    if (m) { qty = parseInt(m[1], 10) || 1; expect = true; continue; }
    if (expect) {
      const name = line.replace(/\s*\(V\.?\s*\d+\)\s*$/i, "").trim(); // quita "(V.2)" etc.
      if (name) res[name] = (res[name] || 0) + qty;
      expect = false;
    }
  }
  return res;
}

function importOrdersFromText() {
  const text = $("pedImportText").value;
  const parsed = parseCardmarketOrder(text);
  const names = Object.keys(parsed);
  if (!names.length) { alert("No he encontrado cartas en el texto. Pega el pedido tal cual (con los nombres en inglés)."); return; }
  const idx = nameIndex();
  const unknown = [];
  names.forEach((n) => {
    const exact = idx[n.toLowerCase()] || n;
    orders[exact] = parsed[n];
    if (cardmarket[exact] != null) delete cardmarket[exact]; // ya pedida -> fuera de "por comprar"
    if (!idx[n.toLowerCase()]) unknown.push(n);
  });
  saveOrders();
  saveCardmarket();
  $("pedImportText").value = "";
  $("pedImportBox").classList.add("hidden");
  renderPedidasList();
  let msg = `🛒 ${names.length} carta(s) marcadas como pedidas.`;
  if (unknown.length) msg += `\n\n⚠️ Estas no están en tus mazos ni colección (las marco igual, revisa el nombre):\n- ${unknown.join("\n- ")}`;
  alert(msg);
}

// ── Configuración de mazos (fichero en el repo privado) ─────────────────────────
const SYNC_CFG_KEY = "mtg-sync-config";
let deckCfg = null, deckCfgSha = null;
const syncCfg = () => { try { return JSON.parse(localStorage.getItem(SYNC_CFG_KEY)) || {}; } catch { return {}; } };
const gh = (token) => ({ Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" });
const b64e = (s) => btoa(unescape(encodeURIComponent(s)));
const b64d = (s) => decodeURIComponent(escape(atob(s.replace(/\n/g, ""))));
function publicRepoInfo() {
  const owner = location.hostname.split(".")[0] || syncCfg().owner || "zahellx";
  const repo = location.pathname.split("/").filter(Boolean)[0] || "mtg-mazos";
  return { owner, repo };
}

async function loadDeckCfg() {
  const c = syncCfg();
  const api = `https://api.github.com/repos/${c.owner}/${c.repo}/contents/decks-config.json?ref=${c.branch || "main"}`;
  const res = await fetch(api, { headers: gh(c.token), cache: "no-store" });
  if (res.status === 404) {
    deckCfg = { decks: decksData.decks.map((d) => ({ name: d.name, archideck_id: d.archideckId, manaboxFolder: d.manaboxFolder || "" })) };
    deckCfgSha = null;
    return "seed";
  }
  if (!res.ok) throw new Error(`GET ${res.status}`);
  const j = await res.json();
  deckCfgSha = j.sha;
  deckCfg = JSON.parse(b64d(j.content));
  if (!Array.isArray(deckCfg.decks)) deckCfg.decks = [];
  deckCfg.decks.sort((a, b) => (a.manaboxFolder || "~").localeCompare(b.manaboxFolder || "~") || (a.name || "").localeCompare(b.name || ""));
  return "loaded";
}

async function renderConfig() {
  const c = syncCfg();
  if (!c.token) {
    $("cfgStatus").textContent = "Configura primero el sync (botón ☁️) con tu token; la config se guarda en tu repo privado.";
    $("configBody").innerHTML = "";
    return;
  }
  $("cfgStatus").textContent = "Cargando configuración…";
  $("configBody").innerHTML = "";
  try {
    const how = await loadDeckCfg();
    drawConfig(how === "seed");
  } catch (e) {
    $("cfgStatus").textContent = "❌ " + e.message;
  }
}

function drawConfig(isSeed) {
  const usedFolders = new Set(deckCfg.decks.map((d) => (d.manaboxFolder || "").trim()).filter(Boolean));
  const allFolders = Object.keys(deckFolders).sort();
  const freeFolders = allFolders.filter((f) => !usedFolders.has(f));

  $("cfgStatus").innerHTML = `${deckCfg.decks.length} mazos configurados` +
    (isSeed ? " · <b>sin guardar</b> (creados desde la config actual; pulsa Guardar)" : "");

  const opts = `<datalist id="folderOptions">${allFolders.map((f) => `<option value="${escapeHtml(f)}">`).join("")}</datalist>`;
  const rows = deckCfg.decks.map((d, i) => `
    <div class="cfg-row">
      <input class="cfg-name" data-i="${i}" placeholder="Nombre" value="${escapeHtml(d.name || "")}" />
      <input class="cfg-id" data-i="${i}" inputmode="numeric" placeholder="Archidekt ID" value="${escapeHtml(String(d.archideck_id || ""))}" />
      <input class="cfg-folder" data-i="${i}" list="folderOptions" placeholder="Carpeta ManaBox (opcional)" value="${escapeHtml(d.manaboxFolder || "")}" />
      <button class="cfg-del" data-i="${i}" title="Borrar">🗑️</button>
    </div>`).join("");

  const freeHtml = freeFolders.length
    ? `<div class="section-h">🗂️ Carpetas de ManaBox sin Archidekt (${freeFolders.length})</div>
       <div class="chips">${freeFolders.map((f) => `<span class="chip free-folder" data-f="${escapeHtml(f)}">+ ${escapeHtml(f)}</span>`).join("")}</div>`
    : (Object.keys(deckFolders).length ? `<div class="note">Todas tus carpetas de ManaBox tienen mazo. 👍</div>` : `<div class="note">Importa tu colección para ver las carpetas de ManaBox sin mazo.</div>`);

  $("configBody").innerHTML = `
    ${opts}
    <div class="cfg-head"><span>Mazo</span><span>Archidekt ID</span><span>Carpeta</span><span></span></div>
    ${rows}
    <button class="btn secondary" id="cfgAdd" style="margin:10px 0;">➕ Añadir mazo</button>
    ${freeHtml}
    <div class="cm-actions" style="margin-top:16px;">
      <button class="btn" id="cfgSave">💾 Guardar y aplicar</button>
    </div>
    <p class="note">Guardar escribe la config en tu repo privado y lanza el refresco de mazos. Las listas de cartas se actualizan en 1-2 min.</p>`;

  // Binding por referencia al objeto (no por índice de render).
  $("configBody").querySelectorAll(".cfg-name").forEach((el) => { el.oninput = () => { deckCfg.decks[+el.dataset.i].name = el.value; }; });
  $("configBody").querySelectorAll(".cfg-id").forEach((el) => { el.oninput = () => { deckCfg.decks[+el.dataset.i].archideck_id = el.value.replace(/[^0-9]/g, ""); }; });
  $("configBody").querySelectorAll(".cfg-folder").forEach((el) => { el.oninput = () => { deckCfg.decks[+el.dataset.i].manaboxFolder = el.value; }; });
  $("configBody").querySelectorAll(".cfg-del").forEach((el) => { el.onclick = () => { deckCfg.decks.splice(+el.dataset.i, 1); drawConfig(isSeed); }; });
  $("configBody").querySelectorAll(".free-folder").forEach((el) => {
    el.onclick = () => { deckCfg.decks.push({ name: el.dataset.f, archideck_id: "", manaboxFolder: el.dataset.f }); drawConfig(isSeed); };
  });
  $("cfgAdd").onclick = () => { deckCfg.decks.push({ name: "", archideck_id: "", manaboxFolder: "" }); drawConfig(isSeed); };
  $("cfgSave").onclick = saveConfig;
}

async function saveConfig() {
  const c = syncCfg();
  const btn = $("cfgSave"); btn.disabled = true; const lbl = btn.textContent; btn.textContent = "Guardando…";
  try {
    // Se conservan también los mazos SIN Archidekt ID (pendientes): quedan en la
    // config y el generador simplemente los ignora hasta que tengan ID.
    const clean = {
      decks: deckCfg.decks
        .filter((d) => (d.name || "").trim() || String(d.archideck_id || "").trim() || (d.manaboxFolder || "").trim())
        .map((d) => ({
          name: (d.name || "").trim() || (String(d.archideck_id || "").trim() ? `Deck ${d.archideck_id}` : "(sin nombre)"),
          archideck_id: parseInt(d.archideck_id, 10) || null,
          manaboxFolder: (d.manaboxFolder || "").trim() || undefined,
        })),
    };
    const pending = clean.decks.filter((d) => !d.archideck_id).length;
    const api = `https://api.github.com/repos/${c.owner}/${c.repo}/contents/decks-config.json`;
    const body = { message: "update decks config", content: b64e(JSON.stringify(clean, null, 2)), branch: c.branch || "main" };
    if (deckCfgSha) body.sha = deckCfgSha;
    const res = await fetch(api, { method: "PUT", headers: { ...gh(c.token), "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`Guardar: ${res.status} ${(await res.text()).slice(0, 140)}`);
    deckCfgSha = (await res.json()).content.sha;

    let dispatched = false;
    try {
      const { owner, repo } = publicRepoInfo();
      const wf = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/workflows/update-decks.yml/dispatches`, {
        method: "POST", headers: { ...gh(c.token), "Content-Type": "application/json" }, body: JSON.stringify({ ref: "main" }),
      });
      dispatched = wf.status === 204;
    } catch { /* sin permiso Actions */ }

    alert(`💾 Config guardada (${clean.decks.length} mazos${pending ? `, ${pending} pendiente(s) sin Archidekt ID` : ""}).\n` +
      (dispatched ? "🔄 Regenerando las listas de mazos… en 1-2 min estarán listas (recarga)." : "Se aplicará en el próximo refresco (o pulsa Run workflow en GitHub). Para que se lance sola, el token necesita permiso 'Actions: write' sobre el repo público."));
  } catch (e) {
    alert("❌ " + e.message);
  } finally {
    btn.disabled = false; btn.textContent = lbl;
  }
}

// ── Navegación ──────────────────────────────────────────────────────────────
const REPORTS = [
  { id: "config", icon: "⚙️", name: "Configurar mazos", desc: "Añade/edita mazos y sus carpetas de ManaBox" },
  { id: "cardmarket", icon: "📋", name: "Lista Cardmarket", desc: "Cartas marcadas para comprar, con copias" },
  { id: "pedidas", icon: "🛒", name: "Pedidas", desc: "Cartas que ya has encargado" },
  { id: "vendibles", icon: "💰", name: "Cartas vendibles", desc: "Copias que te sobran (no las usa ningún mazo)" },
  { id: "coleccion", icon: "🗃️", name: "Toda la colección", desc: "Todas tus cartas por precio; marca para vender" },
  { id: "proxies", icon: "🎭", name: "Proxies", desc: "Dónde tienes proxies y dónde está la carta real" },
  { id: "conflictos", icon: "⚠️", name: "Conflictos de copias", desc: "Cartas que piden varios mazos y no te llegan" },
  { id: "info", icon: "📄", name: "Info / oracle de mazo", desc: "Cada mazo carta a carta, con reglas" },
];
const VIEWS = { home: "dbHome", config: "configView", cardmarket: "cardmarketView", pedidas: "pedidasView", vendibles: "vendiblesView", coleccion: "coleccionView", proxies: "proxiesView", conflictos: "conflictosView", info: "infoView" };

function showView(v) {
  Object.values(VIEWS).forEach((id) => $(id).classList.add("hidden"));
  $(VIEWS[v]).classList.remove("hidden");
  $("backBtn").classList.toggle("hidden", v === "home");
  window.scrollTo(0, 0);
}

const DB_NAV_KEY = "mtg-db-nav";
function openReport(id) {
  const r = REPORTS.find((x) => x.id === id);
  $("title").textContent = r ? `${r.icon} ${r.name}` : "Deck Builder";
  try { sessionStorage.setItem(DB_NAV_KEY, id); } catch (_) {}
  showView(id);
  if (id === "config") renderConfig();
  if (id === "cardmarket") renderCardmarketList();
  if (id === "pedidas") renderPedidasList();
  if (id === "vendibles") renderVendibles();
  if (id === "coleccion") { colShown = 300; renderColeccion(); }
  if (id === "proxies") renderProxies();
  if (id === "conflictos") renderConflictos();
  if (id === "info") renderInfo();
}
function goHome() { $("title").textContent = "🛠️ Deck Builder"; try { sessionStorage.setItem(DB_NAV_KEY, "home"); } catch (_) {} showView("home"); }

function renderMenu() {
  $("reportMenu").innerHTML = REPORTS.map((r) => `
    <div class="report-card" data-report="${r.id}">
      <div class="ric">${r.icon}</div>
      <div><div class="rname">${r.name}</div><div class="rdesc">${r.desc}</div></div>
    </div>`).join("");
  document.querySelectorAll(".report-card").forEach((el) => { el.onclick = () => openReport(el.dataset.report); });
}
function renderCollectionStatus() {
  const n = Object.keys(collection).length;
  $("collectionStatus").innerHTML = n
    ? `Colección cargada: <b>${n}</b> cartas distintas. <a href="#" id="reimport">Reimportar</a>`
    : "Sin colección importada. Impórtala aquí o en “Mis Mazos”.";
  const ri = $("reimport"); if (ri) ri.onclick = (e) => { e.preventDefault(); $("csvInput").click(); };
}

async function init() {
  loadCollection();
  try {
    const res = await fetch("data/decks-data.json", { cache: "no-cache" });
    decksData = await res.json();
  } catch (e) {
    $("reportMenu").innerHTML = `<div class="empty"><div class="big">⚠️</div><div>No pude cargar los mazos.<br>${escapeHtml(e.message)}</div></div>`;
    return;
  }
  const d = new Date(decksData.generatedAt);
  $("syncMeta").textContent = `Mazos de Archidekt · ${d.toLocaleDateString("es-ES", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`;

  renderCollectionStatus();
  renderMenu();
  $("infoDeckSelect").innerHTML = decksData.decks.slice().sort((a, b) => a.name.localeCompare(b.name)).map((d) => `<option value="${escapeHtml(d.name)}">${escapeHtml(d.name)}</option>`).join("");

  $("importBtn").onclick = () => $("csvInput").click();
  $("csvInput").onchange = (e) => {
    const f = e.target.files[0]; if (!f) return;
    const rd = new FileReader();
    rd.onload = () => { try { importCSV(rd.result); renderCollectionStatus(); if (window.mtgSync) window.mtgSync.afterImport(); alert(`✅ Colección importada: ${Object.keys(collection).length} cartas.`); } catch (err) { alert("❌ " + err.message); } };
    rd.readAsText(f); e.target.value = "";
  };

  $("backBtn").onclick = goHome;
  $("vendiblesSearch").oninput = renderVendibles;
  $("vendiblesPrices").onclick = async () => {
    const btn = $("vendiblesPrices"); btn.disabled = true; const lbl = btn.textContent;
    try { const names = sellableCards().map((c) => c.name); btn.textContent = "Consultando…"; await fetchPricesFor(names); renderVendibles(); }
    finally { btn.disabled = false; btn.textContent = lbl; }
  };
  $("vendMinPrice").oninput = renderVendibles;
  $("vendMinCopies").oninput = renderVendibles;
  $("vendOnlySel").onchange = renderVendibles;
  $("vendCopy").onclick = async () => {
    if (!lastVendiblesList.length) { alert("No hay cartas que copiar con los filtros actuales."); return; }
    const text = lastVendiblesList.flatMap((c) => sellLinesFor(c.name, c.extra)).join("\n");
    try { await navigator.clipboard.writeText(text); alert(`📋 Copiadas ${lastVendiblesList.length} cartas con versión e idioma exactos (formato Archidekt).`); }
    catch { prompt("Copia esta lista:", text); }
  };

  const colRefresh = () => { colShown = 300; renderColeccion(); };
  $("colSearch").oninput = colRefresh;
  $("colMinPrice").oninput = colRefresh;
  $("colOnlySel").onchange = colRefresh;
  $("colMore").onclick = () => { colShown += 300; renderColeccion(); };
  $("colPrices").onclick = async () => {
    const btn = $("colPrices"); btn.disabled = true; const lbl = btn.textContent;
    try {
      const names = Object.keys(collection);
      btn.textContent = "Consultando…";
      await fetchPricesFor(names);
      renderColeccion();
    } finally { btn.disabled = false; btn.textContent = lbl; }
  };
  $("colCopy").onclick = async () => {
    const marked = Object.keys(collection).filter((n) => sellMarks[n]);
    if (!marked.length) { alert("No hay cartas marcadas para vender."); return; }
    const text = marked.sort().flatMap((n) => sellLinesFor(n)).join("\n");
    try { await navigator.clipboard.writeText(text); alert(`📋 Copiadas ${marked.length} cartas marcadas, con versión e idioma exactos.`); }
    catch { prompt("Copia esta lista:", text); }
  };
  $("cmCopy").onclick = copyCardmarketAll;
  $("cmClear").onclick = clearCardmarket;
  $("cmOnlyStale").onchange = renderCardmarketList;
  $("cmAddGo").onclick = addCardToCardmarket;
  $("cmAddName").onkeydown = (e) => { if (e.key === "Enter") addCardToCardmarket(); };
  $("pedCopy").onclick = copyPedidasAll;
  $("pedClear").onclick = clearPedidas;
  $("pedImport").onclick = () => $("pedImportBox").classList.toggle("hidden");
  $("pedImportGo").onclick = importOrdersFromText;
  $("prxSearch").oninput = renderProxies;
  $("conflictosSearch").oninput = renderConflictos;
  $("conflictosBasics").onchange = renderConflictos;
  $("infoDeckSelect").onchange = renderInfo;
  $("infoSearch").oninput = renderInfo;

  // Modal de carta compartido: foto de tu copia, versiones y estados CM/pedida.
  const rerenderCurrent = () => {
    const last = (() => { try { return sessionStorage.getItem(DB_NAV_KEY); } catch { return null; } })();
    if (last === "cardmarket") renderCardmarketList();
    if (last === "pedidas") renderPedidasList();
    if (last === "vendibles") renderVendibles();
    if (last === "conflictos") renderConflictos();
  };
  window.cardModal.configure({
    printings: (name) => ownedPrintings(name),
    actions: (name) => [
      { label: "📋 Cardmarket", cls: "cm", on: cardmarket[name] != null, run: () => {
          if (cardmarket[name] != null) delete cardmarket[name]; else cardmarket[name] = 1;
          saveCardmarket();
        } },
      { label: "🛒 Pedida", cls: "ord", on: orders[name] != null, run: () => {
          if (orders[name] != null) { delete orders[name]; saveOrders(); }
          else { orders[name] = 1; if (cardmarket[name] != null) { orders[name] = qtyOf(cardmarket[name]); delete cardmarket[name]; saveCardmarket(); } saveOrders(); }
        } },
    ],
    onChange: rerenderCurrent,
  });
  // Delegación: cualquier fila con data-card abre el modal (salvo que toques un botón).
  document.addEventListener("click", (e) => {
    if (e.target.closest("button, a, input, select")) return;
    const row = e.target.closest("[data-card]");
    if (row) window.cardModal.open(row.dataset.card);
  });

  // Restaurar el reporte abierto antes de recargar.
  try {
    const last = sessionStorage.getItem(DB_NAV_KEY);
    if (last && last !== "home" && VIEWS[last]) openReport(last);
  } catch (_) {}
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
init();
