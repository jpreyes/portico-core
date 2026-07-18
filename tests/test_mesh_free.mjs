// test_mesh_free.mjs — verifica calidad de malla (F2) y malla libre (F3) · #52
//
//  F2: triQuality/quadQuality, meshStats, suavizado Laplaciano (mejora sin invertir).
//  F3: triangulación libre (ear-clip + Delaunay + refinamiento + recombinación):
//      conservación de área, validez (sin invertidos), mejora de ángulos por Delaunay,
//      y PATCH TEST en una planta en L (cóncava) mallada libremente → tensión constante
//      exacta (la malla libre es conforme y usable en el solver).
import { Model } from '../js/model/model.js';
import { StaticSolver } from '../js/solver/static_solver.js';
import { triQuality, quadQuality, meshStats, laplacianSmooth } from '../js/model/mesh_quality.js';
import { earClip, delaunayFlips, triangulatePolygon, meshPolygonIntoModel } from '../js/model/mesh_free.js';

let fails = 0;
const ok  = (c, m) => { console.log(`${c ? '  OK ' : 'FAIL '} ${m}`); if (!c) fails++; };
const rel = (a, b, tol, m) => ok(Math.abs(a - b) <= tol * Math.abs(b) + 1e-9, `${m}  (${(+a).toExponential(4)} vs ${(+b).toExponential(4)})`);

globalThis.window = globalThis;
await import('../lib/numeric.js');
globalThis.window.numeric = globalThis.numeric;

// ── F2: métricas ──────────────────────────────────────────────────────────────
console.log('\n── F2: métricas de calidad ──────────────────────────────');
const eq = triQuality([0, 0, 0], [1, 0, 0], [0.5, Math.sqrt(3) / 2, 0]);
rel(eq.quality, 1, 1e-6, 'triángulo equilátero → calidad 1');
rel(eq.minAngle, 60, 1e-4, 'equilátero → ángulo mínimo 60°');
const sq = quadQuality([0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]);
rel(sq.minScaledJac, 1, 1e-9, 'cuadrado → Jacobiano escalado 1');
ok(sq.warp < 1e-9 && Math.abs(sq.aspect - 1) < 1e-9, 'cuadrado → alabeo 0, aspecto 1');

// ── F2: suavizado mejora una malla perturbada ────────────────────────────────
console.log('\n── F2: suavizado Laplaciano ─────────────────────────────');
const gn = []; for (let i = 0; i <= 2; i++) for (let j = 0; j <= 2; j++) gn.push([i, j, 0]);
const gidx = (i, j) => i * 3 + j;
gn[gidx(1, 1)] = [0.3, 0.3, 0];   // nodo central descentrado
const gcells = []; for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) gcells.push([gidx(i, j), gidx(i + 1, j), gidx(i + 1, j + 1), gidx(i, j + 1)]);
const sm = laplacianSmooth(gn, gcells, { iters: 10, omega: 0.6 });
ok(sm.after.minScaledJac > sm.before.minScaledJac && sm.after.minScaledJac > 0, `suavizado sube la calidad mínima (${sm.before.minScaledJac.toFixed(3)} → ${sm.after.minScaledJac.toFixed(3)})`);
ok(sm.nodes[gidx(0, 0)][0] === 0 && sm.nodes[gidx(2, 2)][1] === 2, 'los nodos de borde NO se mueven');
rel(sm.nodes[gidx(1, 1)][0], 1, 0.05, 'el nodo central vuelve ≈ al centro (x≈1)');

// ── F3: ear clipping + área ──────────────────────────────────────────────────
console.log('\n── F3: triangulación libre ──────────────────────────────');
const sqOuter = [[0, 0], [2, 0], [2, 2], [0, 2]];
const tq = triangulatePolygon(sqOuter, { h: 0.5, recombine: true, smooth: 2 });
const cellArea = (V, c) => { let s = 0; for (let i = 0; i < c.length; i++) { const a = V[c[i]], b = V[c[(i + 1) % c.length]]; s += a[0] * b[1] - b[0] * a[1]; } return Math.abs(s) / 2; };
let aSum = 0; for (const c of tq.cells) aSum += cellArea(tq.V, c);
rel(aSum, 4, 1e-6, 'cuadrado 2×2: Σárea de celdas = 4 (conservación)');
const st = meshStats(tq.V.map(p => [p[0], p[1], 0]), tq.cells);
ok(!st.inverted, `sin elementos invertidos (minJac ${st.minScaledJac.toFixed(3)}, minÁng ${st.minAngle.toFixed(1)}°)`);
ok(st.nQuad > 0, `recombinación produce QUADs (${st.nQuad} quad, ${st.nTri} tri)`);

// L-shape (cóncava): área = 3
console.log('\n── F3: planta en L (cóncava) ────────────────────────────');
const Lshape = [[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]];
const tl = triangulatePolygon(Lshape, { h: 0.4, recombine: true, smooth: 3 });
let aL = 0; for (const c of tl.cells) aL += cellArea(tl.V, c);
rel(aL, 3, 1e-6, 'planta en L: Σárea = 3 (cóncava, conservación)');
const stL = meshStats(tl.V.map(p => [p[0], p[1], 0]), tl.cells);
ok(!stL.inverted, `L sin invertidos (minJac ${stL.minScaledJac.toFixed(3)}, minÁng ${stL.minAngle.toFixed(1)}°)`);

// Delaunay mejora el ángulo mínimo respecto al ear-clip crudo
const Vraw = sqOuter.map(p => [p[0], p[1]]);
const trisRaw = earClip(Vraw, sqOuter.map((_, i) => i));
const angRaw = meshStats(Vraw.map(p => [p[0], p[1], 0]), trisRaw).minAngle;
const Vd = sqOuter.map(p => [p[0], p[1]]); const trisD = delaunayFlips(Vd, earClip(Vd, sqOuter.map((_, i) => i)));
const angD = meshStats(Vd.map(p => [p[0], p[1], 0]), trisD).minAngle;
ok(angD >= angRaw - 1e-9, `flips de Delaunay no empeoran el ángulo mínimo (${angRaw.toFixed(1)}° → ${angD.toFixed(1)}°)`);

// ── F3: PATCH TEST en la malla libre de la L ──────────────────────────────────
console.log('\n── F3: patch test en malla libre (planta en L) ──────────');
const E = 2.1e11, nu = 0.3, t = 0.01, exx = 1e-4, sigTeo = E * exx;
const m = new Model(); m.mode = '3D'; m.materials.clear(); m.sections.clear();
const mat = m.addMaterial({ name: 'Acero', E, G: E / 2.6, nu, rho: 0 });
const Lo3 = Lshape.map(p => [p[0], p[1], 0]);
const mp = meshPolygonIntoModel(m, Lo3, { h: 0.4, recombine: true, smooth: 3, thickness: t, behavior: 'membrane', matId: mat.id });
ok(mp.areaIds.length > 0 && mp.boundaryNodeIds.size > 0, `malla en el modelo: ${m.nodes.size} nodos, ${mp.areaIds.length} áreas, ${mp.boundaryNodeIds.size} de borde`);
const nInterior = m.nodes.size - mp.boundaryNodeIds.size;
ok(nInterior > 0, `hay nodos interiores libres (${nInterior})`);
// membrana: fijar uz,rx,ry,rz; imponer campo lineal en el borde, interior libre
for (const id of mp.nodeIds) {
  const n = m.nodes.get(id); const bnd = mp.boundaryNodeIds.has(id);
  m.updateNode(id, { restraints: { uz: 1, rx: 1, ry: 1, rz: 1, ux: bnd ? 1 : 0, uy: bnd ? 1 : 0 } });
  if (bnd) m.updateNode(id, { prescDisp: { ux: exx * n.x, uy: -nu * exx * n.y } });
}
const res = new StaticSolver().solve(m, null, false);
let maxUerr = 0;
for (const id of mp.nodeIds) { if (mp.boundaryNodeIds.has(id)) continue; const n = m.nodes.get(id), d = res.getNodeDisp(id); maxUerr = Math.max(maxUerr, Math.abs(d[0] - exx * n.x), Math.abs(d[1] + nu * exx * n.y)); }
ok(maxUerr < 1e-9, `nodos interiores = campo lineal exacto (máx error ${maxUerr.toExponential(2)} m)`);
let maxS1 = 0, maxS2 = 0;
for (const aid of mp.areaIds) { const s = res.getAreaStress(aid); maxS1 = Math.max(maxS1, Math.abs(s.s1 - sigTeo)); maxS2 = Math.max(maxS2, Math.abs(s.s2)); }
ok(maxS1 / sigTeo < 1e-6, `σ₁ = E·εx constante en todas las celdas (máx error ${(maxS1 / sigTeo).toExponential(2)})`);
ok(maxS2 / sigTeo < 1e-6, `σ₂ ≈ 0 (máx ${(maxS2 / sigTeo).toExponential(2)})`);

// ── F3b: malla libre con AGUJERO (bridging) — conservación de área + patch test ──
console.log('\n── F3b: malla libre con agujero (cuadrado 4×4, hueco 1×1) ──');
const outerH = [[0, 0], [4, 0], [4, 4], [0, 4]], holeH = [[1.5, 1.5], [2.5, 1.5], [2.5, 2.5], [1.5, 2.5]];
const tH = triangulatePolygon(outerH, { holes: [holeH], h: 0.6, recombine: true, smooth: 3 });
let aH = 0; for (const c of tH.cells) aH += cellArea(tH.V, c);
rel(aH, 15, 1e-3, 'Σárea = 16 − 1 = 15 (conservación con agujero)');
const stH = meshStats(tH.V.map(p => [p[0], p[1], 0]), tH.cells);
ok(!stH.inverted, `sin invertidos (minJac ${stH.minScaledJac.toFixed(3)}); ${stH.nQuad} quad + ${stH.nTri} tri`);
// patch test sobre el dominio con agujero (campo lineal en TODO el borde, outer + hueco)
const mH = new Model(); mH.mode = '3D'; mH.materials.clear(); mH.sections.clear();
const matH = mH.addMaterial({ name: 'Acero', E, G: E / 2.6, nu, rho: 0 });
const mpH = meshPolygonIntoModel(mH, outerH.map(p => [p[0], p[1], 0]), { holes: [holeH.map(p => [p[0], p[1], 0])], h: 0.6, recombine: true, smooth: 3, thickness: t, behavior: 'membrane', matId: matH.id });
for (const id of mpH.nodeIds) { const n = mH.nodes.get(id), bnd = mpH.boundaryNodeIds.has(id); mH.updateNode(id, { restraints: { uz: 1, rx: 1, ry: 1, rz: 1, ux: bnd ? 1 : 0, uy: bnd ? 1 : 0 } }); if (bnd) mH.updateNode(id, { prescDisp: { ux: exx * n.x, uy: -nu * exx * n.y } }); }
const resH = new StaticSolver().solve(mH, null, false);
let s1H = 0, s2H = 0; for (const aid of mpH.areaIds) { const s = resH.getAreaStress(aid); s1H = Math.max(s1H, Math.abs(s.s1 - sigTeo)); s2H = Math.max(s2H, Math.abs(s.s2)); }
ok(s1H / sigTeo < 1e-6 && s2H / sigTeo < 1e-6, `patch test con agujero: σ₁=E·εx, σ₂≈0 (err ${(s1H / sigTeo).toExponential(2)})`);

console.log(fails === 0 ? '\n✔ Todos los asserts pasaron\n' : `\n✗ ${fails} fallaron\n`);
process.exit(fails ? 1 : 0);
