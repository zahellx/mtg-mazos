// ── Sincronización automática vía repo PRIVADO de GitHub ────────────────────────
// Cada clave de datos (colección, pedidas, cardmarket, proxies, precios) viaja con su
// propia marca de tiempo y se FUSIONA: para cada clave gana la versión más nueva, esté
// donde esté. Así el móvil puede subir la colección y el PC pedidas sin machacarse.
// Ciclo automático: al cargar, cada 60 s, al volver a la pestaña y tras cada cambio.
// Formato nube v2: { app, updatedAt, keys: {key: {ts, value}} } (lee también el v1 antiguo).
(function () {
  const CFG_KEY = "mtg-sync-config";
  const KEYTS_KEY = "mtg-sync-keyts";   // {key: ts} última versión conocida por clave
  const SHADOW_KEY = "mtg-sync-shadow"; // {key: hash} para detectar cambios locales
  const DATA_KEYS = [
    "mtg-collection-v1",
    "mtg-collection-data-v1",
    "mtg-price-snapshots-v1",
    "mtg-orders-v1",
    "mtg-cardmarket-v1",
    "mtg-proxies-v1",
    "mtg-sell-v1",
  ];

  const getCfg = () => { try { return JSON.parse(localStorage.getItem(CFG_KEY)) || {}; } catch { return {}; } };
  const setCfg = (c) => localStorage.setItem(CFG_KEY, JSON.stringify(c));
  const loadJson = (k) => { try { return JSON.parse(localStorage.getItem(k)) || {}; } catch { return {}; } };
  let keyTs = loadJson(KEYTS_KEY);
  let shadow = loadJson(SHADOW_KEY);
  const persistMeta = () => { localStorage.setItem(KEYTS_KEY, JSON.stringify(keyTs)); localStorage.setItem(SHADOW_KEY, JSON.stringify(shadow)); };

  const b64encode = (s) => btoa(unescape(encodeURIComponent(s)));
  const b64decode = (s) => decodeURIComponent(escape(atob(s.replace(/\n/g, ""))));
  function hash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return String(h); }

  // Marca como cambiadas (ts=ahora) las claves cuyo valor difiere del último sync.
  function detectLocalChanges() {
    const legacyTs = Number(localStorage.getItem("mtg-sync-ts") || 0);
    for (const k of DATA_KEYS) {
      const v = localStorage.getItem(k);
      if (v == null) continue;
      const h = hash(v);
      if (shadow[k] === undefined) {
        // Primera vez que vemos esta clave: hereda la fecha del sync antiguo (migración).
        shadow[k] = h;
        if (!keyTs[k]) keyTs[k] = legacyTs || 1;
      } else if (shadow[k] !== h) {
        shadow[k] = h;
        keyTs[k] = Date.now();
      }
    }
    persistMeta();
  }

  function apiBase(cfg) { return `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${encodeURIComponent(cfg.path || "collection.json").replace(/%2F/g, "/")}`; }
  function headers(cfg) { return { Authorization: `Bearer ${cfg.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }; }

  async function getRemote(cfg) {
    const res = await fetch(apiBase(cfg) + `?ref=${cfg.branch || "main"}`, { headers: headers(cfg), cache: "no-store" });
    if (res.status === 404) return { exists: false, keys: {} };
    if (!res.ok) throw new Error(`GitHub GET ${res.status}`);
    const j = await res.json();
    let keys = {};
    try {
      const bundle = JSON.parse(b64decode(j.content));
      if (bundle.keys) keys = bundle.keys; // v2
      else if (bundle.data) { // v1 antiguo: todas las claves con la fecha global
        const ts = bundle.updatedAt || 1;
        for (const [k, value] of Object.entries(bundle.data)) keys[k] = { ts, value };
      }
    } catch {}
    return { exists: true, sha: j.sha, keys };
  }

  async function putRemote(cfg, keys, sha) {
    const updatedAt = Math.max(0, ...Object.values(keys).map((e) => e.ts || 0)) || Date.now();
    const body = {
      message: `sync ${new Date().toISOString()}`,
      content: b64encode(JSON.stringify({ app: "mtg-mazos", v: 2, updatedAt, keys })),
      branch: cfg.branch || "main",
    };
    if (sha) body.sha = sha;
    const res = await fetch(apiBase(cfg), { method: "PUT", headers: { ...headers(cfg), "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`GitHub PUT ${res.status}`);
  }

  // ── Ciclo de sincronización: fusión por clave ─────────────────────────────────
  let syncing = false;
  async function syncNow() {
    const cfg = getCfg();
    if (!cfg.token || syncing) return;
    syncing = true;
    try {
      detectLocalChanges();
      const remote = await getRemote(cfg);
      const merged = { ...remote.keys };
      const pulled = [];
      let needPush = !remote.exists;

      for (const k of DATA_KEYS) {
        const lts = keyTs[k] || 0;
        const lval = localStorage.getItem(k);
        const r = remote.keys[k];
        if (r && (r.ts || 0) > lts) {
          // La nube tiene una versión más nueva de ESTA clave: aplicar localmente.
          if (r.value !== lval) { localStorage.setItem(k, r.value); pulled.push(k); }
          keyTs[k] = r.ts; shadow[k] = hash(r.value);
        } else if (lval != null && (!r || lts > (r.ts || 0))) {
          // Lo local es más nuevo: entra en el paquete a subir.
          merged[k] = { ts: lts || Date.now(), value: lval };
          needPush = true;
        }
      }
      persistMeta();
      if (needPush) {
        try { await putRemote(cfg, merged, remote.sha); }
        catch (_) { /* conflicto simultáneo: el próximo ciclo re-fusiona */ }
      }
      if (pulled.length) {
        toast("☁️ Datos actualizados desde la nube");
        setTimeout(() => location.reload(), 900);
      }
    } catch (_) { /* sin red o token: silencioso */ }
    finally { syncing = false; }
  }

  // ── UI: botón flotante + modal (config y override manual) ─────────────────────
  function toast(msg, ok = true) {
    const t = document.createElement("div");
    t.textContent = msg;
    t.style.cssText = `position:fixed;left:50%;bottom:76px;transform:translateX(-50%);z-index:1000;
      background:${ok ? "#16291f" : "#3a1414"};color:${ok ? "#5fd98a" : "#f08a8a"};border:1px solid ${ok ? "#1f4d3a" : "#5a2020"};
      padding:10px 16px;border-radius:10px;font:600 13px system-ui;max-width:90%;text-align:center;box-shadow:0 6px 20px rgba(0,0,0,.4)`;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3500);
  }

  function openModal() {
    const cfg = getCfg();
    const wrap = document.createElement("div");
    wrap.style.cssText = "position:fixed;inset:0;z-index:1001;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:16px";
    wrap.innerHTML = `
      <div style="background:#181b22;border:1px solid #2a2f3a;border-radius:16px;max-width:420px;width:100%;padding:18px;color:#e8eaed;font:14px system-ui">
        <div style="font-weight:700;font-size:16px;margin-bottom:4px">☁️ Sincronización</div>
        <div style="color:#9aa1ad;font-size:12.5px;margin-bottom:14px">Automática: fusiona por dato (gana el más nuevo). Los botones son solo para forzar.</div>
        <label style="font-size:12px;color:#9aa1ad">Token (fine-grained, Contents: read/write)</label>
        <input id="sy-token" type="password" placeholder="github_pat_..." value="${cfg.token ? "••••••••" : ""}" style="width:100%;margin:4px 0 10px;padding:9px;border-radius:9px;border:1px solid #2a2f3a;background:#0f1115;color:#e8eaed">
        <div style="display:flex;gap:8px">
          <div style="flex:1"><label style="font-size:12px;color:#9aa1ad">Owner</label>
            <input id="sy-owner" value="${cfg.owner || "zahellx"}" style="width:100%;margin-top:4px;padding:9px;border-radius:9px;border:1px solid #2a2f3a;background:#0f1115;color:#e8eaed"></div>
          <div style="flex:1"><label style="font-size:12px;color:#9aa1ad">Repo (privado)</label>
            <input id="sy-repo" value="${cfg.repo || "mtg-mazos-data"}" style="width:100%;margin-top:4px;padding:9px;border-radius:9px;border:1px solid #2a2f3a;background:#0f1115;color:#e8eaed"></div>
        </div>
        <div id="sy-status" style="font-size:12px;color:#9aa1ad;margin:12px 0"></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button id="sy-save" style="flex:1;padding:10px;border-radius:10px;border:1px solid #2a2f3a;background:#20242d;color:#e8eaed;font-weight:600">Guardar</button>
          <button id="sy-sync" style="flex:1;padding:10px;border-radius:10px;border:none;background:#6c8cff;color:#0b0e14;font-weight:700">🔄 Sincronizar ya</button>
        </div>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button id="sy-up" style="flex:1;padding:8px;border-radius:10px;border:1px solid #2a2f3a;background:transparent;color:#9aa1ad">⬆️ Forzar subir todo</button>
          <button id="sy-down" style="flex:1;padding:8px;border-radius:10px;border:1px solid #2a2f3a;background:transparent;color:#9aa1ad">⬇️ Forzar bajar todo</button>
        </div>
        <button id="sy-close" style="width:100%;margin-top:8px;padding:8px;border-radius:10px;border:1px solid #2a2f3a;background:transparent;color:#9aa1ad">Cerrar</button>
      </div>`;
    document.body.appendChild(wrap);
    const q = (id) => wrap.querySelector(id);
    const status = (m) => { q("#sy-status").textContent = m; };
    const readForm = () => {
      const c = getCfg();
      const tokenField = q("#sy-token").value;
      const token = (tokenField && tokenField !== "••••••••") ? tokenField.trim() : c.token;
      return { ...c, token, owner: q("#sy-owner").value.trim(), repo: q("#sy-repo").value.trim(), path: c.path || "collection.json", branch: c.branch || "main" };
    };
    q("#sy-close").onclick = () => wrap.remove();
    wrap.onclick = (e) => { if (e.target === wrap) wrap.remove(); };
    q("#sy-save").onclick = () => { setCfg(readForm()); status("✅ Config guardada."); };
    q("#sy-sync").onclick = async () => { setCfg(readForm()); status("Sincronizando…"); await syncNow(); status("✅ Sincronizado."); };
    q("#sy-up").onclick = async () => {
      setCfg(readForm()); status("Subiendo todo…");
      try {
        const cfg2 = getCfg();
        const now = Date.now();
        const keys = {};
        for (const k of DATA_KEYS) { const v = localStorage.getItem(k); if (v != null) { keys[k] = { ts: now, value: v }; keyTs[k] = now; shadow[k] = hash(v); } }
        persistMeta();
        const remote = await getRemote(cfg2);
        await putRemote(cfg2, { ...remote.keys, ...keys }, remote.sha);
        status("✅ Subido todo.");
      } catch (e) { status("❌ " + e.message); }
    };
    q("#sy-down").onclick = async () => {
      setCfg(readForm()); status("Bajando todo…");
      try {
        const remote = await getRemote(getCfg());
        if (!remote.exists) { status("No hay datos en la nube."); return; }
        for (const [k, e] of Object.entries(remote.keys)) {
          if (!DATA_KEYS.includes(k)) continue;
          localStorage.setItem(k, e.value); keyTs[k] = e.ts || Date.now(); shadow[k] = hash(e.value);
        }
        persistMeta();
        status("✅ Bajado. Recargando…");
        setTimeout(() => location.reload(), 700);
      } catch (e) { status("❌ " + e.message); }
    };
  }

  function addButton() {
    const b = document.createElement("button");
    b.textContent = "☁️";
    b.title = "Sincronización";
    b.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:999;width:52px;height:52px;border-radius:50%;border:1px solid #2a2f3a;background:#20242d;color:#e8eaed;font-size:22px;box-shadow:0 6px 20px rgba(0,0,0,.4);cursor:pointer";
    b.onclick = openModal;
    document.body.appendChild(b);
  }

  // API para las apps: tras un cambio local, sincroniza en breve (agrupa ráfagas).
  let changeTimer = null;
  window.mtgSync = {
    afterImport: () => { if (changeTimer) clearTimeout(changeTimer); changeTimer = setTimeout(() => { changeTimer = null; syncNow(); }, 800); },
  };

  function start() {
    addButton();
    syncNow();
    setInterval(() => { if (!document.hidden) syncNow(); }, 60000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) syncNow(); });
    window.addEventListener("focus", syncNow);
  }
  window.addEventListener("load", start);
})();
