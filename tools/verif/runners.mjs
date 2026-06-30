// runners.mjs — corre los solvers de Pórtico HEADLESS (Node), reusando el código
// real de la app. numeric.js se carga como global (shim de window) una sola vez.
import { ModalSolver } from '../../js/solver/modal_solver.js';
import { ModalResults } from '../../js/solver/modal_results.js';
import { StaticSolver } from '../../js/solver/static_solver.js';
import { buildNodeIndex, assembleK, assembleF, getNodeDOFs } from '../../js/solver/assembler.js';
import { assembleKg } from '../../js/solver/geometric.js';
import { solveNonlinear } from '../../js/solver/nl_lite.js';
import { StagedSolver } from '../../js/solver/staged.js';
import { applyTendon } from '../../js/solver/tendon.js';
import { buildLane, influenceLine, movingLoadEnvelope, responseReaction } from '../../js/solver/moving_load.js';

let _num = false;
export async function ensureNumeric() {
  if (_num) return;
  globalThis.window = globalThis;
  await import('../../lib/numeric.js');           // define `numeric` global
  globalThis.window.numeric = globalThis.numeric;
  _num = true;
}

// En modelos 2D la app (runModal) restringe uy/rx/rz; ModalSolver usa los
// restraints del nodo tal cual, así que replicamos esa restricción aquí.
function apply2D(model) {
  if (model.mode !== '2D') return;
  for (const n of model.nodes.values()) { n.restraints.uy = 1; n.restraints.rx = 1; n.restraints.rz = 1; }
}

// Análisis modal — devuelve el ModalResults real (period[], freq[], getModeShape…).
export async function runModal(model, nModes = 6) {
  await ensureNumeric();
  apply2D(model);
  return new ModalSolver().solve(model, nModes);
}

// Análisis estático lineal — devuelve el Results real (getNodeDisp, esfuerzos…).
export async function runStatic(model, lcId = null, selfWeight = false) {
  await ensureNumeric();
  apply2D(model);
  return new StaticSolver().solve(model, lcId, selfWeight);
}

// ── NL-lite (reticulado axial con cable/puntal) — para 1-012 (#56) ──────────────
// Convierte el modelo a un problema de barras (3 GDL/nodo) y corre solveNonlinear.
// Devuelve un adaptador con getNodeDisp(id)=[ux,uy,uz] y getReaction(id)=[Fx,Fy,Fz].
export async function runNLLite(model, lcId = null, opts = {}) {
  await ensureNumeric();
  const nodeIds = [...model.nodes.keys()];
  const idxOf = new Map(nodeIds.map((id, i) => [id, i]));
  const nNode = nodeIds.length;
  const X = new Float64Array(3 * nNode);
  nodeIds.forEach((id, i) => { const n = model.nodes.get(id); X[3 * i] = n.x; X[3 * i + 1] = n.y; X[3 * i + 2] = n.z; });

  const elems = [];
  for (const el of model.elements.values()) {
    const n1 = model.nodes.get(el.n1), n2 = model.nodes.get(el.n2);
    const mat = model.materials.get(el.matId), sec = model.sections.get(el.secId);
    if (!n1 || !n2 || !mat || !sec) continue;
    const L = Math.hypot(n2.x - n1.x, n2.y - n1.y, n2.z - n1.z); if (L < 1e-12) continue;
    elems.push({ n1: idxOf.get(el.n1), n2: idxOf.get(el.n2), EA: mat.E * sec.A, L0: (el.L0factor || 1) * L, cable: !!el.cable, compressionOnly: !!el.compressionOnly });
  }
  // GDL libres (traslaciones no restringidas). Reticulado plano X-Z → uy fijo.
  const free = [];
  nodeIds.forEach((id, i) => {
    const r = model.nodes.get(id).restraints;
    [r.ux, model.mode === '2D' ? 1 : r.uy, r.uz].forEach((fx, c) => { if (!fx) free.push(3 * i + c); });
  });
  // Carga de referencia (cargas nodales del caso)
  const Fref = new Float64Array(3 * nNode);
  const lc = model.loadCases.get(lcId) || [...model.loadCases.values()][0];
  for (const ld of (lc?.loads || [])) if (ld.type === 'nodal') {
    const i = idxOf.get(ld.nodeId); if (i == null) continue;
    Fref[3 * i] += ld.F[0] || 0; Fref[3 * i + 1] += ld.F[1] || 0; Fref[3 * i + 2] += ld.F[2] || 0;
  }
  const res = solveNonlinear({ X, elems, free, Fref, nSteps: opts.nSteps || 1, maxIter: 60 });
  if (!res.converged) throw new Error('NL-lite no convergió');
  const u = res.u, R = res.reactions;
  return {
    converged: res.converged, steps: res.steps,
    getNodeDisp: (id) => { const i = idxOf.get(id); return [u[3 * i], u[3 * i + 1], u[3 * i + 2]]; },
    getReaction: (id) => { const i = idxOf.get(id); return [R[3 * i], R[3 * i + 1], R[3 * i + 2]]; },
  };
}

// ── Modal con rigidez geométrica Kg (#55) — para 1-017 (cuerda tensa) ───────────
// Resuelve el estático de referencia, ensambla Kg(estado) y corre el modal sobre
// K+Kg vs M. Devuelve un ModalResults real (freq[], period[], getModeShape).
export async function runModalKg(model, refLcId, nModes = 3) {
  await ensureNumeric();
  apply2D(model);
  const num = globalThis.numeric;
  const ni = buildNodeIndex(model);
  const { K, M, nDOF } = assembleK(model, ni);
  const is2D = model.mode === '2D';
  const freeDOF = [];
  for (const node of model.nodes.values()) {
    const d = getNodeDOFs(ni, node.id), r = node.restraints;
    [r.ux, is2D ? 1 : r.uy, r.uz, is2D ? 1 : r.rx, r.ry, is2D ? 1 : r.rz].forEach((fx, li) => { if (!fx) freeDOF.push(d[li]); });
  }
  const nF = freeDOF.length;
  const sub = (G) => { const o = []; for (let i = 0; i < nF; i++) { const row = new Float64Array(nF), ri = freeDOF[i] * nDOF; for (let j = 0; j < nF; j++) row[j] = G[ri + freeDOF[j]]; o.push([...row]); } return o; };
  // Estado de referencia: Kff·u = Ff
  const F = assembleF(model, ni, refLcId, false);
  const Kff = sub(K), Ff = freeDOF.map(d => F[d]);
  const uf = num.solve(Kff, Ff);
  const u = new Float64Array(nDOF); for (let i = 0; i < nF; i++) u[freeDOF[i]] = uf[i];
  const { Kg } = assembleKg(model, ni, u);
  const Kgff = sub(Kg), Mff = sub(M);
  // K+Kg
  const A = Kff.map((row, i) => row.map((v, j) => v + Kgff[i][j]));
  // Eig generalizado (A, Mff): eig(inv(M)·A) → ω², vec
  const ev = num.eig(num.dot(num.inv(Mff), A));
  const re = ev.lambda.x, im = ev.lambda.y || re.map(() => 0);
  const V = ev.E.x;   // columnas = autovectores
  const pairs = re.map((w2, k) => ({ w2, k })).filter(p => Math.abs(im[p.k]) < 1e-6 * Math.abs(p.w2) + 1e-9 && p.w2 > 1e-9)
    .sort((a, b) => a.w2 - b.w2).slice(0, nModes);
  const modes = pairs.map(p => {
    const vec = new Float64Array(nDOF);
    for (let i = 0; i < nF; i++) vec[freeDOF[i]] = V[i][p.k];
    return { omega2: p.w2, vec };
  });
  return new ModalResults(model, ni, freeDOF, modes, M, nDOF);
}

// ── Etapas constructivas (#59) — StagedSolver con stages del caso ──────────────
export async function runStaged(model, spec) {
  await ensureNumeric();
  apply2D(model);
  return new StagedSolver().solve(model, spec.stages);
}

// ── Pretensado por tendones (#60) — aplica el tendón y corre el estático ────────
export async function runTendon(model, spec) {
  await ensureNumeric();
  apply2D(model);
  const lcId = spec.lcId ?? 1;
  applyTendon(model, lcId, spec.tendon);
  return new StaticSolver().solve(model, lcId, !!spec.selfWeight);
}

// ── Cargas móviles / líneas de influencia (#61) — API de barrido sobre la pista ─
// Devuelve un adaptador con líneas de influencia y envolventes para que el caso
// extraiga los valores a comparar (sin getNodeDisp → la figura sale sin deformada).
export async function runMoving(model, spec) {
  await ensureNumeric();
  apply2D(model);
  const lane = buildLane(model, spec.lane);
  const midMoment = (leftElem, rightElem) => (res) => {
    const a = res.getElemAtXi(leftElem, 1.0).Mz, b = res.getElemAtXi(rightElem, 0.0).Mz;
    return Math.abs(a) <= Math.abs(b) ? a : b;   // lado no cargado = exacto
  };
  return {
    lane,
    ilReaction: (nodeId, comp = 'Fz', opts) => influenceLine(model, lane, responseReaction(nodeId, comp), opts),
    ilMidMoment: (leftElem, rightElem, opts) => influenceLine(model, lane, (r) => Math.abs(midMoment(leftElem, rightElem)(r)), opts),
    influence: (response, opts) => influenceLine(model, lane, response, opts),
    envelope: (train, responses, opts) => movingLoadEnvelope(model, lane, train, responses, opts),
    midMoment,
  };
}

// Despacho por tipo de análisis (se irá ampliando: buckling, espectro, …).
export async function runAnalysis(model, spec) {
  switch (spec.analysis) {
    case 'modal': return { type: 'modal', res: await runModal(model, spec.nModes || 6) };
    case 'modalKg': return { type: 'modal', res: await runModalKg(model, spec.refLcId ?? 1, spec.nModes || 3) };
    case 'nllite': return { type: 'nllite', res: await runNLLite(model, spec.lcId ?? null, spec) };
    case 'staged': return { type: 'staged', res: await runStaged(model, spec) };
    case 'tendon': return { type: 'static', res: await runTendon(model, spec) };
    case 'moving': return { type: 'moving', res: await runMoving(model, spec) };
    case 'static': {
      // Multi-caso: si spec.lcIds (array) → corre cada caso y devuelve resById.
      if (Array.isArray(spec.lcIds) && spec.lcIds.length) {
        const resById = new Map();
        for (const id of spec.lcIds) resById.set(id, await runStatic(model, id, !!spec.selfWeight));
        return { type: 'static', res: resById.get(spec.lcIds[0]), resById };
      }
      return { type: 'static', res: await runStatic(model, spec.lcId ?? null, !!spec.selfWeight) };
    }
    default: throw new Error('Análisis no soportado en el harness: ' + spec.analysis);
  }
}
