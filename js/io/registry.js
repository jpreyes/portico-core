// ──────────────────────────────────────────────────────────────────────────────
// io/registry.js — REGISTRY of exchange formats (#74, G18)
//
// General, extensible API to import/export the model to ANY engine.  A format is an
// adapter  { id, name, ext, caps, write(neutral)→string, read(text)→neutral }  that
// only knows the NEUTRAL MODEL (`neutral.js`).  Adding an engine = `registerFormat({…})`;
// no need to touch the `Model`, the solver or the UI.  The UI and the public API read
// this registry to populate menus and resolve the adapter by id.
//
//   registerFormat(def)            → registers/overwrites an adapter
//   getFormat(id) / listFormats()  → query
//   exportModel(model, id)         → { text, ext, warnings }
//   importModel(text, id)          → { model, warnings }
// ──────────────────────────────────────────────────────────────────────────────
import { modelToNeutral, neutralToModel } from './neutral.js?v=3';

const _formats = new Map();

/**
 * Registers a format adapter.
 * @param {object} def
 *   id    {string}  unique identifier ('vector', 'abaqus', 'sap2000', …)
 *   name  {string}  human-readable name for the UI
 *   ext   {string}  default extension without dot ('dat', 'inp', 's2k', …)
 *   caps  {object}  { write:bool, read:bool } capabilities
 *   write {(neutral)=>string}   serializes the neutral model to format text
 *   read  {(text)=>neutral}     parses format text into the neutral model
 */
export function registerFormat(def) {
  if (!def || !def.id) throw new Error('registerFormat: falta id');
  _formats.set(def.id, {
    id: def.id, name: def.name || def.id, ext: def.ext || 'txt',
    caps: { write: !!def.write, read: !!def.read, ...(def.caps || {}) },
    write: def.write, read: def.read,
  });
  return def.id;
}

export function getFormat(id) { return _formats.get(id) || null; }

/** List of registered adapters (without the functions) to populate the UI. */
export function listFormats() {
  return [..._formats.values()].map(f => ({ id: f.id, name: f.name, ext: f.ext, caps: f.caps }));
}

/**
 * Exports a PORTICO `Model` to format `id`.
 * @returns {{ text:string, ext:string, warnings:string[] }}
 */
export function exportModel(model, id) {
  const f = getFormat(id);
  if (!f) throw new Error(`Formato desconocido: ${id}`);
  if (!f.write) throw new Error(`El formato «${f.name}» no soporta exportar`);
  const neutral = modelToNeutral(model);
  const text = f.write(neutral);
  return { text, ext: f.ext, warnings: [...(neutral.meta?.warnings || []), ...(neutral.meta?.exportWarnings || [])] };
}

/**
 * Imports text of format `id` into a new PORTICO `Model`.
 * @returns {{ model:Model, warnings:string[] }}
 */
export function importModel(text, id) {
  const f = getFormat(id);
  if (!f) throw new Error(`Formato desconocido: ${id}`);
  if (!f.read) throw new Error(`El formato «${f.name}» no soporta importar`);
  const neutral = f.read(text);
  const model = neutralToModel(neutral);
  return { model, warnings: neutral.meta?.warnings || [] };
}
