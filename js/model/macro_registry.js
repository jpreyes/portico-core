// ──────────────────────────────────────────────────────────────────────────────
// macro_registry.js — MACROMODEL REGISTRY (#86)
//
// A macromodel is a complex structural subsystem solved with FEW calibrated elements
// (nonlinear bars/cables/springs/links) instead of a fine mesh — e.g. an infill wall
// → equivalent diagonal strut. This registry makes ADDING a new macromodel as simple
// as registering a descriptor `{ id, name, nodes, params, expand }`; no need to touch
// the solver nor (with the generic UI) write a new dialog.
//
// The author develops the macromodel THEORY separately (strut/spring/hysteresis
// calibration) and here it is just "plugged in": `expand(model, nodeIds, props)`
// builds the already-calibrated element network in the model and tags them with
// `el.macro`/`el.macroType`.
//
//   registerMacro(def)                    → registers/overwrites a macromodel
//   getMacro(id) / listMacros()           → query (the UI reads this for the menu)
//   insertMacro(model, id, nodeIds, props)→ runs the expand; { error } | { …, macroId }
// ──────────────────────────────────────────────────────────────────────────────

const _macros = new Map();

/**
 * Registers a pluggable macromodel.
 * @param {object} def
 *   id        {string}   unique identifier ('infill', 'shearwall', 'bracing', …)
 *   name      {string}   readable name (menu/dialog)
 *   desc      {string}   short description (1 line) — theoretical reference
 *   nodes     {number}   number of nodes the user selects (e.g. 4 corners)
 *   nodesHint {string}   help text about which nodes to select
 *   dims      {'2D'|'3D'|null}  mode restriction (null = both)
 *   params    {Array}    parameter descriptors to auto-generate the dialog:
 *                        [{ key, label, default, step?, min? }]
 *   expand    {(model, nodeIds:number[], props:object) => ({error}|{macroId,...})}
 *             builds the internal network in the model (calibrated elements); it must
 *             tag each created element with `el.macro=<num id>` and `el.macroType=def.id`,
 *             and register the macro in `model.macros` (see `insertInfill` as an example).
 */
export function registerMacro(def) {
  if (!def || !def.id) throw new Error('registerMacro: falta id');
  if (typeof def.expand !== 'function') throw new Error(`registerMacro «${def.id}»: falta expand()`);
  _macros.set(def.id, {
    id: def.id, name: def.name || def.id, desc: def.desc || '',
    nodes: def.nodes || 0, nodesHint: def.nodesHint || '', dims: def.dims || null,
    params: def.params || [], expand: def.expand,
  });
  return def.id;
}

export function getMacro(id) { return _macros.get(id) || null; }

/** Descriptors of the registered macromodels (without the functions) for the UI. */
export function listMacros() {
  return [..._macros.values()].map(({ id, name, desc, nodes, nodesHint, dims, params }) => ({ id, name, desc, nodes, nodesHint, dims, params }));
}

/**
 * Inserts a macromodel into the model.
 * @returns {{error:string} | {macroId:number, ...}}
 */
export function insertMacro(model, id, nodeIds, props = {}) {
  const def = getMacro(id);
  if (!def) return { error: `Macromodelo desconocido: ${id}` };
  if (def.dims && model.mode !== def.dims) return { error: `«${def.name}» requiere un modelo ${def.dims}.` };
  if (def.nodes && (!Array.isArray(nodeIds) || nodeIds.length !== def.nodes)) return { error: `Seleccione ${def.nodes} nodo(s): ${def.nodesHint || ''}` };
  return def.expand(model, nodeIds, props);
}
