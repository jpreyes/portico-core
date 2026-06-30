// test_allman.mjs — Verificación del triángulo de membrana Allman (drilling DOF).
// Ménsula en flexión EN-PLANO mallada con triángulos: el CST sufre "shear locking"
// (rigidez excesiva) y subestima la flecha; el Allman se acerca a la viga.
//   Flecha teórica de punta: δ = P·L³/(3·E·I) + corte (Timoshenko).
import { assembleAreasInto } from './js/solver/membrane.js?v=132';

const V = '?v=132';
void V;

// ── Modelo cantilever: L×h, NX×NY celdas, cada celda en 2 triángulos ──────────
function buildModel(NX, NY, drilling) {
  const L = 10, h = 1, t = 1, E = 1000, nu = 0;
  const model = {
    nodes: new Map(), materials: new Map(), areas: new Map(),
  };
  model.materials.set(1, { id: 1, E, nu, rho: 0, alpha: 0 });
  const nid = (i, j) => j * (NX + 1) + i + 1;
  for (let j = 0; j <= NY; j++) for (let i = 0; i <= NX; i++) {
    model.nodes.set(nid(i, j), { id: nid(i, j), x: (i / NX) * L, y: (j / NY) * h, z: 0 });
  }
  let aid = 1;
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
    const n00 = nid(i, j), n10 = nid(i + 1, j), n11 = nid(i + 1, j + 1), n01 = nid(i, j + 1);
    // dos triángulos CCW
    model.areas.set(aid++, { id: aid, nodes: [n00, n10, n11], matId: 1, thickness: t, planeStrain: false, behavior: 'membrane', drilling, kind: 'CST' });
    model.areas.set(aid++, { id: aid, nodes: [n00, n11, n01], matId: 1, thickness: t, planeStrain: false, behavior: 'membrane', drilling, kind: 'CST' });
  }
  return { model, L, h, t, E, nu, NX, NY, nid };
}

// ── Solver denso minimalista (6 GDL/nodo) ─────────────────────────────────────
function solveTip(cfg) {
  const { model, NX, NY, nid, E, h, t, L } = cfg;
  const nN = model.nodes.size, ND = 6 * nN;
  const idx = new Map([...model.nodes.keys()].map((k, n) => [k, n]));
  const K = Array.from({ length: ND }, () => new Float64Array(ND));
  const writer = { add: (i, j, v) => { K[i][j] += v; } };
  assembleAreasInto(writer, model, idx, {});

  // Restringidos: w,rx,ry de todos; rz de todos salvo Allman; u,v del borde izq (i=0)
  // + rz=0 en el empotramiento (i=0) para clamp completo.
  const fixed = new Set();
  for (const [k, n] of idx) {
    fixed.add(6 * n + 2); fixed.add(6 * n + 3); fixed.add(6 * n + 4); // w,rx,ry
    if (!cfg.model.areas.values().next().value.drilling) fixed.add(6 * n + 5); // rz si CST
  }
  for (let j = 0; j <= NY; j++) {
    const n = idx.get(nid(0, j));
    fixed.add(6 * n + 0); fixed.add(6 * n + 1); fixed.add(6 * n + 5); // u,v,rz clamp
  }

  // Carga: P total hacia −y repartida en el borde derecho (i=NX), consistente
  // (mitad en esquinas, completo en interiores).
  const P = 1;
  const F = new Float64Array(ND);
  const colNodes = [];
  for (let j = 0; j <= NY; j++) colNodes.push(idx.get(nid(NX, j)));
  for (let k = 0; k < colNodes.length; k++) {
    const w = (k === 0 || k === colNodes.length - 1) ? 0.5 : 1;
    F[6 * colNodes[k] + 1] += -P * w;
  }
  const totW = colNodes.reduce((s, _, k) => s + ((k === 0 || k === colNodes.length - 1) ? 0.5 : 1), 0);
  for (let k = 0; k < colNodes.length; k++) {
    const w = (k === 0 || k === colNodes.length - 1) ? 0.5 : 1;
    F[6 * colNodes[k] + 1] = -P * w / totW;   // normaliza a P total
  }

  // Reducir y resolver (eliminación gaussiana con pivoteo parcial)
  const free = [];
  for (let i = 0; i < ND; i++) if (!fixed.has(i)) free.push(i);
  const m = free.length;
  const A = Array.from({ length: m }, (_, r) => {
    const row = new Float64Array(m + 1);
    for (let c = 0; c < m; c++) row[c] = K[free[r]][free[c]];
    row[m] = F[free[r]];
    return row;
  });
  for (let col = 0; col < m; col++) {
    let piv = col; for (let r = col + 1; r < m; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    [A[col], A[piv]] = [A[piv], A[col]];
    const d = A[col][col];
    for (let c = col; c <= m; c++) A[col][c] /= d;
    for (let r = 0; r < m; r++) if (r !== col && A[r][col] !== 0) {
      const f = A[r][col]; for (let c = col; c <= m; c++) A[r][c] -= f * A[col][c];
    }
  }
  const u = new Float64Array(ND);
  for (let r = 0; r < m; r++) u[free[r]] = A[r][m];

  // Flecha de punta = -v promedio del borde derecho
  let tip = 0;
  for (const n of colNodes) tip += -u[6 * n + 1];
  tip /= colNodes.length;

  // Teoría: Euler-Bernoulli + corte Timoshenko (k=5/6)
  const I = t * h ** 3 / 12;
  const G = E / (2 * (1 + 0));
  const dEB = P * L ** 3 / (3 * E * I);
  const dShear = P * L / (G * (5 / 6) * (t * h));
  return { tip, dEB, dTotal: dEB + dShear };
}

console.log('── Triángulo Allman vs CST — ménsula en flexión en-plano ──\n');
for (const [NX, NY] of [[20, 2], [40, 4]]) {
  const cst = solveTip(buildModel(NX, NY, false));
  const all = solveTip(buildModel(NX, NY, true));
  const th = cst.dTotal;
  console.log(`Malla ${NX}×${NY} (${2 * NX * NY} triángulos):`);
  console.log(`  Teoría (EB+corte) δ = ${th.toExponential(4)}`);
  console.log(`  CST    δ = ${cst.tip.toExponential(4)}  (${(100 * cst.tip / th).toFixed(1)}% de la teoría)`);
  console.log(`  Allman δ = ${all.tip.toExponential(4)}  (${(100 * all.tip / th).toFixed(1)}% de la teoría)`);
  console.log('');
}
