// ── Deck Builder: reportes sobre la colección (comparte datos con "Mis Mazos") ──
const BASICS = new Set(["Plains", "Island", "Swamp", "Mountain", "Forest", "Wastes",
  "Snow-Covered Plains", "Snow-Covered Island", "Snow-Covered Swamp", "Snow-Covered Mountain", "Snow-Covered Forest"]);
const COLLECTION_KEY = "mtg-collection-v1";
const COLLECTION_DATA_KEY = "mtg-collection-data-v1";

let decksData = null;
let collection = {};      // {name: totalQty}
let deckFolders = {};     // {folder: {name: qty}}
let pool = {};            // {name: qty} en binders no-deck
let priceByName = {};     // cache de precios EUR por nombre (para vendibles)

const $ = (id) => document.getElementById(id);
const norm = (s) => s.trim().toLowerCase();
const hasCollection = () => Object.keys(collection).length > 0;
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const imgUrl = (name) => `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}&format=image&version=small`;

function loadCollection() {
  try { collection = JSON.parse(localStorage.getItem(COLLECTION_KEY)) || {}; } catch { collection = {}; }
  try { const d = JSON.parse(localStorage.getItem(COLLECTION_DATA_KEY)) || {}; deckFolders = d.deckFolders || {}; pool = d.pool || {}; }
  catch { deckFolders = {}; pool = {}; }
}
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
  const byName = {}, folders = {}, poolMap = {};
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]; const name = (r[iName] || "").trim(); if (!name) continue;
    const bt = iType >= 0 ? norm(r[iType] || "") : ""; if (bt === "list") continue;
    const qty = parseInt(r[iQty], 10) || 0; if (qty <= 0) continue;
    const bn = iBinder >= 0 ? (r[iBinder] || "").trim() : "";
    byName[name] = (byName[name] || 0) + qty;
    if (bt === "deck") { (folders[bn] = folders[bn] || {}); folders[bn][name] = (folders[bn][name] || 0) + qty; }
    else poolMap[name] = (poolMap[name] || 0) + qty;
  }
  collection = byName; deckFolders = folders; pool = poolMap;
  localStorage.setItem(COLLECTION_KEY, JSON.stringify(byName));
  // Conserva printings previos (los escribe "Mis Mazos"); aquí solo actualizamos lo que usamos.
  let prev = {}; try { prev = JSON.parse(localStorage.getItem(COLLECTION_DATA_KEY)) || {}; } catch {}
  localStorage.setItem(COLLECTION_DATA_KEY, JSON.stringify({ deckFolders: folders, pool: poolMap, printings: prev.printings || [] }));
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

function renderVendibles() {
  if (!hasCollection()) { $("vendiblesStatus").textContent = "Importa tu colección primero."; $("vendiblesList").innerHTML = ""; return; }
  const list0 = sellableCards();
  const filter = norm($("vendiblesSearch").value);
  const list = filter ? list0.filter((c) => norm(c.name).includes(filter)) : list0;
  const hasPrices = list0.some((c) => c.price > 0);
  const totalVal = list0.reduce((s, c) => s + c.value, 0);
  const totalExtra = list0.reduce((s, c) => s + c.extra, 0);
  $("vendiblesStatus").innerHTML = `${list0.length} cartas con sobrantes (${totalExtra} copias)` +
    (hasPrices ? ` · valor ≈ <b>${totalVal.toFixed(2)}€</b>` : ` · pulsa 💶 Precios para valorarlas`);

  $("vendiblesList").innerHTML = list.length ? list.map((c) => `
    <div class="price-row">
      <img loading="lazy" src="${imgUrl(c.name)}" alt="${escapeHtml(c.name)}" onerror="this.style.visibility='hidden'" />
      <div class="p-info">
        <div class="p-name">${escapeHtml(c.name)}</div>
        <div class="p-sub">Tienes ${c.total} · el mazo pide ${c.need} · <b style="color:var(--ok)">sobran ${c.extra}</b></div>
      </div>
      <div class="delta">${c.price > 0 ? `<div class="pct up">${(c.price * c.extra).toFixed(2)}€</div><div class="abs">${c.price.toFixed(2)}€/u</div>` : ""}</div>
    </div>`).join("") : `<div class="empty"><div class="big">✅</div><div>No hay cartas sobrantes para vender.</div></div>`;
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
    <div class="conflict">
      <img loading="lazy" src="${imgUrl(c.name)}" alt="${escapeHtml(c.name)}" onerror="this.style.visibility='hidden'" />
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
        <div class="oracle-row">
          <div class="o-head"><div class="o-name">${r.quantity > 1 ? r.quantity + "× " : ""}${escapeHtml(r.name)}</div><div class="o-cost">${escapeHtml(r.mana_cost)}</div></div>
          <div class="o-type">${escapeHtml(r.type_line)}</div>
          ${r.oracle_text ? `<div class="o-text">${escapeHtml(r.oracle_text)}</div>` : ""}
        </div>`).join("");
    }).join("");
}

// ── Navegación ──────────────────────────────────────────────────────────────
const REPORTS = [
  { id: "vendibles", icon: "💰", name: "Cartas vendibles", desc: "Copias que te sobran (no las usa ningún mazo)" },
  { id: "conflictos", icon: "⚠️", name: "Conflictos de copias", desc: "Cartas que piden varios mazos y no te llegan" },
  { id: "info", icon: "📄", name: "Info / oracle de mazo", desc: "Cada mazo carta a carta, con reglas" },
];
const VIEWS = { home: "dbHome", vendibles: "vendiblesView", conflictos: "conflictosView", info: "infoView" };

function showView(v) {
  Object.values(VIEWS).forEach((id) => $(id).classList.add("hidden"));
  $(VIEWS[v]).classList.remove("hidden");
  $("backBtn").classList.toggle("hidden", v === "home");
  window.scrollTo(0, 0);
}

function openReport(id) {
  const r = REPORTS.find((x) => x.id === id);
  $("title").textContent = r ? `${r.icon} ${r.name}` : "Deck Builder";
  showView(id);
  if (id === "vendibles") renderVendibles();
  if (id === "conflictos") renderConflictos();
  if (id === "info") renderInfo();
}
function goHome() { $("title").textContent = "🛠️ Deck Builder"; showView("home"); }

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
    rd.onload = () => { try { importCSV(rd.result); renderCollectionStatus(); alert(`✅ Colección importada: ${Object.keys(collection).length} cartas.`); } catch (err) { alert("❌ " + err.message); } };
    rd.readAsText(f); e.target.value = "";
  };

  $("backBtn").onclick = goHome;
  $("vendiblesSearch").oninput = renderVendibles;
  $("vendiblesPrices").onclick = async () => {
    const btn = $("vendiblesPrices"); btn.disabled = true; const lbl = btn.textContent;
    try { const names = sellableCards().map((c) => c.name); btn.textContent = "Consultando…"; await fetchPricesFor(names); renderVendibles(); }
    finally { btn.disabled = false; btn.textContent = lbl; }
  };
  $("conflictosSearch").oninput = renderConflictos;
  $("conflictosBasics").onchange = renderConflictos;
  $("infoDeckSelect").onchange = renderInfo;
  $("infoSearch").oninput = renderInfo;
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}
init();
