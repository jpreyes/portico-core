// ──────────────────────────────────────────────────────────────────────────────
// registry.js — Registry of pluggable DESIGN CODES.
//
// Each code (AISC 360, Eurocode 3, ACI 318, NCh1198…) is registered with a uniform
// interface and can be queried by id or by material family. The public API allows
// registering NEW third-party codes without touching the core.
//
// Code interface:
//   {
//     id:     'AISC360-16:LRFD',          // unique identifier
//     family: 'steel',                    // material family it covers
//     label:  'AISC 360-16 (LRFD)',       // readable label
//     check({ demands, mat, sec, member, options }) -> {
//        checks: { axial, shear, flexion, interaccion, ... },   // each {demanda,capacidad,ratio,formula,...}
//        ratioMax, gobierna, estado, metodo
//     }
//   }
// ──────────────────────────────────────────────────────────────────────────────

const _codes = new Map();

export function registerDesignCode(code) {
  if (!code || !code.id) throw new Error('El código de diseño necesita un id.');
  _codes.set(code.id, code);
  return code;
}

export function getDesignCode(id) { return _codes.get(id) || null; }

export function listDesignCodes(family) {
  const all = [..._codes.values()];
  return family ? all.filter(c => c.family === family) : all;
}

// Default code per family (the first registered of that family, unless one was set
// with setDefaultCode).
const _defaults = new Map();
export function setDefaultCode(family, id) { _defaults.set(family, id); }
export function defaultCodeFor(family) {
  if (_defaults.has(family)) return getDesignCode(_defaults.get(family));
  const list = listDesignCodes(family);
  return list[0] || null;
}

export function clearDesignCodes() { _codes.clear(); _defaults.clear(); }
