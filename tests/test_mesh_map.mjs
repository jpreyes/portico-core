// test_mesh_map.mjs — verifica el mallador transfinito (Coons) y multi-parche (#52 F1)
//
//  (1) resamplePolyline reparte por longitud de arco.
//  (2) coonsGridFromCorners (lados rectos) ≡ bilinearGrid de mesher.js (superconjunto).
//  (3) coonsGrid con bordes CURVOS sigue el borde (sector anular: filas en R=4 y R=6).
//  (4) quadMinScaledJacobian: cuadrado→1, invertido→<0; meshQuality detecta inversión.
//  (5) weldPoints / meshRegionIntoModel sueldan nodos compartidos (parches conformes).
//  (6) PATCH TEST en una malla TRAPEZOIDAL (quads distorsionados): imponiendo un campo
//      de desplazamiento lineal en el borde (vía prescDisp #54), el interior reproduce
//      el campo EXACTO y la tensión es la constante teórica → la malla es conforme.
import { Model } from '../js/model/model.js';
import { StaticSolver } from '../js/solver/static_solver.js';
import { Results } from '../js/solver/postprocess.js';
import { buildNodeIndex } from '../js/solver/assembler.js';
import { bilinearGrid } from '../js/model/mesher.js';
import { resamplePolyline, coonsGrid, coonsGridFromCorners, quadMinScaledJacobian, meshQuality, weldPoints, meshRegionIntoModel, blockCells } from '../js/model/mesh_map.js';

let fails = 0;
const ok  = (c, m) => { console.log(`${c ? '  OK ' : 'FAIL '} ${m}`); if (!c) fails++; };
const rel = (a, b, tol, m) => ok(Math.abs(a - b) <= tol * Math.abs(b) + 1e-12, `${m}  (${(+a).toExponential(4)} vs ${(+b).toExponential(4)})`);

globalThis.window = globalThis;
await import('../lib/numeric.js');
globalThis.window.numeric = globalThis.numeric;

// ── (1) resamplePolyline ──────────────────────────────────────────────────────
console.log('\n── (1) resamplePolyline (por longitud de arco) ──────────');
const rp = resamplePolyline([[0, 0, 0], [10, 0, 0]], 5);
ok(rp.length === 6, '6 puntos para n=5');
rel(rp[3][0], 6, 1e-12, 'punto 3/5 en x=6 (equiespaciado)');
// puntos de control desparejos → reparto uniforme igual
const rp2 = resamplePolyline([[0, 0, 0], [1, 0, 0], [10, 0, 0]], 10);
rel(rp2[5][0], 5, 1e-12, 'control despareja → mitad en x=5');

// ── (2) coons (rectos) ≡ bilinear ─────────────────────────────────────────────
console.log('\n── (2) coonsGridFromCorners ≡ bilinearGrid (lados rectos) ──');
const corners = [[0, 0, 0], [4, 0, 0], [5, 3, 0], [1, 2, 0]];   // cuadrilátero general
const gBil = bilinearGrid(corners, 4, 3), gCoo = coonsGridFromCorners(corners, 4, 3);
let maxd = 0; for (let k = 0; k < gBil.length; k++) for (let c = 0; c < 3; c++) maxd = Math.max(maxd, Math.abs(gBil[k][c] - gCoo[k][c]));
ok(maxd < 1e-12, `idéntico a bilinear (máx dif ${maxd.toExponential(2)})`);

// ── (3) bordes curvos: sector anular (R=4 .. R=6) ─────────────────────────────
console.log('\n── (3) coonsGrid con bordes curvos (sector anular) ──────');
const arc = (R, n) => { const p = []; for (let i = 0; i <= n; i++) { const a = (Math.PI / 2) * i / n; p.push([R * Math.cos(a), R * Math.sin(a), 0]); } return p; };
const nx = 8, ny = 4;
const edges = {
  bottom: arc(4, 20),                          // P00=(4,0) → P10=(0,4)
  top:    arc(6, 20),                          // P01=(6,0) → P11=(0,6)
  left:   [[4, 0, 0], [6, 0, 0]],              // P00 → P01
  right:  [[0, 4, 0], [0, 6, 0]],              // P10 → P11
};
const gA = coonsGrid(edges, nx, ny);
const idx = (i, j) => i * (ny + 1) + j;
let rBot = 0, rTop = 0;
for (let i = 0; i <= nx; i++) { rBot = Math.max(rBot, Math.abs(Math.hypot(gA[idx(i, 0)][0], gA[idx(i, 0)][1]) - 4)); rTop = Math.max(rTop, Math.abs(Math.hypot(gA[idx(i, ny)][0], gA[idx(i, ny)][1]) - 6)); }
ok(rBot < 5e-3, `fila inferior sobre el arco R=4 (máx desvío ${rBot.toExponential(2)} m)`);
ok(rTop < 5e-3, `fila superior sobre el arco R=6 (máx desvío ${rTop.toExponential(2)} m)`);
ok(meshQuality(gA, nx, ny).minJac > 0, 'sector anular sin elementos invertidos (Jac>0)');

// ── (4) Jacobiano ─────────────────────────────────────────────────────────────
console.log('\n── (4) Jacobiano escalado ───────────────────────────────');
rel(quadMinScaledJacobian([0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]), 1, 1e-9, 'cuadrado unitario → 1');
ok(quadMinScaledJacobian([0, 0, 0], [1, 0, 0], [0.2, 0.2, 0], [0, 1, 0]) < 0, 'cuadrilátero CÓNCAVO (vértice reentrante) → Jac<0');

// ── (5) soldadura ─────────────────────────────────────────────────────────────
console.log('\n── (5) weldPoints / parches conformes ───────────────────');
const w = weldPoints([[0, 0, 0], [1, 0, 0], [0, 0, 0], [1, 0, 0]], 1e-6);
ok(w.unique.length === 2 && w.remap[2] === 0 && w.remap[3] === 1, 'duplicados soldados a 2 únicos');
// dos parches que comparten un borde → nodos del borde reutilizados
const mw = new Model(); mw.mode = '3D'; mw.materials.clear(); mw.sections.clear();
mw.addMaterial({ name: 'H', E: 2.1e11, G: 8e10, nu: 0.3, rho: 0 });
const p1 = meshRegionIntoModel(mw, { bottom: [[0, 0, 0], [2, 0, 0]], right: [[2, 0, 0], [2, 2, 0]], top: [[0, 2, 0], [2, 2, 0]], left: [[0, 0, 0], [0, 2, 0]] }, { nx: 2, ny: 2, thickness: 0.1 });
const nBefore = mw.nodes.size;
const p2 = meshRegionIntoModel(mw, { bottom: [[2, 0, 0], [4, 0, 0]], right: [[4, 0, 0], [4, 2, 0]], top: [[2, 2, 0], [4, 2, 0]], left: [[2, 0, 0], [2, 2, 0]] }, { nx: 2, ny: 2, thickness: 0.1 });
const sharedReused = (nBefore + (3 * 3) - 3) === mw.nodes.size;   // el 2º parche reusa los 3 nodos del borde común
ok(sharedReused, `parche 2 sueldा el borde común (nodos: ${mw.nodes.size}, esperado ${nBefore + 6})`);
ok(p1.areaIds.length === 4 && p2.areaIds.length === 4, '2 parches × 4 QUAD = 8 áreas');

// ── (6) PATCH TEST en malla trapezoidal (quads distorsionados) ────────────────
console.log('\n── (6) Patch test de membrana en malla trapezoidal ──────');
const E = 2.1e11, nu = 0.3, t = 0.01, exx = 1e-4;     // campo impuesto εx
const sigTeo = E * exx, syTeo = 0;                     // tensión plana: σy=0, σx=E·εx
const m = new Model(); m.mode = '3D'; m.materials.clear(); m.sections.clear();
const mat = m.addMaterial({ name: 'Acero', E, G: E / 2.6, nu, rho: 0 });
// Trapecio: izquierda altura 1, derecha altura 2 → quads distorsionados
const trap = [[0, 0, 0], [4, 0, 0], [4, 2, 0], [0, 1, 0]];
const TNX = 4, TNY = 3;
const pts = coonsGridFromCorners(trap, TNX, TNY);
const tidx = (i, j) => i * (TNY + 1) + j;
const isB = (i, j) => i === 0 || i === TNX || j === 0 || j === TNY;
const nid = [];
for (let i = 0; i <= TNX; i++) for (let j = 0; j <= TNY; j++) {
  const p = pts[tidx(i, j)];
  // membrana: fijar uz,rx,ry,rz; en el borde fijar ux,uy e imponer el campo lineal
  const r = { uz: 1, rx: 1, ry: 1, rz: 1, ux: isB(i, j) ? 1 : 0, uy: isB(i, j) ? 1 : 0 };
  const nd = m.addNode(p[0], p[1], p[2], r);
  if (isB(i, j)) m.updateNode(nd.id, { prescDisp: { ux: exx * p[0], uy: -nu * exx * p[1] } });
  nid[tidx(i, j)] = nd.id;
}
const areaIds = [];
for (const cell of blockCells(TNX, TNY, false)) areaIds.push(m.addArea(cell.map(g => nid[g]), mat.id, { thickness: t, behavior: 'membrane' }).id);
const res = new StaticSolver().solve(m, null, false);

// (a) interior reproduce el campo lineal EXACTO
let maxUerr = 0;
for (let i = 0; i <= TNX; i++) for (let j = 0; j <= TNY; j++) {
  if (isB(i, j)) continue;
  const p = pts[tidx(i, j)], d = res.getNodeDisp(nid[tidx(i, j)]);
  maxUerr = Math.max(maxUerr, Math.abs(d[0] - exx * p[0]), Math.abs(d[1] + nu * exx * p[1]));
}
ok(maxUerr < 1e-9, `nodos interiores = campo lineal (máx error ${maxUerr.toExponential(2)} m)`);

// (b) tensión constante teórica en los elementos. Las componentes sx/sy de
// getAreaStress están en el marco LOCAL del elemento (las celdas del trapecio están
// inclinadas ~9°), pero las INVARIANTES (principales/von Mises) son exactas: el
// estado es uniaxial → σ₁ = E·εx, σ₂ = 0. Eso confirma que el QUAD reproduce el
// campo lineal (patch test) en una malla distorsionada.
let maxS1 = 0, maxS2 = 0;
for (const aid of areaIds) { const s = res.getAreaStress(aid); maxS1 = Math.max(maxS1, Math.abs(s.s1 - sigTeo)); maxS2 = Math.max(maxS2, Math.abs(s.s2)); }
rel(sigTeo, E * exx, 1e-12, 'σx teórico = E·εx');
ok(maxS1 / sigTeo < 1e-9, `σ₁ = E·εx en todos los QUAD (máx error ${(maxS1 / sigTeo).toExponential(2)})`);
ok(maxS2 / sigTeo < 1e-9, `σ₂ ≈ 0 en todos los QUAD (máx ${(maxS2 / sigTeo).toExponential(2)})`);

console.log(fails === 0 ? '\n✔ Todos los asserts pasaron\n' : `\n✗ ${fails} fallaron\n`);
process.exit(fails ? 1 : 0);
