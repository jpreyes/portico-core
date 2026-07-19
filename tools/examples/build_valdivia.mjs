// build_valdivia.mjs — Tutorial 1 model: a 3-storey building in Valdivia (Chile),
// 15×15 m, with a central stair core (SHELL walls), floor slabs (PLATE) and moment
// FRAMES. Soil D → NCh433 design spectrum. Builds the model, saves the .s3d, and runs
// a headless sanity check (weight, fundamental periods, gravity deflection).
//   node tools/examples/build_valdivia.mjs
import fs from 'fs';
import { Model } from '../../js/model/model.js';
import { Serializer } from '../../js/model/serializer.js';

// numeric.js as a global (headless) — same shim the verification harness uses.
globalThis.window = globalThis;
await import('../../lib/numeric.js');
globalThis.window.numeric = globalThis.numeric;
const { Portico } = await import('../../js/api/portico.js');

// ── geometry ────────────────────────────────────────────────────────────────
const G = [0, 2.5, 5, 7.5, 10, 12.5, 15];   // plan grid (m), 7 lines each way
const COL = [0, 2, 4, 6];                    // grid indices carrying columns (x = 0,5,10,15)
const ZL = [0, 3, 6, 9];                     // base + 3 storeys (m)
const NC = G.length - 1;                     // 6 slab cells per side
// central stair core occupies the middle bay: grid lines i,j ∈ [2,4] (x,y ∈ [5,10])
const isCoreCell = (ci, cj) => ci >= 2 && ci <= 3 && cj >= 2 && cj <= 3;   // 2×2 cells = 5×5 m opening
const onCoreWallX = (i) => i === 2 || i === 4;     // wall lines x = 5, 10
const onCoreWallY = (j) => j === 2 || j === 4;     // wall lines y = 5, 10
const inCoreSpan = (k) => k >= 2 && k <= 4;

const m = new Model(); m.mode = '3D'; m.units = 'kN-m';
m.materials.clear(); m.sections.clear();

// ── material: concrete H30 ────────────────────────────────────────────────────
const CONC = m.addMaterial({
  name: 'Hormigón H30', E: 2.87e7, G: 1.19e7, nu: 0.2, rho: 2.5, alpha: 1e-5,
  design: { family: 'concrete', fc: 30, fyRebar: 420 },   // fc, fy in MPa
}).id;

// ── sections (with design blocks so the design engine can size rebar) ─────────
const rect = (b, h) => ({ A: b * h, Iz: b * h ** 3 / 12, Iy: h * b ** 3 / 12,
  J: b * h ** 3 * (1 / 3 - 0.21 * (h / b) * (1 - (h ** 4) / (12 * b ** 4))) });   // St. Venant rect torsion
const SEC_COL = m.addSection({ name: 'Pilar 50×50', ...rect(0.5, 0.5),
  design: { shape: 'rect', dims: { b: 0.5, h: 0.5 },
    rebar: { dia_mm: 25, nTop: 4, nBot: 4, cover_mm: 40 } } }).id;   // 8Φ25
const SEC_BEAM = m.addSection({ name: 'Viga 30×50', ...rect(0.3, 0.5),
  design: { shape: 'rect', dims: { b: 0.3, h: 0.5 },
    rebar: { dia_mm: 22, nTop: 3, nBot: 3, cover_mm: 40 } } }).id;   // 3Φ22 top + 3Φ22 bot

const T_SLAB = 0.15, T_WALL = 0.20;

// ── node registry (shared nodes reused; base level is fixed) ──────────────────
const nreg = new Map();
const key = (ix, iy, iz) => `${ix},${iy},${iz}`;
function N(ix, iy, iz) {
  const k = key(ix, iy, iz);
  if (nreg.has(k)) return nreg.get(k);
  const fixed = iz === 0;
  const r = fixed ? { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 } : {};
  const id = m.addNode(G[ix], G[iy], ZL[iz], r).id;
  nreg.set(k, id); return id;
}

// ── columns (grid intersections, storey by storey) ────────────────────────────
for (const ix of COL) for (const iy of COL) for (let iz = 0; iz < ZL.length - 1; iz++)
  m.addElement(N(ix, iy, iz), N(ix, iy, iz + 1), CONC, SEC_COL);

// ── beams (moment frame, at each floor along both grid directions) ────────────
for (let iz = 1; iz < ZL.length; iz++) {
  for (const iy of COL) for (let c = 0; c < COL.length - 1; c++)
    m.addElement(N(COL[c], iy, iz), N(COL[c + 1], iy, iz), CONC, SEC_BEAM);   // x-beams
  for (const ix of COL) for (let c = 0; c < COL.length - 1; c++)
    m.addElement(N(ix, COL[c], iz), N(ix, COL[c + 1], iz), CONC, SEC_BEAM);   // y-beams
}

// ── floor slabs (PLATE), with the central stair opening removed ───────────────
const slabNodesByFloor = new Map();   // iz → Set(nodeId) for loads / diaphragms
for (let iz = 1; iz < ZL.length; iz++) {
  const set = new Set();
  for (let ci = 0; ci < NC; ci++) for (let cj = 0; cj < NC; cj++) {
    if (isCoreCell(ci, cj)) continue;                       // stairwell opening
    const ns = [N(ci, cj, iz), N(ci + 1, cj, iz), N(ci + 1, cj + 1, iz), N(ci, cj + 1, iz)];
    m.addArea(ns, CONC, { thickness: T_SLAB, behavior: 'plate' });
    ns.forEach(id => set.add(id));
  }
  slabNodesByFloor.set(iz, set);
}

// ── central stair core: SHELL walls, full height, C-SHAPED (3 sides) so the
// fourth side (y = 5) is the stair ACCESS opening. This is a realistic open core;
// it also breaks the plan symmetry (CM ≠ CR) → genuine lateral–torsional coupling.
// wall lines: x = 5 (i=2) and x = 10 (i=4) spanning y ∈ [5,10]; y = 10 (j=4)
// spanning x ∈ [5,10]. Each meshed 2 (plan) × 3 (storeys).
for (let iz = 0; iz < ZL.length - 1; iz++) {
  for (const i of [2, 4]) for (let j = 2; j < 4; j++)          // walls at x = 5, 10
    m.addArea([N(i, j, iz), N(i, j + 1, iz), N(i, j + 1, iz + 1), N(i, j, iz + 1)],
      CONC, { thickness: T_WALL, behavior: 'shell' });
  for (const j of [4]) for (let i = 2; i < 4; i++)             // wall at y = 10 only (y = 5 open = access)
    m.addArea([N(i, j, iz), N(i + 1, j, iz), N(i + 1, j, iz + 1), N(i, j, iz + 1)],
      CONC, { thickness: T_WALL, behavior: 'shell' });
}

// ── rigid diaphragm per floor (plate slabs carry gravity; the floor acts rigid
//    in-plane for the lateral / seismic analysis) ─────────────────────────────
for (let iz = 1; iz < ZL.length; iz++)
  m.addDiaphragm({ z: ZL[iz], nodes: [...slabNodesByFloor.get(iz)] });

// ── load cases ────────────────────────────────────────────────────────────────
const LC_PP = m.addLoadCase('PP', true).id;                         // self-weight (frame+slab+walls)
const LC_CM = m.addLoadCase('CM', false, 'static', null, 'dead').id;  // superimposed dead
const LC_CV = m.addLoadCase('CV', false, 'static', null, 'live').id;  // live
const LC_SX = m.addLoadCase('Sismo X', false, 'spectrum', 'X', 'seismic').id;
const LC_SY = m.addLoadCase('Sismo Y', false, 'spectrum', 'Y', 'seismic').id;

// superimposed dead 2.0 kN/m² and live 2.0 kN/m², lumped to slab nodes by tributary
// area (each plate cell contributes q·A/4 to each of its four corners).
const Q_CM = 2.0, Q_CV = 2.0, CELL = 2.5 * 2.5;
for (let iz = 1; iz < ZL.length; iz++) {
  const perNode = new Map();
  for (let ci = 0; ci < NC; ci++) for (let cj = 0; cj < NC; cj++) {
    if (isCoreCell(ci, cj)) continue;
    for (const id of [N(ci, cj, iz), N(ci + 1, cj, iz), N(ci + 1, cj + 1, iz), N(ci, cj + 1, iz)])
      perNode.set(id, (perNode.get(id) || 0) + CELL / 4);
  }
  for (const [id, area] of perNode) {
    m.addLoad(LC_CM, { type: 'nodal', nodeId: id, F: [0, 0, -Q_CM * area, 0, 0, 0] });
    m.addLoad(LC_CV, { type: 'nodal', nodeId: id, F: [0, 0, -Q_CV * area, 0, 0, 0] });
  }
}

// ── seismic mass source (ETABS/SAP style): self-weight + CM + 0.25·CV ─────────
m.massSource = { enabled: true, selfWeight: true, g: 9.80665,
  entries: [{ lcId: LC_CM, factor: 1.0 }, { lcId: LC_CV, factor: 0.25 }] };

// ── load combinations (NCh3171 / ACI-style) ──────────────────────────────────
m.addCombination({ name: '1.2CM+1.6CV', factors: [{ lcId: LC_PP, factor: 1.2 }, { lcId: LC_CM, factor: 1.2 }, { lcId: LC_CV, factor: 1.6 }] });
m.addCombination({ name: '1.2CM+CV+1.4SX', factors: [{ lcId: LC_PP, factor: 1.2 }, { lcId: LC_CM, factor: 1.2 }, { lcId: LC_CV, factor: 1.0 }, { lcId: LC_SX, factor: 1.4 }] });
m.addCombination({ name: '1.2CM+CV+1.4SY', factors: [{ lcId: LC_PP, factor: 1.2 }, { lcId: LC_CM, factor: 1.2 }, { lcId: LC_CV, factor: 1.0 }, { lcId: LC_SY, factor: 1.4 }] });

// ── save ──────────────────────────────────────────────────────────────────────
const s3d = new Serializer().toJSON(m);
fs.writeFileSync('examples/tutorial1_valdivia.s3d', s3d, 'utf8');

// ── report ────────────────────────────────────────────────────────────────────
const nAreas = m.areas.size, nShell = [...m.areas.values()].filter(a => a.behavior === 'shell').length;
console.log('MODEL  nodes=%d  frames=%d  areas=%d (plate=%d, shell=%d)  diaph=%d',
  m.nodes.size, m.elements.size, nAreas, nAreas - nShell, nShell, m.diaphragms.size);
console.log('saved  examples/tutorial1_valdivia.s3d  (%d KB)', Math.round(s3d.length / 1024));

// ── headless sanity: weight, periods, gravity deflection ──────────────────────
const p = new Portico(m);
const rPP = await p.solveStatic(LC_PP, { selfWeight: true });
let W = 0; for (const n of m.nodes.values()) { const R = rPP.getReaction?.(n.id); if (R) W += R[2]; }
console.log('self-weight ΣRz = %s kN  (%s kN/m²)', W.toFixed(0), (W / (15 * 15 * 3)).toFixed(2));

const modal = await p.solveModal(8);
const T = modal.period || [];
console.log('periods T = [%s] s', T.slice(0, 6).map(t => t.toFixed(3)).join(', '));
// participation: which modes are the X / Y / torsion sway modes
const part = modal.getParticipation();
if (part) {
  console.log('mode  T(s)   Ux%    Uy%    Rz%');
  part.rows.slice(0, 8).forEach((r, i) =>
    console.log('  %s   %s   %s   %s   %s', i + 1, (T[i] || 0).toFixed(3),
      r.pct[0].toFixed(1).padStart(5), r.pct[1].toFixed(1).padStart(5), r.pct[2].toFixed(1).padStart(5)));
  const cum = part.rows[part.rows.length - 1].cumPct;
  console.log('cumulative %%: Ux=%s Uy=%s Rz=%s', cum[0].toFixed(1), cum[1].toFixed(1), cum[2].toFixed(1));
}
