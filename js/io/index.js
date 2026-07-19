// ──────────────────────────────────────────────────────────────────────────────
// io/index.js — entry point of the INTEROPERABILITY module (#74, G18)
//
// Imports the adapters (which self-register as a side effect) and re-exports the
// registry API.  To add a new engine: create `formats/<engine>.js` that calls
// `registerFormat({ id, name, ext, write, read })` and add it to the import list.
// ──────────────────────────────────────────────────────────────────────────────
export { registerFormat, getFormat, listFormats, exportModel, importModel } from './registry.js?v=6';
export { modelToNeutral, neutralToModel } from './neutral.js?v=6';

// Format adapters (self-registering):
import './formats/vector.js?v=6';
import './formats/abaqus.js?v=6';
import './formats/sap2000.js?v=6';
import './formats/etabs.js?v=6';
import './formats/opensees.js?v=6';
import './formats/sofistik.js?v=6';
import './formats/ndx.js?v=6';
