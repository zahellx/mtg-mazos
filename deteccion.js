/**
 * Encuentra dónde está la carta dentro de la imagen de la cámara, para no
 * tener que encuadrarla en un marco fijo.
 *
 * Dos pasos, porque por separado ninguno basta:
 *   1. La carta es la única cosa con TEXTURA (ilustración + texto) sobre una
 *      mesa lisa: se segmenta por energía de bordes en bloques y se coge la
 *      mancha más grande.
 *   2. Esa mancha da la zona aproximada; luego se ajusta un rectángulo con la
 *      proporción exacta de una carta buscando el que mejor cae sobre los
 *      bordes reales.
 *
 * Con sumas acumuladas cada rectángulo se puntúa en tiempo constante.
 */
(function (global) {
  const PROP = 0.716;        // ancho / alto de una carta de Magic
  const BLOQUE = 4;          // píxeles por bloque del mapa de textura

  function mapas(gris, W, H) {
    const gx = new Float32Array(W * H), gy = new Float32Array(W * H);
    for (let y = 1; y < H - 1; y++)
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        gx[i] = Math.abs(gris[i + 1] - gris[i - 1]);
        gy[i] = Math.abs(gris[i + W] - gris[i - W]);
      }
    return { gx, gy };
  }

  /** Mancha con más textura: casi siempre la carta sobre una mesa lisa. */
  function manchaConTextura(gx, gy, W, H) {
    const bw = Math.floor(W / BLOQUE), bh = Math.floor(H / BLOQUE);
    if (bw < 4 || bh < 4) return null;
    const tex = new Float32Array(bw * bh);
    for (let by = 0; by < bh; by++)
      for (let bx = 0; bx < bw; bx++) {
        let s = 0;
        for (let y = by * BLOQUE; y < (by + 1) * BLOQUE; y++)
          for (let x = bx * BLOQUE; x < (bx + 1) * BLOQUE; x++) s += gx[y * W + x] + gy[y * W + x];
        tex[by * bw + bx] = s;
      }
    // Umbral de Otsu sobre la textura: separa "mesa" de "carta" sin fijar
    // un número a mano (depende mucho de la luz y del fondo).
    let max = 0;
    for (let i = 0; i < tex.length; i++) if (tex[i] > max) max = tex[i];
    if (max <= 0) return null;
    const BINS = 64, hist = new Float32Array(BINS);
    for (let i = 0; i < tex.length; i++) hist[Math.min(BINS - 1, Math.floor((tex[i] / max) * BINS))]++;
    let total = tex.length, sum = 0;
    for (let i = 0; i < BINS; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, mejorVar = -1, corte = 0;
    for (let i = 0; i < BINS; i++) {
      wB += hist[i];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      sumB += i * hist[i];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const v = wB * wF * (mB - mF) * (mB - mF);
      if (v > mejorVar) { mejorVar = v; corte = i; }
    }
    const umbral = ((corte + 1) / BINS) * max;

    // Mancha conexa más grande por encima del umbral.
    const visto = new Int32Array(bw * bh).fill(-1);
    const cola = new Int32Array(bw * bh);
    let mejor = null, etiqueta = 0;
    for (let i = 0; i < tex.length; i++) {
      if (tex[i] < umbral || visto[i] !== -1) continue;
      let ini = 0, fin = 0;
      cola[fin++] = i; visto[i] = etiqueta;
      let x1 = bw, y1 = bh, x2 = -1, y2 = -1, n = 0;
      while (ini < fin) {
        const p = cola[ini++], px = p % bw, py = (p / bw) | 0;
        n++;
        if (px < x1) x1 = px; if (px > x2) x2 = px;
        if (py < y1) y1 = py; if (py > y2) y2 = py;
        const vec = [px > 0 ? p - 1 : -1, px < bw - 1 ? p + 1 : -1, py > 0 ? p - bw : -1, py < bh - 1 ? p + bw : -1];
        for (const q of vec) if (q >= 0 && visto[q] === -1 && tex[q] >= umbral) { visto[q] = etiqueta; cola[fin++] = q; }
      }
      if (!mejor || n > mejor.n) mejor = { n, x: x1 * BLOQUE, y: y1 * BLOQUE, w: (x2 - x1 + 1) * BLOQUE, h: (y2 - y1 + 1) * BLOQUE };
      etiqueta++;
    }
    return mejor;
  }

  /**
   * @param {Uint8ClampedArray|Uint8Array} gris  luminancia, W*H
   * @returns {{x,y,w,h,score}|null} en coordenadas de ESA imagen
   */
  function detectarCarta(gris, W, H) {
    if (W < 40 || H < 40) return null;
    const { gx, gy } = mapas(gris, W, H);

    const CV = new Float32Array(W * (H + 1)), RH = new Float32Array(H * (W + 1));
    for (let x = 0; x < W; x++)
      for (let y = 0; y < H; y++) CV[x * (H + 1) + y + 1] = CV[x * (H + 1) + y] + gx[y * W + x];
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) RH[y * (W + 1) + x + 1] = RH[y * (W + 1) + x] + gy[y * W + x];
    const colum = (x, y1, y2) => CV[x * (H + 1) + y2] - CV[x * (H + 1) + y1];
    const fila = (y, x1, x2) => RH[y * (W + 1) + x2] - RH[y * (W + 1) + x1];

    /** Media de energía en los cuatro lados; manda el lado más flojo. */
    function puntuar(x1, y1, w, h) {
      const x2 = x1 + w, y2 = y1 + h;
      const lados = (colum(x1, y1, y2) + colum(x2, y1, y2)) / (2 * h);
      const tapas = (fila(y1, x1, x2) + fila(y2, x1, x2)) / (2 * w);
      return Math.min(lados, tapas) + 0.25 * Math.max(lados, tapas);
    }

    // La mancha de textura es el arte + el texto, o sea casi toda la carta:
    // de ahí sale el tamaño por el que empezar a buscar.
    const mancha = manchaConTextura(gx, gy, W, H);
    const maxAlto = Math.min(H - 2, Math.floor((W - 2) / PROP));
    let altoIni = Math.round(maxAlto * 0.6), cx = W / 2, cy = H / 2;
    if (mancha && mancha.w > 8 && mancha.h > 8) {
      altoIni = Math.max(mancha.h, mancha.w / PROP);
      cx = mancha.x + mancha.w / 2;
      cy = mancha.y + mancha.h / 2;
    }

    let mejor = null;
    const prueba = (x1, y1, w, h) => {
      if (h < 20 || w < 14 || x1 < 1 || y1 < 1 || x1 + w >= W - 1 || y1 + h >= H - 1) return;
      const s = puntuar(x1, y1, w, h);
      if (!mejor || s > mejor.score) mejor = { x: x1, y: y1, w, h, score: s };
    };
    // Alrededor de la mancha: varios tamaños y posiciones.
    for (const f of [0.85, 0.95, 1, 1.06, 1.14, 1.25]) {
      const h = Math.round(altoIni * f), w = Math.round(h * PROP);
      const paso = Math.max(2, Math.round(h * 0.06));
      for (let dy = -3; dy <= 3; dy++)
        for (let dx = -3; dx <= 3; dx++)
          prueba(Math.round(cx - w / 2 + dx * paso), Math.round(cy - h / 2 + dy * paso), w, h);
    }
    // Red de seguridad: si la mancha engañó, barrido general.
    if (!mejor) {
      for (let h = Math.round(maxAlto * 0.35); h <= maxAlto; h += Math.max(2, Math.round(h * 0.1))) {
        const w = Math.round(h * PROP), paso = Math.max(3, Math.round(h * 0.08));
        for (let y1 = 1; y1 + h < H - 1; y1 += paso)
          for (let x1 = 1; x1 + w < W - 1; x1 += paso) prueba(x1, y1, w, h);
      }
    }
    if (!mejor) return null;

    for (let ronda = 0; ronda < 2; ronda++) {
      const r = ronda === 0 ? 3 : 1, base = mejor;
      for (let dh = -3 * r; dh <= 3 * r; dh += r) {
        const h = base.h + dh, w = Math.round(h * PROP);
        for (let dy = -3 * r; dy <= 3 * r; dy += r)
          for (let dx = -3 * r; dx <= 3 * r; dx += r) prueba(base.x + dx, base.y + dy, w, h);
      }
    }
    return mejor;
  }

  const api = { detectarCarta, PROP };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.mtgDeteccion = api;
})(typeof self !== "undefined" ? self : globalThis);
