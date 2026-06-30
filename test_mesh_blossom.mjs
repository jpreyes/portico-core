// test_mesh_blossom.mjs — recombinación «tipo Blossom» + optimización de valencia · #52
//
//  A) maxWeightMatching (Edmonds): óptimo en grafos pequeños con solución conocida,
//     incluyendo un caso donde el VORAZ es subóptimo (necesita el blossom de un ciclo impar).
//  B) recombineToQuads con Blossom ≥ voraz: nunca menos quads ni menor calidad total.
//  C) valenceOptimize: reduce la desviación de valencia Σ|val−ideal| sin invertir.
//  D) extremo a extremo: malla en L con Blossom+valencia → área conservada, sin invertidos,
//     y PATCH TEST exacto (la malla resultante sigue siendo conforme y usable).
import { Model } from './js/model/model.js';
import { StaticSolver } from './js/solver/static_solver.js';
import { maxWeightMatching } from './js/model/matching.js';
import { triangulatePolygon, recombineToQuads, valenceOptimize, adaptiveRefine, earClip, delaunayFlips, uniformRefine, meshPolygonIntoModel } from './js/model/mesh_free.js';
import { meshStats, boundaryNodes } from './js/model/mesh_quality.js';

globalThis.window = globalThis;
await import('./lib/numeric.js');
globalThis.window.numeric = globalThis.numeric;

let fails = 0;
const ok = (c, m) => { console.log(`${c ? '  OK ' : 'FAIL '} ${m}`); if (!c) fails++; };
const rel = (a, b, tol, m) => ok(Math.abs(a - b) <= tol * Math.abs(b) + 1e-9, `${m}  (${(+a).toExponential(4)} vs ${(+b).toExponential(4)})`);
const matchWeight = (edges, mate) => { let w = 0; for (const [i, j, wt] of edges) if (mate[i] === j) w += wt; return w; };

// ── A) maxWeightMatching ──────────────────────────────────────────────────────
console.log('\n── A) matching de peso máximo (Edmonds/Blossom) ──────────');
// Triángulo (ciclo impar K3) con pesos: óptimo = la arista más pesada (1 sola pareja).
let m = maxWeightMatching([[0, 1, 5], [1, 2, 11], [0, 2, 8]], 3);
ok(m[1] === 2 && m[2] === 1 && m[0] === -1, `K3: empareja la arista de peso 11 (mate=[${[...m]}])`);

// Camino de 4 con pesos: el VORAZ tomaría la del medio (peso 8) y dejaría 2 sueltos;
// el óptimo toma las dos de los extremos (5+5=10 > 8).
const pathEdges = [[0, 1, 5], [1, 2, 8], [2, 3, 5]];
m = maxWeightMatching(pathEdges, 4);
ok(matchWeight(pathEdges, m) === 10, `camino-4: el óptimo (10) supera al voraz del medio (8) — peso=${matchWeight(pathEdges, m)}`);
ok(m[0] === 1 && m[2] === 3, 'camino-4: empareja los dos extremos, no el centro');

// «Blossom» necesario: ciclo impar de 5 + colas → el matching óptimo perfecto exige
// contraer un ciclo impar (lo que el matching bipartito/voraz no maneja).
const blo = [[0, 1, 8], [1, 2, 8], [2, 3, 8], [3, 4, 8], [4, 0, 8], [2, 5, 11]];
m = maxWeightMatching(blo, 6);
ok(matchWeight(blo, m) === 27, `ciclo impar + cola: peso óptimo 27 (=11+8+8) — obtuvo ${matchWeight(blo, m)}`);
let perfect = true; for (let v = 0; v < 6; v++) if (m[v] === -1) perfect = false;
ok(perfect, 'ciclo impar + cola: matching PERFECTO (sin vértices libres)');

// Brute force en grafos aleatorios pequeños: el matching debe igualar al óptimo exhaustivo.
function brute(n, edges) {
  let best = -Infinity;
  const rec = (k, used, w) => {
    if (k === edges.length) { best = Math.max(best, w); return; }
    rec(k + 1, used, w);                                   // saltar arista k
    const [i, j, wt] = edges[k];
    if (!used.has(i) && !used.has(j)) { used.add(i); used.add(j); rec(k + 1, used, w + wt); used.delete(i); used.delete(j); }
  };
  rec(0, new Set(), 0);
  return best;
}
let bruteOk = true;
let seed = 12345; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
for (let trial = 0; trial < 200; trial++) {
  const n = 2 + Math.floor(rnd() * 6);                     // 2..7 vértices
  const edges = []; const ek = new Set();
  const ne = 1 + Math.floor(rnd() * 8);
  for (let e = 0; e < ne; e++) {
    let i = Math.floor(rnd() * n), j = Math.floor(rnd() * n);
    if (i === j) continue; if (i > j) { const t = i; i = j; j = t; }
    const k = `${i},${j}`; if (ek.has(k)) continue; ek.add(k);
    edges.push([i, j, 1 + Math.floor(rnd() * 20)]);
  }
  if (!edges.length) continue;
  const mm = maxWeightMatching(edges, n);
  if (matchWeight(edges, mm) !== brute(n, edges)) { bruteOk = false; break; }
}
ok(bruteOk, '200 grafos aleatorios: matching == óptimo por fuerza bruta');

// ── B) recombineToQuads: Blossom ≥ voraz ──────────────────────────────────────
console.log('\n── B) recombinación Blossom vs voraz ─────────────────────');
function quadCount(V, tris) {
  const blo = recombineToQuads(V, tris.map(t => t.slice()), 0.30, { blossom: true });
  const grd = recombineToQuads(V, tris.map(t => t.slice()), 0.30, { blossom: false });
  const nq = (cells) => cells.filter(c => c.length === 4).length;
  const totQ = (cells) => { const st = meshStats(V.map(p => [p[0], p[1], 0]), cells); return { nq: nq(cells), st }; };
  return { blo: totQ(blo), grd: totQ(grd) };
}
for (const [name, poly, h] of [
  ['cuadrado 2×2', [[0, 0], [2, 0], [2, 2], [0, 2]], 0.5],
  ['planta en L', [[0, 0], [6, 0], [6, 2], [2, 2], [2, 6], [0, 6]], 1.0],
]) {
  let V = poly.map(p => [p[0], p[1]]);
  let tris = delaunayFlips(V, earClip(V, poly.map((_, i) => i)));
  const lv = Math.max(1, Math.ceil(Math.log2(6 / h)));
  for (let l = 0; l < lv; l++) { tris = uniformRefine(V, tris); tris = delaunayFlips(V, tris); }
  tris = valenceOptimize(V, tris);
  const r = quadCount(V, tris);
  ok(r.blo.nq >= r.grd.nq, `${name}: Blossom ≥ voraz en nº de quads (${r.blo.nq} ≥ ${r.grd.nq})`);
  ok(!r.blo.st.inverted, `${name}: Blossom sin celdas invertidas (minJac ${r.blo.st.minScaledJac.toFixed(3)})`);
}

// ── C) valenceOptimize reduce la desviación de valencia ───────────────────────
console.log('\n── C) optimización topológica de valencia ───────────────');
function valenceDeviation(V, tris) {
  const nV = V.length; const bnd = boundaryNodes(V.map(p => [p[0], p[1], 0]), tris);
  const val = new Array(nV).fill(0); const seen = new Set();
  const key = (a, b) => a < b ? `${a},${b}` : `${b},${a}`;
  const used = new Set();
  for (const t of tris) for (let e = 0; e < 3; e++) { const a = t[e], b = t[(e + 1) % 3]; const k = key(a, b); if (!seen.has(k)) { seen.add(k); val[a]++; val[b]++; used.add(a); used.add(b); } }
  let dev = 0; for (const v of used) dev += Math.abs(val[v] - (bnd.has(v) ? 4 : 6));
  return dev;
}
{
  const poly = [[0, 0], [6, 0], [6, 2], [2, 2], [2, 6], [0, 6]];
  let V = poly.map(p => [p[0], p[1]]);
  let tris = delaunayFlips(V, earClip(V, poly.map((_, i) => i)));
  for (let l = 0; l < 3; l++) { tris = uniformRefine(V, tris); tris = delaunayFlips(V, tris); }
  const devBefore = valenceDeviation(V, tris);
  const stBefore = meshStats(V.map(p => [p[0], p[1], 0]), tris);
  const tris2 = valenceOptimize(V, tris.map(t => t.slice()));
  const devAfter = valenceDeviation(V, tris2);
  const stAfter = meshStats(V.map(p => [p[0], p[1], 0]), tris2);
  ok(devAfter <= devBefore, `valencia: desviación Σ|val−ideal| no aumenta (${devBefore} → ${devAfter})`);
  ok(devAfter < devBefore, `valencia: efectivamente regulariza (estricta mejora ${devBefore} → ${devAfter})`);
  ok(!stAfter.inverted, `valencia: sin invertidos (minJac ${stAfter.minScaledJac.toFixed(3)})`);
  ok(stAfter.minAngle >= 0.5 * stBefore.minAngle - 1e-9, `valencia: la guardia de calidad evita slivers (minÁng ${stBefore.minAngle.toFixed(1)}° → ${stAfter.minAngle.toFixed(1)}°)`);
}

// ── D) extremo a extremo: patch test en malla en L con Blossom + valencia ─────
console.log('\n── D) patch test (malla en L, Blossom + valencia) ───────');
const Lshape = [[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]];
const tl = triangulatePolygon(Lshape, { h: 0.4, recombine: true, blossom: true, valence: true, smooth: 3 });
const cellArea = (V, c) => { let s = 0; for (let i = 0; i < c.length; i++) { const a = V[c[i]], b = V[c[(i + 1) % c.length]]; s += a[0] * b[1] - b[0] * a[1]; } return Math.abs(s) / 2; };
let aL = 0; for (const c of tl.cells) aL += cellArea(tl.V, c);
rel(aL, 3, 1e-6, 'planta en L: Σárea = 3 (conservación con Blossom+valencia)');
const stL = meshStats(tl.V.map(p => [p[0], p[1], 0]), tl.cells);
ok(!stL.inverted, `L sin invertidos (minJac ${stL.minScaledJac.toFixed(3)}, ${stL.nQuad} quad + ${stL.nTri} tri)`);

const E = 2.1e11, nu = 0.3, t = 0.01, exx = 1e-4, sigTeo = E * exx;
const mo = new Model(); mo.mode = '3D'; mo.materials.clear(); mo.sections.clear();
const mat = mo.addMaterial({ name: 'Acero', E, G: E / 2.6, nu, rho: 0 });
const mp = meshPolygonIntoModel(mo, Lshape.map(p => [p[0], p[1], 0]), { h: 0.4, recombine: true, blossom: true, valence: true, smooth: 3, thickness: t, behavior: 'membrane', matId: mat.id });
for (const id of mp.nodeIds) { const n = mo.nodes.get(id), bnd = mp.boundaryNodeIds.has(id); mo.updateNode(id, { restraints: { uz: 1, rx: 1, ry: 1, rz: 1, ux: bnd ? 1 : 0, uy: bnd ? 1 : 0 } }); if (bnd) mo.updateNode(id, { prescDisp: { ux: exx * n.x, uy: -nu * exx * n.y } }); }
const res = new StaticSolver().solve(mo, null, false);
let s1 = 0, s2 = 0; for (const aid of mp.areaIds) { const s = res.getAreaStress(aid); s1 = Math.max(s1, Math.abs(s.s1 - sigTeo)); s2 = Math.max(s2, Math.abs(s.s2)); }
ok(s1 / sigTeo < 1e-6 && s2 / sigTeo < 1e-6, `patch test: σ₁=E·εx, σ₂≈0 (err ${(s1 / sigTeo).toExponential(2)})`);

// ── E) refinamiento adaptativo por curvatura ──────────────────────────────────
console.log('\n── E) refinamiento adaptativo (esquina reentrante) ──────');
{
  // L con esquina reentrante en (2,2). El campo de tamaño debe afinar cerca de ella.
  const Lr = [[0, 0], [4, 0], [4, 2], [2, 2], [2, 4], [0, 4]];
  const reCorner = [2, 2];
  const meanEdgeNear = (V, cells, R) => {
    let sum = 0, cnt = 0;
    for (const c of cells) for (let i = 0; i < c.length; i++) {
      const a = V[c[i]], b = V[c[(i + 1) % c.length]];
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      if (Math.hypot(mx - reCorner[0], my - reCorner[1]) < R) { sum += Math.hypot(a[0] - b[0], a[1] - b[1]); cnt++; }
    }
    return cnt ? sum / cnt : Infinity;
  };
  const uni = triangulatePolygon(Lr, { h: 1.0, recombine: false, valence: false, adaptive: false, smooth: 0 });
  const adp = triangulatePolygon(Lr, { h: 1.0, recombine: false, valence: false, adaptive: true, smooth: 0 });
  ok(adp.cells.length > uni.cells.length, `adaptativo añade elementos (${uni.cells.length} → ${adp.cells.length})`);
  const eUni = meanEdgeNear(uni.V, uni.cells, 1.0), eAdp = meanEdgeNear(adp.V, adp.cells, 1.0);
  ok(eAdp < eUni, `arista media MÁS CHICA cerca de la esquina reentrante (${eUni.toFixed(3)} → ${eAdp.toFixed(3)})`);
  // lejos de la esquina el tamaño se mantiene (gradiente local, no global)
  const farU = []; const farA = [];
  const meanEdgeFar = (V, cells) => { let s = 0, n = 0; for (const c of cells) for (let i = 0; i < c.length; i++) { const a = V[c[i]], b = V[c[(i + 1) % c.length]]; const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2; if (Math.hypot(mx - reCorner[0], my - reCorner[1]) > 2.5) { s += Math.hypot(a[0] - b[0], a[1] - b[1]); n++; } } return n ? s / n : 0; };
  rel(meanEdgeFar(adp.V, adp.cells), meanEdgeFar(uni.V, uni.cells), 0.15, 'lejos de la esquina el tamaño se conserva (refinamiento LOCAL)');
  // conformidad: área conservada exacta tras el refinamiento adaptativo
  let aA = 0; for (const c of adp.cells) aA += cellArea(adp.V, c);
  rel(aA, 12, 1e-6, 'adaptativo conserva el área (L 4×4 menos cuadrante = 12)');
  ok(!meshStats(adp.V.map(p => [p[0], p[1], 0]), adp.cells).inverted, 'adaptativo sin celdas invertidas');
}

// ── F) costo de borde Blossom-IV (maximizar nº de quads) ──────────────────────
console.log('\n── F) costo de borde Blossom-IV + campo de tamaño del usuario ──');
{
  const poly = [[0, 0], [6, 0], [6, 2], [2, 2], [2, 6], [0, 6]];
  let V = poly.map(p => [p[0], p[1]]);
  let tris = delaunayFlips(V, earClip(V, poly.map((_, i) => i)));
  for (let l = 0; l < 3; l++) { tris = uniformRefine(V, tris); tris = delaunayFlips(V, tris); }
  tris = valenceOptimize(V, tris);
  const nq = (cells) => cells.filter(c => c.length === 4).length;
  const card = recombineToQuads(V, tris.map(t => t.slice()), 0.30, { blossom: true, maxCardinality: true });
  const qual = recombineToQuads(V, tris.map(t => t.slice()), 0.30, { blossom: true, maxCardinality: false });
  ok(nq(card) >= nq(qual), `maxCardinality ≥ peso puro en nº de quads (${nq(card)} ≥ ${nq(qual)})`);
  ok(!meshStats(V.map(p => [p[0], p[1], 0]), card).inverted, 'maxCardinality sin celdas invertidas');
}
// Campo de tamaño DEFINIDO POR EL USUARIO: refinar la mitad izquierda de un cuadrado.
{
  const sq = [[0, 0], [4, 0], [4, 4], [0, 4]];
  const sizeField = (x, y) => x < 2 ? 0.5 : 2.0;     // fino a la izquierda, grueso a la derecha
  const uni = triangulatePolygon(sq, { h: 2.0, recombine: false, valence: false, adaptive: false, smooth: 0 });
  const usr = triangulatePolygon(sq, { h: 2.0, recombine: false, valence: false, adaptive: true, sizeField, smooth: 0 });
  const meanEdgeSide = (V, cells, left) => { let s = 0, n = 0; for (const c of cells) for (let i = 0; i < c.length; i++) { const a = V[c[i]], b = V[c[(i + 1) % c.length]]; const mx = (a[0] + b[0]) / 2; if ((left && mx < 2) || (!left && mx > 2)) { s += Math.hypot(a[0] - b[0], a[1] - b[1]); n++; } } return n ? s / n : 0; };
  ok(usr.cells.length > uni.cells.length, `campo de usuario añade elementos (${uni.cells.length} → ${usr.cells.length})`);
  ok(meanEdgeSide(usr.V, usr.cells, true) < meanEdgeSide(usr.V, usr.cells, false), `arista MÁS CHICA en la mitad izquierda (${meanEdgeSide(usr.V, usr.cells, true).toFixed(3)} < ${meanEdgeSide(usr.V, usr.cells, false).toFixed(3)})`);
  let aU = 0; for (const c of usr.cells) aU += cellArea(usr.V, c);
  rel(aU, 16, 1e-6, 'campo de usuario conserva el área (cuadrado 4×4 = 16)');
}

console.log(fails === 0 ? '\n✔ Todos los asserts pasaron\n' : `\n✗ ${fails} fallaron\n`);
process.exit(fails ? 1 : 0);
