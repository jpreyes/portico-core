// build_pushover.mjs — Tutorials 2 & 3 model: a 20×20 m, 5-storey STEEL moment frame
// (AISC / US codes), for a nonlinear static PUSHOVER to collapse and a performance
// assessment. Bare lateral frame (columns + beams) with lumped floor gravity and an
// inverted-triangle lateral pattern. Builds the model, saves the .s3d, and runs a
// headless sanity check (period + event-to-event plastic collapse).
//   node tools/examples/build_pushover.mjs
import fs from 'fs';
import { Model } from '../../js/model/model.js';
import { Serializer } from '../../js/model/serializer.js';

globalThis.window = globalThis;
await import('../../lib/numeric.js');
globalThis.window.numeric = globalThis.numeric;
const { Portico } = await import('../../js/api/portico.js');

// ── geometry: 20×20 m, 3 bays each way (4 column lines), 5 storeys @ 3.5 m ─────
const GX = [0, 20 / 3, 40 / 3, 20];                 // 4 column lines
const ZL = [0, 3.5, 7, 10.5, 14, 17.5];             // base + 5 storeys
const FY = 345e3;                                    // A992 yield, kN/m²

const m = new Model(); m.mode = '3D'; m.units = 'kN-m';
m.materials.clear(); m.sections.clear();

const STEEL = m.addMaterial({ name: 'Acero A992', E: 2e8, G: 7.7e7, nu: 0.3, rho: 7.85,
  design: { family: 'steel', Fy: 345, Fu: 450 } }).id;   // Fy, Fu in MPa

// Sections (approx W-shapes). Zz drives the plastic moment Mp = Fy·Zz.
const Zc = 2.6e-3, Zb = 1.3e-3;                       // plastic section moduli (m³)
const SEC_COL = m.addSection({ name: 'Pilar W14', A: 0.020, Iz: 5.0e-4, Iy: 1.7e-4, J: 1.0e-5,
  Zz: Zc, design: { shape: 'I', dims: { H: 0.36, B: 0.37, tw: 0.011, tf: 0.018 }, Zz: Zc } }).id;
const SEC_BEAM = m.addSection({ name: 'Viga W18', A: 0.012, Iz: 4.0e-4, Iy: 5.0e-5, J: 1.0e-6,
  Zz: Zb, design: { shape: 'I', dims: { H: 0.46, B: 0.19, tw: 0.009, tf: 0.014 }, Zz: Zb } }).id;
const MP_COL = FY * Zc, MP_BEAM = FY * Zb;           // strong column / weak beam

// ── node registry (base level fixed) ──────────────────────────────────────────
const nreg = new Map();
const N = (ix, iy, iz) => {
  const k = `${ix},${iy},${iz}`;
  if (nreg.has(k)) return nreg.get(k);
  const r = iz === 0 ? { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 } : {};
  const id = m.addNode(GX[ix], GX[iy], ZL[iz], r).id; nreg.set(k, id); return id;
};

// columns
for (let ix = 0; ix < GX.length; ix++) for (let iy = 0; iy < GX.length; iy++)
  for (let iz = 0; iz < ZL.length - 1; iz++) m.addElement(N(ix, iy, iz), N(ix, iy, iz + 1), STEEL, SEC_COL);
// beams (both directions, each floor)
for (let iz = 1; iz < ZL.length; iz++) {
  for (let iy = 0; iy < GX.length; iy++) for (let c = 0; c < GX.length - 1; c++)
    m.addElement(N(c, iy, iz), N(c + 1, iy, iz), STEEL, SEC_BEAM);
  for (let ix = 0; ix < GX.length; ix++) for (let c = 0; c < GX.length - 1; c++)
    m.addElement(N(ix, c, iz), N(ix, c + 1, iz), STEEL, SEC_BEAM);
}

// ── gravity: lumped floor dead load at every floor node ───────────────────────
const LC_G = m.addLoadCase('Gravedad', true).id;      // + self-weight
const Q_DEAD = 5.0, TRIB = (20 / 3) * (20 / 3);        // 5 kN/m², node tributary ≈ one bay² / 1 (interior)
const floorNodes = {};
for (let iz = 1; iz < ZL.length; iz++) {
  floorNodes[iz] = [];
  for (let ix = 0; ix < GX.length; ix++) for (let iy = 0; iy < GX.length; iy++) {
    const id = N(ix, iy, iz); floorNodes[iz].push(id);
    // tributary: corner 1/4, edge 1/2, interior 1 of a bay²
    const fx = (ix === 0 || ix === GX.length - 1) ? 0.5 : 1, fy = (iy === 0 || iy === GX.length - 1) ? 0.5 : 1;
    m.addLoad(LC_G, { type: 'nodal', nodeId: id, F: [0, 0, -Q_DEAD * TRIB * fx * fy, 0, 0, 0] });
  }
}

// ── lateral pushover pattern: inverted triangle (force ∝ height), in +X ────────
const LC_PX = m.addLoadCase('Push X', false).id;
let sumZ = 0; for (let iz = 1; iz < ZL.length; iz++) sumZ += ZL[iz];
for (let iz = 1; iz < ZL.length; iz++) {
  const Fi = 100 * ZL[iz] / sumZ;                      // 100 kN base shear reference, split by height
  const per = Fi / floorNodes[iz].length;
  for (const id of floorNodes[iz]) m.addLoad(LC_PX, { type: 'nodal', nodeId: id, F: [per, 0, 0, 0, 0, 0] });
}

const s3d = new Serializer().toJSON(m);
fs.writeFileSync('examples/tutorial2_pushover.s3d', s3d, 'utf8');
console.log('MODEL  nodes=%d  frames=%d   Mp_col=%s  Mp_beam=%s kN·m',
  m.nodes.size, m.elements.size, MP_COL.toFixed(0), MP_BEAM.toFixed(0));
console.log('saved  examples/tutorial2_pushover.s3d  (%d KB)', Math.round(s3d.length / 1024));

// ── headless sanity: elastic period + event-to-event plastic collapse ─────────
const p = new Portico(m);
const modal = await p.solveModal(4);
console.log('elastic T = [%s] s', (modal.period || []).slice(0, 3).map(t => t.toFixed(3)).join(', '));

const capByElem = new Map();
for (const el of m.elements.values()) {
  const isCol = el.secId === SEC_COL;
  const mp = isCol ? MP_COL : MP_BEAM;
  capByElem.set(el.id, { N: Infinity, Vy: Infinity, Vz: Infinity, My: mp, Mz: mp });
}
const pooh = await p.plasticHinge({ capByElem, contribs: [{ lcId: LC_PX, factor: 1, selfWeight: false }] });
console.log('PUSHOVER  collapsed=%s  λ_collapse=%s  hinges=%d',
  pooh.collapsed, (pooh.lambda ?? pooh.collapseFactor ?? 0).toFixed?.(2) ?? pooh.lambda, (pooh.events || []).length);
