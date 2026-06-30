// ──────────────────────────────────────────────────────────────────────────────
// model_ops — DETERMINISTIC executor of model-modification operations.
//
// The assistant (LLM in the Cloudflare Worker) translates a natural-language order
// into a list of structured OPERATIONS; this module applies them to the already-built
// model. Keeping the executor deterministic and verifiable makes the LLM approach
// safe: the model never ends up in a state the LLM cannot describe with these bounded
// operations.
//
// Operation schema (each is an object with `op`):
//   { op:'add_load',      target, caso?, dir?, w, w2? }
//   { op:'add_story',     height, copies? }
//   { op:'add_bay',       dir:'x'|'y', span, copies? }
//   { op:'set_modifiers', target, mods:{A?,Iy?,Iz?,J?} }
//   { op:'set_mass',      target, mass:{mx?,my?,mz?} }
// target ∈ 'selection' | 'all' | 'all_beams' | 'columns' | number[] (ids).
// ──────────────────────────────────────────────────────────────────────────────

const TOL = 1e-6;

/** Applies a list of operations to the model. ctx provides the current selection.
 *  Returns { resumen:[], warnings:[], creados:{nodes,elements} }. */
export function applyOperations(model, ops, ctx = {}) {
  const out = { resumen: [], warnings: [], creados: { nodes: 0, elements: 0 } };
  if (!Array.isArray(ops) || ops.length === 0) {
    out.avisos.push('El asistente no devolvió ninguna operación.');
    return out;
  }
  for (const raw of ops) {
    const op = raw && raw.op;
    try {
      if (op === 'add_load')           _addLoad(model, raw, ctx, out);
      else if (op === 'add_story')     _addStory(model, raw, out);
      else if (op === 'add_bay')       _addBay(model, raw, out);
      else if (op === 'set_modifiers') _setModifiers(model, raw, ctx, out);
      else if (op === 'set_mass')      _setMass(model, raw, ctx, out);
      else out.avisos.push(`Operación no reconocida: "${op}".`);
    } catch (e) {
      out.avisos.push(`Error en "${op}": ${e.message}`);
    }
  }
  return out;
}

// ── Geometry helpers ────────────────────────────────────────────────────────
function _len(model, e) {
  const a = model.nodes.get(e.n1), b = model.nodes.get(e.n2);
  return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
}
function _isBeam(model, e) {            // nearly horizontal: |dz| < 0.2·L
  const a = model.nodes.get(e.n1), b = model.nodes.get(e.n2);
  const L = _len(model, e) || 1;
  return Math.abs(b.z - a.z) < 0.2 * L;
}
function _isColumn(model, e) {          // nearly vertical
  const a = model.nodes.get(e.n1), b = model.nodes.get(e.n2);
  const L = _len(model, e) || 1;
  return Math.abs(b.z - a.z) > 0.8 * L;
}

/** Resolves the target to a list of ELEMENT ids. */
function _resolveElems(model, target, ctx) {
  if (Array.isArray(target)) return target.map(Number).filter(id => model.elements.has(id));
  const all = [...model.elements.values()];
  switch (target) {
    case 'selection': return (ctx.selection || []).filter(id => model.elements.has(id));
    case 'all_beams': return all.filter(e => _isBeam(model, e)).map(e => e.id);
    case 'columns':   return all.filter(e => _isColumn(model, e)).map(e => e.id);
    case 'all':
    case undefined:
    case null:        return all.map(e => e.id);
    default:          return [];
  }
}
/** Resolves the target to a list of NODE ids. */
function _resolveNodes(model, target, ctx) {
  if (Array.isArray(target)) return target.map(Number).filter(id => model.nodes.has(id));
  if (target === 'selection') return (ctx.selectedNodes || []).filter(id => model.nodes.has(id));
  if (target === 'all' || target == null) return [...model.nodes.keys()];
  return [];
}

// ── add_load ────────────────────────────────────────────────────────────────
function _addLoad(model, op, ctx, out) {
  const dir = op.dir || 'gravity';
  const w  = +op.w || 0;
  const w2 = (op.w2 == null || op.w2 === '') ? null : +op.w2;
  let target = op.target ?? ((ctx.selection && ctx.selection.length) ? 'selection' : 'all_beams');
  const ids = _resolveElems(model, target, ctx);
  if (!ids.length) { out.avisos.push('add_load: no hay elementos objetivo.'); return; }

  // Load case: search by name/live type by default, or create one.
  const wantLive = !op.caso || /viva|sobrecarga|live|uso|\bl\b/i.test(op.caso);
  let lc = [...model.loadCases.values()].find(l => l.type === 'static' &&
    (op.caso ? l.name === op.caso : (wantLive && /viva|sobrecarga|live|uso|\bl\b/i.test(l.name))));
  if (!lc) lc = model.addLoadCase(op.caso || 'L — Sobrecarga de uso', false);

  for (const id of ids) {
    const i = lc.loads.findIndex(l => l.type === 'dist' && l.elemId === id);
    const load = { type: 'dist', elemId: id, dir, w };
    if (w2 != null && w2 !== w) load.w2 = w2;
    if (i >= 0) lc.loads[i] = load; else lc.loads.push(load);
  }
  out.resumen.push(`Carga ${w2 != null ? `trapecial ${w}→${w2}` : `${w}`} kN/m (${dir}) en ${ids.length} elemento(s), caso "${lc.name}".`);
}

// ── Copy a "face" of nodes by an offset (core of appending a story/bay) ──
// Copies the face nodes (inheriting supports/springs/mass), replicates the elements
// internal to the face (both ends on the face) and creates one connector per node
// between the original and its copy. Returns {map, nElem}.
function _copyFace(model, faceIds, offset, connSecId, connMatId) {
  const map = new Map();
  for (const id of faceIds) {
    const n = model.nodes.get(id);
    const nn = model.addNode(n.x + offset[0], n.y + offset[1], n.z + offset[2]);
    // inherit supports/springs/mass (key so a new bay at the base gets its
    // supports and does not end up as a mechanism)
    nn.restraints = { ...n.restraints };
    if (n.springs)  nn.springs  = { ...n.springs };
    if (n.nodeMass) nn.nodeMass = { ...n.nodeMass };
    map.set(id, nn.id);
  }
  const faceSet = new Set(faceIds);
  let nElem = 0;
  // elements internal to the face → replicate
  for (const e of [...model.elements.values()]) {
    if (faceSet.has(e.n1) && faceSet.has(e.n2)) {
      const ne = model.addElement(map.get(e.n1), map.get(e.n2), e.matId, e.secId);
      if (ne) { ne.releases = [...e.releases]; nElem++; }
    }
  }
  // connectors original → copy
  for (const id of faceIds) {
    const ne = model.addElement(id, map.get(id), connMatId, connSecId);
    if (ne) nElem++;
  }
  return { map, nElem };
}

// Representative section/material of a set (the most frequent).
function _repSecMat(model, elems) {
  if (!elems.length) {
    return { secId: model._firstKey?.('sections') ?? [...model.sections.keys()][0],
             matId: model._firstKey?.('materials') ?? [...model.materials.keys()][0] };
  }
  const cnt = new Map();
  for (const e of elems) cnt.set(e.secId, (cnt.get(e.secId) || 0) + 1);
  const secId = [...cnt.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const matId = elems.find(e => e.secId === secId)?.matId ?? elems[0].matId;
  return { secId, matId };
}

// ── add_story: replicates the top level upward ──────────────────────────────
function _addStory(model, op, out) {
  const H = +op.height || 3;
  const copies = Math.max(1, Math.min(20, +op.copies || 1));
  const cols = [...model.elements.values()].filter(e => _isColumn(model, e));
  const conn = _repSecMat(model, cols);     // connectors = columns
  let total = 0;
  for (let c = 0; c < copies; c++) {
    const zTop = Math.max(...[...model.nodes.values()].map(n => n.z));
    const faceIds = [...model.nodes.values()].filter(n => Math.abs(n.z - zTop) < TOL).map(n => n.id);
    if (!faceIds.length) { out.avisos.push('add_story: no se encontró el nivel superior.'); break; }
    // the copies of the top level must NOT inherit supports
    const before = model.nodes.size;
    const { nElem, map } = _copyFace(model, faceIds, [0, 0, H], conn.secId, conn.matId);
    for (const id of map.values()) model.nodes.get(id).restraints = { ux:0,uy:0,uz:0,rx:0,ry:0,rz:0 };
    total += nElem;
    out.creados.nodes += model.nodes.size - before;
    out.creados.elements += nElem;
  }
  out.resumen.push(`${copies} piso(s) anexado(s) encima (H=${H} m): +${total} elementos.`);
}

// ── add_bay: extends the plan by one bay toward +x or +y ────────────────────
function _addBay(model, op, out) {
  const dir = (op.dir === 'y') ? 'y' : 'x';
  const span = +op.span || 5;
  const copies = Math.max(1, Math.min(20, +op.copies || 1));
  const beams = [...model.elements.values()].filter(e => _isBeam(model, e));
  const conn = _repSecMat(model, beams);    // connectors = beams
  const offset = dir === 'x' ? [span, 0, 0] : [0, span, 0];
  let total = 0;
  for (let c = 0; c < copies; c++) {
    const coord = n => (dir === 'x' ? n.x : n.y);
    const mx = Math.max(...[...model.nodes.values()].map(coord));
    const faceIds = [...model.nodes.values()].filter(n => Math.abs(coord(n) - mx) < TOL).map(n => n.id);
    if (!faceIds.length) { out.avisos.push('add_bay: no se encontró el plano extremo.'); break; }
    const before = model.nodes.size;
    const { nElem } = _copyFace(model, faceIds, offset, conn.secId, conn.matId);
    total += nElem;
    out.creados.nodes += model.nodes.size - before;
    out.creados.elements += nElem;
  }
  out.resumen.push(`${copies} vano(s) anexado(s) en +${dir} (luz=${span} m): +${total} elementos.`);
}

// ── set_modifiers: stiffness factors (clones the section per element) ────────
function _setModifiers(model, op, ctx, out) {
  const ids = _resolveElems(model, op.target ?? 'selection', ctx);
  if (!ids.length) { out.avisos.push('set_modifiers: no hay elementos objetivo.'); return; }
  const mods = op.mods || {};
  const keys = ['A', 'Iy', 'Iz', 'J'];
  if (!keys.some(k => mods[k] != null)) { out.avisos.push('set_modifiers: no se indicaron factores.'); return; }
  // clone the section of each target secId (don't affect other elements)
  const cloneOf = new Map();   // originalSecId → clonedSecId
  for (const id of ids) {
    const e = model.elements.get(id);
    if (!cloneOf.has(e.secId)) {
      const base = model.sections.get(e.secId);
      // do NOT carry the base id (it would overwrite the new id in addSection).
      const { id: _omitId, mod: baseMod, ...rest } = base;
      const clon = model.addSection({ ...rest, name: `${base.name} (mod)` });
      clon.mod = { ...(baseMod || { A:1, Iy:1, Iz:1, J:1 }) };
      for (const k of keys) if (mods[k] != null) clon.mod[k] = +mods[k];
      cloneOf.set(e.secId, clon.id);
    }
    e.secId = cloneOf.get(e.secId);
  }
  const desc = keys.filter(k => mods[k] != null).map(k => `${k}×${mods[k]}`).join(', ');
  out.resumen.push(`Modificadores ${desc} aplicados a ${ids.length} elemento(s) (sección clonada).`);
}

// ── set_mass: concentrated nodal mass (ton) ─────────────────────────────────
function _setMass(model, op, ctx, out) {
  const ids = _resolveNodes(model, op.target ?? 'selection', ctx);
  if (!ids.length) { out.avisos.push('set_mass: no hay nodos objetivo.'); return; }
  const m = op.mass || {};
  for (const id of ids) {
    const nd = model.nodes.get(id);
    nd.nodeMass = {
      mx:  m.mx  != null ? +m.mx  : (nd.nodeMass?.mx  || 0),
      my:  m.my  != null ? +m.my  : (nd.nodeMass?.my  || 0),
      mz:  m.mz  != null ? +m.mz  : (nd.nodeMass?.mz  || 0),
      irx: m.irx != null ? +m.irx : (nd.nodeMass?.irx || 0),
      iry: m.iry != null ? +m.iry : (nd.nodeMass?.iry || 0),
      irz: m.irz != null ? +m.irz : (nd.nodeMass?.irz || 0),
    };
  }
  out.resumen.push(`Masa nodal (mx=${m.mx ?? '–'}, my=${m.my ?? '–'}, mz=${m.mz ?? '–'}) en ${ids.length} nodo(s).`);
}
