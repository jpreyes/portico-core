// figure.mjs — figura 3D headless de un modelo (sin navegador, sin GL nativo).
// Proyección isométrica Z-up → SVG vectorial (escala perfecta en el PDF).
// Dibuja la geometría sin deformar (gris) + la deformada/forma modal (azul),
// apoyos y una tríada de ejes. Suficiente para los casos de verificación
// (pórticos/barras; las áreas se dibujan como polígonos).

const cos30 = Math.cos(Math.PI / 6), sin30 = Math.sin(Math.PI / 6);
// Convención: cada proyección devuelve [sx, sy] con sy "hacia ARRIBA positivo"
// (el render hace ty = maxSy − sy para el eje-Y invertido del SVG).
// isométrica 2:1, Z-up: z es la vertical dominante; x,y receden.
function isoFn(x, y, z) { return [(x - y) * cos30, z - (x + y) * sin30]; }

// Elige proyección: si el modelo es PLANO (todos los nodos casi en un plano
// principal) usa una elevación/planta ortográfica limpia; si no, isométrica.
function pickProjection(nodes) {
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const c of nodes.values()) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], c[k]); mx[k] = Math.max(mx[k], c[k]); }
  const r = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]];
  const big = Math.max(...r) || 1;
  const large = r.map(v => v > big * 0.05);          // dimensiones significativas
  // Ortográfica SÓLO si el modelo es planar de verdad (exactamente 2 dims grandes).
  // 1D (línea, p.ej. voladizo) o 3D → isométrica, que muestra la deformada transversal.
  if (large.filter(Boolean).length !== 2) return isoFn;
  if (!large[1]) return (x, y, z) => [x, z];   // plano XZ → elevación (z arriba)
  if (!large[2]) return (x, y, z) => [x, y];   // plano XY → planta
  return (x, y, z) => [y, z];                   // plano YZ → elevación lateral
}

/**
 * @param {object} o
 *   nodes      Map<id,[x,y,z]>            geometría sin deformar
 *   elements   [{n1,n2}]                  barras
 *   areas      [[id,id,id(,id)]]          (opcional) polígonos de área
 *   deformed   Map<id,[x,y,z]>            (opcional) geometría deformada
 *   supports   Set<id>                    (opcional) nodos con apoyo
 *   width      number (def 900)
 *   caption    string (opcional, abajo)
 * @returns {string} SVG
 */
export function renderModelSVG(o) {
  const W = o.width || 900, pad = 26;
  const proj = pickProjection(o.nodes);
  const P = id => { const c = o.nodes.get(id); return c ? proj(c[0], c[1], c[2]) : null; };
  const Pd = id => { const c = (o.deformed || o.nodes).get(id); return c ? proj(c[0], c[1], c[2]) : null; };

  // bbox sobre todos los puntos proyectados (sin + deformado) para encuadrar
  const pts = [];
  for (const id of o.nodes.keys()) { const a = P(id); if (a) pts.push(a); if (o.deformed) { const b = Pd(id); if (b) pts.push(b); } }
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const [px, py] of pts) { if (px < minx) minx = px; if (px > maxx) maxx = px; if (py < miny) miny = py; if (py > maxy) maxy = py; }
  const bw = (maxx - minx) || 1, bh = (maxy - miny) || 1;
  const s = (W - 2 * pad) / bw;
  const H = Math.round(bh * s + 2 * pad);
  const tx = px => pad + (px - minx) * s;
  const ty = py => pad + (maxy - py) * s;   // flip: SVG y hacia abajo
  const L = (a, b) => `${tx(a[0]).toFixed(1)},${ty(a[1]).toFixed(1)} ${tx(b[0]).toFixed(1)},${ty(b[1]).toFixed(1)}`;

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`;
  svg += `<rect width="${W}" height="${H}" fill="#ffffff"/>`;

  // áreas (sin deformar, relleno tenue)
  for (const a of (o.areas || [])) {
    const poly = a.map(id => P(id)).filter(Boolean).map(p => `${tx(p[0]).toFixed(1)},${ty(p[1]).toFixed(1)}`).join(' ');
    if (poly) svg += `<polygon points="${poly}" fill="#dbeafe" fill-opacity="0.5" stroke="#94a3b8" stroke-width="0.8"/>`;
  }
  // barras sin deformar (gris)
  for (const e of o.elements) { const a = P(e.n1), b = P(e.n2); if (a && b) svg += `<polyline points="${L(a, b)}" fill="none" stroke="#9aa7b8" stroke-width="1"/>`; }
  // deformada / forma modal (azul)
  if (o.deformed) {
    for (const e of o.elements) { const a = Pd(e.n1), b = Pd(e.n2); if (a && b) svg += `<polyline points="${L(a, b)}" fill="none" stroke="#2563eb" stroke-width="2"/>`; }
  }
  // apoyos (marcador)
  for (const id of (o.supports || [])) { const a = P(id); if (!a) continue; const X = tx(a[0]), Y = ty(a[1]); svg += `<rect x="${(X - 4).toFixed(1)}" y="${(Y - 4).toFixed(1)}" width="8" height="8" fill="#0f766e" stroke="#fff" stroke-width="0.8"/>`; }

  if (o.caption) svg += `<text x="${W / 2}" y="${H - 6}" font-family="Segoe UI,Arial" font-size="12" fill="#475569" text-anchor="middle">${o.caption.replace(/[<&>]/g, c => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;' }[c]))}</text>`;
  svg += `</svg>`;
  return svg;
}
