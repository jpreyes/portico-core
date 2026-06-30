// ──────────────────────────────────────────────────────────────────────────────
// backend.js — SOLVER ABSTRACTION (open). `SolverBackend` interface + a registry
// with dispatch and automatic fallback to the JS engine. The Pro repo `portico`
// registers Nodex (C++/WASM) here without touching core.
//
// GUIDING PRINCIPLE — HONEST OPEN SOURCE:
//   The interface declares ONLY what core's JS actually implements.
//   No phantom methods for analyses the JS cannot run.
//   Anything that needs a higher backend (Nodex: 7-DOF warping, direct nonlinear
//   time-history, fiber, LTB with warping, etc.) lives in the Pro overlay via
//   generic hooks.
//
// `SolverBackend` contract (async, to accommodate WASM/Cloud/native):
//   name           identifier ('js', 'cpp', …)
//   label          human-readable name
//   capabilities() → object with flags of what the backend implements
//   canSolve(…)    → { ok:boolean, reasons:string[] }
//   async solveStatic(model, lcId, opts)         → Results
//   async solveModal(model, nModes)              → ModalResults
//   async solveSpectrum(mr, params)              → SpectrumResults
//   async solveBuckling(o)                       → { modes, error? }
//   async solveNonlinear(o)                      → { converged, steps, … }
//   async solveNonlinearDC(o)                    → { ok, path, note }
//   async solveCorotBeam(o)                      → { converged, steps, … }
//   async solvePushover(o)                       → { ok, path, note }
//   async solveTimeHistoryModal(o)               → { t, q, nSteps, … }
//   async solveStaged(model, stages)             → StagedResult
//   async solveMovingLoads(model, lane, …)       → { positions, series, env, … }
//   async solveTendon(model, tendon)             → { loads, P, weq, L }
//   async solveFormFind(o)                       → { ok, coords, freeIdx, note }
// ──────────────────────────────────────────────────────────────────────────────
import { StaticSolver }          from './static_solver.js?v=2';
import { ModalSolver }           from './modal_solver.js?v=2';
import { SpectrumSolver }        from './spectrum_solver.js?v=2';
import { solveBuckling as _solveBuckling }      from './buckling.js?v=2';
import { solveNonlinear as _solveNonlinear,
         solveNonlinearDC as _solveNonlinearDC } from './nl_lite.js?v=2';
import { solveCorotBeam as _solveCorotBeam }    from './corotbeam.js?v=2';
import { modalTimeHistory }      from './timehistory.js?v=2';
import { StagedSolver }          from './staged.js?v=2';
import { movingLoadEnvelope }    from './moving_load.js?v=2';
import { tendonEquivalentLoads } from './tendon.js?v=2';
import { formFind }              from './formfind.js?v=2';

// ── Abstract base class ─────────────────────────────────────────────────────────
export class SolverBackend {
  get name()  { return 'base'; }
  get label() { return 'Base'; }
  capabilities() { return {}; }
  canSolve() { return { ok: true, reasons: [] }; }
  async solveStatic()           { throw new Error('SolverBackend.solveStatic not implemented'); }
  async solveModal()            { throw new Error('SolverBackend.solveModal not implemented'); }
  async solveSpectrum()         { throw new Error('SolverBackend.solveSpectrum not implemented'); }
  async solveBuckling()         { throw new Error('SolverBackend.solveBuckling not implemented'); }
  async solveNonlinear()        { throw new Error('SolverBackend.solveNonlinear not implemented'); }
  async solveNonlinearDC()      { throw new Error('SolverBackend.solveNonlinearDC not implemented'); }
  async solveCorotBeam()        { throw new Error('SolverBackend.solveCorotBeam not implemented'); }
  async solvePushover()         { throw new Error('SolverBackend.solvePushover not implemented'); }
  async solveTimeHistoryModal() { throw new Error('SolverBackend.solveTimeHistoryModal not implemented'); }
  async solveStaged()           { throw new Error('SolverBackend.solveStaged not implemented'); }
  async solveMovingLoads()      { throw new Error('SolverBackend.solveMovingLoads not implemented'); }
  async solveTendon()           { throw new Error('SolverBackend.solveTendon not implemented'); }
  async solveFormFind()         { throw new Error('SolverBackend.solveFormFind not implemented'); }
}

// ── JS engine (complete, universal fallback) ───────────────────────────────────
export class JsSolverBackend extends SolverBackend {
  get name()  { return 'js'; }
  get label() { return 'PORTICO JS (browser)'; }

  capabilities() {
    return {
      // ── What core's JS ACTUALLY does ─────────────────────────────────────────
      static:            true,   // linear static (elastic FEM, 6-DOF/node)
      modal:             true,   // frequencies/modes (inverse Stodola)
      spectrum:          true,   // response spectrum SRSS/CQC
      buckling:          true,   // linear buckling eigenproblem (K + λKg)φ = 0
      nonlinear:         true,   // geometric NL (corotational truss, 3-DOF/node)
      nonlinearDC:       true,   // displacement control (augmented system)
      corotBeam:         true,   // 2D large-rotation beam (Crisfield)
      pushover:          true,   // = displacement control with a load pattern
      timeHistoryModal:  true,   // linear modal TH (Nigam–Jennings)
      staged:            true,   // incremental linear construction stages
      movingLoads:       true,   // moving loads and influence lines
      tendon:            true,   // prestress (equivalent loads, FDM)
      formFind:          true,   // force-density form-finding
      distributedLoads:  true,
      selfWeight:        true,
      areas:             true,
      // ── What REQUIRES a higher backend (Nodex or other) ──────────────────────
      warping:              false,  // 7-DOF warping (bisymm. sections)
      fiber:                false,  // fiber section
      nlTimeHistoryDirect:  false,  // nonlinear TH by direct integration
      ltbWarping:           false,  // lateral-torsional buckling with warping
    };
  }

  canSolve() { return { ok: true, reasons: [] }; }

  async solveStatic(model, lcId, opts = {}) {
    return new StaticSolver().solve(model, lcId, !!opts.selfWeight);
  }

  async solveModal(model, nModes = 10) {
    return new ModalSolver().solve(model, nModes);
  }

  async solveSpectrum(mr, params) {
    return new SpectrumSolver().solve(mr, params);
  }

  // o = { Kff_flat, Kgff_flat, nF, nModes, dense }  — matrices already assembled by the caller
  async solveBuckling(o) {
    return _solveBuckling(o);   // → { modes:[{lambda, vec}] } | { error }
  }

  async solveNonlinear(o) {
    return _solveNonlinear(o);
  }

  async solveNonlinearDC(o) {
    return _solveNonlinearDC(o);
  }

  async solveCorotBeam(o) {
    return _solveCorotBeam(o);
  }

  // pushover = displacement control with a lateral load pattern
  async solvePushover(o) {
    return _solveNonlinearDC(o);
  }

  async solveTimeHistoryModal(o) {
    return modalTimeHistory(o);
  }

  async solveStaged(model, stages) {
    return new StagedSolver().solve(model, stages);
  }

  async solveMovingLoads(model, lane, train, responses, opts = {}) {
    return movingLoadEnvelope(model, lane, train, responses, opts);
  }

  async solveTendon(model, tendon) {
    return tendonEquivalentLoads(model, tendon);
  }

  async solveFormFind(o) {
    return formFind(o);
  }
}

// ── Method → capability flag ──────────────────────────────────────────────────
// `capabilities()` is the per-method source of truth: the registry routes a method
// to the active backend ONLY if it declares the corresponding flag. A backend that
// does some analyses but not others (e.g. Nodex: only static) declares exactly what
// it implements; everything else falls back to 'js'.
const METHOD_FLAG = {
  solveStatic:           'static',
  solveModal:            'modal',
  solveSpectrum:         'spectrum',
  solveBuckling:         'buckling',
  solveNonlinear:        'nonlinear',
  solveNonlinearDC:      'nonlinearDC',
  solveCorotBeam:        'corotBeam',
  solvePushover:         'pushover',
  solveTimeHistoryModal: 'timeHistoryModal',
  solveStaged:           'staged',
  solveMovingLoads:      'movingLoads',
  solveTendon:           'tendon',
  solveFormFind:         'formFind',
};

// ── Registry: active backend + transparent fallback to JS ─────────────────────
// The Pro layer registers Nodex: solverRegistry.register(new NodexBackend()).setActive('cpp').
export class SolverRegistry {
  constructor() {
    this._backends = new Map();
    this._activeName = 'js';
    this.register(new JsSolverBackend());
  }
  register(b)     { this._backends.set(b.name, b); return this; }
  list()          { return [...this._backends.values()]; }
  get(name)       { return this._backends.get(name); }
  get active()    { return this._backends.get(this._activeName) || this._backends.get('js'); }
  setActive(name) { if (this._backends.has(name)) this._activeName = name; return this; }

  // ¿El backend `bk` puede ejecutar `method`? capabilities()[flag] es el gate
  // primario (por método); canSolve(...canArgs) es un gate secundario opcional
  // (p.ej. estático que inspecciona el modelo). 'js' siempre puede (fallback universal).
  _supports(bk, method, canArgs) {
    if (bk.name === 'js') return true;
    const flag = METHOD_FLAG[method];
    const caps = bk.capabilities?.() || {};
    if (flag && !caps[flag]) return false;          // no declara la capacidad
    const can = bk.canSolve?.(...canArgs);
    return can ? !!can.ok : true;                    // canSolve opcional
  }

  // Dispatch robusto: backend activo si declara la capacidad (y pasa canSolve);
  // si no, 'js'. Si el backend elegido (≠ 'js') LANZA en runtime, se reintenta en
  // 'js'. 'js' es el fallback universal: si 'js' también falla, el error se propaga.
  // Marca res._backend / res._fellBack.
  async _dispatch(method, args, canArgs = []) {
    const js = this.get('js');
    let b = this.active, fellBack = false;
    if (!this._supports(b, method, canArgs)) { b = js; fellBack = true; }

    let res;
    try {
      res = await b[method](...args);
    } catch (err) {
      if (b.name === 'js') throw err;               // nada por debajo de 'js'
      b = js; fellBack = true;                       // el backend activo lanzó → cae a 'js'
      res = await js[method](...args);              // si 'js' lanza, se propaga
    }
    if (res && typeof res === 'object') { res._backend = b.name; res._fellBack = fellBack; }
    return res;
  }

  // solveStatic mantiene su firma y su can-check (canSolve(model, lcId, opts)),
  // alineado al mismo patrón de fallback + try/catch del dispatch genérico.
  async solveStatic(model, lcId, opts = {}) {
    return this._dispatch('solveStatic', [model, lcId, opts], [model, lcId, opts]);
  }

  async solveModal(model, nModes = 10) {
    return this._dispatch('solveModal', [model, nModes]);
  }
  async solveSpectrum(mr, params) {
    return this._dispatch('solveSpectrum', [mr, params]);
  }
  async solveBuckling(o) {
    return this._dispatch('solveBuckling', [o]);
  }
  async solveNonlinear(o) {
    return this._dispatch('solveNonlinear', [o]);
  }
  async solveNonlinearDC(o) {
    return this._dispatch('solveNonlinearDC', [o]);
  }
  async solveCorotBeam(o) {
    return this._dispatch('solveCorotBeam', [o]);
  }
  async solvePushover(o) {
    return this._dispatch('solvePushover', [o]);
  }
  async solveTimeHistoryModal(o) {
    return this._dispatch('solveTimeHistoryModal', [o]);
  }
  async solveStaged(model, stages) {
    return this._dispatch('solveStaged', [model, stages]);
  }
  async solveMovingLoads(model, lane, train, responses, opts = {}) {
    return this._dispatch('solveMovingLoads', [model, lane, train, responses, opts]);
  }
  async solveTendon(model, tendon) {
    return this._dispatch('solveTendon', [model, tendon]);
  }
  async solveFormFind(o) {
    return this._dispatch('solveFormFind', [o]);
  }
}

export const solverRegistry = new SolverRegistry();
export default solverRegistry;
