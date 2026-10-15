/**
 * Genera la "huella digital" de la ilustración de cada carta para reconocerlas
 * con la cámara (sin leer texto, así vale en cualquier idioma).
 *
 * Produce dos ficheros en data/:
 *   art-hashes.bin   8 bytes por carta (dHash 8x8 = 64 bits)
 *   art-index.txt    una línea por carta: nombre|set|numero  (mismo orden)
 *
 * Pensado para GitHub Actions: node build-art-hashes.js
 * Variables: LIMIT (para pruebas), CONCURRENCIA (por defecto 8).
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const readline = require("readline");
const sharp = require("sharp");

const OUT_DIR = path.join(__dirname, "data");
const LIMIT = parseInt(process.env.LIMIT || "0", 10);
const CONC = parseInt(process.env.CONCURRENCIA || "8", 10);

/** dHash: compara cada píxel con el de su derecha -> 64 bits robustos al brillo. */
async function dHash(buf) {
  const px = await sharp(buf).greyscale().resize(9, 8, { fit: "fill" }).raw().toBuffer();
  const bytes = Buffer.alloc(8);
  let bit = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const izq = px[y * 9 + x], der = px[y * 9 + x + 1];
      if (izq > der) bytes[bit >> 3] |= 1 << (7 - (bit & 7));
      bit++;
    }
  }
  return bytes;
}

const CABECERAS = { "User-Agent": "mtg-mazos/1.0 (github.com/zahellx/mtg-mazos)", Accept: "*/*" };

async function listaDeCartas() {
  const r0 = await fetch("https://api.scryfall.com/bulk-data", { headers: CABECERAS });
  if (!r0.ok) throw new Error(`Scryfall bulk-data: HTTP ${r0.status}`);
  const meta = await r0.json();
  if (!meta || !Array.isArray(meta.data)) throw new Error("Respuesta inesperada de bulk-data");
  const ua = meta.data.find((b) => b.type === "unique_artwork");
  const url = ua.jsonl_download_uri || ua.download_uri;
  console.log("Descargando catálogo de ilustraciones…", url.split("/").pop());
  const res = await fetch(url, { headers: CABECERAS });
  const gunzip = zlib.createGunzip();
  const rl = readline.createInterface({ input: require("stream").Readable.fromWeb(res.body).pipe(gunzip) });
  const out = [];
  for await (const line of rl) {
    if (!line.trim()) continue;
    let c; try { c = JSON.parse(line); } catch { continue; }
    let art = (c.image_uris || {}).art_crop;
    if (!art && c.card_faces && c.card_faces[0] && c.card_faces[0].image_uris) art = c.card_faces[0].image_uris.art_crop;
    if (!art) continue;
    out.push({ name: c.name, set: c.set, num: c.collector_number, art });
    if (LIMIT && out.length >= LIMIT) break;
  }
  return out;
}

async function main() {
  const t0 = Date.now();
  const cartas = await listaDeCartas();
  console.log(`${cartas.length} ilustraciones a procesar (concurrencia ${CONC})`);

  const hashes = Buffer.alloc(cartas.length * 8);
  const ok = new Array(cartas.length).fill(false);
  let hechas = 0, fallos = 0, siguiente = 0;

  async function trabajador() {
    while (true) {
      const i = siguiente++;
      if (i >= cartas.length) return;
      try {
        const r = await fetch(cartas[i].art, { headers: CABECERAS });
        if (r.ok) {
          const h = await dHash(Buffer.from(await r.arrayBuffer()));
          h.copy(hashes, i * 8);
          ok[i] = true;
        } else fallos++;
      } catch { fallos++; }
      if (++hechas % 500 === 0) {
        const seg = (Date.now() - t0) / 1000;
        const ritmo = hechas / seg;
        console.log(`  ${hechas}/${cartas.length} · ${ritmo.toFixed(1)}/s · faltan ~${Math.round((cartas.length - hechas) / ritmo / 60)} min · fallos ${fallos}`);
      }
      await new Promise((r) => setTimeout(r, 60)); // amable con el servidor
    }
  }
  await Promise.all(Array.from({ length: CONC }, trabajador));

  // Solo guardamos las que salieron bien, manteniendo huella e índice alineados.
  const buenas = [];
  const binFinal = Buffer.alloc(cartas.length * 8);
  let n = 0;
  for (let i = 0; i < cartas.length; i++) {
    if (!ok[i]) continue;
    hashes.copy(binFinal, n * 8, i * 8, i * 8 + 8);
    buenas.push(`${cartas[i].name}|${cartas[i].set}|${cartas[i].num}`);
    n++;
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "art-hashes.bin"), binFinal.subarray(0, n * 8));
  fs.writeFileSync(path.join(OUT_DIR, "art-index.txt"), buenas.join("\n"));
  console.log(`\n✅ ${n} huellas (${(n * 8 / 1024).toFixed(0)} KB) · ${fallos} fallos · ${Math.round((Date.now() - t0) / 60000)} min`);
}

main().catch((e) => { console.error("❌", e); process.exit(1); });
