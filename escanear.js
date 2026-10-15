// ── Escáner de cartas: OCR del nombre -> ficha con precio -> Cardmarket filtrado ──
// El precio que mostramos es la referencia de Scryfall (tendencia Cardmarket).
// El precio real por idioma/estado solo está en Cardmarket: por eso los botones
// rápidos abren la carta allí con TUS filtros ya aplicados.
const CARDMARKET_KEY = "mtg-cardmarket-v1";   // lista de Cardmarket (compartida con Deck Builder)
const DESEADOS_KEY = "mtg-deseados-v1";       // deseados: {nombre: {eur: precio máximo}}
const PRESETS_KEY = "mtg-scan-presets-v1";    // botones rápidos de filtros
const PENDING_KEY = "mtg-scan-pending-v1";    // lista de pendientes escaneadas
const FX_KEY = "mtg-fx-v1";                   // cambio EUR->JPY cacheado
const NAMES_KEY = "mtg-card-names-v1";        // catálogo de nombres de Scryfall

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => { localStorage.setItem(k, JSON.stringify(v)); if (window.mtgSync) window.mtgSync.afterImport(); };

let cardmarket = load(CARDMARKET_KEY, {});
let deseados = load(DESEADOS_KEY, {});
let presets = load(PRESETS_KEY, []);
let pending = load(PENDING_KEY, []);
let names = [];           // catálogo de nombres
let fx = load(FX_KEY, null);

// La wishlist admite formato antiguo (número) y nuevo ({q, eur}).
const wishQty = (v) => (typeof v === "object" && v ? (v.q || 1) : (typeof v === "number" ? v : 1));
const wishEur = (v) => (typeof v === "object" && v && v.eur ? Number(v.eur) : null);
const inWishlist = (name) => cardmarket[name] != null;
const enDeseados = (name) => deseados[name] != null;
const topeDeseado = (name) => (deseados[name] && deseados[name].eur != null ? Number(deseados[name].eur) : null);
/** ¿La carta está en alguna de las dos listas? */
const enAlgunaLista = (name) => inWishlist(name) || enDeseados(name);

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
      video: { facingMode: useBack ? { ideal: "environment" } : "user", width: { ideal: 1280 } },
    });
    $("cam").srcObject = stream;
    await $("cam").play();
  } catch (err) {
    status("❌ No pude abrir la cámara: " + err.message + ". Usa 📁 o el buscador.");
  }
}
function stopCam() { if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; } }
const status = (m) => { $("scanStatus").innerHTML = m; };

// ── Reconocimiento por ILUSTRACIÓN (huella de imagen) ─────────────────────────
// Comparamos la huella de lo que ve la cámara con las de todas las cartas.
// No lee texto: funciona igual en japonés, inglés o lo que sea.
const PALABRAS = 8;              // 8 x 32 bits = huella de 256 bits
let HASHES = null;   // Uint32Array (PALABRAS por carta)
let INDEX = null;    // ["nombre|set|num", ...]
let NOMBRE_ID = null; // id de nombre por carta, para medir el margen contra OTRA carta
let cargandoBD = null;

// Umbrales medidos con 1.400 cartas y fotos simuladas de móvil:
// foto buena -> distancia ~27 (p95 41); encuadre malo -> ~76 con margen ~4.
// Con esto entra el 98% de las buenas y no cuela ninguna mala.
const MAX_DIST = 45;
const MIN_MARGEN = 12;

function cargarBD() {
  if (cargandoBD) return cargandoBD;
  cargandoBD = (async () => {
    status("Cargando el reconocedor… (solo la primera vez)");
    const [b, t] = await Promise.all([
      fetch("data/art-hashes.bin").then((r) => { if (!r.ok) throw new Error("faltan las huellas"); return r.arrayBuffer(); }),
      fetch("data/art-index.txt").then((r) => r.text()),
    ]);
    const dv = new DataView(b);
    const n = Math.floor(b.byteLength / (PALABRAS * 4));
    HASHES = new Uint32Array(n * PALABRAS);
    for (let i = 0; i < n * PALABRAS; i++) HASHES[i] = dv.getUint32(i * 4);
    INDEX = t.split("\n");
    // Si no cuadran, la base es de otro formato (p.ej. la de 64 bits): mejor
    // decirlo que reconocer cualquier cosa.
    if (INDEX.length !== n) throw new Error("la base de huellas es de otra versión; se está regenerando, prueba en unos minutos");
    // Dos cartas con el MISMO nombre no son una confusión: el margen se mide
    // siempre contra una carta distinta.
    const ids = new Map();
    NOMBRE_ID = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      const nm = (INDEX[i] || "").split("|")[0];
      let id = ids.get(nm);
      if (id === undefined) { id = ids.size; ids.set(nm, id); }
      NOMBRE_ID[i] = id;
    }
    status(`Reconocedor listo: ${n.toLocaleString("es-ES")} ilustraciones.`);
    return n;
  })().catch((e) => { cargandoBD = null; status("❌ " + e.message + " — lanza el proceso de huellas en GitHub."); throw e; });
  return cargandoBD;
}

const popcount = (x) => { x -= (x >> 1) & 0x55555555; x = (x & 0x33333333) + ((x >> 2) & 0x33333333); x = (x + (x >> 4)) & 0x0f0f0f0f; return (x * 0x01010101) >> 24; };

// Proporciones de la ilustración dentro de una carta (marco moderno).
const ARTE = { x: 0.079, y: 0.112, w: 0.842, h: 0.424 };

const lienzoDet = document.createElement("canvas");
// La carta, pintada una sola vez por fotograma: los 25 encuadres se recortan
// de aquí. Recortar 25 veces del vídeo a tamaño completo era lo que de verdad
// hacía lento el escaneo (50 drawImage grandes por fotograma).
const lienzoCarta = document.createElement("canvas"); lienzoCarta.width = 288; lienzoCarta.height = 402;
const lienzo9 = document.createElement("canvas"); lienzo9.width = 9; lienzo9.height = 8;
const lienzoMed = document.createElement("canvas"); lienzoMed.width = 36; lienzoMed.height = 32;

/** Huella de 256 bits de una región, igual que la calculada en el servidor. */
function huella(fuente, sx, sy, sw, sh) {
  // Reducir en dos pasos da una miniatura más fiel (y la huella coincide mejor).
  const m = lienzoMed.getContext("2d", { willReadFrequently: true });
  m.imageSmoothingEnabled = true; m.imageSmoothingQuality = "high";
  m.drawImage(fuente, sx, sy, sw, sh, 0, 0, 36, 32);
  const c = lienzo9.getContext("2d", { willReadFrequently: true });
  c.imageSmoothingEnabled = true; c.imageSmoothingQuality = "high";
  c.drawImage(lienzoMed, 0, 0, 36, 32, 0, 0, 9, 8);
  const d = c.getImageData(0, 0, 9, 8).data;
  const h = new Uint32Array(PALABRAS);
  let bit = 0;
  const pon = () => { h[bit >> 5] |= 1 << (31 - (bit & 31)); };
  for (let ch = 0; ch < 3; ch++)
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) {
        if (d[(y * 9 + x) * 4 + ch] > d[(y * 9 + x + 1) * 4 + ch]) pon();
        bit++;
      }
  const luz = (p) => 0.299 * d[p * 4] + 0.587 * d[p * 4 + 1] + 0.114 * d[p * 4 + 2];
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) {
      if (luz(y * 9 + x) > luz(y * 9 + x + 1)) pon();
      bit++;
    }
  return h;
}

/** Distancia entre la huella h y la carta i, cortando en cuanto se pasa de `tope`. */
function distancia(i, h, tope) {
  const p = i * PALABRAS;
  let d = popcount(HASHES[p] ^ h[0]) + popcount(HASHES[p + 1] ^ h[1])
        + popcount(HASHES[p + 2] ^ h[2]) + popcount(HASHES[p + 3] ^ h[3]);
  if (d >= tope) return d;   // ya no puede ganar: nos ahorramos la otra mitad
  return d + popcount(HASHES[p + 4] ^ h[4]) + popcount(HASHES[p + 5] ^ h[5])
           + popcount(HASHES[p + 6] ^ h[6]) + popcount(HASHES[p + 7] ^ h[7]);
}

// Filtro barato: con media huella (128 bits) se descarta el 87% de la base.
// Medido con recortes muy desviados, la carta correcta nunca pasó de 43, así
// que cortar en 52 deja margen de sobra.
const CORTE_CORTA = 52;

/** Preselección con media huella, para no recorrer las 54.788 en cada encuadre. */
function listaCorta(h) {
  const n = NOMBRE_ID.length;
  const out = new Uint32Array(n);
  let k = 0;
  for (let i = 0; i < n; i++) {
    const p = i * PALABRAS;
    const d = popcount(HASHES[p] ^ h[0]) + popcount(HASHES[p + 1] ^ h[1])
            + popcount(HASHES[p + 2] ^ h[2]) + popcount(HASHES[p + 3] ^ h[3]);
    if (d <= CORTE_CORTA) out[k++] = i;
  }
  // Si queda demasiado corta, algo raro pasa: mejor mirarlo todo.
  return k < 200 ? null : out.subarray(0, k);
}

/** Carta más parecida a la huella (sin calcular el margen: es la mitad del coste). */
function mejorCarta(h, lista) {
  if (!HASHES) return null;
  const n = lista ? lista.length : NOMBRE_ID.length;
  let mejor = 257, idx = -1;
  for (let j = 0; j < n; j++) {
    const i = lista ? lista[j] : j;
    const d = distancia(i, h, mejor);
    if (d < mejor) { mejor = d; idx = i; }
  }
  return idx < 0 ? null : { i: idx, dist: mejor };
}

/** Distancia a la mejor carta DISTINTA: cuanto más lejos, más seguros estamos. */
function margenDe(h, idx) {
  const suyo = NOMBRE_ID[idx];
  let otra = 257;
  for (let i = 0; i < NOMBRE_ID.length; i++) {
    if (NOMBRE_ID[i] === suyo) continue;
    const d = distancia(i, h, otra);
    if (d < otra) otra = d;
  }
  return otra;
}

/** Busca la carta más parecida, con su margen. */
function buscarHuella(h) {
  const r = mejorCarta(h);
  if (!r) return null;
  return { i: r.i, dist: r.dist, margen: margenDe(h, r.i) - r.dist };
}

// La guía verde está colocada sobre la CAJA, y el vídeo va con object-fit:cover,
// o sea recortado para rellenarla. Si calculamos el recorte sobre el vídeo
// entero analizamos un trozo que no es el que encuadras: con una cámara 16:9
// en una caja 3:4 solo se ve el ~42% del ancho. Estas constantes son las
// mismas que .cam-card-guide y .cam-art-guide en styles.css.
const GUIA = { top: 0.14, alto: 0.72, prop: 0.716 };

/** Región de la ilustración dentro de un marco de carta, con holgura. */
function zonaArte(m, dz, dy) {
  return {
    x: m.x + m.w * (ARTE.x - dz / 2),
    y: m.y + m.h * (ARTE.y + dy - dz / 2),
    w: m.w * (ARTE.w + dz),
    h: m.h * (ARTE.h + dz),
  };
}

/** Dibuja encima del vídeo el rectángulo donde ha encontrado la carta. */
function pintarMarco(v, carta, hallada) {
  const c = $("marco");
  if (!c) return;
  const caja = v.getBoundingClientRect();
  const cw = Math.round(caja.width), ch = Math.round(caja.height);
  if (!cw || !ch) return;
  if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
  const g = c.getContext("2d");
  g.clearRect(0, 0, cw, ch);
  if (!carta) return;
  // De coordenadas del vídeo a coordenadas de pantalla (object-fit: cover).
  const escala = Math.max(cw / v.videoWidth, ch / v.videoHeight);
  const ox = (cw - v.videoWidth * escala) / 2, oy = (ch - v.videoHeight * escala) / 2;
  const x = carta.x * escala + ox, y = carta.y * escala + oy;
  const w = carta.w * escala, h = carta.h * escala;
  // Verde si la ha encontrado; gris punteado si es solo el encuadre de apoyo.
  g.strokeStyle = hallada ? "#3ecf8e" : "rgba(255,255,255,.45)";
  g.lineWidth = 2;
  if (!hallada) g.setLineDash([8, 6]);
  g.strokeRect(x, y, w, h);
  g.setLineDash([]);
  g.strokeStyle = hallada ? "rgba(62,207,142,.55)" : "rgba(255,255,255,.3)";
  g.lineWidth = 1; g.setLineDash([5, 4]);
  g.strokeRect(x + w * ARTE.x, y + h * ARTE.y, w * ARTE.w, h * ARTE.h);
  g.setLineDash([]);
}

/** Pinta la carta detectada en un lienzo propio y devuelve su rectángulo. */
function pintarCarta(v, m) {
  const vw = v.videoWidth, vh = v.videoHeight;
  const x = Math.max(0, Math.min(m.x, vw - 2)), y = Math.max(0, Math.min(m.y, vh - 2));
  const w = Math.max(2, Math.min(m.w, vw - x)), h = Math.max(2, Math.min(m.h, vh - y));
  const c = lienzoCarta.getContext("2d", { willReadFrequently: true });
  c.imageSmoothingEnabled = true; c.imageSmoothingQuality = "high";
  c.drawImage(v, x, y, w, h, 0, 0, lienzoCarta.width, lienzoCarta.height);
  return { x: 0, y: 0, w: lienzoCarta.width, h: lienzoCarta.height };
}

/** Pinta en la lupa el trozo exacto que se compara, para poder verlo. */
function pintarLupa(fuente, r) {
  const c = $("lupa");
  if (!c) return;
  c.getContext("2d").drawImage(fuente, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
}

/** Parte del vídeo que de verdad se ve en pantalla (object-fit: cover recorta). */
function zonaVisible(v) {
  const caja = v.getBoundingClientRect();
  const cw = caja.width || v.clientWidth, ch = caja.height || v.clientHeight;
  const vw = v.videoWidth, vh = v.videoHeight;
  if (!cw || !ch || !vw || !vh) return { x: 0, y: 0, w: vw, h: vh };
  const escala = Math.max(cw / vw, ch / vh);
  const w = Math.min(vw, cw / escala), h = Math.min(vh, ch / escala);
  return { x: (vw - w) / 2, y: (vh - h) / 2, w, h };
}

/** Busca la carta dentro de una zona de la imagen, sin encuadre fijo. */
function detectarEnZona(fuente, vis) {
  if (!global_deteccion()) return null;
  const W = Math.min(160, Math.round(vis.w));
  const H = Math.max(40, Math.round((vis.h * W) / vis.w));
  if (W < 40) return null;
  lienzoDet.width = W; lienzoDet.height = H;
  const c = lienzoDet.getContext("2d", { willReadFrequently: true });
  c.drawImage(fuente, vis.x, vis.y, vis.w, vis.h, 0, 0, W, H);
  const d = c.getImageData(0, 0, W, H).data;
  const gris = new Uint8ClampedArray(W * H);
  for (let i = 0; i < W * H; i++) gris[i] = (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) | 0;
  const r = global_deteccion().detectarCarta(gris, W, H);
  if (!r) return null;
  const k = vis.w / W;
  return { x: vis.x + r.x * k, y: vis.y + r.y * k, w: r.w * k, h: r.h * k, score: r.score };
}
const detectarEnVideo = (v) => detectarEnZona(v, zonaVisible(v));
const global_deteccion = () => (typeof mtgDeteccion !== "undefined" ? mtgDeteccion : null);

/** La guía dibujada en pantalla, traducida a píxeles del vídeo. */
function marcoCarta(v) {
  const caja = v.getBoundingClientRect();
  const cw = caja.width || v.clientWidth, ch = caja.height || v.clientHeight;
  const vw = v.videoWidth, vh = v.videoHeight;
  if (!cw || !ch || !vw || !vh) return { x: 0, y: 0, w: vw, h: vh };
  // object-fit: cover -> el vídeo se escala al máximo y se recorta centrado.
  const escala = Math.max(cw / vw, ch / vh);
  const ox = (cw - vw * escala) / 2, oy = (ch - vh * escala) / 2;
  const aPx = (x, y) => ({ x: (x - ox) / escala, y: (y - oy) / escala });
  const gh = ch * GUIA.alto, gw = gh * GUIA.prop;
  const p1 = aPx((cw - gw) / 2, ch * GUIA.top);
  const p2 = aPx((cw + gw) / 2, ch * GUIA.top + gh);
  return { x: p1.x, y: p1.y, w: p2.x - p1.x, h: p2.y - p1.y };
}

let escaneando = false, cicloId = null;
let ultimaId = null, ultimaTs = 0;   // para no apuntar dos veces la misma carta
let candidata = null;                // carta vista en el ciclo anterior

/** Reprograma el siguiente ciclo de escaneo. */
function seguir(ms = 120) {
  if (!escaneando) return;
  if (cicloId) clearTimeout(cicloId);
  cicloId = setTimeout(unCiclo, ms);
}

/** Carta reconocida: la enseña, la suma a la sesion y sigue escaneando. */
async function acertado(card) {
  // Si la misma carta sigue delante de la camara no la contamos otra vez;
  // en el escaneo por foto (escaneando=false) siempre cuenta.
  const repetida = escaneando && card.id === ultimaId && Date.now() - ultimaTs < 6000;
  ultimaId = card.id; ultimaTs = Date.now();
  await getFx();
  status(`✅ ${esc(card.name)}`);
  renderCard(card);
  if (!repetida) {
    addSesion(card);
    try { navigator.vibrate && navigator.vibrate(enAlgunaLista(card.name) ? [60, 40, 60] : 60); } catch (_) {}
  }
  seguir(900);   // margen para apartar la carta y poner la siguiente
}

async function unCiclo() {
  if (!escaneando) return;
  const v = $("cam");
  if (!v.videoWidth) { seguir(); return; }
  try {
    // Buscamos la carta en toda la imagen; si no se ve clara, el marco fijo.
    const detectada = detectarEnVideo(v);
    const m = detectada || marcoCarta(v);
    pintarMarco(v, m, !!detectada);

    // El rectángulo nunca sale exacto y un desvío pequeño en la carta se
    // multiplica al recortar la ilustración, así que probamos una rejilla de
    // encuadres (medido: con 25 se reconoce el doble que con 9).
    const carta = pintarCarta(v, m);
    let top = null, recorte = zonaArte(carta, 0, 0), mejorH = null;
    // Preselección con el encuadre central; los 25 se comparan solo contra ella.
    const corta = listaCorta(huella(lienzoCarta, recorte.x, recorte.y, recorte.w, recorte.h));
    for (const dz of [-0.06, -0.03, 0, 0.03, 0.06])
      for (const dy of [-0.03, -0.015, 0, 0.015, 0.03]) {
        const z = zonaArte(carta, dz, dy);
        const h = huella(lienzoCarta, z.x, z.y, z.w, z.h);
        const r = mejorCarta(h, corta);
        if (r && (!top || r.dist < top.dist)) { top = r; recorte = z; mejorH = h; }
      }
    pintarLupa(lienzoCarta, recorte);
    // El margen SIEMPRE contra la base entera: si no, una carta gemela fuera
    // de la preselección pasaría desapercibida.
    if (top && mejorH) top.margen = margenDe(mejorH, top.i) - top.dist;
    if (top && top.dist <= MAX_DIST && top.margen >= MIN_MARGEN) {
      const [nombre, set, num] = (INDEX[top.i] || "").split("|");
      // Pedimos dos ciclos seguidos con la misma carta: un fotograma suelto
      // con reflejo o movido puede dar cualquier cosa.
      if (nombre && nombre === candidata) {
        candidata = null;
        await acertadoPorArte(nombre, set, num, top);
        return;
      }
      candidata = nombre;
      status(`Confirmando ${esc(nombre || "…")}…`);
      seguir(80);
      return;
    }
    candidata = null;
    if (top) {
      const aviso = top.dist <= MAX_DIST
        ? "Dudo entre varias cartas parecidas… mueve un poco la carta."
        : detectada
          ? "Carta encontrada, afinando… acércala un poco."
          : "Busco la carta… ponla sobre un fondo liso.";
      status(`${aviso} <span class="meta">(d ${top.dist} · m ${top.margen})</span>`);
    }
  } catch (err) { status("❌ " + err.message); }
  seguir();
}

async function acertadoPorArte(nombre, set, num, top) {
  let card = null;
  try {
    const r = await fetch(`https://api.scryfall.com/cards/${encodeURIComponent(set)}/${encodeURIComponent(num)}`);
    if (r.ok) card = await r.json();
  } catch (_) {}
  if (!card) { status(`Reconocida ${esc(nombre)} pero no pude cargar sus datos.`); seguir(); return; }
  acertado(card);
}

function pausar() {
  escaneando = false;
  if (cicloId) { clearTimeout(cicloId); cicloId = null; }
  $("shotBtn").textContent = "▶️ Seguir escaneando";
}

async function alternarEscaneo() {
  if (escaneando) { pausar(); status("En pausa."); return; }
  try { await cargarBD(); } catch { return; }
  escaneando = true;
  $("shotBtn").textContent = "⏸️ Pausar";
  status("Escaneando… encuadra la carta en el marco.");
  unCiclo();
}

// ── Resultados ────────────────────────────────────────────────────────────────
function showCandidates(cand) {
  $("detail").innerHTML = `<div class="section-h">¿Cuál es?</div>` + cand.map((c) => `
    <div class="cm-row" data-pick="${esc(c.name)}">
      <img loading="lazy" data-name="${esc(c.name)}" src="${window.mtgImg ? window.mtgImg.placeholder : ""}" alt="${esc(c.name)}" />
      <div class="cm-name">${esc(c.name)}${etiquetasLista(c.name)}</div>
      <div class="cm-qty">${Math.round(c.score * 100)}%</div>
    </div>`).join("");
  if (window.mtgImg) window.mtgImg.load($("detail"));
  $("detail").querySelectorAll("[data-pick]").forEach((el) => { el.onclick = () => openCard(el.dataset.pick); });
}

/** Trae una carta de Scryfall por nombre exacto. */
async function traerCarta(name) {
  try {
    const r = await fetch(`https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}`);
    if (r.ok) return await r.json();
  } catch (_) {}
  return null;
}

async function openCard(name) {
  $("detail").innerHTML = `<div class="empty"><div class="big">⏳</div><div>Cargando ${esc(name)}…</div></div>`;
  let card = null;
  try {
    const r = await fetch(`https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}`);
    if (r.ok) card = await r.json();
  } catch (_) {}
  if (!card) { $("detail").innerHTML = `<div class="empty">❌ No pude cargar la carta.</div>`; return; }
  openCardObj(card);
}

async function openCardObj(card) {
  await getFx();
  status(`✅ ${esc(card.name)}`);
  renderCard(card);
  addSesion(card);
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

function renderCard(card, caja) {
  caja = caja || $("detail");
  const precio = card.prices && card.prices.eur ? Number(card.prices.eur) : null;
  const precioFoil = card.prices && card.prices.eur_foil ? Number(card.prices.eur_foil) : null;
  const w = cardmarket[card.name];
  const objetivo = wishEur(w);
  const tope = topeDeseado(card.name);
  const img = (card.image_uris && card.image_uris.normal) || (card.card_faces && card.card_faces[0].image_uris && card.card_faces[0].image_uris.normal) || "";

  const veredicto = (lim) => (lim == null || precio == null) ? "" : `
    <div class="wish-verdict ${precio <= lim ? "good" : "bad"}">
      ${precio <= lim ? "✅ La referencia está por debajo de tu precio" : "⚠️ La referencia está por encima de tu precio"}
    </div>`;
  const aviso = (w != null ? `
    <div class="wish-alert">
      <div class="wish-title">📋 ¡Está en tu lista de Cardmarket!</div>
      <div>Quieres <b>${wishQty(w)}</b> copia(s)${objetivo != null
        ? ` · tu precio objetivo: <b>${eur(objetivo)}</b> <span class="yen">${yen(objetivo)}</span>` : " · sin precio objetivo puesto"}</div>
      ${veredicto(objetivo)}
    </div>` : "") + (tope != null || enDeseados(card.name) ? `
    <div class="wish-alert">
      <div class="wish-title">💚 ¡Está en tus deseados!</div>
      <div>${tope != null
        ? `Pagas como mucho <b>${eur(tope)}</b> <span class="yen">${yen(tope)}</span>` : "Sin precio máximo puesto"}</div>
      ${veredicto(tope)}
    </div>` : "");

  const botones = presets.length
    ? presets.map((p, i) => `<a class="btn cm-quick" href="${esc(cmLink(card, p))}" target="_blank" rel="noopener">🛒 ${esc(p.name)}</a>`).join("")
    : `<a class="btn" href="${esc(cmLink(card, null))}" target="_blank" rel="noopener">🛒 Ver en Cardmarket</a>
       <div class="note">Configura tus filtros con el ⚙️ para tener botones rápidos.</div>`;

  caja.innerHTML = `
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
      <button class="btn secondary js-addCM">${w != null ? "📋 Ya está en Cardmarket" : "📋 A Cardmarket"}</button>
      <button class="btn secondary js-addDes">${enDeseados(card.name) ? "💚 Ya está en deseados" : "💚 A deseados"}</button>
      <a class="btn secondary" style="text-decoration:none;text-align:center" href="${esc(card.scryfall_uri || "#")}" target="_blank" rel="noopener">🔎</a>
    </div>`;
  const cm = caja.querySelector(".js-addCM");
  if (cm) cm.onclick = () => {
    if (cardmarket[card.name] == null) { cardmarket[card.name] = 1; save(CARDMARKET_KEY, cardmarket); renderCard(card, caja); renderPending(); }
  };
  const des = caja.querySelector(".js-addDes");
  if (des) des.onclick = () => {
    if (enDeseados(card.name)) return;
    const t = prompt(`Precio máximo que quieres pagar por ${card.name} (€):`, precio != null ? precio.toFixed(2) : "");
    if (t === null) return;
    const v = Number(String(t).replace(",", "."));
    deseados[card.name] = { eur: isFinite(v) && v > 0 ? v : null };
    save(DESEADOS_KEY, deseados);
    renderCard(card, caja);
    renderPending();
    renderDeseados();
  };
}

/** Marca de las listas en las que está la carta. */
function etiquetasLista(name) {
  return (inWishlist(name) ? ' <span class="cm-badge">📋</span>' : "")
       + (enDeseados(name) ? ` <span class="cm-badge des">💚${topeDeseado(name) != null ? " " + eur(topeDeseado(name)) : ""}</span>` : "");
}

// ── Sesión de escaneo (se acumula, como el montón de cartas) ─────────────────
function addSesion(card) {
  const precio = card.prices && card.prices.eur ? Number(card.prices.eur) : null;
  pending.unshift({
    name: card.name, id: card.id, eur: precio, ts: Date.now(),
    set: (card.set || "").toUpperCase(), num: card.collector_number || "",
  });
  if (pending.length > 200) pending = pending.slice(0, 200);
  save(PENDING_KEY, pending);
  renderPending();
}

function renderPending() {
  const n = pending.length;
  const total = pending.reduce((acc, p) => acc + (p.eur || 0), 0);
  $("sessionTitle").textContent = n ? `📋 Sesión · ${n} carta(s)` : "Sesión vacía";
  $("sessionTotal").innerHTML = n ? `${eur(total)} <span class="yen">${yen(total)}</span>` : "";
  $("sessionActions").style.display = n ? "flex" : "none";
  $("session").innerHTML = pending.map((p, i) => `
    <div class="ses-item">
      <div class="cm-row" data-pick="${esc(p.name)}" data-i="${i}">
        <img loading="lazy" data-name="${esc(p.name)}" src="${window.mtgImg ? window.mtgImg.placeholder : ""}" alt="${esc(p.name)}" />
        <div class="cm-name">${esc(p.name)}${etiquetasLista(p.name)}
          <div class="note">${esc(p.set)} ${esc(p.num)}</div></div>
        <div class="cm-qty">${p.eur != null ? eur(p.eur) : "—"}<div class="yen">${p.eur != null ? yen(p.eur) : ""}</div></div>
        <button class="cm-x" data-del="${i}" title="Quitar">×</button>
      </div>
      <div class="ses-detalle hidden" data-detalle="${i}"></div>
    </div>`).join("");
  if (window.mtgImg) window.mtgImg.load($("session"));
  $("session").querySelectorAll("[data-pick]").forEach((el) => {
    el.onclick = async (e) => {
      if (e.target.dataset.del !== undefined) return;
      // La ficha se abre aquí mismo, no arriba: así no parece que se haya
      // vuelto a escanear y no pierdes de vista el resto de la sesión.
      const caja = $("session").querySelector(`[data-detalle="${el.dataset.i}"]`);
      if (!caja) return;
      if (!caja.classList.contains("hidden")) { caja.classList.add("hidden"); return; }
      caja.classList.remove("hidden");
      caja.innerHTML = `<div class="empty">⏳ Cargando…</div>`;
      const card = await traerCarta(el.dataset.pick);
      if (!card) { caja.innerHTML = `<div class="empty">❌ No pude cargar la carta.</div>`; return; }
      await getFx();
      renderCard(card, caja);
    };
  });
  $("session").querySelectorAll("[data-del]").forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); pending.splice(+b.dataset.del, 1); save(PENDING_KEY, pending); renderPending(); };
  });
}

// ── Ajustes: presets de filtros de Cardmarket ─────────────────────────────────
/** Lista de deseados: carta + precio máximo que quieres pagar. */
function renderDeseados() {
  const caja = $("desList");
  if (!caja) return;
  const nombres = Object.keys(deseados).sort((a, b) => a.localeCompare(b));
  $("desCount").textContent = nombres.length ? `${nombres.length} carta(s)` : "Vacía";
  caja.innerHTML = nombres.length ? nombres.map((n) => {
    const t = topeDeseado(n);
    return `<div class="cm-row">
      <img loading="lazy" data-name="${esc(n)}" src="${window.mtgImg ? window.mtgImg.placeholder : ""}" alt="${esc(n)}" />
      <div class="cm-name">${esc(n)}</div>
      <div class="cm-qty"><button class="btn secondary js-precio" data-n="${esc(n)}" style="width:auto;padding:4px 8px;font-size:13px">
        ${t != null ? eur(t) : "sin tope"}</button>
        <div class="yen">${t != null ? yen(t) : ""}</div></div>
      <button class="cm-x" data-desdel="${esc(n)}" title="Quitar">×</button>
    </div>`;
  }).join("") : `<div class="empty">Nada en deseados todavía. Añade cartas desde su ficha o aquí abajo.</div>`;
  if (window.mtgImg) window.mtgImg.load(caja);
  caja.querySelectorAll(".js-precio").forEach((b) => {
    b.onclick = () => {
      const n = b.dataset.n, t = topeDeseado(n);
      const v = prompt(`Precio máximo por ${n} (€):`, t != null ? String(t) : "");
      if (v === null) return;
      const num = Number(String(v).replace(",", "."));
      deseados[n] = { eur: isFinite(num) && num > 0 ? num : null };
      save(DESEADOS_KEY, deseados); renderDeseados(); renderPending();
    };
  });
  caja.querySelectorAll("[data-desdel]").forEach((b) => {
    b.onclick = () => { delete deseados[b.dataset.desdel]; save(DESEADOS_KEY, deseados); renderDeseados(); renderPending(); };
  });
}

function anadirDeseado() {
  const t = $("desName").value.trim();
  if (!t) return;
  // Si no es un nombre exacto, lo corregimos con el catálogo de Scryfall.
  const cand = bestMatches(t, 1);
  const nombre = cand.length && cand[0].score > 0.72 ? cand[0].name : t;
  const v = $("desPrice").value.trim();
  const num = Number(v.replace(",", "."));
  deseados[nombre] = { eur: v && isFinite(num) && num > 0 ? num : null };
  save(DESEADOS_KEY, deseados);
  $("desName").value = ""; $("desPrice").value = "";
  renderDeseados(); renderPending();
}

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

// ── Escanear una foto (sin cámara en vivo) ────────────────────────────────────
async function escanearImagen(file) {
  pausar();
  status("🔎 Analizando la foto…");
  try {
    await cargarBD();
    const bmp = await createImageBitmap(file);
    const cajas = [];
    // Primero, dónde está la carta en la foto.
    const hallada = detectarEnZona(bmp, { x: 0, y: 0, w: bmp.width, h: bmp.height });
    if (hallada) cajas.push(hallada);
    // Por si la detección falla: cajas con forma de carta a varios tamaños.
    for (const f of [1, 0.9, 0.8, 0.7]) {
      const h = Math.min(bmp.height, bmp.width / 0.716) * f, w = h * 0.716;
      cajas.push({ x: (bmp.width - w) / 2, y: (bmp.height - h) / 2, w, h });
    }
    let top = null, mejorH = null;
    // Preselección con la mejor caja: aquí se hacían 60 búsquedas completas.
    const z0 = zonaArte(cajas[0], 0, 0);
    const corta = listaCorta(huella(bmp, z0.x, z0.y, z0.w, z0.h));
    for (const caja of cajas)
      for (const dz of [-0.06, -0.03, 0, 0.03, 0.06])
        for (const dy of [-0.03, 0, 0.03]) {
          const z = zonaArte(caja, dz, dy);
          const h = huella(bmp, z.x, z.y, z.w, z.h);
          const r = mejorCarta(h, corta);
          if (r && (!top || r.dist < top.dist)) { top = r; mejorH = h; }
        }
    // Y por si la foto ya es solo la ilustración, recortada por ti.
    const hArte = huella(bmp, 0, 0, bmp.width, bmp.height);
    const rArte = mejorCarta(hArte, corta);
    if (rArte && (!top || rArte.dist < top.dist)) { top = rArte; mejorH = hArte; }
    if (top && mejorH) top.margen = margenDe(mejorH, top.i) - top.dist;
    if (top && top.dist <= MAX_DIST && top.margen >= MIN_MARGEN) {
      const [nombre, set, num] = (INDEX[top.i] || "").split("|");
      await acertadoPorArte(nombre, set, num, top);
    } else if (top && top.dist <= 70) {
      // No llega para darla por buena, pero tampoco la tiramos: que decidas tú.
      const [nombre, set, num] = (INDEX[top.i] || "").split("|");
      status("No estoy seguro con esta foto.");
      $("detail").innerHTML = `<div class="empty">
          <div class="big">🤔</div>
          <div>¿Es <b>${esc(nombre)}</b>?</div>
          <button class="btn" id="siEsEsa" style="margin-top:12px">Sí, es esa</button>
          <div class="note">Si no, repite la foto con la ilustración centrada y sin reflejos.</div>
        </div>`;
      const b = $("siEsEsa");
      if (b) b.onclick = () => acertadoPorArte(nombre, set, num, top);
    } else {
      status("No la reconozco en la foto. Prueba con la ilustración centrada o busca por nombre.");
    }
  } catch (err) { status("❌ " + err.message); }
}

// ── Arranque ──────────────────────────────────────────────────────────────────
async function init() {
  renderPending();
  renderDeseados();
  renderPresets();
  loadNames();
  getFx().then(() => { if (pending.length) renderPending(); });

  $("shotBtn").onclick = alternarEscaneo;

  // Acciones sobre la sesión
  $("sesClear").onclick = () => { if (confirm("¿Vaciar la sesión?")) { pending = []; save(PENDING_KEY, pending); renderPending(); } };
  $("sesCopy").onclick = async () => {
    const txt = pending.map((p) => `1 ${p.name}`).join("\n");
    if (!txt) return;
    try { await navigator.clipboard.writeText(txt); alert(`📋 Copiadas ${pending.length} cartas.`); }
    catch { prompt("Copia la lista:", txt); }
  };
  $("sesWish").onclick = () => {
    let n = 0;
    pending.forEach((p) => { if (cardmarket[p.name] == null) { cardmarket[p.name] = 1; n++; } });
    save(CARDMARKET_KEY, cardmarket);
    renderPending();
    alert(n ? `⭐ ${n} carta(s) añadidas a tu lista de Cardmarket.` : "Ya estaban todas en tu lista.");
  };

  // Plan C: una foto (de la galería o hecha al momento) en vez de vídeo.
  $("fileBtn").onclick = () => $("fileInput").click();
  $("fileInput").onchange = (e) => {
    const f = e.target.files[0]; e.target.value = "";
    if (f) escanearImagen(f);
  };
  $("camBtn").onclick = () => { useBack = !useBack; startCam(); };
  $("manualGo").onclick = () => {
    const t = $("manualName").value.trim();
    if (!t) return;
    const cand = bestMatches(t);
    if (cand.length) showCandidates(cand); else status("No encuentro esa carta.");
  };
  $("manualName").onkeydown = (e) => { if (e.key === "Enter") $("manualGo").click(); };

  $("desBtn").onclick = () => { $("scanView").classList.add("hidden"); $("desView").classList.remove("hidden"); stopCam(); renderDeseados(); };
  $("desBack").onclick = () => { $("desView").classList.add("hidden"); $("scanView").classList.remove("hidden"); startCam(); };
  $("desAdd").onclick = anadirDeseado;
  $("desName").onkeydown = (e) => { if (e.key === "Enter") anadirDeseado(); };
  $("desPrice").onkeydown = (e) => { if (e.key === "Enter") anadirDeseado(); };
  $("sesDes").onclick = () => {
    let n = 0;
    pending.forEach((p) => { if (!enDeseados(p.name)) { deseados[p.name] = { eur: null }; n++; } });
    save(DESEADOS_KEY, deseados); renderPending(); renderDeseados();
    alert(n ? `💚 ${n} carta(s) a deseados. Ponles precio máximo desde 💚 arriba.` : "Ya estaban todas en deseados.");
  };
  $("cfgBtn").onclick = () => { $("scanView").classList.add("hidden"); $("cfgView").classList.remove("hidden"); stopCam(); };
  $("cfgBack").onclick = () => { $("cfgView").classList.add("hidden"); $("scanView").classList.remove("hidden"); startCam(); };
  $("cmSave").onclick = savePreset;
  $("cmClearF").onclick = () => { if (confirm("¿Borrar todos los filtros guardados?")) { presets = []; save(PRESETS_KEY, presets); renderPresets(); } };

  startCam().then(() => alternarEscaneo());
  document.addEventListener("visibilitychange", () => { if (document.hidden) { pausar(); stopCam(); } });
}

if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
init();
