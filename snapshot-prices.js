// Registro diario de precios: lee la colección subida a la nube (collection.json en
// tu repo privado), consulta precios EUR en Scryfall y añade una "foto" de precios al
// bundle. Al abrir la app, autoPull se la descarga. Pensado para GitHub Actions (cron).
//
// Requiere el secreto SYNC_TOKEN (fine-grained token con Contents: read/write sobre el
// repo de datos). Config por variables de entorno (con defaults):
//   DATA_OWNER=zahellx  DATA_REPO=mtg-mazos-data  DATA_PATH=collection.json  DATA_BRANCH=main

const OWNER = process.env.DATA_OWNER || "zahellx";
const REPO = process.env.DATA_REPO || "mtg-mazos-data";
const PATH = process.env.DATA_PATH || "collection.json";
const BRANCH = process.env.DATA_BRANCH || "main";
const TOKEN = process.env.SYNC_TOKEN;
const MIN_PRICE = 0.5;   // ignora cartas por debajo de esto
const MAX_SNAPS = 30;    // fotos que conservamos (igual que la app)

if (!TOKEN) { console.error("❌ Falta el secreto SYNC_TOKEN."); process.exit(1); }

const api = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${PATH}`;
const ghHeaders = { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
const b64e = (s) => Buffer.from(s, "utf8").toString("base64");
const b64d = (s) => Buffer.from(s, "base64").toString("utf8");
const dateStr = (d) => { const p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

async function main() {
  const getRes = await fetch(`${api}?ref=${BRANCH}`, { headers: ghHeaders });
  if (getRes.status === 404) { console.log("No hay collection.json en la nube todavía; nada que hacer."); return; }
  if (!getRes.ok) throw new Error(`GET ${getRes.status}: ${(await getRes.text()).slice(0, 200)}`);
  const meta = await getRes.json();
  // Ficheros >1MB: la API no incluye `content` en el JSON; hay que pedirlo en crudo.
  let text = meta.content && meta.content.trim() ? b64d(meta.content) : null;
  if (!text) {
    const rawRes = await fetch(`${api}?ref=${BRANCH}`, { headers: { ...ghHeaders, Accept: "application/vnd.github.raw" } });
    if (!rawRes.ok) throw new Error(`GET raw ${rawRes.status}`);
    text = await rawRes.text();
  }
  const bundle = JSON.parse(text);
  // Formato v2 {keys:{k:{ts,value}}} o v1 antiguo {data:{k:value}} -> normalizamos a keys.
  const keys = bundle.keys || {};
  if (!bundle.keys && bundle.data) {
    const ts = bundle.updatedAt || 1;
    for (const [k, value] of Object.entries(bundle.data)) keys[k] = { ts, value };
  }
  const getVal = (k) => (keys[k] ? keys[k].value : undefined);

  const cdata = getVal("mtg-collection-data-v1") ? JSON.parse(getVal("mtg-collection-data-v1")) : {};
  const printings = cdata.printings || [];
  if (!printings.length) { console.log("La colección subida no tiene printings con Scryfall ID; nada que hacer."); return; }

  const sids = [...new Set(printings.map((p) => p.scryfallId).filter(Boolean))];
  console.log(`Consultando precios de ${sids.length} printings en Scryfall...`);
  const priceById = {};
  for (let i = 0; i < sids.length; i += 75) {
    const batch = sids.slice(i, i + 75);
    const res = await fetch("https://api.scryfall.com/cards/collection", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "mtg-mazos-cron/1.0" },
      body: JSON.stringify({ identifiers: batch.map((id) => ({ id })) }),
    });
    if (res.ok) {
      const d = await res.json();
      (d.data || []).forEach((c) => { priceById[c.id] = { n: parseFloat(c.prices?.eur) || 0, f: parseFloat(c.prices?.eur_foil) || 0 }; });
    } else {
      console.warn(`  ⚠️ Scryfall ${res.status}`);
    }
    if (i + 75 < sids.length) await new Promise((r) => setTimeout(r, 100));
  }

  const snap = {};
  for (const p of printings) {
    const pr = priceById[p.scryfallId];
    if (!pr) continue;
    const price = p.foil ? pr.f : pr.n;
    if (price >= MIN_PRICE) snap[`${p.scryfallId}|${p.foil ? "f" : "n"}`] = Math.round(price * 100) / 100;
  }
  if (!Object.keys(snap).length) { console.log("No obtuve precios; salgo sin cambios."); return; }

  const snaps = getVal("mtg-price-snapshots-v1") ? JSON.parse(getVal("mtg-price-snapshots-v1")) : {};
  const today = dateStr(new Date());
  snaps[today] = snap;
  const dates = Object.keys(snaps).sort();
  while (dates.length > MAX_SNAPS) delete snaps[dates.shift()];
  keys["mtg-price-snapshots-v1"] = { ts: Date.now(), value: JSON.stringify(snaps) };
  const newBundle = { app: "mtg-mazos", v: 2, updatedAt: Date.now(), keys };

  const putRes = await fetch(api, {
    method: "PUT",
    headers: { ...ghHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ message: `price snapshot ${today}`, content: b64e(JSON.stringify(newBundle)), sha: meta.sha, branch: BRANCH }),
  });
  if (!putRes.ok) throw new Error(`PUT ${putRes.status}: ${(await putRes.text()).slice(0, 200)}`);
  console.log(`✅ Snapshot ${today} guardado (${Object.keys(snap).length} precios, ${dates.length} fechas en histórico).`);
}

main().catch((e) => { console.error("❌", e); process.exit(1); });
