// Modal de carta compartido entre las dos apps. Requiere en el DOM:
//   <div id="cardModal"><div class="modal-box"><button id="modalClose">✕</button><div id="modalBody"></div></div></div>
// Cada página lo configura con window.cardModal.configure({ printings, actions, onChange }):
//   printings(name) -> [{scryfallId, setCode, setName?, collectorNumber, foil, qty}] copias que TIENES
//   actions(name)   -> [{label, cls, on, run}] botones de estado (CM / pedida / proxy...)
//   onChange()      -> re-render de la lista de fondo tras una acción
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const cache = {}; // sid|name -> objeto Scryfall
  let current = null;
  let ctx = { printings: () => [], actions: () => [], onChange: null };

  function close() { current = null; const m = $("cardModal"); if (m) m.classList.add("hidden"); }

  async function open(name) {
    current = name;
    $("cardModal").classList.remove("hidden");
    $("modalBody").innerHTML = `<div class="empty"><div class="big">⏳</div><div>Cargando ${esc(name)}…</div></div>`;
    const prints = ctx.printings(name) || [];
    const sid = prints[0]?.scryfallId || null; // la foto de TU copia
    const key = sid || name;
    let card = cache[key];
    if (!card) {
      try {
        const url = sid
          ? `https://api.scryfall.com/cards/${encodeURIComponent(sid)}`
          : `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}`;
        const res = await fetch(url);
        if (res.ok) { card = await res.json(); cache[key] = card; }
      } catch (_) {}
    }
    if (current !== name) return;
    render(name, card);
  }

  function render(name, card) {
    const prints = ctx.printings(name) || [];
    const faces = card && card.card_faces ? card.card_faces : null;
    const img = card ? (card.image_uris?.normal || faces?.[0]?.image_uris?.normal || "") : "";
    const cost = card ? (card.mana_cost || (faces || []).map((f) => f.mana_cost).filter(Boolean).join("  //  ")) : "";
    const type = card ? (card.type_line || "") : "";
    const text = card ? (card.oracle_text || (faces || []).map((f) => `${f.name}\n${f.oracle_text || ""}`).join("\n\n—\n\n")) : "";
    const cmUrl = card?.purchase_uris?.cardmarket || `https://www.cardmarket.com/en/Magic/Products/Search?searchString=${encodeURIComponent(name)}`;
    const sfUrl = card?.scryfall_uri || `https://scryfall.com/search?q=${encodeURIComponent('!"' + name + '"')}`;
    const actions = ctx.actions(name) || [];

    $("modalBody").innerHTML = `
      ${img ? `<img class="modal-img" src="${img}" alt="${esc(name)}" onerror="this.style.display='none'" />`
            : `<img class="modal-img" data-name="${esc(name)}" ${prints[0] ? `data-sid="${esc(prints[0].scryfallId)}"` : ""} src="${window.mtgImg ? window.mtgImg.placeholder : ""}" alt="${esc(name)}" />`}
      <div class="modal-info">
        <div class="modal-name"><span>${esc(name)}</span>${cost ? `<span class="modal-cost">${esc(cost)}</span>` : ""}</div>
        ${type ? `<div class="modal-type">${esc(type)}</div>` : ""}
        ${text ? `<div class="modal-text">${esc(text)}</div>` : ""}
        ${actions.length ? `<div class="modal-actions">${actions.map((a, i) => `<button class="${a.cls}${a.on ? " on" : ""}" data-i="${i}">${a.label}</button>`).join("")}</div>` : ""}
        ${prints.length ? `<button class="btn secondary" id="modalVersions" style="margin-top:10px;">🃏 Versiones que tienes (${prints.length})</button>` : ""}
        <div class="modal-links">
          <a href="${cmUrl}" target="_blank" rel="noopener">🛒 Cardmarket ↗</a>
          <a href="${sfUrl}" target="_blank" rel="noopener">🔎 Scryfall ↗</a>
        </div>
      </div>`;
    if (window.mtgImg) window.mtgImg.load($("modalBody"));
    $("modalBody").querySelectorAll(".modal-actions button").forEach((b) => {
      b.onclick = () => { actions[+b.dataset.i].run(); if (ctx.onChange) ctx.onChange(); render(name, card); };
    });
    const vb = $("modalVersions");
    if (vb) vb.onclick = () => renderVersions(name, card);
  }

  function renderVersions(name, card) {
    const prints = ctx.printings(name) || [];
    $("modalBody").innerHTML = `
      <button class="btn secondary" id="modalBack" style="margin-bottom:12px;">‹ Volver a la carta</button>
      <div class="modal-name"><span>${esc(name)}</span></div>
      <div class="meta" style="margin-bottom:10px;">${prints.length} versión(es) en tu colección</div>
      <div class="ver-grid">
        ${prints.map((p) => `
          <div class="ver">
            <img data-sid="${esc(p.scryfallId)}" data-name="${esc(name)}" src="${window.mtgImg ? window.mtgImg.placeholder : ""}" alt="${esc(name)}" />
            <div class="ver-info">${esc((p.setCode || "").toUpperCase())}${p.collectorNumber ? " #" + esc(p.collectorNumber) : ""}${p.foil ? " ✨" : ""} · ×${p.qty}</div>
          </div>`).join("")}
      </div>`;
    if (window.mtgImg) window.mtgImg.load($("modalBody"));
    $("modalBack").onclick = () => render(name, card);
  }

  function bind() {
    const m = $("cardModal");
    if (!m) return;
    $("modalClose").onclick = close;
    m.onclick = (e) => { if (e.target === m) close(); };
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !m.classList.contains("hidden")) close(); });
  }
  if (document.readyState !== "loading") bind();
  else document.addEventListener("DOMContentLoaded", bind);

  window.cardModal = { configure: (c) => { ctx = { ...ctx, ...c }; }, open, close };
})();
