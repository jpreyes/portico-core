// ──────────────────────────────────────────────────────────────────────────────
// portico.js — PORTICO PUBLIC API.
//
// Single, stable façade to consume the PRE-processing (build/import the model), the
// SOLVER (static, modal, buckling, stages…) and the POST-processing (displacements,
// reactions, forces, diagrams, multi-code DESIGN). It is EXTENSIBLE: third-party
// analyses and design codes can be registered without touching the core. Works the
// same in Node (headless) and in the browser.
//
//   import { Portico } from './js/api/portico.js';
//   const p = new Portico();
//   const ac = p.material({ name:'Acero', E:2e8, design:{ family:'steel', Fy:250 } });
//   const sc = p.section({ name:'IPE300', design:{ shape:'I', d:.3, bf:.15, tf:.0107, tw:.0071 } });
//   const a = p.node(0,0,0,{ux:1,uy:1,uz:1,rx:1,ry:1,rz:1});
//   const b = p.node(5,0,0);
//   const e = p.element(a, b, { mat: ac, sec: sc });
//   const lc = p.loadCase('Q'); p.nodalLoad(lc, b, { fz:-20 });
//   await p.solveStatic(lc);
//   p.displacement(b);            // [ux,uy,uz,rx,ry,rz]
//   p.design({ codeId:'AISC360-16:LRFD' });   // chequeo por elemento
//
// Model units: kN, m (design strengths are given in MPa).
// ──────────────────────────────────────────────────────────────────────────────

import { Model } from '../model/model.js?v=2';
import { Serializer } from '../model/serializer.js?v=2';
import { StaticSolver } from '../solver/static_solver.js?v=2';
import { ModalSolver } from '../solver/modal_solver.js?v=2';
import { ModalResults } from '../solver/modal_results.js?v=2';
import { SpectrumSolver } from '../solver/spectrum_solver.js?v=2';
import { buildNodeIndex, assembleK, assembleF, getNodeDOFs } from '../solver/assembler.js?v=2';
import { assembleKg } from '../solver/geometric.js?v=2';
import { makeFactor } from '../solver/linsolve.js?v=2';
import { solveBuckling } from '../solver/buckling.js?v=2';
import { StagedSolver } from '../solver/staged.js?v=2';
import { checkElement, listDesignCodes, getDesignCode, registerDesignCode } from '../design/design.js?v=2';
import { checkDeflection, checkDrift, driftLimit } from '../design/serviceability.js?v=2';
import { interstoryDrifts, buildStoryLevels } from '../solver/drift.js?v=2';
import { polygonProps, compositeProps } from '../design/polygon_props.js?v=2';
import { jointSCWB, strongColumnWeakBeam } from '../design/seismic.js?v=2';
import { buildSpectrum } from '../design/nch433_spectrum.js?v=2';
import { resolveMaterial } from '../design/material_props.js?v=2';
import { resolveSectionProps } from '../design/section_props.js?v=2';
import { registerFormat, listFormats, exportModel, importModel } from '../io/index.js?v=2';
import { solvePlastic } from '../solver/plastic.js?v=2';
import { pDelta as pDeltaAnalysis } from '../solver/geometric_analysis.js?v=2';
import { buildNLTrussProblem, buildCorotProblem, remapCorotSteps, setupPushoverControl, buildFormFindProblem } from '../solver/nl_frame.js?v=2';
import { solveNonlinear, solveNonlinearDC } from '../solver/nl_lite.js?v=2';
import { solveCorotBeam } from '../solver/corotbeam.js?v=2';
import { buildShearStories, runShearHistory } from '../solver/shear_building.js?v=2';
import { computeMovingLoad } from '../solver/moving_load.js?v=2';
import { formFind } from '../solver/formfind.js?v=2';

// ── numeric.js disponible como global (navegador) o cargado bajo demanda (Node) ──
let _numReady = false;
async function ensureNumeric() {
  if (_numReady || (typeof globalThis !== 'undefined' && globalThis.numeric)) { _numReady = true; return; }
  if (typeof window === 'undefined' || !window.numeric) {
    globalThis.window = globalThis.window || globalThis;
    await import('../../lib/numeric.js');
    globalThis.window.numeric = globalThis.numeric;
  }
  _numReady = true;
}

// En modelos 2D la app restringe uy/rx/rz; lo replicamos para los solvers directos.
function apply2D(model) {
  if (model.mode !== '2D') return;
  for (const n of model.nodes.values()) { n.restraints.uy = 1; n.restraints.rx = 1; n.restraints.rz = 1; }
}

function freeDOFof(model, ni) {
  const is2D = model.mode === '2D', out = [];
  for (const node of model.nodes.values()) {
    const d = getNodeDOFs(ni, node.id), r = node.restraints;
    [r.ux, is2D ? 1 : r.uy, r.uz, is2D ? 1 : r.rx, r.ry, is2D ? 1 : r.rz]
      .forEach((fx, li) => { if (!fx) out.push(d[li]); });
  }
  return out;
}

// Todos los casos estáticos a factor 1 — el patrón de referencia por defecto de los NL.
function allStaticContribs(model) {
  return [...model.loadCases.values()].filter(lc => lc.type !== 'spectrum')
    .map(lc => ({ lcId: lc.id, factor: 1, selfWeight: !!lc.selfWeight }));
}

// Registro de análisis extensibles { name → async (model, opts, api) => result }
const _analyses = new Map();

export class Portico {
  constructor(model) { this.model = model || new Model(); this.results = null; this.modal = null; this._lastKind = null; }

  // ── Constructores ─────────────────────────────────────────────────────────
  static fromS3D(json) { return new Portico(new Serializer().fromJSON(typeof json === 'string' ? json : JSON.stringify(json))); }
  static from(model) { return new Portico(model); }
  toS3D() { return new Serializer().toJSON(this.model); }

  // ── Interoperabilidad (#74): import/export a otros motores vía modelo neutro ──
  // El registro de formatos es extensible: `Portico.registerFormat({id,name,ext,write,read})`.
  static listFormats() { return listFormats(); }
  static registerFormat(def) { return registerFormat(def); }
  /** Exporta el modelo al formato `id` → { text, ext, warnings }. */
  exportTo(id) { return exportModel(this.model, id); }
  /** Importa texto del formato `id` a un Portico nuevo. */
  static importFrom(text, id) { return new Portico(importModel(text, id).model); }

  // ── PRE-proceso: construcción del modelo ────────────────────────────────────
  material(props) { return this.model.addMaterial(props).id; }
  section(props) { return this.model.addSection(props).id; }
  node(x, y, z, restraints) { return this.model.addNode(x, y, z, restraints || {}).id; }
  element(n1, n2, opts = {}) {
    const e = this.model.addElement(n1, n2, opts.mat ?? opts.matId, opts.sec ?? opts.secId);
    if (e && opts) { const { mat, matId, sec, secId, ...rest } = opts; if (Object.keys(rest).length) this.model.updateElement(e.id, rest); }
    return e ? e.id : null;
  }
  area(nodes, opts = {}) { const a = this.model.addArea(nodes, opts.mat ?? opts.matId, opts); return a ? a.id : null; }
  loadCase(name, selfWeight = false) { return this.model.addLoadCase(name, selfWeight).id; }
  load(lcId, load) { return this.model.addLoad(lcId, load); }
  nodalLoad(lcId, nodeId, f = {}) {
    return this.model.addLoad(lcId, { type: 'nodal', nodeId, F: [f.fx || 0, f.fy || 0, f.fz || 0, f.mx || 0, f.my || 0, f.mz || 0] });
  }
  distLoad(lcId, elemId, load) { return this.model.addLoad(lcId, { type: 'dist', elemId, ...load }); }
  combo(props) { return this.model.addCombination(props).id; }
  link(props) { return this.model.addLink(props).id; }
  designSettings(s) { this.model.designSettings = { ...(this.model.designSettings || {}), ...s }; return this.model.designSettings; }
  set2D(on = true) { this.model.mode = on ? '2D' : '3D'; return this; }

  // ── SOLVER ──────────────────────────────────────────────────────────────────
  async solveStatic(lcId = null, opts = {}) {
    await ensureNumeric(); apply2D(this.model);
    this.results = new StaticSolver().solve(this.model, lcId, !!opts.selfWeight);
    this._lastKind = 'static'; this._lastLc = lcId;
    return this.results;
  }
  async solveModal(nModes = 6) {
    await ensureNumeric(); apply2D(this.model);
    this.modal = new ModalSolver().solve(this.model, nModes);
    this._lastKind = 'modal';
    return this.modal;
  }
  // Response spectrum (SRSS/CQC) on the modal results. CODE-AGNOSTIC: it takes any
  // spectrum curve [{T,Sa}] — from Portico.spectrumNCh433() or hand-built — and combines
  // the modes. If no modal has been solved yet, it solves one with `nModes` first.
  //   opts = { spectrum:[{T,Sa}], saFactor=1, direction='X', zeta=0.05, method='CQC', nModes=6 }
  // saFactor scales the raw Sa to model accel. units (m/s²); e.g. for an NCh433 elastic
  // curve in g, saFactor = g/R* applies gravity and the reduction in one step.
  async solveSpectrum(opts = {}) {
    const { nModes = 6, ...params } = opts;
    if (!params.spectrum || params.spectrum.length < 2) throw new Error('solveSpectrum: params.spectrum needs at least 2 [{T,Sa}] points');
    if (!this.modal) await this.solveModal(nModes);
    this.results = new SpectrumSolver().solve(this.modal, params);
    this._lastKind = 'spectrum';
    return this.results;
  }
  // Modal con rigidez geométrica del estado de referencia (lcId).
  async solveModalKg(refLcId, nModes = 3) {
    await ensureNumeric(); apply2D(this.model);
    const num = globalThis.numeric, ni = buildNodeIndex(this.model);
    const { K, M, nDOF } = assembleK(this.model, ni);
    const fd = freeDOFof(this.model, ni), nF = fd.length;
    const sub = (G) => { const o = []; for (let i = 0; i < nF; i++) { const row = new Float64Array(nF), ri = fd[i] * nDOF; for (let j = 0; j < nF; j++) row[j] = G[ri + fd[j]]; o.push([...row]); } return o; };
    const F = assembleF(this.model, ni, refLcId, false);
    const uf = num.solve(sub(K), fd.map(d => F[d]));
    const u = new Float64Array(nDOF); for (let i = 0; i < nF; i++) u[fd[i]] = uf[i];
    const { Kg } = assembleKg(this.model, ni, u);
    const A = sub(K).map((row, i) => row.map((v, j) => v + sub(Kg)[i][j]));
    const ev = num.eig(num.dot(num.inv(sub(M)), A));
    const re = ev.lambda.x, im = ev.lambda.y || re.map(() => 0), V = ev.E.x;
    const pairs = re.map((w2, k) => ({ w2, k })).filter(p => Math.abs(im[p.k]) < 1e-6 * Math.abs(p.w2) + 1e-9 && p.w2 > 1e-9).sort((a, b) => a.w2 - b.w2).slice(0, nModes);
    const modes = pairs.map(p => { const vec = new Float64Array(nDOF); for (let i = 0; i < nF; i++) vec[fd[i]] = V[i][p.k]; return { omega2: p.w2, vec }; });
    this.modal = new ModalResults(this.model, ni, fd, modes, M, nDOF); this._lastKind = 'modal';
    return this.modal;
  }
  // Pandeo lineal: (K + λ·Kg)·φ = 0. Devuelve { factors:[λ], modes }.
  async solveBuckling(refLcId = null, nModes = 4) {
    await ensureNumeric(); apply2D(this.model);
    const ni = buildNodeIndex(this.model);
    const { K, nDOF } = assembleK(this.model, ni);
    const fd = freeDOFof(this.model, ni), nF = fd.length;
    const Kff = new Float64Array(nF * nF), Ff = new Float64Array(nF);
    const F = assembleF(this.model, ni, refLcId, false);
    for (let i = 0; i < nF; i++) { Ff[i] = F[fd[i]]; const ri = fd[i] * nDOF; for (let j = 0; j < nF; j++) Kff[i * nF + j] = K[ri + fd[j]]; }
    const fac = makeFactor(Kff, nF, true);
    if (!fac.ok) throw new Error('Estado de referencia singular (mecanismo).');
    const ufA = fac.solve(Ff); const u = new Float64Array(nDOF); for (let i = 0; i < nF; i++) u[fd[i]] = ufA[i];
    const { Kg, Nmax } = assembleKg(this.model, ni, u);
    if (Nmax < 1e-9) throw new Error('La carga de referencia no genera forces axiales.');
    const Kgff = new Float64Array(nF * nF);
    for (let i = 0; i < nF; i++) { const ri = fd[i] * nDOF; for (let j = 0; j < nF; j++) Kgff[i * nF + j] = Kg[ri + fd[j]]; }
    const res = solveBuckling({ Kff_flat: Kff, Kgff_flat: Kgff, nF, nModes, dense: true });
    if (res.error) throw new Error(res.error);
    this._lastKind = 'buckling';
    this.buckling = { factors: res.modes.map(m => m.lambda), modes: res.modes };
    return this.buckling;
  }
  async solveStaged(stages) { await ensureNumeric(); apply2D(this.model); this.results = new StagedSolver().solve(this.model, stages); this._lastKind = 'staged'; return this.results; }

  // ── Análisis geométrico-no-lineal e inelástico (headless; js/solver/*) ────────
  // Estos exponen los solvers que antes sólo se alcanzaban desde los drivers DOM de
  // app.js. Cada uno arma el problema desde el modelo y devuelve el resultado neutro.

  // PUSHOVER por rótulas plásticas (evento a evento). Capacidades uniformes desde
  // Mp/Np/Vp salvo que se pase un Map capByElem; carga de referencia = todos los casos
  // estáticos a factor 1 salvo `contribs`. → { ok, events, lambda, collapsed, u, … }.
  async plasticHinge({ Mp = Infinity, Np = Infinity, Vp = Infinity, capByElem = null, contribs = null, residual = 1, thetaU = Infinity, deltaU = Infinity } = {}) {
    await ensureNumeric(); apply2D(this.model);
    let caps = capByElem;
    if (!caps) { caps = new Map(); for (const el of this.model.elements.values()) caps.set(el.id, { N: Np, Vy: Vp, Vz: Vp, My: Mp, Mz: Mp }); }
    const res = solvePlastic(this.model, { capByElem: caps, contribs: contribs || allStaticContribs(this.model), residual, thetaU, deltaU });
    if (!res.ok) throw new Error('plasticHinge: ' + res.reason);
    this._lastKind = 'plastic'; this.plastic = res; return res;
  }
  // P-DELTA: (K + Kg(u))·u = F por iteración tangente. → campo amplificado + amplificación.
  async pDelta(opts = {}) {
    await ensureNumeric(); apply2D(this.model);
    const res = pDeltaAnalysis(this.model, opts);
    if (!res.ok) throw new Error('pDelta: ' + res.reason);
    this._lastKind = 'pdelta'; this.pdelta = res; return res;
  }
  // NO LINEAL geométrico ESTÁTICO: gran desplazamiento de barra/cable (control de carga).
  async nonlinearStatic({ contribs = null, nSteps = 12, maxIter = 60, tol = 1e-8, slack = 1e-6 } = {}) {
    await ensureNumeric(); apply2D(this.model);
    const P = buildNLTrussProblem(this.model, { contribs });
    if (!P.ok) throw new Error('nonlinearStatic: ' + P.reason);
    const res = solveNonlinear({ X: P.X, elems: P.elems, free: P.free, Fref: P.Fref, nSteps, maxIter, tol, slack });
    this._lastKind = 'nl'; this.nl = { ...res, X: P.X, nodeIds: P.nodeIds, elemIds: P.elemIds };
    return this.nl;
  }
  // Gran ROTACIÓN: viga corotacional plana (2D X–Z). Pasos remapeados a nodal [ux,0,uz].
  async corotational({ nSteps = 12, maxIter = 80, tol = 1e-9 } = {}) {
    await ensureNumeric(); apply2D(this.model);
    const P = buildCorotProblem(this.model);
    if (!P.ok) throw new Error('corotational: ' + P.reason);
    const res = solveCorotBeam({ coords: P.coords, elems: P.elems, free: P.free, Fref: P.Fref, nSteps, maxIter, tol });
    const steps = remapCorotSteps({ coords: P.coords, elems: P.elems, steps: res.steps, nNode: P.nodeIds.length });
    this._lastKind = 'corot'; this.corot = { steps, converged: res.converged, X: P.X, nodeIds: P.nodeIds, elemIds: P.elemIds };
    return this.corot;
  }
  // PUSHOVER por control de desplazamiento (traza el camino completo, snap-through
  // incluido). El GDL de control sale de un probe lineal; imperfección opcional.
  async pushover({ contribs = null, imp = 0, nSteps = 60 } = {}) {
    await ensureNumeric(); apply2D(this.model);
    const P = buildNLTrussProblem(this.model, { contribs });
    if (!P.ok) throw new Error('pushover: ' + P.reason);
    const setup = setupPushoverControl(P, imp);
    if (!setup.ok) throw new Error('pushover: ' + setup.reason);
    const res = solveNonlinearDC({ X: setup.Ximp, elems: P.elems, free: P.free, Fref: P.Fref, controlDOF: setup.cDOF, targetDisp: setup.target, nSteps });
    this._lastKind = 'pushover'; this.pushoverResult = { ...res, cDOF: setup.cDOF, nodeIds: P.nodeIds, elemIds: P.elemIds };
    return this.pushoverResult;
  }
  // TIME-HISTORY no lineal del edificio de corte equivalente (desde los diafragmas).
  // Requiere el acelerograma (ag, dt). Newmark-β + resortes de entrepiso bilineales.
  async timeHistoryNL({ dir = 'X', zeta = 0.05, alpha = 0.03, ag = null, dt = null, agName = '', driftCode = 'NCh433', stories = null } = {}) {
    await ensureNumeric(); apply2D(this.model);
    const st = stories || buildShearStories(this.model, dir);
    if (!st.length) throw new Error('timeHistoryNL: el modelo no tiene diafragmas (pisos)');
    if (!ag || ag.length < 2) throw new Error('timeHistoryNL: se requiere un acelerograma (ag, dt)');
    const res = runShearHistory({ stories: st, dir, zeta, alpha, ag, dt, agName, driftCode });
    this._lastKind = 'th'; this.timeHistory = res; return res;
  }
  // CARGAS MÓVILES / línea de influencia. cfg = { laneIds, mode:'il'|'env', nPos,
  // respType, … } (ver computeMovingLoad). → { mode, xs, ys, max, min, … }.
  async movingLoad(cfg) {
    await ensureNumeric(); apply2D(this.model);
    this.moving = computeMovingLoad(this.model, cfg); this._lastKind = 'moving';
    return this.moving;
  }
  // FORM-FINDING por densidades de fuerza. REPOSICIONA los nodos libres a la geometría de
  // equilibrio (muta el modelo). `selEls` restringe la red; vacío = todo el modelo.
  async formFinding({ selEls = [], q0 = 10, axes = [2] } = {}) {
    await ensureNumeric(); apply2D(this.model);
    const P = buildFormFindProblem(this.model, selEls);
    if (!P.ok) throw new Error('formFinding: ' + P.reason);
    const res = formFind({ coords: P.coords, fixed: P.fixed, branches: P.branches, q: P.branches.map(() => q0), loads: P.loads, axes });
    if (!res.ok) throw new Error('formFinding: ' + res.note);
    for (const i of res.freeIdx) { const nd = this.model.nodes.get(P.nodeIds[i]); nd.x = res.coords[3 * i]; nd.y = res.coords[3 * i + 1]; nd.z = res.coords[3 * i + 2]; }
    this._lastKind = 'formfind'; return res;
  }

  // Análisis extensible registrado por el usuario.
  static registerAnalysis(name, fn) { _analyses.set(name, fn); }
  async run(name, opts = {}) { const fn = _analyses.get(name); if (!fn) throw new Error('Análisis no registrado: ' + name); await ensureNumeric(); return fn(this.model, opts, this); }

  // ── POST-proceso ────────────────────────────────────────────────────────────
  displacement(nodeId) { return this.results?.getNodeDisp?.(nodeId) ?? null; }
  reaction(nodeId) { return this.results?.getReaction?.(nodeId) ?? null; }
  elementForces(elemId) { return this.results?.getElemForces?.(elemId) ?? null; }
  diagram(elemId, type = 'Mz', n = 12) { try { return this.results?.getDiagramData?.(elemId, type, n) ?? null; } catch { return null; } }
  period(mode = 0) { return this.modal?.period?.[mode] ?? null; }
  frequency(mode = 0) { return this.modal?.freq?.[mode] ?? null; }
  modeShape(mode = 0) { return this.modal?.getModeShape?.(mode) ?? null; }
  bucklingFactor(mode = 0) { return this.buckling?.factors?.[mode] ?? this.buckling?.lambda?.[mode] ?? null; }

  maxDisplacement() {
    if (!this.results?.getNodeDisp) return 0; let m = 0;
    for (const id of this.model.nodes.keys()) { const d = this.results.getNodeDisp(id); if (d) m = Math.max(m, Math.hypot(d[0], d[1], d[2])); }
    return m;
  }

  // ── DISEÑO ──────────────────────────────────────────────────────────────────
  // opts: { codeId?, params?, resultsSets?, member? }. Sin resultsSets usa los
  // resultados actuales. Devuelve un array por elemento con el chequeo D/C.
  design(opts = {}) {
    const sets = opts.resultsSets || (this.results ? [{ name: 'actual', res: this.results }] : []);
    if (!sets.length) throw new Error('No hay resultados: corra un análisis estático antes de diseñar.');
    const maxAbs = (res, eid, type) => { let d; try { d = res.getDiagramData(eid, type, 12); } catch { return 0; } let m = 0; for (const p of (d.pts || [])) m = Math.max(m, Math.abs(p.val)); for (const e of (d.extremes || [])) m = Math.max(m, Math.abs(e.val)); return m; };
    const filas = [];
    for (const el of this.model.elements.values()) {
      const sec = this.model.sections.get(el.secId), mat = this.model.materials.get(el.matId);
      if (!sec || !mat) continue;
      let peor = null, peorNom = null;
      for (const { nombre, res } of sets) {
        const f = res.getElemForces?.(el.id); if (!f) continue;
        const forces = { N: (Math.sign(f.N) || 1) * maxAbs(res, el.id, 'N'), Vy: maxAbs(res, el.id, 'Vy'), Vz: maxAbs(res, el.id, 'Vz'), My: maxAbs(res, el.id, 'My'), Mz: maxAbs(res, el.id, 'Mz'), L: f.L };
        const r = checkElement({ forces, sec, mat, params: opts.params || {}, codeId: opts.codeId, designSettings: this.model.designSettings, member: opts.member || el.design });
        if (!peor || r.ratioMax > peor.ratioMax) { peor = r; peorNom = nombre; }
      }
      if (peor) filas.push({ elemId: el.id, material: mat.name, seccion: sec.name, combo: peorNom, ...peor });
    }
    filas.sort((a, b) => b.ratioMax - a.ratioMax);
    return filas;
  }

  // Chequeo de diseño de UN elemento con forces dadas (sin análisis).
  checkMember({ forces, matId, secId, mat, sec, codeId, params, member }) {
    const M = mat || this.model.materials.get(matId), S = sec || this.model.sections.get(secId);
    return checkElement({ forces, sec: S, mat: M, codeId, params: params || {}, designSettings: this.model.designSettings, member });
  }

  // Propiedades de diseño resueltas (para inspección).
  resolvedMaterial(matId, params = {}) { return resolveMaterial(this.model.materials.get(matId), params); }
  resolvedSection(secId) { return resolveSectionProps(this.model.sections.get(secId)); }

  // ── Estados límite de SERVICIO (#68): flecha y deriva por norma ──────────────
  checkDeflection(opts) { return checkDeflection(opts); }
  checkDrift(opts) { return checkDrift(opts); }

  // Interstory drifts for one direction, checked against a code limit. Composes the
  // generic drift primitive (js/solver/drift.js) with driftLimit(code) — the primitive
  // stays code-agnostic; only the limit is per-norm, so a new code is one row there.
  //   opts = { results, direction='X', mode='auto'|'cm'|'ext', code='NCh433' }
  // `results` defaults to the last solveSpectrum output. Returns [{story, z, h, drift,
  // limit, ratio, ok, code, label?}]. Run once per direction for a full building.
  storyDrifts({ results, direction = 'X', mode = 'auto', code = 'NCh433' } = {}) {
    const res = results || this.results;
    if (!res || typeof res.getNodeDisp !== 'function')
      throw new Error('storyDrifts: needs results with getNodeDisp — run solveSpectrum first or pass { results }');
    const idx = { X: 0, Y: 1, Z: 2 }[direction];
    if (idx === undefined) throw new Error(`storyDrifts: bad direction "${direction}"`);
    const dispOf = id => { try { return res.getNodeDisp(id)[idx]; } catch { return 0; } };
    const levels = buildStoryLevels(this.model, dispOf, { mode });
    const lim = driftLimit(code);
    return interstoryDrifts(levels).map(s => ({
      ...s, limit: lim, ratio: lim > 1e-12 ? +(s.drift / lim).toFixed(4) : Infinity,
      ok: s.drift <= lim, code,
    }));
  }

  // ── Sección poligonal / compuesta (#70) ─────────────────────────────────────
  static polygonProps(o) { return polygonProps(o); }
  static compositeProps(o) { return compositeProps(o); }

  // ── Espectro de diseño NCh433/DS61 ───────────────────────────────────────────
  // { soil, zone, category, Ro, Tstar, Tmax, dT, applyRstar } → { curve, text, Rstar,
  // Sa0, params }. Fuente única del espectro (antes había 4 copias divergentes).
  static spectrumNCh433(o) { return buildSpectrum(o); }

  // ── Detallado sísmico columna fuerte-viga débil (#68) ────────────────────────
  // MnOf opcional: capacidad nominal de flexión por barra (kN·m). Por defecto
  // Mn ≈ Fy·Zz (acero) desde el material y la forma de la sección.
  seismicSCWB(MnOf, opts = {}) {
    const fn = MnOf || ((eid) => {
      const el = this.model.elements.get(eid); if (!el) return 0;
      const M = resolveMaterial(this.model.materials.get(el.matId) || {});
      const S = resolveSectionProps(this.model.sections.get(el.secId) || {});
      return (M.Fy || M.fc || 0) * (S.Zz || S.Sz || 0);
    });
    return jointSCWB(this.model, fn, opts);
  }
  static strongColumnWeakBeam(o) { return strongColumnWeakBeam(o); }

  // ── Catálogo de códigos de diseño ───────────────────────────────────────────
  static listDesignCodes(family) { return listDesignCodes(family).map(c => ({ id: c.id, family: c.family, label: c.label })); }
  static getDesignCode(id) { return getDesignCode(id); }
  static registerDesignCode(code) { return registerDesignCode(code); }
}

export default Portico;
