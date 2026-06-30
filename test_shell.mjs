import { assembleAreasInto } from './js/solver/membrane.js?v=88';

// ── solver denso ─────────────────────────────────────────────────────────────
function solve(A, b, n) {
  const M = A.map(r => Array.from(r)); const x = Array.from(b);
  for (let k = 0; k < n; k++) {
    let p = k; for (let i = k + 1; i < n; i++) if (Math.abs(M[i][k]) > Math.abs(M[p][k])) p = i;
    [M[k], M[p]] = [M[p], M[k]]; [x[k], x[p]] = [x[p], x[k]];
    for (let i = k + 1; i < n; i++) { const f = M[i][k] / M[k][k]; for (let j = k; j < n; j++) M[i][j] -= f * M[k][j]; x[i] -= f * x[k]; }
  }
  for (let k = n - 1; k >= 0; k--) { let s = x[k]; for (let j = k + 1; j < n; j++) s -= M[k][j] * x[j]; x[k] = s / M[k][k]; }
  return x;
}

// ── modelo simulado (Maps como el real) ──────────────────────────────────────
const E = 2.1e11, nu = 0.3, t = 0.01, L = 1.0, P = 1000;
function buildPlate(nx, plane, behavior) {
  const nodes = new Map(), materials = new Map(), areas = new Map();
  materials.set(1, { id: 1, E, nu, alpha: 0 });
  const idx = (i, j) => i * (nx + 1) + j;
  for (let i = 0; i <= nx; i++) for (let j = 0; j <= nx; j++) {
    const X = i * L / nx, Y = j * L / nx;
    // plano XY (normal Z) o plano YZ (normal X) para probar la orientación 3D
    const coord = plane === 'xy' ? { x: X, y: Y, z: 0 } : { x: 0, y: X, z: Y };
    nodes.set(idx(i, j), { id: idx(i, j), ...coord });
  }
  let aid = 1;
  for (let i = 0; i < nx; i++) for (let j = 0; j < nx; j++)
    areas.set(aid, { id: aid++, nodes: [idx(i, j), idx(i + 1, j), idx(i + 1, j + 1), idx(i, j + 1)], matId: 1, thickness: t, planeStrain: false, behavior, kind: 'QUAD' });
  const model = { nodes, materials, areas };
  const nodeIndex = new Map([...nodes.keys()].map((k, n) => [k, n]));
  return { model, nodeIndex, idx, nN: nodes.size };
}

function ssCentralDefl(plane, behavior) {
  const nx = 8;
  const { model, nodeIndex, idx, nN } = buildPlate(nx, plane, behavior);
  const nDOF = 6 * nN;
  const K = []; for (let i = 0; i < nDOF; i++) K.push(new Float64Array(nDOF));
  assembleAreasInto({ add: (i, j, v) => { K[i][j] += v; } }, model, nodeIndex);
  // BC: borde simplemente apoyado (w=0 normal). normal = z (xy) ó x (yz).
  const wDofOff = plane === 'xy' ? 2 : 0;       // GDL de traslación normal
  const big = 1e30;
  const fix = d => { K[d][d] += big; };
  for (let i = 0; i <= nx; i++) for (let j = 0; j <= nx; j++) {
    const onB = i === 0 || j === 0 || i === nx || j === nx;
    const base = 6 * nodeIndex.get(idx(i, j));
    if (onB) fix(base + wDofOff);
  }
  // además fijar los GDL en-plano de TODOS los nodos (membrana no cargada) para evitar
  // modos espurios cuando behavior='plate'; en 'shell' la membrana ya los rigidiza algo
  // pero los dejamos libres salvo un nodo de referencia → fijamos in-plane del borde.
  for (let i = 0; i <= nx; i++) for (let j = 0; j <= nx; j++) {
    const base = 6 * nodeIndex.get(idx(i, j));
    for (let r = 0; r < 3; r++) if (r !== wDofOff) fix(base + r);   // congela traslaciones en-plano (sin carga)
  }
  const F = new Float64Array(nDOF);
  const cBase = 6 * nodeIndex.get(idx(nx / 2, nx / 2));
  F[cBase + wDofOff] = P;
  const u = solve(K.map(r => Array.from(r)), Array.from(F), nDOF);
  const wc = u[cBase + wDofOff];
  const D = E * t * t * t / (12 * (1 - nu * nu));
  return wc * D / (P * L * L);
}

console.log('Shell/placa cuadrada SS — coef w_c·D/(P·L²) (ref 0.01160):');
for (const plane of ['xy', 'yz'])
  for (const beh of ['plate', 'shell']) {
    const c = ssCentralDefl(plane, beh);
    console.log(`  plano ${plane}  ${beh.padEnd(6)} = ${c.toFixed(5)}  (err ${((c - 0.0116) / 0.0116 * 100).toFixed(1)}%)`);
  }
