// test_modal_kg.mjs — verifica MODAL con rigidez geométrica Kg (#55, G14)
// Columna/viga biarticulada con carga axial de referencia P. Relación clásica:
//   ω²(P) / ω²(0) = 1 − P/Pcr   (rigidización por tracción / ablandamiento por
// compresión). Se verifica AUTOCONSISTENTE con el FE: Pcr = λcr·P del mismo Kg,
// así que ω²(P)/ω²(0) debe valer 1 − 1/λcr.
import { Model } from './js/model/model.js';
import { buildNodeIndex, assembleK, assembleF, getNodeDOFs } from './js/solver/assembler.js';
import { assembleKg } from './js/solver/geometric.js';

globalThis.window = globalThis;
await import('./lib/numeric.js');
const num = globalThis.numeric;

let fails = 0;
const ok = (c, m) => { console.log(`${c ? '  OK ' : 'FAIL '} ${m}`); if (!c) fails++; };
const rel = (a, b, tol, m) => ok(Math.abs(a - b) <= tol * Math.abs(b) + 1e-12, `${m}  (${a.toFixed(5)} vs ${b.toFixed(5)})`);

// menores autovalores reales positivos de inv(B)·A (A,B simétricas, B>0)
function genEigVals(Aflat, Bflat, n) {
  const A = [], B = [];
  for (let i = 0; i < n; i++) { A.push([...Aflat.subarray(i * n, i * n + n)]); B.push([...Bflat.subarray(i * n, i * n + n)]); }
  const ev = num.eig(num.dot(num.inv(B), A));
  const re = ev.lambda.x, im = ev.lambda.y || re.map(() => 0);
  return re.map((r, i) => ({ r, im: im[i] })).filter(e => Math.abs(e.im) < 1e-6 * Math.abs(e.r) + 1e-9).map(e => e.r);
}

// ── Modelo: viga biarticulada a lo largo de X, discretizada en nEl elementos ──
const E = 2.1e8, Iy = 8.333e-6, A = 0.01, L = 6, nEl = 8;
const m = new Model();
m.materials.clear(); m.sections.clear();
const mat = m.addMaterial({ name: 'Acero', E, G: E / 2.6, nu: 0.3, rho: 7.85 });
const sec = m.addSection({ name: 'C', A, Iy, Iz: Iy, J: 1e-6, Avy: 1e3, Avz: 1e3, kappay: 1, kappaz: 1 });
const nodes = [];
for (let k = 0; k <= nEl; k++) {
  // restringe fuera de plano (uy,rx,rz) en todos; deja ux, uz, ry
  const r = { uy: 1, rx: 1, rz: 1 };
  const nd = m.addNode((L / nEl) * k, 0, 0, r);
  nodes.push(nd);
}
// articulación: nodo 0 fija ux,uz ; nodo final rodillo (uz fijo, ux libre = axial)
m.updateNode(nodes[0].id, { restraints: { ux: 1, uz: 1 } });
m.updateNode(nodes[nEl].id, { restraints: { uz: 1 } });
for (let k = 0; k < nEl; k++) m.addElement(nodes[k].id, nodes[k + 1].id, mat.id, sec.id);

// Carga axial de COMPRESIÓN P en el extremo móvil (Fx = −P sobre nodo final)
const P = 50;   // kN
const lc = m.addLoadCase('Pref', false);
m.addLoad(lc.id, { type: 'nodal', nodeId: nodes[nEl].id, F: [-P, 0, 0, 0, 0, 0] });

const ni = buildNodeIndex(m);
const { K, M, nDOF } = assembleK(m, ni);

// GDL libres (2D efectivo: ux, uz, ry)
const freeDOF = [];
for (const node of m.nodes.values()) {
  const d = getNodeDOFs(ni, node.id), r = node.restraints;
  [r.ux, 1, r.uz, 1, r.ry, 1].forEach((fx, li) => { if (!fx) freeDOF.push(d[li]); });
}
const nF = freeDOF.length;
const sub = (G) => { const o = new Float64Array(nF * nF); for (let i = 0; i < nF; i++) { const ri = freeDOF[i] * nDOF; for (let j = 0; j < nF; j++) o[i * nF + j] = G[ri + freeDOF[j]]; } return o; };
const Kff = sub(K), Mff = sub(M);

// Estado de referencia: K·u = F (sólo para el axial de Kg)
const F = assembleF(m, ni, lc.id, false);
const Ff = [], Kff2 = [];
for (let i = 0; i < nF; i++) { Ff.push(F[freeDOF[i]]); Kff2.push([...Kff.subarray(i * nF, i * nF + nF)]); }
const uf = num.solve(Kff2, Ff);
const u = new Float64Array(nDOF); for (let i = 0; i < nF; i++) u[freeDOF[i]] = uf[i];
const { Kg, Nmax } = assembleKg(m, ni, u);
const Kgff = sub(Kg);

// ω²(0), ω²(P): menores autovalores de (Kff, Mff) y (Kff+Kgff, Mff)
const w0 = Math.min(...genEigVals(Kff, Mff, nF).filter(v => v > 1e-6));
const KplusKg = new Float64Array(nF * nF); for (let i = 0; i < nF * nF; i++) KplusKg[i] = Kff[i] + Kgff[i];
const wP = Math.min(...genEigVals(KplusKg, Mff, nF).filter(v => v > 1e-6));

// λcr: (K + λKg)φ=0 → eig(inv(K)·Kg)=μ, λ=−1/μ, menor λ positivo
const mus = genEigVals(Kgff, Kff, nF);  // = eig(inv(Kff)·Kgff)
const lambdas = mus.map(mu => -1 / mu).filter(l => l > 1e-6);
const lcr = Math.min(...lambdas);

console.log('\n── Modal con Kg: viga biarticulada bajo compresión axial ──');
ok(Nmax > 1e-6, `el estado de referencia genera axial (Nmax=${Nmax.toFixed(2)} kN)`);
ok(wP < w0, `compresión ablanda: ω²(P)=${wP.toFixed(1)} < ω²(0)=${w0.toFixed(1)}`);
// ω²(P)/ω²(0) == 1 − 1/λcr   (autoconsistencia FE)
const ratioFE = wP / w0, ratioTeo = 1 - 1 / lcr;
rel(ratioFE, ratioTeo, 0.01, `ω²(P)/ω²(0) = 1 − P/Pcr  [Pcr=λcr·P, λcr=${lcr.toFixed(3)}]`);

// Sanidad: Pcr_FE ≈ Euler π²EI/L²
const PcrFE = lcr * P, PcrEuler = Math.PI ** 2 * E * Iy / (L * L);
rel(PcrFE, PcrEuler, 0.02, 'Pcr (FE) ≈ π²EI/L² (Euler)');

console.log(fails === 0 ? '\n✔ Todos los asserts pasaron\n' : `\n✗ ${fails} fallaron\n`);
process.exit(fails ? 1 : 0);
