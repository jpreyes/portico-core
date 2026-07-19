// plan_elevation.mjs — schematic PLAN and ELEVATION drawings (dimensions, sections,
// materials) for the tutorial buildings. Clean annotated SVG, per language.
//   node tools/examples/plan_elevation.mjs <valdivia|steel> <plan|elev> <es|en>
import fs from 'fs';

const B = {
  valdivia: {
    gx: [0, 5, 10, 15], z: [0, 3, 6, 9],
    col: { es: 'Pilar 50×50 (8Φ25)', en: 'Column 50×50 (8Φ25)' },
    beam: { es: 'Viga 30×50 (3Φ22)', en: 'Beam 30×50 (3Φ22)' },
    slab: { es: 'Losa: placa e = 0.15 m', en: 'Slab: plate t = 0.15 m' },
    core: { span: [5, 10], open: 'y-', es: 'Caja escalera: muros shell e = 0.20 m (C, acceso en y=5)', en: 'Stair core: shell walls t = 0.20 m (C, access at y=5)' },
    mat: { es: 'Hormigón H30 · E = 28.7 GPa', en: 'Concrete H30 · E = 28.7 GPa' },
    ttl: { es: 'Edificio Valdivia — 15 × 15 m, 3 niveles', en: 'Valdivia building — 15 × 15 m, 3 storeys' },
    colS: 0.5,
  },
  steel: {
    gx: [0, 20 / 3, 40 / 3, 20], z: [0, 3.5, 7, 10.5, 14, 17.5],
    col: { es: 'Pilar W14 · Mp = 897 kN·m', en: 'Column W14 · Mp = 897 kN·m' },
    beam: { es: 'Viga W18 · Mp = 449 kN·m', en: 'Beam W18 · Mp = 449 kN·m' },
    mat: { es: 'Acero A992 · Fy = 345 MPa', en: 'Steel A992 · Fy = 345 MPa' },
    ttl: { es: 'Pórtico de acero — 20 × 20 m, 5 pisos', en: 'Steel frame — 20 × 20 m, 5 storeys' },
    colS: 0.5,
  },
};

const [key, view, lang = 'es'] = process.argv.slice(2);
const b = B[key]; if (!b) { console.error('unknown building', key); process.exit(1); }
const L = lang === 'en' ? 'en' : 'es';
const FONT = 'font-family="Segoe UI,Arial" font-size="';
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

// ── shared drawing helpers ────────────────────────────────────────────────────
function dimH(x1, x2, y, txt) {   // horizontal dimension line with ticks + centered label
  const t = 5;
  return `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="#64748b" stroke-width="0.8"/>`
    + `<line x1="${x1}" y1="${y - t}" x2="${x1}" y2="${y + t}" stroke="#64748b" stroke-width="0.8"/>`
    + `<line x1="${x2}" y1="${y - t}" x2="${x2}" y2="${y + t}" stroke="#64748b" stroke-width="0.8"/>`
    + `<rect x="${(x1 + x2) / 2 - 20}" y="${y - 8}" width="40" height="12" fill="#fff"/>`
    + `<text x="${(x1 + x2) / 2}" y="${y + 3}" ${FONT}10.5" fill="#334155" text-anchor="middle">${txt}</text>`;
}
function dimV(y1, y2, x, txt) {   // vertical dimension line
  const t = 5;
  return `<line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}" stroke="#64748b" stroke-width="0.8"/>`
    + `<line x1="${x - t}" y1="${y1}" x2="${x + t}" y2="${y1}" stroke="#64748b" stroke-width="0.8"/>`
    + `<line x1="${x - t}" y1="${y2}" x2="${x + t}" y2="${y2}" stroke="#64748b" stroke-width="0.8"/>`
    + `<rect x="${x - 8}" y="${(y1 + y2) / 2 - 20}" width="12" height="40" fill="#fff"/>`
    + `<text x="${x}" y="${(y1 + y2) / 2}" ${FONT}10.5" fill="#334155" text-anchor="middle" transform="rotate(-90 ${x} ${(y1 + y2) / 2})">${txt}</text>`;
}
function legend(x, y, items) {
  let s = '';
  items.forEach((it, i) => {
    const yy = y + i * 17;
    s += `<rect x="${x}" y="${yy - 8}" width="14" height="10" fill="${it.fill || 'none'}" stroke="${it.stroke || '#334155'}" stroke-width="1"/>`;
    s += `<text x="${x + 20}" y="${yy}" ${FONT}11" fill="#334155">${esc(it.t)}</text>`;
  });
  return s;
}

// ═══ PLAN ═════════════════════════════════════════════════════════════════════
function plan() {
  const span = b.gx[b.gx.length - 1];
  const W = 560, m = 70, S = (W - 2 * m) / span;         // scale px/m
  const H = W + 96;                                       // room for legend
  const X = x => m + x * S, Y = y => m + (span - y) * S;  // plan y flips
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#fff"/>`;
  s += `<text x="${W / 2}" y="26" ${FONT}14" fill="#1e3a8a" text-anchor="middle" font-weight="bold">${esc(b.ttl[L])} — ${L === 'en' ? 'plan' : 'planta'}</text>`;
  // slab fill (Valdivia) with stair opening
  if (b.slab) {
    s += `<rect x="${X(0)}" y="${Y(span)}" width="${span * S}" height="${span * S}" fill="#dbeafe" fill-opacity="0.5"/>`;
    if (b.core) { const [lo, hi] = b.core.span; s += `<rect x="${X(lo)}" y="${Y(hi)}" width="${(hi - lo) * S}" height="${(hi - lo) * S}" fill="#fff"/>`; }
  }
  // beams = grid lines
  for (const gx of b.gx) s += `<line x1="${X(gx)}" y1="${Y(0)}" x2="${X(gx)}" y2="${Y(span)}" stroke="#2563eb" stroke-width="2"/>`;
  for (const gy of b.gx) s += `<line x1="${X(0)}" y1="${Y(gy)}" x2="${X(span)}" y2="${Y(gy)}" stroke="#2563eb" stroke-width="2"/>`;
  // core walls (Valdivia): C-shape — three thick walls, open on the access side (y = lo)
  if (b.core) { const [lo, hi] = b.core.span; const cw = 'stroke="#0f766e" stroke-width="4"';
    s += `<line x1="${X(lo)}" y1="${Y(hi)}" x2="${X(hi)}" y2="${Y(hi)}" ${cw}/>`;   // top wall (y = hi)
    s += `<line x1="${X(lo)}" y1="${Y(lo)}" x2="${X(lo)}" y2="${Y(hi)}" ${cw}/>`;   // left wall (x = lo)
    s += `<line x1="${X(hi)}" y1="${Y(lo)}" x2="${X(hi)}" y2="${Y(hi)}" ${cw}/>`;   // right wall (x = hi)
    s += `<text x="${X((lo + hi) / 2)}" y="${Y((lo + hi) / 2)}" ${FONT}10" fill="#0f766e" text-anchor="middle">${L === 'en' ? 'stair' : 'escalera'}</text>`;
    // access opening indicator on the open side (y = lo)
    s += `<text x="${X((lo + hi) / 2)}" y="${Y(lo) + 15}" ${FONT}9.5" fill="#0f766e" text-anchor="middle">${L === 'en' ? '↑ access' : '↑ acceso'}</text>`;
  }
  // columns at intersections
  const cs = b.colS * S;
  for (const gx of b.gx) for (const gy of b.gx)
    s += `<rect x="${X(gx) - cs / 2}" y="${Y(gy) - cs / 2}" width="${cs}" height="${cs}" fill="#1e3a8a"/>`;
  // dimensions: bay spacings on top and left (overall size is in the title)
  const yTop = m - 34;
  for (let i = 0; i < b.gx.length - 1; i++) s += dimH(X(b.gx[i]), X(b.gx[i + 1]), yTop, ((b.gx[i + 1] - b.gx[i]).toFixed(2).replace(/\.?0+$/, '')) + ' m');
  const xL = m - 34;
  for (let i = 0; i < b.gx.length - 1; i++) s += dimV(Y(b.gx[i]), Y(b.gx[i + 1]), xL, ((b.gx[i + 1] - b.gx[i]).toFixed(2).replace(/\.?0+$/, '')) + ' m');
  // axes
  s += `<text x="${X(span) + 14}" y="${Y(0) + 4}" ${FONT}11" fill="#94a3b8">X</text>`;
  s += `<text x="${X(0) - 4}" y="${Y(span) - 10}" ${FONT}11" fill="#94a3b8">Y</text>`;
  // legend
  const items = [{ t: b.col[L], fill: '#1e3a8a', stroke: '#1e3a8a' }, { t: b.beam[L], stroke: '#2563eb' }];
  if (b.slab) items.push({ t: b.slab[L], fill: '#dbeafe' });
  if (b.core) items.push({ t: b.core[L], stroke: '#0f766e' });
  items.push({ t: b.mat[L], stroke: '#fff' });
  s += legend(m, W + 20, items);
  s += `</svg>`;
  return s;
}

// ═══ ELEVATION ════════════════════════════════════════════════════════════════
function elev() {
  const span = b.gx[b.gx.length - 1], htot = b.z[b.z.length - 1];
  const W = 560, m = 70, mR = 130, S = (W - m - mR) / span;   // wider right margin for the height dims
  const Ht = htot * S + 2 * m + 96;
  const X = x => m + x * S, Y = z => Ht - 96 - m - z * S;
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${Ht}" width="${W}" height="${Ht}"><rect width="${W}" height="${Ht}" fill="#fff"/>`;
  s += `<text x="${W / 2}" y="26" ${FONT}14" fill="#1e3a8a" text-anchor="middle" font-weight="bold">${esc(b.ttl[L])} — ${L === 'en' ? 'elevation' : 'elevación'}</text>`;
  // beams at each floor
  for (let i = 1; i < b.z.length; i++) s += `<line x1="${X(0)}" y1="${Y(b.z[i])}" x2="${X(span)}" y2="${Y(b.z[i])}" stroke="#2563eb" stroke-width="3"/>`;
  // columns
  for (const gx of b.gx) s += `<line x1="${X(gx)}" y1="${Y(0)}" x2="${X(gx)}" y2="${Y(htot)}" stroke="#1e3a8a" stroke-width="4"/>`;
  // ground + fixed supports
  s += `<line x1="${X(0) - 20}" y1="${Y(0)}" x2="${X(span) + 20}" y2="${Y(0)}" stroke="#334155" stroke-width="1.5"/>`;
  for (let gi = 0; gi < 12; gi++) s += `<line x1="${X(0) - 20 + gi * (span * S + 40) / 11}" y1="${Y(0)}" x2="${X(0) - 28 + gi * (span * S + 40) / 11}" y2="${Y(0) + 9}" stroke="#334155" stroke-width="1"/>`;
  for (const gx of b.gx) s += `<path d="M${X(gx)},${Y(0)} l-7,10 h14 z" fill="#0f766e"/>`;
  // story-height dimensions on the right
  const xR = X(span) + 40;
  for (let i = 1; i < b.z.length; i++) s += dimV(Y(b.z[i - 1]), Y(b.z[i]), xR, ((b.z[i] - b.z[i - 1]).toFixed(1).replace(/\.0$/, '')) + ' m');
  s += dimV(Y(0), Y(htot), xR + 30, htot + ' m');
  // bay dims on top
  for (let i = 0; i < b.gx.length - 1; i++) s += dimH(X(b.gx[i]), X(b.gx[i + 1]), Y(htot) - 26, ((b.gx[i + 1] - b.gx[i]).toFixed(2).replace(/\.?0+$/, '')) + ' m');
  // floor labels
  for (let i = 1; i < b.z.length; i++) s += `<text x="${X(0) - 30}" y="${Y(b.z[i]) + 4}" ${FONT}10" fill="#64748b" text-anchor="end">${L === 'en' ? 'L' : 'N'}${i}</text>`;
  // legend
  const items = [{ t: b.col[L], stroke: '#1e3a8a' }, { t: b.beam[L], stroke: '#2563eb' }, { t: b.mat[L], stroke: '#fff' }];
  s += legend(m, Ht - 76, items);
  s += `</svg>`;
  return s;
}

const svg = view === 'plan' ? plan() : elev();
const pref = { valdivia: 't1', steel: 't2' }[key];
const name = `${pref}-${view === 'plan' ? 'plan' : 'elevation'}.${L === 'en' ? 'en.' : ''}svg`;
fs.writeFileSync(`docs/tutorials/img/${name}`, svg, 'utf8');
console.log('✓', name);
