// ── Sincronización automática vía repo PRIVADO de GitHub ────────────────────────
// Cada clave de datos (colección, pedidas, cardmarket, proxies, precios) viaja con su
// propia marca de tiempo y se FUSIONA: para cada clave gana la versión más nueva, esté
// donde esté. Así el móvil puede subir la colección y el PC pedidas sin machacarse.
// Ciclo automático: al cargar, cada 60 s, al volver a la pestaña y tras cada cambio.
// Formato nube v2: { app, updatedAt, keys: {key: {ts, value}} } (lee también el v1 antiguo).
(function () {
  // Versión de ESTA copia instalada (va en los ficheros que cachea el service
  // worker, así delata si el dispositivo se quedó con una versión vieja).
  // Se sube a la vez que CACHE en sw.js.
  const APP_VERSION = "v52";
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

  // Caché con ETag: si la nube no cambió, GitHub responde 304 y evitamos
  // descargar el fichero entero (pesa MB) en cada comprobación.
  let remoteCache = null; // {etag, sha, keys}
  async function getRemote(cfg) {
    const url = apiBase(cfg) + `?ref=${cfg.branch || "main"}`;
    const hdrs = { ...headers(cfg) };
    if (remoteCache && remoteCache.etag) hdrs["If-None-Match"] = remoteCache.etag;
    const res = await fetch(url, { headers: hdrs, cache: "no-store" });
    if (res.status === 304 && remoteCache) return { exists: true, sha: remoteCache.sha, keys: remoteCache.keys };
    if (res.status === 404) return { exists: false, keys: {} };
    if (!res.ok) throw new Error(`GitHub GET ${res.status}`);
    const j = await res.json();
    // Ficheros >1MB: `content` llega vacío; pedimos el contenido en crudo (hasta 100MB).
    let text = j.content && j.content.trim() ? b64decode(j.content) : null;
    if (text == null) {
      const raw = await fetch(url, { headers: { ...headers(cfg), Accept: "application/vnd.github.raw" }, cache: "no-store" });
      if (!raw.ok) throw new Error(`GitHub GET raw ${raw.status}`);
      text = await raw.text();
    }
    let keys = {};
    try {
      const bundle = JSON.parse(text);
      if (bundle.keys) keys = bundle.keys; // v2
      else if (bundle.data) { // v1 antiguo: todas las claves con la fecha global
        const ts = bundle.updatedAt || 1;
        for (const [k, value] of Object.entries(bundle.data)) keys[k] = { ts, value };
      }
    } catch {}
    remoteCache = { etag: res.headers.get("etag"), sha: j.sha, keys };
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
    if (!res.ok) throw new Error(`GitHub PUT ${res.status}: ${(await res.text()).slice(0, 120)}`);
    remoteCache = null; // lo que teníamos cacheado ya no vale
  }

  // ── Registro de actividad + línea de estado permanente ────────────────────────
  const LOG_KEY = "mtg-sync-log";
  let log = []; try { log = JSON.parse(localStorage.getItem(LOG_KEY)) || []; } catch { log = []; }
  function logEvent(msg, kind) {
    log.push({ t: Date.now(), msg, kind: kind || "info" });
    if (log.length > 40) log = log.slice(-40);
    try { localStorage.setItem(LOG_KEY, JSON.stringify(log)); } catch {}
    renderStatus();
  }
  const SHORT = {
    "mtg-collection-v1": "colección", "mtg-collection-data-v1": "colección(detalle)",
    "mtg-price-snapshots-v1": "precios", "mtg-orders-v1": "pedidas",
    "mtg-cardmarket-v1": "cardmarket", "mtg-proxies-v1": "proxies", "mtg-sell-v1": "vender",
  };
  const shortName = (k) => SHORT[k] || k;
  const hace = (ts) => {
    if (!ts) return "nunca";
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return `hace ${s}s`;
    if (s < 3600) return `hace ${Math.round(s / 60)} min`;
    return `hace ${Math.round(s / 3600)} h`;
  };
  function pendingKeys() {
    if (!remoteCache) return [];
    return DATA_KEYS.filter((k) => localStorage.getItem(k) != null && (keyTs[k] || 0) > ((remoteCache.keys[k] || {}).ts || 0));
  }
  // ── Detección de versión: ¿este dispositivo tiene la última? ───────────────────
  let liveVersion = null; // versión publicada en la web
  async function checkVersion() {
    try {
      // cache:"reload" salta el service worker y va a la red de verdad.
      const res = await fetch(`sw.js?v=${Date.now()}`, { cache: "reload" });
      const m = (await res.text()).match(/mtg-mazos-(v\d+)/);
      if (m) { liveVersion = m[1]; renderStatus(); }
    } catch (_) { /* sin red: da igual */ }
  }
  const isOutdated = () => liveVersion && liveVersion !== APP_VERSION;

  async function forceUpdate() {
    logEvent(`⬆️ Actualizando app ${APP_VERSION} → ${liveVersion || "última"}`);
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch (_) {}
    location.reload();
  }

  let statusEl = null;
  function renderStatus() {
    if (!statusEl) {
      const meta = document.getElementById("syncMeta");
      if (!meta) return;
      statusEl = document.createElement("div");
      statusEl.id = "mtg-sync-status";
      statusEl.style.cssText = "font-size:11.5px;color:#9aa1ad;margin-top:3px;cursor:pointer";
      statusEl.title = "Toca para ver el detalle";
      statusEl.onclick = () => { if (isOutdated()) forceUpdate(); else openModal(); };
      meta.parentNode.insertBefore(statusEl, meta.nextSibling);
    }
    const cfg = getCfg();
    if (isOutdated()) {
      statusEl.innerHTML = `⚠️ App desactualizada (${APP_VERSION} → ${liveVersion}) — <b>toca para actualizar</b>`;
      statusEl.style.color = "#ffb454";
      return;
    }
    statusEl.style.color = "#9aa1ad";
    if (!cfg.token) { statusEl.textContent = "☁️ Sync sin configurar — toca para poner el token"; return; }
    if (syncing || deckRefreshRunning) { statusEl.textContent = "🔄 " + (busyBase || "Trabajando…"); return; }
    if (lastSyncError) { statusEl.textContent = "❌ " + lastSyncError + " — toca para ver"; return; }
    const pend = pendingKeys();
    if (pend.length) { statusEl.textContent = `⬆️ ${pend.length} dato(s) sin subir — toca para ver`; return; }
    statusEl.textContent = `☁️ Al día · comprobado ${hace(lastSyncAt)}`;
  }

  // ── Ciclo de sincronización: fusión por clave ─────────────────────────────────
  let syncing = false, lastSyncError = null, lastSyncAt = 0;
  async function syncNow(manual) {
    const cfg = getCfg();
    if (!cfg.token) { if (manual) toast("❌ Falta el token (botón ☁️)", false); return; }
    if (syncing) return;
    lastSyncAt = Date.now();
    syncing = true;
    busyStart("Comprobando la nube…");
    try {
      detectLocalChanges();
      const remote = await getRemote(cfg);
      busyLabel("Comparando datos…");
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
        busyLabel("Subiendo a la nube…");
        const names = DATA_KEYS.filter((k) => merged[k] && merged[k].ts === (keyTs[k] || 0)).map(shortName);
        try {
          await putRemote(cfg, merged, remote.sha);
          lastSyncError = null;
          logEvent(`⬆️ Subido: ${names.join(", ") || "datos"}`, "ok");
        } catch (err) {
          // No se traga el error: se avisa y queda registrado para el panel de estado.
          lastSyncError = err.message;
          logEvent(`❌ Fallo al subir: ${err.message}`, "err");
          toast("❌ No pude subir a la nube: " + err.message, false);
        }
      }
      if (pulled.length) {
        busyLabel("Aplicando cambios…");
        logEvent(`⬇️ Bajado: ${pulled.map(shortName).join(", ")}`, "ok");
        toast("☁️ Datos actualizados desde la nube");
        setTimeout(() => location.reload(), 900);
      }
      if (!needPush && !pulled.length) lastSyncError = null;
    } catch (err) {
      lastSyncError = err.message;
      logEvent(`❌ Sync: ${err.message}`, "err");
      if (manual) toast("❌ Sync: " + err.message, false);
    }
    finally { syncing = false; busyEnd(); renderStatus(); }
  }

  // ── Indicador de sync en curso (arriba a la derecha) ──────────────────────────
  let busyEl = null, busyCount = 0;
  function ensureBusyEl() {
    if (busyEl) return;
    const style = document.createElement("style");
    style.textContent = "@keyframes mtgspin{from{transform:rotate(0)}to{transform:rotate(360deg)}}";
    document.head.appendChild(style);
    busyEl = document.createElement("div");
    busyEl.id = "mtg-sync-busy";
    busyEl.style.cssText = `position:fixed;top:calc(10px + env(safe-area-inset-top));right:12px;z-index:1002;
      display:none;align-items:center;gap:6px;background:#20242d;border:1px solid #2a2f3a;color:#9aa1ad;
      border-radius:999px;padding:4px 10px;font:600 11.5px system-ui;box-shadow:0 4px 14px rgba(0,0,0,.35)`;
    busyEl.innerHTML = `<span style="display:inline-block;animation:mtgspin 1s linear infinite">🔄</span><span id="mtg-busy-label"></span>`;
    document.body.appendChild(busyEl);
  }
  let busyTimer = null, busyStartedAt = 0, busyBase = "";
  function busyLabel(label) {
    if (!busyEl) return;
    busyBase = label || "Trabajando…";
    busyEl.querySelector("#mtg-busy-label").textContent = busyBase;
  }
  function busyStart(label) {
    ensureBusyEl();
    busyCount++;
    busyLabel(label || "Sincronizando…");
    busyEl.style.display = "flex";
    // Contador de segundos: deja claro que sigue trabajando y cuánto lleva.
    if (!busyTimer) {
      busyStartedAt = Date.now();
      busyTimer = setInterval(() => {
        if (!busyEl || !busyCount) return;
        const s = Math.round((Date.now() - busyStartedAt) / 1000);
        busyEl.querySelector("#mtg-busy-label").textContent = s > 2 ? `${busyBase} ${s}s` : busyBase;
      }, 1000);
    }
  }
  function busyEnd() {
    busyCount = Math.max(0, busyCount - 1);
    if (!busyCount) {
      if (busyTimer) { clearInterval(busyTimer); busyTimer = null; }
      if (busyEl) busyEl.style.display = "none";
    }
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
        <div style="color:#9aa1ad;font-size:12.5px;margin-bottom:8px">Automática: fusiona por dato (gana el más nuevo). Los botones son solo para forzar.</div>
        <div id="sy-ver" style="font-size:12px;margin-bottom:12px;padding:8px;border-radius:9px;background:#0f1115;border:1px solid #2a2f3a"></div>
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
        <button id="sy-upcol" style="width:100%;margin-top:8px;padding:8px;border-radius:10px;border:1px solid #2a2f3a;background:transparent;color:#9aa1ad">📦 Subir solo la colección de este dispositivo</button>
        <button id="sy-diag" style="width:100%;margin-top:8px;padding:8px;border-radius:10px;border:1px solid #2a2f3a;background:transparent;color:#9aa1ad">🔍 Ver estado de cada dato</button>
        <div id="sy-diag-out" style="font-size:11.5px;color:#9aa1ad;margin-top:8px"></div>
        <div style="font-size:12px;color:#9aa1ad;margin:12px 0 4px;font-weight:600">📜 Actividad reciente</div>
        <div id="sy-log" style="font-size:11px;color:#9aa1ad;max-height:150px;overflow-y:auto;background:#0f1115;border:1px solid #2a2f3a;border-radius:9px;padding:8px"></div>
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
    // Registro persistente: sobrevive a las recargas, para saber qué pasó.
    const renderLog = () => {
      const el = q("#sy-log");
      if (!el) return;
      el.innerHTML = log.length
        ? log.slice().reverse().map((e) => {
            const hora = new Date(e.t).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
            const dia = new Date(e.t).toLocaleDateString("es-ES", { day: "2-digit", month: "short" });
            const col = e.kind === "err" ? "#f08a8a" : e.kind === "ok" ? "#5fd98a" : "#9aa1ad";
            return `<div style="color:${col};padding:1px 0">${dia} ${hora} · ${e.msg}</div>`;
          }).join("")
        : "<div style='opacity:.6'>Sin actividad registrada todavía.</div>";
    };
    renderLog();
    // Versión instalada vs publicada + botón para forzar la actualización.
    const renderVer = () => {
      const el = q("#sy-ver");
      if (!el) return;
      const live = liveVersion ? liveVersion : "comprobando…";
      el.innerHTML = isOutdated()
        ? `<span style="color:#ffb454">⚠️ Esta app: <b>${APP_VERSION}</b> · publicada: <b>${live}</b></span>
           <button id="sy-upd" style="width:100%;margin-top:8px;padding:8px;border-radius:9px;border:none;background:#ffb454;color:#241a08;font-weight:700">⬆️ Actualizar ahora</button>`
        : `<span>Versión de la app: <b>${APP_VERSION}</b> · publicada: <b>${live}</b> ${liveVersion === APP_VERSION ? "✅" : ""}</span>
           <button id="sy-upd" style="width:100%;margin-top:8px;padding:8px;border-radius:9px;border:1px solid #2a2f3a;background:transparent;color:#9aa1ad">🔄 Forzar recarga de la app</button>`;
      const b = q("#sy-upd");
      if (b) b.onclick = forceUpdate;
    };
    renderVer();
    checkVersion().then(renderVer);
    q("#sy-close").onclick = () => wrap.remove();
    wrap.onclick = (e) => { if (e.target === wrap) wrap.remove(); };
    q("#sy-save").onclick = () => { setCfg(readForm()); status("✅ Config guardada."); };
    q("#sy-sync").onclick = async () => { setCfg(readForm()); status("Sincronizando…"); await syncNow(true); status(lastSyncError ? "❌ " + lastSyncError : "✅ Sincronizado."); };
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
    // Sube SOLO las claves de colección de este dispositivo, sin tocar el resto
    // (pedidas, proxies, cardmarket… se quedan como estén en la nube).
    q("#sy-upcol").onclick = async () => {
      setCfg(readForm());
      status("Subiendo la colección…");
      try {
        const cfg2 = getCfg();
        const COL = ["mtg-collection-v1", "mtg-collection-data-v1"];
        const now = Date.now();
        const mine = {};
        for (const k of COL) {
          const v = localStorage.getItem(k);
          if (v != null) { mine[k] = { ts: now, value: v }; keyTs[k] = now; shadow[k] = hash(v); }
        }
        if (!Object.keys(mine).length) { status("Este dispositivo no tiene colección importada."); return; }
        persistMeta();
        remoteCache = null;
        const remote = await getRemote(cfg2);
        await putRemote(cfg2, { ...remote.keys, ...mine }, remote.sha);
        status("✅ Colección subida. Los demás datos no se han tocado.");
        toast("☁️ Colección subida a la nube");
      } catch (e) { status("❌ " + e.message); }
    };
    q("#sy-diag").onclick = async () => {
      setCfg(readForm());
      const out = q("#sy-diag-out");
      out.textContent = "Consultando…";
      const fmt = (ts) => ts ? new Date(ts).toLocaleString("es-ES", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
      const NAMES = {
        "mtg-collection-v1": "Colección", "mtg-collection-data-v1": "Colección (detalle)",
        "mtg-price-snapshots-v1": "Precios", "mtg-orders-v1": "Pedidas",
        "mtg-cardmarket-v1": "Cardmarket", "mtg-proxies-v1": "Proxies", "mtg-sell-v1": "Para vender",
      };
      try {
        detectLocalChanges();
        remoteCache = null; // forzar lectura fresca
        const remote = await getRemote(getCfg());
        const rows = DATA_KEYS.map((k) => {
          const lts = keyTs[k] || 0, rts = (remote.keys[k] || {}).ts || 0;
          const has = localStorage.getItem(k) != null;
          let state = "✅ igual";
          if (!has && !rts) state = "· sin datos";
          else if (lts > rts) state = "⬆️ pendiente de subir";
          else if (rts > lts) state = "⬇️ pendiente de bajar";
          return `<div style="display:flex;justify-content:space-between;gap:8px;padding:2px 0">
            <span>${NAMES[k] || k}</span><span>${state}</span></div>
            <div style="opacity:.6;padding-bottom:4px">aquí ${fmt(lts)} · nube ${fmt(rts)}</div>`;
        }).join("");
        out.innerHTML = rows +
          (lastSyncError ? `<div style="color:#f08a8a;margin-top:6px">Último error: ${lastSyncError}</div>` : "") +
          `<div style="opacity:.6;margin-top:6px">Última comprobación: ${fmt(lastSyncAt)}</div>`;
      } catch (e) { out.textContent = "❌ " + e.message; }
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
    sync: () => syncNow(),                       // promesa: termina cuando acaba el ciclo
    refreshDeck: (name) => deckRefresh(true, name), // refrescar solo ese mazo
    toast,
    log: logEvent,
    // Indicador ocupado para procesos de la app: const end = mtgSync.busy("…"); end();
    busy: (label) => { busyStart(label); renderStatus(); let done = false; return () => { if (!done) { done = true; busyEnd(); renderStatus(); } }; },
    setBusy: (l) => { busyLabel(l); renderStatus(); },
  };

  // ── Refresco de mazos desde Archidekt al entrar ────────────────────────────────
  // El navegador no puede consultar Archidekt (CORS), así que: si los datos
  // publicados tienen más de 30 min, lanzamos el workflow (con el token) para que
  // compruebe Archidekt; si hubo cambios, publica y aquí recargamos al detectarlo.
  const DECKS_URL = "data/decks-data.json";
  const DISPATCH_STAMP = "mtg-decks-dispatch-ts";
  const DECKS_STALE_MS = 30 * 60 * 1000;

  async function decksGeneratedAt() {
    const r = await fetch(`${DECKS_URL}?t=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) throw new Error("no decks-data");
    return Date.parse((await r.json()).generatedAt) || 0;
  }

  let deckRefreshRunning = false;
  async function deckRefresh(force, deckName) {
    const cfg = getCfg();
    if (!cfg.token || deckRefreshRunning) return;
    let gen = 0;
    try { gen = await decksGeneratedAt(); } catch { return; }
    if (!force) {
      if (Date.now() - gen < DECKS_STALE_MS) return; // datos recientes
      const last = Number(localStorage.getItem(DISPATCH_STAMP) || 0);
      if (Date.now() - last < DECKS_STALE_MS) return; // ya lo pedimos hace poco
    }
    const owner = location.hostname.split(".")[0];
    const repo = location.pathname.split("/").filter(Boolean)[0] || "mtg-mazos";
    const what = deckName ? `“${deckName}”` : "los mazos";
    try {
      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/workflows/update-decks.yml/dispatches`, {
        method: "POST",
        headers: { ...headers(cfg), "Content-Type": "application/json" },
        body: JSON.stringify({ ref: "main", inputs: { deck: deckName || "" } }),
      });
      if (res.status !== 204) {
        if (force) toast(`❌ No pude lanzar el refresco (HTTP ${res.status}). ¿El token tiene Actions: write?`, false);
        return;
      }
      localStorage.setItem(DISPATCH_STAMP, String(Date.now()));
      deckRefreshRunning = true;
      // Vigilar ~8 min por si publica una versión nueva (solo publica si hubo cambios).
      busyStart(`Actualizando ${what} desde Archidekt…`);
      logEvent(`🔄 Pedido refresco de ${what}`);
      if (force) toast(`🔄 Pedido el refresco de ${what}. Puede tardar 1-2 min.`);
      let tries = 0;
      const iv = setInterval(async () => {
        tries++;
        try {
          const g = await decksGeneratedAt();
          if (g > gen) {
            clearInterval(iv);
            deckRefreshRunning = false;
            busyEnd();
            logEvent(`🃏 Mazos actualizados desde Archidekt`, "ok");
            toast("🃏 Mazos actualizados desde Archidekt");
            setTimeout(() => location.reload(), 900);
            return;
          }
        } catch {}
        if (tries >= 32) {
          clearInterval(iv);
          deckRefreshRunning = false;
          busyEnd();
          renderStatus();
          logEvent(`⏳ Refresco de ${what}: sin publicación nueva tras 8 min`);
          if (force) toast("✅ Sin cambios en Archidekt (o el despliegue va lento)");
        }
      }, 15000);
    } catch { deckRefreshRunning = false; if (force) toast("❌ Error lanzando el refresco", false); }
  }
  const deckRefreshCheck = () => deckRefresh(false);

  // Botón "🔄" junto a la línea de estado de mazos: fuerza el refresco ya.
  function addDeckRefreshButton() {
    const meta = document.getElementById("syncMeta");
    if (!meta || document.getElementById("deckRefreshBtn")) return;
    const b = document.createElement("button");
    b.id = "deckRefreshBtn";
    b.textContent = "🔄";
    b.title = "Actualizar mazos desde Archidekt ahora";
    b.style.cssText = "margin-left:8px;background:none;border:1px solid #2a2f3a;border-radius:8px;color:#9aa1ad;padding:1px 8px;font-size:12px;cursor:pointer;vertical-align:middle";
    b.onclick = () => deckRefresh(true);
    meta.appendChild(b);
  }

  function start() {
    addButton();
    addDeckRefreshButton();
    renderStatus();
    checkVersion();                        // avisa si el dispositivo tiene una versión vieja
    setInterval(checkVersion, 10 * 60000); // y lo revisa cada 10 min
    setInterval(renderStatus, 5000);       // mantiene fresco el "hace Xs"
    syncNow();
    deckRefreshCheck();
    setInterval(() => { if (!document.hidden) syncNow(); }, 60000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) { syncNow(); deckRefreshCheck(); } });
    window.addEventListener("focus", syncNow);
  }
  window.addEventListener("load", start);
})();
