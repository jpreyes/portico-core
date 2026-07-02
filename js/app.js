// ──────────────────────────────────────────────────────────────────────────────
// App — main orchestrator
// ──────────────────────────────────────────────────────────────────────────────
import { Model }           from './model/model.js?v=2';
import { Serializer }      from './model/serializer.js?v=2';
import { Viewport }        from './ui/viewport.js?v=2';
import { PropertiesPanel } from './ui/properties.js?v=2';
import { MenuBar }         from './ui/menu.js?v=2';
import { UndoStack }       from './utils/undo.js?v=2';
import { esc }             from './utils/escape.js?v=2';
import { StaticSolver, ensureDefaultLC }   from './solver/static_solver.js?v=2';
import { Results }                         from './solver/postprocess.js?v=2';
import { assessStabilitySanity, STABILITY } from './solver/stability.js?v=2';
import { areaStress, areaBendingStress, vonMises, areaLocalFrame } from './solver/membrane.js?v=2';
import { ModalSolver, guyanReduce }        from './solver/modal_solver.js?v=2';
import { buildNodeIndex, assembleK, assembleF, getNodeDOFs } from './solver/assembler.js?v=2';
import { assembleSparseGlobal, extractFreeCSR } from './solver/sparse.js?v=2';
import { corotBeamForceTangent } from './solver/corotbeam.js?v=2';
import { insertInfill } from './model/macromodel.js?v=2';
import { listMacros, getMacro, insertMacro } from './model/macro_registry.js?v=2';
import { assembleKg } from './solver/geometric.js?v=2';
import { makeFactor } from './solver/linsolve.js?v=2';
import { ModalResults }                    from './solver/modal_results.js?v=2';
import { parseAccelerogram, accStats, scaleToPGA, DEMO_PRESETS, G as GACC } from './solver/accelerograms.js?v=2';
import { tendonEquivalentLoads, applyTendon, tendonEcc } from './solver/tendon.js?v=2';
import { buildLane, influenceLine, responseReaction, responseSection } from './solver/moving_load.js?v=2';
import { newmarkNonlinear, shearBuilding, rayleighDamping } from './solver/nl_timehistory.js?v=2';
import { checkDrift } from './design/serviceability.js?v=2';
import { selectProfile, steelCandidates, predimensionar, candidatesForFamily } from './design/autodesign.js?v=2';
import { jointSCWB } from './design/seismic.js?v=2';
import { resolveMaterial } from './design/material_props.js?v=2';
import { resolveSectionProps } from './design/section_props.js?v=2';
import { autoDetectDiaphragms, computeFloorCR, applyDiaphragmConstraints } from './solver/diaphragm.js?v=2';
import { splitElement, splitByLength, discretizeAll, joinElements, intersectElements } from './model/discretize.js?v=2';
import { localAxes, stiffnessMatrix, massMatrix, transformMatrix, globalStiffness, applyReleases } from './solver/timoshenko.js?v=2';
import { blockCells, cornerGridIndices } from './model/mesher.js?v=2';
import { coonsGridFromCorners } from './model/mesh_map.js?v=2';
import { meshPolygonIntoModel } from './model/mesh_free.js?v=2';
import { smoothAreasInModel } from './model/mesh_quality.js?v=2';
import { listFormats, exportModel, importModel } from './io/index.js?v=2';
import { extensions } from './ext/extensions.js?v=2';
import { loadBranding, getBranding } from './branding.js?v=2';
import { solverRegistry } from './solver/backend.js?v=2';
import { i18n } from './i18n/i18n.js?v=2';

// Load categories (#106) — for automatic combinations and design.
const LOAD_TYPES = [
  ['dead', 'Muerta / permanente'], ['live', 'Viva / sobrecarga'],
  ['wind', 'Viento'], ['seismic', 'Sismo'], ['snow', 'Nieve'],
  ['temperature', 'Temperatura'], ['other', 'Otra'],
];
const LOAD_TYPE_LABEL = Object.fromEntries(LOAD_TYPES);

class App {
  constructor() {
    this.model      = new Model();
    this.serializer = new Serializer();
    this.undoStack  = new UndoStack(60);

    this._dirty           = false;
    this._sessionId       = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);  // this session's autosave slot (#43)
    this._fileHandle      = null;
    this._filePath        = null;   // Electron: native file path (string)
    this._results         = null;   // static / spectral Results object (viewport)
    this._modalResults    = null;   // ModalResults object
    this._spectrumResults = new Map(); // 'espX'|'espY'|'espZ' → {result, params}
    this._modalMode       = 0;      // currently displayed mode index (0-based)
    this._modalPlaying    = false;  // animation running?
    this._activeLcId      = null;   // active load case ID
    this._config          = this._loadConfig();   // app config (report, visual, modifiers)

    // G7 · Multi-model project: several models in one file, with no geometric link.
    // The INACTIVE ones live as JSON blobs (`json`); the ACTIVE one is `this.model`.
    this._project = { models: [{ id: 1, name: 'Modelo 1', json: null }], activeId: 1, nextId: 2 };

    // UI components
    this.viewport = new Viewport(
      document.getElementById('viewport-container'), this
    );
    this.panel = new PropertiesPanel(
      document.getElementById('panel'), this
    );
    this.menu = new MenuBar(
      document.getElementById('menubar'), this
    );

    // Toast container
    const tc = document.createElement('div');
    tc.id = 'toast-container';
    document.body.appendChild(tc);

    this._bindKeys();
    this._bindModal();
    this._bindElectronMenu();
    this._initProjectUI();

    // Periodic autosave every 5 min (besides the debounced one and beforeunload):
    // tolerant to a close/power loss even during long edits (#43).
    this._autosaveInterval = setInterval(() => { if (this._dirty) this._autosaveNow(); }, 5 * 60 * 1000);

    // Initial render
    this.viewport.renderModel(this.model);
    this._updateStats();
    this._updateTitle();

    // Load case UI
    this._initLoadCaseUI();
    this.refreshLoads();
    this._initResizeHandle();
    this._initMobilePanel();

    // Analysis button → opens the analysis hub (floating window)
    document.getElementById('btn-run')?.addEventListener('click', () => this.openAnalysisHub());
    document.getElementById('btn-clear-results')?.addEventListener('click', () => {
      // Toggle: in results mode → back to the model; in model with results → re-show.
      if (this.viewport._inResultsMode) this.exitResultsView();
      else if (this._results) { this._refreshResultView(true); this._updateViewToggleBtn(); }
    });
    // Permanent results indicator (status bar) → opens the hub
    document.getElementById('sb-results')?.addEventListener('click', () => this.openAnalysisHub());
    this._updateResultsIndicator();

    // Results type/scale changes.
    // The scale control is a RELATIVE FACTOR (1 = normalized automatic fit). On
    // changing the result type it ALWAYS RE-NORMALIZES (autoScale=true) so each
    // diagram is born well-sized and doesn't inherit an absurd scale from the
    // previous type.
    document.getElementById('result-type')?.addEventListener('change', () => this._refreshResultView(true));
    // #103: result-case selector + download of the current case (in the bar)
    document.getElementById('res-case')?.addEventListener('change', e => this._showResultCase(e.target.value));
    document.getElementById('res-dl')?.addEventListener('click', () => this.exportResults());
    document.getElementById('result-scale')?.addEventListener('change', () => {
      this._refreshResultView();
      // Sync range slider (factor → log10)
      const f = parseFloat(document.getElementById('result-scale')?.value) || 1;
      const logV = Math.log10(Math.max(f, 1e-3));
      const rangeEl = document.getElementById('result-scale-range');
      if (rangeEl) rangeEl.value = Math.max(-1.5, Math.min(1.5, logV));
    });
    document.getElementById('result-scale-range')?.addEventListener('input', e => {
      const factor = Math.pow(10, parseFloat(e.target.value));
      const numEl = document.getElementById('result-scale');
      if (numEl) numEl.value = +factor.toPrecision(3);
      if (this._results) this._refreshResultView();
    });
    // Double-click on the control → back to automatic fit (factor 1).
    document.getElementById('result-scale')?.addEventListener('dblclick', () => {
      const numEl = document.getElementById('result-scale');
      const rangeEl = document.getElementById('result-scale-range');
      if (numEl) numEl.value = 1;
      if (rangeEl) rangeEl.value = 0;
      this._refreshResultView(true);
    });

    // Toolbar extras
    // Elevation selector (true 2D view of a structural axis, only in 3D)
    document.getElementById('elev-select')?.addEventListener('change', e => {
      const v = e.target.value;
      if (!v) { this.viewport.setElevation(null); return; }
      const [axis, coordS] = v.split(':');
      const coord = parseFloat(coordS);
      const opt = e.target.selectedOptions[0];
      this.viewport.setElevation({ axis, coord, name: opt ? opt.textContent : v });
    });
    document.getElementById('btn-toggle-ids')?.addEventListener('click', () => this.viewport.toggleIds());
    document.getElementById('btn-config')?.addEventListener('click', () => this.configDialog());
    document.getElementById('btn-config-tool')?.addEventListener('click', () => this.configDialog());
    document.getElementById('btn-tree-toggle')?.addEventListener('click', () => this.toggleModelTree());
    document.getElementById('btn-toggle-extrude')?.addEventListener('click', () => this.viewport.toggleExtruded());
    document.getElementById('btn-export-img')?.addEventListener('click', () => this.exportViewportPNG());

    // Support reactions (toggle)
    document.getElementById('btn-show-reactions')?.addEventListener('click', () => {
      this._showReactions = !this._showReactions;
      document.getElementById('btn-show-reactions')?.classList.toggle('active', this._showReactions);
      if (this._showReactions && this._results) this.viewport.showReactions(this._results);
      else this.viewport.clearReactions();
    });

    this._initHelp();
    this._initTheme();
    this._initI18n();
    this._initExtensions();

    // F1 / F5 / F6 / F7 / F8 shortcuts
    document.addEventListener('keydown', e => {
      if (e.key === 'F1') { e.preventDefault(); this.openHelp('guia');       }
      if (e.key === 'F5') { e.preventDefault(); this.runAnalysis();          }
      if (e.key === 'F6') { e.preventDefault(); this.runModal();             }
      if (e.key === 'F7') { e.preventDefault(); this.runSpectrum();          }
      if (e.key === 'F8') { e.preventDefault(); this.openCombosTab(); }
      const resKeys = { '1':'deformed','2':'N','3':'Vy','4':'Vz','5':'T','6':'My','7':'Mz','8':'vm' };
      const inInput = ['INPUT','SELECT','TEXTAREA'].includes(document.activeElement?.tagName);
      if (resKeys[e.key] && !inInput) this.setResultType(resKeys[e.key]);
    });

    // Autosave on closing/reloading the page
    window.addEventListener('beforeunload', () => this._autosaveNow());

    // Restore autosave or load the example
    this._restoreOrLoadExample();
  }

  // ── Model mutations (all go through here for undo tracking) ───────────────

  snapshot() {
    // Safety (#42): if the model is auto-discretized (analysis mesh, `_predisc` holds
    // the original), the user's FIRST edit returns to the ORIGINAL model before
    // mutating. This way the subdivided mesh is never edited or saved, and «Clear
    // results» cannot revert to an old state (data loss).
    if (this._predisc) {
      this.model = this.serializer.fromJSON(this._predisc);
      this._predisc = null;
      if (this.viewport._inResultsMode) this.viewport.clearResults();
      this.viewport.renderModel(this.model);
      this.refreshLoads();
      this._updateStats();
      this.toast('Se salió de la malla de análisis (auto-disc) para editar el modelo original', '');
    }
    this.undoStack.push(this.serializer.toJSON(this.model));
  }

  addNode(x, y, z) {
    this.snapshot();
    if (this.model.mode === '2D') y = 0;   // planar X–Z frame
    const node = this.model.addNode(x, y, z);
    this.viewport.addNodeMesh(node);
    this.panel.showNode(node);
    this.markDirty();
    this._updateStats();
    return node;
  }

  addElement(n1id, n2id) {
    this.snapshot();
    const elem = this.model.addElement(n1id, n2id);
    if (!elem) {
      this.toast('No se pudo crear el elemento (nodos inválidos)', 'warn');
      return null;
    }
    this.viewport.addElemLine(elem);
    this.panel.showElement(elem);
    this.markDirty();
    this._updateStats();
    return elem;
  }

  deleteNode(id) {
    this.snapshot();
    const node = this.model.nodes.get(id);
    if (!node) return;
    // Delete connected elements from viewport first
    for (const [eid, el] of this.model.elements) {
      if (el.n1 === id || el.n2 === id) this.viewport.removeElemLine(eid);
    }
    for (const aid of this._nodeAreas(id)) { this.viewport.removeAreaMesh(aid); this.model.removeArea(aid); }
    this.viewport.removeNodeMesh(id);
    this.model.removeNode(id);
    this.refreshLoads();        // removes orphan load arrows
    this.panel.showNothing();
    this.markDirty();
    this._updateStats();
    this.toast(`${i18n.t('Nodo')} #${id} ${i18n.t('eliminado')}`, 'ok');
  }

  deleteElement(id) {
    this.snapshot();
    this.viewport.removeElemLine(id);
    this.model.removeElement(id);
    this.refreshLoads();        // removes orphan load arrows
    this.panel.showNothing();
    this.markDirty();
    this._updateStats();
    this.toast(`${i18n.t('Elemento')} #${id} ${i18n.t('eliminado')}`, 'ok');
  }

  deleteArea(id) {
    this.snapshot();
    this.viewport.removeAreaMesh(id);
    this.model.removeArea(id);
    this.panel.showNothing();
    this.markDirty();
    this._updateStats?.();
    this.toast(`${i18n.t('Elemento de área')} #${id} ${i18n.t('eliminado')}`, 'ok');
  }

  // Areas touching a given node (to clean them up when deleting the node).
  _nodeAreas(nodeId) {
    const out = [];
    for (const [aid, a] of this.model.areas) if (a.nodes.includes(nodeId)) out.push(aid);
    return out;
  }

  deleteSelected() {
    const sel = this.viewport.getSelected();
    if (!sel.length) return;
    this.snapshot();
    // Delete areas + elements before nodes to avoid dangling references
    const areas = sel.filter(s => s.type === 'area');
    const elems = sel.filter(s => s.type === 'elem');
    const nodes = sel.filter(s => s.type === 'node');
    const dias  = sel.filter(s => s.type === 'diaphragm');
    for (const { id } of dias) this.model.removeDiaphragm(id);
    for (const { id } of areas) { this.viewport.removeAreaMesh(id); this.model.removeArea(id); }
    for (const { id } of elems) {
      this.viewport.removeElemLine(id);
      this.model.removeElement(id);
    }
    for (const { id } of nodes) {
      for (const [eid, el] of this.model.elements) {
        if (el.n1 === id || el.n2 === id) {
          this.viewport.removeElemLine(eid);
          this.model.removeElement(eid);
        }
      }
      for (const aid of this._nodeAreas(id)) { this.viewport.removeAreaMesh(aid); this.model.removeArea(aid); }
      this.viewport.removeNodeMesh(id);
      this.model.removeNode(id);
    }
    if (dias.length) this.viewport.refreshDiaphragms();   // removes the deleted diaphragm's viz
    this.refreshLoads();        // removes orphan load arrows
    this.viewport.clearSelection();
    this.panel.showNothing();
    this.markDirty();
    this._updateStats();
  }

  // ── Element discretization ──────────────────────────────────────────────────
  discretizeElement(elemId, opts) {
    this.snapshot();
    const ids = (opts.length > 0)
      ? splitByLength(this.model, elemId, opts.length)
      : splitElement(this.model, elemId, opts.parts || 2);
    if (!ids || ids.length < 2) {
      this.toast('No se pudo discretizar (¿el tramo objetivo es mayor que el elemento?)', 'warn');
      return;
    }
    this.viewport.renderModel(this.model);
    this.refreshLoads();
    this.panel.showNothing();
    this.markDirty();
    this._updateStats();
    this.toast(`${i18n.t('Elemento')} #${elemId} ${i18n.t('dividido en')} ${ids.length} ${i18n.t('tramos')}`, 'ok');
  }

  joinSelectedElements() {
    const sel = this.viewport.getSelected().filter(s => s.type === 'elem').map(s => s.id);
    if (sel.length < 2) {
      this.toast('Seleccione 2 o más elementos colineales (Ctrl+clic) para unir', 'warn');
      return;
    }
    this.snapshot();
    const r = joinElements(this.model, sel);
    if (!r.ok) { this.toast(`${i18n.t('No se pudo unir:')} ${r.reason}`, 'warn'); return; }
    this.viewport.renderModel(this.model);
    this.refreshLoads();
    this.panel.showNothing();
    this.markDirty();
    this._updateStats();
    this.toast(`${sel.length} ${i18n.t('elementos unidos → Elemento')} #${r.elemId}`, 'ok');
  }

  /** Creates a shared node at the intersection of 2 crossing elements. */
  joinIntersection() {
    const sel = this.viewport.getSelected().filter(s => s.type === 'elem').map(s => s.id);
    if (sel.length !== 2) {
      this.toast('Seleccione exactamente 2 elementos que se intersecten (Ctrl+clic) para unirlos', 'warn');
      return;
    }
    this.snapshot();
    const r = intersectElements(this.model, sel[0], sel[1]);
    if (!r.ok) { this.toast(`${i18n.t('No se pudo unir:')} ${r.reason}`, 'warn'); return; }
    this.viewport.renderModel(this.model);
    this.refreshLoads();
    this.panel.showNothing();
    this.markDirty();
    this._updateStats();
    this.toast(`${i18n.t('Nodo de intersección creado')} (#${r.nodeId}); ${r.nuevos} ${i18n.t('tramos')}`, 'ok');
  }

  // ── Bulk actions on the element selection ───────────────────────────────────
  _selElems() { return this.viewport.getSelected().filter(s => s.type === 'elem').map(s => s.id); }
  _selAreas() { return this.viewport.getSelected().filter(s => s.type === 'area').map(s => s.id); }

  // Applies behavior / thickness / material to ALL selected areas.
  setAreasProps(props) {
    const ids = this._selAreas(); if (!ids.length) return;
    this.snapshot();
    for (const id of ids) {
      this.model.updateArea(id, props);
      this.viewport.addAreaMesh(this.model.areas.get(id));
      this.viewport._setAreaHL(id, 0xffc107);
    }
    this.markDirty(); this._updateStats?.();
    this.toast(`${ids.length} ${i18n.t('área(s) actualizadas')}`, 'ok');
  }
  _reselect(ids) { this.viewport.selectElements(ids); this.panel.showSelection(this.viewport.getSelected()); }

  setMaterialSelected(matId) {
    const ids = this._selElems(); if (!ids.length || matId == null) return;
    this.snapshot();
    for (const id of ids) this.model.updateElement(id, { matId: +matId });
    this.viewport.renderModel(this.model); this.markDirty(); this._updateStats();
    this.toast(`${i18n.t('Material aplicado a')} ${ids.length} ${i18n.t('elemento(s)')}`, 'ok');
    this._reselect(ids);
  }
  setSectionSelected(secId) {
    const ids = this._selElems(); if (!ids.length || secId == null) return;
    this.snapshot();
    for (const id of ids) this.model.updateElement(id, { secId: +secId });
    this.viewport.renderModel(this.model); this.markDirty(); this._updateStats();
    this.toast(`${i18n.t('Sección aplicada a')} ${ids.length} ${i18n.t('elemento(s)')}`, 'ok');
    this._reselect(ids);
  }
  discretizeSelected(parts) {
    const ids = this._selElems(); if (!ids.length) return;
    parts = Math.max(2, Math.round(parts || 2));
    this.snapshot();
    let tramos = 0; for (const id of ids) { const r = splitElement(this.model, id, parts); tramos += (r && r.length) ? r.length : 1; }
    this.viewport.renderModel(this.model); this.refreshLoads(); this.panel.showNothing(); this.markDirty(); this._updateStats();
    this.toast(`${ids.length} ${i18n.t('elemento(s) divididos en')} ${parts} (${tramos} ${i18n.t('tramos')})`, 'ok');
  }
  hideSelected() {
    const ids = this._selElems(); if (!ids.length) { this.toast('Seleccione elementos para ocultar', 'warn'); return; }
    this.viewport.hideElements(ids); this.viewport.clearSelection(); this.panel.showNothing();
    this.toast(`${ids.length} ${i18n.t('elemento(s) oculto(s) · Vista → Mostrar todo para revertir')}`, 'ok');
  }
  showAllElements() {
    const n = this.viewport.hiddenCount(); this.viewport.showAllElements();
    this.toast(n ? `${n} elemento(s) mostrado(s)` : 'No había elementos ocultos', 'ok');
  }

  // ── Element groups (session state) ──────────────────────────────────────────
  groups() { return (this._grupos ||= new Map()); }
  createGroup(nombre) {
    const ids = this._selElems(); if (!ids.length) { this.toast('Seleccione elementos para agrupar', 'warn'); return; }
    this.groups();
    nombre = String(nombre || '').trim() || `Grupo ${this._grupos.size + 1}`;
    this._grupos.set(nombre, new Set(ids));
    this.toast(`${i18n.t('Grupo')} "${nombre}" ${i18n.t('creado')} (${ids.length} ${i18n.t('elementos')})`, 'ok');
    this.panel.showSelection(this.viewport.getSelected());
  }
  selectGroup(nombre) { const g = this.groups().get(nombre); if (!g) return; this.viewport.selectElements([...g]); this.panel.showSelection(this.viewport.getSelected()); }
  hideGroup(nombre) { const g = this.groups().get(nombre); if (!g) return; this.viewport.hideElements([...g]); this.toast(`Grupo "${nombre}" oculto`, 'ok'); }
  showGroup(nombre) { const g = this.groups().get(nombre); if (!g) return; this.viewport.showElements([...g]); this.toast(`Grupo "${nombre}" mostrado`, 'ok'); }
  deleteGroup(nombre) { this.groups().delete(nombre); this.toast(`Grupo "${nombre}" eliminado`, 'ok'); this.panel.showSelection(this.viewport.getSelected()); }

  // ── Area elements (CST/QUAD membrane) ─────────────────────────────────────
  async createAreaFromSelection() {
    const ids = this._selNodes();
    if (ids.length !== 3 && ids.length !== 4) { this.toast('Seleccione 3 nodos (CST) o 4 nodos (QUAD) para crear un elemento de área', 'warn'); return; }
    const str = await this._promptModal('Elemento de área',
      'Espesor t (m) y comportamiento (M=membrana, P=placa, S=shell=membrana+placa), separados por coma. Ej: 0.2,S', '0.2,M');
    if (str == null) return;
    const p = str.split(',').map(s => s.trim());
    const t = parseFloat(p[0]); if (!(t > 0)) { this.toast('Espesor inválido', 'warn'); return; }
    const behavior = this._behaviorCode(p[1]);
    this._lastAreaOpts = { thickness: t, behavior };   // remembered for the Area tool
    const ordered = ids.length === 4 ? this._ordenarCuad(ids) : ids;
    this.snapshot();
    const matId = [...this.model.materials.keys()][0];
    const a = this.model.addArea(ordered, matId, { thickness: t, behavior });
    if (!a) { this.toast('No se pudo crear el área (nodos repetidos o inexistentes)', 'warn'); return; }
    this.viewport.addAreaMesh(a);
    this.markDirty(); this._updateStats?.();
    this.toast(`${i18n.t('Elemento de área')} ${a.kind} #${a.id} (${this._behaviorLabel(behavior)}, t=${t} m) ${i18n.t('creado')}`, 'ok');
  }

  // Creates an area from 3/4 nodes (sidebar Area tool), with the last options used
  // (thickness/behavior) — no dialog. The user adjusts material/thickness/behavior
  // afterwards in the area panel.
  createAreaFromNodes(ids) {
    if (!ids || (ids.length !== 3 && ids.length !== 4)) { this.toast('Un área necesita 3 (CST) o 4 (QUAD) nodos', 'warn'); return; }
    const opts = this._lastAreaOpts || (this._lastAreaOpts = { thickness: 0.2, behavior: 'membrane' });
    const ordered = ids.length === 4 ? this._ordenarCuad(ids) : ids;
    this.snapshot();
    const matId = [...this.model.materials.keys()][0];
    const a = this.model.addArea(ordered, matId, { ...opts });
    if (!a) { this.toast('No se pudo crear el área (nodos repetidos o inexistentes)', 'warn'); return; }
    this.viewport.addAreaMesh(a);
    this.markDirty(); this._updateStats?.();
    this.toast(`${i18n.t('Área')} ${a.kind} #${a.id} (${this._behaviorLabel(opts.behavior)}, t=${opts.thickness} m) — ${i18n.t('ajusta sus propiedades en el panel')}`, 'ok');
  }

  // Area behavior codes/labels.
  _behaviorCode(s) { const c = (s || 'M').toUpperCase()[0]; return c === 'S' ? 'shell' : c === 'P' ? 'plate' : 'membrane'; }
  _behaviorLabel(b) { return b === 'shell' ? 'shell' : b === 'plate' ? 'placa' : 'membrana'; }

  // Orders 4 nodes counterclockwise around the centroid, in their plane, so the
  // quadrilateral isn't self-crossing regardless of the selection order.
  _ordenarCuad(ids) {
    const P = ids.map(id => { const n = this.model.nodes.get(id); return { id, x: n.x, y: n.y, z: n.z }; });
    const c = P.reduce((s, p) => ({ x: s.x + p.x / 4, y: s.y + p.y / 4, z: s.z + p.z / 4 }), { x: 0, y: 0, z: 0 });
    const v1 = [P[1].x - P[0].x, P[1].y - P[0].y, P[1].z - P[0].z];
    let nrm = null;
    for (let k = 2; k < 4; k++) {
      const w = [P[k].x - P[0].x, P[k].y - P[0].y, P[k].z - P[0].z];
      const cr = [v1[1] * w[2] - v1[2] * w[1], v1[2] * w[0] - v1[0] * w[2], v1[0] * w[1] - v1[1] * w[0]];
      if (Math.hypot(...cr) > 1e-9) { nrm = cr; break; }
    }
    if (!nrm) return ids;
    const nn = Math.hypot(...nrm), ez = nrm.map(v => v / nn);
    const e1n = Math.hypot(...v1), ex = v1.map(v => v / e1n);
    const ey = [ez[1] * ex[2] - ez[2] * ex[1], ez[2] * ex[0] - ez[0] * ex[2], ez[0] * ex[1] - ez[1] * ex[0]];
    const ang = p => { const d = [p.x - c.x, p.y - c.y, p.z - c.z]; return Math.atan2(d[0] * ey[0] + d[1] * ey[1] + d[2] * ey[2], d[0] * ex[0] + d[1] * ex[1] + d[2] * ex[2]); };
    return [...P].sort((a, b) => ang(a) - ang(b)).map(p => p.id);
  }

  // Meshes a panel: 4 corner nodes → structured nx×ny grid of membranes
  // (MESHGEN, bilinear block interpolation). Reuses the 4 corner nodes.
  async meshPanelSelection(idsArg) {
    const ids = idsArg || this._selNodes();   // idsArg comes from the «Mesh» mode (#78)
    if (ids.length !== 4) { this.toast('Seleccione 4 nodos esquina del panel (en cualquier orden)', 'warn'); return; }
    const str = await this._promptModal('Mallar panel (4 esquinas)',
      'nx, ny, espesor t (m), tipo (Q=quad / T=tri) y comportamiento (M=membrana/P=placa/S=shell). Ej: 6,2,0.2,Q,S', '4,2,0.2,Q,M');
    if (str == null) return;
    const p = str.split(',').map(s => s.trim());
    const nx = Math.round(+p[0]), ny = Math.round(+p[1]), t = parseFloat(p[2]);
    const tri = (p[3] || 'Q').toUpperCase().startsWith('T');
    const behavior = this._behaviorCode(p[4]);
    if (!(nx >= 1 && ny >= 1 && t > 0)) { this.toast('Valores inválidos (nx, ny ≥ 1; t > 0)', 'warn'); return; }
    if (nx * ny > 2500) { this.toast('Demasiados elementos (>2500). Reduzca nx·ny.', 'warn'); return; }

    const ordered = this._ordenarCuad(ids);
    const corners = ordered.map(id => { const n = this.model.nodes.get(id); return [n.x, n.y, n.z]; });
    const pts = coonsGridFromCorners(corners, nx, ny);   // transfinite (superset of bilinear)
    const ci = cornerGridIndices(nx, ny);   // [P1,P2,P3,P4] grid indices
    const cornerMap = new Map([[ci[0], ordered[0]], [ci[1], ordered[1]], [ci[2], ordered[2]], [ci[3], ordered[3]]]);

    this.snapshot();
    const nodeId = [];
    for (let g = 0; g < pts.length; g++) {
      if (cornerMap.has(g)) nodeId[g] = cornerMap.get(g);
      else { const q = pts[g]; nodeId[g] = this.model.addNode(q[0], q[1], q[2]).id; }
    }
    const matId = [...this.model.materials.keys()][0];
    let created = 0;
    for (const cell of blockCells(nx, ny, tri)) {
      const a = this.model.addArea(cell.map(g => nodeId[g]), matId, { thickness: t, behavior });
      if (a) created++;
    }
    this.viewport.renderModel(this.model);
    this.markDirty(); this._updateStats?.();
    this.toast(`${i18n.t('Panel mallado:')} ${created} ${tri ? 'CST' : 'QUAD'} (${nx}×${ny}, ${this._behaviorLabel(behavior)}), ${pts.length - 4} ${i18n.t('nodos nuevos')} · t=${t} m`, 'ok');
  }

  // FREE mesh of a region (mesh_free): N selected nodes form the outline (ordered by
  // angle) → triangulation + recombination to quads. Welds to the existing outline
  // nodes. For non-star-shaped forms use the 4-corner panel.
  async mallarRegionLibre(idsArg) {
    const ids = idsArg || this._selNodes();   // idsArg comes from the «Mesh» mode (#78)
    if (ids.length < 3) { this.toast('Seleccione ≥3 nodos que formen el contorno de la región', 'warn'); return; }
    // order by angle around the centroid (simple polygon if star-shaped)
    const P = ids.map(id => { const n = this.model.nodes.get(id); return { id, x: n.x, y: n.y, z: n.z }; });
    const cx = P.reduce((s, p) => s + p.x, 0) / P.length, cy = P.reduce((s, p) => s + p.y, 0) / P.length;
    P.sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
    const o = await this._mallarRegionDialog(P.length);
    if (o == null) return;
    const { h, tri, t, behavior } = o;
    if (!(h > 0 && t > 0)) { this.toast('Valores inválidos (h>0, t>0)', 'warn'); return; }
    this.snapshot();
    const matId = [...this.model.materials.keys()][0];
    let res;
    try {
      res = meshPolygonIntoModel(this.model, P.map(p => [p.x, p.y, p.z]),
        { h, recombine: !tri, thickness: t, behavior, matId, weldTol: 1e-4,
          smooth: o.smooth, blossom: o.blossom, maxCardinality: o.maxCardinality,
          cost: o.cost, valence: o.valence, adaptive: o.adaptive, adaptiveOpts: o.adaptiveOpts });
    } catch (e) { this.toast(i18n.t('No se pudo mallar la región:') + ' ' + e.message, 'warn'); return; }
    this.viewport.renderModel(this.model);
    this.markDirty(); this._updateStats?.();
    const nQ = res.areaIds.filter(id => (this.model.areas.get(id)?.nodes.length === 4)).length;
    const nT = res.areaIds.length - nQ;
    this.toast(`${i18n.t('Región mallada:')} ${res.areaIds.length} ${i18n.t('celdas')} (${nQ} quad + ${nT} tri, ${this._behaviorLabel(behavior)}) · h=${h} m`, 'ok');
  }

  // Free-mesh options dialog (#52): size/type/thickness/behavior + advanced engine
  // controls (Blossom recombination, valence, adaptive).
  async _mallarRegionDialog(nContorno) {
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = i18n.t('🔲 Mallar región libre');
    document.getElementById('modal-cancel').style.display = '';
    document.getElementById('modal-body').innerHTML = `
      <p style="color:var(--text-muted);font-size:11px;margin:0 0 8px">Contorno = <b>${nContorno}</b> nodos seleccionados. El motor triangula, recombina a cuadriláteros y suaviza.</p>
      <div class="prop-row">
        <div class="prop-field"><label>Tamaño h (m)</label><input type="number" id="ml-h" value="0.5" step="0.1" min="0.01" style="width:80px"></div>
        <div class="prop-field"><label>Tipo</label><select id="ml-tipo"><option value="Q">Cuadriláteros</option><option value="T">Triángulos</option></select></div>
      </div>
      <div class="prop-row">
        <div class="prop-field"><label>Espesor t (m)</label><input type="number" id="ml-t" value="0.2" step="0.05" min="0.001" style="width:80px"></div>
        <div class="prop-field"><label>Comportamiento</label><select id="ml-beh"><option value="M">Membrana</option><option value="P">Placa</option><option value="S">Cáscara</option></select></div>
      </div>
      <details style="margin-top:8px" id="ml-adv">
        <summary style="cursor:pointer;font-size:12px;color:var(--accent,#4af)">⚙ Opciones avanzadas del mallador</summary>
        <div style="padding:8px 4px 0;display:flex;flex-direction:column;gap:6px">
          <label style="font-size:11px;display:flex;align-items:center;gap:6px" id="ml-blo-box"><input type="checkbox" id="ml-blossom" checked> Recombinación óptima «Blossom» (matching de peso máximo)</label>
          <label style="font-size:11px;display:flex;align-items:center;gap:6px" id="ml-card-box"><input type="checkbox" id="ml-card" checked> Maximizar nº de cuadriláteros (Blossom-IV)</label>
          <div class="prop-field" id="ml-cost-box"><label style="font-size:11px">Criterio de calidad del quad</label><select id="ml-cost"><option value="gmsh">Ángulos rectos (Gmsh)</option><option value="jac">Jacobiano (forma)</option></select></div>
          <label style="font-size:11px;display:flex;align-items:center;gap:6px"><input type="checkbox" id="ml-valence" checked> Optimización topológica de valencia</label>
          <label style="font-size:11px;display:flex;align-items:center;gap:6px"><input type="checkbox" id="ml-adaptive" checked> Refinar esquinas reentrantes/agudas (adaptativo)</label>
          <div class="prop-row" id="ml-adapt-box">
            <div class="prop-field"><label style="font-size:11px">Tamaño mín. en esquinas (% de h)</label><input type="number" id="ml-hmin" value="50" step="10" min="10" max="100" style="width:70px"></div>
            <div class="prop-field"><label style="font-size:11px">Suavizado (iter.)</label><input type="number" id="ml-smooth" value="3" step="1" min="0" max="20" style="width:60px"></div>
          </div>
        </div>
      </details>`;
    overlay.classList.remove('hidden');
    const upd = () => {
      const tri = document.getElementById('ml-tipo').value === 'T';
      // the recombination controls only apply to quads
      for (const id of ['ml-blo-box', 'ml-card-box', 'ml-cost-box']) document.getElementById(id).style.opacity = tri ? '0.4' : '';
      for (const id of ['ml-blossom', 'ml-card', 'ml-cost']) document.getElementById(id).disabled = tri;
      const blo = document.getElementById('ml-blossom').checked;
      document.getElementById('ml-card-box').style.opacity = (tri || !blo) ? '0.4' : '';
      document.getElementById('ml-card').disabled = tri || !blo;
      const adp = document.getElementById('ml-adaptive').checked;
      document.getElementById('ml-hmin').disabled = !adp;
    };
    overlay.querySelectorAll('#ml-tipo,#ml-blossom,#ml-adaptive').forEach(e => e.addEventListener('change', upd));
    upd();
    const ok = await new Promise(res => { overlay._resolve = res; overlay._reject = () => res(false); });
    if (!ok) return null;
    const h = +document.getElementById('ml-h').value || 0.5;
    const tri = document.getElementById('ml-tipo').value === 'T';
    const hminPct = Math.max(10, Math.min(100, +document.getElementById('ml-hmin').value || 50));
    return {
      h, tri, t: +document.getElementById('ml-t').value || 0.2,
      behavior: this._behaviorCode(document.getElementById('ml-beh').value),
      blossom: document.getElementById('ml-blossom').checked,
      maxCardinality: document.getElementById('ml-card').checked,
      cost: document.getElementById('ml-cost').value,
      valence: document.getElementById('ml-valence').checked,
      adaptive: document.getElementById('ml-adaptive').checked,
      adaptiveOpts: { hmin: h * hminPct / 100 },
      smooth: Math.max(0, Math.min(20, Math.round(+document.getElementById('ml-smooth').value))),
    };
  }

  // Smooths the area mesh (constrained Laplacian): improves element shape without
  // inverting them; pins borders/supports/loads/member nodes.
  async suavizarMalla() {
    const selAreas = this.viewport.getSelected().filter(s => s.type === 'area').map(s => s.id);
    if (this.model.areas.size === 0) { this.toast('No hay elementos de área en el modelo', 'warn'); return; }
    const str = await this._promptModal('Suavizar malla (calidad)', 'nº de iteraciones (1–20)', '5');
    if (str == null) return;
    const iters = Math.max(1, Math.min(20, Math.round(+str) || 5));
    this.snapshot();
    const rep = smoothAreasInModel(this.model, selAreas, { iters, omega: 0.5 });
    this.viewport.renderModel(this.model);
    this.markDirty();
    const b = rep.before?.minScaledJac, af = rep.after?.minScaledJac;
    this.toast(`${i18n.t('Malla suavizada')} (${iters} iter): ${i18n.t('calidad mín.')} ${b != null ? b.toFixed(3) : '—'} → ${af != null ? af.toFixed(3) : '—'}`, 'ok');
  }

  // Creates a LINK/COUPLING between 2 nodes (1st = master, 2nd = slave).
  async createLinkFromSelection() {
    const ids = this._selNodes();
    if (ids.length !== 2) { this.toast('Seleccione exactamente 2 nodos (1º = maestro, 2º = esclavo)', 'warn'); return; }
    const [master, slave] = ids;
    const str = await this._promptModal('Crear link / coupling',
      'tipo (R=rígido con brazo / C=coupling) y GDL a ligar (ej. R,todos  ó  C,uz). GDL: todos|ux|uy|uz|rx|ry|rz separados por +', 'R,todos');
    if (str == null) return;
    const q = str.split(',').map(s => s.trim());
    const rigid = !(q[0] || 'R').toUpperCase().startsWith('C');
    let dofs;
    const spec = (q[1] || 'todos').toLowerCase();
    if (spec === 'todos' || spec === 'all') dofs = { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 };
    else { dofs = { ux: 0, uy: 0, uz: 0, rx: 0, ry: 0, rz: 0 }; for (const k of spec.split('+')) if (dofs[k] !== undefined) dofs[k] = 1; }
    this.snapshot();
    const lk = this.model.addLink({ master, slave, rigid, dofs });
    this.viewport.refreshLinks?.();
    this.markDirty(); this._updateStats?.();
    this.toast(`${i18n.t('Link')} #${lk.id} ${i18n.t('creado')}: ${i18n.t('nodo')} ${master} → ${slave} (${rigid ? i18n.t('rígido con brazo') : 'coupling'}, ${i18n.t('GDL')} ${spec}). ${i18n.t('Participa en el análisis.')}`, 'ok');
  }

  // INFILL WALL macromodel (#86): 4 corner nodes → 2 compression-only diagonal struts
  // (Mainstone). Auto-detects the frame's column stiffness.
  async createInfillWallFromSelection() {
    const ids = this._selNodes();
    if (ids.length !== 4) { this.toast('Seleccione los 4 nodos de las ESQUINAS del panel', 'warn'); return; }
    if (this.model.mode !== '2D') { this.toast('El muro de relleno (puntal diagonal 2D) requiere un modelo PLANO X–Z', 'warn'); return; }
    // EcIcol = flexural stiffness of the frame's COLUMNS between the corners (vertical).
    let EcIcol = 0, nCol = 0;
    for (const el of this.model.elements.values()) {
      if (!ids.includes(el.n1) || !ids.includes(el.n2)) continue;
      const a = this.model.nodes.get(el.n1), b = this.model.nodes.get(el.n2);
      if (Math.abs(b.z - a.z) > Math.abs(b.x - a.x)) {           // vertical member → column
        const mat = this.model.materials.get(el.matId), sec = this.model.sections.get(el.secId);
        if (mat && sec) { EcIcol += mat.E * sec.Iz; nCol++; }
      }
    }
    EcIcol = nCol ? EcIcol / nCol : 2.5e7 * (0.3 ** 4 / 12);
    const str = await this._promptModal('Muro de relleno — puntal diagonal equivalente',
      'Albañilería: módulo E (MPa), espesor t (m) y rigidez de columna EcIcol (kN·m², auto-detectada). Formato: E, t, EcIcol',
      `3000, 0.20, ${(+EcIcol).toPrecision(4)}`);
    if (str == null) return;
    const p = str.split(',').map(s => parseFloat(s.trim()));
    const Em = (p[0] || 3000) * 1000;          // MPa → kN/m²
    const t = p[1] || 0.2, eci = p[2] || EcIcol;
    this.snapshot();
    const r = insertInfill(this.model, ids, { Em, t, EcIcol: eci });
    if (r.error) { this.toast(i18n.t(r.error), 'error'); return; }
    this.viewport.renderModel(this.model);
    this.markDirty(); this._updateStats?.();
    this.toast(`${i18n.t('Muro de relleno insertado: puntal')} w=${(r.strut.w * 100).toFixed(0)} cm (A=${(r.strut.area * 1e4).toFixed(0)} cm²), ${i18n.t('2 diagonales solo-compresión. Corra Análisis → No lineal para activar una diagonal.')}`, 'ok');
  }

  // GENERIC (#86): inserts ANY registered macromodel from the selection.
  // Reads the descriptor from the registry (`macro_registry.js`), validates nodes/mode,
  // builds the parameter dialog automatically and runs its `expand`. Adding a new
  // macromodel = register its def + (optional) a menu entry that calls this method.
  async insertMacroFromSelection(id) {
    const def = getMacro(id);
    if (!def) { this.toast(`${i18n.t('Macromodelo')} «${id}» ${i18n.t('no registrado')}`, 'warn'); return; }
    if (def.dims && this.model.mode !== def.dims) { this.toast(`«${def.name}» ${i18n.t('requiere un modelo')} ${def.dims}`, 'warn'); return; }
    const ids = this._selNodes();
    if (def.nodes && ids.length !== def.nodes) { this.toast(`${i18n.t('Seleccione')} ${def.nodes} ${i18n.t('nodo(s):')} ${def.nodesHint || ''}`, 'warn'); return; }
    // Parameter dialog auto-generated from def.params.
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = `🧩 ${def.name}`;
    document.getElementById('modal-body').innerHTML = `
      <p style="color:var(--text-muted);font-size:11px;margin:0 0 8px">${(def.desc || '').replace(/[<>&]/g, '')}</p>
      ${def.params.map(p => `<div class="prop-field" style="margin-bottom:6px"><label>${(p.label || p.key).replace(/[<>&]/g, '')}</label><input type="number" id="mc-${p.key}" value="${p.default ?? 0}" step="${p.step ?? 'any'}" ${p.min != null ? `min="${p.min}"` : ''} style="width:100%"></div>`).join('')}`;
    document.getElementById('modal-cancel').style.display = '';
    overlay.classList.remove('hidden');
    const ok = await new Promise(res => { overlay._resolve = res; overlay._reject = () => res(false); });
    if (!ok) return;
    const props = {}; for (const p of def.params) props[p.key] = parseFloat(document.getElementById(`mc-${p.key}`)?.value) || p.default;
    this.snapshot();
    const r = insertMacro(this.model, id, ids, props);
    if (r.error) { this.toast(i18n.t(r.error), 'error'); return; }
    this.viewport.renderModel(this.model);
    this.markDirty(); this._updateStats?.();
    this.toast(`${i18n.t('Macromodelo')} «${def.name}» ${i18n.t('insertado')} (${(r.strutIds || r.elemIds || []).length} ${i18n.t('elemento(s) calibrados')})`, 'ok');
  }

  // ── Bulk actions on NODES ───────────────────────────────────────────────────
  _selNodes() { return this.viewport.getSelected().filter(s => s.type === 'node').map(s => s.id); }
  setSupportSelectedNodes(preset) {
    const ids = this._selNodes(); if (!ids.length) { this.toast('Seleccione nodos', 'warn'); return; }
    const R = preset === 'fixed' ? { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 }
      : preset === 'pinned' ? { ux: 1, uy: 1, uz: 1, rx: 0, ry: 0, rz: 0 }
      : preset === 'roller' ? { ux: 0, uy: 0, uz: 1, rx: 0, ry: 0, rz: 0 }
      : { ux: 0, uy: 0, uz: 0, rx: 0, ry: 0, rz: 0 };
    this.snapshot();
    for (const id of ids) { this.model.updateNode(id, { restraints: { ...R } }); this.viewport.refreshNode(this.model.nodes.get(id)); }
    this.markDirty(); this._updateStats();
    this.toast(`${i18n.t('Apoyo')} "${preset}" ${i18n.t('aplicado a')} ${ids.length} ${i18n.t('nodo(s)')}`, 'ok');
    this.panel.showSelection(this.viewport.getSelected());
  }

  // ── Move / Copy (linear array) the selection ────────────────────────────────
  _selectionNodes() {
    const set = new Set(this._selNodes());
    for (const id of this._selElems()) { const e = this.model.elements.get(id); if (e) { set.add(e.n1); set.add(e.n2); } }
    for (const s of this.viewport.getSelected()) if (s.type === 'area') { const a = this.model.areas.get(s.id); if (a) a.nodes.forEach(n => set.add(n)); }
    return set;
  }
  moveSelection(dx, dy, dz) {
    dx = +dx || 0; dy = +dy || 0; dz = +dz || 0;
    if (!(dx || dy || dz)) { this.toast('Indique un desplazamiento (dX, dY o dZ)', 'warn'); return; }
    const ids = this._selectionNodes(); if (!ids.size) { this.toast('Seleccione nodos o elementos para mover', 'warn'); return; }
    this.snapshot();
    for (const id of ids) { const n = this.model.nodes.get(id); this.model.updateNode(id, { x: n.x + dx, y: n.y + dy, z: n.z + dz }); }
    this.viewport.renderModel(this.model); this.refreshLoads(); this.markDirty(); this._updateStats();
    this.toast(`${ids.size} ${i18n.t('nodo(s) movidos')} (${dx}, ${dy}, ${dz})`, 'ok');
  }
  copySelection(dx, dy, dz, reps, dx2 = 0, dy2 = 0, dz2 = 0, reps2 = 0) {
    dx = +dx || 0; dy = +dy || 0; dz = +dz || 0; reps = Math.max(1, Math.round(reps || 1));
    dx2 = +dx2 || 0; dy2 = +dy2 || 0; dz2 = +dz2 || 0; reps2 = Math.max(0, Math.round(reps2 || 0));
    if (!(dx || dy || dz)) { this.toast('Indique un desplazamiento (dX, dY o dZ) ≠ 0', 'warn'); return; }
    const elems = this._selElems().map(id => this.model.elements.get(id)).filter(Boolean);
    const nodeIds = this._selectionNodes(); if (!nodeIds.size) { this.toast('Seleccione nodos o elementos para copiar', 'warn'); return; }
    this.snapshot();
    const rk = (v) => Math.round(v * 1e4) / 1e4, key = (x, y, z) => `${rk(x)}|${rk(y)}|${rk(z)}`;
    const coordIdx = new Map(); for (const n of this.model.nodes.values()) coordIdx.set(key(n.x, n.y, n.z), n.id);
    const getOrAdd = (x, y, z, src) => {
      const k = key(x, y, z); if (coordIdx.has(k)) return coordIdx.get(k);
      const nn = this.model.addNode(rk(x), rk(y), rk(z), src ? { ...src.restraints } : {});
      if (src) this.model.updateNode(nn.id, { springs: { ...src.springs } });
      coordIdx.set(k, nn.id); return nn.id;
    };
    const pares = new Set(); for (const e of this.model.elements.values()) pares.add(`${Math.min(e.n1, e.n2)}-${Math.max(e.n1, e.n2)}`);
    // One copy of the selection with a given node mapping (offset or reflection).
    const copiarInstancia = (mapCoord) => {
      const map = new Map();
      for (const nid of nodeIds) { const n = this.model.nodes.get(nid); const p = mapCoord(n); map.set(nid, getOrAdd(p.x, p.y, p.z, n)); }
      let k = 0;
      for (const e of elems) {
        const a = map.get(e.n1), b = map.get(e.n2); if (a == null || b == null || a === b) continue;
        const pk = `${Math.min(a, b)}-${Math.max(a, b)}`; if (pares.has(pk)) continue; pares.add(pk);
        const ne = this.model.addElement(a, b, e.matId, e.secId);
        if (!ne) continue;
        // Element properties: releases, cable / prestress.
        const upd = {};
        if (e.releases && e.releases.some(x => x)) upd.releases = [...e.releases];
        if (e.cable) upd.cable = true;
        if (e.compressionOnly) upd.compressionOnly = true;
        if (e.L0factor != null && e.L0factor !== 1) upd.L0factor = e.L0factor;
        if (Object.keys(upd).length) this.model.updateElement(ne.id, upd);
        // Element loads (all dist/temp from all cases) → copy.
        for (const lc of this.model.loadCases.values())
          for (const ld of (lc.loads || []))
            if (ld.elemId === e.id && (ld.type === 'dist' || ld.type === 'temp'))
              lc.loads.push({ ...ld, elemId: ne.id });
        // Group membership (session state).
        if (this._grupos) for (const set of this._grupos.values()) if (set.has(e.id)) set.add(ne.id);
        k++;
      }
      return k;
    };
    let nEl = 0;
    // (reps+1)×(reps2+1) grid except the original (0,0); reps2=0 → linear array
    for (let i = 0; i <= reps; i++) for (let j = 0; j <= reps2; j++) {
      if (i === 0 && j === 0) continue;
      const ox = dx * i + dx2 * j, oy = dy * i + dy2 * j, oz = dz * i + dz2 * j;
      nEl += copiarInstancia((n) => ({ x: n.x + ox, y: n.y + oy, z: n.z + oz }));
    }
    this._afterCopia(nEl);
    const total = reps2 > 0 ? `${reps}×${reps2}` : `×${reps}`;
    this.toast(`${i18n.t('Copiado')} ${total}: +${nEl} ${i18n.t('elemento(s)')}`, 'ok');
  }

  _afterCopia(nEl) {
    this.viewport.renderModel(this.model); this.refreshLoads(); this.viewport.clearSelection(); this.panel.showNothing(); this.markDirty(); this._updateStats();
  }

  // Mirror (reflect) the selection about the plane perpendicular to 'eje' at 'coord'.
  mirrorSelection(eje, coord) {
    coord = +coord || 0; eje = String(eje || 'X').toUpperCase();
    const elems = this._selElems().map(id => this.model.elements.get(id)).filter(Boolean);
    const nodeIds = this._selectionNodes(); if (!nodeIds.size) { this.toast('Seleccione nodos o elementos para espejar', 'warn'); return; }
    this.snapshot();
    const rk = (v) => Math.round(v * 1e4) / 1e4, key = (x, y, z) => `${rk(x)}|${rk(y)}|${rk(z)}`;
    const coordIdx = new Map(); for (const n of this.model.nodes.values()) coordIdx.set(key(n.x, n.y, n.z), n.id);
    const getOrAdd = (x, y, z, src) => {
      const k = key(x, y, z); if (coordIdx.has(k)) return coordIdx.get(k);
      const nn = this.model.addNode(rk(x), rk(y), rk(z), src ? { ...src.restraints } : {});
      if (src) this.model.updateNode(nn.id, { springs: { ...src.springs } });
      coordIdx.set(k, nn.id); return nn.id;
    };
    const pares = new Set(); for (const e of this.model.elements.values()) pares.add(`${Math.min(e.n1, e.n2)}-${Math.max(e.n1, e.n2)}`);
    const refl = (n) => ({ x: eje === 'X' ? 2 * coord - n.x : n.x, y: eje === 'Y' ? 2 * coord - n.y : n.y, z: eje === 'Z' ? 2 * coord - n.z : n.z });
    const map = new Map();
    for (const nid of nodeIds) { const n = this.model.nodes.get(nid); const p = refl(n); map.set(nid, getOrAdd(p.x, p.y, p.z, n)); }
    let nEl = 0;
    for (const e of elems) {
      const a = map.get(e.n1), b = map.get(e.n2); if (a == null || b == null || a === b) continue;
      const pk = `${Math.min(a, b)}-${Math.max(a, b)}`; if (pares.has(pk)) continue; pares.add(pk);
      const ne = this.model.addElement(a, b, e.matId, e.secId);
      if (ne && e.releases && e.releases.some(x => x)) this.model.updateElement(ne.id, { releases: [...e.releases] });
      if (ne) nEl++;
    }
    this._afterCopia(nEl);
    this.toast(`${i18n.t('Espejado en')} ${eje}=${coord}: +${nEl} ${i18n.t('elemento(s)')}`, 'ok');
  }

  // ── Bulk NODAL load on the selected nodes ───────────────────────────────────
  // F = [Fx,Fy,Fz,Mx,My,Mz] applied identically to all; F=null clears.
  setNodalLoadSelected(F, lcId) {
    const ids = this._selNodes(); if (!ids.length) { this.toast('Seleccione nodos', 'warn'); return; }
    const lc = this.model.loadCases.get(+lcId) || this.model.loadCases.get(this._activeLcId) || [...this.model.loadCases.values()][0];
    if (!lc) { this.toast('No hay caso de carga', 'warn'); return; }
    if (lc.type === 'spectrum') { this.toast('El caso espectral no admite cargas nodales', 'warn'); return; }
    this.snapshot();
    const set = new Set(ids);
    lc.loads = (lc.loads || []).filter(l => !(l.type === 'nodal' && set.has(l.nodeId)));   // replaces the existing one
    const hasF = F && F.some(v => v && Number.isFinite(v));
    if (hasF) for (const id of ids) lc.loads.push({ type: 'nodal', nodeId: id, F: F.map(v => +v || 0) });
    this.refreshLoads(); this.markDirty(); this._updateStats();
    this.toast(hasF ? `Carga nodal en ${ids.length} nodo(s) · ${lc.name}` : `Cargas nodales quitadas de ${ids.length} nodo(s) · ${lc.name}`, 'ok');
    this.viewport.selectNodes?.(ids); this.panel.showSelection(this.viewport.getSelected());
  }

  // ── Bulk distributed load on the selected elements ──────────────────────────
  setDistLoadSelected(w, dir, lcId) {
    const ids = this._selElems(); if (!ids.length) { this.toast('Seleccione elementos', 'warn'); return; }
    const lc = this.model.loadCases.get(+lcId) || this.model.loadCases.get(this._activeLcId) || [...this.model.loadCases.values()][0];
    if (!lc) { this.toast('No hay caso de carga', 'warn'); return; }
    if (lc.type === 'spectrum') { this.toast('El caso espectral no admite cargas distribuidas', 'warn'); return; }
    w = +w; dir = dir || 'gravity';
    this.snapshot();
    const set = new Set(ids);
    lc.loads = (lc.loads || []).filter(l => !(l.type === 'dist' && set.has(l.elemId)));   // replaces the existing one
    if (w && Number.isFinite(w)) for (const id of ids) lc.loads.push({ type: 'dist', elemId: id, dir, w });
    this.refreshLoads(); this.markDirty(); this._updateStats();
    this.toast(w ? `Carga ${w} kN/m (${dir}) en ${ids.length} elem. · ${lc.name}` : `Cargas distribuidas quitadas de ${ids.length} elem. · ${lc.name}`, 'ok');
    this._reselect(ids);
  }

  // ── TEMPERATURE load (uniform ΔT) on the selected elements ──────────────────
  setTempLoadSelected(dT, lcId) {
    const ids = this._selElems(); if (!ids.length) { this.toast('Seleccione elementos', 'warn'); return; }
    const lc = this.model.loadCases.get(+lcId) || this.model.loadCases.get(this._activeLcId) || [...this.model.loadCases.values()][0];
    if (!lc) { this.toast('No hay caso de carga', 'warn'); return; }
    if (lc.type === 'spectrum') { this.toast('El caso espectral no admite cargas de temperatura', 'warn'); return; }
    dT = +dT;
    this.snapshot();
    const set = new Set(ids);
    lc.loads = (lc.loads || []).filter(l => !(l.type === 'temp' && set.has(l.elemId)));   // replaces the previous one
    if (dT && Number.isFinite(dT)) for (const id of ids) lc.loads.push({ type: 'temp', elemId: id, dT });
    this.refreshLoads(); this.markDirty(); this._updateStats();
    this.toast(dT ? `ΔT = ${dT} °C en ${ids.length} elem. · ${lc.name}` : `Cargas de temperatura quitadas de ${ids.length} elem. · ${lc.name}`, 'ok');
    this._reselect(ids);
  }

  // Thermal load of an AREA (#57): temperature per face — dTtop = +z face (red),
  // dTbot = −z face (blue), like Abaqus. Mean → membrane, gradient → bending.
  setTempLoadArea(areaId, dTtop, dTbot, lcId) {
    const area = this.model.areas.get(+areaId); if (!area) { this.toast('Área no encontrada', 'warn'); return; }
    const lc = this.model.loadCases.get(+lcId) || this.model.loadCases.get(this._activeLcId) || [...this.model.loadCases.values()][0];
    if (!lc) { this.toast('No hay caso de carga', 'warn'); return; }
    if (lc.type === 'spectrum') { this.toast('El caso espectral no admite cargas de temperatura', 'warn'); return; }
    dTtop = +dTtop || 0; dTbot = +dTbot || 0;
    this.snapshot();
    lc.loads = (lc.loads || []).filter(l => !(l.type === 'temp' && l.areaId === +areaId));   // replaces the previous one
    if (dTtop || dTbot) lc.loads.push({ type: 'temp', areaId: +areaId, dTtop, dTbot });
    this.refreshLoads(); this.markDirty(); this._updateStats();
    this.toast((dTtop || dTbot) ? `ΔT cara roja ${dTtop}° / azul ${dTbot}° en área #${areaId} · ${lc.name}` : `ΔT quitada del área #${areaId} · ${lc.name}`, 'ok');
  }

  async discretizeAllDialog() {
    if (this.model.elements.size === 0) { this.toast('No hay elementos', 'warn'); return; }
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = i18n.t('Discretizar Todos los Elementos');
    document.getElementById('modal-body').innerHTML = `
      <div class="prop-row">
        <div class="prop-field"><label>Modo</label>
          <select id="disc-mode">
            <option value="parts">Nº de partes por elemento</option>
            <option value="length">Longitud de tramo (m)</option>
          </select>
        </div>
        <div class="prop-field"><label>Valor</label>
          <input type="number" id="disc-val" value="5" min="0.01" step="1" style="width:90px">
        </div>
      </div>
      <p style="color:var(--text-muted);font-size:11px;margin-top:8px">
        Ej.: modo longitud con 0.25 divide cada elemento en tramos de ≈25 cm.<br>
        Para revertir use Deshacer (Ctrl+Z) o seleccione tramos y Editar → Unir.
      </p>`;
    document.getElementById('modal-cancel').style.display = '';
    overlay.classList.remove('hidden');
    const ok = await new Promise(res => {
      overlay._resolve = res;
      overlay._reject  = () => res(false);
    });
    if (!ok) return;
    const mode = document.getElementById('disc-mode')?.value;
    const val  = parseFloat(document.getElementById('disc-val')?.value);
    if (!(val > 0)) return;
    this.snapshot();
    const before = this.model.elements.size;
    discretizeAll(this.model, mode === 'length'
      ? { length: val }
      : { parts: Math.max(2, Math.round(val)) });
    this.viewport.renderModel(this.model);
    this.refreshLoads();
    this.panel.showNothing();
    this.markDirty();
    this._updateStats();
    this.toast(`${i18n.t('Discretizado:')} ${before} → ${this.model.elements.size} ${i18n.t('elementos')}`, 'ok');
  }

  // ── Matrix viewer (educational) ──────────────────────────────────────────────
  _fmtMtx(v) {
    if (v === 0) return '0';
    const a = Math.abs(v);
    return (a >= 1e5 || a < 1e-3) ? v.toExponential(2) : String(+v.toPrecision(5));
  }

  _matrixHTML(M, labels, title, highlightZeros = true) {
    const n = M.length;
    let h = `<div class="mtx-title">${title}</div><div class="mtx-wrap"><table class="mtx"><tr><th></th>`;
    for (let j = 0; j < n; j++) h += `<th>${labels[j]}</th>`;
    h += '</tr>';
    for (let i = 0; i < n; i++) {
      h += `<tr><th>${labels[i]}</th>`;
      for (let j = 0; j < n; j++) {
        const v = M[i][j];
        const cls = (highlightZeros && Math.abs(v) < 1e-12) ? ' class="mz"' : '';
        h += `<td${cls}>${this._fmtMtx(v)}</td>`;
      }
      h += '</tr>';
    }
    return h + '</table></div>';
  }

  _matrixCSV(M, labels, title) {
    const lines = [`# ${title}`, ',' + labels.join(',')];
    M.forEach((row, i) => lines.push(labels[i] + ',' + row.map(v => v.toExponential(6)).join(',')));
    return lines.join('\r\n');
  }

  showElementMatrices(elemId) {
    const elem = this.model.elements.get(elemId);
    if (!elem) return;
    const n1 = this.model.nodes.get(elem.n1), n2 = this.model.nodes.get(elem.n2);
    const mat = this.model.materials.get(elem.matId), sec = this.model.sections.get(elem.secId);
    if (!n1 || !n2 || !mat || !sec) { this.toast('Elemento incompleto', 'warn'); return; }

    const { ex, ey, ez, L } = localAxes(n1, n2);
    const Ke = stiffnessMatrix(L, mat, sec);
    const Me = massMatrix(L, mat, sec);
    const T  = transformMatrix(ex, ey, ez);
    const hasRel = elem.releases?.some(r => r);
    const KeC = hasRel ? applyReleases(Ke, elem.releases.map(r => r !== 0)) : null;
    const KG  = globalStiffness(KeC ?? Ke, T);

    const L12 = ['u₁','v₁','w₁','θx₁','θy₁','θz₁','u₂','v₂','w₂','θx₂','θy₂','θz₂'];
    const fx = v => +v.toFixed(4);
    let html = `
      <p style="font-size:11px;color:var(--text-muted);margin-bottom:8px">
        Elemento #${elem.id} (nodos ${elem.n1}→${elem.n2}) · L = ${+L.toFixed(4)} m ·
        ejes locales: x=[${ex.map(fx)}], y=[${ey.map(fx)}], z=[${ez.map(fx)}]<br>
        Orden de GDL locales: [u, v, w, θx, θy, θz] por nodo. Unidades: kN, m, ton.
      </p>`;
    html += this._matrixHTML(Ke, L12, 'Ke — rigidez LOCAL (12×12)');
    if (KeC) html += this._matrixHTML(KeC, L12, 'Ke* — rigidez local CONDENSADA por liberaciones (filas/columnas liberadas = 0)');
    html += this._matrixHTML(T, L12, 'T — matriz de transformación local ← global');
    html += this._matrixHTML(KG, L12, 'K = Tᵀ·Ke·T — rigidez en coordenadas GLOBALES');
    html += this._matrixHTML(Me, L12, 'Me — masa consistente LOCAL (12×12)');
    html += `<button class="btn-secondary" id="mtx-csv" style="width:100%;margin-top:8px">⬇ Exportar matrices a CSV</button>`;

    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-box').classList.add('modal-wide');
    document.getElementById('modal-title').textContent = `${i18n.t('Matrices del Elemento')} #${elem.id}`;
    document.getElementById('modal-body').innerHTML = html;
    document.getElementById('modal-cancel').style.display = 'none';
    overlay.classList.remove('hidden');
    overlay._resolve = () => {};
    overlay._reject  = () => {};

    document.getElementById('mtx-csv')?.addEventListener('click', () => {
      const csv = [
        this._matrixCSV(Ke, L12, `Ke local — Elemento ${elem.id}`),
        KeC ? this._matrixCSV(KeC, L12, 'Ke condensada (liberaciones)') : '',
        this._matrixCSV(T, L12, 'T transformación'),
        this._matrixCSV(KG, L12, 'K global del elemento'),
        this._matrixCSV(Me, L12, 'Me masa local'),
      ].filter(Boolean).join('\r\n#\r\n');
      this._downloadText(csv, `matrices_elemento_${elem.id}.csv`, 'text/csv;charset=utf-8');
    });
  }

  showGlobalMatrices() {
    if (this.model.nodes.size === 0) { this.toast('Modelo vacío', 'warn'); return; }
    const nodeIndex = buildNodeIndex(this.model);
    const { K, M, nDOF } = assembleK(this.model, nodeIndex);
    const ids = [...this.model.nodes.keys()];
    const sub = ['ux','uy','uz','rx','ry','rz'];
    const labels = [];
    for (const id of ids) for (const s of sub) labels.push(`N${id}.${s}`);

    const toRows = (flat) => Array.from({ length: nDOF }, (_, i) =>
      Array.from({ length: nDOF }, (_, j) => flat[i * nDOF + j]));

    const MAX_SHOW = 120;   // up to 20 nodes on screen; always exportable to CSV
    let html = `<p style="font-size:11px;color:var(--text-muted);margin-bottom:8px">
      ${this.model.nodes.size} nodos × 6 GDL = <b>${nDOF} GDL</b> (orden: por nodo, [ux uy uz rx ry rz] globales).
      Incluye liberaciones condensadas, resortes y restricciones de diafragma (penalty).</p>`;
    if (nDOF <= MAX_SHOW) {
      html += this._matrixHTML(toRows(K), labels, `K — rigidez GLOBAL (${nDOF}×${nDOF})`);
      html += this._matrixHTML(toRows(M), labels, `M — masa GLOBAL (${nDOF}×${nDOF})`);
    } else {
      html += `<p style="color:var(--warn);font-size:12px">Matriz demasiado grande para mostrar
        (límite ${MAX_SHOW} GDL) — use la exportación CSV.</p>`;
    }
    html += `<button class="btn-secondary" id="gmtx-csv" style="width:100%;margin-top:8px">⬇ Exportar K y M globales a CSV</button>`;

    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-box').classList.add('modal-wide');
    document.getElementById('modal-title').textContent = i18n.t('Matrices Globales K y M');
    document.getElementById('modal-body').innerHTML = html;
    document.getElementById('modal-cancel').style.display = 'none';
    overlay.classList.remove('hidden');
    overlay._resolve = () => {};
    overlay._reject  = () => {};

    document.getElementById('gmtx-csv')?.addEventListener('click', () => {
      const csv = this._matrixCSV(toRows(K), labels, `K global (${nDOF} GDL)`) +
        '\r\n#\r\n' + this._matrixCSV(toRows(M), labels, `M global (${nDOF} GDL)`);
      this._downloadText(csv, 'matrices_globales.csv', 'text/csv;charset=utf-8');
    });
  }

  // ── Help (F1) ──────────────────────────────────────────────────────────────────
  _initHelp() {
    const overlay = document.getElementById('help-overlay');
    if (!overlay) return;
    document.getElementById('help-close')?.addEventListener('click', () => this.closeHelp());
    overlay.addEventListener('click', e => { if (e.target === overlay) this.closeHelp(); });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !overlay.classList.contains('hidden')) this.closeHelp();
    });
    overlay.querySelectorAll('.help-tab').forEach(btn =>
      btn.addEventListener('click', () => this._switchHelpSec(btn.dataset.hsec)));
  }

  _switchHelpSec(sec) {
    document.querySelectorAll('.help-tab').forEach(b =>
      b.classList.toggle('active', b.dataset.hsec === sec));
    document.querySelectorAll('.help-sec').forEach(s =>
      s.classList.toggle('active', s.id === 'hsec-' + sec));
  }

  openHelp(sec = 'guia') {
    document.getElementById('help-overlay')?.classList.remove('hidden');
    this._switchHelpSec(sec);
    this._renderHelpExamples();
  }

  closeHelp() {
    document.getElementById('help-overlay')?.classList.add('hidden');
  }

  // List of guided examples: reads examples/index.json (maintained by the instructor)
  async _renderHelpExamples() {
    const box = document.getElementById('help-examples-list');
    if (!box) return;
    try {
      const r = await fetch('examples/index.json', { cache: 'no-store' });
      if (!r.ok) throw new Error('sin index');
      const list = await r.json();
      if (!Array.isArray(list) || !list.length) throw new Error('vacío');
      box.innerHTML = '';
      for (const ex of list) {
        const card = document.createElement('div');
        card.className = 'help-excard';
        card.innerHTML = `
          <div class="help-extitle">${esc(i18n.t(ex.title || ex.file))}</div>
          <div class="help-exdesc">${esc(i18n.t(ex.description || ''))}</div>
          ${ex.note ? `<div class="help-exobs">👁 ${esc(i18n.t(ex.note))}</div>` : ''}
          <button class="btn-add help-exopen">${i18n.t('Abrir ejemplo')}</button>`;
        card.querySelector('.help-exopen').addEventListener('click', async () => {
          if (this._dirty) {
            const ok = await this._confirm('¿Descartar los cambios no guardados y abrir el ejemplo?');
            if (!ok) return;
          }
          try {
            const fr = await fetch('examples/' + ex.file, { cache: 'no-store' });
            if (!fr.ok) throw new Error('archivo no encontrado');
            this._loadJSON(await fr.text(), ex.file);
            this.closeHelp();
            this.toast(`${i18n.t('Ejemplo')} "${i18n.t(ex.title || ex.file)}" ${i18n.t('cargado')}`, 'ok');
          } catch (e) {
            this.toast(`${i18n.t('No se pudo abrir:')} ${e.message}`, 'error');
          }
        });
        box.appendChild(card);
      }
    } catch {
      box.innerHTML = `<p class="help-note">${i18n.t('Aún no hay ejemplos publicados. Puede agregarlos siguiendo las instrucciones de más abajo — aparecerán aquí automáticamente.')}</p>`;
    }
  }

  // ── FBD: free-body diagram of the element (educational) ─────────────────────
  // Draws the end forces acting ON the element (local coords) in each bending plane,
  // plus the equilibrium check ΣF=0, ΣM=0.
  _dclPlaneSVG({ titulo, V1, V2, M1, M2, q, L, lblV, lblM, lblQ }) {
    const W = 640, H = 210, x1 = 120, x2 = 520, yb = 105;
    const fmt = v => Math.abs(v) >= 1000 ? v.toFixed(0) : String(+v.toPrecision(4));
    const CV = '#38bdf8', CM = '#ce93d8', CQ = '#fbbf24';
    let s = `<svg viewBox="0 0 ${W} ${H}" class="dcl-svg">`;
    s += `<text x="12" y="20" class="dcl-title">${titulo}</text>`;
    // beam + nodes
    s += `<rect x="${x1}" y="${yb - 6}" width="${x2 - x1}" height="12" rx="3" class="dcl-beam"/>`;
    s += `<circle cx="${x1}" cy="${yb}" r="7" class="dcl-node"/><circle cx="${x2}" cy="${yb}" r="7" class="dcl-node"/>`;
    s += `<text x="${x1}" y="${yb + 30}" class="dcl-end">1</text><text x="${x2}" y="${yb + 30}" class="dcl-end">2</text>`;
    s += `<text x="${(x1 + x2) / 2}" y="${yb + 32}" class="dcl-len">L = ${fmt(L)} m</text>`;

    // vertical shear arrow: positive = +y local = UPWARD on screen
    const vArrow = (x, val, name) => {
      if (Math.abs(val) < 1e-9) return '';
      const up = val > 0, len = 42;
      const yTip  = up ? yb - 12 : yb + 12;
      const yTail = up ? yTip + len : yTip - len;
      const hd = up ? -8 : 8;
      return `<line x1="${x}" y1="${yTail}" x2="${x}" y2="${yTip + hd}" stroke="${CV}" stroke-width="2.4"/>` +
             `<polygon points="${x - 5},${yTip + hd} ${x + 5},${yTip + hd} ${x},${yTip}" fill="${CV}"/>` +
             `<text x="${x}" y="${up ? yTail + 16 : yTail - 8}" class="dcl-val" fill="${CV}">${name}=${fmt(val)}</text>`;
    };
    // moment arc: positive = counterclockwise (right-hand rule)
    const mArc = (x, val, name) => {
      if (Math.abs(val) < 1e-9) return '';
      const r = 19, ccw = val > 0;
      const sweep = ccw ? 0 : 1;
      const p = a => [x + r * Math.cos(a * Math.PI / 180), yb - r * Math.sin(a * Math.PI / 180)];
      const [sx, sy] = p(ccw ? -50 : 230), [tx2, ty2] = p(ccw ? 230 : -50);
      return `<path d="M ${sx} ${sy} A ${r} ${r} 0 1 ${sweep} ${tx2} ${ty2}" fill="none" stroke="${CM}" stroke-width="2.2"/>` +
             `<circle cx="${tx2}" cy="${ty2}" r="3.4" fill="${CM}"/>` +
             `<text x="${x}" y="${yb - r - 12}" class="dcl-val" fill="${CM}">${name}=${fmt(val)}</text>`;
    };
    // distributed load (positive = +y local = ↑)
    let qs = '';
    if (Math.abs(q) > 1e-9) {
      const up = q > 0, n = 9, yA = up ? yb + 50 : yb - 50, yB = up ? yb + 12 : yb - 12;
      const hd = up ? 6 : -6;
      for (let i = 1; i < n; i++) {
        const x = x1 + 30 + (x2 - x1 - 60) * i / n;
        qs += `<line x1="${x}" y1="${yA}" x2="${x}" y2="${yB + hd}" stroke="${CQ}" stroke-width="1.6"/>` +
              `<polygon points="${x - 4},${yB + hd} ${x + 4},${yB + hd} ${x},${yB}" fill="${CQ}"/>`;
      }
      qs += `<line x1="${x1 + 30}" y1="${yA}" x2="${x2 - 30}" y2="${yA}" stroke="${CQ}" stroke-width="1.6"/>`;
      qs += `<text x="${(x1 + x2) / 2}" y="${up ? yA + 16 : yA - 8}" class="dcl-val" fill="${CQ}">${lblQ}=${fmt(q)} kN/m</text>`;
    }
    // V₂/M₂ with the results convention: ef.Vy2 = internal shear at 2; the force ON
    // the element at end 2 is −Vy2 (same for the moment). Passed already signed.
    s += qs + vArrow(x1 - 30, V1, name1(lblV)) + vArrow(x2 + 30, V2, name2(lblV));
    s += mArc(x1, M1, name1(lblM)) + mArc(x2, M2, name2(lblM));
    return s + '</svg>';
    function name1(b) { return b + '₁'; }
    function name2(b) { return b + '₂'; }
  }

  showElementDCL(elemId) {
    if (!this._results) { this.toast('Ejecute el análisis primero (F5) para ver el DCL', 'warn'); return; }
    const ef = this._results.getElemForces(elemId);
    if (!ef) { this.toast('Sin resultados para este elemento', 'warn'); return; }
    const elem = this.model.elements.get(elemId);
    const { L, qy, qz } = ef;
    const fmt = v => Math.abs(v) >= 1000 ? v.toFixed(0) : String(+v.toPrecision(4));

    // Vector fe = forces ON the element (local), reconstructed from the results
    const fe1 = ef.Vy1, fe7 = -ef.Vy2, fe5 = ef.Mz1, fe11 = -ef.Mz2;
    const fe2 = ef.Vz1, fe8 = -ef.Vz2, fe4 = ef.My1, fe10 = -ef.My2;
    const eq = [
      ['ΣFy (plano x–y)',  fe1 + fe7 + (qy || 0) * L],
      ['ΣMz respecto a 1', fe5 + fe11 + fe7 * L + (qy || 0) * L * L / 2],
      ['ΣFz (plano x–z)',  fe2 + fe8 + (qz || 0) * L],
      ['ΣMy respecto a 1', fe4 + fe10 - fe8 * L - (qz || 0) * L * L / 2],
    ];
    const scale = Math.max(1, ...[fe1, fe5, fe2, fe4].map(Math.abs));
    const eqHTML = eq.map(([n, v]) => {
      const ok = Math.abs(v) < 1e-6 * scale + 1e-9;
      return `<tr><td>${n}</td><td style="text-align:right;font-family:var(--font-mono)">${v.toExponential(2)}</td>
        <td style="color:${ok ? 'var(--success)' : 'var(--danger)'};font-weight:700">${ok ? '✓ ≈ 0' : '✗ ≠ 0'}</td></tr>`;
    }).join('');

    const axial = ef.N > 1e-9 ? `tracción, +${fmt(ef.N)} kN` :
                  ef.N < -1e-9 ? `compresión, ${fmt(ef.N)} kN` : '≈ 0';

    let html = `
      <p style="font-size:11px;color:var(--text-muted);margin-bottom:6px">
        Fuerzas que actúan <b>sobre el elemento</b>, en coordenadas <b>locales</b>.
        Corte positivo = +y/+z local (↑ en el dibujo) · momento positivo = antihorario ⟲.<br>
        <b style="color:var(--success)">N = ${fmt(ef.N)} kN (${axial})</b> &nbsp;·&nbsp;
        <b>T = ${fmt(ef.T)} kN·m (torsión)</b></p>`;
    html += this._dclPlaneSVG({ titulo: 'Plano local x–y · corte Vy y momento Mz',
      V1: ef.Vy1, V2: -ef.Vy2, M1: ef.Mz1, M2: -ef.Mz2, q: qy || 0, L, lblV: 'Vy', lblM: 'Mz', lblQ: 'qy' });
    html += this._dclPlaneSVG({ titulo: 'Plano local x–z · corte Vz y momento My',
      V1: ef.Vz1, V2: -ef.Vz2, M1: ef.My1, M2: -ef.My2, q: qz || 0, L, lblV: 'Vz', lblM: 'My', lblQ: 'qz' });
    html += `<div class="mtx-title">Verificación de equilibrio (ΣF = 0 · ΣM = 0)</div>
      <table class="dcl-eq"><tr><th>Ecuación</th><th>Residuo</th><th>Estado</th></tr>${eqHTML}</table>`;

    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-box').classList.add('modal-wide');
    document.getElementById('modal-title').textContent =
      `DCL — Elemento #${elemId} (nodos ${elem?.n1 ?? '?'}→${elem?.n2 ?? '?'})`;
    document.getElementById('modal-body').innerHTML = html;
    document.getElementById('modal-cancel').style.display = 'none';
    overlay.classList.remove('hidden');
    overlay._resolve = () => {};
    overlay._reject  = () => {};
  }

  // ── Grid axes (SAP/ETABS style) ───────────────────────────────────────────────
  // Syntax: comma-separated list; each term is a coordinate or "n@d" (n spans of
  // length d from the last coordinate). E.g. "0, 3@5" → 0,5,10,15
  _parseGridSpec(str) {
    const coords = [];
    let cur = null;
    for (const tok of String(str || '').split(',').map(s => s.trim()).filter(Boolean)) {
      const m = tok.match(/^(\d+)\s*@\s*([\d.]+)$/);
      if (m) {
        const n = +m[1], d = +m[2];
        if (cur === null) { cur = 0; coords.push(0); }
        for (let i = 0; i < n; i++) { cur += d; coords.push(+cur.toFixed(6)); }
      } else {
        const v = parseFloat(tok);
        if (!isNaN(v)) { coords.push(v); cur = v; }
      }
    }
    return [...new Set(coords)].sort((a, b) => a - b);
  }

  async defineGridsDialog() {
    const g = this.model.grids || { x: [], y: [], z: [] };
    const join = arr => (arr || []).join(', ');
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = i18n.t('Definir Ejes de Grilla');
    document.getElementById('modal-body').innerHTML = `
      <p style="font-size:11px;color:var(--text-muted);margin-bottom:8px">
        Coordenadas separadas por coma, o <b>n@d</b> = n tramos de d metros.<br>
        Ej.: <code>0, 3@5</code> → ejes en 0, 5, 10, 15. Vacío = sin ejes en esa dirección.<br>
        Al insertar nodos, el cursor se ajusta a los ejes cercanos.
      </p>
      <div class="prop-field"><label>Ejes X (A, B, C…) — dirección X global</label>
        <input type="text" id="gr-x" value="${join(g.x)}" placeholder="0, 3@5" style="width:100%"></div>
      <div class="prop-field" style="margin-top:6px"><label>Ejes Y (1, 2, 3…) — dirección Y global</label>
        <input type="text" id="gr-y" value="${join(g.y)}" placeholder="0, 2@6" style="width:100%"></div>
      <div class="prop-field" style="margin-top:6px"><label>Niveles Z (pisos)</label>
        <input type="text" id="gr-z" value="${join(g.z)}" placeholder="0, 4@3" style="width:100%"></div>`;
    document.getElementById('modal-cancel').style.display = '';
    overlay.classList.remove('hidden');
    const ok = await new Promise(res => {
      overlay._resolve = res;
      overlay._reject  = () => res(false);
    });
    if (!ok) return;
    this.snapshot();
    this.model.grids = {
      x: this._parseGridSpec(document.getElementById('gr-x')?.value),
      y: this._parseGridSpec(document.getElementById('gr-y')?.value),
      z: this._parseGridSpec(document.getElementById('gr-z')?.value),
    };
    this.markDirty();
    this.viewport.refreshGridAxes();
    this.viewport.refreshElevationOptions();   // new axes → available elevations
    const n = this.model.grids.x.length + this.model.grids.y.length + this.model.grids.z.length;
    this.toast(n ? `Ejes definidos: ${this.model.grids.x.length}×X, ${this.model.grids.y.length}×Y, ${this.model.grids.z.length} niveles` : 'Ejes eliminados', 'ok');
  }

  // ── Undo / Redo ────────────────────────────────────────────────────────────
  undo() {
    const prev = this.undoStack.undo(this.serializer.toJSON(this.model));
    if (!prev) { this.toast('Nada que deshacer', 'warn'); return; }
    this.model = this.serializer.fromJSON(prev);
    this.viewport.renderModel(this.model);
    this.panel.showNothing();
    this.panel.refresh(this.model);
    this._updateStats();
    this.toast('Deshecho', '');
  }

  redo() {
    const next = this.undoStack.redo(this.serializer.toJSON(this.model));
    if (!next) { this.toast('Nada que rehacer', 'warn'); return; }
    this.model = this.serializer.fromJSON(next);
    this.viewport.renderModel(this.model);
    this.panel.showNothing();
    this.panel.refresh(this.model);
    this._updateStats();
    this.toast('Rehecho', '');
  }

  // ── Diaphragm CRUD ────────────────────────────────────────────────────────
  autoDetectDiaphragms() {
    if (this.model.nodes.size < 2) {
      this.toast('El modelo no tiene suficientes nodos', 'warn'); return;
    }
    this.snapshot();
    const { diaphragms: created, nodes: newNodes } = autoDetectDiaphragms(this.model);
    if (created.length === 0) {
      this.toast('No se encontraron nuevos pisos (nodos en el mismo nivel Z)', 'warn');
    } else {
      // Add any new virtual master nodes (CR nodes) to the viewport
      for (const n of newNodes) this.viewport.addNodeMesh(n);
      this.viewport.refreshDiaphragms();
      this.markDirty();
      this._updateStats();
      this.panel.refresh(this.model);
      this.panel._switchTab('dia');
      const extra = newNodes.length > 0
        ? ` (${newNodes.length} nodo(s) master creado(s) en CR)`
        : '';
      this.toast(`${created.length} ${i18n.t('diafragma(s) creado(s) automáticamente')}${extra}`, 'ok');
    }
  }

  addDiaphragmManual() {
    this.snapshot();
    // Find a floor Z to suggest (highest Z with multiple nodes, not already in a diaphragm)
    const usedZ = new Set([...this.model.diaphragms.values()].map(d => d.z));
    let suggestZ = 3.0;
    if (this.model.nodes.size > 0) {
      const zVals = [...this.model.nodes.values()].map(n => n.z).filter(z => !usedZ.has(z) && z > 0);
      if (zVals.length > 0) suggestZ = Math.max(...zVals);
    }
    const d = this.model.addDiaphragm({
      name: `Piso ${this.model.diaphragms.size + 1}`,
      z: suggestZ,
      nodes: [],
      masterId: null,
      cm: { x: 0, y: 0 },
      mass: { m: 0, Icm: 0 },
      eccentricity: { ex: 0, ey: 0 }
    });
    this.viewport.refreshDiaphragms();
    this.markDirty();
    this.panel.renderDiaphragms();
    this.panel._switchTab('dia');
    this.toast(`${i18n.t('Diafragma')} ${d.id} ${i18n.t('creado — asigne nodos en el panel')}`, 'ok');
  }

  // ── Analysis hub (floating window) ──────────────────────────────────────────
  // Opened from the sidebar "Análisis" button: gathers ALL the analyses in one place
  // with their status (run / not run) and lets you VIEW already-computed results
  // without recomputing.
  _tieneEstaticos() { return !!(this._results || (this._resultsByCase && this._resultsByCase.size)); }
  _ensureHubStyles() {
    if (document.getElementById('analysis-hub-style')) return;
    const s = document.createElement('style');
    s.id = 'analysis-hub-style';
    s.textContent = `
      #analysis-hub{position:absolute;inset:0;z-index:60;display:flex;align-items:flex-start;justify-content:center;
        background:rgba(0,0,0,.28);padding-top:54px}
      #analysis-hub .ah-card{width:min(440px,92%);max-height:82%;overflow:auto;background:var(--bg-elev,#141b27);
        border:1px solid var(--border,#334);border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.5);color:var(--text,#e6edf3)}
      #analysis-hub .ah-head{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;
        border-bottom:1px solid var(--border,#334);font-size:14px;position:sticky;top:0;background:var(--bg-elev,#141b27)}
      #analysis-hub .ah-x{background:none;border:none;color:var(--text-muted,#9aa);cursor:pointer;font-size:14px}
      #analysis-hub .ah-body{padding:8px 12px}
      #analysis-hub .ah-sec{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted,#9aa);
        margin:10px 2px 4px}
      #analysis-hub .ah-row{display:flex;flex-wrap:wrap;justify-content:space-between;gap:6px;align-items:center;
        padding:8px;border:1px solid var(--border,#334);border-radius:7px;margin-bottom:6px}
      #analysis-hub .ah-info{flex:1 1 200px;min-width:0}
      #analysis-hub .ah-name{font-size:13px;font-weight:600;display:flex;align-items:center;gap:7px;flex-wrap:wrap}
      #analysis-hub .ah-desc{font-size:11px;color:var(--text-muted,#9aa);margin-top:1px}
      #analysis-hub .ah-acts{display:flex;gap:6px;flex:0 0 auto}
      #analysis-hub .ah-extra{flex:1 1 100%;font-size:11px;color:var(--text-muted,#9aa);margin-top:4px;
        display:flex;flex-wrap:wrap;gap:6px;align-items:center}
      #analysis-hub button.ah-run,#analysis-hub button.ah-see{font-size:11px;padding:4px 9px;border-radius:5px;cursor:pointer;
        border:1px solid var(--border,#334);background:var(--bg4,#1e2735);color:var(--text,#e6edf3)}
      #analysis-hub button.ah-run{background:var(--accent,#388bfd);border-color:var(--accent,#388bfd);color:#fff}
      #analysis-hub .ah-badge{font-size:10px;font-weight:500;padding:1px 7px;border-radius:10px}
      #analysis-hub .ah-ok{background:rgba(52,199,89,.18);color:#34c759}
      #analysis-hub .ah-no{background:rgba(150,160,175,.15);color:var(--text-muted,#9aa)}
      #analysis-hub .ah-chk{flex:0 0 auto;display:flex;align-items:center;margin-right:2px}
      #analysis-hub .ah-chk input{width:15px;height:15px;cursor:pointer;accent-color:var(--accent,#388bfd)}
      #analysis-hub .ah-batchbar{display:flex;justify-content:flex-end;padding:8px 12px 0}
      #analysis-hub .ah-batch-run{font-size:12px;padding:6px 12px}
      #analysis-hub .ah-foot{padding:8px 14px;border-top:1px solid var(--border,#334);font-size:11px;color:var(--text-muted,#9aa)}
      #analysis-hub .ah-tabs{display:flex;gap:4px;padding:8px 12px 0}
      #analysis-hub .ah-tab{flex:1;font-size:12px;font-weight:600;padding:7px 8px;border-radius:7px 7px 0 0;cursor:pointer;
        border:1px solid var(--border,#334);border-bottom:none;background:var(--bg4,#1e2735);color:var(--text-muted,#9aa)}
      #analysis-hub .ah-tab.active{background:var(--bg-elev,#141b27);color:var(--accent,#388bfd);border-color:var(--accent,#388bfd)}
      #analysis-hub .ah-pane{display:none}
      #analysis-hub .ah-pane.active{display:block}`;
    document.head.appendChild(s);
  }
  openAnalysisHub() {
    this._ensureHubStyles();
    document.getElementById('analysis-hub')?.remove();
    const badge = ok => ok
      ? '<span class="ah-badge ah-ok">✓ resultados</span>'
      : '<span class="ah-badge ah-no">sin ejecutar</span>';
    const espList = [...this._spectrumResults.entries()].map(([k, v]) =>
      `<button class="ah-see" data-see="esp:${esc(k)}">${i18n.t('Ver')} ${esc(k.replace(/^esp/, 'Dir '))}${v?.params?.method ? ' · ' + esc(v.params.method) : ''}</button>`
    ).join('');

    const row = (titulo, desc, runAct, seeOk, extra = '') => `
      <div class="ah-row">
        <label class="ah-chk" title="Incluir en «Analizar seleccionados»"><input type="checkbox" class="ah-batch" data-batch="${runAct}"></label>
        <div class="ah-info"><div class="ah-name">${titulo} ${badge(seeOk)}</div><div class="ah-desc">${desc}</div></div>
        <div class="ah-acts">
          <button class="ah-run" data-run="${runAct}">Ejecutar…</button>
          ${seeOk ? `<button class="ah-see" data-see="${runAct}">Ver</button>` : ''}
        </div>
        ${extra ? `<div class="ah-extra">${extra}</div>` : ''}
      </div>`;

    // Results status of the advanced NL-lite ones (#37). Form-finding edits the
    // geometry (leaves no reusable result) → never gets a ✓ / View badge.
    const nlOk = {
      'run-nonlinear':   !!this._nlResult,
      'run-corotbeam':   !!this._nlResult,
      'run-pdelta':      !!this._pdResult,
      'run-buckling':    !!this._buckResult,
      'run-formfind':    false,
      'run-plastic':     !!this._plasticResult,
      'run-pushover-dc': !!this._dcResult,
      'run-nlth':        !!this._nlthResult,
      'run-staged':      !!this._stagedResult,
      'run-moving':      !!this._movingResult,
    };

    const el = document.createElement('div');
    el.id = 'analysis-hub';
    el.innerHTML = `
      <div class="ah-card" role="dialog" aria-label="Centro de análisis">
        <div class="ah-head"><b>Análisis</b><button class="ah-x" title="Cerrar">✕</button></div>
        <div class="ah-tabs">
          <button class="ah-tab active" data-pane="lineal">Estático / lineal</button>
          <button class="ah-tab" data-pane="avanzado">Avanzados (NL-lite)</button>
        </div>
        <div class="ah-body">
          <div class="ah-pane active" data-pane="lineal">
            ${row('Estático', 'Todos los casos y combinaciones', 'run', this._tieneEstaticos(), `<button class="ah-see" data-advrun="1" title="Elegir qué casos de carga correr (LC1, LC2, …)">⚙ Elegir casos a correr…</button>`)}
            ${row('Modal', 'Frecuencias y formas modales', 'run-modal', !!this._modalResults,
              `<button class="ah-see" data-massource="1" title="Definir la masa sísmica desde casos de carga (peso → masa), usada por modal/espectro/time-history">⚖ <span>Fuente de masa</span>${this.model.massSource?.enabled ? ' <span style="color:var(--teal)">●</span>' : ''} …</button>`)}
            ${row('Espectro de respuesta', 'NCh433 · requiere modal', 'run-spectrum', this._spectrumResults.size > 0,
              this._spectrumResults.size ? `${i18n.t('Casos espectrales corridos:')} ${espList}` : '')}
            ${row('Dinámico lineal (time-history)', 'Acelerograma en la base · Duhamel modal · X/Y/Z', 'run-timehistory', !!this._thResult)}
          </div>
          <div class="ah-pane" data-pane="avanzado">
            ${row('No lineal — cables', 'Cables tracción / pretensado', 'run-nonlinear', nlOk['run-nonlinear'])}
            ${row('Gran rotación (viga corotacional 2D)', 'Modelo plano · Newton · gran desplazamiento', 'run-corotbeam', nlOk['run-corotbeam'])}
            ${row('P-Delta', 'Rigidez geométrica iterativa', 'run-pdelta', nlOk['run-pdelta'])}
            ${row('Pandeo lineal', 'Factor crítico (autovalores)', 'run-buckling', nlOk['run-buckling'])}
            ${row('Form-finding', 'Densidades de fuerza (FDM) · reposiciona nodos', 'run-formfind', false)}
            ${row('Rótulas plásticas', 'Colapso evento a evento', 'run-plastic', nlOk['run-plastic'])}
            ${row('Pushover (control δ)', 'Curva carga–desplazamiento', 'run-pushover-dc', nlOk['run-pushover-dc'])}
            ${row('Time-history NO LINEAL', 'Edificio de corte · rótulas · Newmark', 'run-nlth', nlOk['run-nlth'])}
            <div class="ah-sec">Puentes</div>
            ${row('Etapas constructivas', 'Staged · activación incremental', 'run-staged', nlOk['run-staged'])}
            ${row('Pretensado por tendón', 'Cargas equivalentes (load balancing)', 'run-tendon', false)}
            ${row('Cargas móviles / líneas de influencia', 'Barrido de tren · IL · envolventes', 'run-moving', nlOk['run-moving'])}
          </div>
        </div>
        <div class="ah-batchbar">
          <button class="ah-run ah-batch-run" id="ah-batch-run" title="Corre en orden los análisis marcados, con parámetros por defecto (sin diálogos)">▶ Analizar seleccionados</button>
        </div>
        <div class="ah-foot">Marque las casillas y use «Analizar seleccionados» para correr varios en orden con parámetros por defecto · "Ver" muestra resultados ya calculados sin recalcular.</div>
      </div>`;
    document.getElementById('viewport-wrap')?.appendChild(el) || document.body.appendChild(el);
    i18n.translate(el);   // custom overlay (not auto-observed): translate its text/attrs

    const close = () => el.remove();
    el.querySelector('.ah-x').addEventListener('click', close);
    el.addEventListener('click', e => { if (e.target === el) close(); });
    // Sub-tabs (#40)
    el.querySelectorAll('.ah-tab').forEach(t => t.addEventListener('click', () => {
      const p = t.dataset.pane;
      el.querySelectorAll('.ah-tab').forEach(x => x.classList.toggle('active', x.dataset.pane === p));
      el.querySelectorAll('.ah-pane').forEach(x => x.classList.toggle('active', x.dataset.pane === p));
    }));
    el.querySelectorAll('[data-run]').forEach(b => b.addEventListener('click', () => {
      close(); this._runByAction(b.dataset.run);
    }));
    el.querySelectorAll('[data-see]').forEach(b => b.addEventListener('click', () => {
      close(); this._verResultados(b.dataset.see);
    }));
    el.querySelectorAll('[data-advrun]').forEach(b => b.addEventListener('click', (e) => {
      e.stopPropagation(); close(); this.runAnalysisAdvanced();
    }));
    el.querySelectorAll('[data-massource]').forEach(b => b.addEventListener('click', (e) => {
      e.stopPropagation(); close(); this._massSourceDialog();
    }));
    el.querySelector('#ah-batch-run')?.addEventListener('click', () => {
      const acts = [...el.querySelectorAll('.ah-batch:checked')].map(c => c.dataset.batch);
      if (!acts.length) { this.toast('Marque al menos un análisis', 'warn'); return; }
      close(); this._runBatch(acts);
    });
  }

  async _runByAction(act, opts = {}) {
    const fn = {
      'run': () => this.runAnalysis(), 'run-modal': () => this.runModal(opts),
      'run-spectrum': () => this.runSpectrum(opts), 'run-timehistory': () => this.runTimeHistory(opts),
      'run-nonlinear': () => this.runNonlinear(opts), 'run-corotbeam': () => this.runCorotBeam(opts),
      'run-pdelta': () => this.runPDelta(opts), 'run-buckling': () => this.runBuckling(opts),
      'run-formfind': () => this.runFormFinding(opts), 'run-plastic': () => this.runPlastic(opts),
      'run-pushover-dc': () => this.runPushoverDC(opts),
      'run-staged': () => this.runStaged(opts), 'run-tendon': () => this.runTendon(opts),
      'run-moving': () => this.runMovingLoad(opts), 'run-nlth': () => this.runNLTimeHistory(opts),
    }[act];
    if (!fn) return;
    // Each runner manages its own progress box (modal/spectrum/buckling and, since
    // #44, also the synchronous NL-lite ones). await: the BATCH mode waits for it to finish.
    await fn();
  }

  // ── Analyze selected (BATCH) ────────────────────────────────────────────────
  // Runs in logical order the analysis sequence checked in the analysis hub. The
  // spectrum requires modal: if requested without a prior modal, it is prepended.
  async _runBatch(acts) {
    const orden = ['run', 'run-modal', 'run-spectrum', 'run-timehistory', 'run-nonlinear', 'run-pdelta',
                   'run-buckling', 'run-formfind', 'run-plastic', 'run-pushover-dc'];
    const nombre = {
      'run': 'Estático', 'run-modal': 'Modal', 'run-spectrum': 'Espectro', 'run-timehistory': 'Time-history',
      'run-nonlinear': 'No lineal', 'run-pdelta': 'P-Delta', 'run-buckling': 'Pandeo',
      'run-formfind': 'Form-finding', 'run-plastic': 'Rótulas plásticas', 'run-pushover-dc': 'Pushover',
    };
    const set = new Set(acts);
    if (set.has('run-spectrum') && !set.has('run-modal') && !this._modalResults) set.add('run-modal');
    const lista = orden.filter(a => set.has(a));
    if (!lista.length) { this.toast('Marque al menos un análisis', 'warn'); return; }
    for (let i = 0; i < lista.length; i++) {
      const act = lista[i];
      this.toast(`Lote ${i + 1}/${lista.length}: ${nombre[act]}…`, '');
      // silent: each analysis runs with its default parameters, no dialog (#38)
      try { await this._runByAction(act, { silent: true }); }
      catch (e) { this.toast(`${i18n.t('Lote detenido en')} «${nombre[act]}»: ${e.message}`, 'error'); return; }
    }
    this._updateResultsIndicator();
    this.toast(`Lote completado: ${lista.map(a => nombre[a]).join(' · ')}`, 'ok');
  }

  // Re-shows ALREADY-computed results, without recomputing.
  _verResultados(key) {
    if (key === 'run') {                       // static
      if (!this._tieneEstaticos()) { this.toast('No hay resultados estáticos', 'warn'); return; }
      this.panel._switchVTab('results'); this.panel._switchRTab?.('estatico');
      this._refreshResultView(true); this.panel.renderStaticResults?.();
    } else if (key === 'run-modal') {          // modal
      if (!this._modalResults) { this.toast('No hay resultados modales', 'warn'); return; }
      this._setupModalOverlay?.(); this._refreshModalView?.();
      this.panel._switchVTab('results'); this.panel._switchRTab?.('modal'); this.panel.renderModalResults?.();
    } else if (key.startsWith('esp:')) {       // a specific spectral case
      const entry = this._spectrumResults.get(key.slice(4));
      if (!entry) { this.toast('Caso espectral no encontrado', 'warn'); return; }
      this._results = entry.result;
      this.panel._switchVTab('results'); this.panel._switchRTab?.('estatico');
      this._refreshResultView(true); this.panel.renderStaticResults?.();
    } else if (key === 'run-nonlinear' || key === 'run-corotbeam') {  // NL-lite already run (#37)
      if (!this._nlResult) { this.toast('No hay resultados no lineales', 'warn'); return; }
      this._nlOpenOverlay();
    } else if (key === 'run-pdelta') {
      if (!this._pdResult) { this.toast('No hay resultados P-Delta', 'warn'); return; }
      this._pdShow();
    } else if (key === 'run-buckling') {
      if (!this._buckResult) { this.toast('No hay resultados de pandeo', 'warn'); return; }
      this._buckOpenOverlay();
    } else if (key === 'run-plastic') {
      if (!this._plasticResult) { this.toast('No hay resultados de rótulas plásticas', 'warn'); return; }
      this._plasticShow();
    } else if (key === 'run-pushover-dc') {
      if (!this._dcResult) { this.toast('No hay resultados de pushover', 'warn'); return; }
      this._dcOpenOverlay();
    } else if (key === 'run-timehistory') {
      if (!this._thResult) { this.toast('No hay resultados de time-history', 'warn'); return; }
      this._thOpenOverlay();
    } else if (key === 'run-staged') {
      if (!this._stagedResult) { this.toast('No hay resultados de etapas constructivas', 'warn'); return; }
      this._stagedShow();
    } else if (key === 'run-moving') {
      if (!this._movingResult) { this.toast('No hay resultados de cargas móviles', 'warn'); return; }
      this._movingPlotOverlay(this._movingResult);
    } else if (key === 'run-nlth') {
      if (!this._nlthResult) { this.toast('No hay resultados de time-history no lineal', 'warn'); return; }
      this._nlthOpenOverlay();
    }
  }

  // Re-draws the saved P-Delta deformed shape (hub's View button, #37).
  _pdShow() {
    const u = this._pdResult?.u; if (!u || !this._geomNI) return;
    const uByNode = new Map();
    for (const node of this.model.nodes.values()) {
      const d = getNodeDOFs(this._geomNI, node.id);
      uByNode.set(node.id, [u[d[0]], u[d[1]], u[d[2]]]);
    }
    this.viewport.showNLDeformed(uByNode, new Map(), 1, 'P-Delta · deformada amplificada (resultado guardado)');
  }

  // Re-shows the saved plastic-collapse mechanism + the Hinges tab (#37).
  _plasticShow() {
    if (!this._plasticResult) return;
    this._plasticOpenOverlay();   // deformed shape + step-by-step sequence (#47)
    this.panel._switchVTab('results');
    this.panel._switchRTab('plastico');
  }

  // Applies (or reverts) the ×N auto-discretization to the model per the bar's
  // «Auto-discretize» checkbox. Shared by the static, modal and NL-lite analyses so
  // ALL of them run on the same mesh (#36). The ORIGINAL model stays in `_predisc`
  // (the mesh is never edited/saved); it is restored on clearing results or on the
  // first edit (snapshot). Returns whether auto-disc is active.
  _applyAutoDiscIfEnabled() {
    const autoDisc = !!document.getElementById('auto-disc')?.checked;
    if (autoDisc) {
      const nParts = Math.max(2, Math.round(parseFloat(document.getElementById('auto-disc-n')?.value) || 5));
      if (!this._predisc) this._predisc = this.serializer.toJSON(this.model);
      else this.model = this.serializer.fromJSON(this._predisc);  // re-analysis: start from the original
      discretizeAll(this.model, { parts: nParts });
      this.viewport.renderModel(this.model);
    } else if (this._predisc) {
      // was auto-discretized and the checkbox was turned off: restore
      this.model = this.serializer.fromJSON(this._predisc);
      this._predisc = null;
      this.viewport.renderModel(this.model);
    }
    return autoDisc;
  }

  // ── Analysis ──────────────────────────────────────────────────────────────
  // Solves ALL load cases (each with its own self-weight flag) and all combinations
  // by superposition. The shown result is that of the case/combo selected in the
  // dropdown.
  // force=true ignores the cache and re-solves (menu "Recalculate").
  // #105 «Advanced»: pick with checkboxes WHICH static cases to run.
  async runAnalysisAdvanced() {
    const statics = [...this.model.loadCases.values()].filter(lc => lc.type !== 'spectrum');
    if (!statics.length) { this.toast('No hay casos de carga estáticos que correr', 'warn'); return; }
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = i18n.t('⚙ Elegir casos a correr');
    const rows = statics.map(lc => `
      <label style="display:flex;align-items:center;gap:8px;padding:5px 6px;border:1px solid var(--border);border-radius:6px;margin-bottom:4px;font-size:12px;cursor:pointer">
        <input type="checkbox" class="ra-chk" value="${lc.id}" checked style="accent-color:var(--accent)">
        <span style="flex:1">${esc(lc.name)}${lc.selfWeight ? ' <span style="color:var(--text-muted)">⊕PP</span>' : ''}</span>
        <span style="color:var(--text-muted);font-size:10px">${this._loadTypeLabel(lc.loadType || (lc.selfWeight ? 'dead' : 'other'))}</span>
      </label>`).join('');
    document.getElementById('modal-body').innerHTML = `
      <p style="color:var(--text-muted);font-size:11px;margin:0 0 8px">Marca los casos a resolver en esta corrida. Las combinaciones se recalculan a partir de los casos corridos. (Los casos espectrales se calculan con F6 + F7.)</p>
      <div style="display:flex;gap:8px;margin-bottom:8px">
        <button type="button" id="ra-all" class="btn-secondary" style="font-size:11px;padding:3px 8px">Todos</button>
        <button type="button" id="ra-none" class="btn-secondary" style="font-size:11px;padding:3px 8px">Ninguno</button>
      </div>
      ${rows}`;
    document.getElementById('modal-cancel').style.display = '';
    overlay.classList.remove('hidden');
    document.getElementById('ra-all')?.addEventListener('click', () => overlay.querySelectorAll('.ra-chk').forEach(c => c.checked = true));
    document.getElementById('ra-none')?.addEventListener('click', () => overlay.querySelectorAll('.ra-chk').forEach(c => c.checked = false));
    const ok = await new Promise(res => { overlay._resolve = res; overlay._reject = () => res(false); });
    if (!ok) return;
    const only = new Set([...overlay.querySelectorAll('.ra-chk:checked')].map(c => +c.value));
    if (!only.size) { this.toast('No marcaste ningún caso', 'warn'); return; }
    this.runAnalysis(true, only);
  }

  // `only` (#105): Set of lcId to solve (null = all static cases).
  runAnalysis(force = false, only = null) {
    this._runOnly = only;   // read by the case filter below
    // An areas-only model (wall/slab) is valid: nodes + (member OR area elements) suffice.
    if (this.model.nodes.size === 0 || (this.model.elements.size === 0 && (this.model.areas?.size || 0) === 0)) {
      this.toast('El modelo debe tener nodos y elementos (barras o áreas)', 'warn'); return;
    }
    // P4-14: pre-analysis validation
    const valWarns = this._validateModel();
    const valErrors = valWarns.filter(w => w.startsWith('⛔'));
    if (valErrors.length > 0) { this.toast(valErrors[0], 'error'); return; }
    if (valWarns.length > 0)  { this.toast(`${valWarns[0]}`, 'warn'); }

    const btn = document.getElementById('btn-run');
    if (btn) btn.classList.add('running');
    document.getElementById('sb-mode').textContent = i18n.t('Analizando…');

    // Slight delay so browser can repaint before heavy computation.
    // Wrapped in a promise so the BATCH mode (Analyze selected) can wait for it to
    // finish before launching the next analysis.
    return new Promise(resolve => setTimeout(async () => {
      try {
        // ── Auto-discretization (×N) for the analysis ──
        // The original model is saved and restored on clearing results.
        const autoDisc = this._applyAutoDiscIfEnabled();

        // Signature of the original model (+ auto-disc): uniquely identifies the
        // results. If it matches the cache, it is reused without re-solving.
        const sig = this._modelSig(autoDisc);
        let reused = false;
        if (!force && this._resultsCache && this._resultsCache.sig === sig) {
          reused = this._reconstructResultsFromCache();
        }

        if (!reused) {
          // Solve all the STATIC cases (the spectral ones are computed with F6+F7
          // and keep their result in _resultsByCase if they already ran).
          const prevSpec = new Map();
          if (this._resultsByCase) {
            for (const lc of this.model.loadCases.values()) {
              if (lc.type === 'spectrum' && this._resultsByCase.has(lc.id))
                prevSpec.set(lc.id, this._resultsByCase.get(lc.id));
            }
          }
          this._resultsByCase = new Map(prevSpec);
          const only = this._runOnly;   // «Cases…» selection (#105); null = all
          const staticLcs = [...this.model.loadCases.values()].filter(lc => lc.type !== 'spectrum' && (!only || only.has(lc.id)));
          const cases = [];
          if (staticLcs.length) {
            // Solver in a Web Worker (doesn't freeze the UI), single factorization + band.
            const resMap = await this._solveStaticCases(staticLcs);
            for (const lc of staticLcs) {
              const res = resMap.get(lc.id); if (!res) continue;
              this._resultsByCase.set(lc.id, res);
              cases.push({
                key: lc.id, lcId: lc.id, selfWeight: !!lc.selfWeight,
                u: Array.from(res.u), reactions: Array.from(res.reactions),
              });
            }
          }
          if (!cases.length) { this.toast('No hay casos de carga estáticos que analizar', 'warn'); }
          // Combinations by superposition of what's already solved
          for (const combo of this.model.combinations.values()) {
            const res = this._combineFromCache(combo);
            if (res) this._resultsByCase.set('C' + combo.id, res);
          }
          // Don't cache PARTIAL runs (#105): a later full F5 must recompute everything.
          this._resultsCache = only ? null : { sig, autoDisc: !!autoDisc, cases };
          this._persistResults();
        }

        // Show the selected result
        const key = this._activeResultKey ?? this._activeLcId;
        this._results = this._resultsByCase.get(key)
                     || this._resultsByCase.get(this._activeLcId)
                     || this._resultsByCase.values().next().value;
        if (!this._results) {
          this.toast('Sin resultados: cree un caso de carga estático o ejecute F6+F7 para los espectrales', 'warn');
          return;
        }

        const sum = this._results.getSummary();
        const nLC = [...this.model.loadCases.values()].filter(l => l.type !== 'spectrum').length;
        const nCB = this.model.combinations.size;
        this.toast(
          (reused ? 'Resultados recuperados (sin recalcular)' : 'Análisis OK') +
          `: ${nLC} caso(s)` +
          (nCB ? ` + ${nCB} combo(s)` : '') +
          ` | δmax=${sum.maxU.toExponential(2)}`, 'ok');

        // Unified stability verdict (PART 2): backend-agnostic drift/displacement
        // sanity + the solver's own warnings, surfaced prominently (same text for any
        // backend). Catches the near-mechanism the matrix solve alone misses.
        this._surfaceStabilityWarnings();

        document.getElementById('result-type').value = 'deformed';
        this._refreshResultView(true);
        this.refreshLoads();
        this.panel._switchVTab('results');
        this.panel._switchRTab('estatico');
        this.panel.renderStaticResults();
        this._updateResultsIndicator();

        // Kick off background diagram pre-computation (shows progress bar)
        this._precomputeDiagramsAsync(this._results);
      } catch (err) {
        if (err.message === 'cancelado') this.toast('Análisis cancelado', 'warn');
        else {
          this.toast(`${i18n.t('Error:')} ${i18n.t(err.message)}`, 'error'); console.error(err);
          // Instability/mechanism → diagnose and highlight the culprit node
          if (/inestable|singular|mecanismo|factoriza/i.test(err.message)) this.runStabilityDiagnosis(true);
        }
      } finally {
        if (btn) btn.classList.remove('running');
        document.getElementById('sb-mode').textContent = `${i18n.t('Modo:')} ${i18n.t('Resultados')}`;
        resolve();
      }
    }, 20));
  }

  // ── Unified stability surfacing (backend-agnostic) ───────────────────────────
  // After a static run, assess every solved case for excessive drift / displacement
  // (assessStabilitySanity, works for JS Results AND Nodex WasmResults) plus the
  // solver's own `warnings`, and show a PROMINENT banner with the SAME text whatever
  // the active backend. This is what catches a near-mechanism that "solves" with
  // garbage (e.g. a model rescued by a rigid diaphragm) — invisible to the matrix
  // solve alone. See js/solver/stability.js + NODEX-CONTRACT.md.
  _surfaceStabilityWarnings() {
    if (!this._resultsByCase) return;
    const lines = [];
    for (const [key, res] of this._resultsByCase) {
      if (!res || typeof res.getNodeDisp !== 'function') continue;
      // post sanity (drift / displacement) — merge into the result's own warnings
      try {
        const sanity = assessStabilitySanity(this.model, res);
        if (sanity.length) res.warnings = [...(res.warnings || []), ...sanity];
      } catch { /* never block results on the sanity check */ }
      const ws = res.warnings || [];
      if (!ws.length) continue;
      const lc = this.model.loadCases.get(key) ||
                 (typeof key === 'string' && key[0] === 'C' && this.model.combinations.get(+key.slice(1)));
      const caseName = (lc && lc.name) || String(key);
      for (const w of ws) lines.push(`${caseName} — ${this._stabilityMsg(w)}`);
    }
    if (!lines.length) return;
    const uniq = [...new Set(lines)];
    this.toast('⚠ ' + i18n.t('Aviso de estabilidad:') + ' ' + uniq.slice(0, 3).join('  ·  '), 'warn', 9000);
  }

  // Localized message for a structured stability warning (shared codes with Nodex).
  _stabilityMsg(w) {
    const p = w.params || {};
    const tail = i18n.t('Posible inestabilidad o modelo mal restringido.');
    if (w.code === STABILITY.DRIFT)
      return `${i18n.t('Deriva de entrepiso excesiva:')} ${(p.drift * 1000).toFixed(0)} mm (h=${p.h} m, H/${(1 / p.ratio).toFixed(0)}). ${tail}`;
    if (w.code === STABILITY.DISPLACEMENT)
      return `${i18n.t('Desplazamiento máximo desproporcionado:')} ${(p.maxU * 1000).toFixed(0)} mm (${(100 * p.frac).toFixed(0)}% ${i18n.t('del tamaño del modelo')}). ${tail}`;
    if (w.code === STABILITY.ILL_CONDITIONED)
      return i18n.t('Matriz casi singular: el modelo está cerca de un mecanismo; los resultados pueden ser poco fiables.');
    return i18n.t(w.message) || w.message;
  }

  // ── Stability diagnosis ──────────────────────────────────────────────────────
  // Detects FREE DOFs with no stiffness (K diagonal ≈ 0): the most common cause of
  // "singular matrix / mechanism" (a poorly connected node that isn't obvious at a
  // glance). Returns [{ id, dofs:['Rx','Ry'…] }].
  diagnoseInstability() {
    const model = this.model;
    const nodeIndex = buildNodeIndex(model);
    const { K, nDOF } = assembleK(model, nodeIndex);
    let kmax = 0; for (let i = 0; i < nDOF; i++) kmax = Math.max(kmax, Math.abs(K[i * nDOF + i]));
    const tol = (kmax || 1) * 1e-9;
    const names = ['Ux', 'Uy', 'Uz', 'Rx', 'Ry', 'Rz'];
    const is2D = model.mode === '2D';
    const out = [];
    for (const node of model.nodes.values()) {
      const r = node.restraints;
      const fixed = [r.ux, is2D ? 1 : r.uy, r.uz, is2D ? 1 : r.rx, r.ry, is2D ? 1 : r.rz];
      const b = nodeIndex.get(node.id) * 6;
      const weak = [];
      for (let i = 0; i < 6; i++) if (!fixed[i] && Math.abs(K[(b + i) * nDOF + (b + i)]) <= tol) weak.push(names[i]);
      if (weak.length) out.push({ id: node.id, dofs: weak });
    }
    return out;
  }

  // Runs the diagnosis, highlights the culprit nodes and shows the detail.
  // auto=true → invoked after a failure (does not show "all OK").
  runStabilityDiagnosis(auto = false) {
    let culprits;
    try { culprits = this.diagnoseInstability(); }
    catch (e) { this.toast(`${i18n.t('No se pudo diagnosticar:')} ${e.message}`, 'warn'); return; }
    if (!culprits.length) {
      if (!auto) this.toast('Sin GDL sueltos: no se detectaron nodos con rigidez nula. Si el análisis falla, el mecanismo puede ser de varios GDL acoplados (p.ej. barras colineales rotuladas).', 'ok');
      return;
    }
    const ids = culprits.map(c => c.id);
    this.viewport.flagNodes?.(ids);
    const detalle = culprits.slice(0, 8).map(c => `#${c.id} (${c.dofs.join(',')})`).join(' · ');
    this.toast(`⛔ ${culprits.length} ${i18n.t('nodo(s) con GDL sin rigidez (mecanismo) — resaltados:')} ${detalle}${culprits.length > 8 ? '…' : ''}`, 'error');
    this.panel.showSelection?.(this.viewport.getSelected());
  }

  // Solves ALL static cases in a Web Worker (doesn't freeze the UI), assembling K
  // once and factorizing once (banded Cholesky with RCM). If the worker fails or the
  // matrix is not SPD, it uses the dense fallback solver.
  async _solveStaticCases(staticLcs) {
    // ── Backends hook (multi-solver) ────────────────────────────────────────────
    // By default the active backend is 'js' → this block is skipped and the JS
    // pipeline (sparse/dense worker) below is used, UNCHANGED. If an upper layer
    // registered and activated another backend in the solverRegistry (e.g. Nodex
    // C++/WASM), it solves through it; if it doesn't cover some case or fails, it
    // falls back to the full JS pipeline (fast path intact). Each backend returns an
    // object compatible with `Results`.
    const backend = solverRegistry.active;
    if (backend && backend.name !== 'js') {
      try {
        const bmap = new Map();
        let ok = true;
        for (const lc of staticLcs) {
          const opts = { selfWeight: !!lc.selfWeight };
          const can = backend.canSolve(this.model, lc.id, opts);
          if (!can || !can.ok) { ok = false; break; }
          const res = await backend.solveStatic(this.model, lc.id, opts);
          if (!res) { ok = false; break; }
          bmap.set(lc.id, res);
        }
        if (ok) return bmap;
        console.warn(`Backend "${backend.name}" no cubre todos los casos; se usa el solver JS.`);
      } catch (e) {
        console.warn(`Backend "${backend.name}" falló (${e?.message || e}); se usa el solver JS.`);
      }
    }

    const model = this.model;
    const nodeIndex = buildNodeIndex(model);
    const nDOF = nodeIndex.size * 6;

    const is2D = model.mode === '2D';
    const dofNames = ['ux', 'uy', 'uz', 'rx', 'ry', 'rz'];
    const freeDOF = [];
    const freeMap = new Int32Array(nDOF).fill(-1);
    // Prescribed displacement (#54): support DOF with a known value ≠ 0.
    const up = new Float64Array(nDOF);
    const prescDOF = [];
    let hasPresc = false;
    for (const node of model.nodes.values()) {
      const d = getNodeDOFs(nodeIndex, node.id);
      const r = node.restraints, pd = node.prescDisp;
      const rArr = [r.ux, is2D ? 1 : r.uy, r.uz, is2D ? 1 : r.rx, r.ry, is2D ? 1 : r.rz];
      d.forEach((gi, li) => {
        const pv = pd ? (+pd[dofNames[li]] || 0) : 0;
        if (rArr[li] || pv !== 0) {
          if (pv !== 0) { up[gi] = pv; prescDOF.push(gi); hasPresc = true; }
        } else { freeMap[gi] = freeDOF.length; freeDOF.push(gi); }
      });
    }
    if (!freeDOF.length) throw new Error('El modelo no tiene grados de libertad libres (¿todos los nodos están empotrados?)');

    const Flist = staticLcs.map(lc => assembleF(model, nodeIndex, lc.id, !!lc.selfWeight));
    const map = new Map();

    // #54: with prescribed DOFs, moves −K_fp·u_p to each case's RHS. The worker
    // receives the effective RHS (FlistEff); the original F is kept to report the real
    // reactions. u_p is superposed and the reactions are recomputed below.
    let Kdense = null;
    const FlistSolve = hasPresc ? Flist.map(F => Float64Array.from(F)) : Flist;
    if (hasPresc) {
      Kdense = assembleK(model, nodeIndex).K;
      for (const F of FlistSolve)
        for (const di of freeDOF) { let c = 0; for (const dj of prescDOF) c += Kdense[di * nDOF + dj] * up[dj]; F[di] -= c; }
    }

    // By default: SPARSE assembly (CSR) → no dense nDOF² matrix. The «dense matrix»
    // mode (academic) uses the classic dense assembly.
    const dense = !!this._config?.analisis?.matrizDensa;
    let out = null;
    try {
      if (dense || hasPresc) {
        const K = Kdense || assembleK(model, nodeIndex).K;
        out = await this._staticWorkerSolve(K.slice(), nDOF, Int32Array.from(freeDOF), FlistSolve, true);
      } else {
        const { S } = assembleSparseGlobal(model, nodeIndex, { withMass: false });
        const { csr, cf } = extractFreeCSR(S, freeMap, freeDOF.length);
        // Solver choice: iterative PCG only for LARGE meshes WITHOUT penalty constraints.
        // Rigid diaphragms/links use a penalty that inflates κ and cripples CG, so those
        // models keep the direct banded Cholesky (factor once, reuse across load cases).
        // The worker still falls back to the direct factor if PCG ever stalls.
        const PCG_MIN_DOF = 5000;
        const hasPenaltyConstraints = model.diaphragms.size > 0 || model.links.size > 0;
        const usePcg = freeDOF.length >= PCG_MIN_DOF && !hasPenaltyConstraints;
        out = await this._staticWorkerSolveSparse(csr, cf, nDOF, Int32Array.from(freeDOF), FlistSolve, usePcg);
      }
    }
    catch (e) {
      if (e?.message === 'cancelado') throw e;   // cancellation → abort, don't use fallback
      console.warn('Worker estático falló, se usa el solver de respaldo:', e?.message || e); out = null;
    }

    if (out && out.ok) {
      const freeSet = new Set(freeDOF);
      staticLcs.forEach((lc, idx) => {
        const u = out.uList[idx], reactions = out.reactionsList[idx], F = Flist[idx];
        // #54: superpose the prescribed displacement and recompute reactions with K·u−F
        // (the original F, without the RHS shift) → correct support reactions.
        if (hasPresc) {
          for (const dj of prescDOF) u[dj] = up[dj];
          for (let i = 0; i < nDOF; i++) { let s = 0; const off = i * nDOF; for (let j = 0; j < nDOF; j++) s += Kdense[off + j] * u[j]; reactions[i] = s - F[i]; }
        }
        for (const node of model.nodes.values()) {   // reactions of elastic supports
          const sp = node.springs; if (!sp) continue;
          const ks = [sp.kux, sp.kuy, sp.kuz, sp.krx, sp.kry, sp.krz];
          if (!ks.some(k => k > 0)) continue;
          const d = getNodeDOFs(nodeIndex, node.id);
          for (let i = 0; i < 6; i++) if (ks[i] > 0 && freeSet.has(d[i])) reactions[d[i]] = -ks[i] * u[d[i]];
        }
        map.set(lc.id, new Results(model, nodeIndex, u, reactions, F, lc.id, !!lc.selfWeight));
      });
      return map;
    }

    // ── Fallback: original dense solver (numeric.js), per case ──
    const solver = new StaticSolver();
    for (const lc of staticLcs) map.set(lc.id, solver.solve(model, lc.id, !!lc.selfWeight));
    return map;
  }

  // Launches the static worker and solves with progress + cancel.
  _staticWorkerSolve(K, nDOF, freeDOF, Flist, dense = false) {
    return new Promise((resolve, reject) => {
      let worker;
      try { worker = new Worker(new URL('./solver/static_worker.js?v=2', import.meta.url), { type: 'module' }); }
      catch (e) { reject(e); return; }
      this._staticWorker = worker;
      const cancelar = () => { try { worker.terminate(); } catch (e) {} this._staticWorker = null; this._hideProgress(); reject(new Error('cancelado')); };
      this._showProgress('Analizando…', 'Resolviendo K·u = F (en segundo plano)', cancelar);
      worker.onmessage = (ev) => {
        const d = ev.data;
        if (d && d.progress) {
          const sub = d.progress === 'factorizando' ? 'Factorizando la matriz de rigidez…'
            : `Resolviendo caso ${d.done}/${d.total}…`;
          this._showProgress('Analizando…', sub, cancelar);
          return;
        }
        try { worker.terminate(); } catch (e) {}
        this._staticWorker = null;
        this._hideProgress();
        resolve(d);
      };
      worker.onerror = (ev) => { try { worker.terminate(); } catch (e) {} this._staticWorker = null; this._hideProgress(); reject(new Error(ev.message || 'error en worker estático')); };
      // K is transferred (zero-copy); Flist is copied (the main thread needs it for the Results).
      worker.postMessage({ Kflat: K, nDOF, freeDOF, Flist, dense }, [K.buffer, freeDOF.buffer]);
    });
  }

  // Same as _staticWorkerSolve but via the SPARSE path (CSR): the dense matrix is
  // never transferred, only the non-zeros.
  _staticWorkerSolveSparse(csr, cf, nDOF, freeDOF, Flist, pcg = false) {
    return new Promise((resolve, reject) => {
      let worker;
      try { worker = new Worker(new URL('./solver/static_worker.js?v=2', import.meta.url), { type: 'module' }); }
      catch (e) { reject(e); return; }
      this._staticWorker = worker;
      const cancelar = () => { try { worker.terminate(); } catch (e) {} this._staticWorker = null; this._hideProgress(); reject(new Error('cancelado')); };
      this._showProgress('Analizando…', 'Resolviendo K·u = F (matriz dispersa, en segundo plano)', cancelar);
      worker.onmessage = (ev) => {
        const d = ev.data;
        if (d && d.progress) {
          const sub = d.progress === 'factorizando' ? 'Factorizando la matriz de rigidez (dispersa)…'
            : `Resolviendo caso ${d.done}/${d.total}…`;
          this._showProgress('Analizando…', sub, cancelar);
          return;
        }
        try { worker.terminate(); } catch (e) {}
        this._staticWorker = null;
        this._hideProgress();
        resolve(d);
      };
      worker.onerror = (ev) => { try { worker.terminate(); } catch (e) {} this._staticWorker = null; this._hideProgress(); reject(new Error(ev.message || 'error en worker estático')); };
      // Only the non-zeros are transferred (zero-copy); Flist is copied.
      worker.postMessage({ csr, cf, nDOF, freeDOF, Flist, pcg }, [
        csr.rowPtr.buffer, csr.colIdx.buffer, csr.val.buffer,
        cf.rowDof.buffer, cf.ptr.buffer, cf.freeIdx.buffer, cf.val.buffer,
        freeDOF.buffer,
      ]);
    });
  }

  // Combines already-solved results (this._resultsByCase) per the combo's factors.
  // Returns a Results or null if no factor is solvable.
  _combineFromCache(combo) {
    let nodeIndex = null, nDOF = 0, cU = null, cR = null;
    const combinedEF = new Map();
    let any = false;

    for (const { lcId, factor } of combo.factors) {
      const f = parseFloat(factor) || 0;
      const isSpectral = typeof lcId === 'string' && lcId.startsWith('esp');

      if (isSpectral) {
        const sr = this._spectrumResults.get(lcId);
        if (!sr) { this.toast(`${i18n.t('Combo')} "${combo.name}": ${i18n.t('ejecute el espectro')} "${lcId}" ${i18n.t('primero')}`, 'warn'); continue; }
        if (cU && sr.result.U.length !== nDOF) { this.toast(`${i18n.t('Combo')} "${combo.name}": ${i18n.t('espectro incompatible con el modelo actual')}`, 'warn'); continue; }
        if (!cU) {
          nodeIndex = sr.result.nodeIndex;
          nDOF = sr.result.U.length;
          cU = new Float64Array(nDOF); cR = new Float64Array(nDOF);
        }
        for (let i = 0; i < nDOF; i++) cU[i] += f * sr.result.U[i];
        any = true;
      } else {
        const numId = typeof lcId === 'number' ? lcId : parseInt(lcId);
        const res = this._resultsByCase?.get(numId);
        if (!res) {
          const lc = this.model.loadCases.get(numId);
          if (lc?.type === 'spectrum')
            this.toast(`${i18n.t('Combo')} "${combo.name}": ${i18n.t('ejecute F6+F7 para el caso espectral')} "${lc.name}"`, 'warn');
          continue;
        }

        if (res.U && !res.u) {
          // SPECTRAL case (SpectrumResults): envelope — only the displacement is
          // superposed (envelope forces have no unique sign).
          if (cU && res.U.length !== nDOF) { this.toast(`${i18n.t('Combo')} "${combo.name}": ${i18n.t('espectro incompatible con el modelo actual')}`, 'warn'); continue; }
          if (!cU) {
            nodeIndex = res.nodeIndex;
            nDOF = res.U.length;
            cU = new Float64Array(nDOF); cR = new Float64Array(nDOF);
          }
          for (let i = 0; i < nDOF; i++) cU[i] += f * res.U[i];
          any = true;
          continue;
        }

        if (!cU) {
          nodeIndex = res.nodeIndex;
          nDOF = res.u.length;
          cU = new Float64Array(nDOF); cR = new Float64Array(nDOF);
        }
        for (let i = 0; i < nDOF; i++) {
          cU[i] += f * res.u[i];
          cR[i] += f * res.reactions[i];
        }
        for (const [eid, ef] of res._elemForces) {
          if (!ef) continue;
          const cur = combinedEF.get(eid);
          if (!cur) combinedEF.set(eid, _scaleEF(ef, f));
          else      _addScaledEF(cur, ef, f);
        }
        any = true;
      }
    }

    if (!any) return null;
    return new Results(this.model, nodeIndex, cU, cR, new Float64Array(nDOF),
                       null, false, combinedEF.size ? combinedEF : null);
  }

  // Pre-computes diagram data for all elements in background chunks so the UI
  // stays responsive and the progress bar advances visibly.
  _precomputeDiagramsAsync(results) {
    // SpectrumResults (envelope) has no per-sub-element pre-computation
    if (!results || typeof results.precomputeChunk !== 'function') return;
    const TYPES    = ['N', 'Vy', 'Vz', 'T', 'My', 'Mz'];
    const NPTS     = 20;
    const CHUNK    = 12;   // elements per setTimeout slice
    const elemKeys = [...this.model.elements.keys()];
    const total    = elemKeys.length;
    if (total === 0) return;

    const progressEl = document.getElementById('sb-progress');
    const modeEl     = document.getElementById('sb-mode');
    if (progressEl) { progressEl.value = 0; progressEl.classList.remove('hidden'); }

    let i = 0;
    const tick = () => {
      i = results.precomputeChunk(elemKeys, TYPES, NPTS, i, CHUNK);
      const pct = Math.round(i / total * 100);
      if (progressEl) progressEl.value = pct;
      if (modeEl && i < total) modeEl.textContent = `Diagramas (${i}/${total})…`;

      if (i < total) {
        setTimeout(tick, 0);
      } else {
        if (progressEl) progressEl.classList.add('hidden');
        if (modeEl) modeEl.textContent = `${i18n.t('Modo:')} ${i18n.t('Resultados')}`;
        // Refresh force diagram if one is currently displayed
        const type = document.getElementById('result-type')?.value;
        if (type && type !== 'deformed') this._refreshResultView();
      }
    };
    setTimeout(tick, 30);
  }

  _refreshResultView(autoScale = false) {
    if (!this._results) return;
    this._renderResultCaseSelector();   // #103: keep the case selector synced
    this._syncResultTypeOptions();
    const type   = document.getElementById('result-type')?.value || 'deformed';
    // relative factor (1 = auto-normalized); null forces normalization
    const factor = autoScale ? null : (parseFloat(document.getElementById('result-scale')?.value) || null);

    if (type === 'deformed') {
      this.viewport.showDeformed(this._results, factor);
    } else if (type === 'vm') {
      this.viewport.showAreaStress(this._results);
    } else {
      this.viewport.showForceDiagram(this._results, type, factor);
    }
    // Reactions: re-draw with the values of the shown result
    if (this._showReactions) this.viewport.showReactions(this._results);
    this._updateViewToggleBtn();   // now in results mode → «Model view» button
  }

  // The «Stresses (von Mises)» option of the results selector only makes sense if the
  // model has area elements: it is hidden when there are none.
  _syncResultTypeOptions() {
    const opt = document.querySelector('#result-type option[value="vm"]');
    if (!opt) return;
    const hasAreas = this.model.areas && this.model.areas.size > 0;
    opt.hidden = !hasAreas;
    opt.disabled = !hasAreas;
    // If the active view was «vm» and there are no more areas, return to the deformed shape.
    if (!hasAreas && opt.selected) {
      const sel = document.getElementById('result-type');
      if (sel) sel.value = 'deformed';
    }
  }

  // Return to the model's NORMAL VIEW (#88): leaves results mode (deformed shape,
  // diagrams, contours, reactions) and closes the floating result overlays, but KEEPS
  // everything computed (`_results`, `_resultsByCase`, modal, NL, design, and the
  // auto-discretized model). Non-destructive — results can be re-shown from the
  // analysis hub. To DISCARD: `clearResults()`.
  exitResultsView() {
    if (!this.viewport._inResultsMode &&
        !['nlth-overlay', 'pl-overlay', 'th-overlay', 'ml-overlay', 'nl-overlay', 'buck-overlay', 'dc-overlay']
          .some(id => document.getElementById(id))) {
      this.toast('Ya estás en la vista del modelo', 'info'); return;
    }
    // Stop ongoing animations (without clearing the result data).
    this._nlthStopPlay?.(); this._plasticStopPlay?.(); this._thStopPlay?.(); this._dcStopPlay?.(); this._nlStopPlay?.();
    // Close the floating result overlays (the `_*Result` data persists).
    for (const id of ['nlth-overlay', 'pl-overlay', 'th-overlay', 'ml-overlay', 'nl-overlay', 'buck-overlay', 'dc-overlay'])
      document.getElementById(id)?.remove();
    // Exit the results render → normal (undeformed) model.
    this.viewport.clearResults();
    this._showReactions = false;
    this.viewport.clearReactions();
    document.getElementById('btn-show-reactions')?.classList.remove('active');
    this._updateViewToggleBtn();   // the button switches to «View results» (the data is kept)
    this.toast('Vista del modelo (los resultados se conservan — usa «Ver resultados» para volver)', 'ok');
  }

  // Toolbar button as a view TOGGLE (#88): «Model view» (cube) when results are shown,
  // «View results» (eye) when there are results but the model is shown, and hidden if
  // there is nothing to show.
  _updateViewToggleBtn() {
    const btn = document.getElementById('btn-clear-results'); if (!btn) return;
    const inRes  = !!this.viewport._inResultsMode;
    const hasRes = !!this._results;
    if (!inRes && !hasRes) { btn.style.display = 'none'; return; }
    btn.style.display = '';
    if (inRes) {
      btn.title = i18n.t('Volver a la vista normal del modelo (sale de deformada/diagramas/contornos CONSERVANDO los resultados). Para descartarlos: menú Análisis → Limpiar Resultados.');
      btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3 L21 7.5 V16.5 L12 21 L3 16.5 V7.5 Z"/><path d="M3 7.5 L12 12 L21 7.5 M12 12 V21"/></svg><span>${i18n.t('Vista modelo')}</span>`;
    } else {
      btn.title = i18n.t('Volver a ver los resultados calculados (deformada / diagramas) sin recalcular.');
      btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 12 C5 6, 19 6, 22 12 C19 18, 5 18, 2 12 Z"/><circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/></svg><span>${i18n.t('Ver resultados')}</span>`;
    }
  }

  // DESTRUCTIVE action with confirmation (#88): asks before discarding everything.
  async clearResultsConfirm() {
    const hay = this._results || this._modalResults || this._plasticResult || this._dcResult ||
                this._nlResult || this._pdResult || this._thResult || this._buckResult ||
                this._nlthResult || this._stagedResult || this._movingResult ||
                (this._spectrumResults && this._spectrumResults.size);
    if (!hay) { this.toast('No hay resultados que limpiar', 'info'); return; }
    const ok = await this._confirm('¿Descartar TODOS los resultados calculados (estático, modal, espectro, NL, diseño) y revertir la malla auto-discretizada?\n\nSi sólo quieres volver a ver el modelo sin borrar nada, usa «Vista modelo» en la barra.');
    if (ok) this.clearResults();
  }

  clearResults() {
    this._results       = null;
    this._resultsByCase = null;
    this._activeResultKey = this._activeLcId;
    this._modalResults = null;
    this._modalPlaying = false;
    this._spectrumResults.clear();
    this._buckResult = null;
    this._plasticResult = null;   // don't leave old hinges/pushover in the tab
    this._dcResult = null;
    this._nlResult = null;
    this._pdResult = null;
    this._thResult = null;
    this._thRuns = null;   // #104: forget the dynamic runs that were executed
    this._stagedResult = null;
    this._movingResult = null;
    this._nlthResult = null;
    this._nlthStopPlay?.();
    this._plasticStopPlay?.();
    this._thStopPlay?.();
    this._dcStopPlay?.();
    this._nlStopPlay?.();
    document.getElementById('pl-overlay')?.remove();
    this._thRenderPanel?.();   // #90: the «Dynamic» tab empties (shows the hint)
    this._dcRenderPanel?.();   // #90: same for the «Pushover» tab
    this._buckRenderPanel?.(); // #90: same for the «Buckling» tab
    this._nlRenderPanel?.();   // #90: same for the «Nonlinear» tab
    this._nlthRenderPanel?.(); // #90: same for the «NL Dynamic» tab
    this._movingRenderPanel?.(); // #90: same for the «Moving loads» tab
    this.viewport.clearResults();
    // Turn off the reactions visualization
    this._showReactions = false;
    this.viewport.clearReactions();
    document.getElementById('btn-show-reactions')?.classList.remove('active');
    // Restore the original model if the analysis auto-discretized it.
    // Reversible (#42): the current state is pushed to undo before replacing,
    // so Ctrl+Z recovers what there would be if the original were out of sync.
    if (this._predisc) {
      this.undoStack.push(this.serializer.toJSON(this.model));
      this.model = this.serializer.fromJSON(this._predisc);
      this._predisc = null;
      this.viewport.renderModel(this.model);
      this._updateStats();
    }
    this._renderLcSelector();
    this.refreshLoads();
    document.getElementById('sb-mode').textContent = `${i18n.t('Modo:')} ${i18n.t('Seleccionar')}`;
    document.getElementById('modal-analysis-overlay')?.classList.add('hidden');
    this._updateViewToggleBtn();   // no results → button hidden
    this.panel.showNothing();
    this._updateResultsIndicator();
  }

  refreshLoads() {
    if (typeof this.viewport.showLoads === 'function') {
      this.viewport.showLoads(this.model, this._activeLcId);
    }
  }

  setResultType(type) {
    if (!this._results && !this._modalResults) return;
    const sel = document.getElementById('result-type');
    if (sel) sel.value = type;
    // Re-normalize on changing type (each diagram is born well-sized).
    if (this._results) this._refreshResultView(true);
  }

  exportResults() {
    if (!this._results) { this.toast('No hay resultados — ejecute el análisis primero', 'warn'); return; }
    const csv = this._results.toCSV(i18n.t);
    const name = (this._resultCaseLabel(this._activeResultKey) || 'resultados').replace(/[^\w\-]+/g, '_');
    this._downloadText(csv, `resultados_${name}.csv`, 'text/csv;charset=utf-8');
    this.toast(`${i18n.t('Resultados de')} «${this._resultCaseLabel(this._activeResultKey) || '—'}» ${i18n.t('exportados (CSV)')}`, 'ok');
  }

  // #103: human-readable label for a _resultsByCase key (numeric id = case; 'C'+id = combo).
  _resultCaseLabel(key) {
    if (key == null) return '';
    if (typeof key === 'string' && key.startsWith('C')) { const c = this.model.combinations.get(+key.slice(1)); return c ? 'Σ ' + c.name : key; }
    const lc = this.model.loadCases.get(+key);
    if (!lc) return String(key);
    return lc.type === 'spectrum' ? `〜 ${lc.name} [esp ${lc.specDir}]` : lc.name;
  }

  // Fills the results-bar case selector with what ALREADY has a result.
  _renderResultCaseSelector() {
    const sel = document.getElementById('res-case'); if (!sel) return;
    const map = this._resultsByCase;
    if (!map || !map.size) { sel.innerHTML = '<option>—</option>'; sel.disabled = true; return; }
    sel.disabled = false;
    const active = this._activeResultKey ?? this._activeLcId;
    sel.innerHTML = [...map.keys()].map(k => `<option value="${k}" ${String(k) === String(active) ? 'selected' : ''}>${esc(this._resultCaseLabel(k) || k)}</option>`).join('');
  }

  // Changes the shown case/combination from the results bar.
  _showResultCase(key) {
    if (key == null) return;
    if (typeof key === 'string' && key.startsWith('C')) { this.runCombination(+key.slice(1)); return; }
    const k = +key;
    if (!this._resultsByCase?.has(k)) { this.toast('Ese caso aún no tiene resultados (córrelo primero)', 'warn'); return; }
    this._activeLcId = k; this._activeResultKey = k;
    this._results = this._resultsByCase.get(k);
    this._refreshResultView(true);
    this.refreshLoads();
    this._renderLcSelector();
  }

  // ── Modal analysis ─────────────────────────────────────────────────────────
  async runModal(opts = {}) {
    if (this.model.nodes.size === 0 || (this.model.elements.size === 0 && (this.model.areas?.size || 0) === 0)) {
      this.toast('El modelo debe tener nodos y elementos (barras o áreas)', 'warn'); return;
    }
    const hasSupport = [...this.model.nodes.values()]
      .some(n => Object.values(n.restraints).some(v => v) ||
                 (n.springs && Object.values(n.springs).some(k => k > 0)));
    if (!hasSupport) {
      this.toast('El modelo no tiene apoyos', 'warn'); return;
    }
    // Exit results mode (e.g. static deformed shape) before running the modal, to do
    // it "from outside" on the clean model.
    if (this.viewport._inResultsMode) this.viewport.clearResults();

    // HTML modal instead of native prompt(); in batch, default values (#38).
    const modalOpts = opts.silent
      ? { nModes: this._lastNModes || this._defaultNModes(), method: this._modalMethod || 'subspace', useKg: false }
      : await this._modalNModesDialog();
    if (!modalOpts) return;
    const { nModes, method: modalMethod, useKg, pattern } = modalOpts;
    // Solver mode (fast banded vs complete dense) is a GLOBAL setting (Configuración),
    // shared by modal and time-history — not a per-run choice.
    const modalDense = !!this._config?.analisis?.matrizDensa;
    this._lastNModes = nModes;

    const btn = document.getElementById('btn-run');
    if (btn) btn.classList.add('running');
    document.getElementById('sb-mode').textContent = i18n.t('Análisis modal…');
    this._showProgress('Analizando…', 'Resolviendo el problema de autovalores K·φ = ω²·M·φ (en segundo plano)');
    await new Promise(r => setTimeout(r, 20));   // let the box paint before assembling

    try {
      // ×N auto-discretization (same as static) for the modal (#36).
      this._applyAutoDiscIfEnabled();

      // ── Assemble stiffness / mass on main thread ─────────────────────────────
      const nodeIndex = buildNodeIndex(this.model);
      const { K, M, nDOF } = assembleK(this.model, nodeIndex);

      // Extract free DOFs (in 2D models, uy/rx/rz are restrained)
      const is2D = this.model.mode === '2D';
      const freeDOF = [];
      for (const node of this.model.nodes.values()) {
        const d = getNodeDOFs(nodeIndex, node.id);
        const r = node.restraints;
        [r.ux, is2D ? 1 : r.uy, r.uz, is2D ? 1 : r.rx, r.ry, is2D ? 1 : r.rz].forEach((fixed, li) => {
          if (!fixed) freeDOF.push(d[li]);
        });
      }
      if (freeDOF.length === 0) throw new Error('No hay grados de libertad libres.');
      const nF = freeDOF.length;

      // Build Kff / Mff as flat Float64Arrays for zero-copy transfer to worker
      const Kff_flat = new Float64Array(nF * nF);
      const Mff_flat = new Float64Array(nF * nF);
      for (let i = 0; i < nF; i++) {
        for (let j = 0; j < nF; j++) {
          Kff_flat[i * nF + j] = K[freeDOF[i] * nDOF + freeDOF[j]];
          Mff_flat[i * nF + j] = M[freeDOF[i] * nDOF + freeDOF[j]];
        }
      }

      // ── #55: geometric stiffness from a reference state (P-Δ / pre-stress).
      // Modal on (K + Kg) vs M: tension stiffens and compression softens the
      // frequencies. Kg is evaluated with the u of the reference state (like SAP2000).
      let kgInfo = '';
      if (useKg) {
        const { contribs, label } = this._resolvePattern(pattern);
        const Fref = new Float64Array(nDOF);
        for (const c of contribs) {
          const Fi = assembleF(this.model, nodeIndex, c.lcId, !!c.selfWeight);
          for (let i = 0; i < nDOF; i++) Fref[i] += c.factor * Fi[i];
        }
        const Ff = new Float64Array(nF);
        for (let i = 0; i < nF; i++) Ff[i] = Fref[freeDOF[i]];
        const fac = makeFactor(Kff_flat, nF, modalDense);
        if (!fac.ok) throw new Error('El estado de referencia para Kg es singular/inestable. Revise apoyos.');
        const uf = fac.solve(Ff);
        const u = new Float64Array(nDOF); for (let i = 0; i < nF; i++) u[freeDOF[i]] = uf[i];
        const { Kg, Nmax } = assembleKg(this.model, nodeIndex, u);
        if (Nmax < 1e-9) throw new Error('El estado de referencia no genera fuerzas axiales (sin efecto P-Δ).');
        for (let i = 0; i < nF; i++) { const ri = freeDOF[i] * nDOF; for (let j = 0; j < nF; j++) Kff_flat[i * nF + j] += Kg[ri + freeDOF[j]]; }
        kgInfo = ` · con Kg(${label})`;
      }

      // ── #5: Guyan condensation of the MASSLESS DOFs before the worker ────────
      // Avoids spurious modes (ρ=0, rotations with no inertia). Only activates if there
      // are genuinely massless DOFs; normal models pass through intact. Condensed on the
      // dense matrices and the modes are re-expanded on returning from the worker.
      let postK = Kff_flat, postM = Mff_flat, postN = nF, expandGuyan = null;
      try {
        const num = window.numeric;
        let maxMd = 0; for (let i = 0; i < nF; i++) maxMd = Math.max(maxMd, Math.abs(Mff_flat[i * nF + i]));
        let hasSlave = false; const thr = maxMd * 1e-6;
        if (num && maxMd > 0) for (let i = 0; i < nF; i++) if (Math.abs(Mff_flat[i * nF + i]) <= thr) { hasSlave = true; break; }
        if (hasSlave) {
          const K2 = [], M2 = [];
          for (let i = 0; i < nF; i++) { const kr = new Array(nF), mr = new Array(nF); for (let j = 0; j < nF; j++) { kr[j] = Kff_flat[i * nF + j]; mr[j] = Mff_flat[i * nF + j]; } K2.push(kr); M2.push(mr); }
          const red = guyanReduce(K2, M2, nF, maxMd, num);
          if (red) {
            const nM = red.nM, Kr = new Float64Array(nM * nM), Mr = new Float64Array(nM * nM);
            for (let i = 0; i < nM; i++) for (let j = 0; j < nM; j++) { Kr[i * nM + j] = red.Kr[i][j]; Mr[i * nM + j] = red.Mr[i][j]; }
            postK = Kr; postM = Mr; postN = nM; expandGuyan = red.expand;
          }
        }
      } catch (e) { console.warn('Guyan omitido:', e); }

      // ── Run Stodola in a Web Worker (non-blocking) ───────────────────────────
      // dense = "complete/heavy" (dense factorization, no reordering); banded =
      // "fast optimized" (banded Cholesky + RCM). Selectable per run.
      const denseModal = modalDense;
      let modes = await new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./solver/modal_worker.js?v=2', import.meta.url), { type: 'module' });
        worker.postMessage({ Kff_flat: postK, Mff_flat: postM, nF: postN, nModes, dense: denseModal, method: modalMethod },
          [postK.buffer, postM.buffer]); // transfer — zero copy
        worker.onmessage = (ev) => {
          worker.terminate();
          if (ev.data.error) reject(new Error(ev.data.error));
          else               resolve(ev.data.modes);
        };
        worker.onerror = (ev) => {
          worker.terminate();
          reject(new Error(ev.message || 'Error en worker modal'));
        };
      });
      if (expandGuyan) modes = modes.map(m => ({ omega2: m.omega2, vec: expandGuyan(m.vec) }));

      this._modalResults = new ModalResults(this.model, nodeIndex, freeDOF, modes, M, nDOF);
      this._modalMode    = 0;
      this._modalPlaying = false;

      const f1 = this._modalResults.freq[0].toFixed(3);
      const T1 = this._modalResults.period[0].toFixed(3);
      this.toast(
        `Modal OK — ${this._modalResults.nModes} modos | f₁=${f1} Hz | T₁=${T1} s${kgInfo}`, 'ok'
      );

      this._setupModalOverlay();
      this._refreshModalView();
      this.panel._switchVTab('results');
      this.panel._switchRTab('modal');
      this.panel.renderModalResults();
      this._updateResultsIndicator();
    } catch (err) {
      this.toast(`Error modal: ${err.message}`, 'error');
      console.error(err);
    } finally {
      if (btn) btn.classList.remove('running');
      this._hideProgress();
      document.getElementById('sb-mode').textContent = `${i18n.t('Modo:')} Modal`;
    }
  }

  /** Default number of modes: max(12, 3·number of diaphragms) — 3 modes per rigid
   *  diaphragm (2 translations + rotation), with a floor of 12. */
  _defaultNModes() {
    return Math.max(12, 3 * (this.model.diaphragms?.size || 0));
  }

  /** HTML modal dialog — ask for number of modes (replaces native prompt). */
  _modalNModesDialog() {
    return new Promise(resolve => {
      const overlay = document.getElementById('modal-overlay');
      document.getElementById('modal-title').textContent = i18n.t('Análisis Modal');
      document.getElementById('modal-cancel').style.display = '';
      const lastMethod = this._modalMethod || 'stodola';
      const defModes = this._lastNModes || this._defaultNModes();
      document.getElementById('modal-body').innerHTML = `
        <div class="prop-row">
          <div class="prop-field">
            <label>Número de modos a extraer (1–50)</label>
            <input type="number" id="modal-nmodes" value="${defModes}" min="1" max="50" step="1"
              style="width:90px">
          </div>
          <div class="prop-field" style="justify-content:flex-end">
            <span style="color:var(--text-muted);font-size:11px">
              Recomendado:<br>≥ 3 × número de pisos.
            </span>
          </div>
        </div>
        <div class="prop-row cols1" style="margin-top:8px">
          <div class="prop-field">
            <label>Método de extracción</label>
            <select id="modal-method" style="width:100%">
              <option value="stodola" ${lastMethod === 'stodola' ? 'selected' : ''}>Iteración inversa (Stodola) — robusto, modo a modo</option>
              <option value="subspace" ${lastMethod === 'subspace' ? 'selected' : ''}>Iteración de subespacio (Bathe) — bloque, rápido con muchos modos</option>
            </select>
          </div>
        </div>
        <div class="prop-row cols1" style="margin-top:10px">
          <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer" title="Modal sobre K+Kg(estado): la fuerza axial del estado de referencia rigidiza (tracción) o ablanda (compresión) las frecuencias. Como en SAP2000 (modal sobre un caso no lineal).">
            <input type="checkbox" id="modal-usekg" ${this._modalUseKg ? 'checked' : ''}> Incluir rigidez geométrica P-Δ (pre-esfuerzo)
          </label>
        </div>
        <div class="prop-row cols1" id="modal-kg-pat" style="margin-top:6px;${this._modalUseKg ? '' : 'display:none'}">
          <div class="prop-field">
            <label>Estado de referencia (carga que genera Kg)</label>
            ${this._patternSelectHTML('modal-pattern')}
          </div>
        </div>`;
      overlay.classList.remove('hidden');
      setTimeout(() => {
        const el = document.getElementById('modal-nmodes');
        el?.focus(); el?.select();
        document.getElementById('modal-usekg')?.addEventListener('change', (e) => {
          const pat = document.getElementById('modal-kg-pat');
          if (pat) pat.style.display = e.target.checked ? '' : 'none';
        });
      }, 50);
      overlay._resolve = () => {
        const v = parseInt(document.getElementById('modal-nmodes')?.value) || 10;
        const method = document.getElementById('modal-method')?.value || 'stodola';
        const useKg = !!document.getElementById('modal-usekg')?.checked;
        const pattern = document.getElementById('modal-pattern')?.value || 'all';
        this._modalMethod = method;
        this._modalUseKg = useKg;
        if (useKg) this._lastPattern = pattern;
        resolve({ nModes: Math.max(1, Math.min(50, v)), method, useKg, pattern });
      };
      overlay._reject = () => resolve(null);
    });
  }

  /** Generic single-input prompt modal (replaces native prompt). */
  _promptModal(title, label, defaultValue = '') {
    return new Promise(resolve => {
      const overlay = document.getElementById('modal-overlay');
      document.getElementById('modal-title').textContent = title;
      document.getElementById('modal-cancel').style.display = '';
      document.getElementById('modal-body').innerHTML = `
        <div class="prop-field">
          <label>${label}</label>
          <input type="text" id="modal-prompt-inp" value="${defaultValue}"
            style="width:100%;margin-top:4px">
        </div>`;
      overlay.classList.remove('hidden');
      setTimeout(() => {
        const el = document.getElementById('modal-prompt-inp');
        el?.focus(); el?.select();
      }, 50);
      overlay._resolve = () => {
        const v = document.getElementById('modal-prompt-inp')?.value?.trim();
        resolve(v || null);
      };
      overlay._reject = () => resolve(null);
    });
  }

  _setupModalOverlay() {
    const mr  = this._modalResults;
    const sel = document.getElementById('modal-mode-select');
    if (!sel) return;

    // Populate mode selector
    sel.innerHTML = '';
    for (let i = 0; i < mr.nModes; i++) {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = `Modo ${i+1}  (${mr.freq[i].toFixed(3)} Hz)`;
      sel.appendChild(opt);
    }
    sel.value = '0';

    // Show overlay
    document.getElementById('modal-analysis-overlay').classList.remove('hidden');
    document.getElementById('results-overlay').classList.add('hidden');
    this._updateViewToggleBtn();

    // Bind events (remove old listeners by cloning)
    const bindBtn = (id, fn) => {
      const el = document.getElementById(id);
      if (!el) return;
      const fresh = el.cloneNode(true);
      el.parentNode.replaceChild(fresh, el);
      fresh.addEventListener('click', fn);
    };

    // Use property assignment to avoid listener accumulation on repeated runs
    sel.onchange = e => {
      this._modalMode = +e.target.value;
      if (this._modalPlaying) this.viewport.stopAnimation(this._modalAmp());
      this._modalPlaying = false;
      const pb = document.getElementById('modal-play-btn');
      if (pb) { pb.textContent = '▶'; pb.classList.remove('playing'); }
      this._refreshModalView();
    };

    bindBtn('modal-play-btn', () => this._toggleModalAnimation());
    bindBtn('modal-table-btn', () => this._showParticipationTable());
    bindBtn('modal-export-btn', () => this.exportModalResults());

    const ampEl = document.getElementById('modal-amp');
    if (ampEl) ampEl.oninput = () => { if (!this._modalPlaying) this._refreshModalView(); };
  }

  _modalAmp() {
    return Math.max(0.01, parseFloat(document.getElementById('modal-amp')?.value) || 1);
  }

  _refreshModalView() {
    if (!this._modalResults) return;
    const mr   = this._modalResults;
    const mi   = this._modalMode;
    const amp  = this._modalAmp();

    // Auto-scale: amp × (model span / 5)
    const b    = this.model.getBounds();
    const span = Math.max(b.max.x-b.min.x, b.max.y-b.min.y, b.max.z-b.min.z, 1);
    const scale = amp * span / 5;

    this.viewport.showModeShape(mr, mi, scale);

    // Update freq / period display
    document.getElementById('modal-freq-val').textContent   = mr.freq[mi].toFixed(4);
    document.getElementById('modal-period-val').textContent = mr.period[mi].toFixed(4);

    // Keep mode selector in sync
    const sel = document.getElementById('modal-mode-select');
    if (sel) sel.value = mi;
  }

  _toggleModalAnimation() {
    if (!this._modalResults) return;
    const btn   = document.getElementById('modal-play-btn');
    const speed = parseFloat(document.getElementById('modal-speed')?.value) || 1;
    const b     = this.model.getBounds();
    const span  = Math.max(b.max.x-b.min.x, b.max.y-b.min.y, b.max.z-b.min.z, 1);
    const scale = this._modalAmp() * span / 5;

    if (this._modalPlaying) {
      this.viewport.stopAnimation(scale);
      this._modalPlaying = false;
      if (btn) { btn.textContent = '▶'; btn.classList.remove('playing'); }
    } else {
      this._refreshModalView();
      this.viewport.startModeAnimation(scale, speed);
      this._modalPlaying = true;
      if (btn) { btn.textContent = '⏸'; btn.classList.add('playing'); }
    }
  }

  _showParticipationTable() {
    if (!this._modalResults) return;
    const { rows } = this._modalResults.getParticipation();

    const header = `
      <tr>
        <th style="text-align:center">#</th>
        <th>f (Hz)</th><th>T (s)</th>
        <th>X (%)</th><th>Y (%)</th><th>Rz (%)</th>
        <th>ΣX</th><th>ΣY</th><th>ΣRz</th>
      </tr>`;

    const bodyRows = rows.map(r => {
      const cx = r.cumPct[0], cy = r.cumPct[1], crz = r.cumPct[2];
      const cuOk  = pct => pct >= 90 ? 'cum-ok' : pct >= 70 ? 'cum-warn' : '';
      return `<tr>
        <td>${r.mode}</td>
        <td>${r.freq.toFixed(4)}</td>
        <td>${r.period.toFixed(4)}</td>
        <td>${r.pct[0].toFixed(1)}</td>
        <td>${r.pct[1].toFixed(1)}</td>
        <td>${r.pct[2].toFixed(1)}</td>
        <td class="${cuOk(cx)}">${cx.toFixed(1)}</td>
        <td class="${cuOk(cy)}">${cy.toFixed(1)}</td>
        <td class="${cuOk(crz)}">${crz.toFixed(1)}</td>
      </tr>`;
    }).join('');

    this._alert(
      'Participación de masas modales',
      `<table class="modal-part-table"><thead>${header}</thead><tbody>${bodyRows}</tbody></table>
       <p style="margin-top:8px;font-size:11px;color:var(--text-muted)">
         ${i18n.t('Verde ≥ 90% — cumple criterio sísmico mínimo de masa participante.')}</p>`
    );
  }

  exportModalResults() {
    if (!this._modalResults) {
      this.toast('No hay resultados modales — ejecute Análisis Modal primero', 'warn'); return;
    }
    const csv = this._modalResults.toCSV(i18n.t);
    this._downloadText(csv, 'resultados_modales.csv', 'text/csv;charset=utf-8');
    this.toast('Resultados modales exportados', 'ok');
  }

  exportSpectrumResults() {
    if (!this._results?.toCSV || !this._results?.meta) {
      this.toast('No hay resultados espectrales — ejecute Espectro de Respuesta primero', 'warn'); return;
    }
    const csv = this._results.toCSV(i18n.t);
    this._downloadText(csv, 'resultados_espectrales.csv', 'text/csv;charset=utf-8');
    this.toast('Resultados espectrales exportados', 'ok');
  }

  // ── Response spectrum analysis ─────────────────────────────────────────────
  async runSpectrum(opts = {}) {
    if (!this._modalResults) {
      this.toast('Ejecute primero el Análisis Modal (F6)', 'warn'); return;
    }

    // No preloaded curve: the spectrum is generated by the user (NCh433 button, already
    // with T* from the modal) or typed. This way nothing looks "already computed".
    const defaultText = this._lastSpectrum || '';

    // In batch (#38) the last defined curve is reused; if there is none, it is skipped
    // (the spectrum requires a Sa(T) curve the user must set once).
    let params;
    if (opts.silent) {
      if (!this._lastSpectrumParams) { this.toast('Espectro omitido en el lote: defínalo una vez manualmente para fijar la curva.', 'warn'); return; }
      params = this._lastSpectrumParams;
    } else {
      params = await this._spectrumDialog(defaultText);
    }
    if (!params) return;
    this._lastSpectrum = params.rawText;
    this._lastSpectrumParams = params;

    // «Accept» in the dialog: only creates/updates the load case, no solver.
    if (!opts.silent && params.action === 'accept') {
      const specLc = this._saveSpectrumCase(params);
      this._lastSpectrumParams.targetLcId = specLc.id;
      this._renderLcSelector();
      this.panel?.renderCombinations?.();
      this.toast(`${i18n.t('Caso')} «${specLc.name}» ${i18n.t('guardado sin calcular. Use «Calcular» (o F7) para correrlo.')}`, 'ok');
      return;
    }

    const btn = document.getElementById('btn-run');
    if (btn) btn.classList.add('running');
    document.getElementById('sb-mode').textContent = i18n.t('Espectro…');
    this._showProgress('Analizando…', 'Combinando respuestas modales (espectro de respuesta)');

    return new Promise(resolve => setTimeout(async () => {
      try {
        this._results = await solverRegistry.solveSpectrum(this._modalResults, params);

        // Store by direction so combos can reference it (legacy [ESP])
        this._spectrumResults.set('esp' + params.direction, { result: this._results, params });
        this._updateResultsIndicator();

        // ── Assign the result to its spectral LOAD CASE ──
        // Creates or updates the spectral case (selector, combos, file) with no solver
        // — same logic as the dialog's «Create»/«Accept». In batch/silent it is reused
        // by direction (no duplication).
        const specLc = this._saveSpectrumCase(params);
        // Sets the case as the target for later reuses (batch / reopening the dialog).
        if (this._lastSpectrumParams) this._lastSpectrumParams.targetLcId = specLc.id;
        this._resultsByCase ??= new Map();
        this._resultsByCase.set(specLc.id, this._results);
        this._activeResultKey = specLc.id;
        this._renderLcSelector();

        const sum = this._results.getSummary();
        const { direction, method } = params;
        this.toast(
          `Espectro ${direction} ${method} → caso "${specLc.name}" | δmax=${sum.maxU.toExponential(3)}`,
          'ok'
        );

        document.getElementById('result-type').value = 'deformed';
        this._refreshResultView(true);
        document.getElementById('result-summary').textContent =
          `Espectro Dir-${direction} (${method}, ζ=${(params.zeta*100).toFixed(0)}%) | δmax=${sum.maxU.toExponential(3)}`;
        document.getElementById('modal-analysis-overlay')?.classList.add('hidden');

        // Show spectral results in sidebar
        this.panel._switchVTab('results');
        this.panel._switchRTab('estatico');
        this.panel.renderStaticResults();
        this.panel.renderCombinations(); // refresh combo dropdowns with new spectral case
      } catch (err) {
        this.toast(`Error espectro: ${err.message}`, 'error');
        console.error(err);
      } finally {
        if (btn) btn.classList.remove('running');
        this._hideProgress();
        document.getElementById('sb-mode').textContent = `${i18n.t('Modo:')} ${i18n.t('Espectro')}`;
        resolve();
      }
    }, 20));
  }

  // ── G12 · TIME-domain dynamic analysis (linear modal time-history) #48 ───────
  // Modal (subspace, in worker) → participation factor Γ per mode for the excitation
  // direction → Duhamel integration (Nigam–Jennings) per mode in a worker →
  // superposition u(t)=Σφᵢqᵢ(t). Uniform base excitation.
  async runTimeHistory(opts = {}) {
    const model = this.model;
    if (model.nodes.size === 0 || (model.elements.size === 0 && (model.areas?.size || 0) === 0)) {
      this.toast('El modelo debe tener nodos y elementos', 'warn'); return;
    }
    const hasSupport = [...model.nodes.values()].some(n =>
      Object.values(n.restraints).some(v => v) || (n.springs && Object.values(n.springs).some(k => k > 0)));
    if (!hasSupport) { this.toast('El modelo no tiene apoyos', 'warn'); return; }

    const thOpts = opts.silent ? this._thDefaults() : await this._timeHistoryDialog();
    if (!thOpts) return;
    const { dir, zeta, nModes, ag, dt, agName } = thOpts;
    if (!ag || ag.length < 2) { this.toast('Acelerograma vacío o no reconocido.', 'warn'); return; }
    this._lastTH = { dir, zeta, nModes };

    if (this.viewport._inResultsMode) this.viewport.clearResults();
    const btn = document.getElementById('btn-run'); if (btn) btn.classList.add('running');
    document.getElementById('sb-mode').textContent = i18n.t('Time-history…');
    this._showProgress('Time-history…', 'Modal + integración de Duhamel por modo (en segundo plano)');
    await new Promise(r => setTimeout(r, 20));
    try {
      this._applyAutoDiscIfEnabled();
      const nodeIndex = buildNodeIndex(model);
      const { K, M, nDOF } = assembleK(model, nodeIndex);
      const is2D = model.mode === '2D';
      const freeDOF = [];
      for (const node of model.nodes.values()) {
        const d = getNodeDOFs(nodeIndex, node.id), r = node.restraints;
        [r.ux, is2D ? 1 : r.uy, r.uz, is2D ? 1 : r.rx, r.ry, is2D ? 1 : r.rz].forEach((fx, li) => { if (!fx) freeDOF.push(d[li]); });
      }
      if (!freeDOF.length) throw new Error('No hay GDL libres.');
      const nF = freeDOF.length;
      const Kff = new Float64Array(nF * nF), Mff = new Float64Array(nF * nF);
      for (let i = 0; i < nF; i++) { const ri = freeDOF[i] * nDOF; for (let j = 0; j < nF; j++) { Kff[i * nF + j] = K[ri + freeDOF[j]]; Mff[i * nF + j] = M[ri + freeDOF[j]]; } }

      // Modal by subspace iteration in a worker (doesn't block the UI).
      const dense = !!this._config?.analisis?.matrizDensa;
      const rawModes = await new Promise((resolve, reject) => {
        const w = new Worker(new URL('./solver/modal_worker.js?v=2', import.meta.url), { type: 'module' });
        w.postMessage({ Kff_flat: Kff, Mff_flat: Mff, nF, nModes, dense, method: 'subspace' }, [Kff.buffer, Mff.buffer]);
        w.onmessage = ev => { w.terminate(); ev.data.error ? reject(new Error(ev.data.error)) : resolve(ev.data.modes); };
        w.onerror = ev => { w.terminate(); reject(new Error(ev.message || 'Error en worker modal')); };
      });
      if (!rawModes.length) throw new Error('Sin modos (¿masa nula? asigne ρ al material o masa al diafragma).');

      // Influence vector r (unit at the direction's translational DOF) and M·r.
      const dirComp = dir === 'X' ? 0 : dir === 'Y' ? 1 : 2;
      const dirDofs = [];
      for (const node of model.nodes.values()) dirDofs.push(getNodeDOFs(nodeIndex, node.id)[dirComp]);
      const Mr = new Float64Array(nDOF);
      for (let i = 0; i < nDOF; i++) { let s = 0; const ri = i * nDOF; for (const dd of dirDofs) s += M[ri + dd]; Mr[i] = s; }

      // Per mode: φ (nDOF), generalized mass, Γ = (φᵀMr)/(φᵀMφ), ω.
      const modes = rawModes.map(m => {
        const phi = new Float64Array(nDOF);
        for (let i = 0; i < nF; i++) phi[freeDOF[i]] = m.vec[i];
        // M·φ and genMass
        let genM = 0, L = 0;
        for (let i = 0; i < nDOF; i++) {
          let mp = 0; const ri = i * nDOF; for (let j = 0; j < nF; j++) mp += M[ri + freeDOF[j]] * m.vec[j];
          genM += phi[i] * mp; L += phi[i] * Mr[i];
        }
        const omega = Math.sqrt(Math.max(m.omega2 ?? (m.omega * m.omega), 0));
        return { omega, gamma: genM > 1e-30 ? L / genM : 0, phi };
      });

      // Duhamel integration per mode in a worker.
      const { q, peakModal } = await this._thSolveInWorker(modes.map(m => ({ omega: m.omega, gamma: m.gamma })), ag, dt, zeta);

      // Monitor node/DOF: the translational DOF (in the direction) with the largest peak response.
      const nSteps = ag.length;
      let monitorDOF = freeDOF[0], monitorNodeId = null, peakU = -1;
      for (const node of model.nodes.values()) {
        const d = getNodeDOFs(nodeIndex, node.id)[dirComp];
        // only free DOFs
        let isFree = false; for (let i = 0; i < nF; i++) if (freeDOF[i] === d) { isFree = true; break; }
        if (!isFree) continue;
        let pk = 0;
        for (let k = 0; k < nSteps; k++) { let u = 0; for (let i = 0; i < modes.length; i++) u += modes[i].phi[d] * q[i][k]; const au = Math.abs(u); if (au > pk) pk = au; }
        if (pk > peakU) { peakU = pk; monitorDOF = d; monitorNodeId = node.id; }
      }

      const stats = accStats(ag, dt);
      this._thResult = { dt, q, peakModal, modes, nodeIndex, freeDOF, nF, dir, zeta, ag, agName, nSteps, monitorDOF, monitorNodeId, stats, peakU };
      // #104: remember each run record as a re-selectable dynamic «case».
      this._thRuns ??= new Map();
      let label = `${agName} · ${dir}`, k = 1; while (this._thRuns.has(label) && this._thRuns.get(label) !== this._thResult) { k++; label = `${agName} · ${dir} (${k})`; }
      this._thResult._label = label; this._thRuns.set(label, this._thResult);
      const f1 = (modes[0].omega / (2 * Math.PI)).toFixed(3), T1 = (2 * Math.PI / modes[0].omega).toFixed(3);
      this.toast(`Time-history OK · ${modes.length} ${i18n.t('modos')} · ${dir} · PGA ${stats.pga.toFixed(2)} m/s² · u_máx ${peakU.toExponential(2)} m (${i18n.t('nodo')} ${monitorNodeId}) · T₁=${T1}s`, 'ok');
      this._thOpenOverlay();
      this._updateResultsIndicator();
    } catch (err) {
      this.toast(`${i18n.t('Time-history:')} ${i18n.t(err.message)}`, 'error'); console.error(err);
    } finally {
      if (btn) btn.classList.remove('running');
      this._hideProgress();
      document.getElementById('sb-mode').textContent = `${i18n.t('Modo:')} Time-history`;
    }
  }

  _thDefaults() {
    const d = this._lastTH || {};
    const demo = DEMO_PRESETS.synthetic();
    return { dir: d.dir || 'X', zeta: d.zeta ?? 0.05, nModes: d.nModes || this._defaultNModes(), ag: demo.a, dt: demo.dt, agName: demo.name };
  }

  // Integrates the modal coordinates in a Web Worker (fallback to the main thread).
  _thSolveInWorker(modes, ag, dt, zeta) {
    return new Promise((resolve, reject) => {
      let w;
      try { w = new Worker(new URL('./solver/timehistory_worker.js?v=2', import.meta.url), { type: 'module' }); }
      catch (e) {
        try { solverRegistry.solveTimeHistoryModal({ modes: modes.map(m => ({ ...m, phi: new Float64Array(0) })), ag, dt, zeta }).then(r => resolve({ q: r.q, peakModal: r.peakModal }), reject); }
        catch (err) { reject(err); }
        return;
      }
      w.onmessage = ev => { w.terminate(); ev.data.error ? reject(new Error(ev.data.error)) : resolve(ev.data); };
      w.onerror = ev => { w.terminate(); reject(new Error(ev.message || 'Error en worker time-history')); };
      w.postMessage({ modes, ag, dt, zeta });
    });
  }

  // Time history of a global DOF (modal superposition).
  _thNodalDOF(dof) {
    const { q, modes, nSteps } = this._thResult;
    const h = new Float64Array(nSteps);
    for (let i = 0; i < modes.length; i++) { const c = modes[i].phi[dof], qi = q[i]; if (!c) continue; for (let k = 0; k < nSteps; k++) h[k] += c * qi[k]; }
    return h;
  }

  // Full displacement vector at step `step`.
  _thUAt(step) {
    const { q, modes, nodeIndex } = this._thResult;
    const nDOF = nodeIndex.size * 6, u = new Float64Array(nDOF);
    for (let i = 0; i < modes.length; i++) { const qi = q[i][step]; if (!qi) continue; const phi = modes[i].phi; for (let d = 0; d < nDOF; d++) u[d] += phi[d] * qi; }
    return u;
  }

  /** HTML dialog — seismic mass source: which load cases (× factors) become mass. */
  _massSourceDialog() {
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = i18n.t('Fuente de masa sísmica (peso → masa)');
    document.getElementById('modal-cancel').style.display = '';
    const ms = this.model.massSource || { enabled: false, g: 9.80665, selfWeight: false, entries: [] };
    const entryOf = id => (ms.entries || []).find(x => x.lcId === id);
    const lcRows = [...this.model.loadCases.values()].map(lc => {
      const e = entryOf(lc.id);
      return `<div class="prop-row" style="align-items:center;gap:8px">
        <label style="flex:1;display:flex;align-items:center;gap:6px">
          <input type="checkbox" class="msrc-lc" data-lc="${lc.id}" ${e ? 'checked' : ''}>
          <span>${lc.name || ('LC' + lc.id)}</span></label>
        <div class="prop-field" style="width:120px"><label>Factor</label>
          <input type="number" class="msrc-f" data-lc="${lc.id}" value="${e ? e.factor : 1}" step="0.05" min="0" style="width:90px"></div>
      </div>`;
    }).join('') || `<div style="color:var(--text-muted);font-size:12px">No hay casos de carga. Crea casos (p.ej. D, L) con cargas gravitacionales para usarlos como masa.</div>`;
    document.getElementById('modal-body').innerHTML = `
      <div class="prop-row cols1"><label style="display:flex;align-items:center;gap:6px">
        <input type="checkbox" id="msrc-enabled" ${ms.enabled ? 'checked' : ''}>
        <b>Activar fuente de masa</b></label></div>
      <div style="color:var(--text-muted);font-size:11px;margin:2px 0 8px;line-height:1.5">
        La componente vertical (−Z) de cada caso × su factor se reparte a los nodos (regla tributaria) y se convierte en masa m = W/g, activa en X, Y y Z. Así el peso muerto/sobrecarga participa en modal, espectro y time-history.</div>
      ${lcRows}
      <div class="prop-row" style="margin-top:8px">
        <label style="flex:1;display:flex;align-items:center;gap:6px"><input type="checkbox" id="msrc-sw" ${ms.selfWeight ? 'checked' : ''}> Incluir peso propio (ρ·A·L)</label>
        <div class="prop-field" style="width:140px"><label>g (m/s²)</label><input type="number" id="msrc-g" value="${ms.g || 9.80665}" step="0.001" min="0.001" style="width:100px"></div>
      </div>
      <div style="color:var(--text-muted);font-size:11px;margin-top:6px">Si el material ya tiene densidad ρ&gt;0, su masa estructural ya está incluida — no marques «peso propio» para no duplicarla.</div>`;
    overlay.classList.remove('hidden');
    overlay._resolve = () => {
      const enabled = document.getElementById('msrc-enabled').checked;
      const selfWeight = document.getElementById('msrc-sw').checked;
      const g = Math.max(0.001, parseFloat(document.getElementById('msrc-g').value) || 9.80665);
      const entries = [];
      document.querySelectorAll('.msrc-lc').forEach(cb => {
        if (!cb.checked) return;
        const lcId = +cb.dataset.lc;
        const f = parseFloat(document.querySelector(`.msrc-f[data-lc="${lcId}"]`)?.value);
        entries.push({ lcId, factor: isFinite(f) ? f : 1 });
      });
      this.snapshot?.();
      this.model.massSource = (enabled || selfWeight || entries.length)
        ? { enabled, g, selfWeight, entries } : null;
      this.markDirty?.();
      overlay.classList.add('hidden');
      this.toast(enabled
        ? `${i18n.t('Fuente de masa:')} ${entries.length} ${i18n.t('caso(s)')}${selfWeight ? ' + ' + i18n.t('peso propio') : ''} · g=${g}`
        : i18n.t('Fuente de masa desactivada'), 'ok');
    };
    overlay._reject = () => overlay.classList.add('hidden');
  }

  /** HTML dialog — time-history options (direction, ζ, modes, accelerogram). */
  _timeHistoryDialog() {
    return new Promise(resolve => {
      const overlay = document.getElementById('modal-overlay');
      document.getElementById('modal-title').textContent = i18n.t('Time-history modal (acelerograma en la base)');
      document.getElementById('modal-cancel').style.display = '';
      const d = this._lastTH || {};
      document.getElementById('modal-body').innerHTML = `
        <div class="prop-row">
          <div class="prop-field"><label>Dirección de excitación</label>
            <select id="th-dir"><option value="X" ${d.dir==='X'?'selected':''}>X</option><option value="Y" ${d.dir==='Y'?'selected':''}>Y</option><option value="Z" ${d.dir==='Z'?'selected':''}>Z (vertical)</option></select></div>
          <div class="prop-field"><label>N° de modos</label><input type="number" id="th-nmodes" value="${d.nModes||this._defaultNModes()}" min="1" max="40" step="1" style="width:80px"></div>
          <div class="prop-field"><label>Amortiguamiento ζ (%)</label><input type="number" id="th-zeta" value="${((d.zeta??0.05)*100)}" min="0" max="20" step="0.5" style="width:80px"></div>
        </div>
        <div class="prop-row cols1" style="margin-top:8px">
          <div class="prop-field"><label>Acelerograma</label>
            <select id="th-source">
              <option value="ricker">Demo — Pulso de Ricker (sintético)</option>
              <option value="harmonic">Demo — Armónico (sintético)</option>
              <option value="synthetic" selected>Demo — Sismo sintético (NO es real)</option>
              <option value="paste">Pegar / cargar registro (t a) o (a)…</option>
            </select></div>
        </div>
        <div id="th-paste-box" style="display:none;margin-top:6px">
          <textarea id="th-text" rows="5" placeholder="Pegue el registro: dos columnas «t a» (s, m/s²) o una columna «a» con Δt.\nLíneas con # o texto se ignoran." style="width:100%;font-family:var(--font-mono);font-size:11px"></textarea>
          <div class="prop-row" style="margin-top:4px">
            <div class="prop-field"><label>Δt si es 1 columna (s)</label><input type="number" id="th-dt" value="0.01" min="0.0005" step="0.005" style="width:90px"></div>
            <div class="prop-field"><label>Archivo</label><input type="file" id="th-file" accept=".txt,.csv,.acc,.dat,.at2"></div>
          </div>
        </div>
        <div class="prop-row" style="margin-top:6px">
          <div class="prop-field"><label>Escalar a PGA (m/s², 0 = no escalar)</label><input type="number" id="th-pga" value="0" min="0" step="0.5" style="width:100px"></div>
          <div class="prop-field" style="justify-content:flex-end"><span style="color:var(--text-muted);font-size:11px">Excitación uniforme en la base.<br>Integración de Duhamel por modo.</span></div>
        </div>
        <div class="prop-row cols1" style="margin-top:6px"><span style="color:var(--text-muted);font-size:11px;line-height:1.5">
          Los registros «demo» son <b>sintéticos</b> (no son sismos reales). Para usar Llolleo/Constitución 2010 u otro, péguelo o cárguelo como texto (t a).</span></div>`;
      overlay.classList.remove('hidden');
      const srcSel = document.getElementById('th-source');
      const pasteBox = document.getElementById('th-paste-box');
      srcSel.addEventListener('change', () => { pasteBox.style.display = srcSel.value === 'paste' ? '' : 'none'; });
      document.getElementById('th-file').addEventListener('change', async (e) => {
        const f = e.target.files?.[0]; if (!f) return;
        document.getElementById('th-text').value = await f.text();
      });
      overlay._resolve = () => {
        const dir = document.getElementById('th-dir').value;
        const nModes = Math.max(1, Math.min(40, parseInt(document.getElementById('th-nmodes').value) || 10));
        const zeta = Math.max(0, Math.min(0.2, (parseFloat(document.getElementById('th-zeta').value) || 5) / 100));
        const pga = parseFloat(document.getElementById('th-pga').value) || 0;
        const src = srcSel.value;
        let ag, dt, agName;
        if (src === 'paste') {
          const dtF = parseFloat(document.getElementById('th-dt').value) || 0.01;
          const parsed = parseAccelerogram(document.getElementById('th-text').value, dtF);
          if (!parsed.ok) { this.toast(i18n.t('Registro:') + ' ' + parsed.note, 'warn'); return; }   // doesn't solve → retry
          ag = parsed.a; dt = parsed.dt; agName = `Registro cargado (${parsed.n} pts, Δt=${dt.toFixed(4)}s)`;
        } else {
          const demo = DEMO_PRESETS[src](); ag = demo.a; dt = demo.dt; agName = demo.name;
        }
        if (pga > 0) ag = scaleToPGA(ag, pga);
        overlay.classList.add('hidden');
        resolve({ dir, zeta, nModes, ag, dt, agName });
      };
      overlay._reject = () => resolve(null);
    });
  }

  // Component selector options by monitor type (node/element).
  _thCompOptions(type, sel) {
    const opts = type === 'elem'
      ? [['N', 'N (axial)'], ['Mz-i', 'Mz nodo i'], ['Mz-j', 'Mz nodo j'], ['My-i', 'My nodo i'], ['My-j', 'My nodo j'], ['V2', 'Corte V2'], ['V3', 'Corte V3']]
      : type === 'area'
      ? [['vm', 'von Mises'], ['s1', 'σ₁ (mayor)'], ['s2', 'σ₂ (menor)'], ['sx', 'σx (local)'], ['sy', 'σy (local)'], ['txy', 'τxy (local)']]
      : type === 'diaph'
      ? [['ux', 'u X (CM)'], ['uy', 'u Y (CM)'], ['mag', '|u| (CM)'], ['rz', 'θ torsión']]
      : [['ux', 'u X'], ['uy', 'u Y'], ['uz', 'u Z'], ['mag', '|u|'], ['rx', 'θ X'], ['ry', 'θ Y'], ['rz', 'θ Z']];
    return opts.map(([v, t]) => `<option value="${v}" ${v === sel ? 'selected' : ''}>${t}</option>`).join('');
  }

  // Time history of an element force (local end) by modal superposition:
  // f_local(t) = Ke·(T·u_e(t)). comp ∈ {N,Mz-i,Mz-j,My-i,My-j,V2,V3}.
  _thElemForceHist(elemId, comp) {
    const R = this._thResult, model = this.model;
    const el = model.elements.get(elemId);
    const out = new Float64Array(R.nSteps);
    if (!el) return out;
    const n1 = model.nodes.get(el.n1), n2 = model.nodes.get(el.n2);
    const mat = model.materials.get(el.matId), sec = model.sections.get(el.secId);
    if (!n1 || !n2 || !mat || !sec) return out;
    const { ex, ey, ez, L } = localAxes(n1, n2);
    let Ke = stiffnessMatrix(L, mat, sec);
    if ((el.releases || []).some(r => r)) Ke = applyReleases(Ke, el.releases.map(r => !!r));
    const T = transformMatrix(ex, ey, ez);
    const ed = [...getNodeDOFs(R.nodeIndex, el.n1), ...getNodeDOFs(R.nodeIndex, el.n2)];
    const li = { 'N': 6, 'V2': 7, 'V3': 8, 'My-i': 4, 'Mz-i': 5, 'My-j': 10, 'Mz-j': 11 }[comp] ?? 6;
    const ue = new Float64Array(12), ul = new Float64Array(12);
    for (let k = 0; k < R.nSteps; k++) {
      for (let a = 0; a < 12; a++) { let s = 0; const d = ed[a]; for (let i = 0; i < R.modes.length; i++) s += R.modes[i].phi[d] * R.q[i][k]; ue[a] = s; }
      for (let a = 0; a < 12; a++) { let s = 0; const Ta = T[a]; for (let b = 0; b < 12; b++) s += Ta[b] * ue[b]; ul[a] = s; }
      let f = 0; const Ki = Ke[li]; for (let b = 0; b < 12; b++) f += Ki[b] * ul[b];
      out[k] = f;
    }
    return out;
  }

  // Time history of the STRESS of an AREA element (#51), by modal superposition:
  // reconstructs u(t) at the area's DOFs and evaluates the stress with the same routine
  // as the static post-processing. For a shell it returns the surface envelope
  // (membrane ± bending); for a membrane, the membrane stress.
  // comp ∈ {vm, sx, sy, txy, s1, s2}.
  _thAreaStressHist(areaId, comp) {
    const R = this._thResult, model = this.model;
    const out = new Float64Array(R.nSteps);
    const area = model.areas?.get(areaId); if (!area) return out;
    const nDOF = R.nodeIndex.size * 6;
    const u = new Float64Array(nDOF);
    // DOFs of the area's nodes (the only ones to reconstruct each step).
    const dofs = [];
    for (const nid of (area.nodes || [])) { const d = getNodeDOFs(R.nodeIndex, nid); for (let i = 0; i < 6; i++) dofs.push(d[i]); }
    const inv = (sm) => {                       // requested invariant from [σx,σy,τxy]
      if (!sm) return 0;
      const [sx, sy, txy] = sm, c = (sx + sy) / 2, r = Math.hypot((sx - sy) / 2, txy);
      switch (comp) { case 'sx': return sx; case 'sy': return sy; case 'txy': return txy;
        case 's1': return c + r; case 's2': return c - r; default: return vonMises(sm); }
    };
    for (let k = 0; k < R.nSteps; k++) {
      for (const d of dofs) { let s = 0; for (let i = 0; i < R.modes.length; i++) s += R.modes[i].phi[d] * R.q[i][k]; u[d] = s; }
      const sm = areaStress(area, model, R.nodeIndex, u, 0);
      if (!sm) { out[k] = 0; continue; }
      const sb = areaBendingStress(area, model, R.nodeIndex, u);   // null if pure membrane
      if (sb && comp === 'vm') {
        // Surface envelope (top/bottom face), same as getAreaStress.
        const top = [sm[0] - sb[0], sm[1] - sb[1], sm[2] - sb[2]];
        const bot = [sm[0] + sb[0], sm[1] + sb[1], sm[2] + sb[2]];
        out[k] = Math.max(vonMises(top), vonMises(bot));
      } else {
        out[k] = inv(sm);
      }
    }
    return out;
  }

  // History of the monitored object (node: displacement/rotation/|u|; element: force;
  // area: stress).
  _thMonitorHist() {
    const R = this._thResult;
    if (R.monType === 'elem') return this._thElemForceHist(R.monId, R.monComp);
    if (R.monType === 'area') return this._thAreaStressHist(R.monId, R.monComp);
    if (R.monType === 'diaph') return this._thDiaphHist(R.monId, R.monComp);
    if (!R.nodeIndex.has(R.monId)) return new Float64Array(R.nSteps);
    const d0 = getNodeDOFs(R.nodeIndex, R.monId);
    if (R.monComp === 'mag') {
      const hx = this._thNodalDOF(d0[0]), hy = this._thNodalDOF(d0[1]), hz = this._thNodalDOF(d0[2]);
      const h = new Float64Array(R.nSteps); for (let k = 0; k < R.nSteps; k++) h[k] = Math.hypot(hx[k], hy[k], hz[k]); return h;
    }
    const ci = { ux: 0, uy: 1, uz: 2, rx: 3, ry: 4, rz: 5 }[R.monComp] ?? 0;
    return this._thNodalDOF(d0[ci]);
  }

  // Time history of the CENTER OF MASS of a diaphragm (rigid floor), without needing
  // a node at the CM (the CM is not a node: it is a coordinate). The floor moves as a
  // rigid body in its plane; the MASTER node's motion (ux, uy, θz) is reconstructed
  // and translated to the CM point by rigid kinematics:
  //   u_cm = u_master + θz·ẑ × (r_cm − r_master)
  //   ⇒  u_cm_x = ux_m − θz·(cm_y − m_y),  u_cm_y = uy_m + θz·(cm_x − m_x).
  // comp ∈ {ux, uy, mag, rz}.
  _thDiaphHist(diaphId, comp) {
    const R = this._thResult, model = this.model;
    const d = model.diaphragms.get(diaphId);
    const out = new Float64Array(R.nSteps);
    if (!d) return out;
    const masterId = d.masterId || d.nodes?.[0];
    const master = model.nodes.get(masterId);
    if (!master || !R.nodeIndex.has(masterId)) return out;
    const dm = getNodeDOFs(R.nodeIndex, masterId);
    const uxm = this._thNodalDOF(dm[0]), uym = this._thNodalDOF(dm[1]), rzm = this._thNodalDOF(dm[5]);
    const ox = (d.cm?.x ?? master.x) - master.x;   // CM − master (in plan)
    const oy = (d.cm?.y ?? master.y) - master.y;
    for (let k = 0; k < R.nSteps; k++) {
      const uxc = uxm[k] - rzm[k] * oy;
      const uyc = uym[k] + rzm[k] * ox;
      out[k] = comp === 'uy' ? uyc : comp === 'mag' ? Math.hypot(uxc, uyc) : comp === 'rz' ? rzm[k] : uxc;
    }
    return out;
  }

  // Label + unit of the monitored object.
  _thMonitorInfo() {
    const R = this._thResult;
    if (R.monType === 'elem') { const isM = /^M/.test(R.monComp); return { txt: `${R.monComp.replace('-i', ' i').replace('-j', ' j')} · elem ${R.monId}`, unit: isM ? 'kN·m' : 'kN' }; }
    if (R.monType === 'area') { const lbl = { vm: 'von Mises', s1: 'σ₁', s2: 'σ₂', sx: 'σx', sy: 'σy', txy: 'τxy' }[R.monComp] || R.monComp; return { txt: `${lbl} · área ${R.monId}`, unit: 'kPa' }; }
    if (R.monType === 'diaph') { const d = this.model.diaphragms.get(R.monId); const isRz = R.monComp === 'rz'; const lbl = { ux: 'u X', uy: 'u Y', mag: '|u|', rz: 'θ torsión' }[R.monComp] || R.monComp; return { txt: `${lbl} · CM piso ${R.monId}${d ? ` (z=${d.z})` : ''}`, unit: isRz ? 'rad' : 'm' }; }
    if (R.monComp === 'mag') return { txt: `|u| · nodo ${R.monId}`, unit: 'm' };
    const isRot = /^r/.test(R.monComp); return { txt: `${R.monComp} · nodo ${R.monId}`, unit: isRot ? 'rad' : 'm' };
  }

  // (Re)builds the SVG curve of the monitored history and its peak.
  _thBuildPlot() {
    const R = this._thResult, h = R._hist, n = R.nSteps;
    let pkStep = 0, pk = 0; for (let k = 0; k < n; k++) { const a = Math.abs(h[k]); if (a > pk) { pk = a; pkStep = k; } }
    R._pkStep = pkStep; R._peak = pk;
    const W = 280, H = 110, ml = 4, mr = 4, mt = 8, mb = 4;
    const hmax = pk || 1e-30, tmax = (n - 1) * R.dt || 1;
    const sx = k => ml + (W - ml - mr) * (k * R.dt) / tmax;
    const sy = u => mt + (H - mt - mb) * (1 - (u / hmax + 1) / 2);
    let poly = ''; const sd = Math.max(1, Math.floor(n / 700));
    for (let k = 0; k < n; k += sd) poly += `${sx(k).toFixed(1)},${sy(h[k]).toFixed(1)} `;
    const y0 = sy(0).toFixed(1);
    R._svg = (k) => `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:${H}px;background:var(--bg3,#0b1220);border-radius:6px">
      <line x1="${ml}" y1="${y0}" x2="${W - mr}" y2="${y0}" stroke="var(--border,#26324d)" stroke-width="1"/>
      <polyline points="${poly}" fill="none" stroke="var(--accent,#38bdf8)" stroke-width="1.3"/>
      <circle cx="${sx(k).toFixed(1)}" cy="${sy(h[k]).toFixed(1)}" r="3.2" fill="#f59e0b"/>
    </svg>`;
  }

  // Changes the monitored object (reads the controls), recomputes and redraws.
  _thSetMonitor() {
    const R = this._thResult; if (!R) return;
    const type = document.getElementById('th-montype')?.value || 'node';
    const id = parseInt(document.getElementById('th-monid')?.value) || 0;
    const comp = document.getElementById('th-moncomp')?.value || 'ux';
    if (type === 'node' && !this.model.nodes.has(id)) { this.toast(`${i18n.t('El nodo')} ${id} ${i18n.t('no existe')}`, 'warn'); return; }
    if (type === 'elem' && !this.model.elements.has(id)) { this.toast(`${i18n.t('El elemento')} ${id} ${i18n.t('no existe')}`, 'warn'); return; }
    if (type === 'area' && !this.model.areas?.has(id)) { this.toast(`${i18n.t('El área')} ${id} ${i18n.t('no existe')}`, 'warn'); return; }
    if (type === 'diaph' && !this.model.diaphragms?.has(id)) { this.toast(`${i18n.t('El diafragma')} ${id} ${i18n.t('no existe')}`, 'warn'); return; }
    R.monType = type; R.monId = id; R.monComp = comp;
    R._hist = this._thMonitorHist();
    this._thBuildPlot();
    const stepInp = document.getElementById('th-step');
    this._thShowStep(stepInp ? +stepInp.value : R._pkStep);
  }

  // Shows the dynamic response in the «Dynamic» tab of Results (#90: it used to be a
  // floating window). Sets the default monitor the first time and switches to the tab,
  // which builds the content via _thRenderPanel().
  _thOpenOverlay() {
    const R = this._thResult; if (!R) return;
    if (!R._monInit) {   // default monitor only the 1st time (don't override the user's choice)
      R.monType = 'node'; R.monId = R.monitorNodeId; R.monComp = { X: 'ux', Y: 'uy', Z: 'uz' }[R.dir] || 'ux';
      R._monInit = true;
    }
    this.panel._switchVTab('results');
    this.panel._switchRTab('th');   // → _thRenderPanel()
  }

  // Builds the «Dynamic» tab content in #th-panel. Keeps the SAME IDs as the old
  // floating window → _thShowStep / _thSetMonitor stay the same.
  // Monitor response curve (node / element / area / center of mass) + animation.
  _thRenderPanel() {
    const el = document.getElementById('th-panel');
    const hint = document.getElementById('res-th-hint');
    const R = this._thResult;
    if (!el) return;
    if (!R) { if (hint) hint.style.display = ''; el.innerHTML = ''; return; }
    if (hint) hint.style.display = 'none';
    this._thStopPlay();
    R._hist = this._thMonitorHist();
    this._thBuildPlot();
    const n = R.nSteps;
    const tSel = (v) => R.monType === v ? 'selected' : '';
    // #104: dynamic record/case selector (if more than one earthquake was run)
    const runs = this._thRuns;
    const runSel = (runs && runs.size > 1)
      ? `<div style="display:flex;gap:5px;align-items:center;margin-bottom:5px"><label style="color:var(--text-muted);font-size:11px">Sismo</label>
          <select id="th-run" style="font-size:11px;flex:1" title="Registro/caso dinámico a mostrar">${[...runs.keys()].map(lbl => `<option value="${lbl.replace(/"/g, '')}" ${runs.get(lbl) === R ? 'selected' : ''}>${lbl.replace(/[<>&]/g, '')}</option>`).join('')}</select></div>`
      : '';
    el.innerHTML = runSel + `
      <div style="display:flex;gap:5px;align-items:center;margin-bottom:5px">
        <select id="th-montype" style="font-size:11px"><option value="node" ${tSel('node')}>Nodo</option><option value="elem" ${tSel('elem')}>Elemento</option>${(this.model.areas?.size) ? `<option value="area" ${tSel('area')}>Área</option>` : ''}${(this.model.diaphragms?.size) ? `<option value="diaph" ${tSel('diaph')}>Centro de masa</option>` : ''}</select>
        <input type="number" id="th-monid" value="${R.monId}" min="1" step="1" style="width:58px;font-size:11px" title="ID del nodo, elemento, área o diafragma (piso) a monitorear">
        <select id="th-moncomp" style="font-size:11px;flex:1">${this._thCompOptions(R.monType, R.monComp)}</select>
      </div>
      <div id="th-plot"></div>
      <div style="display:flex;align-items:center;gap:6px;margin:6px 0">
        <button id="th-play" class="btn-secondary" style="font-size:14px;padding:2px 8px">▶</button>
        <input type="range" id="th-step" min="0" max="${n - 1}" value="${R._pkStep}" style="flex:1">
        <select id="th-speed" title="Velocidad de animación" style="font-size:11px"><option value="0.5">×0.5</option><option value="1" selected>×1</option><option value="2">×2</option><option value="4">×4</option></select>
      </div>
      <div id="th-readout" style="color:var(--text-muted,#94a3b8);font-size:11px;line-height:1.5;margin-bottom:6px"></div>
      <div style="display:flex;align-items:center;gap:6px;justify-content:space-between">
        <span style="display:flex;align-items:center;gap:6px"><label style="color:var(--text-muted)">Escala ×</label>
          <input type="number" id="th-scale" value="1" min="0.05" step="0.5" style="width:60px"></span>
        <span style="display:flex;gap:6px">
          <button id="th-peak" class="btn-secondary" style="font-size:11px;padding:2px 6px" title="Ir al instante de máxima respuesta">Máx</button>
          <button id="th-export" class="btn-secondary" style="font-size:11px;padding:2px 6px">⤓ CSV</button>
        </span>
      </div>`;
    el.querySelector('#th-run')?.addEventListener('change', (e) => {
      const r = this._thRuns?.get(e.target.value); if (r) { this._thStopPlay(); this._thResult = r; this._thRenderPanel(); }
    });
    const stepInp = el.querySelector('#th-step'), scaleInp = el.querySelector('#th-scale'), playBtn = el.querySelector('#th-play');
    const typeSel = el.querySelector('#th-montype'), idInp = el.querySelector('#th-monid'), compSel = el.querySelector('#th-moncomp');
    const redraw = () => this._thShowStep(+stepInp.value);
    stepInp.addEventListener('input', redraw);
    scaleInp.addEventListener('input', redraw);
    // Selectable monitor: changing type rebuilds the components; any change recomputes.
    typeSel.addEventListener('change', () => {
      if (typeSel.value === 'elem') { idInp.value = this._selElems?.()[0] || [...this.model.elements.keys()][0] || 1; compSel.innerHTML = this._thCompOptions('elem', 'N'); }
      else if (typeSel.value === 'area') { idInp.value = [...(this.model.areas?.keys() || [])][0] || 1; compSel.innerHTML = this._thCompOptions('area', 'vm'); }
      else if (typeSel.value === 'diaph') { idInp.value = [...(this.model.diaphragms?.keys() || [])][0] || 1; compSel.innerHTML = this._thCompOptions('diaph', { X: 'ux', Y: 'uy', Z: 'mag' }[R.dir] || 'ux'); }
      else { idInp.value = R.monitorNodeId; compSel.innerHTML = this._thCompOptions('node', R.monComp); }
      this._thSetMonitor();
    });
    idInp.addEventListener('change', () => this._thSetMonitor());
    compSel.addEventListener('change', () => this._thSetMonitor());
    el.querySelector('#th-peak').addEventListener('click', () => { stepInp.value = R._pkStep; redraw(); });
    el.querySelector('#th-export').addEventListener('click', () => this._thExportCSV());
    playBtn.addEventListener('click', () => {
      if (this._thPlayTimer) { this._thStopPlay(); playBtn.textContent = '▶'; return; }
      playBtn.textContent = '⏸';
      const speedEl = el.querySelector('#th-speed');
      const base = Math.max(1, Math.floor(n / 240));
      this._thPlayTimer = setInterval(() => { const stride = Math.max(1, Math.round(base * (parseFloat(speedEl?.value) || 1))); let v = +stepInp.value + stride; if (v > n - 1) v = 0; stepInp.value = v; redraw(); }, 60);
    });
    redraw();
  }

  _thStopPlay() { if (this._thPlayTimer) { clearInterval(this._thPlayTimer); this._thPlayTimer = null; } }

  _thShowStep(step) {
    const R = this._thResult; if (!R) return;
    step = Math.max(0, Math.min(step, R.nSteps - 1));
    const u = this._thUAt(step);
    const uByNode = new Map();
    for (const node of this.model.nodes.values()) {
      const d = getNodeDOFs(R.nodeIndex, node.id);
      uByNode.set(node.id, [u[d[0]], u[d[1]], u[d[2]]]);
    }
    const factor = parseFloat(document.getElementById('th-scale')?.value) || 1;
    const t = step * R.dt, ag = R.ag[step];
    let dmax = 0; for (const v of uByNode.values()) dmax = Math.max(dmax, Math.hypot(v[0], v[1], v[2]));
    this.viewport.showNLDeformed(uByNode, new Map(), factor,
      `Time-history · t=${t.toFixed(3)}s · a_g=${ag.toFixed(3)} m/s² · δmax=${dmax.toExponential(2)} m`);
    const plot = document.getElementById('th-plot'); if (plot && R._svg) plot.innerHTML = R._svg(step);
    const ro = document.getElementById('th-readout');
    const info = this._thMonitorInfo();
    if (ro) ro.innerHTML = `t = <b>${t.toFixed(3)} s</b> / ${((R.nSteps - 1) * R.dt).toFixed(2)} s · a_g = ${ag.toFixed(3)} m/s²<br>`
      + `${info.txt} = ${R._hist[step].toExponential(3)} ${info.unit} · máx = <b>${(R._peak ?? 0).toExponential(3)} ${info.unit}</b><br>`
      + `${R.modes.length} modos · ζ=${(R.zeta * 100).toFixed(1)}% · dir ${R.dir} · PGA=${R.stats.pga.toFixed(2)} m/s² · ${R.agName}`;
  }

  _thExportCSV() {
    const R = this._thResult; if (!R) return;
    const h = R._hist || this._thMonitorHist();
    const info = this._thMonitorInfo();
    const obj = R.monType === 'elem' ? 'elem' : R.monType === 'area' ? 'area' : 'nodo';
    const col = `${R.monComp}_${obj}${R.monId}[${info.unit}]`;
    let csv = `# Time-history modal · dir ${R.dir} · ${R.modes.length} modos · zeta ${(R.zeta*100).toFixed(1)}% · ${R.agName}\n`;
    csv += `t[s],a_g[m/s2],${col}\n`;
    for (let k = 0; k < R.nSteps; k++) csv += `${(k*R.dt).toFixed(5)},${R.ag[k].toFixed(6)},${h[k].toExponential(6)}\n`;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `timehistory_${R.monType}${R.monId}_${R.monComp}.csv`; a.click();
    URL.revokeObjectURL(a.href);
    this.toast(`Historia exportada (${info.txt})`, 'ok');
  }

  // ════════════════════════════════════════════════════════════════════════════
  // BRIDGES — UI for the three verified engines (G14): construction stages, tendon
  // prestress and moving loads / influence lines.  The ENGINES (staged.js /
  // tendon.js / moving_load.js) are already validated headless against the analytic /
  // manual CSI solution (verif 1-031 / 1-009 / 1-030); here only the UI is wired,
  // following the pattern of the other analyses (modal dialog + progress bar +
  // reusable result with a «View» badge in the analysis hub).
  // ════════════════════════════════════════════════════════════════════════════

  // ── Construction stages (staged) ─────────────────────────────────────────────
  async runStaged(opts = {}) {
    const model = this.model;
    if (model.elements.size === 0) { this.toast('Las etapas constructivas requieren elementos de barra', 'warn'); return; }
    const stages = opts.silent ? this._stagedDefaultStages() : await this._stagedDialog();
    if (!stages || !stages.length) return;
    if (this.viewport._inResultsMode) this.viewport.clearResults();
    const btn = document.getElementById('btn-run'); if (btn) btn.classList.add('running');
    this._showProgress('Etapas constructivas…', 'Análisis lineal incremental por fases (acumulando estado)');
    await new Promise(r => setTimeout(r, 20));
    try {
      const res = await solverRegistry.solveStaged(model, stages);
      this._stagedResult = { res, stages, info: stages.map((s, i) => `${i + 1}. ${s.name}`).join(' · ') };
      const last = res.stages[res.stages.length - 1];
      this.toast(`Etapas OK · ${res.stages.length} fases · δmax acumulado ${res.getMaxDisp().toExponential(2)} m · activos finales ${last ? last.active.size : 0}`, 'ok');
      this._stagedShow();
      this._updateResultsIndicator?.();
    } catch (err) {
      this.toast(`${i18n.t('Etapas:')} ${i18n.t(err.message)}`, 'error'); console.error(err);
    } finally {
      if (btn) btn.classList.remove('running');
      this._hideProgress();
    }
  }

  // Default sequence (batch / silent mode): one stage per group in order, or a single
  // stage with all elements if there are no groups.
  _stagedDefaultStages() {
    const groups = this.groups();
    if (groups.size) return [...groups.entries()].map(([name, set]) => ({ name, activate: [...set], selfWeightNew: true }));
    return [{ name: 'Estructura completa', activate: [...this.model.elements.keys()], selfWeightNew: true }];
  }

  // Stage-sequence editor. Each stage activates a GROUP of elements (or all);
  // optionally a final SERVICE stage applies the loads of a case.
  async _stagedDialog() {
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = i18n.t('Etapas constructivas (staged)');
    const groups = this.groups();
    const draft = this._stagedDraft && this._stagedDraft.length ? this._stagedDraft : this._stagedDefaultStages().map(s => ({ name: s.name, ids: s.activate, sw: true }));
    const srcOpts = `<option value="__all__">Todos los elementos (${this.model.elements.size})</option>`
      + [...groups.entries()].map(([n, s]) => `<option value="${esc(n)}">Grupo «${esc(n)}» (${s.size})</option>`).join('');
    const lcOpts = `<option value="">— ninguna —</option>`
      + [...this.model.loadCases.values()].map(lc => `<option value="${lc.id}">${esc(lc.name)}</option>`).join('');
    document.getElementById('modal-body').innerHTML = `
      <p style="color:var(--text-muted);font-size:11px;margin:0 0 8px">
        Cada etapa <b>activa</b> un conjunto de elementos; el estado (desplazamientos y esfuerzos) se
        <b>acumula</b> y cada elemento «nace» libre de tensión al activarse (como CSiBridge). Su peso propio
        se aplica al colarse. Define la secuencia agrupando los elementos en <b>groups</b> previamente.</p>
      <div class="prop-row" style="align-items:flex-end;gap:8px">
        <div class="prop-field" style="flex:1"><label>Añadir etapa con</label><select id="staged-src">${srcOpts}</select></div>
        <label style="font-size:11px;display:flex;align-items:center;gap:4px"><input type="checkbox" id="staged-sw" checked> peso propio nuevo</label>
        <button id="staged-add" class="btn" style="white-space:nowrap">➕ Añadir</button>
      </div>
      <div id="staged-list" style="margin-top:8px"></div>
      <div class="prop-row cols1" style="margin-top:8px">
        <div class="prop-field"><label>Caso de SERVICIO en la última etapa (estructura terminada)</label><select id="staged-service">${lcOpts}</select></div>
      </div>`;
    document.getElementById('modal-cancel').style.display = '';
    overlay.classList.remove('hidden');

    const list = document.getElementById('staged-list');
    const elemName = (set) => set === '__all__' ? `todos (${this.model.elements.size})` : `«${set}»`;
    const render = () => {
      list.innerHTML = draft.length
        ? draft.map((s, i) => `
          <div class="prop-row" style="align-items:center;gap:6px;border:1px solid var(--border);border-radius:6px;padding:5px 7px;margin-bottom:5px">
            <span style="font-weight:700;color:var(--accent)">${i + 1}</span>
            <input type="text" data-name="${i}" value="${esc(s.name)}" style="flex:1;font-size:12px">
            <span style="font-size:11px;color:var(--text-muted)">${s.ids.length} elem${s.sw ? ' · pp' : ''}</span>
            <button data-up="${i}" title="Subir" ${i === 0 ? 'disabled' : ''}>▲</button>
            <button data-dn="${i}" title="Bajar" ${i === draft.length - 1 ? 'disabled' : ''}>▼</button>
            <button data-rm="${i}" title="Quitar">🗑</button>
          </div>`).join('')
        : `<p style="color:var(--text-muted);font-size:11px">Sin etapas. Añade al menos una.</p>`;
      list.querySelectorAll('[data-name]').forEach(inp => inp.addEventListener('change', e => { draft[+e.target.dataset.name].name = e.target.value; }));
      list.querySelectorAll('[data-up]').forEach(b => b.addEventListener('click', () => { const i = +b.dataset.up; [draft[i - 1], draft[i]] = [draft[i], draft[i - 1]]; render(); }));
      list.querySelectorAll('[data-dn]').forEach(b => b.addEventListener('click', () => { const i = +b.dataset.dn; [draft[i + 1], draft[i]] = [draft[i], draft[i + 1]]; render(); }));
      list.querySelectorAll('[data-rm]').forEach(b => b.addEventListener('click', () => { draft.splice(+b.dataset.rm, 1); render(); }));
    };
    render();
    document.getElementById('staged-add').addEventListener('click', () => {
      const src = document.getElementById('staged-src').value;
      const sw = document.getElementById('staged-sw').checked;
      const ids = src === '__all__' ? [...this.model.elements.keys()] : [...(groups.get(src) || [])];
      if (!ids.length) { this.toast('El grupo no tiene elementos', 'warn'); return; }
      draft.push({ name: `Etapa ${draft.length + 1} — ${elemName(src)}`, ids, sw });
      render();
    });

    const ok = await new Promise(res => { overlay._resolve = res; overlay._reject = () => res(false); });
    if (!ok) return null;
    this._stagedDraft = draft;
    const stages = draft.map(s => ({ name: s.name, activate: s.ids, selfWeightNew: s.sw }));
    const svcId = parseInt(document.getElementById('staged-service').value);
    if (Number.isFinite(svcId)) {
      const lc = this.model.loadCases.get(svcId);
      if (lc) stages.push({ name: `Servicio — ${lc.name}`, activate: [], selfWeightNew: false, loads: (lc.loads || []).slice() });
    }
    return stages;
  }

  // Draws the accumulated deformed shape of the stages (reuses showNLDeformed).
  _stagedShow() {
    const R = this._stagedResult; if (!R) return;
    const res = R.res;
    const uByNode = new Map();
    for (const node of this.model.nodes.values()) { const d = res.getNodeDisp(node.id); uByNode.set(node.id, [d[0], d[1], d[2]]); }
    this.viewport.showNLDeformed(uByNode, new Map(), 1,
      `Etapas constructivas · ${res.stages.length} fases · δmax acumulado ${res.getMaxDisp().toExponential(2)} m`);
  }

  // ── Tendon prestress (equivalent loads) ──────────────────────────────────────
  async runTendon(opts = {}) {
    const model = this.model;
    const sel = this._selElems();
    if (!sel.length) { this.toast('Selecciona los elementos del tendón (en orden, del ancla activa a la pasiva)', 'warn'); return; }
    const cfg = await this._tendonDialog(sel);
    if (!cfg) return;
    try {
      const tendon = cfg.tendon;
      const eq = tendonEquivalentLoads(model, tendon);
      const lc = model.loadCases.get(cfg.lcId);
      if (!lc) { this.toast('Caso de carga inexistente', 'warn'); return; }
      this.snapshot();
      for (const ld of eq.loads) lc.loads.push(ld);
      this.refreshLoads?.();
      this.markDirty();
      this.toast(`${i18n.t('Tendón aplicado a')} «${lc.name}» · P=${eq.P.toFixed(0)} kN · w_eq=${Math.abs(eq.weq).toFixed(2)} kN/m · L=${eq.L.toFixed(2)} m`, 'ok');
      if (cfg.solve) this.runAnalysis();
    } catch (err) {
      this.toast(`${i18n.t('Tendón:')} ${i18n.t(err.message)}`, 'error'); console.error(err);
    }
  }

  async _tendonDialog(sel) {
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = i18n.t('Pretensado por tendón — cargas equivalentes');
    const lcOpts = [...this.model.loadCases.values()].map(lc => `<option value="${lc.id}">${esc(lc.name)}</option>`).join('')
      || `<option value="">(crea un caso de carga primero)</option>`;
    document.getElementById('modal-body').innerHTML = `
      <p style="color:var(--text-muted);font-size:11px;margin:0 0 8px">
        Método de las cargas equivalentes (load balancing, T.Y. Lin). El tendón se traduce a una carga de
        balanceo + axial + momentos de ancla sobre <b>${sel.length}</b> elemento(s) seleccionado(s) (en orden).
        Excentricidad <b>e ↓ positiva</b> (m).</p>
      <div class="prop-row">
        <div class="prop-field"><label>Trazado</label><select id="td-profile"><option value="parabola">Parábola</option><option value="polygon">Poligonal</option></select></div>
        <div class="prop-field"><label>Caso de carga destino</label><select id="td-lc">${lcOpts}</select></div>
      </div>
      <div class="prop-row" id="td-parab">
        <div class="prop-field"><label>e inicial (m)</label><input type="number" id="td-e1" value="0" step="0.05" style="width:80px"></div>
        <div class="prop-field"><label>e centro (m)</label><input type="number" id="td-em" value="0.3" step="0.05" style="width:80px"></div>
        <div class="prop-field"><label>e final (m)</label><input type="number" id="td-e2" value="0" step="0.05" style="width:80px"></div>
      </div>
      <div class="prop-row cols1" id="td-poly" style="display:none">
        <div class="prop-field"><label>Quiebres «s,e» por línea (s∈[0,1], e ↓+ en m)</label>
          <textarea id="td-points" rows="4" style="width:100%;font-family:var(--font-mono);font-size:11px">0,0
0.5,0.3
1,0</textarea></div>
      </div>
      <div class="prop-row">
        <div class="prop-field"><label>Fuerza</label><select id="td-fmode"><option value="P">Efectiva P directa</option><option value="jack">Tesado + pérdidas</option></select></div>
        <div class="prop-field" id="td-P"><label>P (kN)</label><input type="number" id="td-Pval" value="1000" step="50" style="width:100px"></div>
      </div>
      <div class="prop-row" id="td-jack" style="display:none">
        <div class="prop-field"><label>P₀ gato (kN)</label><input type="number" id="td-jackval" value="1200" step="50" style="width:90px"></div>
        <div class="prop-field"><label>μ (1/rad)</label><input type="number" id="td-mu" value="0.2" step="0.01" style="width:70px"></div>
        <div class="prop-field"><label>k (1/m)</label><input type="number" id="td-k" value="0.001" step="0.0005" style="width:80px"></div>
        <div class="prop-field"><label>Pérdida tanto alzado</label><input type="number" id="td-lump" value="0.1" min="0" max="0.5" step="0.01" style="width:70px"></div>
      </div>
      <label style="font-size:12px;display:flex;align-items:center;gap:6px;margin-top:6px"><input type="checkbox" id="td-solve" checked> Resolver estático tras aplicar</label>`;
    document.getElementById('modal-cancel').style.display = '';
    overlay.classList.remove('hidden');
    const sync = () => {
      const poly = document.getElementById('td-profile').value === 'polygon';
      document.getElementById('td-parab').style.display = poly ? 'none' : '';
      document.getElementById('td-poly').style.display = poly ? '' : 'none';
      const jack = document.getElementById('td-fmode').value === 'jack';
      document.getElementById('td-P').style.display = jack ? 'none' : '';
      document.getElementById('td-jack').style.display = jack ? '' : 'none';
    };
    document.getElementById('td-profile').addEventListener('change', sync);
    document.getElementById('td-fmode').addEventListener('change', sync);
    sync();
    const ok = await new Promise(res => { overlay._resolve = res; overlay._reject = () => res(false); });
    if (!ok) return null;
    const profile = document.getElementById('td-profile').value;
    const lcId = parseInt(document.getElementById('td-lc').value);
    if (!Number.isFinite(lcId)) { this.toast('Selecciona un caso de carga', 'warn'); return null; }
    const tendon = { elems: sel, profile };
    if (profile === 'parabola') {
      tendon.e = { start: +document.getElementById('td-e1').value || 0, mid: +document.getElementById('td-em').value || 0, end: +document.getElementById('td-e2').value || 0 };
    } else {
      tendon.points = document.getElementById('td-points').value.split(/\n/).map(l => l.trim()).filter(Boolean)
        .map(l => { const [s, e] = l.split(/[,\s]+/).map(Number); return { s, e }; }).filter(p => Number.isFinite(p.s) && Number.isFinite(p.e));
    }
    if (document.getElementById('td-fmode').value === 'jack') {
      tendon.jack = +document.getElementById('td-jackval').value || 0;
      tendon.friction = { mu: +document.getElementById('td-mu').value || 0, k: +document.getElementById('td-k').value || 0 };
      tendon.lumpSum = +document.getElementById('td-lump').value || 0;
    } else {
      tendon.P = +document.getElementById('td-Pval').value || 0;
    }
    return { tendon, lcId, solve: document.getElementById('td-solve').checked };
  }

  // ── Moving loads / influence lines ───────────────────────────────────────────
  async runMovingLoad(opts = {}) {
    const model = this.model;
    const sel = this._selElems();
    if (!sel.length) { this.toast('Selecciona los elementos de la PISTA (en orden a lo largo del recorrido)', 'warn'); return; }
    const cfg = await this._movingDialog(sel);
    if (!cfg) return;
    const btn = document.getElementById('btn-run'); if (btn) btn.classList.add('running');
    this._showProgress('Cargas móviles…', cfg.mode === 'il' ? 'Barrido de carga unitaria (línea de influencia)' : 'Barrido del tren (envolvente)');
    await new Promise(r => setTimeout(r, 20));
    try {
      const lane = buildLane(model, cfg.laneIds);
      const resp = cfg.respType === 'reaction' ? responseReaction(cfg.nodeId, cfg.comp) : responseSection(cfg.elemId, cfg.xi, cfg.key);
      let result;
      if (cfg.mode === 'il') {
        const il = influenceLine(model, lane, resp, { nPos: cfg.nPos, P: 1 });
        result = { mode: 'il', lane, label: cfg.label, unit: cfg.unit, xs: il.s, ys: il.value, max: il.max, min: il.min, sMax: il.sMax, sMin: il.sMin };
      } else {
        const env = await solverRegistry.solveMovingLoads(model, lane, cfg.train, { [cfg.label]: resp }, { nPos: cfg.nPos });
        const e = env.env[cfg.label];
        result = { mode: 'env', lane, label: cfg.label, unit: cfg.unit, xs: env.positions, ys: env.series[cfg.label], max: e.max, min: e.min, sMax: e.atMax, sMin: e.atMin, trainLen: env.trainLen };
      }
      this._movingResult = result;
      this.toast(`${i18n.t('Cargas móviles OK')} · ${cfg.label} · ${i18n.t('máx')} ${result.max.toExponential(3)} ${cfg.unit} · ${i18n.t('mín')} ${result.min.toExponential(3)} ${cfg.unit}`, 'ok');
      this._movingPlotOverlay(result);
      this._updateResultsIndicator?.();
    } catch (err) {
      this.toast(`${i18n.t('Cargas móviles:')} ${i18n.t(err.message)}`, 'error'); console.error(err);
    } finally {
      if (btn) btn.classList.remove('running');
      this._hideProgress();
    }
  }

  async _movingDialog(sel) {
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = i18n.t('Cargas móviles / líneas de influencia');
    const nodeOpts = [...this.model.nodes.keys()].map(id => `<option value="${id}">Nodo ${id}</option>`).join('');
    const elemOpts = sel.map(id => `<option value="${id}">Elem ${id}</option>`).join('');
    document.getElementById('modal-body').innerHTML = `
      <p style="color:var(--text-muted);font-size:11px;margin:0 0 8px">
        Pista = <b>${sel.length}</b> elemento(s) seleccionado(s), en orden. La <b>línea de influencia</b> barre una
        carga unitaria ↓; la <b>envolvente</b> barre un tren multi-eje. Respuesta = reacción de un apoyo o esfuerzo
        en una sección.</p>
      <div class="prop-row">
        <div class="prop-field"><label>Modo</label><select id="ml-mode"><option value="il">Línea de influencia (carga unitaria)</option><option value="env">Envolvente (tren de cargas)</option></select></div>
        <div class="prop-field"><label>Posiciones de barrido</label><input type="number" id="ml-npos" value="41" min="9" max="201" step="2" style="width:80px"></div>
      </div>
      <div class="prop-row">
        <div class="prop-field"><label>Respuesta</label><select id="ml-resp"><option value="reaction">Reacción de apoyo</option><option value="section">Esfuerzo en sección</option></select></div>
      </div>
      <div class="prop-row" id="ml-reaction">
        <div class="prop-field"><label>Nodo</label><select id="ml-node">${nodeOpts}</select></div>
        <div class="prop-field"><label>Componente</label><select id="ml-comp"><option value="Fz">Fz (vertical)</option><option value="Fx">Fx</option><option value="Fy">Fy</option><option value="My">My</option><option value="Mz">Mz</option></select></div>
      </div>
      <div class="prop-row" id="ml-section" style="display:none">
        <div class="prop-field"><label>Elemento</label><select id="ml-elem">${elemOpts}</select></div>
        <div class="prop-field"><label>Posición ξ (0–1)</label><input type="number" id="ml-xi" value="0.5" min="0" max="1" step="0.05" style="width:70px"></div>
        <div class="prop-field"><label>Esfuerzo</label><select id="ml-key"><option value="Mz">Mz</option><option value="My">My</option><option value="Vy">Vy</option><option value="Vz">Vz</option><option value="N">N</option></select></div>
      </div>
      <div class="prop-row cols1" id="ml-train" style="display:none">
        <div class="prop-field"><label>Tren «offset,P» por línea (offset m respecto al eje de referencia, P en kN ↓)</label>
          <textarea id="ml-trainpts" rows="3" style="width:100%;font-family:var(--font-mono);font-size:11px">0,100
4,100</textarea></div>
      </div>`;
    document.getElementById('modal-cancel').style.display = '';
    overlay.classList.remove('hidden');
    const sync = () => {
      const isReac = document.getElementById('ml-resp').value === 'reaction';
      document.getElementById('ml-reaction').style.display = isReac ? '' : 'none';
      document.getElementById('ml-section').style.display = isReac ? 'none' : '';
      document.getElementById('ml-train').style.display = document.getElementById('ml-mode').value === 'env' ? '' : 'none';
    };
    document.getElementById('ml-resp').addEventListener('change', sync);
    document.getElementById('ml-mode').addEventListener('change', sync);
    sync();
    const ok = await new Promise(res => { overlay._resolve = res; overlay._reject = () => res(false); });
    if (!ok) return null;
    const mode = document.getElementById('ml-mode').value;
    const nPos = Math.max(9, Math.min(201, parseInt(document.getElementById('ml-npos').value) || 41));
    const respType = document.getElementById('ml-resp').value;
    const cfg = { mode, nPos, respType, laneIds: sel };
    const isMoment = (k) => /^M/.test(k);

    if (respType === 'reaction') {
      cfg.nodeId = parseInt(document.getElementById('ml-node').value);
      cfg.comp = document.getElementById('ml-comp').value;
      cfg.unit = isMoment(cfg.comp) ? 'kN·m' : 'kN';
      cfg.label = `R${cfg.comp} · nodo ${cfg.nodeId}`;
    } else {
      cfg.elemId = parseInt(document.getElementById('ml-elem').value);
      cfg.xi = Math.max(0, Math.min(1, +document.getElementById('ml-xi').value || 0.5));
      cfg.key = document.getElementById('ml-key').value;
      cfg.unit = isMoment(cfg.key) ? 'kN·m' : 'kN';
      cfg.label = `${cfg.key} · elem ${cfg.elemId} @ξ=${cfg.xi.toFixed(2)}`;
    }
    if (mode === 'env') {
      cfg.train = document.getElementById('ml-trainpts').value.split(/\n/).map(l => l.trim()).filter(Boolean)
        .map(l => { const [offset, P] = l.split(/[,\s]+/).map(Number); return { offset, P }; }).filter(a => Number.isFinite(a.offset) && Number.isFinite(a.P));
      if (!cfg.train.length) { this.toast('Define al menos un eje del tren', 'warn'); return null; }
    }
    return cfg;
  }

  // #90: Moving loads → «Moving loads» tab in Results.
  _movingPlotOverlay(R) {
    this._movingResult = R;
    this.panel._switchVTab('results');
    this.panel._switchRTab('ml');   // → _movingRenderPanel()
  }

  // Builds the influence-line / envelope chart in #ml-panel.
  _movingRenderPanel() {
    const el = document.getElementById('ml-panel');
    const hint = document.getElementById('res-ml-hint');
    if (!el) return;
    const R = this._movingResult;
    if (!R) { if (hint) hint.style.display = ''; el.innerHTML = ''; return; }
    if (hint) hint.style.display = 'none';
    const W = 460, H = 200, ml = 44, mr = 14, mt = 14, mb = 28;
    const n = R.xs.length;
    const xmin = R.xs[0], xmax = R.xs[n - 1] || 1;
    let ymax = R.max, ymin = R.min;
    if (ymax === ymin) { ymax += 1; ymin -= 1; }
    const pad = (ymax - ymin) * 0.08; ymax += pad; ymin -= pad;
    const sx = x => ml + (W - ml - mr) * (x - xmin) / (xmax - xmin || 1);
    const sy = y => mt + (H - mt - mb) * (1 - (y - ymin) / (ymax - ymin || 1));
    let poly = ''; for (let i = 0; i < n; i++) poly += `${sx(R.xs[i]).toFixed(1)},${sy(R.ys[i]).toFixed(1)} `;
    const y0 = sy(0).toFixed(1);
    const mk = (x, y, col) => `<circle cx="${sx(x).toFixed(1)}" cy="${sy(y).toFixed(1)}" r="3.5" fill="${col}"/>`;
    const title = R.mode === 'il' ? 'Línea de influencia (carga unitaria ↓)' : `Envolvente del tren (largo ${R.trainLen?.toFixed(1)} m)`;
    el.innerHTML = `
      <div style="font-size:12px;font-weight:600;margin-bottom:4px;color:var(--accent,#38bdf8)">${title}</div>
      <div style="font-size:12px;margin-bottom:6px">${R.label} <span style="color:var(--text-muted)">(${R.unit})</span></div>
      <svg viewBox="0 0 ${W} ${H}" style="width:100%;background:var(--bg3,#0b1220);border-radius:6px">
        <line x1="${ml}" y1="${y0}" x2="${W - mr}" y2="${y0}" stroke="var(--border,#26324d)" stroke-width="1"/>
        <line x1="${ml}" y1="${mt}" x2="${ml}" y2="${H - mb}" stroke="var(--border,#26324d)" stroke-width="1"/>
        <polyline points="${poly}" fill="none" stroke="var(--accent,#38bdf8)" stroke-width="1.6"/>
        ${mk(R.sMax, R.max, '#ef4444')}${mk(R.sMin, R.min, '#22c55e')}
        <text x="${ml}" y="${H - 8}" fill="var(--text-muted,#9aa)" font-size="10">pos. ${xmin.toFixed(1)} m</text>
        <text x="${W - mr}" y="${H - 8}" fill="var(--text-muted,#9aa)" font-size="10" text-anchor="end">${xmax.toFixed(1)} m</text>
      </svg>
      <div style="font-size:11.5px;margin-top:8px;line-height:1.7">
        <span style="color:#ef4444">●</span> máx = <b>${R.max.toExponential(3)} ${R.unit}</b> en pos. ${R.sMax.toFixed(2)} m<br>
        <span style="color:#22c55e">●</span> mín = <b>${R.min.toExponential(3)} ${R.unit}</b> en pos. ${R.sMin.toFixed(2)} m<br>
        <span style="color:var(--text-muted)">Pista L = ${R.lane.L.toFixed(2)} m · ${n} posiciones</span>
      </div>
      <div style="margin-top:8px"><button class="ml-csv btn-secondary" style="font-size:11px;padding:4px 10px">⬇ CSV</button></div>`;
    el.querySelector('.ml-csv').addEventListener('click', () => this._movingExportCSV(R));
  }

  _movingExportCSV(R) {
    let csv = `# Cargas móviles · ${R.mode === 'il' ? 'línea de influencia (carga unitaria)' : 'envolvente del tren'} · ${R.label}\n`;
    csv += `posicion[m],${R.label.replace(/[,\s]+/g, '_')}[${R.unit}]\n`;
    for (let i = 0; i < R.xs.length; i++) csv += `${R.xs[i].toFixed(4)},${R.ys[i].toExponential(6)}\n`;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `cargas_moviles_${R.mode}.csv`; a.click(); URL.revokeObjectURL(a.href);
    this.toast('Resultado exportado', 'ok');
  }

  // ════════════════════════════════════════════════════════════════════════════
  // NONLINEAR TIME-HISTORY (plastic hinges) · #48b — UI
  // The engine (nl_timehistory.js) integrates by Newmark-β + Newton an elastoplastic
  // SHEAR BUILDING (interstory springs).  The UI reduces the model to that building:
  // stories = diaphragms (ordered by z), mass = diaphragm mass, interstory stiffness
  // from a static lateral analysis proportional to the mass (shear idealization) and
  // seed yield shear Vy = Cy·accumulated weight.
  // The story table is EDITABLE (the user corrects the idealization).
  // ════════════════════════════════════════════════════════════════════════════
  async runNLTimeHistory(opts = {}) {
    const model = this.model;
    if (model.diaphragms.size < 1) {
      this.toast('El time-history no lineal (edificio de corte) requiere diafragmas rígidos por piso. Use «auto-detectar diafragmas» o defínalos.', 'warn');
      return;
    }
    const dir0 = this._lastNLTH?.dir || 'X';
    let stories;
    try { stories = this._nlthBuildStories(dir0); }
    catch (e) { this.toast(`${i18n.t('No se pudo armar el edificio de shear:')} ${e.message}`, 'error'); return; }
    if (!stories.length) { this.toast('No se identificaron pisos (diafragmas).', 'warn'); return; }

    const cfg = opts.silent ? this._nlthDefaults(stories, dir0) : await this._nlthDialog(stories, dir0);
    if (!cfg) return;
    const { dir, zeta, alpha, ag, dt, agName, stories: st } = cfg;
    if (!ag || ag.length < 2) { this.toast('Acelerograma vacío o no reconocido.', 'warn'); return; }
    this._lastNLTH = { dir, zeta, alpha };

    const m = st.map(s => s.m), k = st.map(s => s.k), Vy = st.map(s => s.Vy);
    if (m.some(v => !(v > 0)) || k.some(v => !(v > 0))) { this.toast('Cada piso necesita masa y rigidez > 0 (edite la tabla).', 'warn'); return; }
    const n = st.length;

    const btn = document.getElementById('btn-run'); if (btn) btn.classList.add('running');
    this._showProgress('Time-history no lineal…', 'Integración directa Newmark-β + Newton (rótulas elastoplásticas)');
    await new Promise(r => setTimeout(r, 20));
    try {
      const ws = this._shearFreqs(m, k);                 // frequencies of the shear building
      const w1 = ws[0], wN = ws[n - 1] || ws[0];
      const sb = shearBuilding({ m, k, Fy: Vy, alpha: m.map(() => alpha) });
      const { C } = rayleighDamping(sb.M, sb.resist.K0(), n, zeta, w1, wN);
      const res = newmarkNonlinear({ M: sb.M, resist: sb.resist, C, ag, dt, store: 'full', monitorDof: n - 1 });

      // Per-story derived: yield drift dy=Vy/k, peak drift, yielded flag.
      const dy = st.map((s, i) => s.Vy / s.k);
      const driftPeak = new Array(n).fill(0);
      for (const u of res.U) for (let i = 0; i < n; i++) { const d = Math.abs(u[i] - (i > 0 ? u[i - 1] : 0)); if (d > driftPeak[i]) driftPeak[i] = d; }
      const yielded = st.map((s, i) => driftPeak[i] > dy[i] * 1.0001);
      // Interstory drift Δ/h vs code limit (NCh433 by default, #68).
      const driftCode = this._lastNLTH?.driftCode || 'NCh433';
      let worstDrift = { ratio: 0, story: 0, dr: 0 };
      for (let i = 0; i < n; i++) {
        const h = st[i].z - (i > 0 ? st[i - 1].z : 0);
        const c = checkDrift({ drift: driftPeak[i], h, code: driftCode });
        if (c.ratio > worstDrift.ratio) worstDrift = { ratio: c.ratio, story: i, dr: c.demand, limit: c.limit };
      }
      const stats = accStats(ag, dt);
      const T1 = 2 * Math.PI / w1;

      this._nlthResult = { stories: st, dir, zeta, alpha, ag, dt, agName, nSteps: res.U.length, U: res.U,
        monDof: n - 1, peak: res.peak, peakStep: res.peakStep, dy, driftPeak, yielded, stats, T1, w1, springs: sb.springs,
        driftCode, worstDrift };
      const nY = yielded.filter(Boolean).length;
      this.toast(`Time-history NL OK · ${n} ${i18n.t('pisos')} · ${dir} · T₁=${T1.toFixed(3)}s · ${i18n.t('u_techo máx')} ${res.peak.toExponential(2)} m · ${nY} ${i18n.t('piso(s) en fluencia')}`, 'ok');
      this._nlthOpenOverlay();
      this._updateResultsIndicator?.();
    } catch (err) {
      this.toast(`${i18n.t('Time-history no lineal:')} ${i18n.t(err.message)}`, 'error'); console.error(err);
    } finally {
      if (btn) btn.classList.remove('running');
      this._hideProgress();
    }
  }

  // Natural frequencies of the shear building (tridiagonal K, diagonal M) via the
  // symmetric eigenproblem A = D^{-1/2}·K·D^{-1/2}. Returns ascending ω.
  _shearFreqs(m, k) {
    const n = m.length;
    const num = window.numeric;
    const K = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i < n; i++) { K[i][i] += k[i]; if (i > 0) { K[i - 1][i - 1] += k[i]; K[i][i - 1] -= k[i]; K[i - 1][i] -= k[i]; } }
    const A = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => K[i][j] / Math.sqrt(m[i] * m[j])));
    let ev;
    try { ev = num.eig(A).lambda.x.slice(); } catch (e) { ev = [Math.min(...k) / Math.max(...m)]; }
    return ev.map(l => Math.sqrt(Math.max(l, 1e-12))).sort((a, b) => a - b);
  }

  // Reduces the model to a shear building: stories = diaphragms by z, diaphragm mass,
  // interstory stiffness from a static lateral analysis ∝ mass.
  _nlthBuildStories(dir) {
    const model = this.model;
    const dias = [...model.diaphragms.values()].filter(d => (d.nodes || []).length).sort((a, b) => a.z - b.z);
    if (!dias.length) return [];
    const ci = dir === 'Y' ? 1 : 0;
    const g = GACC || 9.80665;
    // Mass per story (from the diaphragm).
    const masses = dias.map(d => +d.mass?.m || 0);
    // Lateral load ∝ mass, distributed over the diaphragm's nodes.
    const lc = { id: -9, name: '_nlth', selfWeight: false, type: 'static', specDir: null, loads: [] };
    dias.forEach((d, i) => {
      const p = masses[i] || 1; const per = p / d.nodes.length;
      for (const nid of d.nodes) { const F = [0, 0, 0, 0, 0, 0]; F[ci] = per; lc.loads.push({ type: 'nodal', nodeId: nid, F }); }
    });
    const view = { nodes: model.nodes, elements: model.elements, areas: model.areas, diaphragms: model.diaphragms,
      materials: model.materials, sections: model.sections, links: model.links,
      loadCases: new Map([[-9, lc]]), combinations: new Map(), mode: model.mode, units: model.units };
    let R; try { R = new StaticSolver().solve(view, -9, false); } catch (e) { R = null; }
    // Lateral displacement of each story = average of its nodes in the direction.
    const uFloor = dias.map(d => {
      if (!R) return 0; let s = 0, c = 0;
      for (const nid of d.nodes) { const u = R.getNodeDisp(nid); if (u) { s += u[ci]; c++; } }
      return c ? s / c : 0;
    });
    // Story shear (accumulated from the top) and interstory stiffness k=V/Δ.
    const stories = [];
    for (let i = 0; i < dias.length; i++) {
      let V = 0; for (let j = i; j < dias.length; j++) V += (masses[j] || 1);   // ∝ mass
      const uPrev = i > 0 ? uFloor[i - 1] : 0;
      const drift = uFloor[i] - uPrev;
      const k = (drift > 1e-12) ? V / drift : 0;
      const massAbove = masses.slice(i).reduce((a, b) => a + b, 0);
      const Vy = 0.15 * g * massAbove;                  // seed: Cy=0.15 · accumulated weight
      stories.push({ z: dias[i].z, m: masses[i], k, Vy, label: `Piso ${i + 1} (z=${dias[i].z.toFixed(2)})`, nodes: dias[i].nodes });
    }
    return stories;
  }

  _nlthDefaults(stories, dir) {
    const d = this._lastNLTH || {};
    const demo = DEMO_PRESETS.synthetic();
    return { dir: d.dir || dir, zeta: d.zeta ?? 0.05, alpha: d.alpha ?? 0.03, ag: demo.a, dt: demo.dt, agName: demo.name, stories };
  }

  async _nlthDialog(stories, dir) {
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = i18n.t('Time-history NO LINEAL — edificio de corte (rótulas)');
    const d = this._lastNLTH || {};
    const ws = this._shearFreqs(stories.map(s => s.m || 1), stories.map(s => s.k || 1));
    const T1 = stories.every(s => s.k > 0 && s.m > 0) ? (2 * Math.PI / ws[0]).toFixed(3) : '—';
    const rowsHTML = (sts) => sts.map((s, i) => `
      <tr>
        <td style="white-space:nowrap">${s.label}</td>
        <td><input type="number" data-st="${i}" data-f="m"  value="${(+s.m).toPrecision(5)}"  step="0.1"  style="width:90px"></td>
        <td><input type="number" data-st="${i}" data-f="k"  value="${(+s.k).toPrecision(5)}"  step="100"  style="width:100px"></td>
        <td><input type="number" data-st="${i}" data-f="Vy" value="${(+s.Vy).toPrecision(5)}" step="10"   style="width:100px"></td>
      </tr>`).join('');
    document.getElementById('modal-body').innerHTML = `
      <p style="color:var(--text-muted);font-size:11px;margin:0 0 8px">
        Integración directa <b>Newmark-β + Newton</b> de un <b>edificio de corte</b> elastoplástico (idealización
        de los diafragmas como masas de piso unidas por resortes de entrepiso histeréticos). La tabla se sembró del
        modelo (masa del diafragma; rigidez por análisis lateral ∝ masa); <b>edítela</b> para afinar la idealización.</p>
      <div class="prop-row">
        <div class="prop-field"><label>Dirección</label><select id="nlth-dir"><option value="X" ${(d.dir||dir)==='X'?'selected':''}>X</option><option value="Y" ${(d.dir||dir)==='Y'?'selected':''}>Y</option></select></div>
        <div class="prop-field"><label>ζ (%)</label><input type="number" id="nlth-zeta" value="${((d.zeta??0.05)*100)}" min="0" max="20" step="0.5" style="width:70px"></div>
        <div class="prop-field"><label>Endurec. α</label><input type="number" id="nlth-alpha" value="${d.alpha??0.03}" min="0" max="0.5" step="0.01" style="width:70px"></div>
        <div class="prop-field" style="justify-content:flex-end"><span style="font-size:11px;color:var(--text-muted)">T₁ ≈ <b id="nlth-t1">${T1}</b> s</span></div>
      </div>
      <div style="max-height:170px;overflow:auto;border:1px solid var(--border);border-radius:6px;margin:6px 0">
        <table class="nlth-tbl" style="width:100%;border-collapse:collapse;font-size:11px">
          <thead><tr style="position:sticky;top:0;background:var(--bg4)"><th style="text-align:left;padding:3px 6px">Piso</th><th>masa m</th><th>rigidez k</th><th>Vy (corte fluencia)</th></tr></thead>
          <tbody id="nlth-rows">${rowsHTML(stories)}</tbody>
        </table>
      </div>
      <div class="prop-row" style="font-size:11px;color:var(--text-muted)"><span>Botón de re-semilla de Vy a un coef. de corte basal Cy·peso:</span>
        <input type="number" id="nlth-cy" value="0.15" min="0.02" max="1" step="0.01" style="width:70px">
        <button id="nlth-reseed" style="font-size:11px">↻ Vy = Cy·peso acumulado</button></div>
      <div class="prop-row cols1" style="margin-top:6px">
        <div class="prop-field"><label>Acelerograma</label>
          <select id="nlth-source">
            <option value="ricker">Demo — Pulso de Ricker (sintético)</option>
            <option value="harmonic">Demo — Armónico (sintético)</option>
            <option value="synthetic" selected>Demo — Sismo sintético (NO es real)</option>
            <option value="paste">Pegar / cargar registro (t a) o (a)…</option>
          </select></div>
      </div>
      <div id="nlth-paste-box" style="display:none;margin-top:6px">
        <textarea id="nlth-text" rows="4" placeholder="Registro: «t a» (s, m/s²) o una columna «a» con Δt." style="width:100%;font-family:var(--font-mono);font-size:11px"></textarea>
        <div class="prop-row" style="margin-top:4px">
          <div class="prop-field"><label>Δt si 1 columna (s)</label><input type="number" id="nlth-dt" value="0.01" min="0.0005" step="0.005" style="width:90px"></div>
          <div class="prop-field"><label>Archivo</label><input type="file" id="nlth-file" accept=".txt,.csv,.acc,.dat,.at2"></div>
        </div>
      </div>
      <div class="prop-row" style="margin-top:6px">
        <div class="prop-field"><label>Escalar a PGA (m/s², 0 = no)</label><input type="number" id="nlth-pga" value="0" min="0" step="0.5" style="width:90px"></div>
      </div>`;
    document.getElementById('modal-cancel').style.display = '';
    overlay.classList.remove('hidden');
    const srcSel = document.getElementById('nlth-source');
    srcSel.addEventListener('change', () => { document.getElementById('nlth-paste-box').style.display = srcSel.value === 'paste' ? '' : 'none'; });
    document.getElementById('nlth-file').addEventListener('change', async (e) => { const f = e.target.files?.[0]; if (f) document.getElementById('nlth-text').value = await f.text(); });
    const readTable = () => stories.map((s, i) => ({ ...s,
      m: +document.querySelector(`[data-st="${i}"][data-f="m"]`).value || 0,
      k: +document.querySelector(`[data-st="${i}"][data-f="k"]`).value || 0,
      Vy: +document.querySelector(`[data-st="${i}"][data-f="Vy"]`).value || 0 }));
    const refreshT1 = () => {
      const st = readTable();
      if (st.every(s => s.k > 0 && s.m > 0)) document.getElementById('nlth-t1').textContent = (2 * Math.PI / this._shearFreqs(st.map(s => s.m), st.map(s => s.k))[0]).toFixed(3);
    };
    document.getElementById('nlth-rows').addEventListener('change', refreshT1);
    document.getElementById('nlth-reseed').addEventListener('click', () => {
      const Cy = +document.getElementById('nlth-cy').value || 0.15, g = GACC || 9.80665;
      const st = readTable();
      for (let i = 0; i < st.length; i++) { const massAbove = st.slice(i).reduce((a, b) => a + (b.m || 0), 0); document.querySelector(`[data-st="${i}"][data-f="Vy"]`).value = (Cy * g * massAbove).toPrecision(5); }
    });

    const ok = await new Promise(res => { overlay._resolve = res; overlay._reject = () => res(false); });
    if (!ok) return null;
    const st = readTable();
    const dirV = document.getElementById('nlth-dir').value;
    const zeta = Math.max(0, Math.min(0.2, (+document.getElementById('nlth-zeta').value || 5) / 100));
    const alpha = Math.max(0, Math.min(0.5, +document.getElementById('nlth-alpha').value || 0.03));
    const pga = +document.getElementById('nlth-pga').value || 0;
    let ag, dt, agName;
    if (srcSel.value === 'paste') {
      const parsed = parseAccelerogram(document.getElementById('nlth-text').value, +document.getElementById('nlth-dt').value || 0.01);
      if (!parsed.ok) { this.toast(i18n.t('Registro:') + ' ' + parsed.note, 'warn'); return null; }
      ag = parsed.a; dt = parsed.dt; agName = `Registro cargado (${parsed.n} pts, Δt=${dt.toFixed(4)}s)`;
    } else { const demo = DEMO_PRESETS[srcSel.value](); ag = demo.a; dt = demo.dt; agName = demo.name; }
    if (pga > 0) ag = scaleToPGA(ag, pga);
    return { dir: dirV, zeta, alpha, ag, dt, agName, stories: st };
  }

  // #90: Nonlinear time-history (shear building) → «NL Dynamic» tab.
  _nlthOpenOverlay() {
    if (!this._nlthResult) return;
    this.panel._switchVTab('results');
    this.panel._switchRTab('nlth');   // → _nlthRenderPanel()
  }

  // Builds the «NL Dynamic» tab content in #nlth-panel: history of the monitor story +
  // animated «stick» diagram. Same IDs → _nlthBuildPlot/_nlthShowStep unchanged.
  _nlthRenderPanel() {
    const el = document.getElementById('nlth-panel');
    const hint = document.getElementById('res-nlth-hint');
    if (!el) return;
    const R = this._nlthResult;
    if (!R) { if (hint) hint.style.display = ''; el.innerHTML = ''; return; }
    if (hint) hint.style.display = 'none';
    this._nlthStopPlay?.();
    const stOpts = R.stories.map((s, i) => `<option value="${i}" ${i === R.monDof ? 'selected' : ''}>${s.label}${R.yielded[i] ? ' ⚠' : ''}</option>`).join('');
    el.innerHTML = `
      <div style="display:flex;gap:8px">
        <div style="flex:0 0 96px"><div id="nlth-stick"></div></div>
        <div style="flex:1;min-width:0">
          <div class="prop-row" style="margin:0 0 6px">
            <div class="prop-field"><label style="font-size:10px">Monitor</label><select id="nlth-mon">${stOpts}</select></div>
            <div class="prop-field"><label style="font-size:10px">Escala</label><input type="number" id="nlth-scale" value="1" min="0.1" step="0.5" style="width:56px"></div>
          </div>
          <div id="nlth-plot"></div>
        </div>
      </div>
      <div id="nlth-readout" style="font-size:11px;margin-top:6px;line-height:1.6"></div>
      <div class="prop-row" style="align-items:center;gap:6px;margin-top:8px">
        <button id="nlth-play" class="btn-secondary" style="font-size:14px;padding:2px 8px">▶</button>
        <input type="range" id="nlth-step" min="0" max="${R.nSteps - 1}" value="${R.peakStep}" style="flex:1">
        <select id="nlth-speed" title="Velocidad de animación" style="font-size:11px"><option value="0.5">×0.5</option><option value="1" selected>×1</option><option value="2">×2</option><option value="4">×4</option></select>
        <button id="nlth-max" class="btn-secondary" title="Ir al pico" style="font-size:11px;padding:2px 6px">Máx</button>
        <button id="nlth-csv" class="btn-secondary" style="font-size:11px;padding:2px 6px">⬇ CSV</button>
      </div>`;
    document.getElementById('nlth-mon').addEventListener('change', e => { R.monDof = +e.target.value; this._nlthBuildPlot(); this._nlthShowStep(+document.getElementById('nlth-step').value); });
    document.getElementById('nlth-scale').addEventListener('change', () => this._nlthShowStep(+document.getElementById('nlth-step').value));
    document.getElementById('nlth-step').addEventListener('input', e => { this._nlthStopPlay?.(); this._nlthShowStep(+e.target.value); });
    document.getElementById('nlth-max').addEventListener('click', () => { document.getElementById('nlth-step').value = R.peakStep; this._nlthShowStep(R.peakStep); });
    document.getElementById('nlth-csv').addEventListener('click', () => this._nlthExportCSV());
    document.getElementById('nlth-play').addEventListener('click', () => this._nlthTogglePlay());
    this._nlthBuildPlot();
    this._nlthShowStep(R.peakStep);
  }

  _nlthBuildPlot() {
    const R = this._nlthResult; const n = R.nSteps;
    const h = new Float64Array(n); for (let k = 0; k < n; k++) h[k] = R.U[k][R.monDof];
    R._hist = h;
    let pk = 0, pkStep = 0; for (let k = 0; k < n; k++) { const a = Math.abs(h[k]); if (a > pk) { pk = a; pkStep = k; } }
    R._histPeak = pk; R._histPeakStep = pkStep;
    const W = 320, H = 110, ml = 4, mr = 4, mt = 8, mb = 4;
    const hmax = pk || 1e-30, tmax = (n - 1) * R.dt || 1;
    const sx = k => ml + (W - ml - mr) * (k * R.dt) / tmax;
    const sy = u => mt + (H - mt - mb) * (1 - (u / hmax + 1) / 2);
    let poly = ''; const sd = Math.max(1, Math.floor(n / 700));
    for (let k = 0; k < n; k += sd) poly += `${sx(k).toFixed(1)},${sy(h[k]).toFixed(1)} `;
    const y0 = sy(0).toFixed(1);
    R._svg = (k) => `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:${H}px;background:var(--bg3,#0b1220);border-radius:6px">
      <line x1="${ml}" y1="${y0}" x2="${W - mr}" y2="${y0}" stroke="var(--border,#26324d)" stroke-width="1"/>
      <polyline points="${poly}" fill="none" stroke="var(--accent,#38bdf8)" stroke-width="1.3"/>
      <circle cx="${sx(k).toFixed(1)}" cy="${sy(h[k]).toFixed(1)}" r="3.2" fill="#f59e0b"/></svg>`;
  }

  // «Stick» diagram of the deformed building at step k.
  _nlthStickSVG(step) {
    const R = this._nlthResult, n = R.stories.length;
    const u = R.U[step];
    const scale = +document.getElementById('nlth-scale')?.value || 1;
    const W = 120, H = 230, mx = 56, mb = 14, mt = 12;
    const zmax = Math.max(...R.stories.map(s => s.z)) || 1;
    let umax = 0; for (const uu of R.U) for (let i = 0; i < n; i++) umax = Math.max(umax, Math.abs(uu[i]));
    umax = umax || 1e-9;
    const sy = z => H - mb - (H - mb - mt) * z / zmax;
    const sx = ux => mx + (W - mx - 8) * scale * ux / umax;
    let pts = `${mx},${H - mb} `; for (let i = 0; i < n; i++) pts += `${sx(u[i]).toFixed(1)},${sy(R.stories[i].z).toFixed(1)} `;
    let dots = '';
    for (let i = 0; i < n; i++) dots += `<circle cx="${sx(u[i]).toFixed(1)}" cy="${sy(R.stories[i].z).toFixed(1)}" r="4" fill="${R.yielded[i] ? '#ef4444' : '#38bdf8'}"/>`;
    return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:${H}px;background:var(--bg3,#0b1220);border-radius:6px">
      <line x1="${mx}" y1="${mt}" x2="${mx}" y2="${H - mb}" stroke="var(--border,#26324d)" stroke-width="1" stroke-dasharray="3 3"/>
      <polyline points="${pts}" fill="none" stroke="var(--accent,#38bdf8)" stroke-width="1.6"/>${dots}
      <text x="4" y="${H - 2}" fill="var(--text-muted,#9aa)" font-size="9">rojo = piso en fluencia</text></svg>`;
  }

  _nlthShowStep(step) {
    const R = this._nlthResult; if (!R) return;
    step = Math.max(0, Math.min(R.nSteps - 1, step | 0));
    const stick = document.getElementById('nlth-stick'); if (stick) stick.innerHTML = this._nlthStickSVG(step);
    const plot = document.getElementById('nlth-plot'); if (plot && R._svg) plot.innerHTML = R._svg(step);
    const t = step * R.dt, ag = R.ag[step];
    const ro = document.getElementById('nlth-readout');
    const nY = R.yielded.filter(Boolean).length;
    const uResid = Math.abs(R.U[R.nSteps - 1][R.monDof]);
    if (ro) ro.innerHTML = `t = <b>${t.toFixed(3)} s</b> / ${((R.nSteps - 1) * R.dt).toFixed(2)} s · a_g = ${ag.toFixed(3)} m/s²<br>`
      + `u(${R.stories[R.monDof].label}) = ${R._hist[step].toExponential(3)} m · máx = <b>${(R._histPeak ?? 0).toExponential(3)} m</b><br>`
      + `${R.stories.length} pisos · T₁=${R.T1.toFixed(3)} s · ζ=${(R.zeta * 100).toFixed(1)}% · α=${R.alpha} · dir ${R.dir} · PGA=${R.stats.pga.toFixed(2)} m/s²<br>`
      + `pisos en fluencia: <b>${nY}/${R.stories.length}</b> · deriva residual monitor ${uResid.toExponential(2)} m<br>`
      + `deriva máx Δ/h = <b>${(R.worstDrift?.dr ?? 0).toExponential(2)}</b> (piso ${(R.worstDrift?.story ?? 0) + 1}) vs límite ${R.driftCode} ${(R.worstDrift?.limit ?? 0)} → <b style="color:${(R.worstDrift?.ratio ?? 0) > 1 ? '#ef4444' : '#22c55e'}">${(R.worstDrift?.ratio ?? 0).toFixed(2)}</b> · ${R.agName}`;
  }

  _nlthTogglePlay() {
    if (this._nlthTimer) { this._nlthStopPlay(); return; }
    const R = this._nlthResult; if (!R) return;
    const btn = document.getElementById('nlth-play'); if (btn) btn.textContent = '⏸';
    const stepInp = document.getElementById('nlth-step');
    const speedEl = document.getElementById('nlth-speed');
    const base = Math.max(1, Math.floor(R.nSteps / 240));
    this._nlthTimer = setInterval(() => {
      const skip = Math.max(1, Math.round(base * (parseFloat(speedEl?.value) || 1)));
      let s = (+stepInp.value || 0) + skip; if (s >= R.nSteps) s = 0;
      stepInp.value = s; this._nlthShowStep(s);
    }, 40);
  }

  _nlthStopPlay() {
    if (this._nlthTimer) { clearInterval(this._nlthTimer); this._nlthTimer = null; }
    const btn = document.getElementById('nlth-play'); if (btn) btn.textContent = '▶';
  }

  _nlthExportCSV() {
    const R = this._nlthResult; if (!R) return;
    const n = R.stories.length;
    let csv = `# Time-history NO LINEAL (edificio de corte) · dir ${R.dir} · ${n} pisos · zeta ${(R.zeta*100).toFixed(1)}% · alpha ${R.alpha} · ${R.agName}\n`;
    csv += `# T1=${R.T1.toFixed(4)}s · pisos en fluencia: ${R.yielded.map((y,i)=>y?i+1:null).filter(x=>x).join('/')||'ninguno'}\n`;
    csv += 't[s],a_g[m/s2],' + R.stories.map((s, i) => `u_piso${i + 1}[m]`).join(',') + '\n';
    for (let k = 0; k < R.nSteps; k++) csv += `${(k*R.dt).toFixed(5)},${R.ag[k].toFixed(6)},` + R.U[k].slice(0, n).join(',') + '\n';
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `timehistory_NL_${R.dir}.csv`; a.click(); URL.revokeObjectURL(a.href);
    this.toast('Historia exportada', 'ok');
  }

  // ════════════════════════════════════════════════════════════════════════════
  // AUTOMATIC DESIGN (G17 #71/#72/#73) — UI with NON-destructive preview.
  // The engine (autodesign.js) NEVER invents: it only picks from the catalog. Here the
  // proposal is built per section (continuity), a PREVIEW is shown (current section →
  // proposal · D/C · weight) and only on confirmation is it applied to the model (with undo).
  // ════════════════════════════════════════════════════════════════════════════
  async autoDesignDialog(dis) {
    dis = dis || await this._computeDesign();
    if (!dis || !dis.filas?.length) { this.toast('Ejecute el análisis estático (F5) antes de diseñar.', 'warn'); return; }
    const sel = new Set(this._selElems());
    const scope = sel.size ? `selección (${sel.size})` : 'todo el modelo';
    // Demand per element (envelope) from the design table.
    const demByEl = new Map(dis.filas.map(f => [f.id, f]));
    // Design family of the material (steel/aluminum → steel catalog; RC; timber).
    const famOf = (mat) => {
      const f = mat?.design?.family;
      if (f === 'concrete' || f === 'timber' || f === 'steel' || f === 'aluminum') return f;
      if (/horm|concret|h\s*\d/i.test(mat?.name || '')) return 'concrete';
      if (/mader|pino|wood|c1[68]|c24|timber/i.test(mat?.name || '')) return 'timber';
      return 'steel';
    };
    // Group by SECTION (continuity: one proposal per section).
    const groups = new Map();   // secId → { secId, els:[], dem:{}, mat, fam, Lb }
    for (const el of this.model.elements.values()) {
      if (sel.size && !sel.has(el.id)) continue;
      const mat = this.model.materials.get(el.matId);
      const f = demByEl.get(el.id); if (!f) continue;
      let g = groups.get(el.secId);
      if (!g) { g = { secId: el.secId, els: [], dem: { N: 0, Vy: 0, Vz: 0, My: 0, Mz: 0, L: 0 }, mat, fam: famOf(mat), Lb: 0 }; groups.set(el.secId, g); }
      g.els.push(el.id);
      // envelope of the group's demand (max |·| per component; N keeps the worst's sign)
      for (const k of ['Vy', 'Vz', 'My', 'Mz']) g.dem[k] = Math.max(g.dem[k], Math.abs(f.forces[k] || 0));
      if (Math.abs(f.forces.N || 0) > Math.abs(g.dem.N)) g.dem.N = f.forces.N;
      g.dem.L = Math.max(g.dem.L, f.forces.L || 0);
      g.Lb = Math.max(g.Lb, el.design?.Lb || f.forces.L || 0);
    }
    if (!groups.size) { this.toast('No hay elementos en el alcance con resultados de diseño.', 'warn'); return; }

    const codeByFam = this.model.designSettings?.codeByFamily || {};
    // Per-group context (to recompute without rebuilding demands when the #84 limit changes).
    this._adGroups = [...groups.values()].map(g => {
      const secNow = this.model.sections.get(g.secId);
      const sharedOut = [...this.model.elements.values()].some(e => e.secId === g.secId && !g.els.includes(e.id));
      return { secId: g.secId, secName: secNow?.name || `sec ${g.secId}`, nEls: g.els.length, fam: g.fam,
        role: secNow?.role || 'generico',
        dem: g.dem, mat: g.mat, code: codeByFam[g.fam], Lb: g.Lb, sharedOut, prefer: secNow?.design?.profile,
        actual: secNow?.design?.profile || `A=${(secNow?.A * 1e4 || 0).toFixed(1)} cm²` };
    });
    this._adScope = scope;
    this._adRoleFilter = this._adRoleFilter || 'all';
    this._adLimits = {};
    this._adPrefs = this._adPrefs || { dcTarget: 0.85, steelFamilies: ['IPE', 'HEA', 'HEB'] };   // preferences (#73)
    this._adCompute();
  }

  // Recomputes the auto-design proposals with the current dimension limits (#84) and
  // preferences (#73: target D/C + allowed steel families), and reopens the overlay.
  // Reuses the per-group context saved earlier.
  _adCompute() {
    const { maxWidth, maxHeight } = this._adLimits || {};
    const P = this._adPrefs || { dcTarget: 0.85, steelFamilies: ['IPE', 'HEA', 'HEB'] };
    // Filter by type (column/beam/generic): iterate only the marked sections.
    const roleF = this._adRoleFilter || 'all';
    const rows = (this._adGroups || []).filter(g => roleF === 'all' || (g.role || 'generico') === roleF).map(g => {
      // Allowed steel families (#73): restricts the steel/aluminum catalog.
      const candidates = candidatesForFamily(g.fam, { steelFamilies: P.steelFamilies?.length ? P.steelFamilies : ['IPE', 'HEA', 'HEB'] });
      const sel2 = selectProfile({ demands: g.dem, candidates, mat: g.mat, code: g.code,
        member: { L: g.dem.L, Lb: g.Lb || g.dem.L },
        prefs: { prefer: g.prefer, dcTarget: P.dcTarget ?? 0.85, maxWidth, maxHeight } });
      return { secId: g.secId, secName: g.secName, nEls: g.nEls, fam: g.fam, role: g.role, actual: g.actual,
        best: sel2.best, note: sel2.note, sharedOut: g.sharedOut, dem: g.dem };
    });
    this._autoDesignRows = rows;
    this._autoDesignOverlay(rows, this._adScope, this._adLimits);
  }

  _autoDesignOverlay(rows, scope, limits = {}) {
    document.getElementById('ad-overlay')?.remove();
    const fmt = v => (v == null || !isFinite(v)) ? '—' : (+v).toFixed(2);
    const body = rows.map((r, i) => {
      const b = r.best;
      const dcCol = b ? (b.dc > 1 ? '#ef4444' : b.dc > 0.9 ? '#f59e0b' : '#22c55e') : '#ef4444';
      const roleIco = { pilar: '🟦', viga: '🟩' }[r.role] || '·';
      return `<tr>
        <td><input type="checkbox" class="ad-chk" data-i="${i}" ${b ? 'checked' : ''} ${b ? '' : 'disabled'}></td>
        <td>${esc(r.secName)}<br><span style="color:var(--text-muted);font-size:10px">${roleIco} ${r.nEls} elem${r.sharedOut ? ' ⚠ compartida' : ''}</span></td>
        <td style="font-size:10px">${esc(r.actual)}</td>
        <td><b>${b ? esc(b.name) : '—'}</b></td>
        <td style="color:${dcCol}"><b>${b ? fmt(b.dc) : '—'}</b></td>
        <td style="text-align:right;font-size:10px">${b ? (b.weight).toFixed(1) : '—'}</td>
        <td style="font-size:10px;color:var(--text-muted)">${b ? (b.governs || '') : (r.note || 'sin solución')}</td>
      </tr>`;
    }).join('');
    const anyBest = rows.some(r => r.best);
    const el = document.createElement('div'); el.id = 'ad-overlay';
    el.innerHTML = `
      <div class="ad-card" role="dialog" aria-label="Diseñar (auto-selección)">
        <div class="ad-head"><b>🧮 Diseñar (auto-selección desde catálogo) · ${scope}</b><button class="ad-x">✕</button></div>
        <div class="ad-body">
          <p style="font-size:11px;color:var(--text-muted);margin:0 0 8px">Por sección, la candidata más liviana que cumple <b>D/C≤1</b> (objetivo 0.75–0.90): acero del catálogo (IPE/HEA/HEB), H.A. (escuadrías + ρ) o madera (escuadrías). Vista previa NO destructiva; nada cambia hasta «Aplicar».</p>
          <div style="display:flex;gap:12px;align-items:center;margin:0 0 8px;font-size:11px;flex-wrap:wrap">
            <span style="color:var(--text-muted)">Límite de dimensiones (opcional):</span>
            <label>ancho máx <input class="ad-maxw" type="number" min="0" step="1" value="${limits?.maxWidth != null ? +(limits.maxWidth * 100).toFixed(1) : ''}" style="width:54px"> cm</label>
            <label>alto máx <input class="ad-maxh" type="number" min="0" step="1" value="${limits?.maxHeight != null ? +(limits.maxHeight * 100).toFixed(1) : ''}" style="width:54px"> cm</label>
          </div>
          <div style="display:flex;gap:12px;align-items:center;margin:0 0 8px;font-size:11px;flex-wrap:wrap">
            <label title="Recorrer sólo las secciones marcadas como pilar o viga (según el «Tipo de elemento» de la sección).">Diseñar
              <select class="ad-role" style="font-size:11px">
                <option value="all" ${(this._adRoleFilter || 'all') === 'all' ? 'selected' : ''}>Todas</option>
                <option value="column" ${this._adRoleFilter === 'column' ? 'selected' : ''}>🟦 Sólo pilares</option>
                <option value="beam" ${this._adRoleFilter === 'beam' ? 'selected' : ''}>🟩 Sólo vigas</option>
                <option value="generico" ${this._adRoleFilter === 'generico' ? 'selected' : ''}>· Sólo genéricas</option>
              </select></label>
            <label title="D/C objetivo: la selección prefiere candidatos con D/C cerca de este valor (sin pasar de 1).">D/C objetivo <input class="ad-dctgt" type="number" min="0.3" max="1" step="0.05" value="${(this._adPrefs?.dcTarget ?? 0.85)}" style="width:54px"></label>
            <span style="color:var(--text-muted)" title="Familias de acero permitidas como candidatas (sólo aplica a secciones de acero/aluminio).">Acero:</span>
            ${['IPE', 'HEA', 'HEB'].map(fa => `<label style="display:inline-flex;gap:3px;align-items:center"><input type="checkbox" class="ad-fam" value="${fa}" ${(this._adPrefs?.steelFamilies || ['IPE','HEA','HEB']).includes(fa) ? 'checked' : ''}>${fa}</label>`).join('')}
          </div>
          <div style="max-height:46vh;overflow:auto;border:1px solid var(--border);border-radius:6px">
            <table class="ad-tbl" style="width:100%;border-collapse:collapse;font-size:11.5px">
              <thead><tr style="position:sticky;top:0;background:var(--bg4)"><th></th><th style="text-align:left">Sección</th><th>Actual</th><th>Propuesta</th><th>D/C</th><th>kg/m</th><th>Gob.</th></tr></thead>
              <tbody>${body}</tbody>
            </table>
          </div>
        </div>
        <div class="ad-foot">
          <span style="font-size:11px;color:var(--text-muted)">⚠ compartida = la sección la usan también elementos fuera del alcance.</span>
          <button class="ad-apply" ${anyBest ? '' : 'disabled'}>✓ Aplicar al modelo</button>
        </div>
      </div>`;
    document.getElementById('viewport-wrap')?.appendChild(el) || document.body.appendChild(el);
    el.querySelector('.ad-x').addEventListener('click', () => el.remove());
    el.querySelector('.ad-apply').addEventListener('click', () => this._autoDesignApply());
    // Dimension limit (#84): on change, recompute the proposals (on 'change' so it
    // doesn't redo on every keystroke). Empty/0 = no limit on that axis.
    const onLim = () => {
      const w = parseFloat(el.querySelector('.ad-maxw').value);
      const h = parseFloat(el.querySelector('.ad-maxh').value);
      this._adLimits = { maxWidth: w > 0 ? w / 100 : undefined, maxHeight: h > 0 ? h / 100 : undefined };
      this._adCompute();
    };
    el.querySelector('.ad-maxw').addEventListener('change', onLim);
    el.querySelector('.ad-maxh').addEventListener('change', onLim);
    // Preferences (#73): target D/C + allowed steel families → recompute.
    const onPrefs = () => {
      const dt = parseFloat(el.querySelector('.ad-dctgt').value);
      const fams = [...el.querySelectorAll('.ad-fam:checked')].map(c => c.value);
      this._adPrefs = { dcTarget: (dt > 0 && dt <= 1) ? dt : 0.85, steelFamilies: fams };
      this._adCompute();
    };
    el.querySelector('.ad-dctgt').addEventListener('change', onPrefs);
    el.querySelectorAll('.ad-fam').forEach(c => c.addEventListener('change', onPrefs));
    // Filter by element type (column/beam/generic) → recompute the scope.
    el.querySelector('.ad-role')?.addEventListener('change', (ev) => {
      this._adRoleFilter = ev.target.value;
      this._adCompute();
    });
    if (!document.getElementById('ad-overlay-css')) {
      const s = document.createElement('style'); s.id = 'ad-overlay-css';
      s.textContent = `
        #ad-overlay{position:absolute;inset:0;z-index:60;display:flex;align-items:flex-start;justify-content:center;background:rgba(0,0,0,.28);padding-top:54px}
        #ad-overlay .ad-card{width:min(560px,94%);max-height:84%;display:flex;flex-direction:column;background:var(--bg-elev,#141b27);border:1px solid var(--border,#334);border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.5);color:var(--text,#e6edf3)}
        #ad-overlay .ad-head{display:flex;justify-content:space-between;align-items:center;padding:9px 13px;border-bottom:1px solid var(--border,#334);font-size:13px}
        #ad-overlay .ad-x{background:none;border:none;color:var(--text-muted,#9aa);cursor:pointer;font-size:14px}
        #ad-overlay .ad-body{padding:10px 13px;overflow:auto}
        #ad-overlay .ad-tbl th,#ad-overlay .ad-tbl td{padding:4px 6px;border-bottom:1px solid var(--border,#26324d);text-align:center}
        #ad-overlay .ad-foot{padding:9px 13px;border-top:1px solid var(--border,#334);display:flex;justify-content:space-between;align-items:center;gap:10px}
        #ad-overlay .ad-apply{font-size:12px;padding:6px 13px;border-radius:6px;cursor:pointer;border:1px solid var(--accent,#388bfd);background:var(--accent,#388bfd);color:#fff}
        #ad-overlay .ad-apply:disabled{opacity:.5;cursor:default}`;
      document.head.appendChild(s);
    }
  }

  async _autoDesignApply() {
    const rows = this._autoDesignRows || [];
    const picks = [...document.querySelectorAll('#ad-overlay .ad-chk:checked')].map(c => rows[+c.dataset.i]).filter(r => r && r.best);
    if (!picks.length) { this.toast('No hay propuestas seleccionadas', 'warn'); return; }
    this.snapshot();
    let n = 0;
    for (const r of picks) {
      // The candidate already carries its resolved section (steel from catalog, or RC/timber rect).
      const props = r.best.sec; if (!props) continue;
      this.model.updateSection(r.secId, { A: props.A, Iz: props.Iz, Iy: props.Iy, J: props.J, Avy: props.Avy, Avz: props.Avz, design: props.design });
      const s = this.model.sections.get(r.secId);
      if (s) s.name = r.best.name;     // renames the section to the proposal
      n++;
    }
    this.markDirty();
    this.viewport.renderModel?.(this.model);
    this.panel.renderSections?.();
    document.getElementById('ad-overlay')?.remove();
    this.toast(`${i18n.t('Diseño aplicado a')} ${n} ${i18n.t('sección(es). Recalcule el análisis (F5) y vuelva a verificar. Ctrl+Z deshace.')}`, 'ok');
    this.panel.renderDesign?.();
  }

  // ── Downloadable design report (CSV, #73) ───────────────────────────────────
  // Per element: section, combo/case, design forces, D/C per check
  // (bending/shear/axial/interaction), the governing one and max nodal |δ|.
  exportDesignReportCSV(dis) {
    dis = dis || this._lastDiseno;
    const f = dis?.filas;
    if (!f || !f.length) { this.toast('Ejecute el análisis (F5) y verifique el diseño antes de exportar el reporte.', 'warn'); return; }
    const num = v => (v == null || !isFinite(v)) ? '' : (+v).toFixed(4);
    const dispOf = (id) => {
      try { const el = this.model.elements.get(id), r = this._results; if (!el || !r) return null;
        let mx = 0; for (const nid of [el.n1, el.n2]) { const d = r.getNodeDisp(nid); mx = Math.max(mx, Math.hypot(d[0], d[1], d[2])); } return mx; }
      catch { return null; }
    };
    const code = this.model.designSettings?.codeByFamily ? JSON.stringify(this.model.designSettings.codeByFamily) : 'default';
    let csv = `# Reporte de diseño PORTICO · ${new Date().toLocaleString('es-CL')}\n`;
    csv += `# Caso/combo: ${dis.caso || 'activo'} · codigo por familia: ${code}\n`;
    csv += `# D/C = demanda/capacidad <= 1 (cumple). |delta| = desplazamiento nodal max del elemento.\n`;
    csv += `elem,seccion,gobierna,N[kN],Vy[kN],Vz[kN],My[kNm],Mz[kNm],DC_flexion,DC_corte,DC_axial,DC_interaccion,DC_max,cumple,delta_mm\n`;
    for (const x of f) {
      const fz = x.forces || {};
      const dmm = dispOf(x.id); const dmmS = dmm == null ? '' : (dmm * 1000).toFixed(3);
      csv += [x.id, `"${(x.sec || '').replace(/"/g, "'")}"`, `"${x.governs || ''}"`,
        num(fz.N), num(fz.Vy), num(fz.Vz), num(fz.My), num(fz.Mz),
        num(x.bending?.ratio), num(x.shear?.ratio), num(x.axial?.ratio), num(x.interaction?.ratio),
        num(x.ratioMax), (x.ratioMax <= 1 ? 'si' : 'NO'), dmmS].join(',') + '\n';
    }
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `reporte_diseno_${(this._modelName || 'modelo').replace(/\W+/g, '_')}.csv`; a.click();
    URL.revokeObjectURL(a.href);
    const nNo = f.filter(x => x.ratioMax > 1).length;
    this.toast(`${i18n.t('Reporte de diseño exportado')} · ${f.length} ${i18n.t('elementos')} · ${nNo} ${i18n.t('no cumplen')}`, 'ok');
  }

  // ── «Strong column – weak beam» joints (SCWB, #68) ──────────────────────────
  // Walks the joints (ΣMnc ≥ γ·ΣMnb, Mn ≈ Fy·Zz by default), highlights them in the
  // viewport (red = fails, green = passes) and opens an overlay with the table.
  runSCWB(gamma) {
    const model = this.model;
    if (!model.elements.size) { this.toast('No hay barras para chequear nudos SCWB', 'warn'); return; }
    gamma = gamma ?? this._scwbGamma ?? 1.2;
    const MnOf = (eid) => {
      const el = model.elements.get(eid); if (!el) return 0;
      const M = resolveMaterial(model.materials.get(el.matId) || {});
      const S = resolveSectionProps(model.sections.get(el.secId) || {});
      return (M.Fy || M.fc || 0) * (S.Zz || S.Sz || 0);   // kN·m (kPa·m³)
    };
    const res = jointSCWB(model, MnOf, { gamma });
    if (!res.length) { this.toast('No hay nudos viga-columna (se necesita ≥1 columna y ≥1 viga concurrentes; se clasifica por verticalidad)', 'warn'); return; }
    this._scwbRes = res; this._scwbGamma = gamma;
    this.viewport.showSCWB(res);
    this._scwbOverlay(res, gamma);
    const nBad = res.filter(r => !r.ok).length;
    this.toast(`${i18n.t('Nudos SCWB:')} ${res.length} ${i18n.t('nudo(s) viga-columna')} · ${nBad} ${i18n.t('NO cumple(n)')} · γ=${gamma}`, nBad ? 'warn' : 'ok');
  }

  _scwbOverlay(res, gamma) {
    document.getElementById('scwb-overlay')?.remove();
    const el = document.createElement('div'); el.id = 'scwb-overlay';
    el.style.cssText = 'position:fixed;right:16px;bottom:84px;z-index:50;background:var(--bg4);border:1px solid var(--border);border-radius:8px;padding:10px 12px;width:300px;box-shadow:0 8px 24px rgba(0,0,0,.4);font-size:12px;color:var(--text)';
    const nBad = res.filter(r => !r.ok).length;
    const rows = res.map(r => `
      <tr class="scwb-row" data-node="${r.node}" style="cursor:pointer">
        <td style="text-align:center">${r.node}</td>
        <td style="text-align:right;font-family:var(--font-mono);font-size:10px">${r.sumMnc.toFixed(0)}</td>
        <td style="text-align:right;font-family:var(--font-mono);font-size:10px">${r.sumMnb.toFixed(0)}</td>
        <td style="text-align:center;color:${r.ok ? 'var(--teal,#2dd4bf)' : '#ef4444'}"><b>${isFinite(r.ratio) ? r.ratio.toFixed(2) : '∞'}</b></td>
        <td style="text-align:center">${r.ok ? '✓' : '✗'}</td>
      </tr>`).join('');
    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <b style="color:var(--accent,#38bdf8)">🏛️ Nudos columna fuerte–viga débil</b>
        <button id="scwb-close" title="Cerrar" style="background:none;border:none;color:var(--text-muted,#94a3b8);cursor:pointer;font-size:16px;line-height:1">✕</button>
      </div>
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;font-size:11px;color:var(--text-muted)">
        <span>γ = ΣMnc ≥ γ·ΣMnb</span>
        <input type="number" id="scwb-gamma" value="${gamma}" min="1" max="2" step="0.05" style="width:56px">
        <span style="margin-left:auto"><b style="color:${nBad ? '#ef4444' : 'var(--teal,#2dd4bf)'}">${nBad}</b>/${res.length} ✗</span>
      </div>
      <div style="max-height:42vh;overflow:auto;border:1px solid var(--border);border-radius:5px">
        <table style="width:100%;border-collapse:collapse;font-size:11px">
          <thead><tr style="position:sticky;top:0;background:var(--bg4)">
            <th style="padding:3px">Nudo</th><th>ΣMnc</th><th>ΣMnb</th><th>D/C</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <p style="font-size:10px;color:var(--text-muted);margin:6px 0 0">Mn ≈ Fy·Zz por barra. Clasificación columna/viga por verticalidad. Clic en una fila para centrar el nudo. Rojo = no cumple.</p>`;
    document.body.appendChild(el);
    el.querySelector('#scwb-close').addEventListener('click', () => { el.remove(); this.viewport.clearSCWB(); });
    el.querySelector('#scwb-gamma').addEventListener('change', (e) => {
      const g = parseFloat(e.target.value); if (g > 0) this.runSCWB(g);
    });
    el.querySelectorAll('.scwb-row').forEach(tr => tr.addEventListener('click', () => {
      this.viewport.centerOnNode?.(+tr.dataset.node);
    }));
  }

  // ── Preliminary sizing (#71): dialog BEFORE the analysis ────────────────────
  async predimensionarDialog() {
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = i18n.t('⚡ Predimensionar (preliminar)');
    document.getElementById('modal-body').innerHTML = `
      <p style="color:var(--text-muted);font-size:11px;margin:0 0 8px">Reglas simples de ingeniería para una sección inicial (antes del análisis). El resultado es <b>editable</b> y preliminar — requiere verificación posterior.</p>
      <div class="prop-row">
        <div class="prop-field"><label>Tipo</label><select id="pd-tipo"><option value="beam">Viga</option><option value="column">Columna</option></select></div>
        <div class="prop-field"><label>Material</label><select id="pd-mat"><option value="steel">Acero</option><option value="concrete">Hormigón armado</option><option value="timber">Madera</option></select></div>
      </div>
      <div class="prop-row">
        <div class="prop-field"><label>Luz / altura L (m)</label><input type="number" id="pd-L" value="6" step="0.5" style="width:90px"></div>
        <div class="prop-field" id="pd-q-box"><label>Carga q (kN/m)</label><input type="number" id="pd-q" value="20" step="1" style="width:90px"></div>
        <div class="prop-field" id="pd-N-box" style="display:none"><label>Axial N (kN)</label><input type="number" id="pd-N" value="800" step="50" style="width:90px"></div>
        <div class="prop-field" id="pd-fc-box" style="display:none"><label>f'c (MPa)</label><input type="number" id="pd-fc" value="25" step="5" style="width:70px"></div>
      </div>
      <div id="pd-out" style="font-size:12px;margin-top:6px;padding:8px;border:1px dashed var(--border);border-radius:6px;color:var(--text-muted)">…</div>
      <label style="font-size:11px;display:flex;align-items:center;gap:6px;margin-top:6px"><input type="checkbox" id="pd-assign"> Crear sección y asignar a la selección de elementos</label>`;
    document.getElementById('modal-cancel').style.display = '';
    overlay.classList.remove('hidden');
    const tipo = () => document.getElementById('pd-tipo').value, matf = () => document.getElementById('pd-mat').value;
    const refresh = () => {
      const isCol = tipo() === 'column', isC = matf() === 'concrete';
      document.getElementById('pd-q-box').style.display = isCol ? 'none' : '';
      document.getElementById('pd-N-box').style.display = isCol ? '' : 'none';
      document.getElementById('pd-fc-box').style.display = (isCol && isC) ? '' : 'none';
      const p = predimensionar({ type: tipo(), material: matf(), L: +document.getElementById('pd-L').value || 6,
        q: +document.getElementById('pd-q').value || 20, N: +document.getElementById('pd-N').value || 800, fc: +document.getElementById('pd-fc').value || 25,
        H: +document.getElementById('pd-L').value || 3 });
      this._predim = p;
      const dimTxt = p.profile ? `<b>${p.profile}</b>` : Object.entries(p.dims).map(([k, v]) => `${k}=${(v * 1000).toFixed(0)} mm`).join(' · ');
      document.getElementById('pd-out').innerHTML = `Propuesta: ${dimTxt}<br><span style="font-size:11px">${p.nota}</span>`;
    };
    overlay.querySelectorAll('#pd-tipo,#pd-mat,#pd-L,#pd-q,#pd-N,#pd-fc').forEach(e => e.addEventListener('input', refresh));
    refresh();
    const ok = await new Promise(res => { overlay._resolve = res; overlay._reject = () => res(false); });
    if (!ok) return;
    const p = this._predim; if (!p) return;
    if (document.getElementById('pd-assign').checked) {
      const { profileToSection } = await import('./design/profiles.js?v=2');
      this.snapshot();
      // Catalog profile → direct props; free shape (RC/timber) → compute A,I,J.
      let secProps = p.profile ? profileToSection(p.profile) : { design: { shape: p.shape, dims: p.dims } };
      if (!p.profile) {
        const { fromShape } = await import('./design/section_props.js?v=2');
        const g = fromShape(p.shape, p.dims);
        if (g) secProps = { A: g.A, Iz: g.Iz, Iy: g.Iy, J: g.J, Avy: g.Avz_web, Avz: g.Avy_flange, design: { shape: p.shape, dims: p.dims } };
      }
      const name = p.profile || `Predim ${p.shape} ${Object.values(p.dims).map(v => (v * 1000).toFixed(0)).join('×')}`;
      const newSec = this.model.addSection({ name, ...secProps });
      const selEls = this._selElems();
      for (const id of selEls) this.model.updateElement(id, { secId: newSec.id });
      this.markDirty(); this.viewport.renderModel?.(this.model); this.panel.renderSections?.();
      this.toast(`${i18n.t('Sección')} «${name}» ${i18n.t('creada')}${selEls.length ? ` ${i18n.t('y asignada a')} ${selEls.length} ${i18n.t('elemento(s)')}` : ''}. ${i18n.t('Preliminar — verifique tras analizar.')}`, 'ok');
    } else {
      this.toast(`${i18n.t('Predimensionado:')} ${p.profile || Object.entries(p.dims).map(([k, v]) => `${k}=${(v * 1000).toFixed(0)}mm`).join(' ')} (${i18n.t('preliminar')})`, 'ok');
    }
  }

  // Runs an nl_lite solver (dense corotational Newton) in a Web Worker so the UI
  // doesn't freeze on large models (#44). kind: 'nl' = load control (solveNonlinear),
  // 'dc' = displacement control (solveNonlinearDC).
  // `opts` and the result travel by structured clone (preserves typed arrays).
  // If the environment doesn't support module workers (e.g. file://), it falls back to
  // the main thread.
  _solveNLInWorker(kind, opts) {
    return new Promise((resolve, reject) => {
      let worker;
      try {
        worker = new Worker(new URL('./solver/nl_worker.js?v=2', import.meta.url), { type: 'module' });
      } catch (e) {
        try { (kind === 'dc' ? solverRegistry.solveNonlinearDC(opts) : solverRegistry.solveNonlinear(opts)).then(resolve, reject); return; }
        catch (err) { reject(err); }
        return;
      }
      worker.onmessage = (ev) => { worker.terminate(); ev.data.error ? reject(new Error(ev.data.error)) : resolve(ev.data.res); };
      worker.onerror = (ev) => { worker.terminate(); reject(new Error(ev.message || 'Error en el worker no lineal')); };
      worker.postMessage({ kind, opts });
    });
  }

  // ── Geometric NONLINEAR analysis (NL-lite, Phase 1) ───────────────────────
  // Treats ALL elements as two-force members (truss); those marked «cable» resist
  // tension only. Prestress via natural length L0. Combines all static cases at
  // factor 1 (nodal loads + self-weight + distributed loads lumped to the end nodes).
  // Incremental Newton.
  async runNonlinear(opts = {}) {
    if (!this._config?.analisis?.nlLite) {
      this.toast('Active «Análisis no lineal (NL-lite)» en ⚙ Configuración primero', 'warn');
      this.configDialog?.();
      return;
    }
    if (this.model.nodes.size === 0 || this.model.elements.size === 0) {
      this.toast('Modelo vacío: agregue nodos y elementos', 'warn'); return;
    }

    // Node index (0-based) and reference coordinates
    const nodeIds = [...this.model.nodes.keys()];
    const idxOf = new Map(nodeIds.map((id, i) => [id, i]));
    const nNode = nodeIds.length;
    const X = new Float64Array(3 * nNode);
    nodeIds.forEach((id, i) => { const n = this.model.nodes.get(id); X[3*i] = n.x; X[3*i+1] = n.y; X[3*i+2] = n.z; });

    // Member/cable elements
    const elems = [], elemIds = [];
    for (const el of this.model.elements.values()) {
      const n1 = this.model.nodes.get(el.n1), n2 = this.model.nodes.get(el.n2);
      const mat = this.model.materials.get(el.matId), sec = this.model.sections.get(el.secId);
      if (!n1 || !n2 || !mat || !sec) continue;
      const L = Math.hypot(n2.x-n1.x, n2.y-n1.y, n2.z-n1.z);
      if (L < 1e-12) continue;
      const L0 = (el.L0factor || 1) * L;
      elems.push({ n1: idxOf.get(el.n1), n2: idxOf.get(el.n2), EA: mat.E * sec.A, L0, cable: !!el.cable, compressionOnly: !!el.compressionOnly });
      elemIds.push(el.id);
    }
    if (!elems.length) { this.toast('No hay elementos válidos para el análisis no lineal', 'warn'); return; }

    // Free DOFs (translations only; in 2D, uy fixed)
    const is2D = this.model.mode === '2D';
    const free = [];
    nodeIds.forEach((id, i) => {
      const r = this.model.nodes.get(id).restraints;
      const fix = [r.ux, is2D ? 1 : r.uy, r.uz];
      for (let c = 0; c < 3; c++) if (!fix[c]) free.push(3*i + c);
    });
    if (!free.length) { this.toast('Todos los nodos están restringidos (sin GDL libres)', 'warn'); return; }

    // Reference load: combines all static cases at factor 1
    const Fref = new Float64Array(3 * nNode);
    const addNode = (id, fx, fy, fz) => { const i = idxOf.get(id); if (i==null) return; Fref[3*i]+=fx; Fref[3*i+1]+=fy; Fref[3*i+2]+=fz; };
    const dirVec = (dir) => dir==='globalX' ? [1,0,0] : dir==='globalY' ? [0,1,0] : dir==='globalZ' ? [0,0,1] : [0,0,-1]; // gravity = −Z
    let nCasos = 0;
    for (const lc of this.model.loadCases.values()) {
      if (lc.type === 'spectrum') continue;
      nCasos++;
      for (const load of (lc.loads || [])) {
        if (load.type === 'nodal') addNode(load.nodeId, load.F[0]||0, load.F[1]||0, load.F[2]||0);
        else if (load.type === 'dist') {
          const el = this.model.elements.get(load.elemId);
          if (!el) continue;
          const n1 = this.model.nodes.get(el.n1), n2 = this.model.nodes.get(el.n2);
          if (!n1 || !n2) continue;
          const L = Math.hypot(n2.x-n1.x, n2.y-n1.y, n2.z-n1.z);
          const half = (load.w || 0) * L / 2;
          const g = dirVec(load.dir || 'gravity');
          addNode(el.n1, half*g[0], half*g[1], half*g[2]);
          addNode(el.n2, half*g[0], half*g[1], half*g[2]);
        }
      }
      if (lc.selfWeight) {   // self-weight lumped to the nodes (−Z)
        for (const el of this.model.elements.values()) {
          const n1 = this.model.nodes.get(el.n1), n2 = this.model.nodes.get(el.n2);
          const mat = this.model.materials.get(el.matId), sec = this.model.sections.get(el.secId);
          if (!n1 || !n2 || !mat || !sec) continue;
          const L = Math.hypot(n2.x-n1.x, n2.y-n1.y, n2.z-n1.z);
          const w = mat.rho * sec.A * L / 2;   // half to each node
          addNode(el.n1, 0, 0, -w); addNode(el.n2, 0, 0, -w);
        }
      }
    }

    const nSteps = Math.max(1, Math.min(200, Math.round(parseFloat(this._nlSteps) || 12)));
    this._showProgress('No lineal…', 'Resolviendo el sistema no lineal (Newton, control de carga) en segundo plano');
    await new Promise(r => setTimeout(r, 20));
    let res;
    try {
      res = await this._solveNLInWorker('nl', { X, elems, free, Fref, nSteps, maxIter: 60, tol: 1e-8, slack: 1e-6 });
    } catch (e) { this.toast(`${i18n.t('Error no lineal:')} ${i18n.t(e.message)}`, 'error'); console.error(e); return; }
    finally { this._hideProgress(); }

    if (!res.steps.length || !res.steps[0]) { this.toast('El análisis no lineal no produjo pasos (¿mecanismo?)', 'error'); return; }
    this._nlResult = { res, X, nodeIds, idxOf, elemIds };
    if (!res.converged) this.toast(`${i18n.t('No convergió en el paso')} ${res.steps.length}/${nSteps} ${i18n.t('(tangente singular o carga excesiva).')} ${i18n.t('Se muestran los pasos logrados.')}`, 'warn');
    else this.toast(`${i18n.t('No lineal OK')} · ${res.steps.length} ${i18n.t('pasos')} · ${nCasos} ${i18n.t('caso(s) combinados')}`, 'ok');
    this._nlOpenOverlay();
    this._updateResultsIndicator();
  }

  // ── 2D COROTATIONAL beam — large rotation/displacement (1-029) ───────────────
  // PLANAR X–Z model. Maps members → corotational solver (js/solver/corotbeam.js),
  // solves by Newton with load increments, and reuses the «Nonlinear» tab by
  // remapping each step [u,w,θ] → nodal displacement [ux,uy=0,uz=w].
  async runCorotBeam(opts = {}) {
    if (!this._config?.analisis?.nlLite) {
      this.toast('Active «Análisis no lineal (NL-lite)» en ⚙ Configuración primero', 'warn');
      this.configDialog?.(); return;
    }
    if (this.model.mode !== '2D') {
      this.toast('La viga corotacional es 2D: requiere un modelo PLANO X–Z (Archivo → Nuevo → 2D).', 'warn'); return;
    }
    if (this.model.elements.size === 0) { this.toast('No hay elementos para el análisis', 'warn'); return; }

    const nodeIds = [...this.model.nodes.keys()];
    const idxOf = new Map(nodeIds.map((id, i) => [id, i]));
    const nNode = nodeIds.length;
    const coords = new Float64Array(2 * nNode);   // (x, z) of the plane
    nodeIds.forEach((id, i) => { const n = this.model.nodes.get(id); coords[2*i] = n.x; coords[2*i+1] = n.z; });

    const elems = [], elemIds = [];
    for (const el of this.model.elements.values()) {
      const n1 = this.model.nodes.get(el.n1), n2 = this.model.nodes.get(el.n2);
      const mat = this.model.materials.get(el.matId), sec = this.model.sections.get(el.secId);
      if (!n1 || !n2 || !mat || !sec) continue;
      if (Math.hypot(n2.x-n1.x, n2.z-n1.z) < 1e-12) continue;
      const mod = sec.mod || {};
      elems.push({ n1: idxOf.get(el.n1), n2: idxOf.get(el.n2), EA: mat.E * sec.A * (mod.A ?? 1), EI: mat.E * sec.Iz * (mod.Iz ?? 1) });
      elemIds.push(el.id);
    }
    if (!elems.length) { this.toast('No hay elementos válidos en el plano', 'warn'); return; }

    // Free DOFs: 3/node (u=ux, w=uz, θ=ry)
    const free = [];
    nodeIds.forEach((id, i) => {
      const r = this.model.nodes.get(id).restraints;
      const fix = [r.ux, r.uz, r.ry];
      for (let c = 0; c < 3; c++) if (!fix[c]) free.push(3*i + c);
    });
    if (!free.length) { this.toast('Todos los nodos están restringidos', 'warn'); return; }

    // Reference load: Fx→u, Fz→w, My→θ ; dist/self-weight lumped (transverse −Z)
    const Fref = new Float64Array(3 * nNode);
    const add = (id, fu, fw, fm) => { const i = idxOf.get(id); if (i == null) return; Fref[3*i] += fu; Fref[3*i+1] += fw; Fref[3*i+2] += fm; };
    let nCasos = 0;
    for (const lc of this.model.loadCases.values()) {
      if (lc.type === 'spectrum') continue;
      nCasos++;
      for (const load of (lc.loads || [])) {
        if (load.type === 'nodal') add(load.nodeId, load.F[0]||0, load.F[2]||0, load.F[4]||0);   // Fx, Fz, My
        else if (load.type === 'dist') {
          const el = this.model.elements.get(load.elemId); if (!el) continue;
          const n1 = this.model.nodes.get(el.n1), n2 = this.model.nodes.get(el.n2); if (!n1 || !n2) continue;
          const L = Math.hypot(n2.x-n1.x, n2.z-n1.z); const half = (load.w || 0) * L / 2;
          add(el.n1, 0, -half, 0); add(el.n2, 0, -half, 0);   // transverse −Z lumping (approx.)
        }
      }
      if (lc.selfWeight) for (const el of this.model.elements.values()) {
        const n1 = this.model.nodes.get(el.n1), n2 = this.model.nodes.get(el.n2);
        const mat = this.model.materials.get(el.matId), sec = this.model.sections.get(el.secId);
        if (!n1 || !n2 || !mat || !sec) continue;
        const w = mat.rho * sec.A * Math.hypot(n2.x-n1.x, n2.z-n1.z) / 2;
        add(el.n1, 0, -w, 0); add(el.n2, 0, -w, 0);
      }
    }

    const nSteps = Math.max(1, Math.min(200, Math.round(parseFloat(this._nlSteps) || 12)));
    this._showProgress('Corotacional…', 'Gran rotación: Newton-Raphson por incrementos de carga');
    await new Promise(r => setTimeout(r, 20));
    let res;
    try { res = await solverRegistry.solveCorotBeam({ coords, elems, free, Fref, nSteps, maxIter: 80, tol: 1e-9 }); }
    catch (e) { this.toast(`${i18n.t('Error corotacional:')} ${i18n.t(e.message)}`, 'error'); console.error(e); return; }
    finally { this._hideProgress(); }

    if (!res.steps.length) { this.toast('El análisis no produjo pasos (¿mecanismo?)', 'error'); return; }
    // Remap steps to the «Nonlinear» tab format: nodal u [ux, uy=0, uz=w].
    const X = new Float64Array(3 * nNode);
    nodeIds.forEach((id, i) => { const n = this.model.nodes.get(id); X[3*i] = n.x; X[3*i+1] = n.y; X[3*i+2] = n.z; });
    const steps2 = res.steps.map(s => {
      const u3 = new Float64Array(3 * nNode);
      for (let i = 0; i < nNode; i++) { u3[3*i] = s.u[3*i]; u3[3*i+1] = 0; u3[3*i+2] = s.u[3*i+1]; }
      const N = elems.map(el => corotBeamForceTangent(coords, s.u, el).N);
      return { lambda: s.lambda, u: u3, N, taut: N.map(() => true), iters: s.iters, resid: s.resid };
    });
    this._nlResult = { res: { steps: steps2, converged: res.converged }, X, nodeIds, idxOf, elemIds, corot: true };
    if (!res.converged) this.toast(`${i18n.t('Corotacional: no convergió en el paso')} ${res.steps.length}/${nSteps}. ${i18n.t('Se muestran los pasos logrados.')}`, 'warn');
    else this.toast(`${i18n.t('Corotacional OK')} · ${res.steps.length} ${i18n.t('pasos')} · ${i18n.t('gran rotación')} · ${nCasos} ${i18n.t('caso(s)')}`, 'ok');
    this._nlOpenOverlay();
    // Planar model → frame the FRONT X–Z view to see the curve well (no zoomExtents
    // afterwards, which resets to iso). One frame so it's already rendered.
    setTimeout(() => { try { this.viewport.setView?.('front'); } catch {} }, 60);
    this._updateResultsIndicator();
  }

  // Floating panel with step-by-step control of the nonlinear deformed shape.
  // #90: Nonlinear / P-Delta → «Nonlinear» tab in Results.
  _nlOpenOverlay() {
    if (!this._nlResult) return;
    this.panel._switchVTab('results');
    this.panel._switchRTab('nl');   // → _nlRenderPanel()
  }

  // Builds the «Nonlinear» tab content in #nl-panel (same IDs as the old floating
  // window → _nlShowStep unchanged).
  _nlRenderPanel() {
    const el = document.getElementById('nl-panel');
    const hint = document.getElementById('res-nl-hint');
    if (!el) return;
    if (!this._nlResult) { if (hint) hint.style.display = ''; el.innerHTML = ''; return; }
    if (hint) hint.style.display = 'none';
    this._nlStopPlay();
    const steps = this._nlResult.res.steps;
    el.innerHTML = `
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
        <button id="nl-play" class="btn-secondary" style="font-size:14px;padding:2px 8px">▶</button>
        <input type="range" id="nl-step" min="1" max="${steps.length}" value="${steps.length}" style="flex:1">
      </div>
      <div id="nl-readout" style="color:var(--text-muted,#94a3b8);font-size:11px;line-height:1.5;margin-bottom:6px"></div>
      <div style="display:flex;align-items:center;gap:6px">
        <label style="color:var(--text-muted,#94a3b8)">Escala ×</label>
        <input type="number" id="nl-scale" value="1" min="0.05" step="0.25" style="width:64px">
      </div>`;
    const stepInp = el.querySelector('#nl-step');
    const scaleInp = el.querySelector('#nl-scale');
    const playBtn = el.querySelector('#nl-play');
    const redraw = () => this._nlShowStep(+stepInp.value - 1);
    stepInp.addEventListener('input', redraw);
    scaleInp.addEventListener('input', redraw);
    playBtn.addEventListener('click', () => {
      if (this._nlPlayTimer) { this._nlStopPlay(); playBtn.textContent = '▶'; return; }
      playBtn.textContent = '⏸';
      this._nlPlayTimer = setInterval(() => {
        let v = +stepInp.value + 1; if (v > steps.length) v = 1;
        stepInp.value = v; redraw();
      }, 350);
    });
    redraw();
  }

  _nlStopPlay() { if (this._nlPlayTimer) { clearInterval(this._nlPlayTimer); this._nlPlayTimer = null; } }

  _nlShowStep(s) {
    const { res, nodeIds, idxOf, elemIds } = this._nlResult;
    const step = res.steps[Math.max(0, Math.min(s, res.steps.length - 1))];
    if (!step) return;
    const uByNode = new Map();
    nodeIds.forEach((id) => { const i = idxOf.get(id); uByNode.set(id, [step.u[3*i], step.u[3*i+1], step.u[3*i+2]]); });
    const elemState = new Map();
    elemIds.forEach((eid, k) => elemState.set(eid, { N: step.N[k], taut: step.taut[k], cable: this.model.elements.get(eid)?.cable, compressionOnly: this.model.elements.get(eid)?.compressionOnly }));
    const factor = parseFloat(document.getElementById('nl-scale')?.value) || 1;
    let maxD = 0; for (const u of uByNode.values()) maxD = Math.max(maxD, Math.hypot(u[0], u[1], u[2]));
    const corot = !!this._nlResult.corot;
    this.viewport.showNLDeformed(uByNode, elemState, factor,
      `${corot ? 'Gran rotación (corotacional)' : 'No lineal'} · paso ${Math.round(step.lambda * res.steps.length)}/${res.steps.length} · λ=${step.lambda.toFixed(2)} · δmax=${maxD.toExponential(2)} m · ${step.iters} iter`,
      null, { trueScale: corot });
    const ro = document.getElementById('nl-readout');
    if (ro) {
      const Nmax = Math.max(0, ...step.N.map(Math.abs));
      if (corot) {
        ro.innerHTML = `λ = <b>${step.lambda.toFixed(3)}</b> · iter ${step.iters} · resid ${step.resid.toExponential(1)}<br>δmáx = ${maxD.toExponential(3)} m · |N|máx = ${Nmax.toFixed(2)} kN · ${step.N.length} ${i18n.t('elementos')}`;
      } else {
        const taut = step.taut.filter(t => t !== false).length;
        const slack = step.taut.length - taut;
        ro.innerHTML = `λ = <b>${step.lambda.toFixed(3)}</b> · iter ${step.iters} · resid ${step.resid.toExponential(1)}<br>|N|máx = ${Nmax.toFixed(2)} kN · ${i18n.t('cables tensos')} ${taut}${slack ? ` · ${i18n.t('flojos')} ${slack}` : ''}`;
      }
    }
  }

  // ── NL-lite Phase 2: geometric stiffness (P-Delta + linear buckling) ──────
  // Sets up the geometric problem: dense K, free DOFs and the COMBINED static load
  // (all cases at factor 1) as the reference load.
  _buildGeomProblem() {
    const model = this.model;
    const nodeIndex = buildNodeIndex(model);
    const { K, nDOF } = assembleK(model, nodeIndex);
    const is2D = model.mode === '2D';
    const freeDOF = [];
    for (const node of model.nodes.values()) {
      const d = getNodeDOFs(nodeIndex, node.id), r = node.restraints;
      const rArr = [r.ux, is2D ? 1 : r.uy, r.uz, is2D ? 1 : r.rx, r.ry, is2D ? 1 : r.rz];
      d.forEach((gi, li) => { if (!rArr[li]) freeDOF.push(gi); });
    }
    const F = new Float64Array(nDOF);
    let nCasos = 0;
    for (const lc of model.loadCases.values()) {
      if (lc.type === 'spectrum') continue;
      const Fi = assembleF(model, nodeIndex, lc.id, !!lc.selfWeight);
      for (let i = 0; i < nDOF; i++) F[i] += Fi[i];
      nCasos++;
    }
    return { nodeIndex, K, nDOF, freeDOF, F, nCasos };
  }

  _maxTransDisp(u) {
    let mx = 0;
    for (const node of this.model.nodes.values()) {
      const d = getNodeDOFs(this._geomNI, node.id);
      mx = Math.max(mx, Math.hypot(u[d[0]], u[d[1]], u[d[2]]));
    }
    return mx;
  }

  // Linear BUCKLING by eigenvalues: (K + λ·Kg)·φ = 0 → λcr and buckling mode.
  // SUBSPACE ITERATION in a Web Worker (like the modal): extracts the smallest λcr in
  // a block, without blocking the UI or the dense num.eig O(n³) that used to hang. The
  // reference state (K·u = F) is solved with banded Cholesky.
  async runBuckling(opts = {}) {
    if (!this._config?.analisis?.nlLite) { this.toast('Active «Análisis no lineal (NL-lite)» en ⚙ Configuración', 'warn'); this.configDialog?.(); return; }
    if (this.model.nodes.size === 0 || (this.model.elements.size === 0 && (this.model.areas?.size || 0) === 0)) { this.toast('Modelo vacío', 'warn'); return; }

    const buckOpts = opts.silent ? { nModes: this._lastBuckModes || 6 } : await this._buckNModesDialog();
    if (!buckOpts) return;
    const { nModes } = buckOpts;
    this._lastBuckModes = nModes;

    if (this.viewport._inResultsMode) this.viewport.clearResults();
    const btn = document.getElementById('btn-run');
    if (btn) btn.classList.add('running');
    document.getElementById('sb-mode').textContent = i18n.t('Pandeo lineal…');
    this._showProgress('Pandeo lineal…', 'Resolviendo el problema de autovalores (K + λ·Kg)·φ = 0 por iteración de subespacio (en segundo plano)');
    await new Promise(r => setTimeout(r, 20));   // let the box paint before assembling

    try {
      this._applyAutoDiscIfEnabled();   // same mesh as the static analysis (#36)
      const { nodeIndex, K, nDOF, freeDOF, F, nCasos } = this._buildGeomProblem();
      this._geomNI = nodeIndex;
      if (!freeDOF.length) throw new Error('Sin GDL libres');
      if (!nCasos) throw new Error('Defina al menos un caso de carga: es la carga de referencia del pandeo.');

      const nF = freeDOF.length;
      // Kff and Ff in flat format (Float64Array nF×nF)
      const Kff_flat = new Float64Array(nF * nF);
      const Ff = new Float64Array(nF);
      for (let i = 0; i < nF; i++) { Ff[i] = F[freeDOF[i]]; const ri = freeDOF[i] * nDOF; for (let j = 0; j < nF; j++) Kff_flat[i * nF + j] = K[ri + freeDOF[j]]; }

      // Reference state: K_ff·u = F_ff (banded Cholesky; gives the axial force for Kg).
      const dense = !!this._config?.analisis?.matrizDensa;
      const fac = makeFactor(Kff_flat, nF, dense);
      if (!fac.ok) throw new Error('Estado de referencia singular/inestable (mecanismo). Revise apoyos — p.ej. torsión libre del conjunto.');
      const ufA = fac.solve(Ff);
      const u = new Float64Array(nDOF); for (let i = 0; i < nF; i++) u[freeDOF[i]] = ufA[i];

      const { Kg, Nmax, Nby } = assembleKg(this.model, nodeIndex, u);

      // Flat Kgff for the worker (+ Kg magnitude = is there a buckling effect?).
      // Works for members (Nmax) and for SHELLS (membrane stress → area Kg).
      const Kgff_flat = new Float64Array(nF * nF);
      let kgMax = 0;
      for (let i = 0; i < nF; i++) { const ri = freeDOF[i] * nDOF; for (let j = 0; j < nF; j++) { const v = Kg[ri + freeDOF[j]]; Kgff_flat[i * nF + j] = v; const av = Math.abs(v); if (av > kgMax) kgMax = av; } }
      if (kgMax < 1e-12) throw new Error('La carga de referencia no genera rigidez geométrica (sin efecto de pandeo).');

      // Subspace iteration in the Worker (doesn't block the UI)
      const buckResult = await solverRegistry.solveBuckling({ Kff_flat, Kgff_flat, nF, nModes, dense });
      if (buckResult.error) throw new Error(buckResult.error);
      const rawModes = buckResult.modes;

      // Expand each mode (vec in free DOFs) to the global vector indexed by nDOF.
      const modes = rawModes.map(m => {
        const vec = new Float64Array(nDOF);
        for (let i = 0; i < nF; i++) vec[freeDOF[i]] = m.vec[i];
        return { lambda: m.lambda, vec };
      });
      if (!modes.length) throw new Error('No se hallaron modos de pandeo (la carga de referencia no produce compresión). Revise su sentido.');

      this._buckResult = { modes, nCasos, Nby };   // Nby = reference axial force per element
      this.toast(`${i18n.t('Pandeo:')} λcr = ${modes[0].lambda.toFixed(3)} · ${i18n.t('carga crítica = λcr × carga de referencia')}`, 'ok');
      this._buckOpenOverlay();
      this._updateResultsIndicator();
    } catch (err) {
      this.toast(`Pandeo: ${err.message}`, 'error');
      console.error(err);
    } finally {
      if (btn) btn.classList.remove('running');
      this._hideProgress();
      document.getElementById('sb-mode').textContent = `${i18n.t('Modo:')} ${i18n.t('Pandeo')}`;
    }
  }

  /** HTML dialog — number of buckling modes to extract (analogous to the modal). */
  _buckNModesDialog() {
    return new Promise(resolve => {
      const overlay = document.getElementById('modal-overlay');
      document.getElementById('modal-title').textContent = i18n.t('Pandeo lineal');
      document.getElementById('modal-cancel').style.display = '';
      document.getElementById('modal-body').innerHTML = `
        <div class="prop-row">
          <div class="prop-field">
            <label>Número de modos de pandeo (1–20)</label>
            <input type="number" id="buck-nmodes" value="6" min="1" max="20" step="1" style="width:90px">
          </div>
          <div class="prop-field" style="justify-content:flex-end">
            <span style="color:var(--text-muted);font-size:11px">
              Iteración de subespacio.<br>El menor λcr gobierna.
            </span>
          </div>
        </div>
        <div class="prop-row cols1" style="margin-top:8px">
          <span style="color:var(--text-muted);font-size:11px;line-height:1.5">
            Resuelve (K + λ·Kg)·φ = 0 sobre la carga de referencia (combinación de
            todos los casos estáticos a factor 1). Carga de pandeo = λcr × esa carga.
          </span>
        </div>`;
      overlay.classList.remove('hidden');
      setTimeout(() => { const el = document.getElementById('buck-nmodes'); el?.focus(); el?.select(); }, 50);
      overlay._resolve = () => {
        const v = parseInt(document.getElementById('buck-nmodes')?.value) || 6;
        resolve({ nModes: Math.max(1, Math.min(20, v)) });
      };
      overlay._reject = () => resolve(null);
    });
  }

  // #90: Linear buckling → «Buckling» tab in Results.
  _buckOpenOverlay() {
    if (!this._buckResult) return;
    this.panel._switchVTab('results');
    this.panel._switchRTab('buck');   // → _buckRenderPanel()
  }

  // Builds the «Buckling» tab content in #buck-panel (same IDs as the old floating
  // window → _buckShowMode unchanged).
  _buckRenderPanel() {
    const el = document.getElementById('buck-panel');
    const hint = document.getElementById('res-buck-hint');
    if (!el) return;
    if (!this._buckResult) { if (hint) hint.style.display = ''; el.innerHTML = ''; return; }
    if (hint) hint.style.display = 'none';
    const modes = this._buckResult.modes;
    el.innerHTML = `
      <div style="margin-bottom:6px">Modo:
        <select id="buck-mode">${modes.map((m, i) => `<option value="${i}">#${i + 1} — λcr = ${m.lambda.toFixed(3)}</option>`).join('')}</select>
      </div>
      <div id="buck-readout" style="color:var(--text-muted,#94a3b8);font-size:11px;line-height:1.5;margin-bottom:6px"></div>
      <div style="display:flex;align-items:center;gap:6px">
        <label style="color:var(--text-muted,#94a3b8)">Escala ×</label>
        <input type="number" id="buck-scale" value="1" min="0.05" step="0.25" style="width:64px">
      </div>
      <div id="buck-elemloads" style="margin-top:8px"></div>`;
    const sel = el.querySelector('#buck-mode'), scl = el.querySelector('#buck-scale');
    const redraw = () => this._buckShowMode(+sel.value);
    sel.addEventListener('change', redraw);
    scl.addEventListener('input', redraw);
    redraw();
  }

  _buckShowMode(k) {
    const m = this._buckResult.modes[k]; if (!m) return;
    const uByNode = new Map();
    for (const node of this.model.nodes.values()) {
      const d = getNodeDOFs(this._geomNI, node.id);
      uByNode.set(node.id, [m.vec[d[0]], m.vec[d[1]], m.vec[d[2]]]);
    }
    const factor = parseFloat(document.getElementById('buck-scale')?.value) || 1;
    this.viewport.showNLDeformed(uByNode, new Map(), factor,
      `Pandeo modo ${k + 1} · factor crítico λcr = ${m.lambda.toFixed(3)} (carga crítica = λcr × carga de referencia)`);
    const ro = document.getElementById('buck-readout');
    if (ro) ro.innerHTML = `λcr = <b>${m.lambda.toFixed(4)}</b><br>${i18n.t('Carga de pandeo =')} ${m.lambda.toFixed(3)} ${i18n.t('× la carga aplicada combinada.')}<br>${m.lambda < 1 ? `<b style="color:#f87171">${i18n.t('λcr &lt; 1: la estructura pandea bajo la carga actual.')}</b>` : i18n.t('λcr &gt; 1: estable ante pandeo bajo la carga actual.')}`;
    this._buckRenderElemLoads(m.lambda);
  }

  // Buckling load PER ELEMENT (#33b): at the global critical load (λcr) each member's
  // axial force is N_cr = λcr·N_ref. Lists the most compressed (those that govern the
  // buckling). N in kN, compression negative.
  _buckRenderElemLoads(lambda) {
    const box = document.getElementById('buck-elemloads');
    const Nby = this._buckResult?.Nby;
    if (!box || !Nby) return;
    const rows = [...Nby.entries()]
      .map(([id, Nref]) => ({ id, Nref, Ncr: lambda * Nref }))
      .filter(r => r.Ncr < -1e-9)                 // only compressed (they buckle)
      .sort((a, b) => a.Ncr - b.Ncr)              // most compressed first
      .slice(0, 8);
    if (!rows.length) { box.innerHTML = '<span style="color:var(--text-muted,#94a3b8);font-size:11px">Sin elementos en compresión para este modo.</span>'; return; }
    const mut = 'color:var(--text-muted,#94a3b8)';
    box.innerHTML = `
      <div style="${mut};font-size:11px;margin-bottom:3px">Carga de pandeo por elemento (N<sub>cr</sub> = λcr·N), más comprimidos:</div>
      <table style="width:100%;border-collapse:collapse;font-size:10.5px">
        <thead><tr style="${mut}"><th style="text-align:left">Elem</th><th style="text-align:right">N ref</th><th style="text-align:right">N cr [kN]</th></tr></thead>
        <tbody>${rows.map(r => `<tr><td>#${r.id}</td><td style="text-align:right">${r.Nref.toFixed(1)}</td><td style="text-align:right;color:#f87171">${r.Ncr.toFixed(1)}</td></tr>`).join('')}</tbody>
      </table>`;
  }

  // P-DELTA: solves (K + Kg(u))·u = F iterating (frames). Shows the amplified deformed
  // shape and compares linear δmax vs P-Delta. BANDED engine (Cholesky, #44), not the
  // dense numeric.solve O(n³), with a progress box like modal/buckling.
  async runPDelta(opts = {}) {
    if (!this._config?.analisis?.nlLite) { this.toast('Active «Análisis no lineal (NL-lite)» en ⚙ Configuración', 'warn'); this.configDialog?.(); return; }
    this._applyAutoDiscIfEnabled();   // same mesh as the static (#36)
    const { nodeIndex, K, nDOF, freeDOF, F, nCasos } = this._buildGeomProblem();
    this._geomNI = nodeIndex;
    if (!freeDOF.length) { this.toast('Sin GDL libres', 'warn'); return; }
    if (!nCasos) { this.toast('Defina al menos un caso de carga.', 'warn'); return; }

    const nF = freeDOF.length;
    // Kff and Ff in flat format (Float64Array): input to the banded factorizer.
    const Kff = new Float64Array(nF * nF);
    const Ff = new Float64Array(nF);
    for (let i = 0; i < nF; i++) { Ff[i] = F[freeDOF[i]]; const ri = freeDOF[i] * nDOF; for (let j = 0; j < nF; j++) Kff[i * nF + j] = K[ri + freeDOF[j]]; }
    const dense = !!this._config?.analisis?.matrizDensa;

    this._showProgress('P-Delta…', 'Resolviendo (K + Kg(u))·u = F por iteración (motor en banda)');
    await new Promise(r => setTimeout(r, 20));
    try {
      const fac0 = makeFactor(Kff, nF, dense);
      if (!fac0.ok) { this.toast('Estado lineal inestable (mecanismo).', 'error'); return; }
      const uf = fac0.solve(Ff);
      if (!uf || uf.some(v => !isFinite(v))) { this.toast('Estado lineal singular.', 'error'); return; }
      let u = new Float64Array(nDOF); for (let i = 0; i < nF; i++) u[freeDOF[i]] = uf[i];
      const dLin = this._maxTransDisp(u);

      let conv = false, it = 0;
      for (it = 0; it < 25; it++) {
        const { Kg } = assembleKg(this.model, nodeIndex, u);
        const KT = new Float64Array(nF * nF);
        for (let i = 0; i < nF; i++) { const ri = freeDOF[i] * nDOF; for (let j = 0; j < nF; j++) KT[i * nF + j] = Kff[i * nF + j] + Kg[ri + freeDOF[j]]; }
        const fac = makeFactor(KT, nF, dense);
        if (!fac.ok) { this.toast('Tangente singular: la carga iguala o supera la de pandeo (λcr ≤ 1). Reduzca la carga o ejecute Pandeo.', 'error'); return; }
        const uf2 = fac.solve(Ff);
        if (!uf2 || uf2.some(v => !isFinite(v))) { this.toast('Divergió: la carga alcanza la de pandeo.', 'error'); return; }
        const uNew = new Float64Array(nDOF); for (let i = 0; i < nF; i++) uNew[freeDOF[i]] = uf2[i];
        let dn = 0, de = 0; for (let i = 0; i < nDOF; i++) { dn += (uNew[i] - u[i]) ** 2; de += uNew[i] ** 2; }
        u = uNew;
        if (de > 0 && Math.sqrt(dn / de) < 1e-6) { conv = true; it++; break; }
      }
      const dPD = this._maxTransDisp(u);
      this._pdResult = { u };
      const amp = dLin > 1e-12 ? dPD / dLin : 1;
      this.toast(`P-Delta: δmax ${dLin.toExponential(2)} → ${dPD.toExponential(2)} m (${i18n.t('amplificación')} ×${amp.toFixed(2)}) · ${conv ? it + ' iter' : i18n.t('no convergió')}`, conv ? 'ok' : 'warn');

      const uByNode = new Map();
      for (const node of this.model.nodes.values()) {
        const d = getNodeDOFs(nodeIndex, node.id);
        uByNode.set(node.id, [u[d[0]], u[d[1]], u[d[2]]]);
      }
      this.viewport.showNLDeformed(uByNode, new Map(), 1,
        `P-Delta · δmax=${dPD.toExponential(2)} m · amplificación ×${amp.toFixed(2)} vs lineal · ${conv ? it + ' iter' : 'sin converger'}`);
      this._updateResultsIndicator();
    } finally { this._hideProgress(); }
  }

  // ── NL-lite Phase 3: FORM-FINDING by force densities (FDM) ────────────────
  // Finds the equilibrium shape of the cable/member network and REPOSITIONS the free
  // nodes to that geometry (becomes the base model; Ctrl+Z undoes).
  // Anchors = nodes with any translation restraint. q = force density.
  async runFormFinding(opts = {}) {
    if (!this._config?.analisis?.nlLite) { this.toast('Active «Análisis no lineal (NL-lite)» en ⚙ Configuración', 'warn'); this.configDialog?.(); return; }
    const model = this.model;
    if (model.nodes.size === 0 || model.elements.size === 0) { this.toast('Modelo vacío', 'warn'); return; }

    // ── Restrict the network to the TARGET elements (fix #29) ───────────────────
    // If there are selected elements, only THOSE form the network; the rest stay
    // intact. A node is an ANCHOR if it is restrained OR if it touches a NON-
    // participating element (boundary with the structure that is NOT formed) → so the
    // columns and their nodes aren't destroyed when forming, e.g., only the beam.
    // Without a selection, the whole model is formed (good for cable nets, not frames).
    const selEls = this._selElems();
    const hasSel = selEls.length > 0;
    const partSet = new Set(hasSel ? selEls : [...model.elements.keys()]);
    const boundary = new Set();
    if (hasSel) for (const el of model.elements.values()) {
      if (!partSet.has(el.id)) { boundary.add(el.n1); boundary.add(el.n2); }
    }

    const nodeIds = [...model.nodes.keys()];
    const idxOf = new Map(nodeIds.map((id, i) => [id, i]));
    const n = nodeIds.length;
    const coords = new Float64Array(3 * n);
    const fixed = [];
    nodeIds.forEach((id, i) => {
      const nd = model.nodes.get(id);
      coords[3 * i] = nd.x; coords[3 * i + 1] = nd.y; coords[3 * i + 2] = nd.z;
      const r = nd.restraints;
      // anchor = translation restraint OR boundary with non-participating structure
      fixed.push(!!(r.ux || r.uy || r.uz) || boundary.has(id));
    });
    if (fixed.filter(Boolean).length < 2) { this.toast('El form-finding necesita ≥ 2 nodos ancla (apoyos, o bordes de la selección). Restrinja algunos nodos o seleccione los elementos a formar.', 'warn'); return; }

    const branches = [];
    for (const id of partSet) {
      const el = model.elements.get(id); if (!el) continue;
      const i = idxOf.get(el.n1), j = idxOf.get(el.n2);
      if (i != null && j != null) branches.push([i, j]);
    }
    if (!branches.length) { this.toast('Sin elementos para formar la red.', 'warn'); return; }

    const ffOpts = opts.silent ? { q0: 10, axes: [2] } : await this._formFindDialog(hasSel);
    if (!ffOpts) return;
    const { q0, axes } = ffOpts;
    const q = branches.map(() => q0);

    // Combined external loads (all static cases) on the free nodes.
    const loads = nodeIds.map(() => [0, 0, 0]);
    let hasLoad = false;
    const dirVec = d => d === 'globalX' ? [1, 0, 0] : d === 'globalY' ? [0, 1, 0] : d === 'globalZ' ? [0, 0, 1] : [0, 0, -1];
    for (const lc of model.loadCases.values()) {
      if (lc.type === 'spectrum') continue;
      for (const ld of (lc.loads || [])) {
        if (ld.type === 'nodal') {
          const i = idxOf.get(ld.nodeId);
          if (i != null) { loads[i][0] += ld.F[0] || 0; loads[i][1] += ld.F[1] || 0; loads[i][2] += ld.F[2] || 0; hasLoad = true; }
        } else if (ld.type === 'dist') {
          const el = model.elements.get(ld.elemId); if (!el) continue;
          const n1 = model.nodes.get(el.n1), n2 = model.nodes.get(el.n2); if (!n1 || !n2) continue;
          const L = Math.hypot(n2.x - n1.x, n2.y - n1.y, n2.z - n1.z);
          const half = (ld.w || 0) * L / 2, g = dirVec(ld.dir || 'gravity');
          const a = idxOf.get(el.n1), b = idxOf.get(el.n2);
          if (a != null) for (let c = 0; c < 3; c++) loads[a][c] += half * g[c];
          if (b != null) for (let c = 0; c < 3; c++) loads[b][c] += half * g[c];
          hasLoad = true;
        }
      }
      if (lc.selfWeight) {
        for (const el of model.elements.values()) {
          const mat = model.materials.get(el.matId), sec = model.sections.get(el.secId);
          const n1 = model.nodes.get(el.n1), n2 = model.nodes.get(el.n2);
          if (!mat || !sec || !n1 || !n2) continue;
          const L = Math.hypot(n2.x - n1.x, n2.y - n1.y, n2.z - n1.z);
          const wgt = mat.rho * sec.A * L / 2;
          const a = idxOf.get(el.n1), b = idxOf.get(el.n2);
          if (a != null) loads[a][2] -= wgt; if (b != null) loads[b][2] -= wgt;
          hasLoad = true;
        }
      }
    }

    const res = await solverRegistry.solveFormFind({ coords, fixed, branches, q, loads: hasLoad ? loads : null, axes });
    if (!res.ok) { this.toast(i18n.t('Form-finding:') + ' ' + res.note, 'error'); return; }

    // Reposition the free nodes to the equilibrium geometry (undo with Ctrl+Z).
    this.snapshot();
    let moved = 0, dmax = 0;
    for (const i of res.freeIdx) {
      const nd = model.nodes.get(nodeIds[i]);
      const nx = res.coords[3 * i], ny = res.coords[3 * i + 1], nz = res.coords[3 * i + 2];
      dmax = Math.max(dmax, Math.hypot(nx - nd.x, ny - nd.y, nz - nd.z));
      nd.x = nx; nd.y = ny; nd.z = nz; moved++;
    }
    this.viewport.renderModel(model);
    this.viewport.zoomExtents?.();
    this.markDirty();
    const ambito = hasSel ? `${branches.length} ${i18n.t('elem. seleccionados')}` : i18n.t('todo el modelo');
    const ejes = axes.length === 1 ? i18n.t('sólo vertical (Z)') : i18n.t('3D (x,y,z)');
    this.toast(`Form-finding OK · ${moved} ${i18n.t('nodos reposicionados')} (Δmáx ${dmax.toFixed(3)} m) · ${ambito} · ${ejes} · ${hasLoad ? i18n.t('forma funicular bajo carga') : i18n.t('red de longitud mínima')}. ${i18n.t('Ctrl+Z deshace.')}`, 'ok');
  }

  /** HTML dialog — form-finding options (density q + axes to adjust). */
  _formFindDialog(hasSel) {
    return new Promise(resolve => {
      const overlay = document.getElementById('modal-overlay');
      document.getElementById('modal-title').textContent = i18n.t('Form-finding (densidades de fuerza)');
      document.getElementById('modal-cancel').style.display = '';
      const ambito = hasSel
        ? i18n.t('Se formará <b>sólo la selección</b>; el resto de la estructura (p.ej. pilares) queda fijo como anclaje.')
        : i18n.t('<b>Sin selección</b>: se formará <b>todo el modelo</b>. Apto para redes de cable; en marcos conviene seleccionar antes sólo los elementos a formar.');
      document.getElementById('modal-body').innerHTML = `
        <div class="prop-row cols1">
          <div class="prop-field">
            <label>Densidad de fuerza q = N/L [kN/m] (mayor q → forma más tensa/recta)</label>
            <input type="text" id="ff-q" value="10" style="width:100%;margin-top:4px">
          </div>
        </div>
        <div class="prop-row cols1" style="margin-top:8px">
          <div class="prop-field">
            <label>Coordenadas a ajustar</label>
            <select id="ff-axes" style="width:100%">
              <option value="z" selected>Sólo vertical (Z) — mantiene las luces en planta (recomendado)</option>
              <option value="xyz">3D (x, y, z) — redistribuye también en planta (redes/mallas)</option>
            </select>
          </div>
        </div>
        <div class="prop-row cols1" style="margin-top:8px">
          <span style="color:var(--text-muted);font-size:11px;line-height:1.5">${ambito}</span>
        </div>`;
      overlay.classList.remove('hidden');
      setTimeout(() => { const el = document.getElementById('ff-q'); el?.focus(); el?.select(); }, 50);
      overlay._resolve = () => {
        const q0 = parseFloat(document.getElementById('ff-q')?.value);
        if (!(q0 > 0)) { this.toast('q debe ser un número > 0', 'warn'); resolve(null); return; }
        const axes = document.getElementById('ff-axes')?.value === 'xyz' ? [0, 1, 2] : [2];
        resolve({ q0, axes });
      };
      overlay._reject = () => resolve(null);
    });
  }

  // ── NL-lite Phase 4: bilinear material + PLASTIC HINGES ────────────────────
  // Assembles K (dense) with the current releases (formed hinges) and stores per
  // element {ed, T, KeCond} to recover the end moments.
  _plasticAssemble(nodeIndex, releasesByElem) {
    const model = this.model;
    const nDOF = nodeIndex.size * 6;
    const K = new Float64Array(nDOF * nDOF);
    const elems = [];
    for (const el of model.elements.values()) {
      const n1 = model.nodes.get(el.n1), n2 = model.nodes.get(el.n2);
      const mat = model.materials.get(el.matId), sec = model.sections.get(el.secId);
      if (!n1 || !n2 || !mat || !sec) continue;
      const { ex, ey, ez, L } = localAxes(n1, n2);
      let Ke = stiffnessMatrix(L, mat, sec);
      const rel = releasesByElem.get(el.id);
      const relBool = rel ? rel.map(r => !!r) : null;
      if (relBool && relBool.some(Boolean)) Ke = applyReleases(Ke, relBool);
      const T = transformMatrix(ex, ey, ez);
      const KG = globalStiffness(Ke, T);
      const ed = [...getNodeDOFs(nodeIndex, el.n1), ...getNodeDOFs(nodeIndex, el.n2)];
      for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) K[ed[i] * nDOF + ed[j]] += KG[i][j];
      elems.push({ id: el.id, ed, T, KeCond: Ke, L });
    }
    // Rigid-diaphragm constraints (penalty), like assembleK: without this the master
    // nodes (without elements) have zero stiffness → singular K → false «mechanism
    // from the start» in models with diaphragms.
    applyDiaphragmConstraints(K, model, nodeIndex, nDOF);
    return { K, nDOF, elems };
  }

  // EVENT-BY-EVENT incremental analysis with plastic hinges (plastic pushover).
  // Elastic-perfectly-plastic material: each end forms a hinge upon reaching the
  // plastic moment Mp; that rotational DOF is released and its moment is fixed at Mp.
  // Collapse occurs when a MECHANISM forms (singular K).
  async runPlastic(opts = {}) {
    if (!this._config?.analisis?.nlLite) { this.toast('Active «Análisis no lineal (NL-lite)» en ⚙ Configuración', 'warn'); this.configDialog?.(); return; }
    const model = this.model;
    if (model.nodes.size === 0 || model.elements.size === 0) { this.toast('Modelo vacío', 'warn'); return; }

    // Mp capacity per element (#27b): uniform by default; with selected elements a
    // different Mp can be given to the selection and, optionally, let ONLY the
    // selection hinge (the rest stays elastic).
    const selEls = this._selElems();
    // Auto-disc ×N only if there is NO selection: with a selection the mesh IDs don't
    // match the selected ones and the per-element Mp would be lost (#36).
    if (!selEls.length) this._applyAutoDiscIfEnabled();
    const popts = opts.silent
      ? { mpDefault: opts.mp || this._lastMp || 100, mpSel: opts.mp || this._lastMp || 100, soloSel: false, pattern: this._lastPattern || 'all', mode: opts.mode || 'perfecto', residual: opts.residual ?? 1, thetaU: opts.thetaU, deltaU: opts.deltaU, Np: opts.Np, Vp: opts.Vp }
      : await this._plasticDialog(selEls.length > 0);
    if (!popts) return;
    const { mpDefault, mpSel, soloSel } = popts;
    // Behavior: 'perfecto' (∞ plateau), 'ductil_caida' (plateau up to θu/δu then drops),
    // 'fragil' (immediate drop). residual = fraction retained after the drop.
    const hingeMode = popts.mode || 'perfecto';
    const residual = (hingeMode === 'perfecto') ? 1 : (popts.residual ?? 1e-4);
    const thetaU = hingeMode === 'fragil' ? 0 : (hingeMode === 'ductil_caida' ? (popts.thetaU ?? 0.02) : Infinity);   // ultimate rotation (rad) of the MOMENT hinges
    const deltaU = hingeMode === 'fragil' ? 0 : (hingeMode === 'ductil_caida' ? (popts.deltaU ?? 0.02) : Infinity);   // ultimate displacement (m) of N/V
    // Per-element capacities: Mp (moment My/Mz), Np (axial) and Vp (shear Vy/Vz).
    // Np/Vp default to ∞ (don't yield) unless the user provides them → so the default
    // behavior is still MOMENT hinges.
    const Np = popts.Np > 0 ? popts.Np : Infinity, Vp = popts.Vp > 0 ? popts.Vp : Infinity;
    this._lastMp = mpDefault;
    const Mp = mpDefault;
    const selSet = new Set(selEls);
    const capByElem = new Map();
    for (const el of model.elements.values()) {
      let mp = mpDefault;
      if (selEls.length && selSet.has(el.id)) mp = mpSel;
      else if (selEls.length && soloSel) mp = Infinity;   // doesn't hinge → stays elastic
      capByElem.set(el.id, { N: Np, Vy: Vp, Vz: Vp, My: mp, Mz: mp });
    }
    const capOf = (eid, axis) => (capByElem.get(eid) || {})[axis] ?? Infinity;
    // yield components per element (local DOF, axis, rotational?)
    const COMPS = [
      { end: 1, dl: 0, axis: 'N', rot: false }, { end: 1, dl: 1, axis: 'Vy', rot: false }, { end: 1, dl: 2, axis: 'Vz', rot: false },
      { end: 1, dl: 4, axis: 'My', rot: true }, { end: 1, dl: 5, axis: 'Mz', rot: true },
      { end: 2, dl: 7, axis: 'Vy', rot: false }, { end: 2, dl: 8, axis: 'Vz', rot: false },
      { end: 2, dl: 10, axis: 'My', rot: true }, { end: 2, dl: 11, axis: 'Mz', rot: true },
    ];
    const dropMode = (thetaU !== Infinity || deltaU !== Infinity);   // there is a drop (brittle or ductile-with-drop)

    // Plastic deformation of the hinge RELATIVE TO THE CHORD of the element (not the
    // raw deformation of the released DOF, which includes the rigid-body
    // rotation/translation of the span). ul = LOCAL element displacements (12), L = length.
    //   · Moment (Mz): nodal rotation − chord rotation in the x-y plane = θz − (uy2−uy1)/L
    //   · Moment (My): θy + (uz2−uz1)/L  (sign of the local frame [ux,uy,uz,rx,ry,rz])
    //   · Axial (N):    relative elongation ux2−ux1
    //   · Shear (V):    relative transverse slip uy2−uy1 / uz2−uz1
    const plasticRate = (ul, c, L) => {
      switch (c.axis) {
        case 'N':  return ul[6] - ul[0];
        case 'Vy': return ul[7] - ul[1];
        case 'Vz': return ul[8] - ul[2];
        case 'Mz': return ul[c.dl] - (ul[7] - ul[1]) / L;
        case 'My': return ul[c.dl] + (ul[8] - ul[2]) / L;
        default:   return ul[c.dl];
      }
    };

    const nodeIndex = buildNodeIndex(model);
    const nDOF = nodeIndex.size * 6;
    const is2D = model.mode === '2D';
    const freeDOF = [];
    for (const node of model.nodes.values()) {
      const d = getNodeDOFs(nodeIndex, node.id), r = node.restraints;
      const rArr = [r.ux, is2D ? 1 : r.uy, r.uz, is2D ? 1 : r.rx, r.ry, is2D ? 1 : r.rz];
      d.forEach((gi, li) => { if (!rArr[li]) freeDOF.push(gi); });
    }
    if (!freeDOF.length) { this.toast('Sin GDL libres', 'warn'); return; }
    const nF = freeDOF.length;

    // Reference load per the chosen pattern (#45): all / one case / one combo.
    const F = new Float64Array(nDOF);
    const { contribs, label: patLabel } = this._resolvePattern(popts.pattern);
    let nCasos = 0;
    for (const c of contribs) {
      const Fi = assembleF(model, nodeIndex, c.lcId, c.selfWeight);
      for (let i = 0; i < nDOF; i++) F[i] += c.factor * Fi[i];
      nCasos++;
    }
    if (!nCasos) { this.toast('Defina al menos un caso de carga (patrón de carga del pushover).', 'warn'); return; }
    // Null load pattern → no moment grows with λ → "no hinges form" would be
    // misleading (the loads are the problem, not Mp). Clear diagnosis (#46).
    let Fnorm = 0; for (let i = 0; i < nDOF; i++) Fnorm += F[i] * F[i]; Fnorm = Math.sqrt(Fnorm);
    if (Fnorm < 1e-12) { this.toast('El patrón de carga es nulo (los casos no tienen cargas, o el peso propio no está activo). Asigne cargas antes de correr rótulas.', 'warn'); return; }

    const releasesByElem = new Map();
    for (const el of model.elements.values()) releasesByElem.set(el.id, (el.releases || Array(12).fill(0)).slice());
    const Macc = new Map(), hinged = new Set();
    const thetaP = new Map(), dropped = new Set();   // plastic deformation of each hinge + already-dropped hinges
    let lambda = 0; const u = new Float64Array(nDOF);
    const events = []; let collapsed = false;
    const maxEvents = 12 * model.elements.size + 24;

    // Applies the DROP of a set of hinges: sheds the retained moment/force
    // −(1−ε)·X_form, redistributes and forms IN CASCADE those that exceed capacity
    // (brittle → drop immediately). Returns true if a mechanism forms.
    const applyDrops = (queue0) => {
      let queue = queue0, guard2 = 0;
      while (queue.length && guard2++ < 600) {
        const { K: Kd, elems: elemsD } = this._plasticAssemble(nodeIndex, releasesByElem);
        const eb = new Map(elemsD.map(e => [e.id, e]));
        const Kffd = new Float64Array(nF * nF);
        for (let i = 0; i < nF; i++) { const ri = freeDOF[i] * nDOF; for (let j = 0; j < nF; j++) Kffd[i * nF + j] = Kd[ri + freeDOF[j]]; }
        const facd = makeFactor(Kffd, nF, false);
        if (!facd.ok) return true;   // mechanism after the drop
        const G = new Float64Array(nDOF);
        for (const c of queue) {
          const e = eb.get(c.elemId); if (!e) continue;
          const shed = -(1 - residual) * c.M_form;
          for (let i = 0; i < 12; i++) G[e.ed[i]] += e.T[c.dofLocal][i] * shed;   // T^T: local→global
          Macc.set(c.key, residual * c.M_form); dropped.add(c.key);
        }
        const Gf = new Float64Array(nF); for (let i = 0; i < nF; i++) Gf[i] = G[freeDOF[i]];
        const duf = facd.solve(Gf);
        const duJ = new Float64Array(nDOF); for (let i = 0; i < nF; i++) duJ[freeDOF[i]] = duf[i];
        for (let i = 0; i < nDOF; i++) u[i] += duJ[i];
        const over = [];
        for (const e of elemsD) {
          const ue = e.ed.map(d => duJ[d]);
          const ul = new Array(12).fill(0); for (let i = 0; i < 12; i++) { let s = 0; for (let j = 0; j < 12; j++) s += e.T[i][j] * ue[j]; ul[i] = s; }
          const fl = new Array(12).fill(0); for (let i = 0; i < 12; i++) { let s = 0; for (let j = 0; j < 12; j++) s += e.KeCond[i][j] * ul[j]; fl[i] = s; }
          for (const c of COMPS) {
            const key = `${e.id}:${c.end}:${c.axis}`;
            if (hinged.has(key)) { if (!dropped.has(key)) thetaP.set(key, (thetaP.get(key) || 0) + plasticRate(ul, c, e.L)); continue; }
            const cap = capOf(e.id, c.axis); if (!isFinite(cap)) continue;
            const M1 = (Macc.get(key) || 0) + fl[c.dl]; Macc.set(key, M1);
            if (Math.abs(M1) > cap * (1 + 1e-6)) over.push({ key, elemId: e.id, dofLocal: c.dl, end: c.end, axis: c.axis, rot: c.rot, M_form: Math.sign(M1) * cap });
          }
        }
        let dctrl2 = 0; for (const node of model.nodes.values()) { const d = getNodeDOFs(nodeIndex, node.id); dctrl2 = Math.max(dctrl2, Math.hypot(u[d[0]], u[d[1]], u[d[2]])); }
        const next = [];
        for (const o of over) {
          releasesByElem.get(o.elemId)[o.dofLocal] = 1; hinged.add(o.key); thetaP.set(o.key, 0);
          const nd = model.elements.get(o.elemId);
          events.push({ lambda, elemId: o.elemId, nodeId: o.end === 1 ? nd.n1 : nd.n2, axis: o.axis, dctrl: dctrl2, cascade: true });
          Macc.set(o.key, o.M_form);
          if ((o.rot ? thetaU : deltaU) === 0) next.push({ key: o.key, elemId: o.elemId, dofLocal: o.dofLocal, end: o.end, axis: o.axis, M_form: o.M_form });   // brittle → drops instantly
        }
        queue = next;
      }
      return false;
    };

    this._showProgress('Rótulas plásticas…', 'Análisis incremental evento a evento (motor en banda)');
    await new Promise(r => setTimeout(r, 20));
    for (let k = 0; k < maxEvents; k++) {
      const { K, elems } = this._plasticAssemble(nodeIndex, releasesByElem);
      const Kff = new Float64Array(nF * nF);
      for (let i = 0; i < nF; i++) { const ri = freeDOF[i] * nDOF; for (let j = 0; j < nF; j++) Kff[i * nF + j] = K[ri + freeDOF[j]]; }
      const fac = makeFactor(Kff, nF, false);
      if (!fac.ok) { collapsed = true; break; }   // mechanism → collapse

      const Ff = new Float64Array(nF); for (let i = 0; i < nF; i++) Ff[i] = F[freeDOF[i]];
      const uf = fac.solve(Ff);
      const uUnit = new Float64Array(nDOF); for (let i = 0; i < nF; i++) uUnit[freeDOF[i]] = uf[i];

      // Forces/rates per COMPONENT (N, Vy, Vz, My, Mz) at non-hinged ends + plastic
      // deformation of the already-formed (not dropped) hinges.
      const rates = [], hingeDef = [];
      for (const e of elems) {
        const ue = e.ed.map(d => uUnit[d]);
        const ul = new Array(12).fill(0);
        for (let i = 0; i < 12; i++) { let s = 0; for (let j = 0; j < 12; j++) s += e.T[i][j] * ue[j]; ul[i] = s; }
        const fl = new Array(12).fill(0);
        for (let i = 0; i < 12; i++) { let s = 0; for (let j = 0; j < 12; j++) s += e.KeCond[i][j] * ul[j]; fl[i] = s; }
        for (const c of COMPS) {
          const key = `${e.id}:${c.end}:${c.axis}`;
          if (hinged.has(key)) { if (!dropped.has(key)) hingeDef.push({ key, dl: c.dl, rot: c.rot, vrate: plasticRate(ul, c, e.L) }); continue; }
          const cap = capOf(e.id, c.axis); if (!isFinite(cap)) continue;   // no capacity → doesn't yield
          rates.push({ key, elemId: e.id, end: c.end, axis: c.axis, dofLocal: c.dl, rot: c.rot, mr: fl[c.dl], cap });
        }
      }

      // Δλ to the next YIELD (the force reaches ±cap of the component)
      let dlam = Infinity;
      const cand = [];
      for (const r of rates) {
        if (Math.abs(r.mr) < 1e-12) continue;
        const M0 = Macc.get(r.key) || 0;
        let best = Infinity;
        for (const tgt of [r.cap, -r.cap]) { const dl = (tgt - M0) / r.mr; if (dl > 1e-9 && dl < best) best = dl; }
        if (isFinite(best)) { cand.push({ r, dl: best }); if (best < dlam) dlam = best; }
      }
      // Δλ to the next DROP (plastic deformation reaches θu/δu) — ductile-with-drop
      if (dropMode) for (const h of hingeDef) {
        const defCap = h.rot ? thetaU : deltaU; if (!isFinite(defCap) || defCap === 0) continue;
        if (Math.abs(h.vrate) < 1e-15) continue;
        const dl = (defCap - Math.abs(thetaP.get(h.key) || 0)) / Math.abs(h.vrate);
        if (dl < dlam) dlam = Math.max(0, dl);
      }
      if (!isFinite(dlam)) break;   // no more yielding or drops → done

      lambda += dlam;
      for (const r of rates) Macc.set(r.key, (Macc.get(r.key) || 0) + dlam * r.mr);
      for (const h of hingeDef) thetaP.set(h.key, (thetaP.get(h.key) || 0) + dlam * h.vrate);
      for (let i = 0; i < nDOF; i++) u[i] += dlam * uUnit[i];
      let dctrl = 0;
      for (const node of model.nodes.values()) { const d = getNodeDOFs(nodeIndex, node.id); dctrl = Math.max(dctrl, Math.hypot(u[d[0]], u[d[1]], u[d[2]])); }
      const tol = Math.max(1e-9, dlam * 1e-6);

      // FORM the components that yield at this λ (N/V/M hinge)
      const fragilNow = [];
      for (const c of cand) {
        if (c.dl > dlam + tol) continue;
        releasesByElem.get(c.r.elemId)[c.r.dofLocal] = 1; hinged.add(c.r.key); thetaP.set(c.r.key, 0);
        const nd = model.elements.get(c.r.elemId);
        events.push({ lambda, elemId: c.r.elemId, nodeId: c.r.end === 1 ? nd.n1 : nd.n2, axis: c.r.axis, dctrl });
        if ((c.r.rot ? thetaU : deltaU) === 0) fragilNow.push({ key: c.r.key, elemId: c.r.elemId, dofLocal: c.r.dofLocal, end: c.r.end, axis: c.r.axis, M_form: Macc.get(c.r.key) || 0 });
      }
      // DROPS from reaching ultimate deformation (ductile-with-drop)
      const reached = [];
      if (dropMode) for (const h of hingeDef) {
        const defCap = h.rot ? thetaU : deltaU; if (!isFinite(defCap) || defCap === 0) continue;
        if (Math.abs(thetaP.get(h.key) || 0) >= defCap - 1e-9) { const p = h.key.split(':'); reached.push({ key: h.key, elemId: +p[0], dofLocal: h.dl, end: +p[1], axis: p[2], M_form: Macc.get(h.key) || 0 }); }
      }
      // Process the drops (brittle-immediate + θu/δu-reached) with cascade
      const dq = fragilNow.concat(reached);
      if (dq.length && applyDrops(dq)) { collapsed = true; break; }
    }
    this._hideProgress();

    if (!events.length) {
      this.toast(collapsed
        ? 'La estructura es inestable desde el inicio (mecanismo): revise apoyos y conexiones; no es un problema de Mp.'
        : 'Ningún extremo alcanza Mp: suba el patrón de carga o baje Mp (con el Mp dado la carga de referencia no produce ese momento).', 'warn');
      return;
    }
    this._plasticResult = { events, lambda, collapsed, u: Float64Array.from(u), nodeIndex, Mp, capByElem, nCasos, patLabel, hingeMode, residual, thetaU, deltaU, Np, Vp };

    // Show the collapse mechanism (deformed shape) + hinge sequence, with a
    // step-by-step animation panel (#47).
    this.toast((collapsed ? `Colapso plástico: λc = ${lambda.toFixed(3)} × carga de referencia · ${events.length} rótulas` : `Plástico: ${events.length} rótulas, sin mecanismo (λ=${lambda.toFixed(3)})`) + ` · patrón: ${patLabel}`, collapsed ? 'ok' : 'warn');
    this._plasticOpenOverlay();
    // Results in the «Hinges» tab (respects the light/dark theme) — #27a.
    this.panel._switchVTab('results');
    this.panel._switchRTab('plastico');
  }

  // Color of hinge i (0-based) of n: yellow→red gradient by order (#47).
  _hingeColor(i, n) {
    const t = n > 1 ? i / (n - 1) : 1;
    const a = [0xfd, 0xe0, 0x47], b = [0xef, 0x44, 0x44];
    const c = a.map((v, k) => Math.round(v + (b[k] - v) * t));
    return (c[0] << 16) | (c[1] << 8) | c[2];
  }

  // Re-draws the plastic deformed shape showing the hinges formed up to step k
  // (1..N), colored by formation order. k = N → full mechanism.
  _plasticShowStep(k) {
    const pr = this._plasticResult; if (!pr) return;
    const ni = pr.nodeIndex || buildNodeIndex(this.model);
    const uByNode = new Map();
    for (const node of this.model.nodes.values()) {
      const d = getNodeDOFs(ni, node.id);
      uByNode.set(node.id, [pr.u[d[0]], pr.u[d[1]], pr.u[d[2]]]);
    }
    const n = pr.events.length;
    const kk = Math.max(1, Math.min(k, n));
    const hinges = pr.events.slice(0, kk).map((ev, i) => ({ nodeId: ev.nodeId, color: this._hingeColor(i, n) }));
    const last = pr.events[kk - 1];
    this.viewport.showNLDeformed(uByNode, new Map(), 1,
      `${pr.collapsed ? 'Colapso plástico' : 'Plástico'} · rótula ${kk}/${n}` +
      (last ? ` · elem #${last.elemId} ${last.axis} · λ=${last.lambda.toFixed(3)}` : ''), hinges);
    const ro = document.getElementById('pl-readout');
    if (ro && last) ro.innerHTML = `${i18n.t('Rótula')} <b>${kk}/${n}</b> · elem #${last.elemId} (${last.axis}) · λ = <b>${last.lambda.toFixed(3)}</b>`;
  }

  // Floating panel with step-by-step control of the hinge sequence (#47).
  _plasticOpenOverlay() {
    const pr = this._plasticResult; if (!pr || !pr.events.length) return;
    const N = pr.events.length;
    let el = document.getElementById('pl-overlay');
    if (!el) { el = document.createElement('div'); el.id = 'pl-overlay'; document.body.appendChild(el); }
    el.style.cssText = 'position:fixed;right:16px;bottom:84px;z-index:50;background:var(--bg4);border:1px solid var(--border);border-radius:8px;padding:10px 12px;width:268px;box-shadow:0 8px 24px rgba(0,0,0,.4);font-size:12px;color:var(--text)';
    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <b style="color:var(--accent,#38bdf8)">Secuencia de rótulas</b>
        <button id="pl-close" title="Cerrar" style="background:none;border:none;color:var(--text-muted,#94a3b8);cursor:pointer;font-size:16px;line-height:1">✕</button>
      </div>
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
        <button id="pl-play" class="btn-secondary" style="font-size:14px;padding:2px 8px">▶</button>
        <input type="range" id="pl-step" min="1" max="${N}" value="${N}" style="flex:1">
        <select id="pl-speed" title="Velocidad de animación" style="font-size:11px"><option value="0.5">×0.5</option><option value="1" selected>×1</option><option value="2">×2</option><option value="4">×4</option></select>
      </div>
      <div id="pl-readout" style="color:var(--text-muted,#94a3b8);font-size:11px;line-height:1.5;margin-bottom:4px"></div>
      <div style="color:var(--text-muted,#94a3b8);font-size:10.5px">Amarillo = primera · rojo = última. ${pr.collapsed ? `Mecanismo a la rótula ${N} (λc=${pr.lambda.toFixed(3)}).` : 'Sin mecanismo.'}</div>`;
    const stepInp = el.querySelector('#pl-step');
    const playBtn = el.querySelector('#pl-play');
    const redraw = () => this._plasticShowStep(+stepInp.value);
    stepInp.addEventListener('input', redraw);
    el.querySelector('#pl-close').addEventListener('click', () => { this._plasticStopPlay(); el.remove(); this.viewport.clearResults(); });
    playBtn.addEventListener('click', () => {
      if (this._plasticPlayTimer) { this._plasticStopPlay(); playBtn.textContent = '▶'; return; }
      playBtn.textContent = '⏸';
      const speedEl = el.querySelector('#pl-speed');
      const tick = () => {
        let v = +stepInp.value + 1; if (v > N) v = 1;
        stepInp.value = v; redraw();
        this._plasticPlayTimer = setTimeout(tick, 450 / (parseFloat(speedEl?.value) || 1));
      };
      this._plasticPlayTimer = setTimeout(tick, 450 / (parseFloat(speedEl?.value) || 1));
    });
    redraw();
  }

  _plasticStopPlay() { if (this._plasticPlayTimer) { clearTimeout(this._plasticPlayTimer); this._plasticPlayTimer = null; } }

  // ── Load pattern for hinges/pushover (#45) ──────────────────────────────────
  // Options for the selector: all cases, a specific case, or a combination.
  _loadPatternOptions() {
    const opts = [{ value: 'all', label: 'Todos los casos estáticos (combinados, factor 1)' }];
    for (const lc of this.model.loadCases.values())
      if (lc.type !== 'spectrum') opts.push({ value: 'lc:' + lc.id, label: 'Caso: ' + lc.name });
    for (const cb of this.model.combinations.values())
      opts.push({ value: 'combo:' + cb.id, label: 'Combo: ' + cb.name });
    return opts;
  }
  // Resolves a pattern into contributions {lcId, factor, selfWeight}. Each case's
  // self-weight is honored and scaled by its factor (in combos, e.g. 1.2·D).
  _resolvePattern(choice) {
    const staticLcs = [...this.model.loadCases.values()].filter(lc => lc.type !== 'spectrum');
    const allContribs = () => staticLcs.map(lc => ({ lcId: lc.id, factor: 1, selfWeight: !!lc.selfWeight }));
    if (!choice || choice === 'all') return { contribs: allContribs(), label: 'todos los casos' };
    if (choice.startsWith('lc:')) {
      const id = +choice.slice(3), lc = this.model.loadCases.get(id);
      if (lc && lc.type !== 'spectrum') return { contribs: [{ lcId: id, factor: 1, selfWeight: !!lc.selfWeight }], label: lc.name };
    } else if (choice.startsWith('combo:')) {
      const id = +choice.slice(6), cb = this.model.combinations.get(id);
      if (cb) {
        const contribs = [];
        for (const f of (cb.factors || [])) {
          const lc = this.model.loadCases.get(f.lcId);
          if (lc && lc.type !== 'spectrum') contribs.push({ lcId: f.lcId, factor: f.factor, selfWeight: !!lc.selfWeight });
        }
        if (contribs.length) return { contribs, label: cb.name };
      }
    }
    return { contribs: allContribs(), label: 'todos los casos' };
  }
  // <option>s for the pattern <select>, marking the last one used.
  _patternSelectHTML(id) {
    const last = this._lastPattern || 'all';
    const opts = this._loadPatternOptions().map(o =>
      `<option value="${o.value}"${o.value === last ? ' selected' : ''}>${String(o.label).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</option>`).join('');
    return `<select id="${id}" style="width:100%">${opts}</select>`;
  }

  // CONSTITUTIVE curve of the hinge (moment–rotation M–θ) as SVG. mode:
  //  'perfecto' → elastic up to Mp and infinite plateau (elastic-perfectly-plastic).
  //  'fragil'   → elastic up to Mp and DROP to a residual (resPct % of Mp), then plateau.
  _hingeBackboneSVG(mode = 'perfecto', resPct = 0.01, W = 240, H = 150) {
    const pad = 28, x0 = pad, y0 = H - pad, xMax = W - 10, yTop = 14;
    const Mp = y0 - yTop;                 // pixels for Mp
    const xy = (x) => (x0 + 18) + x;      // θ in px from the elastic start
    const xYield = 46;                    // θy in px
    const r = Math.max(0, Math.min(1, resPct / 100));
    const yM = (frac) => y0 - frac * Mp;  // frac of Mp → y px
    const ax = `<line x1="${x0}" y1="${y0}" x2="${xMax}" y2="${y0}" stroke="var(--border)" stroke-width="1"/>` +
               `<line x1="${x0}" y1="${y0}" x2="${x0}" y2="${yTop}" stroke="var(--border)" stroke-width="1"/>` +
               `<text x="${xMax}" y="${y0 + 14}" font-size="10" fill="var(--text-muted)" text-anchor="end">θ (giro)</text>` +
               `<text x="${x0 - 4}" y="${yTop}" font-size="10" fill="var(--text-muted)" text-anchor="end">M</text>` +
               `<line x1="${x0}" y1="${yM(1)}" x2="${x0 + 4}" y2="${yM(1)}" stroke="var(--text-muted)"/>` +
               `<text x="${x0 - 4}" y="${yM(1) + 3}" font-size="10" fill="var(--text-muted)" text-anchor="end">Mp</text>`;
    const xEnd = xMax - x0 - 20, xDrop = xy(xYield) + Math.round((xEnd - xYield) * 0.45);   // θu for ductile-with-drop
    let path, note, uMark = '';
    if (mode === 'fragil') {
      path = `M ${xy(0)} ${yM(0)} L ${xy(xYield)} ${yM(1)} L ${xy(xYield)} ${yM(r)} L ${xy(xEnd)} ${yM(r)}`;
      note = `<text x="${xy(xYield) + 4}" y="${yM(r) + (r < 0.15 ? -4 : 12)}" font-size="9" fill="var(--accent,#3b82f6)">caída a ${(+resPct).toFixed(2)}%·Mp</text>`;
    } else if (mode === 'ductil_caida') {
      path = `M ${xy(0)} ${yM(0)} L ${xy(xYield)} ${yM(1)} L ${xDrop} ${yM(1)} L ${xDrop} ${yM(r)} L ${xy(xEnd)} ${yM(r)}`;
      note = `<text x="${xy(xYield) + 4}" y="${yM(1) - 4}" font-size="9" fill="var(--accent,#3b82f6)">meseta hasta θu, luego cae</text>`;
      uMark = `<line x1="${xDrop}" y1="${y0}" x2="${xDrop}" y2="${yM(1)}" stroke="var(--border)" stroke-dasharray="2,2"/><text x="${xDrop}" y="${y0 + 12}" font-size="9" fill="var(--text-muted)" text-anchor="middle">θu</text>`;
    } else {
      path = `M ${xy(0)} ${yM(0)} L ${xy(xYield)} ${yM(1)} L ${xy(xEnd)} ${yM(1)}`;
      note = `<text x="${xy(xYield) + 4}" y="${yM(1) - 4}" font-size="9" fill="var(--accent,#3b82f6)">meseta ∞ (dúctil)</text>`;
    }
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px;background:var(--bg4);border-radius:6px">` +
      ax + `<line x1="${xy(xYield)}" y1="${y0}" x2="${xy(xYield)}" y2="${yM(1)}" stroke="var(--border)" stroke-dasharray="2,2"/>` +
      `<text x="${xy(xYield)}" y="${y0 + 12}" font-size="9" fill="var(--text-muted)" text-anchor="middle">θy</text>` + uMark +
      `<path d="${path}" fill="none" stroke="var(--accent,#3b82f6)" stroke-width="2.5"/>` + note + `</svg>`;
  }

  /** HTML dialog — Mp capacity (uniform and/or per selection) for the hinges. */
  _plasticDialog(hasSel) {
    return new Promise(resolve => {
      const overlay = document.getElementById('modal-overlay');
      document.getElementById('modal-title').textContent = i18n.t('Rótulas plásticas (material elasto-plástico)');
      document.getElementById('modal-cancel').style.display = '';
      const selBlock = hasSel ? `
        <div class="prop-row cols1" style="margin-top:8px">
          <div class="prop-field">
            <label>Mp para los elementos SELECCIONADOS [kN·m]</label>
            <input type="text" id="pl-mp-sel" value="100" style="width:100%;margin-top:4px">
          </div>
        </div>
        <div class="prop-row cols1" style="margin-top:6px">
          <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer">
            <input type="checkbox" id="pl-solo-sel"> Sólo la selección puede rotular (el resto permanece elástico)
          </label>
        </div>` : '';
      document.getElementById('modal-body').innerHTML = `
        <div class="prop-row cols1">
          <div class="prop-field">
            <label>Momento plástico Mp [kN·m] (capacidad ${hasSel ? 'del resto de elementos' : 'de cada rótula'})</label>
            <input type="text" id="pl-mp-def" value="100" style="width:100%;margin-top:4px">
          </div>
        </div>
        ${selBlock}
        <div class="prop-row cols1" style="margin-top:8px">
          <div class="prop-field">
            <label>Comportamiento de la rótula (curva constitutiva)</label>
            <select id="pl-mode" style="width:100%;margin-top:4px">
              <option value="perfecto">Dúctil — perfectamente plástica (meseta ∞)</option>
              <option value="ductil_caida">Dúctil con caída — meseta hasta θu/δu y luego cae</option>
              <option value="fragil">Frágil — caída inmediata al alcanzar la capacidad</option>
            </select>
          </div>
        </div>
        <div class="prop-row cols1" id="pl-res-row" style="margin-top:6px;display:none">
          <div class="prop-field">
            <label>Capacidad residual tras la caída [% de la capacidad]</label>
            <input type="text" id="pl-residual" value="0.01" style="width:100%;margin-top:4px">
          </div>
        </div>
        <div class="prop-row cols2" id="pl-defu-row" style="margin-top:6px;display:none">
          <div class="prop-field"><label>θu rotación última [rad] (momento)</label><input type="text" id="pl-thetau" value="0.02" style="width:100%;margin-top:4px"></div>
          <div class="prop-field"><label>δu desplaz. último [m] (N/V)</label><input type="text" id="pl-deltau" value="0.02" style="width:100%;margin-top:4px"></div>
        </div>
        <div class="prop-row cols2" style="margin-top:6px">
          <div class="prop-field"><label>Np axial [kN] (resorte/rótula N; vacío = ∞)</label><input type="text" id="pl-np" value="" placeholder="∞" style="width:100%;margin-top:4px"></div>
          <div class="prop-field"><label>Vp cortante [kN] (rótula V; vacío = ∞)</label><input type="text" id="pl-vp" value="" placeholder="∞" style="width:100%;margin-top:4px"></div>
        </div>
        <div class="prop-row cols1" style="margin-top:8px;text-align:center">
          <div id="pl-curve">${this._hingeBackboneSVG('perfecto', 0.01)}</div>
          <span style="color:var(--text-muted);font-size:10px">Curva constitutiva momento–giro de la rótula</span>
        </div>
        <div class="prop-row cols1" style="margin-top:8px">
          <div class="prop-field">
            <label>Patrón de carga a evaluar (#45)</label>
            ${this._patternSelectHTML('pl-pattern')}
          </div>
        </div>
        <div class="prop-row cols1" style="margin-top:8px">
          <span style="color:var(--text-muted);font-size:11px;line-height:1.5">Análisis incremental evento-a-evento: cada extremo forma rótula al alcanzar su Mp; el colapso ocurre al formarse un mecanismo. En modo <b>frágil</b> la rótula pierde capacidad al formarse (caída brusca → posible colapso anticipado en cascada).${hasSel ? '' : ' Seleccione elementos antes para asignar capacidades por separado.'}</span>
        </div>`;
      overlay.classList.remove('hidden');
      const redrawCurve = () => {
        const mode = document.getElementById('pl-mode')?.value || 'perfecto';
        const res = parseFloat(document.getElementById('pl-residual')?.value) || 0.01;
        const hasCaida = mode === 'fragil' || mode === 'ductil_caida';
        const rr = document.getElementById('pl-res-row'); if (rr) rr.style.display = hasCaida ? '' : 'none';
        const dr = document.getElementById('pl-defu-row'); if (dr) dr.style.display = mode === 'ductil_caida' ? '' : 'none';
        const c = document.getElementById('pl-curve'); if (c) c.innerHTML = this._hingeBackboneSVG(mode, res);
      };
      setTimeout(() => { document.getElementById('pl-mode')?.addEventListener('change', redrawCurve); document.getElementById('pl-residual')?.addEventListener('input', redrawCurve); const el = document.getElementById('pl-mp-def'); el?.focus(); el?.select(); }, 50);
      overlay._resolve = () => {
        const mpDefault = parseFloat(document.getElementById('pl-mp-def')?.value);
        if (!(mpDefault > 0)) { this.toast('Mp debe ser un número > 0', 'warn'); resolve(null); return; }
        let mpSel = mpDefault, soloSel = false;
        if (hasSel) {
          mpSel = parseFloat(document.getElementById('pl-mp-sel')?.value);
          if (!(mpSel > 0)) { this.toast('Mp de la selección debe ser > 0', 'warn'); resolve(null); return; }
          soloSel = !!document.getElementById('pl-solo-sel')?.checked;
        }
        const pattern = document.getElementById('pl-pattern')?.value || 'all';
        this._lastPattern = pattern;
        const mode = document.getElementById('pl-mode')?.value || 'perfecto';
        const residual = (mode === 'perfecto') ? 1 : Math.max(0, (parseFloat(document.getElementById('pl-residual')?.value) || 0.01) / 100);
        const thetaU = parseFloat(document.getElementById('pl-thetau')?.value) || 0.02;
        const deltaU = parseFloat(document.getElementById('pl-deltau')?.value) || 0.02;
        const Np = parseFloat(document.getElementById('pl-np')?.value);
        const Vp = parseFloat(document.getElementById('pl-vp')?.value);
        resolve({ mpDefault, mpSel, soloSel, pattern, mode, residual, thetaU, deltaU, Np: Np > 0 ? Np : 0, Vp: Vp > 0 ? Vp : 0 });
      };
      overlay._reject = () => resolve(null);
    });
  }

  // ── NL-lite: builds the nonlinear problem (bars/cables) from the model ──────
  // `pattern` (#45): reference load pattern (all / one case / one combo).
  _buildNLProblem(pattern) {
    const model = this.model;
    const nodeIds = [...model.nodes.keys()];
    const idxOf = new Map(nodeIds.map((id, i) => [id, i]));
    const nNode = nodeIds.length;
    const X = new Float64Array(3 * nNode);
    nodeIds.forEach((id, i) => { const n = model.nodes.get(id); X[3 * i] = n.x; X[3 * i + 1] = n.y; X[3 * i + 2] = n.z; });
    const elems = [], elemIds = [];
    for (const el of model.elements.values()) {
      const n1 = model.nodes.get(el.n1), n2 = model.nodes.get(el.n2);
      const mat = model.materials.get(el.matId), sec = model.sections.get(el.secId);
      if (!n1 || !n2 || !mat || !sec) continue;
      const L = Math.hypot(n2.x - n1.x, n2.y - n1.y, n2.z - n1.z); if (L < 1e-12) continue;
      elems.push({ n1: idxOf.get(el.n1), n2: idxOf.get(el.n2), EA: mat.E * sec.A, L0: (el.L0factor || 1) * L, cable: !!el.cable, compressionOnly: !!el.compressionOnly });
      elemIds.push(el.id);
    }
    const is2D = model.mode === '2D';
    const free = [];
    nodeIds.forEach((id, i) => { const r = model.nodes.get(id).restraints; const fix = [r.ux, is2D ? 1 : r.uy, r.uz]; for (let c = 0; c < 3; c++) if (!fix[c]) free.push(3 * i + c); });
    const Fref = new Float64Array(3 * nNode); let nCasos = 0;
    const addN = (id, fx, fy, fz) => { const i = idxOf.get(id); if (i == null) return; Fref[3 * i] += fx; Fref[3 * i + 1] += fy; Fref[3 * i + 2] += fz; };
    const dirVec = d => d === 'globalX' ? [1, 0, 0] : d === 'globalY' ? [0, 1, 0] : d === 'globalZ' ? [0, 0, 1] : [0, 0, -1];
    const { contribs, label: patLabel } = this._resolvePattern(pattern);
    for (const c of contribs) {
      const lc = model.loadCases.get(c.lcId); if (!lc) continue; nCasos++;
      const fac = c.factor;
      for (const ld of (lc.loads || [])) {
        if (ld.type === 'nodal') addN(ld.nodeId, fac * (ld.F[0] || 0), fac * (ld.F[1] || 0), fac * (ld.F[2] || 0));
        else if (ld.type === 'dist') {
          const el = model.elements.get(ld.elemId); if (!el) continue;
          const n1 = model.nodes.get(el.n1), n2 = model.nodes.get(el.n2); if (!n1 || !n2) continue;
          const L = Math.hypot(n2.x - n1.x, n2.y - n1.y, n2.z - n1.z);
          const half = fac * (ld.w || 0) * L / 2, g = dirVec(ld.dir || 'gravity');
          addN(el.n1, half * g[0], half * g[1], half * g[2]); addN(el.n2, half * g[0], half * g[1], half * g[2]);
        }
      }
      if (c.selfWeight) for (const el of model.elements.values()) {
        const mat = model.materials.get(el.matId), sec = model.sections.get(el.secId);
        const n1 = model.nodes.get(el.n1), n2 = model.nodes.get(el.n2);
        if (!mat || !sec || !n1 || !n2) continue;
        const L = Math.hypot(n2.x - n1.x, n2.y - n1.y, n2.z - n1.z), w = fac * mat.rho * sec.A * L / 2;
        addN(el.n1, 0, 0, -w); addN(el.n2, 0, 0, -w);
      }
    }
    return { X, elems, elemIds, free, Fref, nodeIds, idxOf, nNode, nCasos, patLabel };
  }

  /** HTML dialog — pushover: initial imperfection + load pattern (#45). */
  _pushoverDialog() {
    return new Promise(resolve => {
      const overlay = document.getElementById('modal-overlay');
      document.getElementById('modal-title').textContent = i18n.t('Pushover — control de desplazamiento');
      document.getElementById('modal-cancel').style.display = '';
      document.getElementById('modal-body').innerHTML = `
        <div class="prop-row cols1">
          <div class="prop-field">
            <label>Patrón de carga de referencia (#45)</label>
            ${this._patternSelectHTML('po-pattern')}
          </div>
        </div>
        <div class="prop-row cols1" style="margin-top:8px">
          <div class="prop-field">
            <label>Imperfección inicial (amplitud en m; 0 = perfecta)</label>
            <input type="text" id="po-imp" value="0" style="width:100%;margin-top:4px">
          </div>
        </div>
        <div class="prop-row cols1" style="margin-top:8px">
          <span style="color:var(--text-muted);font-size:11px;line-height:1.5">Idealiza las barras como reticulado (axial/cables). La imperfección dispara inestabilidades (snap-through / puntos límite).</span>
        </div>`;
      overlay.classList.remove('hidden');
      setTimeout(() => { const el = document.getElementById('po-imp'); el?.focus(); el?.select(); }, 50);
      overlay._resolve = () => {
        const pattern = document.getElementById('po-pattern')?.value || 'all';
        const imp = document.getElementById('po-imp')?.value ?? '0';
        resolve({ imp, pattern });
      };
      overlay._reject = () => resolve(null);
    });
  }

  // ── NL-lite Phase 5: pushover by DISPLACEMENT CONTROL + imperfections ───────
  // + load–displacement curve. Traces the full equilibrium path
  // (snap-through / limit points). Optional initial imperfection to trigger
  // instabilities. Treats the elements as bars/cables (truss).
  async runPushoverDC(opts = {}) {
    if (!this._config?.analisis?.nlLite) { this.toast('Active «Análisis no lineal (NL-lite)» en ⚙ Configuración', 'warn'); this.configDialog?.(); return; }
    const model = this.model;
    if (model.nodes.size === 0 || model.elements.size === 0) { this.toast('Modelo vacío', 'warn'); return; }

    // Dialog: imperfection + load pattern (#45). In batch, default values.
    const pd = opts.silent ? { imp: 0, pattern: this._lastPattern || 'all' } : await this._pushoverDialog();
    if (!pd) return;
    const imp = parseFloat(pd.imp) || 0;
    this._lastPattern = pd.pattern;

    const P = this._buildNLProblem(pd.pattern);
    if (!P.free.length) { this.toast('Sin GDL libres', 'warn'); return; }
    if (!P.nCasos) { this.toast('Defina un caso de carga (patrón de referencia).', 'warn'); return; }

    // Linear response (1 step, 1 iteration from u=0) → control DOF + imperfection shape
    const lin = await solverRegistry.solveNonlinear({ X: P.X, elems: P.elems, free: P.free, Fref: P.Fref, nSteps: 1, maxIter: 1, tol: 1e-30 });
    const uLin = lin.steps[0]?.u || new Float64Array(P.X.length);
    let cDOF = P.free[0], best = -1;
    for (const d of P.free) { const v = Math.abs(uLin[d]); if (v > best) { best = v; cDOF = d; } }
    if (best < 1e-30) {
      let frefN = 0; for (const d of P.free) frefN += P.Fref[d] * P.Fref[d]; frefN = Math.sqrt(frefN);
      this.toast(frefN < 1e-12
        ? 'El patrón de carga es nulo (asigne cargas en algún caso antes de correr el pushover).'
        : 'La carga no produce desplazamiento: el pushover por control de desplazamiento idealiza las barras como RETICULADO (sólo axial/cables, sin flexión). Para pórticos a flexión use «Rótulas plásticas».', 'warn');
      return;
    }

    const Ximp = Float64Array.from(P.X);
    if (imp > 0) {
      let nrm = 0; for (const d of P.free) nrm += uLin[d] * uLin[d]; nrm = Math.sqrt(nrm) || 1;
      for (const d of P.free) Ximp[d] += imp * uLin[d] / nrm;
    }
    const linCtrl = uLin[cDOF] || 1e-3;
    const target = linCtrl * 25;   // pushes well past limit points (traces the full snap-through)
    this._showProgress('Pushover…', 'Trazando la trayectoria de equilibrio (control de desplazamiento) en segundo plano');
    await new Promise(r => setTimeout(r, 20));
    let res;
    try { res = await this._solveNLInWorker('dc', { X: Ximp, elems: P.elems, free: P.free, Fref: P.Fref, controlDOF: cDOF, targetDisp: target, nSteps: 60 }); }
    catch (e) { this.toast(`${i18n.t('Error en pushover:')} ${i18n.t(e.message)}`, 'error'); console.error(e); return; }
    finally { this._hideProgress(); }
    if (!res.path || res.path.length < 2) { this.toast(i18n.t('Pushover DC:') + ' ' + (res.note || i18n.t('sin trayectoria')), 'error'); return; }

    this._dcResult = { res, P, cDOF, imp, Ximp };
    let peak = -Infinity, peakD = 0; for (const p of res.path) if (p.lambda > peak) { peak = p.lambda; peakD = p.disp; }
    const ni = Math.floor(cDOF / 3), nodeId = P.nodeIds[ni], axis = 'XYZ'[cDOF % 3];
    this._dcCtrlLabel = `nodo ${nodeId} · ${axis}`;
    this.toast(`${res.ok ? i18n.t('Pushover DC OK') : res.note} · ${i18n.t('pico')} λ=${peak.toFixed(3)} (${i18n.t('carga límite')}) · ${i18n.t('control')} ${this._dcCtrlLabel}${imp ? ` · ${i18n.t('imperfección')} ${imp} m` : ''}`, res.ok ? 'ok' : 'warn');
    this._dcOpenOverlay();
    this._updateResultsIndicator();
  }

  // #90: Pushover (displacement control) → «Pushover» tab in Results.
  _dcOpenOverlay() {
    if (!this._dcResult) return;
    this.panel._switchVTab('results');
    this.panel._switchRTab('dc');   // → _dcRenderPanel()
  }

  // Builds the «Pushover» tab content in #dc-panel (same IDs as the old floating
  // window → _dcShowStep stays the same).
  _dcRenderPanel() {
    const el = document.getElementById('dc-panel');
    const hint = document.getElementById('res-dc-hint');
    if (!el) return;
    if (!this._dcResult) { if (hint) hint.style.display = ''; el.innerHTML = ''; return; }
    if (hint) hint.style.display = 'none';
    this._dcStopPlay();
    const { res } = this._dcResult;
    const path = res.path;
    // λ vs control displacement curve (SVG)
    const W = 256, H = 120, ml = 4, mr = 4, mt = 6, mb = 4;
    const ds = path.map(p => p.disp), ls = path.map(p => p.lambda);
    const dmin = Math.min(...ds), dmax = Math.max(...ds), lmin = Math.min(...ls, 0), lmax = Math.max(...ls, 0);
    const sx = d => ml + (W - ml - mr) * (Math.abs(dmax - dmin) < 1e-30 ? 0.5 : (d - dmin) / (dmax - dmin));
    const sy = l => mt + (H - mt - mb) * (1 - (Math.abs(lmax - lmin) < 1e-30 ? 0.5 : (l - lmin) / (lmax - lmin)));
    const poly = path.map(p => `${sx(p.disp).toFixed(1)},${sy(p.lambda).toFixed(1)}`).join(' ');
    const y0 = sy(0).toFixed(1);
    this._dcSVG = (k) => `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:${H}px;background:var(--bg3,#0b1220);border-radius:6px">
      <line x1="${ml}" y1="${y0}" x2="${W - mr}" y2="${y0}" stroke="var(--border,#26324d)" stroke-width="1"/>
      <polyline points="${poly}" fill="none" stroke="var(--accent,#38bdf8)" stroke-width="1.5"/>
      <circle cx="${sx(path[k].disp).toFixed(1)}" cy="${sy(path[k].lambda).toFixed(1)}" r="3.5" fill="#f59e0b"/>
    </svg>`;
    el.innerHTML = `
      <div id="dc-plot"></div>
      <div style="display:flex;align-items:center;gap:6px;margin:6px 0">
        <button id="dc-play" class="btn-secondary" style="font-size:14px;padding:2px 8px">▶</button>
        <input type="range" id="dc-step" min="0" max="${path.length - 1}" value="${path.length - 1}" style="flex:1">
        <select id="dc-speed" title="Velocidad de animación" style="font-size:11px"><option value="0.5">×0.5</option><option value="1" selected>×1</option><option value="2">×2</option><option value="4">×4</option></select>
      </div>
      <div id="dc-readout" style="color:var(--text-muted,#94a3b8);font-size:11px;line-height:1.5"></div>`;
    const stepInp = el.querySelector('#dc-step'), playBtn = el.querySelector('#dc-play');
    const redraw = () => this._dcShowStep(+stepInp.value);
    stepInp.addEventListener('input', redraw);
    playBtn.addEventListener('click', () => {
      if (this._dcPlayTimer) { this._dcStopPlay(); playBtn.textContent = '▶'; return; }
      playBtn.textContent = '⏸';
      const speedEl = el.querySelector('#dc-speed');
      this._dcPlayTimer = setInterval(() => { const stride = Math.max(1, Math.round(parseFloat(speedEl?.value) || 1)); let v = +stepInp.value + stride; if (v > path.length - 1) v = 0; stepInp.value = v; redraw(); }, 120);
    });
    redraw();
  }

  _dcStopPlay() { if (this._dcPlayTimer) { clearInterval(this._dcPlayTimer); this._dcPlayTimer = null; } }

  _dcShowStep(k) {
    const { res, P } = this._dcResult;
    const p = res.path[Math.max(0, Math.min(k, res.path.length - 1))]; if (!p) return;
    const uByNode = new Map(), elemState = new Map();
    P.nodeIds.forEach((id, i) => uByNode.set(id, [p.u[3 * i], p.u[3 * i + 1], p.u[3 * i + 2]]));
    P.elemIds.forEach((eid, j) => {
      const me = this.model.elements.get(eid);
      const taut = me?.cable ? p.N[j] >= 0 : (me?.compressionOnly ? p.N[j] <= 0 : true);
      elemState.set(eid, { N: p.N[j], cable: me?.cable, compressionOnly: me?.compressionOnly, taut });
    });
    this.viewport.showNLDeformed(uByNode, elemState, 1,
      `Pushover DC · λ=${p.lambda.toFixed(3)} · δ(${this._dcCtrlLabel})=${p.disp.toExponential(2)} m`);
    const plot = document.getElementById('dc-plot'); if (plot) plot.innerHTML = this._dcSVG(k);
    const ro = document.getElementById('dc-readout');
    if (ro) ro.innerHTML = `λ = <b>${p.lambda.toFixed(4)}</b> ${i18n.t('(× carga de referencia)')}<br>δ control (${this._dcCtrlLabel}) = ${p.disp.toExponential(3)} m<br>${i18n.t('punto')} ${k + 1}/${res.path.length}`;
  }

  _spectrumDialog(defaultText) {
    const is2D = this.model.mode === '2D';
    // Spectrum cases ALREADY saved (their parameters can be selected and edited).
    const specCases = [...this.model.loadCases.values()].filter(l => l.type === 'spectrum');
    // "Current" case to prefill: the active one if spectral, otherwise the first saved.
    const activeLc = this.model.loadCases.get(this._activeLcId);
    let curLc = (activeLc?.type === 'spectrum') ? activeLc : (specCases[0] || null);
    // Initial form values taken from the chosen case (or defaults).
    const sp0 = curLc?.spec || {};
    const prefDir   = curLc?.specDir || 'X';
    const initMethod = sp0.method || 'CQC';
    const initZeta   = sp0.zeta ?? 0.05;
    const initFactor = sp0.saFactor || 9.81;
    const initialText = sp0.rawText || defaultText;
    // Fundamental T* suggested from the modal analysis (if available)
    const Tstar0 = this._modalResults?.period?.[0]
      ? this._modalResults.period[0].toFixed(3) : '';
    // Period selector: list of modes from the modal analysis or an arbitrary value.
    const periodos = this._modalResults?.period || [];
    const tmodeSelect = periodos.length
      ? `<select id="sp-Tmode" style="width:100%;margin-bottom:3px">
          <option value="__arb">Período arbitrario (escribir ↓)</option>
          ${periodos.slice(0, 20).map((T, i) => `<option value="${(+T).toFixed(4)}" ${i === 0 ? 'selected' : ''}>Modo ${i + 1} — T = ${(+T).toFixed(3)} s</option>`).join('')}
         </select>` : '';

    return new Promise(resolve => {
      const overlay = document.getElementById('modal-overlay');
      document.getElementById('modal-title').textContent = i18n.t('Espectro de Respuesta');
      document.getElementById('modal-cancel').style.display = '';

      document.getElementById('modal-body').innerHTML = `
<div class="prop-row" style="margin-bottom:10px">
  <div class="prop-field">
    <label>Caso de espectro <span style="color:var(--text-muted);font-weight:400">(elige uno guardado para editar sus parámetros, o crea uno nuevo)</span></label>
    <div style="display:flex;gap:6px;align-items:stretch">
      <select id="sp-case" style="flex:1">
        <option value="__new">➕ Nuevo caso de espectro…</option>
        ${specCases.map(l => `<option value="${l.id}" ${curLc && l.id === curLc.id ? 'selected' : ''}>${esc(l.name || ('Caso ' + l.id))} (${esc(l.specDir || 'X')})</option>`).join('')}
      </select>
      <button type="button" id="sp-addcase" class="btn-secondary" title="Crear otro caso de espectro con estos parámetros (sin salir de la ventana)" style="white-space:nowrap;padding:0 10px">＋ caso</button>
      <button type="button" id="sp-del" class="btn-secondary" title="Eliminar el caso de espectro seleccionado" style="white-space:nowrap;padding:0 10px">🗑</button>
    </div>
    <small id="sp-status" style="display:block;margin-top:5px;font-size:11px;color:var(--text-muted)">Edita los parámetros y pulsa «Crear caso» (nuevo) o «Aceptar» (guardar en el caso elegido). «Calcular» guarda y ejecuta.</small>
  </div>
</div>
<div class="prop-row cols3" style="margin-bottom:10px">
  <div class="prop-field">
    <label>Dirección sísmica</label>
    <select id="sp-dir">
      <option value="X" ${prefDir !== 'Y' ? 'selected' : ''}>X  (E–O)</option>
      ${is2D ? '' : `<option value="Y" ${prefDir === 'Y' ? 'selected' : ''}>Y  (N–S)</option>`}
    </select>
  </div>
  <div class="prop-field">
    <label>Combinación</label>
    <select id="sp-method">
      <option value="CQC" ${initMethod !== 'SRSS' ? 'selected' : ''}>CQC (recomendado)</option>
      <option value="SRSS" ${initMethod === 'SRSS' ? 'selected' : ''}>SRSS</option>
    </select>
  </div>
  <div class="prop-field">
    <label>Amortiguamiento ζ</label>
    <input type="number" id="sp-zeta" value="${initZeta}" step="0.01" min="0.01" max="0.5">
  </div>
</div>

<fieldset style="border:1px solid var(--border);border-radius:6px;padding:8px 10px;margin-bottom:10px">
  <legend style="padding:0 6px;color:var(--accent);font-size:12px">Construir espectro NCh433 / DS61</legend>
  <div class="prop-row cols3" style="margin-bottom:8px">
    <div class="prop-field"><label>Zona sísmica (Ao)</label>
      <select id="sp-zona"><option value="1">1 (0.20 g)</option><option value="2" selected>2 (0.30 g)</option><option value="3">3 (0.40 g)</option></select>
    </div>
    <div class="prop-field"><label>Tipo de suelo</label>
      <select id="sp-suelo"><option>A</option><option>B</option><option>C</option><option selected>D</option><option>E</option></select>
    </div>
    <div class="prop-field"><label>Categoría (I)</label>
      <select id="sp-cat"><option value="I">I (0.6)</option><option value="II" selected>II (1.0)</option><option value="III">III (1.2)</option><option value="IV">IV (1.2)</option></select>
    </div>
  </div>
  <div class="prop-row cols3" style="margin-bottom:8px">
    <div class="prop-field"><label>Ro</label><input type="number" id="sp-Ro" value="11" step="0.5" min="1"></div>
    <div class="prop-field"><label>T* (s) — período fundamental</label>${tmodeSelect}<input type="number" id="sp-Tstar" value="${Tstar0}" step="0.01" min="0" placeholder="período en s"></div>
    <div class="prop-field"><label>&nbsp;</label><button type="button" id="sp-gen" class="btn" style="width:100%">Generar curva</button></div>
  </div>
  <small id="sp-rstar" style="color:var(--text-muted);display:block">Sa(T)=S·Ao·I·α(T)/R*. Si T* está vacío, R*=1 (espectro elástico).</small>
</fieldset>

<div class="prop-row" style="margin-bottom:10px">
  <div class="prop-field">
    <label>Unidades de Sa</label>
    <select id="sp-unit">
      <option value="9.81" ${Math.abs(initFactor-9.81)<1e-6?'selected':''}>g  (×9.81 → m/s²)</option>
      <option value="1" ${Math.abs(initFactor-1)<1e-6?'selected':''}>m/s²</option>
      <option value="0.01" ${Math.abs(initFactor-0.01)<1e-6?'selected':''}>cm/s²</option>
      <option value="0.3048" ${Math.abs(initFactor-0.3048)<1e-6?'selected':''}>ft/s²</option>
    </select>
  </div>
</div>
<div class="prop-field">
  <label>Espectro — T (s), Sa   (una pareja por línea)</label>
  <textarea id="sp-spectrum" rows="7" class="sp-textarea" placeholder="Aún sin espectro. Use «Generar curva» (NCh433) o pegue sus pares T, Sa.">${initialText}</textarea>
</div>
<div class="prop-field" style="margin-top:8px">
  <label>Curva Sa(T) <span style="color:var(--text-muted);font-weight:400">(se dibuja desde los datos de arriba)</span></label>
  <svg id="sp-graph" viewBox="0 0 420 200" style="width:100%;height:170px;background:var(--bg-elev,#1b1b1b);border:1px solid var(--border);border-radius:6px"></svg>
</div>`;

      // ── NCh433/DS61 tables (same as assistant/rules.json) ─────────────────
      const SUELOS = { A:{S:0.9,To:0.15,p:2.0}, B:{S:1.0,To:0.30,p:1.5}, C:{S:1.05,To:0.40,p:1.6}, D:{S:1.2,To:0.75,p:1.0}, E:{S:1.3,To:1.2,p:1.0} };
      const AO = { '1':0.20, '2':0.30, '3':0.40 };
      const CAT = { I:0.6, II:1.0, III:1.2, IV:1.2 };

      const $ = (id) => document.getElementById(id);

      const drawGraph = () => {
        const pts = _parseSpectrum($('sp-spectrum').value); // [{T,Sa},...]
        const svg = $('sp-graph');
        const W = 420, H = 200, ml = 38, mr = 8, mt = 12, mb = 24;
        if (pts.length < 2) { svg.innerHTML = `<text x="${W/2}" y="${H/2}" fill="#888" font-size="11" text-anchor="middle">Sin curva — genérela o ingrésela arriba</text>`; return; }
        const Tmax = Math.max(...pts.map(p => p.T)) || 1;
        const Samax = Math.max(...pts.map(p => p.Sa)) || 1;
        const sx = (t) => ml + (t / Tmax) * (W - ml - mr);
        const sy = (s) => H - mb - (s / Samax) * (H - mt - mb);
        const poly = pts.map(p => `${sx(p.T).toFixed(1)},${sy(p.Sa).toFixed(1)}`).join(' ');
        const gx = [0, 0.25, 0.5, 0.75, 1].map(f => { const t = +(f*Tmax).toFixed(2); return `<line x1="${sx(t)}" y1="${mt}" x2="${sx(t)}" y2="${H-mb}" stroke="#333"/><text x="${sx(t)}" y="${H-8}" fill="#888" font-size="9" text-anchor="middle">${t}</text>`; }).join('');
        const gy = [0, 0.5, 1].map(f => { const s = +(f*Samax).toFixed(3); return `<line x1="${ml}" y1="${sy(s)}" x2="${W-mr}" y2="${sy(s)}" stroke="#333"/><text x="${ml-4}" y="${sy(s)+3}" fill="#888" font-size="9" text-anchor="end">${s}</text>`; }).join('');
        svg.innerHTML = `${gy}${gx}<polyline points="${poly}" fill="none" stroke="var(--accent,#4ea1ff)" stroke-width="2"/><text x="${W-mr}" y="${mt+2}" fill="#888" font-size="9" text-anchor="end">Sa  ·  T (s)</text>`;
      };

      const genNCh433 = () => {
        const su = SUELOS[$('sp-suelo').value]; const Ao = AO[$('sp-zona').value]; const I = CAT[$('sp-cat').value];
        const Ro = parseFloat($('sp-Ro').value) || 11; const Tstar = parseFloat($('sp-Tstar').value);
        const Rstar = (Tstar > 0) ? 1 + Tstar / (0.10 * su.To + Tstar / Ro) : 1;
        const alpha = (T) => (1 + 4.5 * Math.pow(T / su.To, su.p)) / (1 + Math.pow(T / su.To, 3));
        const lines = [];
        for (let T = 0; T <= 3.0001; T += 0.05) {
          const Tr = +T.toFixed(2);
          lines.push(`${Tr.toFixed(2)}, ${(su.S * Ao * I * alpha(Tr) / Rstar).toFixed(4)}`);
        }
        $('sp-spectrum').value = lines.join('\n');
        $('sp-unit').value = '9.81';
        $('sp-rstar').textContent = `R* = ${Rstar.toFixed(4)} (To=${su.To}, Ro=${Ro}${Tstar>0?`, T*=${Tstar}`:''}). Sa(0)=${(su.S*Ao*I/Rstar).toFixed(4)} g.`;
        drawGraph();
      };

      $('sp-gen').addEventListener('click', genNCh433);
      $('sp-spectrum').addEventListener('input', drawGraph);
      // Saved-case selector: choosing one loads its parameters into the form.
      $('sp-case')?.addEventListener('change', (e) => {
        const v = e.target.value;
        if (v === '__new') { $('sp-status') && ($('sp-status').textContent = i18n.t('✎ Caso nuevo — pulsa «Crear caso» para guardarlo.')); return; }
        const lc = this.model.loadCases.get(+v); if (!lc) return;
        const sp = lc.spec || {};
        $('sp-dir').value = lc.specDir || 'X';
        $('sp-method').value = sp.method || 'CQC';
        $('sp-zeta').value = sp.zeta ?? 0.05;
        $('sp-unit').value = String(sp.saFactor || 9.81);
        $('sp-spectrum').value = sp.rawText || '';
        drawGraph();
        const st = $('sp-status'); if (st) { st.textContent = `${i18n.t('● Caso')} «${lc.name}» ${i18n.t('cargado (guardado). «Aceptar»/«Calcular» guarda los cambios.')}`; st.style.color = 'var(--ok,#3fb950)'; }
      });
      // Period selector (modal-analysis mode → fills in T*)
      $('sp-Tmode')?.addEventListener('change', (e) => {
        const v = e.target.value;
        if (v && v !== '__arb') { $('sp-Tstar').value = v; if ($('sp-spectrum').value.trim()) genNCh433(); }
      });
      drawGraph();

      // The global Accept/Cancel footer is replaced by this window's own buttons
      // (Exit · Create · Accept · Calculate), injected into the SAME #modal-footer
      // so they stay always visible (the body scrolls). The global buttons are
      // hidden and restored on close.
      const footer  = document.getElementById('modal-footer');
      const okBtn     = document.getElementById('modal-ok');
      const cancelBtn = document.getElementById('modal-cancel');
      const prevJustify = footer ? footer.style.justifyContent : '';
      if (okBtn) okBtn.style.display = 'none';
      if (cancelBtn) cancelBtn.style.display = 'none';
      const actions = document.createElement('div');
      actions.id = 'sp-actions';
      actions.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:8px;width:100%';
      actions.innerHTML = `
        <button type="button" id="sp-exit" class="btn-secondary" title="Cerrar la ventana sin más cambios">Salir</button>
        <div style="display:flex;gap:8px">
          <button type="button" id="sp-create" class="btn-secondary" title="Crear un caso de espectro nuevo con estos parámetros y seguir en esta ventana">➕ Crear caso</button>
          <button type="button" id="sp-accept" class="btn-secondary" title="Guardar los parámetros en el caso seleccionado y cerrar — NO ejecuta el análisis">Aceptar</button>
          <button type="button" id="sp-calc" class="btn-primary" title="Guardar y ejecutar el análisis espectral">Calcular</button>
        </div>`;
      if (footer) { footer.style.justifyContent = 'space-between'; footer.appendChild(actions); }

      // Gathers the form parameters. `forceNew` ⇒ create a new case (ignores the
      // selected one). Returns null and warns if the spectrum is invalid.
      const gather = (forceNew = false) => {
        const rawText = $('sp-spectrum').value;
        const spectrum = _parseSpectrum(rawText);
        if (spectrum.length < 2) {
          this.toast('El espectro necesita al menos 2 puntos (T,Sa)', 'error');
          return null;
        }
        const su = SUELOS[$('sp-suelo').value];
        const TstarV = parseFloat($('sp-Tstar').value);
        const RoV = parseFloat($('sp-Ro').value) || 11;
        const RstarV = (TstarV > 0) ? 1 + TstarV / (0.10 * su.To + TstarV / RoV) : 1;
        const nch433 = {
          zona: $('sp-zona').value, suelo: $('sp-suelo').value, cat: $('sp-cat').value,
          Ao: AO[$('sp-zona').value], I: CAT[$('sp-cat').value],
          S: su.S, To: su.To, p: su.p, Ro: RoV,
          Tstar: TstarV > 0 ? TstarV : null, Rstar: RstarV,
          unidadSa: $('sp-unit').options[$('sp-unit').selectedIndex]?.text || '',
        };
        const caseSel = $('sp-case')?.value;
        const targetLcId = (forceNew || !caseSel || caseSel === '__new') ? null : +caseSel;
        return {
          spectrum, saFactor: parseFloat($('sp-unit').value) || 9.81,
          direction: $('sp-dir').value, zeta: parseFloat($('sp-zeta').value) || 0.05,
          method: $('sp-method').value, rawText, nch433,
          targetLcId, createNew: targetLcId == null,
        };
      };

      // Rebuilds the dialog's case selector and leaves `selId` selected.
      const refreshCaseSelect = (selId) => {
        const sel = $('sp-case'); if (!sel) return;
        const cases = [...this.model.loadCases.values()].filter(l => l.type === 'spectrum');
        sel.innerHTML = '<option value="__new">➕ Nuevo caso de espectro…</option>' +
          cases.map(l => `<option value="${l.id}" ${l.id === selId ? 'selected' : ''}>${esc(l.name || ('Caso ' + l.id))} (${esc(l.specDir || 'X')})</option>`).join('');
        if (selId != null) sel.value = String(selId);
      };

      const close = (val) => {
        actions.remove();
        if (okBtn) okBtn.style.display = '';
        if (cancelBtn) cancelBtn.style.display = '';
        if (footer) footer.style.justifyContent = prevJustify;
        overlay.classList.add('hidden');
        overlay._resolve = () => {}; overlay._reject = () => {};
        resolve(val);
      };

      // Save state (#102): clarifies whether there are unsaved changes or it's been saved.
      const setStatus = (msg, color) => { const el = $('sp-status'); if (el) { el.textContent = msg; el.style.color = color || 'var(--text-muted)'; } };
      const markDirty = () => { const sel = $('sp-case'); const v = sel?.value; setStatus(v && v !== '__new' ? '✎ Cambios sin guardar en el caso seleccionado — pulsa «Aceptar» o «Calcular» para guardar.' : '✎ Caso nuevo sin guardar — pulsa «Crear caso».', 'var(--warn,#d29922)'); };
      ['sp-spectrum'].forEach(id => $(id)?.addEventListener('input', markDirty));
      ['sp-dir', 'sp-method', 'sp-zeta', 'sp-unit'].forEach(id => $(id)?.addEventListener('change', markDirty));

      // «Create» / «＋ case»: creates a new spectrum case WITHOUT exiting or calculating,
      // adds it to the selector and leaves it selected to keep editing.
      const createCase = () => {
        const p = gather(true); if (!p) return;
        const lc = this._saveSpectrumCase(p);
        this._lastSpectrum = p.rawText; this._lastSpectrumParams = p;
        refreshCaseSelect(lc.id);
        this._renderLcSelector();
        this.panel?.renderCombinations?.();
        setStatus(`● Caso «${lc.name}» creado y guardado. Cambia parámetros y «Crear» otro, o «Calcular».`, 'var(--ok,#3fb950)');
        this.toast(`${i18n.t('Caso')} «${lc.name}» ${i18n.t('creado (sin calcular).')}`, 'ok');
      };

      // 🗑 Delete the selected spectrum case.
      const deleteCase = async () => {
        const sel = $('sp-case'); const v = sel?.value;
        if (!v || v === '__new') { this.toast('Elige primero un caso guardado para eliminar', 'warn'); return; }
        const lc = this.model.loadCases.get(+v); if (!lc) return;
        const sure = await this._confirm(`¿Eliminar el caso de espectro «${esc(lc.name)}»?`);
        if (!sure) return;
        this.snapshot();
        this.model.loadCases.delete(+v);
        this._resultsByCase?.delete(+v);
        for (const combo of this.model.combinations.values()) combo.factors = combo.factors.filter(f => f.lcId !== +v);
        if (this._activeLcId === +v) { this._activeLcId = this.model.loadCases.keys().next().value; this._activeResultKey = this._activeLcId; }
        this.markDirty(); this._renderLcSelector(); this.panel?.renderCombinations?.();
        refreshCaseSelect(null); sel.value = '__new';
        setStatus(`Caso «${lc.name}» eliminado.`, 'var(--text-muted)');
        this.toast(`${i18n.t('Caso de espectro')} «${lc.name}» ${i18n.t('eliminado')}`, 'ok');
      };

      $('sp-create')?.addEventListener('click', createCase);
      $('sp-addcase')?.addEventListener('click', createCase);
      $('sp-del')?.addEventListener('click', deleteCase);
      $('sp-exit')?.addEventListener('click', () => close(null));
      $('sp-accept')?.addEventListener('click', () => { const p = gather(); if (p) close({ ...p, action: 'accept' }); });
      $('sp-calc')?.addEventListener('click',   () => { const p = gather(); if (p) close({ ...p, action: 'calculate' }); });

      overlay.classList.remove('hidden');
      overlay._resolve = () => {};            // the global footer is hidden
      overlay._reject  = () => close(null);   // global Escape → clean exit
    });
  }

  // Creates or updates the spectral load case from the dialog parameters,
  // WITHOUT running the solver. Shared by «Create», «Accept» and «Calculate».
  _saveSpectrumCase(params) {
    let specLc = params.targetLcId ? this.model.loadCases.get(params.targetLcId) : null;
    if (specLc && specLc.type === 'spectrum') {
      if (specLc.specDir !== params.direction) {   // update dir + default name
        specLc.specDir = params.direction;
        if (/^Sismo [XY] \(esp\)/.test(specLc.name)) specLc.name = `Sismo ${params.direction} (esp)`;
      }
    } else if (!params.createNew) {
      specLc = [...this.model.loadCases.values()]
        .find(l => l.type === 'spectrum' && l.specDir === params.direction);
    }
    if (!specLc) {
      // Unique name: «Sismo X (esp)», «Sismo X (esp) 2», … if it already exists.
      let name = `Sismo ${params.direction} (esp)`, k = 1;
      const taken = new Set([...this.model.loadCases.values()].map(l => l.name));
      while (taken.has(name)) { k++; name = `Sismo ${params.direction} (esp) ${k}`; }
      specLc = this.model.addLoadCase(name, false, 'spectrum', params.direction);
    }
    specLc.spec = {   // parameters used (saved in the .s3d)
      method: params.method, zeta: params.zeta,
      saFactor: params.saFactor, rawText: params.rawText,
    };
    this.markDirty();
    return specLc;
  }

  // ── P1-2: Refresh stale CR values after loading a .s3d file ──────────────
  _refreshDiaphragmCRs() {
    for (const d of this.model.diaphragms.values()) {
      const nodeIds = d.nodes.filter(id => this.model.nodes.has(id));
      if (nodeIds.length < 2) continue;
      const floorNodeSet = new Set(nodeIds);
      const cr = computeFloorCR(this.model, floorNodeSet, d.z);
      if (!cr) continue;
      d.cr = cr;

      // Update masterId if the saved one is at the wrong position
      const CTOL = 0.05;
      const existingMaster = this.model.nodes.get(d.masterId);
      const masterMisplaced = !existingMaster
        || Math.abs(existingMaster.x - cr.x) > CTOL
        || Math.abs(existingMaster.y - cr.y) > CTOL;
      if (masterMisplaced) {
        const match = nodeIds
          .map(id => this.model.nodes.get(id))
          .find(n => n && Math.abs(n.x - cr.x) < CTOL && Math.abs(n.y - cr.y) < CTOL);
        if (match) d.masterId = match.id;
      }
    }
  }

  // ── P4-14: Pre-analysis model validation ──────────────────────────────────
  _validateModel() {
    const warnings = [];
    const model = this.model;

    // Nodes without connected elements
    // (diaphragm master/CR nodes are constraint-only — not structural elements)
    const connectedNodes = new Set();
    for (const e of model.elements.values()) {
      connectedNodes.add(e.n1); connectedNodes.add(e.n2);
    }
    for (const a of model.areas.values()) for (const n of a.nodes) connectedNodes.add(n);
    const diaphragmMasters = new Set(
      [...model.diaphragms.values()].map(d => d.masterId).filter(id => id != null)
    );
    const floating = [...model.nodes.keys()].filter(
      id => !connectedNodes.has(id) && !diaphragmMasters.has(id)
    );
    if (floating.length > 0) {
      const list = floating.slice(0, 5).join(', ') + (floating.length > 5 ? '…' : '');
      warnings.push(`⚠ ${floating.length} nodo(s) sin elements: [${list}]`);
    }

    // No supports
    const hasSupport = [...model.nodes.values()]
      .some(n => Object.values(n.restraints).some(v => v) ||
                 (n.springs && Object.values(n.springs).some(k => k > 0)));
    if (!hasSupport) warnings.push('⛔ No hay apoyos — el modelo es inestable');

    // Material / section properties (#robustez): invalid values produce Inf/NaN element
    // matrices that otherwise surface as a misleading "mechanism". Report them clearly.
    const hasPlaneStrain = [...model.areas.values()].some(a => a.planeStrain);
    for (const mat of model.materials.values()) {
      const lbl = `${i18n.t('Material')} "${mat.name || ('#' + mat.id)}"`;
      if (!(mat.E > 0)) warnings.push(`⛔ ${lbl}: ${i18n.t('el módulo E debe ser > 0')}`);
      if (!(mat.G > 0)) warnings.push(`⛔ ${lbl}: ${i18n.t('el módulo de corte G debe ser > 0')}`);
      if (mat.nu != null) {
        if (mat.nu < 0 || mat.nu > 0.5) warnings.push(`⛔ ${lbl}: ${i18n.t('el Poisson ν debe estar en [0, 0.5]')}`);
        else if (mat.nu >= 0.5 && hasPlaneStrain) warnings.push(`⛔ ${lbl}: ${i18n.t('ν=0.5 es singular en deformación plana (use ν<0.5)')}`);
      }
    }
    for (const sec of model.sections.values()) {
      const lbl = `${i18n.t('Sección')} "${sec.name || ('#' + sec.id)}"`;
      if (!(sec.A > 0))  warnings.push(`⛔ ${lbl}: ${i18n.t('el área A debe ser > 0')}`);
      if (!(sec.Iy > 0)) warnings.push(`⛔ ${lbl}: ${i18n.t('la inercia Iy debe ser > 0')}`);
      if (!(sec.Iz > 0)) warnings.push(`⛔ ${lbl}: ${i18n.t('la inercia Iz debe ser > 0')}`);
    }

    // Degenerate areas (collinear / zero-area): the assembler skips them (NaN-safe), but
    // a silently-dropped wall/slab gives wrong results — warn so the user knows.
    const degenAreas = [];
    for (const a of model.areas.values()) {
      const c = a.nodes.map(id => model.nodes.get(id));
      if (c.some(n => !n) || c.length < 3) continue;
      if (areaLocalFrame(c.map(n => [n.x, n.y, n.z])).degenerate) degenAreas.push(a.id);
    }
    if (degenAreas.length) {
      const list = degenAreas.slice(0, 5).join(', ') + (degenAreas.length > 5 ? '…' : '');
      warnings.push(`⚠ ${degenAreas.length} ${i18n.t('área(s) degenerada(s) (colineal/área cero), se ignoran:')} [${list}]`);
    }

    return warnings;
  }

  // ── Load case management ───────────────────────────────────────────────────
  _initLoadCaseUI() {
    this._activeLcId = ensureDefaultLC(this.model);
    this._activeResultKey = this._activeLcId;
    this._renderLcSelector();

    document.getElementById('lc-select')?.addEventListener('change', e => {
      const v = e.target.value;
      if (v.startsWith('C')) {
        // Combination: show it (from cache if present; otherwise analyze everything)
        this.runCombination(parseInt(v.slice(1)));
      } else {
        this._activeLcId = +v;
        this._activeResultKey = +v;
        if (this._resultsByCase?.has(+v)) {
          // Already solved in the full analysis — instant switch
          this._results = this._resultsByCase.get(+v);
          this._refreshResultView(true);
          this.refreshLoads();
          this.panel.renderStaticResults();
          this._precomputeDiagramsAsync(this._results);
        } else if (this._results) {
          this.runAnalysis();
        } else {
          this.refreshLoads();
        }
      }
    });

    document.getElementById('btn-add-lc')?.addEventListener('click', () => this.newCaseDialog());
    document.getElementById('btn-edit-lc')?.addEventListener('click', () => this.editCaseDialog());
    document.getElementById('btn-toggle-loads')?.addEventListener('click', () => {
      const vis = this.viewport.toggleLoads();
      const btn = document.getElementById('btn-toggle-loads');
      if (btn) { btn.style.color = vis ? 'var(--success)' : 'var(--text-muted)'; btn.textContent = vis ? '⬇ cargas' : '⬇ cargas (off)'; }
    });
  }

  // "+" dialog: create a load case (with optional self-weight) or a combination
  // Readable label of a load category (#106).
  _loadTypeLabel(lt) { return LOAD_TYPE_LABEL[lt] || LOAD_TYPE_LABEL.other; }
  // <option>s for the load-category selector, with `sel` marked.
  _loadTypeOptions(sel) { return LOAD_TYPES.map(([v, l]) => `<option value="${v}" ${v === sel ? 'selected' : ''}>${l}</option>`).join(''); }

  async newCaseDialog() {
    const overlay = document.getElementById('modal-overlay');
    const is2D = this.model.mode === '2D';
    document.getElementById('modal-title').textContent = i18n.t('Nuevo Caso / Combinación');
    document.getElementById('modal-body').innerHTML = `
      <div class="prop-row">
        <div class="prop-field"><label>Tipo</label>
          <select id="nc-type">
            <option value="case">Caso de carga estático</option>
            <option value="spectrum">Caso sísmico — espectro de respuesta</option>
            <option value="combo">Combinación</option>
          </select>
        </div>
        <div class="prop-field"><label>Nombre</label>
          <input type="text" id="nc-name" value="LC${this.model.loadCases.size + 1}">
        </div>
      </div>
      <label id="nc-sw-row" style="display:flex;align-items:center;gap:7px;margin-top:10px;cursor:pointer;font-size:12px;color:var(--text)">
        <input type="checkbox" id="nc-sw" style="accent-color:var(--accent)">
        Incluir peso propio de los elementos en este caso (típico de CM / carga muerta)
      </label>
      <div class="prop-field" id="nc-ltype-row" style="margin-top:10px">
        <label>Tipo de carga (para combinaciones y diseño automáticos)</label>
        <select id="nc-ltype" style="width:100%">${this._loadTypeOptions('other')}</select>
      </div>
      <div id="nc-dir-row" style="display:none;margin-top:10px">
        <div class="prop-field"><label>Dirección sísmica</label>
          <select id="nc-dir">
            <option value="X">X (E–O)</option>
            ${is2D ? '' : '<option value="Y">Y (N–S)</option>'}
          </select>
        </div>
        <p style="font-size:11px;color:var(--text-muted);margin-top:6px">
          Un caso espectral no admite cargas: se calcula con Análisis Modal (F6)
          + Espectro de Respuesta (F7), y su resultado (envolvente) queda
          asignado a este caso para verlo y combinarlo.</p>
      </div>`;
    document.getElementById('modal-cancel').style.display = '';
    overlay.classList.remove('hidden');
    // Self-weight only for static cases; direction only for spectral ones
    const typeSel = document.getElementById('nc-type');
    typeSel.addEventListener('change', () => {
      const t = typeSel.value;
      document.getElementById('nc-sw-row').style.display  = t === 'case' ? 'flex' : 'none';
      document.getElementById('nc-ltype-row').style.display = t === 'case' ? 'block' : 'none';
      document.getElementById('nc-dir-row').style.display = t === 'spectrum' ? 'block' : 'none';
      const nameInp = document.getElementById('nc-name');
      nameInp.value = t === 'combo'    ? `Combo ${this.model.combinations.size + 1}`
                    : t === 'spectrum' ? `Sismo ${document.getElementById('nc-dir')?.value || 'X'} (esp)`
                    : `LC${this.model.loadCases.size + 1}`;
    });
    document.getElementById('nc-dir')?.addEventListener('change', e => {
      if (typeSel.value === 'spectrum')
        document.getElementById('nc-name').value = `Sismo ${e.target.value} (esp)`;
    });
    setTimeout(() => { const el = document.getElementById('nc-name'); el?.focus(); el?.select(); }, 50);

    const ok = await new Promise(res => {
      overlay._resolve = res;
      overlay._reject  = () => res(false);
    });
    if (!ok) return;

    const type = document.getElementById('nc-type')?.value;
    const name = document.getElementById('nc-name')?.value?.trim();
    if (!name) return;
    this.snapshot();
    if (type === 'combo') {
      const combo = this.model.addCombination({ name, factors: [] });
      this.markDirty();
      this._renderLcSelector();
      this.openCombosTab();   // take the user to define the factors
      this.toast(`${i18n.t('Combinación')} "${combo.name}" ${i18n.t('creada — agregue factores')}`, 'ok');
    } else if (type === 'spectrum') {
      const dir = document.getElementById('nc-dir')?.value === 'Y' ? 'Y' : 'X';
      const lc = this.model.addLoadCase(name, false, 'spectrum', dir);
      this._activeLcId = lc.id;
      this._activeResultKey = lc.id;
      this.markDirty();
      this._renderLcSelector();
      this.refreshLoads();
      this.toast(`${i18n.t('Caso espectral')} "${lc.name}" (dir ${dir}) ${i18n.t('creado — ejecute F6 (modal) y F7 (espectro)')}`, 'ok');
    } else {
      const sw = document.getElementById('nc-sw')?.checked || false;
      const lt = document.getElementById('nc-ltype')?.value || (sw ? 'dead' : 'other');
      const lc = this.model.addLoadCase(name, sw, 'static', null, lt);
      this._activeLcId = lc.id;
      this._activeResultKey = lc.id;
      this.markDirty();
      this._renderLcSelector();
      this.refreshLoads();
    }
  }

  // ✎ dialog: edit the active load case (name, self-weight, delete)
  async editCaseDialog() {
    const lc = this.model.loadCases.get(this._activeLcId);
    if (!lc) { this.toast('No hay caso de carga activo', 'warn'); return; }
    const overlay = document.getElementById('modal-overlay');
    const isSpec = lc.type === 'spectrum';
    document.getElementById('modal-title').textContent = `${i18n.t('Editar Caso')} "${lc.name}"`;
    document.getElementById('modal-body').innerHTML = `
      <div class="prop-field"><label>Nombre</label>
        <input type="text" id="ec-name" value="${esc(lc.name)}" style="width:100%">
      </div>
      ${isSpec ? `
      <p style="font-size:11.5px;color:var(--teal);margin-top:10px">
        〜 Caso espectral — dirección sísmica <b>${lc.specDir}</b>.
        Se calcula con Análisis Modal (F6) + Espectro (F7); no admite cargas ni peso propio.
      </p>` : `
      <label style="display:flex;align-items:center;gap:7px;margin-top:10px;cursor:pointer;font-size:12px;color:var(--text)">
        <input type="checkbox" id="ec-sw" ${lc.selfWeight ? 'checked' : ''} style="accent-color:var(--accent)">
        Incluir peso propio de los elementos en este caso
      </label>
      <div class="prop-field" style="margin-top:10px">
        <label>Tipo de carga (para combinaciones y diseño automáticos)</label>
        <select id="ec-ltype" style="width:100%">${this._loadTypeOptions(lc.loadType || (lc.selfWeight ? 'dead' : 'other'))}</select>
      </div>`}
      ${this.model.loadCases.size > 1 ? `
      <button id="ec-del" class="btn-danger" style="width:100%;margin-top:14px">
        ${i18n.t('Eliminar este caso')}${isSpec ? '' : ` (${i18n.t('y sus')} ${lc.loads.length} ${i18n.t('carga(s)')})`}
      </button>` : ''}`;
    document.getElementById('modal-cancel').style.display = '';
    overlay.classList.remove('hidden');

    // Delete case: immediate action with confirmation
    document.getElementById('ec-del')?.addEventListener('click', async () => {
      overlay.classList.add('hidden');
      const sure = await this._confirm(`¿Eliminar el caso "${esc(lc.name)}" y todas sus cargas?`);
      if (!sure) return;
      this.snapshot();
      this.model.loadCases.delete(lc.id);
      // clear factors of combos that reference it
      for (const combo of this.model.combinations.values()) {
        combo.factors = combo.factors.filter(f => f.lcId !== lc.id);
      }
      this._activeLcId = this.model.loadCases.keys().next().value;
      this._activeResultKey = this._activeLcId;
      this.markDirty();
      this._renderLcSelector();
      this.refreshLoads();
      this.toast(`${i18n.t('Caso')} "${lc.name}" ${i18n.t('eliminado')}`, 'ok');
    });

    const ok = await new Promise(res => {
      overlay._resolve = res;
      overlay._reject  = () => res(false);
    });
    if (!ok) return;
    if (!this.model.loadCases.has(lc.id)) return;   // it was deleted
    this.snapshot();
    lc.name = document.getElementById('ec-name')?.value?.trim() || lc.name;
    if (!isSpec) {
      lc.selfWeight = document.getElementById('ec-sw')?.checked || false;
      const lt = document.getElementById('ec-ltype')?.value; if (lt) lc.loadType = lt;
    }
    this.markDirty();
    this._renderLcSelector();
    this.toast(`${i18n.t('Caso')} "${lc.name}" ${i18n.t('actualizado')}`, 'ok');
  }

  _renderLcSelector() {
    const sel = document.getElementById('lc-select');
    if (!sel) return;
    sel.innerHTML = '';
    const activeKey = this._activeResultKey ?? this._activeLcId;
    for (const lc of this.model.loadCases.values()) {
      const opt = document.createElement('option');
      opt.value = lc.id;
      opt.textContent = lc.type === 'spectrum'
        ? `〜 ${lc.name} [esp ${lc.specDir}]`
        : lc.name + (lc.selfWeight ? ' ⊕PP' : '');
      opt.selected = lc.id === activeKey;
      sel.appendChild(opt);
    }
    if (this.model.combinations.size > 0) {
      const grp = document.createElement('optgroup');
      grp.label = '── Combos ──';
      for (const c of this.model.combinations.values()) {
        const opt = document.createElement('option');
        opt.value = 'C' + c.id;
        opt.textContent = 'Σ ' + c.name;
        opt.selected = ('C' + c.id) === activeKey;
        grp.appendChild(opt);
      }
      sel.appendChild(grp);
    }
    // Keep the case list of the «Cases and combos» panel in sync.
    this.panel?.renderLoadCases?.();
  }

  // ── Panel resize handle ────────────────────────────────────────────────────
  _initResizeHandle() {
    const handle = document.getElementById('panel-resize-handle');
    const main   = document.getElementById('main');
    if (!handle || !main) return;
    let dragging = false, startX = 0, startW = 0;
    handle.addEventListener('mousedown', e => {
      dragging = true;
      startX = e.clientX;
      startW = document.getElementById('panel').offsetWidth;
      handle.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      const newW = Math.max(220, Math.min(700, startW + (startX - e.clientX)));
      // Only the PANEL WIDTH changes via the CSS variable --panel-w; this way the
      // 5-column grid (incl. the side tree's) is built by CSS and doesn't break when
      // dragging or opening/closing the tree (before, an inline 4-column grid was set).
      main.style.setProperty('--panel-w', newW + 'px');
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    });
  }

  _initMobilePanel() {
    const btn   = document.getElementById('panel-toggle-btn');
    const scrim = document.getElementById('panel-scrim');
    const panel = document.getElementById('panel');
    if (!btn || !scrim || !panel) return;
    const open  = () => { panel.classList.add('mobile-open');    scrim.classList.add('visible');    btn.classList.add('active'); };
    const close = () => { panel.classList.remove('mobile-open'); scrim.classList.remove('visible'); btn.classList.remove('active'); };
    btn.addEventListener('click',   () => panel.classList.contains('mobile-open') ? close() : open());
    scrim.addEventListener('click', close);
  }

  // ── Load combinations ──────────────────────────────────────────────────────
  // View a combination: if the full analysis already ran, shows the cached
  // result; otherwise runs the full analysis (which solves everything).
  runCombination(comboId) {
    const combo = this.model.combinations.get(comboId);
    if (!combo || combo.factors.length === 0) {
      this.toast('Combinación vacía — agregue al menos un factor', 'warn'); return;
    }
    this._activeResultKey = 'C' + comboId;
    const cached = this._resultsByCase?.get('C' + comboId);
    if (cached) {
      this._results = cached;
      this.toast(`"${combo.name}" | δmax=${cached.getMaxDisp().toExponential(2)}`, 'ok');
      document.getElementById('result-type').value = 'deformed';
      this._refreshResultView(true);
      this.panel._switchVTab('results');
      this.panel._switchRTab('estatico');
      this.panel.renderStaticResults();
      this._renderLcSelector();
    } else {
      this.runAnalysis();   // solves all cases and combos, and shows this one
    }
  }

  // Opens the combinations tab (accessible from the Analysis menu / F8)
  openCombosTab() {
    this.panel._switchVTab('model');
    this.panel._switchTab('cargas');   // → renderLoadCases + renderCombinations
  }

  // Creates the base load cases (D, L) and the default code combinations
  // (NCh3171 / LRFD). The seismic ones are added per direction if spectral
  // cases exist (X/Y). All are EDITABLE in the Combos tab.
  createCodeCasesAndCombos() {
    const m = this.model;
    this.snapshot();
    // Identify cases by their CATEGORY (#106); as a fallback, by self-weight / name.
    const byType = lt => [...m.loadCases.values()].find(l => l.type === 'static' && l.loadType === lt);
    const findLC = re => [...m.loadCases.values()].find(l => l.type === 'static' && re.test(l.name));
    let D = byType('dead') || [...m.loadCases.values()].find(l => l.type === 'static' && l.selfWeight) || findLC(/muerta|dead|peso propio|\bpp\b|\bd\b/i);
    if (!D) D = m.addLoadCase('D — Dead load (SW)', true, 'static', null, 'dead');
    let L = byType('live') || findLC(/viva|sobrecarga|live|uso|\bl\b/i);
    if (!L) L = m.addLoadCase('L — Live load', false, 'static', null, 'live');

    const specs = [...m.loadCases.values()].filter(l => l.type === 'spectrum');
    const ex = specs.find(s => s.specDir === 'X'), ey = specs.find(s => s.specDir === 'Y');

    const combos = [
      // ── Ultimate strength (LRFD) ───────────────────────────────────────────
      { name: '1.4D', f: [[D, 1.4]] },
      { name: '1.2D + 1.6L', f: [[D, 1.2], [L, 1.6]] },
      // ── Service / allowable stress (ASD, NCh3171·ASCE-7) ───────────────────
      { name: 'D (servicio)', f: [[D, 1.0]] },
      { name: 'D + L (servicio)', f: [[D, 1.0], [L, 1.0]] },
    ];
    const seismic = (E, d) => {
      // Ultimate strength (LRFD)
      combos.push({ name: `1.2D + 1.0L + 1.4E${d}`, f: [[D, 1.2], [L, 1.0], [E, 1.4]] });
      combos.push({ name: `1.2D + 1.0L − 1.4E${d}`, f: [[D, 1.2], [L, 1.0], [E, -1.4]] });
      combos.push({ name: `0.9D + 1.4E${d}`, f: [[D, 0.9], [E, 1.4]] });
      combos.push({ name: `0.9D − 1.4E${d}`, f: [[D, 0.9], [E, -1.4]] });
      // Allowable stress (ASD): E reduced by 0.7
      combos.push({ name: `D + 0.7E${d} (servicio)`, f: [[D, 1.0], [E, 0.7]] });
      combos.push({ name: `D − 0.7E${d} (servicio)`, f: [[D, 1.0], [E, -0.7]] });
      combos.push({ name: `D + 0.75L + 0.525E${d} (servicio)`, f: [[D, 1.0], [L, 0.75], [E, 0.525]] });
      combos.push({ name: `D + 0.75L − 0.525E${d} (servicio)`, f: [[D, 1.0], [L, 0.75], [E, -0.525]] });
      combos.push({ name: `0.6D + 0.7E${d} (servicio)`, f: [[D, 0.6], [E, 0.7]] });
      combos.push({ name: `0.6D − 0.7E${d} (servicio)`, f: [[D, 0.6], [E, -0.7]] });
    };
    if (ex) seismic(ex, 'x');
    if (ey) seismic(ey, 'y');

    const exist = new Set([...m.combinations.values()].map(c => c.name));
    let n = 0;
    for (const c of combos) {
      if (exist.has(c.name)) continue;
      m.addCombination({ name: c.name, factors: c.f.map(([lc, factor]) => ({ lcId: lc.id, factor })) });
      n++;
    }
    this.markDirty(); this._updateStats?.(); this.refreshLoads?.();
    this.panel.renderCombinations?.(); this._renderLcSelector?.();
    const note = (ex || ey) ? '' : ' · las sísmicas se añaden al correr el espectro X/Y';
    this.toast(`${i18n.t('Norma NCh3171: casos D/L +')} ${n} ${i18n.t('combinación(es) LRFD y servicio')}${note}`, 'ok');
    this.openCombosTab();
  }

  async runCombinationDialog() {
    if (this.model.combinations.size === 0) {
      this.toast('No hay combinaciones — créelas en la pestaña Combos.', 'warn'); return;
    }
    if (this.model.combinations.size === 1) {
      this.runCombination([...this.model.combinations.keys()][0]); return;
    }
    const opts = [...this.model.combinations.values()]
      .map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = i18n.t('Ejecutar Combinación');
    document.getElementById('modal-body').innerHTML =
      `<div class="prop-field"><label>Combinación</label><select id="combo-pick">${opts}</select></div>`;
    document.getElementById('modal-cancel').style.display = '';
    overlay.classList.remove('hidden');
    const ok = await new Promise(res => {
      overlay._resolve = res;
      overlay._reject  = () => res(false);
    });
    if (!ok) return;
    this.runCombination(+document.getElementById('combo-pick').value);
  }

  // ── File I/O ───────────────────────────────────────────────────────────────
  async newFile() {
    if (this._dirty) {
      const ok = await this._confirm('¿Descartar cambios no guardados y crear un nuevo modelo?');
      if (!ok) return;
    }
    // The 2D/3D mode is chosen WHEN CREATING the model and isn't changed afterward:
    // it defines how it's modeled (plane vs space) and which DOFs participate.
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = i18n.t('Nuevo Modelo');
    document.getElementById('modal-body').innerHTML = `
      <div class="prop-field"><label>Tipo de modelo</label>
        <select id="nm-mode" style="width:100%">
          <option value="3D">Estructura 3D (espacial)</option>
          <option value="2D">Pórtico 2D — plano X–Z (vista ortográfica real)</option>
        </select>
      </div>
      <p style="font-size:11px;color:var(--text-muted);margin-top:8px">
        <b>2D:</b> se modela en un plano sin profundidad (cámara ortográfica fija);
        los GDL fuera del plano (uy, rx, rz) se restringen automáticamente y el
        análisis es plano. <b>El modo no puede cambiarse después.</b></p>`;
    document.getElementById('modal-cancel').style.display = '';
    overlay.classList.remove('hidden');
    const ok2 = await new Promise(res => {
      overlay._resolve = res;
      overlay._reject  = () => res(false);
    });
    if (!ok2) return;
    const mode = document.getElementById('nm-mode')?.value === '2D' ? '2D' : '3D';

    this.model = new Model();
    this.model.mode = mode;
    // G7: new model → single-model project.
    this._project = { models: [{ id: 1, name: 'Modelo 1', json: null }], activeId: 1, nextId: 2 };
    this._renderProjectSelector();
    this.viewport._elevation = null;
    this.undoStack.clear();
    this._fileHandle = null;
    this._filePath   = null;
    this._dirty = false;
    this._results = null;
    this._resultsByCase = null;
    this._discardResultsCache();   // new model → previous results don't apply
    this._activeLcId = ensureDefaultLC(this.model);
    this._activeResultKey = this._activeLcId;
    this._renderLcSelector();
    this.refreshLoads();
    this.viewport.renderModel(this.model);
    this.viewport.applyProjectMode();
    this.panel.showNothing();
    this._updateStats();
    this._updateTitle();
    this.toast(`${i18n.t('Nuevo modelo')} ${mode} ${i18n.t('creado')}`, 'ok');
  }

  async openFile() {
    if (this._dirty) {
      const ok = await this._confirm('¿Descartar cambios no guardados?');
      if (!ok) return;
    }
    try {
      if (window.electronAPI) {
        const result = await window.electronAPI.openFile();
        if (!result) return;
        this._filePath   = result.filePath;
        this._fileHandle = null;
        this._loadJSON(result.content, result.filePath.split(/[\\/]/).pop());
      } else if ('showOpenFilePicker' in window) {
        const [handle] = await window.showOpenFilePicker({
          types: [{ description: 'PORTICO (.s3d)', accept: { 'application/json': ['.s3d', '.json'] } }]
        });
        const text = await (await handle.getFile()).text();
        this._fileHandle = handle;
        this._filePath   = null;
        this._loadJSON(text, handle.name);
      } else {
        this._fallbackOpen();
      }
    } catch (err) {
      if (err.name !== 'AbortError') this.toast(`${i18n.t('Error al abrir:')} ${err.message}`, 'error');
    }
  }

  _fallbackOpen() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.s3d,.json';
    inp.onchange = async () => {
      const text = await inp.files[0].text();
      this._loadJSON(text, inp.files[0].name);
    };
    inp.click();
  }

  _loadJSON(text, filename, keepResults = false, keepProject = false) {
    try {
      let parsed = null;
      try { parsed = JSON.parse(text); } catch {}
      // G7: PROJECT file (multiple models) → dedicated path.
      if (!keepProject && parsed && parsed.portico_project) { this._loadProjectJSON(parsed, filename); return; }
      this.model = this.serializer.fromJSON(text);
      // Groups and hidden elements saved in the file (view state).
      this._grupos = new Map((parsed && Array.isArray(parsed.groups) ? parsed.groups : [])
        .map((g) => [g.name, new Set((g.elems || []).filter((id) => this.model.elements.has(id)))]));
      this.viewport.clearHidden();
      if (parsed && Array.isArray(parsed.ocultos))
        this.viewport._hiddenElems = new Set(parsed.ocultos.filter((id) => this.model.elements.has(id)));
      this.viewport._elevation = null;          // elevation is per session
      this._refreshDiaphragmCRs();   // P1-2: fix stale CR/masterId from saved files
      this.undoStack.clear();
      this._dirty = false;
      this.viewport.renderModel(this.model);
      this.panel.showNothing();
      this.panel.refresh(this.model);
      // Clear the previous model's analysis state so it doesn't carry over
      // (an old `_predisc` could revert to ANOTHER model when clearing — #42).
      this._predisc = null;
      this._buckResult = null;
      this._plasticResult = null;
      this._dcResult = null;
      this._nlResult = null;
      this._pdResult = null;
      this._thResult = null;
      this._stagedResult = null;
      this._movingResult = null;
      this._nlthResult = null;
      this._thStopPlay?.();
      this._nlthStopPlay?.();
      this._dcStopPlay?.();
      this._nlStopPlay?.();
      this._thRenderPanel?.();   // #90: empty the «Dynamic» tab when loading another model
      this._dcRenderPanel?.();   // #90: same for «Pushover»
      this._buckRenderPanel?.(); // #90: same for «Buckling»
      this._nlRenderPanel?.();   // #90: same for «Nonlinear»
      this._movingRenderPanel?.(); // #90: same for «Moving loads»
      this._nlthRenderPanel?.(); // #90: same for «NL dynamic»
      if (!keepResults) { this._modalResults = null; this._spectrumResults.clear(); }
      this._results = null;
      this._resultsByCase = null;
      this._activeLcId = ensureDefaultLC(this.model);
      this._activeResultKey = this._activeLcId;
      // Restore the run parameters saved in the file (#39). Done BEFORE adopting
      // embedded results, which re-align the auto-disc.
      this._applyAnalysisParams(this.model.analysisParams);
      // Results embedded in the file → adopt them (stays "already run").
      // If none, discard the cache except in session recovery / example,
      // where the signature will decide later whether the saved results are usable.
      if (parsed && parsed.results) {
        this._adoptEmbeddedResults(parsed.results);
      } else if (!keepResults) {
        this._discardResultsCache();
      }
      this._renderLcSelector();
      this.refreshLoads();
      this._updateStats();
      this._updateTitle(filename);
      // G7: opening a SIMPLE file resets the project to a single model; a switch/
      // project load keeps the list (keepProject).
      if (!keepProject) { this._project = { models: [{ id: 1, name: this._modelName || filename || 'Modelo 1', json: null }], activeId: 1, nextId: 2 }; }
      this._renderProjectSelector();
      this.viewport.applyProjectMode();   // camera/inputs per 2D/3D mode
      if (this.model.mode !== '2D') this.viewport.zoomExtents();
      this.toast(`${i18n.t('Modelo cargado:')} ${filename}${this.model.mode === '2D' ? ' (2D)' : ''}`, 'ok');
      // Sync unit selector
      document.getElementById('unit-select').value = this.model.units || 'kN-m';
      document.getElementById('sb-units').textContent = (this.model.units || 'kN-m').replace('-', ' — ');
    } catch (err) {
      this.toast(`${i18n.t('Error al cargar archivo:')} ${err.message}`, 'error');
    }
  }

  // ── Assistant: spec → deterministic generator → model ───────────────────
  // Example text for the generation assistant (same as the placeholder).
  get _ASIS_EJEMPLO() {
    return 'edificio de 4 niveles de 3 m, planta con 3 vanos de 6 m en X y 2 de 5 m en Y, hormigón G30, vigas 25x50, pilares 35x35, salas de clases, en Valdivia, con sismo zona 2 suelo D';
  }

  // Lets you TRY the assistant textbox's example with the keyboard: when the
  // textarea is EMPTY (showing the example placeholder), **Tab** fills it with the
  // example and **Enter** fills it and RUNS it immediately. `runFn(text)` runs the
  // generation. With text typed in, Enter does a normal line break.
  _wireAsisExample(taId, runFn) {
    const ta = document.getElementById(taId); if (!ta) return;
    ta.addEventListener('keydown', (e) => {
      if (ta.value.trim() !== '') return;            // only when empty (example)
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault(); ta.value = this._ASIS_EJEMPLO;
        ta.setSelectionRange(ta.value.length, ta.value.length);
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault(); ta.value = this._ASIS_EJEMPLO; runFn(this._ASIS_EJEMPLO);
      }
    });
  }

  assistantDialog() {
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = i18n.t('Asistente — generar modelo desde ficha');
    document.getElementById('modal-box')?.classList.add('modal-wide');
    document.getElementById('modal-cancel').style.display = '';
    const okBtn = document.getElementById('modal-ok');
    okBtn.textContent = 'Generar modelo';

    const ep = localStorage.getItem('portico_n8n_endpoint') || '';
    const plantilla = JSON.stringify({
      project: 'Example building', mode: '3D',
      location: { city: 'Example City', latitude_deg: 39.8, altitude_masl: 10, exposure: 'C' },
      geometry: {
        levels: [
          { height_m: 3, use_class: 'School' },
          { height_m: 5, use_class: 'Light storage' }
        ],
        spans_x: { count: 4, span_m: 3 },
        spans_y: [5, 5]
      },
      sections: { material: 'S275', beams: 'IPE300', columns: 'HEB200' },
      base_support: 'fixed', rigid_diaphragm: true,
      loads: { dead_extra_kN_m2: 1.5, seismic: true }
    }, null, 2);

    document.getElementById('modal-body').innerHTML = `
<div class="prop-field">
  <label>Describe el modelo en palabras (el asistente arma la ficha)</label>
  <textarea id="asis-nl" rows="4" class="sp-textarea" placeholder="Ej.: edificio de 4 niveles de 3 m, planta con 3 vanos de 6 m en X y 2 de 5 m en Y, hormigón G30, vigas 25x50, pilares 35x35, salas de clases, en Valdivia, con sismo zona 2 suelo D"></textarea>
  <small style="color:var(--text-muted);display:block;margin-top:3px">💡 Vacío: <b>Tab</b> rellena el ejemplo · <b>Enter</b> lo ejecuta (para probar de inmediato).</small>
</div>
<div class="prop-row" style="margin-top:6px;align-items:end">
  <div class="prop-field" style="flex:1"><label>Endpoint del asistente LLM (conecta tu propio servicio)</label>
    <input type="text" id="asis-endpoint" value="${ep}" placeholder="https://your-worker.example.com/api/assistant"></div>
  <button type="button" id="btn-asis-llm" class="btn-primary" style="margin-left:8px">✦ Pedir ficha al asistente</button>
</div>
<small style="color:var(--text-muted);display:block;margin-top:4px">El asistente IA requiere que conectes tu propio endpoint LLM (p.ej. un Cloudflare Worker con tu API key como secreto del servidor, nunca en el navegador). Sin endpoint, usa el generador determinista pegando una ficha JSON abajo. Luego pulsa <b>Generar modelo</b>.</small>

<details style="margin-top:12px">
  <summary style="cursor:pointer;color:var(--accent)">Ver / editar la ficha (JSON) — avanzado</summary>
  <div class="prop-field" style="margin-top:8px">
    <textarea id="asis-spec" rows="14" class="sp-textarea" style="font-family:monospace;font-size:12px">${plantilla}</textarea>
    <small style="color:var(--text-muted);display:block;margin-top:4px">El generador determinista construye el modelo (geometría, secciones, cargas NCh, combinaciones) y reemplaza el modelo actual. Si falta o no se reconoce algún dato, se sustituye/estima y se informa.</small>
  </div>
</details>`;

    // Keyboard-runnable example: Tab fills it, Enter requests the spec from the assistant.
    this._wireAsisExample('asis-nl', () => document.getElementById('btn-asis-llm')?.click());

    document.getElementById('btn-asis-llm')?.addEventListener('click', async () => {
      const url = document.getElementById('asis-endpoint').value.trim();
      const msg = document.getElementById('asis-nl').value.trim();
      if (!url) { this.toast('Configure el endpoint del asistente', 'warn'); return; }
      if (!msg) { this.toast('Escriba una descripción', 'warn'); return; }
      localStorage.setItem('portico_n8n_endpoint', url);
      this._showProgress('Consultando al asistente…', 'Puede tardar varios segundos');
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: msg }) });
        const data = await r.json().catch(() => ({}));   // the server sends { error } even on failure
        if (!r.ok) throw new Error(data.error || data.message || `HTTP ${r.status}`);
        const spec = data.spec ?? data;
        this._lastAsisLogId = data._logId || null;   // for feedback after generating
        const ta = document.getElementById('asis-spec');
        if (ta) { ta.value = JSON.stringify(spec, null, 2); ta.closest('details')?.setAttribute('open', ''); }
        this.toast('Ficha recibida — pulsa «Generar modelo»', 'ok');
      } catch (e) { this.toast(i18n.t('Error asistente:') + ' ' + e.message, 'error'); }
      finally { this._hideProgress(); }
    });

    const restore = () => { okBtn.textContent = 'Aceptar'; };
    overlay.classList.remove('hidden');
    overlay._resolve = () => { restore(); this._generateFromSpec(document.getElementById('asis-spec').value); };
    overlay._reject = restore;
  }

  /** Requests the spec from the assistant (endpoint) from a text and generates the model.
   *  Used by the cover-page box and reusable from anywhere. */
  async assistantFromText(message) {
    const url = localStorage.getItem('portico_n8n_endpoint') || '';
    if (!url) { this.toast('Configura tu endpoint LLM en el diálogo del asistente (Asistente → endpoint).', 'warn'); return; }
    this._showProgress('Consultando al asistente…', 'Interpretando tu descripción');
    let spec = null;
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message }) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || data.message || `HTTP ${r.status}`);
      spec = data.spec ?? data;
      this._lastAsisLogId = data._logId || null;   // for feedback after generating
      // The model that generated the spec is reported in the console (not on screen).
      if (data._llm) {
        console.info(`[asistente] proveedor: ${data._llm.proveedor} · modelo: ${data._llm.modelo}`);
        if (data._llm.intentos && data._llm.intentos.length) console.info('[asistente] cascada (intentos fallidos antes del exitoso):', data._llm.intentos);
      }
      if (data._rag) {
        console.info(`[asistente] RAG: ${data._rag.usados.length} ejemplo(s) usados (score ${data._rag.score})`, data._rag.usados);
        if (data._rag.novedoso) console.info('[asistente] pedido NOVEDOSO (sin ejemplo parecido): candidato para agregar a assistant/examples.json en la revisión semanal.');
      }
    } catch (e) {
      this._hideProgress();
      this.toast(i18n.t('Error asistente:') + ' ' + e.message, 'error');
      return;
    }
    await this._generateFromSpec(JSON.stringify(spec));
  }

  /** Modifies the ALREADY-BUILT model from a natural-language command.
   *  The assistant (Worker/LLM) translates the command into structured OPERATIONS;
   *  `applyModelOperations` (deterministic) executes them. */
  async modifyModelFromText(message) {
    if (!message || !message.trim()) { this.toast('Escribe qué cambiar en el modelo', 'warn'); return; }
    if (this.model.nodes.size === 0) { this.toast('No hay modelo que modificar (créalo primero)', 'warn'); return; }
    const base = localStorage.getItem('portico_n8n_endpoint') || '';
    if (!base) { this.toast('Configura tu endpoint LLM en el diálogo del asistente.', 'warn'); return; }
    const url  = base.replace(/\/+$/, '') + '/modificar';
    const sel  = this.viewport.getSelected();
    const ctx  = {
      selection:     sel.filter(s => s.type === 'elem').map(s => s.id),
      selectedNodes: sel.filter(s => s.type === 'node').map(s => s.id),
    };
    this._showProgress('Consultando al asistente…', 'Interpretando la modificación');
    let ops = null;
    try {
      const summary = this._modelSummary();
      // Send English keys (canonical) + Spanish ones (compat) so either worker version works.
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, model: summary, selection: ctx }) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || data.message || `HTTP ${r.status}`);
      ops = data.ops || data.operaciones || (Array.isArray(data) ? data : null);
      if (data._llm) console.info(`[asistente·modificar] ${data._llm.proveedor} · ${data._llm.modelo}`);
    } catch (e) {
      this._hideProgress();
      this.toast(i18n.t('Error asistente:') + ' ' + e.message, 'error');
      return;
    }
    this._hideProgress();
    await this.applyModelOperations(ops, ctx);
  }

  /** Applies a list of operations (from the assistant, or manual) to the model and
   *  refreshes the view. Reusable; verifiable without a server. */
  async applyModelOperations(ops, ctx = null) {
    if (!ctx) {
      const sel = this.viewport.getSelected();
      ctx = { selection: sel.filter(s => s.type === 'elem').map(s => s.id),
              selectedNodes: sel.filter(s => s.type === 'node').map(s => s.id) };
    }
    this.snapshot();
    const { applyOperations } = await import('./model/model_ops.js?v=2');
    const res = applyOperations(this.model, ops, ctx);
    // previous results are no longer valid after modifying the geometry/loads
    this.viewport.clearResults?.();
    this._results = null; this._resultsByCase = null; this._discardResultsCache?.();
    this.viewport.renderModel(this.model);
    this.panel.refresh?.(this.model);
    this._renderLcSelector?.();
    this.refreshLoads?.();
    this._updateStats?.();
    this.markDirty();
    if (this.model.mode !== '2D') this.viewport.zoomExtents?.();
    if (res.resumen.length) this.toast(res.resumen.join(' · '), 'ok');
    if (res.avisos.length)  this._showWarnings?.(res.avisos.map(m => ({ type: 'aviso', msg: m })));
    return res;
  }

  /** Compact model summary to give context to the assistant (without dumping everything). */
  _modelSummary() {
    const ns = [...this.model.nodes.values()];
    if (!ns.length) return { nodos: 0 };
    const xs = ns.map(n => n.x), ys = ns.map(n => n.y), zs = ns.map(n => n.z);
    const uniq = a => [...new Set(a.map(v => +v.toFixed(3)))].sort((p, q) => p - q);
    return {
      nodos: this.model.nodes.size, elements: this.model.elements.size, areas: this.model.areas.size,
      bbox: { x: [Math.min(...xs), Math.max(...xs)], y: [Math.min(...ys), Math.max(...ys)], z: [Math.min(...zs), Math.max(...zs)] },
      niveles_z: uniq(zs), ejes_x: uniq(xs), ejes_y: uniq(ys),
      casos: [...this.model.loadCases.values()].map(l => l.name),
      secciones: [...this.model.sections.values()].map(s => s.name),
      unidades: this.model.units,
    };
  }

  async _generateFromSpec(specText) {
    let spec;
    try { spec = JSON.parse(specText); }
    catch (e) { this.toast(i18n.t('Ficha JSON inválida:') + ' ' + e.message, 'error'); return; }

    // If there's already a model, ask what to do: overlay / new / cancel.
    let modo = 'nueva';
    if (this.model.nodes.size > 0) {
      modo = await this._existingModelDialog();
      if (modo === 'cancelar') return;
    }

    this._showProgress('Generando el modelo…', 'Aplicando reglas y cargas normativas');
    try {
      const libs = await this._loadAssistantLibraries();
      const { generateModel } = await import('../assistant/generator.js?v=2');
      const modelo = generateModel(spec, libs);

      if (modo === 'sobreponer') {
        const src = this.serializer.fromJSON(JSON.stringify(modelo));
        const modoMix = src.mode !== this.model.mode;
        const { welded } = this._mergeGeneratedInto(src);
        this.viewport.clearResults();
        this._results = null; this._resultsByCase = null;
        this._discardResultsCache?.();
        this.viewport.renderModel(this.model);
        this.panel.showNothing();
        this.panel.refresh(this.model);
        this._renderLcSelector();
        this.refreshLoads();
        this._updateStats();
        this.markDirty();
        if (this.model.mode !== '2D') this.viewport.zoomExtents();
        this.toast(`${i18n.t('Estructura sobrepuesta —')} ${welded} ${i18n.t('nodo(s) coincidente(s) fundido(s)')}`, 'ok');
        if (modoMix) this.toast(`${i18n.t('Aviso: el modelo generado era')} ${src.mode} ${i18n.t('y el actual es')} ${this.model.mode}; ${i18n.t('se conservó')} ${this.model.mode}`, 'warn');
      } else {
        this._loadJSON(JSON.stringify(modelo), (spec.project || 'assistant') + '.s3d');
        this.markDirty();
        this.toast(`${i18n.t('Modelo generado —')} ${modelo._generado?.resumen || ''}`, 'ok');
      }
      this._showWarnings(modelo._warnings || []);
      // Feedback: if this generation came from an assistant query, offer to mark
      // it as "not what I asked for" (feeds the weekly review).
      const fid = this._lastAsisLogId; this._lastAsisLogId = null;
      if (fid) this._offerAssistantFeedback(fid);
    } catch (e) {
      this.toast(i18n.t('Error al generar:') + ' ' + e.message, 'error');
      console.error(e);
    } finally { this._hideProgress(); }
  }

  /** Feedback bar after generating from the assistant: ✓ Yes / ✗ Not what I asked for.
   *  The "no" sends POST /api/assistant/feedback marking the record as incorrect. */
  _offerAssistantFeedback(logId) {
    if (!logId) return;
    document.getElementById('asis-feedback')?.remove();
    const el = document.createElement('div');
    el.id = 'asis-feedback';
    el.style.cssText = 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:100001;background:var(--bg-elev,#141b27);border:1px solid var(--border,#334);border-radius:10px;padding:10px 14px;display:flex;align-items:center;gap:10px;box-shadow:0 8px 30px rgba(0,0,0,.45);font-size:13px;color:var(--text,#e6edf3)';
    el.innerHTML = `
      <span>¿El modelo es lo que pediste?</span>
      <button id="afb-yes" style="border:1px solid var(--success,#15803d);background:transparent;color:var(--success,#15803d);border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px">✓ Sí</button>
      <button id="afb-no" style="border:1px solid var(--danger,#dc2626);background:transparent;color:var(--danger,#dc2626);border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px">✗ No era lo que pedí</button>`;
    document.body.appendChild(el);
    const close = () => el.remove();
    const timer = setTimeout(close, 15000);
    el.querySelector('#afb-yes').onclick = () => { clearTimeout(timer); close(); };
    el.querySelector('#afb-no').onclick = async () => {
      clearTimeout(timer); close();
      const comentario = await this._promptModal('Feedback del asistente', '¿Qué esperabas? (opcional, ayuda a mejorar)', '');
      try {
        const base = localStorage.getItem('portico_n8n_endpoint') || '';
        if (!base) return;   // with no endpoint configured there's no backend to report to
        const r = await fetch(base + '/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: logId, comentario: comentario || null }) });
        if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || `HTTP ${r.status}`); }
        this.toast('Gracias — registrado como «no era lo solicitado»', 'ok');
      } catch (e) { this.toast(i18n.t('No se pudo enviar el feedback:') + ' ' + e.message, 'warn'); }
    };
  }

  // ── Application configuration (persisted in localStorage) ───────────────────
  _defaultConfig() {
    return {
      report: {
        titulo: 'Memoria de Cálculo',
        kicker: 'ANÁLISIS Y DISEÑO ESTRUCTURAL',
        institucion: '',
        subInstitucion: '',
        proyectista: '',
        revisor: '',
        descripcion: '',       // PRO
        footer: '',            // PRO (empty = default academic footer)
        limitaciones: '',      // PRO (empty = default academic limitations)
        logoEmpresa: '',       // PRO (data URL of the company logo)
        mostrarIds: true,      // show node/element IDs in the figures
        modosVisibles: true,   // amplify the mode shapes so they're noticeable
      },
      analisis: { motor: 'normal', shellTipos: [], matrizDensa: false, nlLite: false },   // matrizDensa: false = banded solver (fast); true = dense (academic). nlLite: geometric nonlinear analysis (no token). motor/area: PRO.
      seccion_mod_default: { A: 1, Iy: 1, Iz: 1, J: 1 },
    };
  }

  // Footer and limitations of the ACADEMIC VERSION (not editable without a token).
  get _ACAD_FOOTER() { return i18n.t('Generado con PORTICO — no sustituye la revisión de un profesional competente'); }
  get _ACAD_LIMITS() {
    return [
      i18n.t('Documento generado automáticamente por PORTICO con carácter <b>orientativo</b>; no reemplaza el criterio ni la firma de un profesional competente.'),
      i18n.t('La verificación de diseño usa propiedades de sección (A, I) y parámetros normativos estándar (Fy, f′c, φ, cuantía); el hormigón armado se evalúa con la cuantía indicada y supuestos declarados.'),
      i18n.t('La verificación de <b>resistencia</b> cubre flexión, corte, axial e interacción flexo-axial (AISC H1 / NDS) por envolvente de combinaciones. La de <b>servicio</b> cubre la flecha de vigas bajo sobrecarga de uso sin mayorar y las derivas de entrepiso (NCh433, límite 2/1000·h, entre centros de masa y entre nodos externos). NO incluye diseño de uniones, fundaciones, pandeo lateral-torsional ni clasificación de perfiles. Los efectos P-Δ y el pandeo global (factor crítico λcr) se evalúan aparte con NL-lite (no se incorporan automáticamente a las razones D/C).'),
      i18n.t('Las cargas de viento, nieve y sobrecargas se representan como casos de carga; verifique su clasificación y magnitud según la normativa aplicable.'),
    ];
  }
  _loadConfig() {
    const def = this._defaultConfig();
    try {
      const raw = JSON.parse(localStorage.getItem('portico_config') || '{}');
      return {
        report: { ...def.report, ...(raw.report || {}) },
        analisis: { ...def.analisis, ...(raw.analisis || {}) },
        seccion_mod_default: { ...def.seccion_mod_default, ...(raw.seccion_mod_default || {}) },
      };
    } catch { return def; }
  }
  _saveConfig() { try { localStorage.setItem('portico_config', JSON.stringify(this._config)); } catch (e) {} }

  // ── PER-PROJECT report (#41) ────────────────────────────────────────────────
  // Header/report fields that travel with the model (in the .s3d). The company
  // logo does NOT: it's firm branding, the same across all projects → global.
  static get _MEMORIA_PROJ_KEYS() {
    return ['titulo','kicker','institucion','subInstitucion','proyectista','revisor',
            'descripcion','footer','limitaciones','mostrarIds','modosVisibles'];
  }
  // EFFECTIVE report: global defaults (config) overridden by the model's.
  // Compatible with old files (model.report == null → config only).
  _report() {
    return { ...this._config.report, ...(this.model?.report || {}) };
  }
  // Per-project subset of the effective report (to save in the .s3d).
  _projectReport() {
    const eff = this._report(), out = {};
    for (const k of App._MEMORIA_PROJ_KEYS) if (eff[k] !== undefined) out[k] = eff[k];
    return out;
  }

  // ── Run parameters (#39) ────────────────────────────────────────────────────
  // Gathers the parameters the analyses run with, to save them in the .s3d.
  _gatherAnalysisParams() {
    return {
      autoDisc:    !!document.getElementById('auto-disc')?.checked,
      autoDiscN:   Math.max(2, Math.round(parseFloat(document.getElementById('auto-disc-n')?.value) || 5)),
      modalModes:  this._lastNModes  || 10,
      modalMethod: this._modalMethod || 'subspace',
      buckModes:   this._lastBuckModes || 6,
      plasticMp:   this._lastMp || 100,
      nlSteps:     Math.max(1, Math.round(parseFloat(this._nlSteps) || 12)),
    };
  }
  // Restores into the UI/state the parameters saved in a just-loaded .s3d.
  _applyAnalysisParams(ap) {
    if (!ap) return;
    const cb = document.getElementById('auto-disc');
    if (cb && ap.autoDisc != null) cb.checked = !!ap.autoDisc;
    const nIn = document.getElementById('auto-disc-n');
    if (nIn && ap.autoDiscN) nIn.value = ap.autoDiscN;
    if (ap.modalModes)  this._lastNModes   = ap.modalModes;
    if (ap.modalMethod) this._modalMethod  = ap.modalMethod;
    if (ap.buckModes)   this._lastBuckModes = ap.buckModes;
    if (ap.plasticMp)   this._lastMp        = ap.plasticMp;
    if (ap.nlSteps)     this._nlSteps       = ap.nlSteps;
  }

  // ── Extensions (upper layers: Pro / white-label) ────────────────────────────
  // core is self-contained; the upper layers register their contributions in
  // `extensions` (see js/ext/extensions.js). Here only the registered badges are drawn.
  _initExtensions() {
    const host = document.getElementById('ext-badges');
    if (!host) return;
    host.innerHTML = extensions.badges
      .map(b => (typeof b.render === 'function' ? b.render() : (b.html || '')))
      .join('');
  }

  // ── i18n (ES/EN) ────────────────────────────────────────────────────────────
  // Translates the static chrome (menus, header, cover page) by source string; what
  // the dictionary doesn't cover stays in Spanish (fallback). See js/i18n/.
  _initI18n() {
    i18n.init(document.body);
    const sel = document.getElementById('lang-select');
    if (sel) {
      sel.value = i18n.getLocale();
      sel.addEventListener('change', () => i18n.setLocale(sel.value));
    }
    // Auto-translates the containers that re-render dynamically (the right
    // properties panel, the model tree): when new HTML is injected, in EN the
    // observer translates it. No-op in Spanish. The modal has its own observer.
    for (const id of ['panel', 'model-tree', 'toast-container']) {
      const el = document.getElementById(id);
      if (el) i18n.observe(el);
    }
    // On language change, re-apply the dynamic status-bar texts.
    window.addEventListener('localechange', () => {
      if (this.viewport?.mode) this.viewport.setMode(this.viewport.mode);
      this._updateResultsIndicator();
      this._updateStats();
      this._updateTitle();
    });
  }
  // Is there report branding (company logo/footer/limitations)? Enabled by an
  // upper layer via extensions.setFlag('memoriaBranding'). In core it's false →
  // the report uses the standard template.
  get _brandingPro() { return extensions.flag('memoriaBranding'); }

  configDialog() {
    // mm: working copy of the EFFECTIVE report (config + model). What's edited is
    // saved as the PER-PROJECT report in the model and as the global default (#41).
    const mm = { ...this._report() }, sd = this._config.seccion_mod_default, an = this._config.analisis;
    const overlay = document.getElementById('modal-overlay');
    const ea = s => String(s ?? '').replace(/"/g, '&quot;');
    // Context shared with the EXTENSION sections (upper layers: Pro, white-label).
    // Each section registered in `extensions` provides its HTML, its listeners
    // (bind) and dumps its values into mm/an on save (collect).
    const ctx = { app: this, mm, an, sd, esc: ea };
    const extHtml = extensions.configSections
      .map(s => { try { return s.render?.(ctx) || ''; } catch (e) { console.error('configSection.render', e); return ''; } })
      .join('');
    document.getElementById('modal-title').textContent = i18n.t('⚙ Configuración');
    document.getElementById('modal-box')?.classList.add('modal-wide');
    document.getElementById('modal-cancel').style.display = '';
    document.getElementById('modal-body').innerHTML = `
      <div style="display:flex;flex-direction:column;gap:14px;font-size:13px">
        <fieldset style="border:1px solid var(--border);border-radius:6px;padding:10px 12px">
          <legend style="padding:0 6px;color:var(--accent)">Memoria — encabezado</legend>
          <div class="prop-row cols2" style="gap:8px">
            <div class="prop-field"><label>Título</label><input id="cfg-titulo" value="${ea(mm.titulo)}"></div>
            <div class="prop-field"><label>Proyectista</label><input id="cfg-proy" value="${ea(mm.proyectista)}"></div>
          </div>
          <div class="prop-row cols2" style="gap:8px;margin-top:6px">
            <div class="prop-field"><label>Revisó</label><input id="cfg-rev" value="${ea(mm.revisor)}"></div>
          </div>
        </fieldset>

        <fieldset style="border:1px solid var(--border);border-radius:6px;padding:10px 12px">
          <legend style="padding:0 6px;color:var(--accent)">Visualización de la memoria</legend>
          <label style="display:block;margin-bottom:5px"><input type="checkbox" id="cfg-ids" ${mm.mostrarIds ? 'checked' : ''}> Mostrar IDs de nodos y elementos en las figuras</label>
          <label style="display:block"><input type="checkbox" id="cfg-modos" ${mm.modosVisibles ? 'checked' : ''}> Amplificar las formas modales para que se observen</label>
        </fieldset>

        <fieldset style="border:1px solid var(--border);border-radius:6px;padding:10px 12px">
          <legend style="padding:0 6px;color:var(--accent)">Análisis</legend>
          <label style="display:block">Modo de solución
            <select id="cfg-solver" style="margin-left:6px">
              <option value="fast" ${!this._config.analisis.matrizDensa ? 'selected' : ''}>Rápido optimizado (Cholesky bandeado + RCM) — recomendado</option>
              <option value="full" ${this._config.analisis.matrizDensa ? 'selected' : ''}>Completo / pesado (matriz densa, sin reordenamiento) — exacto, más lento</option>
            </select></label>
          <small style="color:var(--text-muted);font-size:10.5px">Aplica al estático, modal, espectro y time-history. El modo rápido condensa en banda (factorización única, O(n·b)); el completo arma y factoriza la matriz densa tal cual (O(n³)), útil para verificación.</small>
          <label style="display:block;margin-top:8px"><input type="checkbox" id="cfg-nllite" ${this._config.analisis.nlLite ? 'checked' : ''}> Habilitar <b>análisis no lineal (NL-lite)</b></label>
          <small style="color:var(--text-muted);font-size:10.5px">Activa <b>Análisis → No lineal</b>: cables (solo tracción), pretensado por longitud natural y no linealidad geométrica (corotacional, Newton incremental) con deformada paso a paso. Marca elementos como «cable» en la pestaña Elem.</small>
        </fieldset>

        ${extHtml}

        <fieldset style="border:1px solid var(--border);border-radius:6px;padding:10px 12px">
          <legend style="padding:0 6px;color:var(--accent)">Modificadores de sección por defecto (rigidez)</legend>
          <p style="color:var(--text-muted);font-size:11px;margin-bottom:6px">Factores aplicados a A, I, J en el análisis (p.ej. sección agrietada ACI: viga 0.35, columna 0.70). Editables por sección en la pestaña Sec.</p>
          <div class="prop-row cols4" style="gap:8px">
            <div class="prop-field"><label>×A</label><input type="number" id="cfg-mA" value="${sd.A}" step="0.05" min="0.01"></div>
            <div class="prop-field"><label>×Iy</label><input type="number" id="cfg-mIy" value="${sd.Iy}" step="0.05" min="0.01"></div>
            <div class="prop-field"><label>×Iz</label><input type="number" id="cfg-mIz" value="${sd.Iz}" step="0.05" min="0.01"></div>
            <div class="prop-field"><label>×J</label><input type="number" id="cfg-mJ" value="${sd.J}" step="0.05" min="0.01"></div>
          </div>
          <button type="button" id="cfg-apply-mod" class="btn" style="margin-top:8px">Aplicar estos modificadores a TODAS las secciones</button>
        </fieldset>
        <p style="color:var(--text-muted);font-size:11px">Los parámetros de diseño (Fy, f′c, φ, cuantía…) usan valores normativos estándar.</p>
      </div>`;
    overlay.classList.remove('hidden');

    // Listeners of the extension sections (upper layers).
    extensions.configSections.forEach(s => { try { s.bind?.(ctx); } catch (e) { console.error('configSection.bind', e); } });

    document.getElementById('cfg-apply-mod')?.addEventListener('click', () => {
      const mod = { A: +document.getElementById('cfg-mA').value || 1, Iy: +document.getElementById('cfg-mIy').value || 1,
        Iz: +document.getElementById('cfg-mIz').value || 1, J: +document.getElementById('cfg-mJ').value || 1 };
      for (const s of this.model.sections.values()) this.model.updateSection(s.id, { mod: { ...mod } });
      this.markDirty(); this.panel.renderSections?.();
      this.toast('Modificadores aplicados a todas las secciones', 'ok');
    });
    overlay._resolve = () => {
      const v = id => document.getElementById(id)?.value ?? '';
      mm.titulo = v('cfg-titulo'); mm.proyectista = v('cfg-proy'); mm.revisor = v('cfg-rev');
      mm.mostrarIds = document.getElementById('cfg-ids')?.checked ?? true;
      mm.modosVisibles = document.getElementById('cfg-modos')?.checked ?? true;
      an.matrizDensa = document.getElementById('cfg-solver')?.value === 'full';   // dense (full) / banded (fast)
      an.nlLite = document.getElementById('cfg-nllite')?.checked ?? false;        // nonlinear
      // Contributions from the extensions (they dump their fields into mm/an).
      extensions.configSections.forEach(s => { try { s.collect?.(ctx); } catch (e) { console.error('configSection.collect', e); } });
      sd.A = +v('cfg-mA') || 1; sd.Iy = +v('cfg-mIy') || 1; sd.Iz = +v('cfg-mIz') || 1; sd.J = +v('cfg-mJ') || 1;
      // PER-PROJECT report (model, travels in the .s3d) + global default (#41).
      const proj = {};
      for (const k of App._MEMORIA_PROJ_KEYS) proj[k] = mm[k];
      this.model.report = { ...(this.model.report || {}), ...proj };
      this._config.report = { ...this._config.report, ...mm };   // incl. logoEmpresa (global)
      this.markDirty();
      this._saveConfig();
      document.getElementById('modal-box')?.classList.remove('modal-wide');
      this.toast('Configuración guardada', 'ok');
    };
    overlay._reject = () => document.getElementById('modal-box')?.classList.remove('modal-wide');
  }

  /** 3-option dialog when a model already exists while generating from the assistant. */
  _existingModelDialog() {
    return new Promise(resolve => {
      document.getElementById('portico-choice')?.remove();
      const s = this.model.getStats();
      const el = document.createElement('div');
      el.id = 'portico-choice';
      el.style.cssText = 'position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;background:rgba(6,10,18,.72);backdrop-filter:blur(2px)';
      el.innerHTML = `
        <div style="background:var(--bg-elev,#141b27);border:1px solid var(--border,#334);border-radius:10px;padding:22px 24px;max-width:460px;box-shadow:0 10px 40px rgba(0,0,0,.5)">
          <div style="color:var(--text,#e6edf3);font-weight:600;font-size:15px;margin-bottom:6px">⚠️ Ya existe un modelo</div>
          <div style="color:var(--text-muted,#9aa);font-size:13px;line-height:1.5;margin-bottom:16px">
            El modelo actual tiene <b>${s.nodes}</b> nodos y <b>${s.elements}</b> elementos.
            ¿Qué hago con la estructura que generará el asistente?</div>
          <div style="display:flex;flex-direction:column;gap:8px">
            <button data-choice="sobreponer" style="width:100%;text-align:left;padding:10px 12px;border-radius:6px;border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer;font-size:13px">➕ Sobreponer — agregar al modelo actual (funde nodos coincidentes)</button>
            <button data-choice="nueva" style="width:100%;text-align:left;padding:10px 12px;border-radius:6px;border:1px solid var(--border2,#445);background:transparent;color:var(--text,#e6edf3);cursor:pointer;font-size:13px">🗑 Nueva — reemplazar el modelo actual por el generado</button>
            <button data-choice="cancelar" style="width:100%;text-align:left;padding:10px 12px;border-radius:6px;border:1px solid var(--border2,#445);background:transparent;color:var(--text-muted,#9aa);cursor:pointer;font-size:13px">✕ Cancelar</button>
          </div>
        </div>`;
      document.body.appendChild(el);
      const done = v => { el.remove(); resolve(v); };
      el.querySelectorAll('[data-choice]').forEach(b => b.addEventListener('click', () => done(b.dataset.choice)));
      el.addEventListener('mousedown', e => { if (e.target === el) done('cancelar'); });
    });
  }

  /** Merges a generated model into this.model (overlay): remaps ids, welds
   *  coincident nodes by coordinate and dedupes bars/material/section. */
  _mergeGeneratedInto(src) {
    const dst = this.model;
    const rk = v => Math.round(v * 1e4) / 1e4;
    const ckey = (x, y, z) => `${rk(x)},${rk(y)},${rk(z)}`;
    const strip = o => { const { id, ...r } = o; return r; };

    // Materials and sections (dedupe by name)
    const matByName = new Map([...dst.materials.values()].map(m => [m.name, m.id]));
    const matMap = new Map();
    for (const m of src.materials.values()) {
      if (matByName.has(m.name)) { matMap.set(m.id, matByName.get(m.name)); continue; }
      const nm = dst.addMaterial(strip(m)); matMap.set(m.id, nm.id); matByName.set(nm.name, nm.id);
    }
    const secByName = new Map([...dst.sections.values()].map(s => [s.name, s.id]));
    const secMap = new Map();
    for (const s of src.sections.values()) {
      if (secByName.has(s.name)) { secMap.set(s.id, secByName.get(s.name)); continue; }
      const ns = dst.addSection(strip(s)); secMap.set(s.id, ns.id); secByName.set(ns.name, ns.id);
    }

    // Nodes: weld by coordinate
    const coordIdx = new Map();
    for (const n of dst.nodes.values()) coordIdx.set(ckey(n.x, n.y, n.z), n.id);
    const nodeMap = new Map();
    let welded = 0;
    for (const n of src.nodes.values()) {
      const k = ckey(n.x, n.y, n.z);
      if (coordIdx.has(k)) {
        const exId = coordIdx.get(k);
        nodeMap.set(n.id, exId);
        const r = {};
        for (const g of ['ux', 'uy', 'uz', 'rx', 'ry', 'rz']) if (n.restraints?.[g]) r[g] = 1;
        dst.updateNode(exId, { restraints: r, springs: n.springs, nodeMass: n.nodeMass });
        welded++;
      } else {
        const nn = dst.addNode(n.x, n.y, n.z, n.restraints || {});
        dst.updateNode(nn.id, { springs: n.springs, nodeMass: n.nodeMass });
        nodeMap.set(n.id, nn.id);
        coordIdx.set(k, nn.id);
      }
    }

    // Elements (dedupe by node pair)
    const pk = (a, b) => a < b ? `${a}-${b}` : `${b}-${a}`;
    const elemPairs = new Set([...dst.elements.values()].map(e => pk(e.n1, e.n2)));
    const elemMap = new Map();
    for (const e of src.elements.values()) {
      const a = nodeMap.get(e.n1), b = nodeMap.get(e.n2);
      if (a == null || b == null || a === b || elemPairs.has(pk(a, b))) continue;
      const ne = dst.addElement(a, b, matMap.get(e.matId), secMap.get(e.secId));
      if (!ne) continue;
      if (e.releases) dst.updateElement(ne.id, { releases: e.releases });
      elemMap.set(e.id, ne.id);
      elemPairs.add(pk(a, b));
    }

    // Load cases (merge by name; loads with remapped targets)
    const srcLcName = new Map([...src.loadCases.values()].map(l => [l.id, l.name]));
    const lcByName = new Map([...dst.loadCases.values()].map(l => [l.name, l.id]));
    for (const lc of src.loadCases.values()) {
      let dstLcId = lcByName.get(lc.name);
      if (dstLcId == null) {
        const nl = dst.addLoadCase(lc.name, lc.selfWeight, lc.type, lc.specDir);
        if (lc.spec) nl.spec = lc.spec;
        dstLcId = nl.id; lcByName.set(nl.name, nl.id);
      }
      const dlc = dst.loadCases.get(dstLcId);
      for (const ld of (lc.loads || [])) {
        if (ld.type === 'nodal') { const id = nodeMap.get(ld.nodeId); if (id != null) dlc.loads.push({ type: 'nodal', nodeId: id, F: [...ld.F] }); }
        else if (ld.type === 'dist') { const id = elemMap.get(ld.elemId); if (id != null) { const d = { type: 'dist', elemId: id, dir: ld.dir, w: ld.w }; if (ld.w2 != null) d.w2 = ld.w2; dlc.loads.push(d); } }
      }
    }

    // Diaphragms (remap nodes / masterId)
    for (const d of src.diaphragms.values()) {
      const nodes = (d.nodes || []).map(id => nodeMap.get(id)).filter(x => x != null);
      if (!nodes.length) continue;
      const nd = dst.addDiaphragm({ ...strip(d), nodes });
      if (d.masterId != null && nodeMap.get(d.masterId) != null) nd.masterId = nodeMap.get(d.masterId);
    }

    // Combinations (remap the factors' lcId; dedupe by name)
    const comboNames = new Set([...dst.combinations.values()].map(c => c.name));
    for (const c of src.combinations.values()) {
      if (comboNames.has(c.name)) continue;
      const factors = (c.factors || [])
        .map(f => ({ lcId: lcByName.get(srcLcName.get(f.lcId)), factor: f.factor }))
        .filter(f => f.lcId != null);
      dst.addCombination({ name: c.name, factors });
      comboNames.add(c.name);
    }

    return { welded };
  }

  /** Summary of the generator's replacements/estimations/omissions. */
  _showWarnings(warnings) {
    if (!warnings || !warnings.length) { this.toast('Sin reemplazos: todo se interpretó correctamente', 'ok'); return; }
    const icono = { reemplazo: '🔁', estimado: '📐', omitido: '⚠️', info: 'ℹ️' };
    const items = warnings.map(a => `<li style="margin:4px 0"><b>${icono[a.type] || '•'} ${a.type}</b> — ${a.msg}</li>`).join('');
    this._alert('Resumen del asistente — ajustes realizados',
      `<p style="color:var(--text-muted);margin-bottom:6px">${i18n.t('El modelo se generó. Estos datos faltaban o no se reconocieron y se sustituyeron/estimaron:')}</p>
       <ul style="max-height:340px;overflow:auto;padding-left:18px;font-size:12px">${items}</ul>`);
  }

  /** Full-screen progress overlay that blocks interaction. */
  _showProgress(titulo, sub = '', onCancel = null) {
    let el = document.getElementById('portico-progress');
    if (!el) {
      el = document.createElement('div');
      el.id = 'portico-progress';
      el.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(6,10,18,.72);backdrop-filter:blur(2px)';
      el.innerHTML =
        `<div style="background:var(--bg-elev,#141b27);border:1px solid var(--border,#334);border-radius:10px;padding:22px 26px;min-width:300px;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,.5)">
           <div id="pp-titulo" style="color:var(--text,#e6edf3);font-weight:600;margin-bottom:4px"></div>
           <div id="pp-sub" style="color:var(--text-muted,#9aa);font-size:12px;margin-bottom:12px"></div>
           <div style="height:6px;border-radius:3px;background:var(--border,#223);overflow:hidden">
             <div style="height:100%;width:40%;border-radius:3px;background:var(--accent,#4ea1ff);animation:pp-slide 1.1s ease-in-out infinite"></div>
           </div>
           <button id="pp-cancel" style="display:none;margin-top:14px;background:transparent;border:1px solid var(--danger,#dc2626);color:var(--danger,#dc2626);border-radius:6px;padding:4px 12px;cursor:pointer;font-size:12px">Cancelar</button>
         </div>
         <style>@keyframes pp-slide{0%{margin-left:-40%}100%{margin-left:100%}}</style>`;
      document.body.appendChild(el);
    }
    el.querySelector('#pp-titulo').textContent = titulo;
    el.querySelector('#pp-sub').textContent = sub;
    const cancel = el.querySelector('#pp-cancel');
    cancel.style.display = onCancel ? '' : 'none';
    cancel.onclick = onCancel || null;
    el.style.display = 'flex';
  }

  _hideProgress() {
    const el = document.getElementById('portico-progress');
    if (el) el.style.display = 'none';
  }

  // ── Light / dark theme (light by default) ───────────────────────────────────
  _initTheme() {
    const t = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    this.applyTheme(t);
    const toggle = () => {
      const actual = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
      this.applyTheme(actual === 'dark' ? 'light' : 'dark');
    };
    document.getElementById('btn-theme')?.addEventListener('click', toggle);
    document.getElementById('landing-theme')?.addEventListener('click', toggle);   // same toggle on the cover page
  }

  applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('portico_theme', theme); } catch (e) {}   // remembered per machine
    const icon = theme === 'dark' ? '☀️' : '🌙';
    const ttl  = theme === 'dark' ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro';
    for (const id of ['btn-theme', 'landing-theme']) {
      const btn = document.getElementById(id);
      if (btn) { btn.textContent = icon; btn.title = ttl; }
    }
    this._swapLogos(theme);
    this.viewport?.setTheme?.(theme === 'light');
  }

  /** (open) Swaps brand logos with -negro/-blanco variants per the theme.
   *  The open edition ships no institutional logos; if a white-label build adds
   *  a logo with those variants, this swap supports it automatically. */
  _swapLogos(theme) {
    const suf = theme === 'light' ? 'negro' : 'blanco';
    for (const img of document.querySelectorAll('img.brand-logo')) {
      const s = img.getAttribute('src') || '';
      if (/(blanco|negro)(?=[^/]*\.svg$)/.test(s))
        img.setAttribute('src', s.replace(/(blanco|negro)(?=[^/]*\.svg$)/, suf));
    }
  }

  async _loadAssistantLibraries() {
    if (this._asisLibs) return this._asisLibs;
    const parseCSV = (txt) => {
      const lines = txt.split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#'));
      const head = lines[0].split(',').map(s => s.trim());
      return lines.slice(1).map(l => {
        const c = l.split(',').map(s => s.trim());
        return Object.fromEntries(head.map((h, i) => [h, c[i]]));
      });
    };
    const base = 'assistant/';
    const [reglas, pTxt, mTxt, sTxt] = await Promise.all([
      fetch(base + 'rules.json').then(r => r.json()),
      fetch(base + 'profiles.csv').then(r => r.text()),
      fetch(base + 'materials.csv').then(r => r.text()),
      fetch(base + 'live_loads.csv').then(r => r.text()),
    ]);
    this._asisLibs = { reglas, perfiles: parseCSV(pTxt), materiales: parseCSV(mTxt), sobrecargas: parseCSV(sTxt) };
    return this._asisLibs;
  }

  async saveFile() {
    if (window.electronAPI && this._filePath) {
      try {
        await window.electronAPI.writeFile(this._filePath, this._fullSaveJSON());
        this._dirty = false;
        this._updateTitle();
        this.toast(this._saveToastMsg(), 'ok');
      } catch (err) {
        this.toast(`${i18n.t('Error al guardar:')} ${err.message}`, 'error');
      }
    } else if (this._fileHandle) {
      try {
        const writable = await this._fileHandle.createWritable();
        await writable.write(this._fullSaveJSON());
        await writable.close();
        this._dirty = false;
        this._updateTitle();
        this.toast(this._saveToastMsg(), 'ok');
      } catch (err) {
        this.toast(`${i18n.t('Error al guardar:')} ${err.message}`, 'error');
      }
    } else {
      await this.saveFileAs();
    }
  }

  async saveFileAs() {
    try {
      if (window.electronAPI) {
        const filePath = await window.electronAPI.saveFileAs('modelo.s3d');
        if (!filePath) return;
        await window.electronAPI.writeFile(filePath, this._fullSaveJSON());
        this._filePath   = filePath;
        this._fileHandle = null;
        this._dirty = false;
        this._updateTitle(filePath.split(/[\\/]/).pop());
        this.toast(this._saveToastMsg(), 'ok');
      } else if ('showSaveFilePicker' in window) {
        const handle = await window.showSaveFilePicker({
          suggestedName: 'modelo.s3d',
          types: [{ description: 'PORTICO', accept: { 'application/json': ['.s3d'] } }]
        });
        const writable = await handle.createWritable();
        await writable.write(this._fullSaveJSON());
        await writable.close();
        this._fileHandle = handle;
        this._filePath   = null;
        this._dirty = false;
        this._updateTitle(handle.name);
        this.toast(this._saveToastMsg(), 'ok');
      } else {
        this._downloadText(this._fullSaveJSON(), 'modelo.s3d', 'application/json');
        this._dirty = false;
        this._updateTitle();
        this.toast(this._saveToastMsg(), 'ok');
      }
    } catch (err) {
      if (err.name !== 'AbortError') this.toast(`${i18n.t('Error al guardar:')} ${err.message}`, 'error');
    }
  }

  importCSV() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.csv,.txt';
    inp.onchange = async () => {
      try {
        const text = await inp.files[0].text();
        this.snapshot();
        const { model, errors } = this.serializer.fromCSV(text, this.model, i18n.t);
        this.model = model;
        this.viewport.renderModel(model);
        this.panel.showNothing();
        this.panel.refresh(model);
        this.markDirty();
        this._updateStats();
        this.viewport.zoomExtents();
        if (errors.length > 0) {
          this.toast(`${i18n.t('CSV importado con')} ${errors.length} ${i18n.t('advertencia(s)')}`, 'warn');
          console.warn('CSV import warnings:', errors);
        } else {
          this.toast('CSV importado correctamente', 'ok');
        }
        // Show error details if any
        if (errors.length > 0) {
          this._alert(
            'Advertencias al importar CSV',
            `<pre style="font-size:11px;color:#d29922;white-space:pre-wrap;">${esc(errors.slice(0,20).join('\n'))}</pre>`
          );
        }
      } catch (err) {
        this.toast(`${i18n.t('Error al importar CSV:')} ${err.message}`, 'error');
      }
    };
    inp.click();
  }

  exportCSV() {
    // If the analysis auto-discretized the model, export the user's ORIGINAL
    const m = this._predisc ? this.serializer.fromJSON(this._predisc) : this.model;
    const csv = this.serializer.toCSV(m);
    this._downloadText(csv, 'modelo.csv', 'text/csv;charset=utf-8');
    this.toast('CSV exportado', 'ok');
  }

  // ── Interoperability (#74): export/import to other engines ───────────────────
  async exportInterop() {
    const fmts = listFormats().filter(f => f.caps.write);
    if (!fmts.length) { this.toast('No hay formatos de exportación registrados', 'warn'); return; }
    const opts = fmts.map(f => `<option value="${f.id}">${f.name}</option>`).join('');
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = i18n.t('🔄 Exportar a otro motor');
    document.getElementById('modal-cancel').style.display = '';
    document.getElementById('modal-body').innerHTML = `
      <p style="color:var(--text-muted);font-size:11px;margin:0 0 8px">Escribe el modelo (nodos, barras, secciones, apoyos, cargas nodales) en el formato de otro programa de análisis.</p>
      <div class="prop-field"><label>Formato</label><select id="io-fmt" style="width:100%">${opts}</select></div>`;
    overlay.classList.remove('hidden');
    const okBtn = await new Promise(res => { overlay._resolve = () => res(true); overlay._reject = () => res(false); });
    if (!okBtn) return;
    const id = document.getElementById('io-fmt').value;
    try {
      const m = this._predisc ? this.serializer.fromJSON(this._predisc) : this.model;
      const { text, ext, warnings } = exportModel(m, id);
      const base = (this._modelName || 'modelo').replace(/\.[^.]+$/, '').replace(/\W+/g, '_') || 'modelo';
      this._downloadText(text, `${base}.${ext}`, 'text/plain;charset=utf-8');
      this.toast(`Exportado a ${id}${warnings.length ? ` (${warnings.length} advertencia(s))` : ''}`, warnings.length ? 'warn' : 'ok');
      if (warnings.length) this._alert('Advertencias al exportar', `<pre style="font-size:11px;color:#d29922;white-space:pre-wrap">${esc(warnings.join('\n'))}</pre>`);
    } catch (e) { this.toast(i18n.t('Error al exportar:') + ' ' + e.message, 'error'); }
  }

  async importInterop() {
    const fmts = listFormats().filter(f => f.caps.read);
    if (!fmts.length) { this.toast('No hay formatos de importación registrados', 'warn'); return; }
    // 1) Choose the file type FIRST (HTML's <input type=file> doesn't allow named
    //    filters, so the format is chosen here and the file is filtered to its ext).
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = i18n.t('🔄 Importar de otro motor');
    document.getElementById('modal-cancel').style.display = '';
    const opts = fmts.map(f => `<option value="${f.id}">${f.name}</option>`).join('');
    document.getElementById('modal-body').innerHTML = `
      <p style="color:var(--text-muted);font-size:11px;margin:0 0 8px">Elige el <b>tipo de archivo</b> y luego selecciónalo. Se leen nodos, barras, secciones, apoyos y cargas nodales.</p>
      <div class="prop-field"><label>Tipo de archivo</label><select id="io-fmt" style="width:100%">${opts}</select></div>`;
    overlay.classList.remove('hidden');
    const okBtn = await new Promise(res => { overlay._resolve = () => res(true); overlay._reject = () => res(false); });
    if (!okBtn) return;
    const fmt = fmts.find(f => f.id === document.getElementById('io-fmt').value);
    if (!fmt) return;
    // 2) Open the file, filtered to the chosen format's extension.
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = `.${fmt.ext},.txt`;
    inp.onchange = async () => {
      const file = inp.files[0]; if (!file) return;
      try {
        const text = await file.text();
        this.snapshot();
        const { model, warnings } = importModel(text, fmt.id);
        this.model = model;
        this.viewport.renderModel(model);
        this.panel.showNothing(); this.panel.refresh(model);
        this.markDirty(); this._updateStats(); this.viewport.zoomExtents();
        this.toast(`${i18n.t('Importado de')} ${fmt.name}: ${model.nodes.size} ${i18n.t('nodos')}, ${model.elements.size} ${i18n.t('barras')}${warnings.length ? ` (${warnings.length} ${i18n.t('aviso(s)')})` : ''}`, warnings.length ? 'warn' : 'ok');
        if (warnings.length) this._alert('Advertencias al importar', `<pre style="font-size:11px;color:#d29922;white-space:pre-wrap">${esc(warnings.slice(0, 30).join('\n'))}</pre>`);
      } catch (e) { this.toast(i18n.t('Error al importar:') + ' ' + e.message, 'error'); }
    };
    inp.click();
  }

  // ── Import IFC (#75-#77, G19): floating window with side-by-side preview ─────
  async importIFC() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.ifc,.ifcxml,.txt';
    inp.onchange = async () => {
      const file = inp.files[0]; if (!file) return;
      let mods;
      try {
        mods = await Promise.all([
          import('./io/ifc/ifcToPortico.js?v=2'),
          import('./ui/ifcImportDialog.js?v=2'),
          import('./io/neutral.js?v=2'),
        ]);
      } catch (e) { this.toast(i18n.t('No se pudo cargar el importador IFC:') + ' ' + e.message, 'error'); return; }
      const [{ analyzeIFC, itemsToNeutral }, { openIfcImportDialog }, { neutralToModel }] = mods;
      let analysis;
      try {
        const text = await file.text();
        analysis = analyzeIFC(text);
      } catch (e) { this.toast(i18n.t('Error al leer el IFC:') + ' ' + e.message, 'error'); return; }
      if (!analysis.items.length) { this.toast('El IFC no contiene elementos reconocibles', 'warn'); return; }

      const res = await openIfcImportDialog({ fileName: file.name, analysis });
      if (!res) return;   // canceled: the model is NOT touched

      try {
        const base = file.name.replace(/\.[^.]+$/, '');
        const { neutral, stats, warnings } = itemsToNeutral(res.items, res.selected, { name: base });
        this.snapshot();                         // integrated into undo/redo
        this.model = neutralToModel(neutral);
        this._modelName = base;
        this.viewport.renderModel(this.model);
        this.panel.showNothing(); this.panel.refresh(this.model);
        this.markDirty(); this._updateStats(); this.viewport.zoomExtents();
        const allW = [...analysis.warnings.summary(), ...warnings];
        this.toast(`${i18n.t('IFC importado:')} ${stats.nodes} ${i18n.t('nodos')}, ${stats.members} ${i18n.t('barras')}${stats.areas ? `, ${stats.areas} ${i18n.t('áreas')}` : ''}${allW.length ? ` (${allW.length} ${i18n.t('aviso(s)')})` : ''}`, allW.length ? 'warn' : 'ok');
        if (allW.length) this._alert('Advertencias al importar IFC', `<pre style="font-size:11px;color:#d29922;white-space:pre-wrap">${esc(allW.slice(0, 40).join('\n'))}</pre>`);
      } catch (e) { this.toast(i18n.t('Error al construir el modelo:') + ' ' + e.message, 'error'); }
    };
    inp.click();
  }

  // ── Export IFC (#75-#77, G19): model → .ifc (IFC4, bars as IfcBeam/Column) ──
  async exportIFC() {
    if (this.model.nodes.size === 0) { this.toast('Modelo vacío — nada que exportar', 'warn'); return; }
    try {
      const [{ modelToNeutral }, { neutralToIFC }] = await Promise.all([
        import('./io/neutral.js?v=2'),
        import('./io/ifc/ifcWriter.js?v=2'),
      ]);
      const m = this._predisc ? this.serializer.fromJSON(this._predisc) : this.model;
      const neutral = modelToNeutral(m);
      const base = (this._modelName || 'modelo').replace(/\.[^.]+$/, '').replace(/\W+/g, '_') || 'modelo';
      const text = neutralToIFC(neutral, { name: base });
      this._downloadText(text, `${base}.ifc`, 'application/x-step;charset=utf-8');
      const warns = neutral.meta?.warnings || [];
      this.toast(`${i18n.t('IFC exportado:')} ${neutral.members.length} ${i18n.t('barras')}${neutral.areas?.length ? `, ${neutral.areas.length} ${i18n.t('áreas')}` : ''}${warns.length ? ` (${warns.length} ${i18n.t('aviso(s)')})` : ''}`, warns.length ? 'warn' : 'ok');
      if (warns.length) this._alert('Advertencias al exportar IFC', `<pre style="font-size:11px;color:#d29922;white-space:pre-wrap">${esc(warns.join('\n'))}</pre>`);
    } catch (e) { this.toast(i18n.t('Error al exportar IFC:') + ' ' + e.message, 'error'); }
  }

  // JSON to save to disk: if the analysis auto-discretized the model,
  // the user's ORIGINAL model is saved, not the temporary subdivided one.
  _modelJSONForSave() {
    return this._predisc ?? this.serializer.toJSON(this.model);
  }

  // Are there results consistent with the current model, fit to save?
  _hasSavableResults() {
    const c = this._resultsCache;
    return !!(c && c.cases && c.cases.length && c.sig === this._modelSig(!!c.autoDisc));
  }

  // JSON to save: if the project has multiple models, wraps them all; otherwise,
  // the usual single-model .s3d (zero change for existing files).
  _fullSaveJSON() {
    if (this._project && this._project.models.length > 1) return this._buildProjectSaveJSON();
    return this._singleSaveJSON();
  }

  // ── G7: multi-model project ─────────────────────────────────────────────────
  _initProjectUI() {
    document.getElementById('project-select')?.addEventListener('change', e => this._projectSwitch(e.target.value));
    document.getElementById('btn-project')?.addEventListener('click', () => this._projectDialog());
    // Side tree: add model / clear temporaries
    document.getElementById('mt-add')?.addEventListener('click', async () => {
      const mode = await this._askModelMode(); if (mode) this._projectAddModel(mode);
    });
    document.getElementById('mt-temp-clear')?.addEventListener('click', () => this.clearAllTemporales());
    this._renderProjectSelector();
  }

  // Opens/closes the side tree (the toolbar shifts to the right).
  toggleModelTree(force) {
    const main = document.getElementById('main'); if (!main) return;
    const open = force == null ? !main.classList.contains('tree-open') : !!force;
    main.classList.toggle('tree-open', open);
    document.getElementById('btn-tree-toggle')?.classList.toggle('active', open);
    if (open) this.renderModelTree();
    setTimeout(() => this.viewport?._onResize?.(), 200);   // after the grid transition
  }

  // Treeview of the project's models + temporaries list (left side panel).
  renderModelTree() {
    const box = document.getElementById('mt-models');
    if (box) {
      const only = this._project.models.length <= 1;
      box.innerHTML = this._project.models.map(m => {
        const act = m.id === this._project.activeId;
        return `<div class="mt-node ${act ? 'active' : ''}" data-id="${m.id}">
          <span class="mt-ico">${act ? '▸' : '·'}</span>
          <span class="mt-name" title="Activar «${esc(m.name)}»">${esc(m.name || ('Modelo ' + m.id))}</span>
          <button class="mt-act" data-act="rename" data-id="${m.id}" title="Renombrar">✎</button>
          <button class="mt-act" data-act="dup" data-id="${m.id}" title="Duplicar">⧉</button>
          <button class="mt-act danger" data-act="del" data-id="${m.id}" title="Eliminar" ${only ? 'style="display:none"' : ''}>🗑</button>
        </div>`;
      }).join('');
      box.querySelectorAll('.mt-node').forEach(n =>
        n.querySelector('.mt-name').addEventListener('click', () => this._projectSwitch(+n.dataset.id)));
      box.querySelectorAll('.mt-act').forEach(b => b.addEventListener('click', async ev => {
        ev.stopPropagation();
        const id = +b.dataset.id, act = b.dataset.act, m = this._project.models.find(x => x.id === id);
        if (act === 'rename') {
          const name = await this._promptModal('Renombrar modelo', 'Nombre del modelo', m?.name || '');
          if (name) { m.name = name; if (id === this._project.activeId) this._updateTitle(name); this._renderProjectSelector(); this.markDirty(); }
        } else if (act === 'dup') {
          if (id !== this._project.activeId) this._projectSwitch(id);
          this._projectDuplicate();
        } else if (act === 'del') {
          if (await this._confirm(`¿Eliminar el modelo «${esc(m?.name)}» del proyecto?`)) this._projectDelete(id);
        }
      }));
    }
    this._fillTemporales(document.getElementById('mt-temporales'));
  }

  // Project model management dialog.
  async _projectDialog() {
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = i18n.t('🗂 Modelos del proyecto');
    const rows = this._project.models.map(m => `
      <div style="display:flex;align-items:center;gap:6px;padding:5px 8px;border:1px solid var(--border);border-radius:6px;margin-bottom:4px;font-size:12px;${m.id === this._project.activeId ? 'border-color:var(--accent)' : ''}">
        <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${m.id === this._project.activeId ? '● ' : ''}${esc(m.name)}</span>
        <button class="pj-act" data-act="switch" data-id="${m.id}" title="Activar este modelo" style="background:none;border:none;color:var(--text-muted);cursor:pointer">↪</button>
        <button class="pj-act" data-act="rename" data-id="${m.id}" title="Renombrar" style="background:none;border:none;color:var(--text-muted);cursor:pointer">✎</button>
        <button class="pj-act" data-act="del" data-id="${m.id}" title="Eliminar del proyecto" style="background:none;border:none;color:var(--danger,#f85149);cursor:pointer">🗑</button>
      </div>`).join('');
    document.getElementById('modal-body').innerHTML = `
      <p style="color:var(--text-muted);font-size:11px;margin:0 0 8px">Varios modelos en un mismo proyecto (edificio, cercha, fundación…). Se integran en <b>una sola memoria</b> de cálculo; no comparten geometría. Se guardan juntos en el .s3d.</p>
      ${rows}
      <div style="display:flex;gap:8px;margin-top:10px">
        <button type="button" id="pj-new" class="btn-secondary" style="font-size:12px">＋ Nuevo modelo</button>
        <button type="button" id="pj-dup" class="btn-secondary" style="font-size:12px">⧉ Duplicar activo</button>
      </div>`;
    document.getElementById('modal-cancel').style.display = '';
    overlay.classList.remove('hidden');
    const closeAnd = (fn) => { overlay.classList.add('hidden'); overlay._resolve = () => {}; overlay._reject = () => {}; fn(); };
    overlay.querySelectorAll('.pj-act').forEach(b => b.addEventListener('click', async () => {
      const id = +b.dataset.id, act = b.dataset.act;
      if (act === 'switch') closeAnd(() => this._projectSwitch(id));
      else if (act === 'del') { const m = this._project.models.find(x => x.id === id); if (await this._confirm(`¿Eliminar el modelo «${esc(m?.name)}» del proyecto?`)) closeAnd(() => this._projectDelete(id)); }
      else if (act === 'rename') {
        const m = this._project.models.find(x => x.id === id);
        const name = await this._promptModal('Renombrar modelo', 'Nombre del modelo', m?.name || '');
        if (name) { m.name = name; if (id === this._project.activeId) this._updateTitle(name); this._renderProjectSelector(); this.markDirty(); closeAnd(() => this._projectDialog()); }
      }
    }));
    document.getElementById('pj-new')?.addEventListener('click', async () => {
      const mode = await this._askModelMode(); if (!mode) return; closeAnd(() => this._projectAddModel(mode));
    });
    document.getElementById('pj-dup')?.addEventListener('click', () => closeAnd(() => this._projectDuplicate()));
    overlay._resolve = () => {}; overlay._reject = () => { overlay.classList.add('hidden'); };
  }

  // Asks 2D/3D (reusable). Returns '2D' | '3D' | null.
  async _askModelMode() {
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = i18n.t('Nuevo modelo');
    document.getElementById('modal-body').innerHTML = `
      <div class="prop-field"><label>Tipo de modelo</label>
        <select id="am-mode" style="width:100%"><option value="3D">Estructura 3D (espacial)</option><option value="2D">Pórtico 2D — plano X–Z</option></select></div>`;
    document.getElementById('modal-cancel').style.display = '';
    overlay.classList.remove('hidden');
    const ok = await new Promise(res => { overlay._resolve = res; overlay._reject = () => res(false); });
    if (!ok) return null;
    return document.getElementById('am-mode')?.value === '2D' ? '2D' : '3D';
  }

  _activeModelEntry() { return this._project.models.find(m => m.id === this._project.activeId); }
  // Serializes the ACTIVE model (with its results/report/view) into its slot.
  _stashActiveModel() {
    const e = this._activeModelEntry(); if (!e) return;
    if (this._modelName) e.name = this._modelName;
    e.json = this._singleSaveJSON();
  }
  // Project file: {portico_project, models:[{id,name,data}], activeId}.
  _buildProjectSaveJSON() {
    this._stashActiveModel();
    return JSON.stringify({
      portico_project: true, version: 1, activeId: this._project.activeId,
      models: this._project.models.map(m => ({ id: m.id, name: m.name, data: JSON.parse(m.json || this.serializer.toJSON(new Model())) })),
    }, null, 2);
  }
  // Loads a project file: builds the list and opens the active model.
  _loadProjectJSON(obj, filename) {
    const models = (obj.models || []).filter(m => m && m.data).map((m, i) => ({ id: m.id ?? (i + 1), name: m.name || `Modelo ${i + 1}`, json: JSON.stringify(m.data) }));
    if (!models.length) { this.toast('Proyecto sin modelos', 'warn'); return; }
    const activeId = models.some(m => m.id === obj.activeId) ? obj.activeId : models[0].id;
    this._project = { models, activeId, nextId: Math.max(...models.map(m => m.id)) + 1 };
    const active = this._activeModelEntry();
    this._loadJSON(active.json, active.name, true, true);   // keepResults + keepProject
    this._renderProjectSelector();
    this.toast(`${i18n.t('Proyecto cargado:')} ${models.length} ${i18n.t('modelo(s) · activo')} «${active.name}»`, 'ok');
  }

  // Fills the (hidden, for compatibility) selector and the side model tree.
  _renderProjectSelector() {
    const sel = document.getElementById('project-select');
    if (sel) sel.innerHTML = this._project.models.map(m => `<option value="${m.id}" ${m.id === this._project.activeId ? 'selected' : ''}>${esc(m.name || ('Modelo ' + m.id))}</option>`).join('');
    this.renderModelTree?.();
  }

  // Switches the active model (stashes the current one in its slot and opens the target).
  _projectSwitch(id) {
    id = +id;
    if (id === this._project.activeId) return;
    const e = this._project.models.find(m => m.id === id); if (!e || !e.json) return;
    this._stashActiveModel();
    this._project.activeId = id;
    this._loadJSON(e.json, e.name, true, true);
    this._renderProjectSelector();
  }

  // Adds a new (empty) model to the project and activates it.
  _projectAddModel(mode = '3D') {
    this._stashActiveModel();
    const id = this._project.nextId++;
    const m = new Model(); m.mode = mode; ensureDefaultLC(m);
    const name = `Modelo ${this._project.models.length + 1}`;
    this._project.models.push({ id, name, json: this.serializer.toJSON(m) });
    this._project.activeId = id;
    this._loadJSON(this._activeModelEntry().json, name, false, true);
    this._renderProjectSelector();
    this.toast(`${i18n.t('Modelo')} «${name}» (${mode}) ${i18n.t('agregado al proyecto')}`, 'ok');
  }

  // Duplicates the active model.
  _projectDuplicate() {
    this._stashActiveModel();
    const cur = this._activeModelEntry(); const id = this._project.nextId++;
    const name = `${cur.name} (copia)`;
    this._project.models.push({ id, name, json: cur.json });
    this._project.activeId = id;
    this._loadJSON(cur.json, name, true, true);
    this._renderProjectSelector();
    this.toast(`${i18n.t('Modelo duplicado:')} «${name}»`, 'ok');
  }

  _projectDelete(id) {
    id = +id;
    if (this._project.models.length <= 1) { this.toast('El proyecto debe tener al menos un modelo', 'warn'); return; }
    const wasActive = id === this._project.activeId;
    this._project.models = this._project.models.filter(m => m.id !== id);
    if (wasActive) { this._project.activeId = this._project.models[0].id; this._loadJSON(this._activeModelEntry().json, this._activeModelEntry().name, true, true); }
    this._renderProjectSelector(); this.markDirty();
  }

  // JSON to save in the .s3d file: model + (if present and applicable) the
  // analysis results embedded, to reopen the file "already run".
  _singleSaveJSON() {
    const modelJSON = this._modelJSONForSave();
    let obj;
    try { obj = JSON.parse(modelJSON); } catch { return modelJSON; }
    // Per-project data: calculation report (#41) and analysis parameters (#39).
    // ALWAYS saved so they travel with the file (not in `_modelJSONForSave`,
    // which feeds `_modelSig` and must not change when editing the report).
    obj.report        = this._projectReport();
    obj.analysisParams = this._gatherAnalysisParams();
    if (this.model.designSettings) obj.designSettings = this.model.designSettings;
    // Groups and hidden elements (view state) — persist in the .s3d.
    if (this._grupos && this._grupos.size)
      obj.groups = [...this._grupos].map(([name, set]) => ({ name, elems: [...set] }));
    if (this.viewport?.hiddenCount?.())
      obj.ocultos = [...this.viewport._hiddenElems];
    if (this._hasSavableResults()) {
      obj.results = {
        sig:          this._resultsCache.sig,
        autoDisc:     !!this._resultsCache.autoDisc,
        activeKey:    this._activeResultKey ?? this._activeLcId,
        showReactions:!!this._showReactions,
        savedAt:      new Date().toISOString(),
        cases:        this._resultsCache.cases,
      };
    }
    return JSON.stringify(obj, null, 2);   // always carries report/analysisParams
  }

  _saveToastMsg() {
    return this._hasSavableResults() ? 'Guardado (con resultados)' : 'Guardado';
  }

  // Adopts the results embedded in a just-loaded .s3d file.
  _adoptEmbeddedResults(e) {
    if (!e || !Array.isArray(e.cases) || !e.cases.length) return false;
    const cb = document.getElementById('auto-disc');
    if (cb) cb.checked = !!e.autoDisc;   // align with the one used when generating the results
    const sig = this._modelSig(!!e.autoDisc);
    if (e.sig && e.sig !== sig) {
      // The file's model was edited after saving the results → ignore them
      this._discardResultsCache();
      this.toast('El archivo trae resultados que no calzan con el modelo (se ignoran)', 'warn');
      return false;
    }
    this._resultsCache = { sig, autoDisc: !!e.autoDisc, cases: e.cases };
    if (e.activeKey != null) this._activeResultKey = e.activeKey;
    this._showReactions = !!e.showReactions;
    this._persistResults();
    this._autoShowResults();   // open showing the results, without pressing anything
    return true;
  }

  // Shows the cached results automatically (without the user pressing Analysis).
  // Reuses the cache → doesn't recompute. Used when opening an "already run" .s3d
  // or when recovering the previous session.
  _autoShowResults() {
    if (!this._resultsCache || !this.model.elements.size) return;
    setTimeout(() => this.runAnalysis(), 250);
  }

  // ── Results persistence (don't recompute every session) ─────────────────────
  // djb2 hash of the original model's JSON (+ auto-disc): detects changes. If the
  // model didn't change, the saved results are still valid.
  _hashStr(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  _modelSig(autoDisc) {
    return this._hashStr(this._modelJSONForSave() + '|ad:' + (autoDisc ? 1 : 0));
  }

  // Rebuilds _resultsByCase from the cached raw vectors, over the current model
  // (already subdivided if applicable). Doesn't solve the system.
  _reconstructResultsFromCache() {
    const cache = this._resultsCache;
    if (!cache || !cache.cases) return false;
    const m = this.model;
    const nodeIndex = buildNodeIndex(m);
    const nDOF = nodeIndex.size * 6;
    const byCase = new Map();
    for (const c of cache.cases) {
      if (!c.u || c.u.length !== nDOF) return false;  // the model doesn't match → recompute
      const u = Float64Array.from(c.u);
      const r = Float64Array.from(c.reactions);
      byCase.set(c.key, new Results(m, nodeIndex, u, r, new Float64Array(nDOF), c.lcId, c.selfWeight));
    }
    // Combos by superposition of the reconstructed cases
    this._resultsByCase = byCase;
    for (const combo of m.combinations.values()) {
      const res = this._combineFromCache(combo);
      if (res) this._resultsByCase.set('C' + combo.id, res);
    }
    return true;
  }

  _persistResults() {
    try {
      localStorage.setItem('portico_results', JSON.stringify({
        sig: this._resultsCache.sig,
        autoDisc: !!this._resultsCache.autoDisc,
        cases: this._resultsCache.cases,
        activeKey: this._activeResultKey ?? this._activeLcId,
        showReactions: !!this._showReactions,
        ts: Date.now(),
      }));
    } catch { /* quota full → the results stay in memory this session */ }
  }

  // On startup: if there are saved results for THIS same model, prepare them
  // for reuse (a click on Analysis shows them without recomputing).
  _offerCachedResults() {
    // If the model already carries embedded results (from a .s3d), they take priority
    if (this._hasSavableResults()) return;
    try {
      const raw = localStorage.getItem('portico_results');
      if (!raw) return;
      const p = JSON.parse(raw);
      const cb = document.getElementById('auto-disc');
      if (cb && p.autoDisc != null) cb.checked = !!p.autoDisc;
      if (p.sig !== this._modelSig(!!p.autoDisc)) { this._discardResultsCache(); return; }
      // The model matches → keep the cache and the saved view state
      this._resultsCache = { sig: p.sig, autoDisc: !!p.autoDisc, cases: p.cases };
      if (p.activeKey != null) this._activeResultKey = p.activeKey;
      this._showReactions = !!p.showReactions;
      this._autoShowResults();   // show the results immediately
    } catch { this._discardResultsCache(); }
  }

  _discardResultsCache() {
    this._resultsCache = null;
    this._activeResultKey = this._activeLcId;
    this._showReactions = false;
    try { localStorage.removeItem('portico_results'); } catch {}
  }

  downloadTemplate() {
    const csv = this.serializer.getTemplate();
    this._downloadText(csv, 'plantilla_portico.csv', 'text/csv;charset=utf-8');
    this.toast('Plantilla descargada', 'ok');
  }

  // ── Utilities ──────────────────────────────────────────────────────────────
  markDirty() {
    this._dirty = true;
    this._updateTitle();
    // Autosave: 1.5 s after the last change (avoids losing work)
    clearTimeout(this._autosaveT);
    this._autosaveT = setTimeout(() => this._autosaveNow(), 1500);
  }

  // ── Multi-slot autosave (#43) ───────────────────────────────────────────────
  // Each SESSION writes to its own slot `portico_autosave_<sid>` (overwritten with
  // the latest state). An index `portico_autosaves` lists the slots so the cover
  // page can offer to recover ANY of the recent sessions, not just the last one.
  // The 6 most recent are kept (the oldest is purged).
  static get _AUTOSAVE_MAX() { return 6; }
  _autosaveNow() {
    try {
      // G7: with multiple models, autosaves the WHOLE PROJECT (the inactive ones
      // aren't lost when recovering the session); with a single one, the usual model.
      const json = (this._project && this._project.models.length > 1) ? this._fullSaveJSON() : this._modelJSONForSave();
      // Don't autosave the empty "new" model (doesn't clutter the index with junk).
      if (this.model.nodes.size === 0 && this._project.models.length <= 1) return;
      const key = 'portico_autosave_' + this._sessionId;
      const name = this._modelName || 'Sin título';
      const meta = { sid: this._sessionId, key, ts: Date.now(), name,
                     n: this.model.nodes.size, e: this.model.elements.size + (this.model.areas?.size || 0) };
      localStorage.setItem(key, JSON.stringify({ ...meta, json }));
      // Index: upsert this session, sorted by ts desc, capped at _AUTOSAVE_MAX.
      let idx = [];
      try { idx = JSON.parse(localStorage.getItem('portico_autosaves') || '[]'); } catch {}
      idx = idx.filter(x => x && x.sid !== this._sessionId);
      idx.unshift(meta);
      while (idx.length > App._AUTOSAVE_MAX) {
        const drop = idx.pop();
        if (drop?.key) try { localStorage.removeItem(drop.key); } catch {}
      }
      localStorage.setItem('portico_autosaves', JSON.stringify(idx));
    } catch { /* localStorage quota full — ignore */ }
  }

  // List of recoverable autosaves (new index + legacy key), most recent first.
  // Each entry: { key, ts, name, n, e, legacy? }.
  _autosaveList() {
    const out = [];
    try {
      const idx = JSON.parse(localStorage.getItem('portico_autosaves') || '[]');
      for (const x of idx) if (x && x.key && localStorage.getItem(x.key)) out.push(x);
    } catch {}
    // Compatibility: old single key `portico_autosave`.
    try {
      const raw = localStorage.getItem('portico_autosave');
      if (raw) { const o = JSON.parse(raw); out.push({ key: 'portico_autosave', ts: o.ts || 0, name: 'Sesión anterior', n: '?', e: '?', legacy: true }); }
    } catch {}
    return out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  }

  // Recovery dialog: lists the autosaves and lets you resume any, delete one, or
  // start new. Resolves with the chosen JSON or null (new).
  _autosaveRecoveryDialog(list) {
    return new Promise(resolve => {
      document.getElementById('autosave-recover')?.remove();
      const fmt = ts => ts ? new Date(ts).toLocaleString('es-CL') : '—';
      const el = document.createElement('div');
      el.id = 'autosave-recover';
      el.style.cssText = 'position:fixed;inset:0;z-index:100001;display:flex;align-items:center;justify-content:center;background:rgba(6,10,18,.74);backdrop-filter:blur(2px)';
      const rows = list.map((x, i) => `
        <div class="asr-row" style="display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--border,#334);border-radius:7px;margin-bottom:6px">
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(x.name || 'Sin título')}</div>
            <div style="font-size:11px;color:var(--text-muted,#9aa)">${fmt(x.ts)} · ${x.n} nodos · ${x.e} elem.</div>
          </div>
          <button class="btn-primary asr-load" data-i="${i}" style="font-size:12px;padding:5px 10px">Reanudar</button>
          <button class="asr-del" data-i="${i}" title="Eliminar" style="background:none;border:none;color:var(--text-muted,#9aa);cursor:pointer;font-size:15px">🗑</button>
        </div>`).join('');
      el.innerHTML = `
        <div style="width:min(480px,92%);background:var(--bg-elev,#141b27);border:1px solid var(--border,#334);border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.5);color:var(--text,#e6edf3);padding:16px 18px">
          <div style="font-size:15px;font-weight:700;margin-bottom:4px">Recuperar trabajo autoguardado</div>
          <div style="font-size:12px;color:var(--text-muted,#9aa);margin-bottom:12px">Se encontraron modelos guardados automáticamente. Reanude cualquiera o empiece uno nuevo.</div>
          <div id="asr-list">${rows}</div>
          <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:10px">
            <button id="asr-new" class="btn" style="font-size:12px;padding:6px 12px">Empezar nuevo (vacío)</button>
          </div>
        </div>`;
      document.body.appendChild(el);
      // Auto-close on inactivity (#83): if nobody interacts with the dialog within
      // ~8 s, it resolves as "start new" (empty model) so it doesn't block startup.
      // Any interaction within the dialog resets the counter.
      let idleT = null;
      const resetIdle = () => { clearTimeout(idleT); idleT = setTimeout(() => done(null), 8000); };
      const done = (val) => { clearTimeout(idleT); el.remove(); resolve(val); };
      ['pointerdown', 'pointermove', 'keydown', 'wheel'].forEach(ev => el.addEventListener(ev, resetIdle, true));
      resetIdle();
      el.querySelectorAll('.asr-load').forEach(b => b.addEventListener('click', () => {
        const x = list[+b.dataset.i];
        try { const o = JSON.parse(localStorage.getItem(x.key)); done({ json: o.json, name: x.name }); }
        catch { this.toast('No se pudo leer el autoguardado', 'error'); done(null); }
      }));
      el.querySelectorAll('.asr-del').forEach(b => b.addEventListener('click', () => {
        const x = list[+b.dataset.i];
        try { localStorage.removeItem(x.key); } catch {}
        if (!x.legacy) { try { const idx = JSON.parse(localStorage.getItem('portico_autosaves') || '[]').filter(y => y.key !== x.key); localStorage.setItem('portico_autosaves', JSON.stringify(idx)); } catch {} }
        list.splice(+b.dataset.i, 1);
        if (!list.length) done(null);
        else { el.remove(); this._autosaveRecoveryDialog(list).then(resolve); }
      }));
      el.querySelector('#asr-new').addEventListener('click', () => done(null));
    });
  }

  // Deletes an autosave slot (and removes it from the index unless it's the legacy key).
  _deleteAutosave(key, legacy) {
    try { localStorage.removeItem(key); } catch {}
    if (!legacy) {
      try {
        const idx = JSON.parse(localStorage.getItem('portico_autosaves') || '[]').filter(y => y.key !== key);
        localStorage.setItem('portico_autosaves', JSON.stringify(idx));
      } catch {}
    }
  }

  // Temporary autosave management (#82): lists the accumulated `portico_autosave_*`
  // slots, lets you delete each one, clear them ALL, or resume one (discarding the
  // current work). Accessible at any time (File → «Temporary autosaves…»), not just
  // at startup.
  manageAutosavesDialog() {
    document.getElementById('autosave-manage')?.remove();
    const el = document.createElement('div');
    el.id = 'autosave-manage';
    el.style.cssText = 'position:fixed;inset:0;z-index:100002;display:flex;align-items:center;justify-content:center;background:rgba(6,10,18,.6);backdrop-filter:blur(2px)';
    const close = () => el.remove();
    const paint = () => {
      const list = this._autosaveList();
      const cur = 'portico_autosave_' + this._sessionId;
      const fmt = ts => ts ? new Date(ts).toLocaleString('es-CL') : '—';
      const esc = s => (s || 'Sin título').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
      const rows = list.map((x, i) => `
        <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--border,#334);border-radius:7px;margin-bottom:6px">
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(x.name)}${x.key === cur ? ' <span style="color:var(--accent,#38bdf8);font-weight:400">· sesión actual</span>' : ''}</div>
            <div style="font-size:11px;color:var(--text-muted,#9aa)">${fmt(x.ts)} · ${x.n} nodos · ${x.e} elem.</div>
          </div>
          <button class="asm-load" data-i="${i}" style="font-size:12px;padding:5px 10px">Reanudar</button>
          <button class="asm-del" data-i="${i}" title="Eliminar" style="background:none;border:none;color:var(--text-muted,#9aa);cursor:pointer;font-size:15px">🗑</button>
        </div>`).join('') || '<div style="font-size:12px;color:var(--text-muted,#9aa);padding:6px 0">No hay autoguardados temporales.</div>';
      el.innerHTML = `
        <div style="width:min(500px,92%);background:var(--bg-elev,#141b27);border:1px solid var(--border,#334);border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.5);color:var(--text,#e6edf3);padding:16px 18px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
            <div style="font-size:15px;font-weight:700">🧹 Autoguardados temporales</div>
            <button id="asm-x" style="background:none;border:none;color:var(--text-muted,#9aa);cursor:pointer;font-size:16px">✕</button>
          </div>
          <div style="font-size:12px;color:var(--text-muted,#9aa);margin-bottom:12px">Copias automáticas recientes (${list.length}). Reanude una (descarta el trabajo actual no guardado), elimine las que no use, o límpielas todas.</div>
          <div>${rows}</div>
          <div style="display:flex;justify-content:space-between;gap:8px;margin-top:10px">
            <button id="asm-clear" style="font-size:12px;padding:6px 12px" ${list.length ? '' : 'disabled'}>🧹 Limpiar todos</button>
            <button id="asm-close" class="btn-primary" style="font-size:12px;padding:6px 12px">Cerrar</button>
          </div>
        </div>`;
      el.querySelector('#asm-x').addEventListener('click', close);
      el.querySelector('#asm-close').addEventListener('click', close);
      el.querySelectorAll('.asm-del').forEach(b => b.addEventListener('click', () => {
        const x = list[+b.dataset.i]; this._deleteAutosave(x.key, x.legacy); paint();
      }));
      el.querySelectorAll('.asm-load').forEach(b => b.addEventListener('click', async () => {
        const x = list[+b.dataset.i];
        const ok = await this._confirm(`¿Reanudar "${esc(x.name || 'Sin título')}"? Se descartará el trabajo actual no guardado.`);
        if (!ok) return;
        try { const o = JSON.parse(localStorage.getItem(x.key)); close(); this._loadJSON(o.json, x.name || 'autoguardado', true); this.toast('Autoguardado reanudado', 'ok'); }
        catch { this.toast('No se pudo leer el autoguardado', 'error'); }
      }));
      el.querySelector('#asm-clear').addEventListener('click', async () => {
        const ok = await this._confirm('¿Eliminar TODOS los autoguardados temporales? (No afecta el modelo abierto.)');
        if (!ok) return;
        for (const x of list) this._deleteAutosave(x.key, x.legacy);
        this.toast('Autoguardados temporales eliminados', 'ok'); paint();
      });
    };
    document.body.appendChild(el);
    paint();
  }

  // «Temporaries» tab (#82): same autosave list as the dialog, but INLINE in the
  // right panel (persistent, not modal). Repainted when opening the tab.
  renderTemporales() { this._fillTemporales(document.getElementById('temporales-body')); }

  // Repaints all the temporaries containers (right panel + side tree).
  _refreshTemp() {
    this._fillTemporales(document.getElementById('temporales-body'));
    this._fillTemporales(document.getElementById('mt-temporales'));
  }

  // Fills a container with the list of temporary autosaves.
  _fillTemporales(box) {
    if (!box) return;
    const list = this._autosaveList();
    const cur = 'portico_autosave_' + this._sessionId;
    const fmt = ts => ts ? new Date(ts).toLocaleString('es-CL') : '—';
    const esc = s => (s || 'Sin título').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    box.innerHTML = list.map((x, i) => `
      <div style="display:flex;align-items:center;gap:6px;padding:7px 8px;border:1px solid var(--border,#334);border-radius:7px;margin-bottom:6px">
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(x.name)}${x.key === cur ? ' <span style="color:var(--accent,#38bdf8);font-weight:400">· actual</span>' : ''}</div>
          <div style="font-size:10.5px;color:var(--text-muted,#9aa)">${fmt(x.ts)} · ${x.n} nodos · ${x.e} elem.</div>
        </div>
        <button class="temp-load" data-i="${i}" style="font-size:11px;padding:4px 9px">Reanudar</button>
        <button class="temp-del" data-i="${i}" title="Eliminar este autoguardado" style="background:none;border:none;color:var(--text-muted,#9aa);cursor:pointer;font-size:14px">🗑</button>
      </div>`).join('') || '<div style="font-size:12px;color:var(--text-muted,#9aa);padding:6px 0">No hay autoguardados temporales.</div>';
    box.querySelectorAll('.temp-del').forEach(b => b.addEventListener('click', () => {
      const x = list[+b.dataset.i]; this._deleteAutosave(x.key, x.legacy); this._refreshTemp();
    }));
    box.querySelectorAll('.temp-load').forEach(b => b.addEventListener('click', async () => {
      const x = list[+b.dataset.i];
      const ok = await this._confirm(`¿Reanudar "${esc(x.name || 'Sin título')}"? Se descartará el trabajo actual no guardado.`);
      if (!ok) return;
      try { const o = JSON.parse(localStorage.getItem(x.key)); this._loadJSON(o.json, x.name || 'autoguardado', true); this.toast('Autoguardado reanudado', 'ok'); this._refreshTemp(); }
      catch { this.toast('No se pudo leer el autoguardado', 'error'); }
    }));
  }

  // «Clear all» from the Temporaries tab.
  async clearAllTemporales() {
    const list = this._autosaveList();
    if (!list.length) { this.toast('No hay autoguardados temporales', 'info'); return; }
    const ok = await this._confirm('¿Eliminar TODOS los autoguardados temporales? (No afecta el modelo abierto.)');
    if (!ok) return;
    for (const x of list) this._deleteAutosave(x.key, x.legacy);
    this.toast('Autoguardados temporales eliminados', 'ok');
    this._refreshTemp();
  }

  // On startup: offer to recover an autosaved session; otherwise, a new model.
  // Once there's a model, offer the saved results if they match.
  async _restoreOrLoadExample() {
    let restored = false;
    try {
      const list = this._autosaveList();
      if (list.length) {
        const choice = await this._autosaveRecoveryDialog(list);
        if (choice && choice.json) {
          this._loadJSON(choice.json, choice.name || 'autoguardado', true);   // keepResults
          this.toast('Trabajo autoguardado recuperado', 'ok');
          restored = true;
        }
      }
    } catch (e) { console.warn('Autosave: no se pudo recuperar', e); }
    if (!restored) {
      // ALWAYS start with a new, empty model (no example is loaded).
      this._loadJSON(this.serializer.toJSON(this.model), 'nuevo', false);
    }
    this.viewport.applyProjectMode();   // badge + camera per the model's mode
    // If entered from the cover page with "Generate model with the assistant", open
    // NOW the "Assistant — generate model from spec" dialog (after recovering the
    // session / loading the model, which free the modal-overlay) and do NOT
    // auto-show cached results, so the assistant stays in front.
    if (window.__porticoGoAssistant) {
      window.__porticoGoAssistant = false;
      this.assistantDialog();
    } else {
      this._offerCachedResults();
    }
    this._ready = true;   // init complete: the cover page can open the assistant directly
  }

  _updateTitle(filename) {
    const raw = filename
      ? filename.replace(/\.[^.]+$/, '')
      : (this._modelName || (this._fileHandle ? 'modelo' : 'Sin título'));
    if (filename) this._modelName = raw;   // remembered for the autosave (#43)
    // Built-in default labels are translated for the tab title; real file names
    // pass through unchanged. Kept local (not in the global i18n dict) so the DOM
    // walker never rewrites stray "nuevo"/"modelo" text nodes elsewhere.
    const DEFAULT_LABELS = {
      'nuevo': 'Untitled', 'Sin título': 'Untitled',
      'modelo': 'Untitled', 'autoguardado': 'Autosaved',
    };
    const name = (i18n.getLocale() === 'en' && DEFAULT_LABELS[raw]) ? DEFAULT_LABELS[raw] : raw;
    document.title = (this._dirty ? '● ' : '') + `${name} — ${getBranding().appName}`;
  }

  _updateStats() {
    const s = this.model.getStats();
    document.getElementById('sb-model').textContent =
      `${i18n.t('Nodos:')} ${s.nodes} | Elem: ${s.elements} | Mat: ${s.materials} | Sec: ${s.sections}`;
  }

  // ── PERMANENT results indicator (status bar) ────────────────────────────────
  // Summarizes which analyses have results available, outside the Analysis Center.
  // Click → opens the hub. Called after running/clearing any analysis.
  _updateResultsIndicator() {
    const el = document.getElementById('sb-results');
    if (!el) return;
    const partes = [];
    if (this._tieneEstaticos?.()) partes.push(i18n.t('Estático'));
    if (this._modalResults) partes.push('Modal');
    if (this._spectrumResults?.size) partes.push(`${this._spectrumResults.size} ${i18n.t('esp')}`);
    if (this._buckResult) partes.push(i18n.t('Pandeo'));
    if (partes.length) {
      el.textContent = '✓ ' + partes.join(' · ');
      el.style.color = 'var(--ok, #34c759)';
      el.title = i18n.t('Resultados disponibles:') + ' ' + partes.join(', ') + ' — ' + i18n.t('clic para abrir el Centro de análisis');
    } else {
      el.textContent = i18n.t('Sin resultados');
      el.style.color = 'var(--text-muted, #9aa)';
      el.title = i18n.t('Aún no hay análisis ejecutados — clic para abrir el Centro de análisis');
    }
  }

  _downloadText(content, filename, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type }));
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // ── P2-5: Export viewport as PNG ──────────────────────────────────────────
  exportViewportPNG() {
    // Force a render pass so the canvas buffer is current
    this.viewport._renderer.render(this.viewport._scene, this.viewport._camera);
    const url = this.viewport._renderer.domElement.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = `portico_${new Date().toISOString().slice(0,19).replace(/[T:]/g,'-')}.png`;
    a.click();
    this.toast('Imagen exportada', 'ok');
  }

  // ── Calculation report / Design basis (PDF-printable document) ──────────────
  async generateCalcBasis() {
    if (this.model.nodes.size === 0) {
      this.toast('Modelo vacío — nada que documentar', 'warn'); return;
    }
    this.toast('Generando memoria de cálculo…');
    // G7: with multiple models, the report ITERATES over them (each one a chapter).
    const html = (this._project && this._project.models.length > 1)
      ? await this._reportProjectHTML()
      : await (async () => {
          let imgs = { base: null, deformada: null, modos: [] };
          try { imgs = await this._captureReportViews(); } catch (e) { console.error('Captura de vistas falló:', e); }
          const diseno = await this._computeDesign();
          const deflex = this._computeBeamDeflections(diseno?.params);
          const drift  = this._computeDrift();
          return this._reportHTML(imgs, diseno, deflex, drift);
        })();

    const win = window.open('', '_blank');
    if (!win) {
      this._downloadText(html, 'memoria_calculo.html', 'text/html;charset=utf-8');
      this.toast('Pop-up bloqueado — memoria descargada como HTML', 'warn');
      return;
    }
    win.document.open();
    win.document.write(html);
    win.document.close();
    this.toast('Memoria generada — use «Imprimir → Guardar como PDF»', 'ok');
  }

  // G7: HTML report that ITERATES over all the project's models. Switches to each
  // (restoring its results), builds its section and at the end returns to the original
  // active one. Each model is a chapter with a page break; they share the <head>/styles.
  async _reportProjectHTML() {
    const orig = this._project.activeId;
    this._stashActiveModel();
    const docs = [];
    for (const entry of this._project.models) {
      this._projectSwitch(entry.id);
      await new Promise(r => setTimeout(r, 80));   // let the render settle to capture views
      if (this.model.nodes.size === 0) continue;
      let imgs = { base: null, deformada: null, modos: [] };
      try { imgs = await this._captureReportViews(); } catch (e) { console.error('Captura de vistas falló:', e); }
      const diseno = await this._computeDesign();
      const deflex = this._computeBeamDeflections(diseno?.params);
      const drift  = this._computeDrift();
      docs.push({ name: entry.name, html: this._reportHTML(imgs, diseno, deflex, drift) });
    }
    this._projectSwitch(orig);
    if (!docs.length) return this._reportHTML({ base: null, deformada: null, modos: [] }, null, null, null);
    const bodyOf = (h) => { const i = h.indexOf('<body>') + 6, j = h.indexOf('</body>'); return h.slice(i, j); };
    const head = docs[0].html.slice(0, docs[0].html.indexOf('<body>') + 6);
    const sections = docs.map((d, i) => `
      <div style="page-break-before:${i ? 'always' : 'auto'}">
        <h1 style="border-bottom:3px solid #1d4ed8;padding-bottom:6px;margin-top:0">${i18n.t('Modelo')} ${i + 1} · ${esc(d.name)}</h1>
        ${bodyOf(d.html)}
      </div>`).join('\n');
    return head + sections + '\n</body></html>';
  }

  // ── Calculation report in Word (.docx) ──────────────────────────────────────
  // Same information as the HTML/PDF report, but as an editable Word document.
  // The .docx is built with a self-contained generator (js/io/docx.js): no build
  // or dependencies required.
  async generateReportDocx() {
    // G7: with multiple models, the Word report ITERATES over them (one chapter each), like the HTML/PDF.
    const multi = !!(this._project && this._project.models.length > 1);
    if (!multi && this.model.nodes.size === 0) { this.toast('Modelo vacío — nada que documentar', 'warn'); return; }
    this.toast('Generando memoria (Word)…');
    try {
      const { Docx } = await import('./io/docx.js?v=2');
      let d;
      if (multi) {
        d = await this._reportProjectDocx(Docx);
      } else {
        let imgs = { base: null, deformada: null, modos: [] };
        try { imgs = await this._captureReportViews(); } catch (e) { console.error('Captura de vistas falló:', e); }
        const diseno = await this._computeDesign();
        const deflex = this._computeBeamDeflections(diseno?.params);
        const drift  = this._computeDrift();
        d = this._reportDocx(Docx, imgs, diseno, deflex, drift);
      }
      this._downloadBlob(d.blob(), multi ? 'memoria_proyecto.docx' : 'memoria_calculo.docx');
      this.toast(i18n.t('Memoria Word (.docx) descargada') + (multi ? ` — ${this._project.models.length} ${i18n.t('modelos')}` : ''), 'ok');
    } catch (e) {
      console.error('Memoria .docx falló:', e);
      this.toast(i18n.t('No se pudo generar el .docx:') + ' ' + e.message, 'error');
    }
  }

  // Builds the Word document for ONE model: cover page + sections 1–8.
  _reportDocx(Docx, imgs, diseno, deflex, drift) {
    const d = new Docx();
    this._reportDocxCover(d);
    d.pageBreak();
    this._reportDocxBody(d, imgs, diseno, deflex, drift);
    return d;
  }

  // G7: Word report that ITERATES over all the project's models (one chapter each,
  // with the same information as the HTML/PDF). Switches to each model to capture its
  // views and results, and at the end returns to the original active one. Mirror of _reportProjectHTML.
  async _reportProjectDocx(Docx) {
    const d = new Docx();
    const orig = this._project.activeId;
    this._stashActiveModel();
    this._reportDocxCover(d, { nModelos: this._project.models.length });
    let i = 0;
    for (const entry of this._project.models) {
      this._projectSwitch(entry.id);
      await new Promise(r => setTimeout(r, 80));   // let the render settle to capture views
      if (this.model.nodes.size === 0) continue;
      let imgs = { base: null, deformada: null, modos: [] };
      try { imgs = await this._captureReportViews(); } catch (e) { console.error('Captura de vistas falló:', e); }
      const diseno = await this._computeDesign();
      const deflex = this._computeBeamDeflections(diseno?.params);
      const drift  = this._computeDrift();
      d.pageBreak();
      d.heading(`${i18n.t('Modelo')} ${++i} · ${entry.name || (i18n.t('Modelo') + ' ' + entry.id)}`, 1);
      this._reportDocxBody(d, imgs, diseno, deflex, drift);
    }
    this._projectSwitch(orig);
    return d;
  }

  // Cover page of the Word report (institution/logo, title and identification table).
  _reportDocxCover(d, opts = {}) {
    const cm = this._report();
    const proyecto = (document.title || '').replace(/^●\s*/, '').replace(/\s*—\s*[^—]*$/, '').trim() || i18n.t('Modelo sin título');
    const fecha = new Date().toLocaleDateString(i18n.getLocale() === 'en' ? 'en-US' : 'es-CL', { year: 'numeric', month: 'long', day: 'numeric' });
    const U = this.model.units || 'kN-m';
    const tieneLogoPro = !!(this._brandingPro && cm.logoEmpresa);
    if (tieneLogoPro) d.image(cm.logoEmpresa, '', 2 * 914400);   // company logo (if PNG/JPEG)
    if (!tieneLogoPro)
      d.paragraph([{ text: cm.institucion || '', bold: true, color: '0A3A57', size: 13 }], { align: 'center' })
       .paragraph([{ text: cm.subInstitucion || '', color: '5C6A7D', size: 10 }], { align: 'center' });
    d.spacer();
    d.paragraph([{ text: cm.kicker || i18n.t('ANÁLISIS Y DISEÑO ESTRUCTURAL'), color: '0D9488', bold: true, size: 11 }], { align: 'center' });
    d.paragraph([{ text: cm.titulo || i18n.t('Memoria de Cálculo'), bold: true, color: '0A3A57', size: 26 }], { align: 'center' });
    d.paragraph([{ text: proyecto, size: 13 }], { align: 'center' });
    if (opts.nModelos > 1) d.paragraph([{ text: `${i18n.t('Proyecto de')} ${opts.nModelos} ${i18n.t('modelos')}`, color: '0D9488', size: 10 }], { align: 'center' });
    d.spacer();
    d.table(null, [
      [{ text: i18n.t('Proyecto'), bold: true }, proyecto],
      [{ text: i18n.t('Fecha'), bold: true }, fecha],
      [{ text: i18n.t('Unidades'), bold: true }, U.replace('-', ' · ')],
      [{ text: i18n.t('Proyectista'), bold: true }, cm.proyectista || ''],
      [{ text: i18n.t('Revisó'), bold: true }, cm.revisor || ''],
    ]);
    d.paragraph([{ text: i18n.t('Documento de carácter orientativo. Los resultados deben ser validados por un profesional competente antes de cualquier uso en obra.'), italic: true, color: '5C6A7D', size: 9 }], { align: 'center' });
    if (this._brandingPro && cm.descripcion) d.paragraph(cm.descripcion);
  }

  // Sections 1–8 of the report for the ACTIVE model (appended to `d`).
  _reportDocxBody(d, imgs, diseno, deflex, drift) {
    const m = this.model;
    const cm = this._report();   // effective report: per-project + global defaults (#41)
    const fmt = (v, dec = 3) => (v == null || !isFinite(v)) ? '—'
      : (Math.abs(v) >= 1e5 || (Math.abs(v) > 0 && Math.abs(v) < 1e-3) ? (+v).toExponential(2) : (+v).toFixed(dec));
    const stripTags = s => String(s ?? '').replace(/<[^>]+>/g, '');

    // ── 1. Design basis ──
    d.heading(i18n.t('1. Bases de cálculo'), 1);
    const s = m.getStats();
    d.heading(i18n.t('1.1 Modelo estructural'), 2);
    d.table([i18n.t('Magnitud'), i18n.t('Cantidad')], [
      [i18n.t('Nodos'), String(s.nodes)], [i18n.t('Elementos (barras)'), String(s.elements)],
      [i18n.t('Áreas (membrana/placa/shell)'), String(m.areas?.size || 0)],
      [i18n.t('Materiales'), String(s.materials)], [i18n.t('Secciones'), String(s.sections)],
      [i18n.t('Diafragmas rígidos'), String(m.diaphragms?.size || 0)],
      [i18n.t('Casos de carga'), String(m.loadCases?.size || 0)], [i18n.t('Combinaciones'), String(m.combinations?.size || 0)],
    ]);

    d.heading(i18n.t('1.2 Materiales'), 2);
    d.table([i18n.t('Material'), 'E', 'G', 'ν', 'ρ'],
      [...m.materials.values()].map(mt => [mt.name, fmt(mt.E, 0), fmt(mt.G, 0), fmt(mt.nu, 2), fmt(mt.rho, 3)]));

    d.heading(i18n.t('1.3 Secciones'), 2);
    const secCount = new Map();
    for (const el of m.elements.values()) secCount.set(el.secId, (secCount.get(el.secId) || 0) + 1);
    d.table([i18n.t('Sección'), 'A', 'Iy', 'Iz', 'J', i18n.t('N° elem.')],
      [...m.sections.values()].map(sec => [sec.name, fmt(sec.A, 5), fmt(sec.Iy, 6), fmt(sec.Iz, 6), fmt(sec.J, 6), String(secCount.get(sec.id) || 0)]));

    // ── 2. Loads and combinations ──
    d.heading(i18n.t('2. Cargas y combinaciones'), 1);
    const dirLabel = { gravity: i18n.t('Gravedad (−Z)'), globalX: i18n.t('Global +X'), globalY: i18n.t('Global +Y'), globalZ: i18n.t('Global +Z'), localY: i18n.t('Local y'), localZ: i18n.t('Local z') };
    for (const lc of [...m.loadCases.values()].filter(l => l.type !== 'spectrum')) {
      d.heading(`${lc.name}${lc.selfWeight ? '  ' + i18n.t('(+ peso propio)') : ''}`, 3);
      const rows = (lc.loads || []).map(ld => {
        if (ld.type === 'nodal') { const F = ld.F || []; return [i18n.t('Puntual'), `${i18n.t('Nodo')} ${ld.nodeId}`, `F=(${fmt(F[0], 1)}, ${fmt(F[1], 1)}, ${fmt(F[2], 1)}) kN`]; }
        if (ld.type === 'temp') return [i18n.t('Temperatura'), `${i18n.t('Elem')} ${ld.elemId}`, `ΔT = ${fmt(ld.dT, 1)} °C`];
        return [i18n.t('Distribuida'), `${i18n.t('Elem')} ${ld.elemId}`, `w = ${fmt(ld.w, 2)} kN/m · ${dirLabel[ld.dir] || ld.dir || i18n.t('gravedad')}`];
      });
      if (rows.length) d.table([i18n.t('Tipo'), i18n.t('Aplicada en'), i18n.t('Valor')], rows);
      else d.paragraph([{ text: lc.selfWeight ? i18n.t('Solo peso propio.') : i18n.t('Sin cargas asignadas.'), italic: true, color: '5C6A7D' }]);
    }
    const lcName = id => m.loadCases.get(id)?.name || m.combinations?.get(id)?.name || `LC${id}`;
    if (m.combinations?.size) {
      d.heading(i18n.t('2.1 Combinaciones'), 2);
      d.table([i18n.t('Combinación'), i18n.t('Definición')],
        [...m.combinations.values()].map(c => [c.name, (c.factors || []).map(f => `${fmt(f.factor, 2)}·${lcName(f.lcId)}`).join('  +  ') || '—']));
    }

    // ── 3. Figures ──
    d.heading(i18n.t('3. Modelo y deformada'), 1);
    if (imgs.base) d.image(imgs.base, i18n.t('Modelo estructural (geometría base)'));
    if (imgs.deformada) d.image(imgs.deformada, i18n.t('Deformada (resultado estático)'));

    // ── 4. Modal analysis ──
    if (this._modalResults) {
      d.heading(i18n.t('4. Análisis modal'), 1);
      const { rows } = this._modalResults.getParticipation();
      d.paragraph(`${i18n.t('Modos extraídos:')} ${this._modalResults.nModes}.`);
      d.table([i18n.t('Modo'), 'f (Hz)', 'T (s)', 'Mx %', 'My %', 'Mrz %', 'ΣMx', 'ΣMy', 'ΣMrz'],
        rows.slice(0, 12).map(r => [String(r.mode), fmt(r.freq, 3), fmt(r.period, 3),
          fmt(r.pct[0], 1), fmt(r.pct[1], 1), fmt(r.pct[2], 1), fmt(r.cumPct[0], 1), fmt(r.cumPct[1], 1), fmt(r.cumPct[2], 1)]));
      for (const md of imgs.modos) d.image(md.img, `${i18n.t('Modo')} ${md.n} — f = ${fmt(md.freq, 3)} Hz · T = ${fmt(md.period, 3)} s`);
    }

    // ── 5. Strength verification (D/C) ──
    d.heading(i18n.t('5. Verificación de resistencia (D/C)'), 1);
    if (diseno?.filas?.length) {
      const f = diseno.filas;
      const colorR = r => r > 1 ? 'DC2626' : r > 0.9 ? 'B45309' : '15803D';
      const estado = r => r > 1 ? i18n.t('NO CUMPLE') : r > 0.9 ? i18n.t('ajustado') : i18n.t('cumple');
      const alcance = diseno.envolvente ? i18n.t('envolvente de las combinaciones') : `${i18n.t('el estado')} «${diseno.caso || i18n.t('activo')}»`;
      d.paragraph(`${i18n.t('Verificación por')} ${alcance}. ${i18n.t('La razón D/C = demanda/capacidad debe ser ≤ 1.0.')}`);
      d.table([i18n.t('Elem'), i18n.t('Sección'), i18n.t('Material'), 'N (kN)', 'M (kN·m)', 'V (kN)', i18n.t('D/C máx'), i18n.t('Gobierna'), i18n.t('Estado')],
        f.slice(0, 60).map(x => [
          `#${x.id}`, x.sec, x.mat, fmt(x.forces.N, 1),
          fmt(Math.max(x.forces.My, x.forces.Mz), 1), fmt(Math.max(x.forces.Vy, x.forces.Vz), 1),
          { text: fmt(x.ratioMax, 2), bold: true, color: colorR(x.ratioMax) },
          String(x.governs ?? '—'),
          { text: estado(x.ratioMax), color: colorR(x.ratioMax) },
        ]));
      const nNo = f.filter(x => x.ratioMax > 1).length, nAj = f.filter(x => x.ratioMax > 0.9 && x.ratioMax <= 1).length;
      const shown = f.length > 60 ? `${i18n.t('Se muestran los 60 elementos más solicitados de')} ${f.length}. ` : '';
      d.paragraph(`${shown}${i18n.t('Resumen:')} ${f.length - nNo - nAj} ${i18n.t('cumplen')} · ${nAj} ${i18n.t('ajustados')} · ${nNo} ${i18n.t('no cumplen')}.`);
    } else {
      d.paragraph([{ text: i18n.t('No hay resultados de análisis para verificar. Ejecute el análisis estático (F5) con sus combinaciones de carga antes de generar la memoria.'), italic: true, color: '5C6A7D' }]);
    }

    // ── 6. Service: beam deflections ──
    d.heading(i18n.t('6. Deformaciones de vigas (servicio)'), 1);
    if (deflex?.rows?.length) {
      const colorR = r => r > 1 ? 'DC2626' : r > 0.9 ? 'B45309' : '15803D';
      d.paragraph(`${i18n.t('Flecha de vigas bajo')} «${deflex.caso}» ${i18n.t('sin mayorar, respecto a la cuerda del vano.')} ${i18n.t('Límite de servicio')} L/${deflex.limSobre}.`);
      d.table([i18n.t('Viga'), i18n.t('Sección'), 'L (m)', 'δ (mm)', 'δ adm (mm)', 'δ/δadm', i18n.t('Estado')],
        deflex.rows.slice(0, 60).map(x => [
          `#${x.id}`, x.sec, fmt(x.L, 2), fmt(x.delta * 1000, 2), fmt(x.lim * 1000, 2),
          { text: fmt(x.ratio, 2), bold: true, color: colorR(x.ratio) },
          { text: x.ratio > 1 ? i18n.t('NO CUMPLE') : x.ratio > 0.9 ? i18n.t('ajustado') : i18n.t('cumple'), color: colorR(x.ratio) },
        ]));
    } else d.paragraph([{ text: stripTags(deflex?.note || i18n.t('Sin datos de deformaciones de vigas.')), italic: true, color: '5C6A7D' }]);

    // ── 7. Seismic drifts ──
    d.heading(i18n.t('7. Derivas sísmicas de entrepiso (NCh433)'), 1);
    if (drift?.dirs?.length) {
      for (const D of drift.dirs) {
        d.heading(`${i18n.t('Dirección sísmica')} ${D.dir}`, 3);
        d.table([i18n.t('Piso'), 'Z (m)', 'h (m)', 'δ/h (CM)', '·/0.002', 'δ/h (ext.)', '·/0.002'],
          D.stories.map(st => [String(st.piso), fmt(st.z, 2), fmt(st.h, 2),
            st.driftCM == null ? '—' : fmt(st.driftCM, 5), st.ratioCM == null ? '—' : fmt(st.ratioCM, 2),
            fmt(st.driftExt, 5), fmt(st.ratioExt, 2)]));
      }
      d.paragraph([{ text: i18n.t('Límite NCh433: 0.002 (2/1000·h). Calculada con los desplazamientos del espectro de respuesta.'), color: '5C6A7D', size: 9 }]);
    } else d.paragraph([{ text: stripTags(drift?.note || i18n.t('Sin datos de derivas sísmicas.')), italic: true, color: '5C6A7D' }]);

    // ── 8. Limitations ──
    d.heading(i18n.t('8. Alcances y limitaciones'), 1);
    const limits = (this._brandingPro && cm.limitaciones)
      ? cm.limitaciones.split('\n').map(x => x.trim()).filter(Boolean)
      : this._ACAD_LIMITS;
    for (const li of limits) d.paragraph([{ text: '• ' + stripTags(li), size: 9, color: '5C6A7D' }]);
    d.spacer();
    d.paragraph([{ text: (this._brandingPro && cm.footer) ? cm.footer : this._ACAD_FOOTER, italic: true, color: '5C6A7D', size: 9 }], { align: 'center' });
  }

  _downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // Design verification (bending/shear/axial) per element, using the current
  // results and the editable parameters from assistant/design_params.json.
  async _computeDesign() {
    const ver = '?v=2';
    let params = null;
    try { params = await fetch('assistant/design_params.json' + ver).then(r => r.json()); }
    catch (e) { console.error('No se pudo cargar design_params.json:', e); return null; }
    // No results: we still return the parameters (methods/codes/deflections).
    if (!this._results || typeof this._results.getElemForces !== 'function') {
      return { filas: [], params, caso: null };
    }
    try {
      const mod = await import('./design/design.js' + ver);

      // ── Set of design results: ENVELOPE over combinations ──
      // (the combos are the factored ULS states). If no combos are solved,
      // the individual static cases are used. _resultsByCase: lcId | 'C'+id.
      if (!this._resultsByCase) { try { this._reconstructResultsFromCache(); } catch {} }
      const byCase = this._resultsByCase;
      const disResults = [];
      if (byCase) {
        for (const c of (this.model.combinations?.values() || [])) {
          const r = byCase.get('C' + c.id); if (r) disResults.push({ name: c.name, res: r });
        }
        if (!disResults.length) {
          for (const lc of this.model.loadCases.values()) {
            if (lc.type === 'spectrum') continue;
            const r = byCase.get(lc.id); if (r) disResults.push({ name: lc.name, res: r });
          }
        }
      }
      if (!disResults.length) {
        const key = this._activeResultKey ?? this._activeLcId;
        const nom = this.model.loadCases.get(key)?.name || this.model.combinations?.get(key)?.name || `caso ${key}`;
        disResults.push({ name: nom, res: this._results });
      }

      const maxAbs = (res, eid, type) => {
        let d; try { d = res.getDiagramData(eid, type, 12); } catch { return 0; }
        let m = 0;
        for (const p of (d.pts || [])) m = Math.max(m, Math.abs(p.val));
        for (const e of (d.extremes || [])) m = Math.max(m, Math.abs(e.val));
        return m;
      };
      // The DEFLECTION verification is done separately (service): table of beam
      // deflections under unfactored live load (_computeBeamDeflections) and
      // story drifts (_computeDrift). Here only strength (D/C).
      const filas = [];
      for (const el of this.model.elements.values()) {
        const sec = this.model.sections.get(el.secId);
        const mat = this.model.materials.get(el.matId);
        if (!sec || !mat) continue;
        let peor = null, peorNom = null, peorFuerzas = null;
        for (const { nombre, res } of disResults) {
          const f = res.getElemForces(el.id); if (!f) continue;
          const fuerzas = {
            N: (Math.sign(f.N) || 1) * maxAbs(res, el.id, 'N'),
            Vy: maxAbs(res, el.id, 'Vy'), Vz: maxAbs(res, el.id, 'Vz'),
            My: maxAbs(res, el.id, 'My'), Mz: maxAbs(res, el.id, 'Mz'), L: f.L,
          };
          const r = mod.checkElement({ fuerzas, sec, mat, matName: mat.name, params,
            designSettings: this.model.designSettings, member: el.design });
          if (!peor || r.ratioMax > peor.ratioMax) { peor = r; peorNom = nombre; peorFuerzas = fuerzas; }
        }
        if (!peor) continue;
        filas.push({ id: el.id, mat: mat.name, sec: sec.name, forces: peorFuerzas, combo: peorNom, ...peor });
      }
      filas.sort((a, b) => b.ratioMax - a.ratioMax);
      return { filas, params, caso: disResults.length > 1 ? `envolvente de ${disResults.length} estados` : disResults[0].name, envolvente: disResults.length > 1 };
    } catch (e) { console.error('Diseño falló:', e); return { filas: [], params, caso: null }; }
  }

  // ── Service: BEAM deflections under unfactored LIVE LOAD ───────────────────
  // Table of beam elements only (nearly horizontal), deflection relative to the
  // chord using exclusively the live-load case (factor 1, uncombined).
  _computeBeamDeflections(params) {
    const out = { rows: [], note: '', caso: null, limSobre: (params?.deflection_limits?.beam_live_load_L_over) || 360 };
    if (!this._resultsByCase) { try { this._reconstructResultsFromCache(); } catch {} }
    const byCase = this._resultsByCase;
    const isLive = lc => lc.type !== 'spectrum' && !lc.selfWeight && /viva|sobrecarga|uso|\bcv\b|live/i.test(lc.name || '');
    const lcLive = [...this.model.loadCases.values()].find(isLive);
    if (!lcLive) { out.note = 'No se identificó el caso de sobrecarga de uso. Nómbrelo con «sobrecarga», «viva», «uso» o «CV» (y sin peso propio).'; return out; }
    out.caso = lcLive.name;
    const res = byCase?.get(lcLive.id);
    if (!res || typeof res.getElemAtXi !== 'function') { out.note = `Ejecute el análisis estático (F5) para tener resultados del caso «${lcLive.name}».`; return out; }

    // Max deflection relative to the straight chord between the nodes (span sag).
    const flechaMax = (el) => {
      try {
        const u1 = res.getNodeDisp(el.n1), u2 = res.getNodeDisp(el.n2);
        if (!u1 || !u2) return 0;
        let dmax = 0;
        for (let k = 1; k < 10; k++) {
          const xi = k / 10, d = res.getElemAtXi(el.id, xi); if (!d) continue;
          const cx = u1[0] + xi * (u2[0] - u1[0]), cy = u1[1] + xi * (u2[1] - u1[1]), cz = u1[2] + xi * (u2[2] - u1[2]);
          dmax = Math.max(dmax, Math.hypot(d.ux - cx, d.uy - cy, d.uz - cz));
        }
        return dmax;
      } catch { return 0; }
    };

    for (const el of this.model.elements.values()) {
      const n1 = this.model.nodes.get(el.n1), n2 = this.model.nodes.get(el.n2);
      if (!n1 || !n2) continue;
      const L = Math.hypot(n2.x - n1.x, n2.y - n1.y, n2.z - n1.z);
      if (L < 1e-9) continue;
      if (Math.abs(n2.z - n1.z) > 0.2 * L) continue;   // beams only (nearly horizontal)
      const delta = flechaMax(el);
      const lim = L / out.limSobre;
      out.rows.push({ id: el.id, sec: this.model.sections.get(el.secId)?.name || '', L, delta, lim, ratio: lim > 1e-9 ? delta / lim : 0 });
    }
    out.rows.sort((a, b) => b.ratio - a.ratio);
    return out;
  }

  // ── Service: story DRIFTS per NCh433 ───────────────────────────────────────
  // (1) between CENTERS OF MASS (diaphragm master nodes) and (2) between the
  // EXTERNAL nodes (max level displacement). Both ≤ 0.002·h (2/1000 of the story
  // height). Uses the seismic displacements (spectrum F6+F7).
  _computeDrift() {
    const limit = 0.002;
    const out = { limit, dirs: [], note: '', hasCM: false };
    const spec = this._spectrumResults;
    const dirDefs = [['X', 0, 'espX'], ['Y', 1, 'espY']].filter(([, , k]) => spec?.get(k)?.result);
    if (!dirDefs.length) { out.note = 'Las derivas usan los resultados sísmicos: ejecute Análisis Modal (F6) y Espectro de Respuesta (F7) en X y/o Y.'; return out; }

    // Floor levels: diaphragms (master = CM) if they exist; otherwise group nodes by z.
    let levels;
    const diaphs = [...this.model.diaphragms.values()];
    if (diaphs.length) {
      levels = diaphs.map(d => ({ z: d.z, masterId: d.masterId, nodeIds: (d.nodes || []).filter(id => this.model.nodes.has(id)) }));
      out.hasCM = true;
    } else {
      const byZ = new Map();
      for (const n of this.model.nodes.values()) {
        if (Math.abs(n.z) < 0.01) continue;   // base level
        const zk = Math.round(n.z * 100) / 100;
        if (!byZ.has(zk)) byZ.set(zk, []);
        byZ.get(zk).push(n.id);
      }
      levels = [...byZ.entries()].map(([z, ids]) => ({ z, masterId: null, nodeIds: ids }));
      out.note = 'Sin diafragmas rígidos: la deriva entre centros de masa requiere definir diafragmas (Análisis → diafragmas). Se reporta solo la deriva entre nodos externos por nivel de Z.';
    }
    levels.sort((a, b) => a.z - b.z);
    if (!levels.length) { out.note = 'No hay niveles de entrepiso (todos los nodos están en la base).'; return out; }

    for (const [dir, idx, key] of dirDefs) {
      const res = spec.get(key).result;
      const dispH = id => { try { return Math.abs(res.getNodeDisp(id)[idx]); } catch { return 0; } };
      const lvlData = levels.map(L => ({
        z: L.z,
        cm: L.masterId != null ? dispH(L.masterId) : null,
        ext: L.nodeIds.reduce((mx, id) => Math.max(mx, dispH(id)), 0),
      }));
      // Base (ground) reference at z=0 with u=0
      let prev = { z: 0, cm: 0, ext: 0 };
      const stories = [];
      lvlData.forEach((cur, i) => {
        const h = cur.z - prev.z;
        if (h <= 1e-6) { prev = cur; return; }
        const driftCM = (cur.cm != null && prev.cm != null) ? Math.abs(cur.cm - prev.cm) / h : null;
        const driftExt = Math.abs(cur.ext - prev.ext) / h;
        stories.push({
          piso: i + 1, z: cur.z, h,
          driftCM, ratioCM: driftCM != null ? driftCM / limit : null, okCM: driftCM != null ? driftCM <= limit : null,
          driftExt, ratioExt: driftExt / limit, okExt: driftExt <= limit,
        });
        prev = cur;
      });
      out.dirs.push({ dir, stories });
    }
    return out;
  }

  // Captures base, deformed shape and up to 3 modes, and restores the user's view.
  async _captureReportViews() {
    const vp  = this.viewport;
    const out = { base: null, deformada: null, modos: [] };
    const hadResults     = !!this._results;
    const hadModal       = !!this._modalResults;
    const prevMode       = this._modalMode;
    const prevType       = document.getElementById('result-type')?.value || 'deformed';
    const modalVisible   = !document.getElementById('modal-analysis-overlay')?.classList.contains('hidden');
    const resultsVisible = !document.getElementById('results-overlay')?.classList.contains('hidden');
    const frame = () => new Promise(r => requestAnimationFrame(() => r()));
    const cm = this._report();   // effective report: per-project + global defaults (#41)
    const b0  = this.model.getBounds();
    const span = Math.max(b0.max.x - b0.min.x, b0.max.y - b0.min.y, b0.max.z - b0.min.z, 1);

    // Show node/element IDs in the figures (config)
    const idsPrev = vp._showIds;
    if (cm.mostrarIds && !vp._showIds) vp.toggleIds();
    else if (!cm.mostrarIds && vp._showIds) vp.toggleIds();

    vp.setView('iso');

    // Base model (no deformed shape or modes)
    vp.clearResults();
    await frame();
    out.base = vp.snapshot();

    // Deformed shape (if there are static results)
    if (hadResults) {
      vp.showDeformed(this._results, null);
      await frame();
      out.deformada = vp.snapshot();
    }

    // Up to 3 mode shapes (if there's a modal analysis). Scale NORMALIZED to ~12%
    // of the span so the mode is visible (before, span/5 was too small).
    if (hadModal) {
      const mr = this._modalResults;
      const n = Math.min(3, mr.nModes);
      for (let i = 0; i < n; i++) {
        let maxd = 0;
        try { for (const d of mr.getModeShape(i).values()) maxd = Math.max(maxd, Math.hypot(d[0], d[1], d[2])); } catch {}
        const base = maxd > 1e-9 ? (span * 0.14) / maxd : span / 5;
        const scale = cm.modosVisibles !== false ? base : span / 5;
        vp.showModeShape(mr, i, scale);
        await frame();
        out.modos.push({ n: i + 1, freq: mr.freq[i], period: mr.period[i], img: vp.snapshot() });
      }
    }

    // Restore IDs and what the user had on screen
    if (vp._showIds !== idsPrev) vp.toggleIds();
    vp.clearResults();
    if (hadModal && modalVisible) {
      document.getElementById('modal-analysis-overlay')?.classList.remove('hidden');
      this._modalMode = prevMode;
      this._refreshModalView();
    } else if (hadResults && resultsVisible) {
      const s = document.getElementById('result-type'); if (s) s.value = prevType;
      document.getElementById('results-overlay')?.classList.remove('hidden');
      this._refreshResultView();
    }
    return out;
  }

  _reportHTML(imgs, diseno, deflex, drift) {
    const m = this.model;
    const fmt = (v, d = 3) => (v == null || !isFinite(v)) ? '—'
      : (Math.abs(v) >= 1e5 || (Math.abs(v) > 0 && Math.abs(v) < 1e-3) ? (+v).toExponential(2) : (+v).toFixed(d));
    const proyecto = (document.title || '').replace(/^●\s*/, '').replace(/\s*—\s*[^—]*$/, '').trim() || i18n.t('Modelo sin título');
    const fecha = new Date().toLocaleDateString(i18n.getLocale() === 'en' ? 'en-US' : 'es-CL', { year:'numeric', month:'long', day:'numeric' });
    const U = m.units || 'kN-m';
    const cm = this._report();   // effective report: per-project + global defaults (#41)
    const clasif = (n) => { n = String(n||'').toLowerCase();
      if (/(horm|concret|h\s*\d|fc)/.test(n)) return 'concrete';
      if (/(mader|pino|wood|gl\b|lvl|conif)/.test(n)) return 'timber';
      return 'steel'; };
    const dp = diseno?.params || null;

    // ── Materials ───────────────────────────────────────────────────────────
    const matRows = [...m.materials.values()].map(mt => `<tr>
      <td>${esc(mt.name)}</td><td>${fmt(mt.E,0)}</td><td>${fmt(mt.G,0)}</td>
      <td>${fmt(mt.nu,2)}</td><td>${fmt(mt.rho,3)}</td></tr>`).join('') || `<tr><td colspan="5">${i18n.t('Sin materiales')}</td></tr>`;

    // ── Sections (with count of elements using each) ────────────────────────
    const secCount = new Map();
    for (const el of m.elements.values()) secCount.set(el.secId, (secCount.get(el.secId) || 0) + 1);
    const modTxt = (md) => { const o = md || {}; const a=o.A??1,iy=o.Iy??1,iz=o.Iz??1,j=o.J??1;
      return (a===1&&iy===1&&iz===1&&j===1) ? '—' : `A·${a} Iy·${iy} Iz·${iz} J·${j}`; };
    const secRows = [...m.sections.values()].map(s => `<tr>
      <td>${esc(s.name)}</td><td>${fmt(s.A,5)}</td><td>${fmt(s.Iy,6)}</td><td>${fmt(s.Iz,6)}</td>
      <td>${fmt(s.J,6)}</td><td>${fmt(s.Avy,5)}</td><td>${fmt(s.Avz,5)}</td>
      <td>${modTxt(s.mod)}</td><td>${secCount.get(s.id) || 0}</td></tr>`).join('') || `<tr><td colspan="9">${i18n.t('Sin secciones')}</td></tr>`;

    // ── Classification of cases and loads ───────────────────────────────────
    const tipoCaso = (lc) => {
      if (lc.type === 'spectrum') return i18n.t('Sísmica (espectro)');
      const n = (lc.name || '').toLowerCase();
      if (/vient|wind/.test(n)) return i18n.t('Viento');
      if (/niev|snow/.test(n)) return i18n.t('Nieve');
      if (/sism|seism|\bsx\b|\bsy\b|\beq\b/.test(n)) return i18n.t('Sísmica');
      if (/sobre|live|\bcv\b|uso/.test(n)) return i18n.t('Sobrecarga de uso');
      if (/event|acc/.test(n)) return i18n.t('Eventual');
      if (/perm|muert|\bcm\b|dead|propio/.test(n) || lc.selfWeight) return i18n.t('Permanente');
      return i18n.t('Carga');
    };
    const dirLabel = { gravity:i18n.t('Gravedad ↓ (−Z)'), globalX:i18n.t('Global +X'), globalY:i18n.t('Global +Y'),
      globalZ:i18n.t('Global +Z'), localY:i18n.t('Local y'), localZ:i18n.t('Local z'), x:i18n.t('Global +X'), y:i18n.t('Global +Y'), z:i18n.t('Global +Z') };

    const casosStatic = [...m.loadCases.values()].filter(lc => lc.type !== 'spectrum');
    const cargasHTML = casosStatic.map(lc => {
      const loadRows = (lc.loads || []).map(ld => {
        if (ld.type === 'nodal') {
          const [Fx,Fy,Fz,Mx,My,Mz] = ld.F || [];
          return `<tr><td>${i18n.t('Puntual')}</td><td>${i18n.t('Nodo')} ${ld.nodeId}</td><td>—</td>
            <td>F=(${fmt(Fx,2)}, ${fmt(Fy,2)}, ${fmt(Fz,2)}) kN · M=(${fmt(Mx,2)}, ${fmt(My,2)}, ${fmt(Mz,2)}) kN·m</td></tr>`;
        }
        if (ld.type === 'temp') {
          return `<tr><td>${i18n.t('Temperatura')}</td><td>${i18n.t('Elem')} ${ld.elemId}</td><td>${i18n.t('Uniforme')}</td><td>ΔT = ${fmt(ld.dT,1)} °C</td></tr>`;
        }
        return `<tr><td>${i18n.t('Distribuida')}</td><td>${i18n.t('Elem')} ${ld.elemId}</td>
          <td>${esc(dirLabel[ld.dir] || ld.dir || i18n.t('Gravedad'))}</td><td>w = ${fmt(ld.w,2)} kN/m</td></tr>`;
      }).join('');
      const cuerpo = loadRows || `<tr><td colspan="4" class="muted">${lc.selfWeight ? i18n.t('Solo peso propio') : i18n.t('Sin cargas asignadas')}</td></tr>`;
      return `<h3>${esc(lc.name)} <span class="tag">${tipoCaso(lc)}</span>${lc.selfWeight ? ` <span class="tag tag-pp">${i18n.t('+ peso propio')}</span>` : ''}</h3>
        <table><thead><tr><th>${i18n.t('Tipo')}</th><th>${i18n.t('Aplicada en')}</th><th>${i18n.t('Dirección')}</th><th>${i18n.t('Valor')}</th></tr></thead>
        <tbody>${cuerpo}</tbody></table>`;
    }).join('') || `<p class="muted">${i18n.t('No hay casos de carga estáticos definidos.')}</p>`;

    // ── Seismic (spectra with their NCh433/DS61 parameters) ─────────────────
    let sismoHTML = '';
    const espectros = [...this._spectrumResults.values()].filter(e => e?.params);
    if (espectros.length) {
      sismoHTML = espectros.map(({ params: p }) => {
        const k = p.nch433 || {};
        const tabla = `<table><tbody>
          <tr><th>${i18n.t('Dirección sísmica')}</th><td>${esc(p.direction)}</td><th>${i18n.t('Método combinación')}</th><td>${esc(p.method)}</td></tr>
          <tr><th>${i18n.t('Zona sísmica')}</th><td>${esc(k.zona ?? '—')} (A₀ = ${fmt(k.Ao,2)} g)</td><th>${i18n.t('Tipo de suelo')}</th><td>${esc(k.suelo ?? '—')} (S=${fmt(k.S,2)}, T₀=${fmt(k.To,2)}, p=${fmt(k.p,2)})</td></tr>
          <tr><th>${i18n.t('Categoría de importancia')}</th><td>${esc(k.cat ?? '—')} (I = ${fmt(k.I,2)})</td><th>${i18n.t('Amortiguamiento ζ')}</th><td>${fmt(p.zeta,2)}</td></tr>
          <tr><th>R₀</th><td>${fmt(k.Ro,1)}</td><th>R* / T*</th><td>R*=${fmt(k.Rstar,3)} ${k.Tstar ? `(T*=${fmt(k.Tstar,3)} s)` : `(${i18n.t('elástico')})`}</td></tr>
        </tbody></table>`;
        return `<h3>${i18n.t('Espectro de respuesta — dirección')} ${esc(p.direction)}</h3>
          ${tabla}
          <div class="spec-graph">${this._reportSpectrumSVG(p.spectrum)}</div>
          <p class="muted">Sa(T) = S·A₀·I·α(T)/R* (NCh433 / DS61). ${i18n.t('Unidad de Sa:')} ${esc(k.unidadSa || 'g')}.</p>`;
      }).join('');
    } else {
      sismoHTML = `<p class="muted">${i18n.t('No se ha ejecutado un análisis de espectro de respuesta. Ejecute «Análisis → Espectro de Respuesta (F7)» para documentar zona sísmica, suelo, importancia y el espectro de diseño.')}</p>`;
    }

    // ── Modal (3 modes) ─────────────────────────────────────────────────────
    let modalHTML = '';
    if (this._modalResults) {
      const { rows } = this._modalResults.getParticipation();
      const partRows = rows.slice(0, Math.max(3, Math.min(rows.length, 12))).map(r => `<tr>
        <td>${r.mode}</td><td>${fmt(r.freq,3)}</td><td>${fmt(r.period,3)}</td>
        <td>${fmt(r.pct[0],1)}</td><td>${fmt(r.pct[1],1)}</td><td>${fmt(r.pct[2],1)}</td>
        <td>${fmt(r.cumPct[0],1)}</td><td>${fmt(r.cumPct[1],1)}</td><td>${fmt(r.cumPct[2],1)}</td></tr>`).join('');
      const modeImgs = imgs.modos.map(md => `<figure>
        <img src="${md.img}" alt="${i18n.t('Modo')} ${md.n}">
        <figcaption>${i18n.t('Modo')} ${md.n} — f = ${fmt(md.freq,3)} Hz · T = ${fmt(md.period,3)} s</figcaption></figure>`).join('');
      modalHTML = `
        <p>${i18n.t('Modos extraídos:')} ${this._modalResults.nModes}. ${i18n.t('Frecuencias y períodos de los primeros modos:')}</p>
        <table><thead><tr><th>${i18n.t('Modo')}</th><th>f (Hz)</th><th>T (s)</th>
          <th>Mx (%)</th><th>My (%)</th><th>Mrz (%)</th><th>ΣMx</th><th>ΣMy</th><th>ΣMrz</th></tr></thead>
          <tbody>${partRows}</tbody></table>
        <p class="muted">${i18n.t('Mx/My/Mrz = masa modal participante (%). Σ = acumulada.')}</p>
        ${modeImgs ? `<div class="figrow">${modeImgs}</div>` : ''}`;
    } else {
      modalHTML = `<p class="muted">${i18n.t('No se ha ejecutado el análisis modal. Ejecute «Análisis → Análisis Modal (F6)» para documentar los modos de vibrar.')}</p>`;
    }

    // ── Model images ────────────────────────────────────────────────────────
    const idsNota = cm.mostrarIds ? ' — ' + i18n.t('con IDs de nodos y elementos') : '';
    const figBase = imgs.base ? `<figure><img src="${imgs.base}" alt="${i18n.t('Modelo base')}"><figcaption>${i18n.t('Modelo estructural (geometría base')}${idsNota})</figcaption></figure>` : '';
    const figDef  = imgs.deformada ? `<figure><img src="${imgs.deformada}" alt="${i18n.t('Deformada')}"><figcaption>${i18n.t('Deformada (resultado estático')}${idsNota})</figcaption></figure>`
      : `<p class="muted">${i18n.t('Deformada no disponible — ejecute el análisis estático (F5).')}</p>`;

    const s = m.getStats();

    // ── Design methods (only materials present) ─────────────────────────────
    const tipos = new Set([...m.materials.values()].map(mt => clasif(mt.name)));
    const nombreTipo = { steel:i18n.t('Acero estructural'), concrete:i18n.t('Hormigón armado'), timber:i18n.t('Madera') };
    const metodosHTML = dp ? [...tipos].map(t => {
      const p = dp[t] || {};
      let det = '';
      if (t === 'steel')    det = `Fy = ${fmt(p.Fy_MPa,0)} MPa · Fu = ${fmt(p.Fu_MPa,0)} MPa · E = ${fmt(p.E_MPa,0)} MPa · φ_b=${p.phi?.bending} φ_v=${p.phi?.shear} φ_c=${p.phi?.axial_compresion}`;
      if (t === 'concrete') det = `f′c = ${fmt(p.fc_MPa,0)} MPa · fy = ${fmt(p.fy_rebar_MPa,0)} MPa · cuantía ρ = ${fmt(p.long_reinf_ratio,3)} · rec. = ${fmt(p.cover_mm,0)} mm · φ_b=${p.phi?.bending} φ_v=${p.phi?.shear}`;
      if (t === 'timber')   det = `Fb = ${fmt(p.Fb_MPa,1)} · Fv = ${fmt(p.Fv_MPa,1)} · Fc = ${fmt(p.Fc_MPa,1)} · Ft = ${fmt(p.Ft_MPa,1)} MPa · ∏Ki = ${fmt(Object.values(p.modification_factors||{}).reduce((a,b)=>a*b,1),2)}`;
      return `<tr><th>${nombreTipo[t]}</th><td>${esc(p.method||'—')}<br><span class="muted">${det}</span></td></tr>`;
    }).join('') : `<tr><td colspan="2" class="muted">${i18n.t('Parámetros de diseño no disponibles.')}</td></tr>`;

    // ── Standards and codes ─────────────────────────────────────────────────
    const normas = [
      [i18n.t('Acción sísmica'), 'NCh433.Of96 Mod.2009 · DS61 (espectro de diseño)'],
      [i18n.t('Cargas y sobrecargas'), 'NCh1537.Of2009 (permanentes y sobrecargas de uso)'],
      [i18n.t('Combinaciones de carga'), 'NCh3171.Of2010 (disposiciones generales)'],
      [i18n.t('Viento'), 'NCh432.Of2010'],
      [i18n.t('Nieve'), 'NCh431.Of2010'],
      [i18n.t('Acero estructural'), 'NCh427/1 · ANSI/AISC 360-16 (LRFD)'],
      [i18n.t('Hormigón armado'), 'NCh430 · ACI 318'],
      [i18n.t('Madera estructural'), 'NCh1198 (tensiones admisibles modificadas)'],
    ].map(([a,b]) => `<tr><th>${a}</th><td>${esc(b)}</td></tr>`).join('');

    // ── Model load combinations ─────────────────────────────────────────────
    const lcName = id => m.loadCases.get(id)?.name || m.combinations?.get(id)?.name || `LC${id}`;
    const comboRows = [...(m.combinations?.values() || [])].map(c =>
      `<tr><td>${esc(c.name)}</td><td>${(c.factors||[]).map(f => `${fmt(f.factor,2)}·${esc(lcName(f.lcId))}`).join('  +  ') || '—'}</td></tr>`).join('')
      || `<tr><td colspan="2" class="muted">${i18n.t('No hay combinaciones definidas.')}</td></tr>`;

    // ── Allowable deflections ───────────────────────────────────────────────
    const fl = dp?.deflection_limits || {};
    const flechasHTML = `<table><tbody>
      <tr><th>${i18n.t('Viga — carga total')}</th><td>L / ${fl.beam_total_load_L_over ?? 300}</td>
          <th>${i18n.t('Viga — sobrecarga')}</th><td>L / ${fl.beam_live_load_L_over ?? 360}</td></tr>
      <tr><th>${i18n.t('Voladizo')}</th><td>L / ${fl.cantilever_L_over ?? 150}</td>
          <th>${i18n.t('δ máx del modelo')}</th><td>${this._results?.getMaxDisp ? fmt(this._results.getMaxDisp(),5)+' m' : '—'}</td></tr>
    </tbody></table>
    <p class="muted">${i18n.t('Límites como fracción de la luz L. La verificación de flecha por elemento debe contrastarse con la luz libre de cada vano.')}</p>`;

    // ── Element design: STRENGTH verification bending/shear/axial ──
    // (the service DEFLECTIONS go in their own section, not here).
    let disenoHTML;
    const rClass = r => r > 1.0 ? 'r-bad' : r > 0.9 ? 'r-warn' : 'r-ok';
    if (diseno && diseno.filas && diseno.filas.length) {
      const f = diseno.filas;
      const malo = x => x.ratioMax > 1;
      const aj   = x => !malo(x) && x.ratioMax > 0.9;
      const nNo = f.filter(malo).length;
      const nAj = f.filter(aj).length;
      const nOk = f.length - nNo - nAj;
      const top = f.slice(0, 60);
      const rows = top.map(x => `<tr>
        <td>#${x.id}</td><td>${esc(x.sec)}</td><td>${esc(x.mat)}</td><td title="${esc(x.combo||'')}">${esc((x.combo||'').slice(0,14))}</td>
        <td>${fmt(x.forces.N,1)}</td><td>${fmt(Math.max(x.forces.My,x.forces.Mz),1)}</td><td>${fmt(Math.max(x.forces.Vy,x.forces.Vz),1)}</td>
        <td class="${rClass(x.bending.ratio)}">${fmt(x.bending.ratio,2)}</td>
        <td class="${rClass(x.shear.ratio)}">${fmt(x.shear.ratio,2)}</td>
        <td class="${rClass(x.axial.ratio)}">${fmt(x.axial.ratio,2)}</td>
        <td class="${rClass(x.interaction?.ratio)}">${fmt(x.interaction?.ratio,2)}</td>
        <td>${x.governs}</td>
        <td class="${rClass(x.ratioMax)}"><b>${fmt(x.ratioMax,2)}</b></td>
        <td class="${malo(x)?'r-bad':aj(x)?'r-warn':'r-ok'}">${malo(x)?i18n.t('NO CUMPLE'):aj(x)?i18n.t('ajustado'):i18n.t('cumple')}</td></tr>`).join('');
      const alcance = diseno.envolvente ? i18n.t('envolvente de las combinaciones de carga') : `${i18n.t('el estado')} «${esc(diseno.caso||i18n.t('activo'))}»`;
      const shown = f.length > 60 ? `${i18n.t('Se muestran los 60 elementos más solicitados de')} ${f.length}. ` : '';
      disenoHTML = `
        <p>${i18n.t('Verificación de')} <b>${i18n.t('resistencia')}</b> ${i18n.t('por')} <b>${alcance}</b>:
        ${i18n.t('para cada elemento se reporta la combinación más desfavorable. La razón')} <b>D/C = ${i18n.t('demanda/capacidad')}</b> ${i18n.t('debe ser ≤ 1.0.')}
        ${i18n.t('Las deformaciones (servicio) se verifican en la sección de deformaciones de vigas. Parámetros en')} <code>assistant/design_params.json</code>.</p>
        <table style="font-size:9.5px"><thead><tr>
          <th>${i18n.t('Elem')}</th><th>${i18n.t('Sección')}</th><th>${i18n.t('Material')}</th><th>${i18n.t('Combo')}</th><th>N (kN)</th><th>M (kN·m)</th><th>V (kN)</th>
          <th>${i18n.t('flex.')}</th><th>${i18n.t('corte')}</th><th>${i18n.t('axial')}</th><th>${i18n.t('interac.')}</th><th>${i18n.t('Gobierna')}</th><th>${i18n.t('D/C máx')}</th><th>${i18n.t('Estado')}</th>
        </tr></thead><tbody>${rows}</tbody></table>
        <p class="muted">${shown}
        ${i18n.t('Resumen:')} <b class="r-ok">${nOk} ${i18n.t('cumplen')}</b> · <b class="r-warn">${nAj} ${i18n.t('ajustados')}</b> · <b class="r-bad">${nNo} ${i18n.t('no cumplen')}</b>.
        ${i18n.t('D/C: flexión/corte/axial e interacción flexo-axial. Colores: verde ≤ 0.90 · ámbar 0.90–1.00 · rojo > 1.00.')}</p>`;
    } else {
      disenoHTML = `<p class="muted">${i18n.t('No hay resultados de análisis para verificar. Ejecute el análisis estático (F5) con sus combinaciones de carga antes de generar la memoria.')}</p>`;
    }

    // ── Beam deflections (service · unfactored live load) ───────────────────
    let deflexHTML;
    if (deflex && deflex.rows && deflex.rows.length) {
      const dr = deflex.rows.slice(0, 60);
      const rows = dr.map(x => `<tr>
        <td>#${x.id}</td><td>${esc(x.sec)}</td><td>${fmt(x.L,2)}</td>
        <td>${fmt(x.delta*1000,2)}</td><td>L/${deflex.limSobre} = ${fmt(x.lim*1000,2)}</td>
        <td class="${rClass(x.ratio)}"><b>${fmt(x.ratio,2)}</b></td>
        <td class="${x.ratio>1?'r-bad':x.ratio>0.9?'r-warn':'r-ok'}">${x.ratio>1?i18n.t('NO CUMPLE'):x.ratio>0.9?i18n.t('ajustado'):i18n.t('cumple')}</td></tr>`).join('');
      const nNo = deflex.rows.filter(x => x.ratio > 1).length;
      const shown = deflex.rows.length > 60 ? `${i18n.t('Se muestran las 60 vigas más deformadas de')} ${deflex.rows.length}. ` : '';
      const resumen = nNo ? `<b class="r-bad">${nNo} ${i18n.t('viga(s) superan el límite.')}</b> ` : i18n.t('Todas cumplen el límite de servicio.') + ' ';
      deflexHTML = `
        <p>${i18n.t('Flecha de las')} <b>${i18n.t('vigas')}</b> ${i18n.t('(elementos casi horizontales) bajo el caso de')} <b>${i18n.t('sobrecarga de uso')} «${esc(deflex.caso)}» ${i18n.t('sin mayorar')}</b>
        ${i18n.t('(factor 1.0), medida respecto a la cuerda recta del vano. Límite de servicio')} L/${deflex.limSobre}.</p>
        <table style="font-size:9.5px"><thead><tr>
          <th>${i18n.t('Viga')}</th><th>${i18n.t('Sección')}</th><th>L (m)</th><th>δ (mm)</th><th>${i18n.t('δ admisible (mm)')}</th><th>δ/δadm</th><th>${i18n.t('Estado')}</th>
        </tr></thead><tbody>${rows}</tbody></table>
        <p class="muted">${shown}
        ${resumen}
        ${i18n.t('δ = flecha relativa máxima en el vano por sobrecarga de uso (sin mayorar).')}</p>`;
    } else {
      deflexHTML = `<p class="muted">${esc(deflex?.note || i18n.t('Sin datos de deformaciones de vigas.'))}</p>`;
    }

    // ── Seismic story drifts (NCh433) ─────────────────────────────────────────
    let driftHTML;
    if (drift && drift.dirs && drift.dirs.length) {
      const cls = ok => ok === false ? 'r-bad' : ok === true ? 'r-ok' : '';
      const lblOk = ok => ok === false ? i18n.t('NO CUMPLE') : ok === true ? i18n.t('cumple') : '—';
      const cell = (v, d = 5) => v == null ? '—' : fmt(v, d);
      driftHTML = drift.dirs.map(D => {
        const rows = D.stories.map(s => `<tr>
          <td>${s.piso}</td><td>${fmt(s.z,2)}</td><td>${fmt(s.h,2)}</td>
          <td>${cell(s.driftCM)}</td><td class="${cls(s.okCM)}">${cell(s.ratioCM,2)}</td><td class="${cls(s.okCM)}">${lblOk(s.okCM)}</td>
          <td>${cell(s.driftExt)}</td><td class="${cls(s.okExt)}">${cell(s.ratioExt,2)}</td><td class="${cls(s.okExt)}">${lblOk(s.okExt)}</td></tr>`).join('');
        return `<h3>${i18n.t('Dirección sísmica')} ${esc(D.dir)}</h3>
        <table style="font-size:9.5px"><thead><tr>
          <th>${i18n.t('Piso')}</th><th>Z (m)</th><th>h (m)</th>
          <th>δ/h (CM)</th><th>·/0.002</th><th>${i18n.t('Estado CM')}</th>
          <th>δ/h (ext.)</th><th>·/0.002</th><th>${i18n.t('Estado ext.')}</th>
        </tr></thead><tbody>${rows || `<tr><td colspan="9" class="muted">${i18n.t('Sin entrepisos.')}</td></tr>`}</tbody></table>`;
      }).join('');
      driftHTML += `<p class="muted">${i18n.t('Deriva de entrepiso δ/h = desplazamiento relativo entre pisos consecutivos ÷ altura de entrepiso.')}
        <b>${i18n.t('Límite NCh433: 0.002')}</b> ${i18n.t('(2/1000) tanto entre')} <b>${i18n.t('centros de masa')}</b> (Art. 5.9.2) ${i18n.t('como entre')} <b>${i18n.t('nodos externos')}</b> ${i18n.t('del piso (Art. 5.9.3).')}
        ${i18n.t('Calculada con los desplazamientos del espectro de respuesta.')}${drift.hasCM ? '' : ` <i>${i18n.t('Sin diafragmas: se reporta solo la deriva entre nodos externos.')}</i>`}</p>`;
    } else {
      driftHTML = `<p class="muted">${esc(drift?.note || i18n.t('Sin datos de derivas sísmicas.'))}</p>`;
    }

    // ── Cover page (configurable per project) ───────────────────────────────
    // The logo/institution come from the report configuration (empty by default
    // in the open edition). The company logo (PRO) is shown if loaded.
    const tieneLogoPro = !!(this._brandingPro && cm.logoEmpresa);
    const logosAcad = '';
    const logoEmp = tieneLogoPro ? `<div class="cover-logo-emp"><img src="${esc(cm.logoEmpresa)}" alt="${i18n.t('Empresa')}"></div>` : '';
    const portada = `<section class="cover">
      ${logoEmp}${logosAcad}
      <div class="cover-inst">${esc(cm.institucion || '')}<br><span>${esc(cm.subInstitucion || '')}</span></div>
      <svg class="cover-frame" viewBox="0 0 360 200" aria-hidden="true">
        <path d="M60 175 V55 H300 V175" fill="none" stroke="#0a3a57" stroke-width="4" stroke-linecap="round"/>
        <path d="M46 188 L74 188 L60 175 Z" fill="#0d9488"/><path d="M286 188 L314 188 L300 175 Z" fill="#0d9488"/>
        <path d="M44 188 H76 M284 188 H316" stroke="#0a3a57" stroke-width="2"/>
        <circle cx="60" cy="55" r="5" fill="#0e7fc0"/><circle cx="300" cy="55" r="5" fill="#0e7fc0"/>
      </svg>
      <div class="cover-kicker">${esc(cm.kicker || i18n.t('ANÁLISIS Y DISEÑO ESTRUCTURAL'))}</div>
      <h1 class="cover-title">${esc(cm.titulo || i18n.t('Memoria de Cálculo'))}</h1>
      <div class="cover-proj">${esc(proyecto)}</div>
      ${tieneLogoPro ? '' : `<div class="cover-badge">${i18n.t('Generado con PORTICO — análisis estructural 3D')}</div>`}
      <table class="cover-meta"><tbody>
        <tr><th>${i18n.t('Proyecto')}</th><td>${esc(proyecto)}</td></tr>
        <tr><th>${i18n.t('Fecha')}</th><td>${esc(fecha)}</td></tr>
        <tr><th>${i18n.t('Unidades')}</th><td>${esc(U.replace('-',' · '))}</td></tr>
        <tr><th>${i18n.t('Proyectista')}</th><td>${esc(cm.proyectista) || '&nbsp;'}</td></tr>
        <tr><th>${i18n.t('Revisó')}</th><td>${esc(cm.revisor) || '&nbsp;'}</td></tr>
      </tbody></table>
      <p class="cover-note">${i18n.t('Documento de carácter orientativo. Los resultados deben ser validados por un profesional competente antes de cualquier uso en obra.')}</p>
    </section>`;
    const descripcionHTML = (this._brandingPro && cm.descripcion) ? `<p>${esc(cm.descripcion)}</p>` : '';
    // Footer and limitations: academic by default; editable only with a professional token.
    const footerTxt = (this._brandingPro && cm.footer) ? cm.footer : this._ACAD_FOOTER;
    const limitItems = (this._brandingPro && cm.limitaciones)
      ? cm.limitaciones.split('\n').map(s => s.trim()).filter(Boolean).map(esc)
      : this._ACAD_LIMITS;
    const limitHTML = limitItems.map(li => `<li>${li}</li>`).join('');

    return `<!DOCTYPE html><html lang="${i18n.getLocale()}"><head><meta charset="utf-8">
<base href="${esc(location.origin)}/">
<title>${esc(cm.titulo || i18n.t('Memoria de Cálculo'))} — ${esc(proyecto)}</title>
<style>
  :root{--ink:#1b2533;--mut:#5c6a7d;--bd:#cdd6e3;--ac:#0e7fc0;--head:#0a3a57;--teal:#0d9488;}
  *{box-sizing:border-box;}
  body{font-family:'Segoe UI',system-ui,sans-serif;color:var(--ink);margin:0;padding:30px 40px 64px;font-size:12px;line-height:1.5;}
  h1{font-size:22px;color:var(--head);margin:0 0 2px;}
  h2{font-size:15px;color:var(--head);border-bottom:2px solid var(--ac);padding-bottom:3px;margin:24px 0 10px;}
  h3{font-size:13px;color:var(--head);margin:15px 0 6px;}
  .sub{color:var(--mut);font-size:12px;margin:0 0 4px;}
  table{width:100%;border-collapse:collapse;margin:6px 0 12px;font-size:11px;}
  th,td{border:1px solid var(--bd);padding:4px 7px;text-align:left;vertical-align:top;}
  th{background:#eef3f9;color:var(--head);font-weight:600;}
  td{font-variant-numeric:tabular-nums;}
  code{background:#eef3f9;padding:0 4px;border-radius:3px;font-size:11px;}
  .muted{color:var(--mut);}
  .tag{display:inline-block;background:var(--ac);color:#fff;font-size:9px;padding:1px 7px;border-radius:9px;vertical-align:middle;font-weight:600;}
  .tag-pp{background:#15803d;}
  figure{margin:8px 0;text-align:center;}
  img{max-width:100%;border:1px solid var(--bd);border-radius:6px;background:#f6f8fb;}
  figcaption{color:var(--mut);font-size:10px;margin-top:3px;}
  .figrow{display:flex;flex-wrap:wrap;gap:10px;}
  .figrow figure{flex:1 1 30%;min-width:200px;margin:4px 0;}
  .spec-graph{border:1px solid var(--bd);border-radius:6px;padding:6px;background:#f6f8fb;max-width:480px;}
  .r-ok{background:#e8f6ed;color:#15803d;} .r-warn{background:#fdf3e2;color:#b45309;} .r-bad{background:#fde8e8;color:#dc2626;font-weight:700;}
  .print-btn{position:fixed;top:12px;right:12px;background:var(--ac);color:#fff;border:none;padding:8px 16px;border-radius:6px;font-size:13px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.2);z-index:10;}
  .page-footer{position:fixed;bottom:0;left:0;right:0;height:42px;display:flex;align-items:center;justify-content:space-between;
    padding:0 40px;font-size:9px;color:var(--mut);border-top:1px solid var(--bd);background:#fff;}
  .page-footer b{color:var(--head);}
  .cover{min-height:88vh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;page-break-after:always;}
  .cover-logos{display:flex;gap:22px;align-items:center;justify-content:center;margin-bottom:10px;flex-wrap:wrap;}
  .cover-logos img{height:46px;width:auto;border:none;background:none;border-radius:0;}
  .cover-logo-emp{margin-bottom:8px;} .cover-logo-emp img{height:54px;width:auto;border:none;background:none;}
  .cover-inst{font-size:12px;letter-spacing:.5px;color:var(--head);font-weight:600;margin-bottom:6px;}
  .cover-inst span{display:block;font-weight:400;color:var(--mut);font-size:10px;letter-spacing:0;}
  .cover-frame{width:240px;height:auto;margin:14px 0;}
  .cover-kicker{letter-spacing:3px;font-size:12px;color:var(--teal);font-weight:600;}
  .cover-title{font-size:38px;color:var(--head);margin:4px 0 2px;letter-spacing:1px;}
  .cover-proj{font-size:16px;color:var(--ink);margin-bottom:14px;}
  .cover-badge{max-width:480px;font-size:11px;color:var(--mut);border:1px dashed var(--bd);border-radius:8px;padding:8px 12px;margin-bottom:18px;}
  .cover-meta{max-width:420px;font-size:12px;} .cover-meta th{width:120px;}
  .cover-note{max-width:480px;font-size:10px;color:var(--mut);margin-top:16px;font-style:italic;}
  @media print{.print-btn{display:none;} h2{break-after:avoid;} table,figure{break-inside:avoid;} body{padding:0 40px 64px;}}
</style></head><body>
<button class="print-btn" onclick="window.print()">${i18n.t('🖨 Imprimir / Guardar PDF')}</button>
<div class="page-footer"><span><b>PORTICO</b> · ${esc(cm.titulo || i18n.t('Memoria de Cálculo'))} — ${esc(proyecto)}</span>
  <span>${esc(footerTxt)}</span>
  <span>${esc(fecha)}</span></div>

${portada}

<h2>${i18n.t('1. Bases de cálculo')}</h2>

<h3>${i18n.t('1.1 Descripción del modelo')}</h3>
${descripcionHTML}
<table><tbody>
  <tr><th>${i18n.t('Nodos')}</th><td>${s.nodes}</td><th>${i18n.t('Elementos')}</th><td>${s.elements}</td></tr>
  <tr><th>${i18n.t('Materiales')}</th><td>${s.materials}</td><th>${i18n.t('Secciones')}</th><td>${s.sections}</td></tr>
  <tr><th>${i18n.t('Modo del proyecto')}</th><td>${esc(m.mode || '3D')}</td><th>${i18n.t('Casos de carga')}</th><td>${m.loadCases.size}</td></tr>
</tbody></table>
${figBase}

<h3>${i18n.t('1.2 Métodos de diseño')}</h3>
<table><tbody>${metodosHTML}</tbody></table>

<h3>${i18n.t('1.3 Normas y códigos')}</h3>
<table><tbody>${normas}</tbody></table>

<h3>${i18n.t('1.4 Materiales y propiedades mecánicas')}</h3>
<table><thead><tr><th>${i18n.t('Material')}</th><th>E (kN/m²)</th><th>G (kN/m²)</th><th>ν</th><th>ρ (t/m³)</th></tr></thead>
<tbody>${matRows}</tbody></table>

<h3>${i18n.t('1.5 Secciones')}</h3>
<table><thead><tr><th>${i18n.t('Sección')}</th><th>A (m²)</th><th>Iy (m⁴)</th><th>Iz (m⁴)</th><th>J (m⁴)</th><th>Avy (m²)</th><th>Avz (m²)</th><th>${i18n.t('Modif. rigidez')}</th><th>${i18n.t('# elem')}</th></tr></thead>
<tbody>${secRows}</tbody></table>

<h3>${i18n.t('1.6 Cargas y sobrecargas')}</h3>
${cargasHTML}

<h3>${i18n.t('1.7 Acción sísmica')}</h3>
${sismoHTML}

<h3>${i18n.t('1.8 Combinaciones de carga')}</h3>
<table><thead><tr><th>${i18n.t('Combinación')}</th><th>${i18n.t('Factores')}</th></tr></thead><tbody>${comboRows}</tbody></table>

<h3>${i18n.t('1.9 Flechas admisibles')}</h3>
${flechasHTML}

<h2>${i18n.t('2. Análisis estructural')}</h2>
<h3>${i18n.t('2.1 Modelo deformado')}</h3>
${figDef}
<h3>${i18n.t('2.2 Análisis modal — modos de vibrar')}</h3>
${modalHTML}

<h2>${i18n.t('3. Diseño de elementos (resistencia)')}</h2>
${disenoHTML}

<h2>${i18n.t('4. Verificaciones de servicio')}</h2>
<h3>${i18n.t('4.1 Deformaciones de vigas — sobrecarga de uso (sin mayorar)')}</h3>
${deflexHTML}
<h3>${i18n.t('4.2 Derivas sísmicas de entrepiso — NCh433 (límite 2/1000·h)')}</h3>
${driftHTML}

<h2>${i18n.t('5. Limitaciones y alcances')}</h2>
<ul style="font-size:11px;line-height:1.6">${limitHTML}</ul>
</body></html>`;
  }

  // SVG of the Sa(T) spectrum for the calculation report.
  _reportSpectrumSVG(pts) {
    if (!Array.isArray(pts) || pts.length < 2) return `<p class="muted">${i18n.t('Sin curva.')}</p>`;
    const W = 460, H = 220, ml = 46, mr = 12, mt = 12, mb = 30;
    const Tmax = Math.max(...pts.map(p => p.T)) || 1;
    const Smax = Math.max(...pts.map(p => p.Sa)) || 1;
    const sx = t => ml + (t / Tmax) * (W - ml - mr);
    const sy = s => H - mb - (s / Smax) * (H - mt - mb);
    const poly = pts.map(p => `${sx(p.T).toFixed(1)},${sy(p.Sa).toFixed(1)}`).join(' ');
    const gx = [0,0.25,0.5,0.75,1].map(f => { const t=+(f*Tmax).toFixed(2);
      return `<line x1="${sx(t)}" y1="${mt}" x2="${sx(t)}" y2="${H-mb}" stroke="#dde5ef"/><text x="${sx(t)}" y="${H-10}" fill="#5c6a7d" font-size="9" text-anchor="middle">${t}</text>`; }).join('');
    const gy = [0,0.25,0.5,0.75,1].map(f => { const sv=+(f*Smax).toFixed(3);
      return `<line x1="${ml}" y1="${sy(sv)}" x2="${W-mr}" y2="${sy(sv)}" stroke="#dde5ef"/><text x="${ml-5}" y="${sy(sv)+3}" fill="#5c6a7d" font-size="9" text-anchor="end">${sv}</text>`; }).join('');
    return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto">
      ${gy}${gx}
      <polyline points="${poly}" fill="none" stroke="#0e7fc0" stroke-width="2"/>
      <text x="${ml}" y="${mt-1}" fill="#5c6a7d" font-size="9">Sa</text>
      <text x="${W-mr}" y="${H-2}" fill="#5c6a7d" font-size="9" text-anchor="end">T (s)</text>
    </svg>`;
  }

  // ── Toast notifications ────────────────────────────────────────────────────
  toast(msg, type = '', ms = 3000) {
    const container = document.getElementById('toast-container');
    const el = document.createElement('div');
    el.className = `toast${type ? ' ' + type : ''}`;
    el.textContent = i18n.t(msg);
    container.appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  // ── Modal helpers ──────────────────────────────────────────────────────────
  _bindModal() {
    document.getElementById('modal-cancel')?.addEventListener('click', () => {
      const overlay = document.getElementById('modal-overlay');
      overlay.classList.add('hidden');
      document.getElementById('modal-box')?.classList.remove('modal-wide');
      document.getElementById('modal-cancel').style.display = '';
      if (overlay._reject) overlay._reject(new Error('cancelled'));
    });
    document.getElementById('modal-ok')?.addEventListener('click', () => {
      const overlay = document.getElementById('modal-overlay');
      overlay.classList.add('hidden');
      document.getElementById('modal-box')?.classList.remove('modal-wide');
      document.getElementById('modal-cancel').style.display = '';
      if (overlay._resolve) overlay._resolve(true);
    });
    // Auto-translates the modal content whenever new HTML is injected.
    // characterData:false avoids re-firing when translate() changes text.
    const box = document.getElementById('modal-box');
    if (box) new MutationObserver(() => i18n.translate(box))
      .observe(box, { childList: true, subtree: true, characterData: false });
  }

  _confirm(msg) {
    return new Promise(resolve => {
      const overlay = document.getElementById('modal-overlay');
      document.getElementById('modal-title').textContent = i18n.t('Confirmar');
      document.getElementById('modal-body').innerHTML = `<p style="color:var(--text)">${msg}</p>`;
      document.getElementById('modal-cancel').style.display = '';
      overlay.classList.remove('hidden');
      overlay._resolve = resolve;
      overlay._reject  = () => resolve(false);
    });
  }

  _alert(title, html) {
    const overlay = document.getElementById('modal-overlay');
    document.getElementById('modal-title').textContent = i18n.t(title);
    document.getElementById('modal-body').innerHTML = html;
    document.getElementById('modal-cancel').style.display = 'none';
    overlay.classList.remove('hidden');
    overlay._resolve = () => {};
    overlay._reject  = () => {};
  }

  // ── Electron native menu → app methods ────────────────────────────────────
  _bindElectronMenu() {
    if (!window.electronAPI) return;
    window.electronAPI.onMenu('menu:new',  () => this.newFile());
    window.electronAPI.onMenu('menu:open', () => this.openFile());
    window.electronAPI.onMenu('menu:save', () => this.saveFile());
    window.electronAPI.onMenu('menu:undo', () => this.undo());
    window.electronAPI.onMenu('menu:redo', () => this.redo());
  }

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────
  _bindKeys() {
    document.addEventListener('keydown', e => {
      const tag = document.activeElement?.tagName;
      const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      const ctrl = e.ctrlKey || e.metaKey;

      if (ctrl) {
        switch (e.key.toLowerCase()) {
          case 'z': e.preventDefault(); this.undo();        break;
          case 'y': e.preventDefault(); this.redo();        break;
          case 's': e.preventDefault(); this.saveFile();    break;
          case 'o': e.preventDefault(); this.openFile();    break;
          case 'n': e.preventDefault(); this.newFile();     break;
          case 'a': e.preventDefault(); this.viewport.selectAll(); break;
        }
        return;
      }

      if (inInput) return;

      switch (e.key.toLowerCase()) {
        case 's':      this.viewport.setMode('select');     break;
        case 'n':      this.viewport.setMode('addnode');    break;
        case 'e':      this.viewport.setMode('addelem');    break;
        case 'r':      this.viewport.setMode('addsupport'); break;
        case 'd':      this.viewport.toggleIds();           break;
        case 'x':      this.viewport.toggleExtruded();      break;
        case 'delete':
        case 'backspace': this.deleteSelected();            break;
        case 'home':   this.viewport.zoomExtents();         break;
        case 'i':      this.viewport.setView('iso');        break;
        case 't':      this.viewport.setView('top');        break;
        case 'f':      this.viewport.setView('front');      break;
        case 'l':      this.viewport.setView('side');       break;
        case 'g':      this.viewport.toggleGrid();          break;
        case 'h':      if (e.shiftKey) this.showAllElements(); else this.hideSelected(); break;
      }
    });
  }

  // ── Example loader ─────────────────────────────────────────────────────────
  async _loadExample() {
    try {
      const resp = await fetch('examples/portico_simple.s3d');
      if (!resp.ok) return;
      const text = await resp.text();
      this._loadJSON(text, 'portico_simple.s3d', true);   // keepResults: the signature decides
      this._dirty = false;
      this._updateTitle('portico_simple');
    } catch {
      // No example available — start empty, that's fine
    }
  }
}

// ── Module helpers ────────────────────────────────────────────────────────────
function _parseSpectrum(text) {
  const pts = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split(/[\s,;]+/);
    const T  = parseFloat(parts[0]);
    const Sa = parseFloat(parts[1]);
    if (isFinite(T) && isFinite(Sa) && T >= 0 && Sa >= 0) pts.push({ T, Sa });
  }
  pts.sort((a, b) => a.T - b.T);
  return pts;
}

// ── Element-force superposition helpers for load combinations ─────────────────
const _EF_SCALAR_KEYS = ['N','Vy1','Vz1','T','My1','Mz1','Vy2','Vz2','My2','Mz2',
                          'Vmax','Mmax','Nabs','qy','qz'];

function _scaleEF(ef, factor) {
  const out = { ...ef };   // copy geometry (ex,ey,ez,L,_ue)
  for (const k of _EF_SCALAR_KEYS) out[k] = (ef[k] ?? 0) * factor;
  return out;
}

function _addScaledEF(target, ef, factor) {
  for (const k of _EF_SCALAR_KEYS) target[k] = (target[k] ?? 0) + (ef[k] ?? 0) * factor;
}

// ── Bootstrap ────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  // White-label: applies branding.default.json to the DOM BEFORE starting the App, so
  // the i18n engine caches the already-«branded» text as the original. If it fails, it
  // uses the default values (the UI already carries the Spanish) and doesn't block startup.
  await loadBranding('?v=2');
  window.app = new App();
});

