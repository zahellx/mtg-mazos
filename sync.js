// ── Sincronización de la colección vía un repo PRIVADO de GitHub ────────────────
// Guarda un JSON (colección + carpetas + pool + printings + fotos de precio + pedidas)
// en un fichero de un repo privado tuyo. Cualquier dispositivo con el token lo lee/escribe.
// "Último que escribe, gana" (sin merge). El token se guarda solo en este navegador.
(function () {
  const CFG_KEY = "mtg-sync-config";
  const TS_KEY = "mtg-sync-ts";
  // Claves de datos que se sincronizan (todas las que usan las dos apps).
  const DATA_KEYS = [
    "mtg-collection-v1",
    "mtg-collection-data-v1",
    "mtg-price-snapshots-v1",
    "mtg-orders-v1",
    "mtg-cardmarket-v1",
    "mtg-proxies-v1",
  ];

  const getCfg = () => { try { return JSON.parse(localStorage.getItem(CFG_KEY)) || {}; } catch { return {}; } };
  const setCfg = (c) => localStorage.setItem(CFG_KEY, JSON.stringify(c));
  const localTs = () => Number(localStorage.getItem(TS_KEY) || 0);
  const setLocalTs = (t) => localStorage.setItem(TS_KEY, String(t));
  const b64encode = (s) => btoa(unescape(encodeURIComponent(s)));
  const b64decode = (s) => decodeURIComponent(escape(atob(s.replace(/\n/g, ""))));

  function bundle(updatedAt) {
    const data = {};
    for (const k of DATA_KEYS) { const v = localStorage.getItem(k); if (v != null) data[k] = v; }
    return { app: "mtg-mazos", updatedAt, data };
  }
  function applyBundle(obj) {
    if (!obj || !obj.data) return;
    for (const k of DATA_KEYS) {
      if (obj.data[k] != null) localStorage.setItem(k, obj.data[k]);
    }
  }

  function apiBase(cfg) { return `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${encodeURIComponent(cfg.path).replace(/%2F/g, "/")}`; }
  function headers(cfg) { return { Authorization: `Bearer ${cfg.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }; }

  async function getRemote(cfg) {
    const res = await fetch(apiBase(cfg) + `?ref=${cfg.branch || "main"}`, { headers: headers(cfg), cache: "no-store" });
    if (res.status === 404) return { exists: false };
    if (!res.ok) throw new Error(`GitHub GET ${res.status}: ${(await res.text()).slice(0, 120)}`);
    const j = await res.json();
    let parsed = null;
    try { parsed = JSON.parse(b64decode(j.content)); } catch {}
    return { exists: true, sha: j.sha, bundle: parsed };
  }

  async function push() {
    const cfg = getCfg();
    if (!cfg.token) throw new Error("Configura el token primero.");
    const remote = await getRemote(cfg);
    const ts = Date.now();
    const body = {
      message: `collection sync ${new Date(ts).toISOString()}`,
      content: b64encode(JSON.stringify(bundle(ts))),
      branch: cfg.branch || "main",
    };
    if (remote.exists) body.sha = remote.sha;
    const res = await fetch(apiBase(cfg), { method: "PUT", headers: { ...headers(cfg), "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`GitHub PUT ${res.status}: ${(await res.text()).slice(0, 160)}`);
    setLocalTs(ts);
    return ts;
  }

  async function pull(apply = true) {
    const cfg = getCfg();
    if (!cfg.token) throw new Error("Configura el token primero.");
    const remote = await getRemote(cfg);
    if (!remote.exists || !remote.bundle) return { applied: false, reason: "no-remote" };
    const remoteTs = remote.bundle.updatedAt || 0;
    if (apply) { applyBundle(remote.bundle); setLocalTs(remoteTs); }
    return { applied: apply, remoteTs };
  }

  // ── UI: botón flotante + modal ────────────────────────────────────────────────
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
        <div style="font-weight:700;font-size:16px;margin-bottom:4px">☁️ Sincronizar colección</div>
        <div style="color:#9aa1ad;font-size:12.5px;margin-bottom:14px">Se guarda en un repo privado tuyo de GitHub. El token queda solo en este dispositivo.</div>
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
          <button id="sy-up" style="flex:1;padding:10px;border-radius:10px;border:none;background:#6c8cff;color:#0b0e14;font-weight:700">⬆️ Subir</button>
          <button id="sy-down" style="flex:1;padding:10px;border-radius:10px;border:none;background:#3ecf8e;color:#0b0e14;font-weight:700">⬇️ Bajar</button>
        </div>
        <button id="sy-close" style="width:100%;margin-top:8px;padding:8px;border-radius:10px;border:1px solid #2a2f3a;background:transparent;color:#9aa1ad">Cerrar</button>
      </div>`;
    document.body.appendChild(wrap);
    const $ = (id) => wrap.querySelector(id);
    const status = (m) => { $("#sy-status").textContent = m; };
    const readForm = () => {
      const c = getCfg();
      const tokenField = $("#sy-token").value;
      const token = (tokenField && tokenField !== "••••••••") ? tokenField.trim() : c.token;
      return { token, owner: $("#sy-owner").value.trim(), repo: $("#sy-repo").value.trim(), path: c.path || "collection.json", branch: c.branch || "main" };
    };
    $("#sy-close").onclick = () => wrap.remove();
    wrap.onclick = (e) => { if (e.target === wrap) wrap.remove(); };
    $("#sy-save").onclick = () => { setCfg(readForm()); status("✅ Config guardada."); };
    $("#sy-up").onclick = async () => { setCfg(readForm()); status("Subiendo…"); try { await push(); status("✅ Subido a GitHub."); } catch (e) { status("❌ " + e.message); } };
    $("#sy-down").onclick = async () => {
      setCfg(readForm()); status("Bajando…");
      try { const r = await pull(true); if (r.applied) { status("✅ Bajado. Recargando…"); setTimeout(() => location.reload(), 700); } else status("No hay datos en la nube todavía."); }
      catch (e) { status("❌ " + e.message); }
    };
  }

  function addButton() {
    const b = document.createElement("button");
    b.textContent = "☁️";
    b.title = "Sincronizar colección";
    b.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:999;width:52px;height:52px;border-radius:50%;border:1px solid #2a2f3a;background:#20242d;color:#e8eaed;font-size:22px;box-shadow:0 6px 20px rgba(0,0,0,.4);cursor:pointer";
    b.onclick = openModal;
    document.body.appendChild(b);
  }

  // Auto-pull al cargar: si en la nube hay algo más reciente que lo local, lo aplica.
  async function autoPull() {
    const cfg = getCfg();
    if (!cfg.token) return;
    try {
      const remote = await getRemote(cfg);
      if (remote.exists && remote.bundle && (remote.bundle.updatedAt || 0) > localTs()) {
        applyBundle(remote.bundle);
        setLocalTs(remote.bundle.updatedAt || 0);
        toast("☁️ Colección actualizada desde la nube");
        setTimeout(() => location.reload(), 900);
      }
    } catch (_) { /* silencioso */ }
  }

  // API pública para que las apps empujen tras importar.
  window.mtgSync = {
    afterImport: async () => {
      const cfg = getCfg();
      if (!cfg.token) return;
      try { await push(); toast("☁️ Colección subida a la nube"); } catch (e) { toast("❌ Sync: " + e.message, false); }
    },
  };

  window.addEventListener("load", () => { addButton(); autoPull(); });
})();
