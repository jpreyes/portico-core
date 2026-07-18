// DKT regression — rotational-DOF convention, distorted/oriented triangles and
// mixed quad+tri meshes. These probe the failure modes that a pure-triangle,
// transverse-load model hides (there the deflection w is sign-independent, so a
// wrong rotational convention stays invisible — which is why the basic plate test
// can pass while DKT is in the wrong convention).
//
// The DKT (Batoz) element must expose the SAME local DOFs [w, θx, θy] as MITC4 and
// the frames — θx=∂w/∂y, θy=−∂w/∂x — so a triangle can share rotational DOFs with a
// quad, a beam or an applied moment without a sign clash.
//
// Checks:
//   (1) Curvature recovery: feeding a known physical field reproduces κ exactly,
//       and DKT agrees with MITC4 (same convention).
//   (2) Constant-curvature PATCH TEST on a patch of distorted, arbitrarily oriented
//       triangles: a correct thin-plate element reproduces a constant-moment state
//       exactly on any mesh.
//   (3) MIXED quad+tri mesh of one cantilever strip gives the same deflection as the
//       pure-quad and pure-tri meshes (no spurious stiffening at the shared edge).

import { mitc4Plate, dktPlate, plateCurvatures, plateMoments, plateD } from '../js/solver/plate.js';

const E = 2.1e11, nu = 0.3, t = 0.02;
let failures = 0;
const check = (cond, msg) => { console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };

// Physical field (OUR convention): w = A x² + B y² + C xy
//   θx = ∂w/∂y = 2By + Cx ,  θy = −∂w/∂x = −(2Ax + Cy)
//   κ = [∂θy/∂x, −∂θx/∂y, ∂θy/∂y − ∂θx/∂x] = [−2A, −2B, −2C]
const A = 0.10, B = 0.05, C = 0.03;
const kappaT = [-2 * A, -2 * B, -2 * C];
const W  = (x, y) => A * x * x + B * y * y + C * x * y;
const TX = (x, y) => 2 * B * y + C * x;
const TY = (x, y) => -(2 * A * x + C * y);
const feed = (cc, fn) => { const d = []; for (const [x, y] of cc) d.push(W(x, y), TX(x, y), TY(x, y)); return fn(cc, d); };
const close = (a, b, tol) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

// ── (1) Curvature recovery & convention ──────────────────────────────────────
console.log('── (1) Curvature recovery (physical field → κ exact, DKT = MITC4) ──');
const quad = [[0.1, 0.2], [1.4, 0.1], [1.5, 1.2], [0.3, 1.3]];
const tri  = [[0.2, 0.1], [1.3, 0.4], [0.6, 1.1]];
const kQ = feed(quad, plateCurvatures);
const kT = feed(tri,  plateCurvatures);
console.log(`  target κ = [${kappaT.map(v => v.toFixed(4)).join(', ')}]`);
console.log(`  MITC4  κ = [${kQ.map(v => v.toFixed(4)).join(', ')}]`);
console.log(`  DKT    κ = [${kT.map(v => v.toFixed(4)).join(', ')}]`);
check(close(kQ, kappaT, 1e-9), 'MITC4 reproduces κ (physical convention)');
check(close(kT, kappaT, 1e-9), 'DKT reproduces κ — same convention as MITC4 (regression: not flipped to Batoz)');

// ── (2) Constant-curvature patch test, distorted/oriented triangles ──────────
console.log('\n── (2) Constant-curvature patch test (distorted triangles) ──');
// unit square corners (0..3) + irregular interior node 4 → 4 distorted triangles
const nodes = [[0, 0], [1, 0], [1, 1], [0, 1], [0.63, 0.42]];
const tris = [[0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4]];
const nN = nodes.length, nDOF = 3 * nN;
const K = Array.from({ length: nDOF }, () => new Float64Array(nDOF));
for (const tr of tris) {
  const Ke = dktPlate(tr.map(i => nodes[i]), E, nu, t);
  for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++)
    for (let r = 0; r < 3; r++) for (let s = 0; s < 3; s++)
      K[3 * tr[a] + r][3 * tr[b] + s] += Ke[(3 * a + r) * 9 + (3 * b + s)];
}
const u = new Float64Array(nDOF);
const fixed = new Set();
for (let i = 0; i < 4; i++) {
  const [x, y] = nodes[i];
  u[3 * i] = W(x, y); u[3 * i + 1] = TX(x, y); u[3 * i + 2] = TY(x, y);
  fixed.add(3 * i); fixed.add(3 * i + 1); fixed.add(3 * i + 2);
}
const free = [...Array(nDOF).keys()].filter(d => !fixed.has(d));
const nf = free.length;
const Kff = Array.from({ length: nf }, () => new Float64Array(nf)), rhs = new Float64Array(nf);
for (let i = 0; i < nf; i++) {
  for (let j = 0; j < nf; j++) Kff[i][j] = K[free[i]][free[j]];
  let r = 0; for (const c of fixed) r -= K[free[i]][c] * u[c]; rhs[i] = r;
}
for (let k = 0; k < nf; k++) {
  let p = k; for (let i = k + 1; i < nf; i++) if (Math.abs(Kff[i][k]) > Math.abs(Kff[p][k])) p = i;
  [Kff[k], Kff[p]] = [Kff[p], Kff[k]]; [rhs[k], rhs[p]] = [rhs[p], rhs[k]];
  for (let i = k + 1; i < nf; i++) { const f = Kff[i][k] / Kff[k][k]; for (let j = k; j < nf; j++) Kff[i][j] -= f * Kff[k][j]; rhs[i] -= f * rhs[k]; }
}
const xf = new Float64Array(nf);
for (let k = nf - 1; k >= 0; k--) { let s = rhs[k]; for (let j = k + 1; j < nf; j++) s -= Kff[k][j] * xf[j]; xf[k] = s / Kff[k][k]; }
for (let i = 0; i < nf; i++) u[free[i]] = xf[i];
let worst = 0;
for (const tr of tris) {
  const cc = tr.map(i => nodes[i]); const d = [];
  for (const i of tr) d.push(u[3 * i], u[3 * i + 1], u[3 * i + 2]);
  const kap = plateCurvatures(cc, d);
  worst = Math.max(worst, Math.max(...kap.map((v, i) => Math.abs(v - kappaT[i]))));
}
const relPatch = worst / Math.max(...kappaT.map(Math.abs));
console.log(`  worst Δκ over the patch = ${worst.toExponential(2)} (rel ${relPatch.toExponential(2)})`);
check(relPatch < 1e-8, 'constant curvature reproduced exactly on distorted triangles');

// ── (3) Mixed quad+tri mesh consistency (cantilever strip, pure plate bending) ─
console.log('\n── (3) Mixed quad+tri mesh — no spurious stiffening at the shared edge ──');
function strip(mesh, nx) {
  const L = 2.0, wd = 0.5, P = 100;
  const nd = [], grid = []; let id = 0;
  for (let i = 0; i <= nx; i++) { grid.push([]); for (let j = 0; j <= 1; j++) { nd.push([i * L / nx, j * wd]); grid[i].push(id++); } }
  const n = nd.length, dofs = 3 * n;
  const Kg = Array.from({ length: dofs }, () => new Float64Array(dofs));
  const addQ = (Ke, g) => { for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) for (let r = 0; r < 3; r++) for (let s = 0; s < 3; s++) Kg[3 * g[a] + r][3 * g[b] + s] += Ke[(3 * a + r) * 12 + (3 * b + s)]; };
  const addT = (Ke, g) => { for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) for (let r = 0; r < 3; r++) for (let s = 0; s < 3; s++) Kg[3 * g[a] + r][3 * g[b] + s] += Ke[(3 * a + r) * 9 + (3 * b + s)]; };
  for (let i = 0; i < nx; i++) {
    const n1 = grid[i][0], n2 = grid[i + 1][0], n3 = grid[i + 1][1], n4 = grid[i][1];
    const asTri = mesh === 'tri' || (mesh === 'mixed' && i % 2 === 1);
    if (!asTri) addQ(mitc4Plate([nd[n1], nd[n2], nd[n3], nd[n4]], E, nu, t), [n1, n2, n3, n4]);
    else { addT(dktPlate([nd[n1], nd[n2], nd[n3]], E, nu, t), [n1, n2, n3]); addT(dktPlate([nd[n1], nd[n3], nd[n4]], E, nu, t), [n1, n3, n4]); }
  }
  const fx = new Set();
  for (let j = 0; j <= 1; j++) { const nn = grid[0][j]; fx.add(3 * nn); fx.add(3 * nn + 1); fx.add(3 * nn + 2); }
  const fr = [...Array(dofs).keys()].filter(d => !fx.has(d));
  const F = new Float64Array(dofs); F[3 * grid[nx][0]] = -P / 2; F[3 * grid[nx][1]] = -P / 2;
  const m = fr.length, Kf = Array.from({ length: m }, () => new Float64Array(m)), rh = new Float64Array(m);
  for (let i = 0; i < m; i++) { for (let j = 0; j < m; j++) Kf[i][j] = Kg[fr[i]][fr[j]]; rh[i] = F[fr[i]]; }
  for (let k = 0; k < m; k++) { let p = k; for (let i = k + 1; i < m; i++) if (Math.abs(Kf[i][k]) > Math.abs(Kf[p][k])) p = i; [Kf[k], Kf[p]] = [Kf[p], Kf[k]]; [rh[k], rh[p]] = [rh[p], rh[k]]; for (let i = k + 1; i < m; i++) { const f = Kf[i][k] / Kf[k][k]; for (let j = k; j < m; j++) Kf[i][j] -= f * Kf[k][j]; rh[i] -= f * rh[k]; } }
  const x = new Float64Array(m); for (let k = m - 1; k >= 0; k--) { let s = rh[k]; for (let j = k + 1; j < m; j++) s -= Kf[k][j] * x[j]; x[k] = s / Kf[k][k]; }
  const uu = new Float64Array(dofs); for (let i = 0; i < m; i++) uu[fr[i]] = x[i];
  return uu[3 * grid[nx][0]];
}
const wQ = strip('quad', 8), wT = strip('tri', 8), wM = strip('mixed', 8);
console.log(`  w_tip  quad=${wQ.toExponential(5)}  tri=${wT.toExponential(5)}  mixed=${wM.toExponential(5)}`);
check(Math.abs((wT - wQ) / wQ) < 0.05, 'pure-tri agrees with pure-quad');
check(Math.abs((wM - wQ) / wQ) < 0.05, 'mixed quad+tri agrees with pure-quad (no convention clash)');

console.log(`\n=== ${failures === 0 ? 'ALL OK' : failures + ' FAILURE(S)'} ===`);
process.exit(failures === 0 ? 0 : 1);
