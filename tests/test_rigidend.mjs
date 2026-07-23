// test_rigidend.mjs — verifica el CACHO RÍGIDO nativo (zona rígida de extremo, #87).
//
// Caso analítico: voladizo horizontal a lo largo de X, empotrado en el nodo i (base),
// libre en el nodo j (punta), longitud total L. Carga transversal P en Z en la punta.
// Con una zona rígida `oi` en la base, la parte FLEXIBLE mide Lf = L − oi y se comporta
// como un voladizo empotrado en el extremo del cacho → flecha de punta:
//     δ_z = P · Lf³ / (3·E·Iy)     (sección rígida a corte → Euler-Bernoulli)
// Sin cacho: δ_z = P·L³/(3EIy). El cacho reduce la flecha por ((L−oi)/L)³.
import { Model } from '../js/model/model.js';
import { StaticSolver } from '../js/solver/static_solver.js';
import { Serializer } from '../js/model/serializer.js';

let fails = 0;
const ok  = (c, m) => { console.log(`${c ? '  OK ' : 'FAIL '} ${m}`); if (!c) fails++; };
const rel = (a, b, tol, m) => ok(Math.abs(a - b) <= tol * Math.abs(b) + 1e-9, `${m}  (${(+a).toExponential(5)} vs ${(+b).toExponential(5)})`);

globalThis.window = globalThis;
await import('../lib/numeric.js');
globalThis.window.numeric = globalThis.numeric;

const E = 2e8, Iy = 1e-4, A = 0.02, L = 4, P = 100;
const EI = E * Iy;

function cantilever(oi) {
  const m = new Model(); m.mode = '3D'; m.materials.clear(); m.sections.clear();
  const mat = m.addMaterial({ name: 'M', E, G: E / 2.4, nu: 0.2, rho: 0 });
  const sec = m.addSection({ name: 'S', A, Iy, Iz: Iy, J: 1e-4, Avy: 1e3, Avz: 1e3 });  // rígida a corte
  const n1 = m.addNode(0, 0, 0, { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 });          // base empotrada
  const n2 = m.addNode(L, 0, 0);                                                          // punta libre
  const el = m.addElement(n1.id, n2.id, mat.id, sec.id);
  if (oi) m.updateElement(el.id, { rigidEnd: { i: oi, j: 0 } });
  const lc = m.addLoadCase('tip', false);
  m.addLoad(lc.id, { type: 'nodal', nodeId: n2.id, F: [0, 0, -P, 0, 0, 0] });            // P en −Z
  const r = new StaticSolver().solve(m, lc.id, false);
  return { m, n1, n2, el, r };
}

// ── 1) Sin cacho: voladizo clásico ───────────────────────────────────────────
console.log('\n── 1) Voladizo SIN cacho ──');
{
  const { n2, r } = cantilever(0);
  const dz = Math.abs(r.getNodeDisp(n2.id)[2]);
  rel(dz, P * L ** 3 / (3 * EI), 1e-3, `δ_z punta = P·L³/(3EIy)`);
}

// ── 2) Con cacho oi en la base → luz flexible Lf = L−oi ───────────────────────
console.log('\n── 2) Voladizo CON cacho rígido en la base ──');
for (const oi of [1, 2]) {
  const { n2, r } = cantilever(oi);
  const dz = Math.abs(r.getNodeDisp(n2.id)[2]);
  const Lf = L - oi;
  rel(dz, P * Lf ** 3 / (3 * EI), 5e-3, `oi=${oi}: δ_z = P·(L−oi)³/(3EIy)`);
}

// ── 3) El cacho RIGIDIZA (menor flecha que sin cacho) y equilibrio global ─────
console.log('\n── 3) Monotonía + equilibrio ──');
{
  const a = cantilever(0), b = cantilever(1.5);
  const da = Math.abs(a.r.getNodeDisp(a.n2.id)[2]), db = Math.abs(b.r.getNodeDisp(b.n2.id)[2]);
  ok(db < da, `con cacho la flecha es menor (${db.toExponential(3)} < ${da.toExponential(3)})`);
  // ΣReacciones verticales = P
  let Rz = 0; const reac = b.r.getReaction(b.n1.id); Rz += reac[2];
  rel(Math.abs(Rz), P, 1e-6, `ΣRz = P (equilibrio)`);
}

// ── 4) Round-trip JSON conserva rigidEnd ──────────────────────────────────────
console.log('\n── 4) Round-trip .s3d ──');
{
  const { m, el } = cantilever(1.2);
  const s = new Serializer();
  const m2 = s.fromJSON(s.toJSON(m));
  const el2 = m2.elements.get(el.id);
  ok(el2 && el2.rigidEnd && Math.abs(el2.rigidEnd.i - 1.2) < 1e-9 && (el2.rigidEnd.j || 0) === 0,
     `rigidEnd {i:1.2, j:0} sobrevive al JSON  (${JSON.stringify(el2?.rigidEnd)})`);
}

// ── 5) CARGA DISTRIBUIDA sobre barra con cacho (FEF consistente) ─────────────
// Voladizo a lo largo de X, empotrado en i, con cacho oi en la base y carga
// uniforme w (−Z) sobre TODA la longitud L. La porción sobre la zona rígida va
// directo al nodo empotrado (no deforma); la porción sobre la luz flexible es
// un voladizo de largo Lf = L−oi con carga uniforme:
//     δ_z(punta) = w·Lf⁴ / (8·E·Iy)
// y el equilibrio global sigue exigiendo ΣRz = w·L y M_base = w·L²/2.
console.log('\n── 5) Carga distribuida + cacho ──');
function cantileverUDL(oi, w) {
  const m = new Model(); m.mode = '3D'; m.materials.clear(); m.sections.clear();
  const mat = m.addMaterial({ name: 'M', E, G: E / 2.4, nu: 0.2, rho: 0 });
  const sec = m.addSection({ name: 'S', A, Iy, Iz: Iy, J: 1e-4, Avy: 1e3, Avz: 1e3 });
  const n1 = m.addNode(0, 0, 0, { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 });
  const n2 = m.addNode(L, 0, 0);
  const el = m.addElement(n1.id, n2.id, mat.id, sec.id);
  if (oi) m.updateElement(el.id, { rigidEnd: { i: oi, j: 0 } });
  const lc = m.addLoadCase('udl', false);
  m.addLoad(lc.id, { type: 'dist', elemId: el.id, w, dir: 'gravity' });   // w>0 = hacia abajo
  return { m, n1, n2, el, r: new StaticSolver().solve(m, lc.id, false) };
}
{
  const w = 20;
  for (const oi of [0, 1, 2]) {
    const { n1, n2, r } = cantileverUDL(oi, w);
    const Lf = L - oi;
    const dz = Math.abs(r.getNodeDisp(n2.id)[2]);
    rel(dz, w * Lf ** 4 / (8 * EI), 5e-3, `oi=${oi}: δ_z = w·(L−oi)⁴/(8EIy)`);
    // Equilibrio global: la carga sobre el cacho NO se pierde
    const reac = r.getReaction(n1.id);
    rel(Math.abs(reac[2]), w * L, 1e-6, `oi=${oi}: ΣRz = w·L (la carga del cacho no se pierde)`);
    rel(Math.abs(reac[4]), w * L * L / 2, 1e-6, `oi=${oi}: M_base = w·L²/2`);
  }
}

// ── 6) Cacho en AMBOS extremos + carga trapecial: equilibrio global ──────────
// Barra empotrada en i y apoyada (rótula) en j, con cachos oi/oj y carga
// trapecial w1→w2: ΣRz = ∫w dx = (w1+w2)/2·L y ΣM(nodo i) = ∫x·w dx.
console.log('\n── 6) Cachos en ambos extremos + carga trapecial ──');
{
  const w1 = 10, w2 = 30, oi = 0.6, oj = 0.9;
  const m = new Model(); m.mode = '3D'; m.materials.clear(); m.sections.clear();
  const mat = m.addMaterial({ name: 'M', E, G: E / 2.4, nu: 0.2, rho: 0 });
  const sec = m.addSection({ name: 'S', A, Iy, Iz: Iy, J: 1e-4, Avy: 1e3, Avz: 1e3 });
  const fix = { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 };
  const n1 = m.addNode(0, 0, 0, fix);
  const n2 = m.addNode(L, 0, 0, { ux: 1, uy: 1, uz: 1 });   // apoyo: rotaciones libres
  const el = m.addElement(n1.id, n2.id, mat.id, sec.id);
  m.updateElement(el.id, { rigidEnd: { i: oi, j: oj } });
  const lc = m.addLoadCase('trap', false);
  m.addLoad(lc.id, { type: 'dist', elemId: el.id, w: w1, w2, dir: 'gravity' });
  const r = new StaticSolver().solve(m, lc.id, false);
  const R1 = r.getReaction(n1.id), R2 = r.getReaction(n2.id);
  const Wtot = (w1 + w2) / 2 * L;
  const Mtot = L * L * (w1 + 2 * w2) / 6;                 // ∫x·w(x)dx respecto al nodo i
  rel(Math.abs(R1[2] + R2[2]), Wtot, 1e-6, `ΣRz = (w1+w2)/2·L`);
  // ΣMy respecto al nodo i (origen): Rz(j)·L − (My_i + My_j) = ∫x·w(x)dx
  rel(R2[2] * L - (R1[4] + R2[4]), Mtot, 1e-6, `ΣMy(nodo i) = ∫x·w(x)dx`);
}

console.log(fails ? `\n${fails} FALLO(S)` : '\nTODO OK ✓');
process.exit(fails ? 1 : 0);
