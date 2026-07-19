// ──────────────────────────────────────────────────────────────────────────────
// design.js — element design ORCHESTRATOR (multi-code, generalized).
//
// Previously this file had the steel/concrete/timber formulas embedded and the
// parameters lived in a GLOBAL JSON by type (a single Fy for all steel, etc.),
// guessing the type from the name. Now:
//
//   1. STRENGTHS are properties of the MATERIAL (mat.design) → any material is
//      designable (material_props.js).
//   2. The design GEOMETRY (plastic moduli, slendernesses…) comes from the SHAPE of
//      the section (section_props.js).
//   3. The CODES (AISC 360 LRFD/ASD, Eurocode 3, ACI 318, EC2, NCh1198) are
//      PLUGGABLE modules in a registry (registry.js) and extensible via the API.
//
// Compatibility: if a material has no design.family, it is classified by its name and
// the strengths fall back to the legacy JSON (design_params.json). The signature of
// checkElement remains usable as before.
// ──────────────────────────────────────────────────────────────────────────────

import { resolveMaterial, clasificarMaterial } from './material_props.js?v=4';
import { resolveSectionProps } from './section_props.js?v=4';
import { registerDesignCode, getDesignCode, defaultCodeFor, setDefaultCode, listDesignCodes } from './registry.js?v=4';
import { aisc360_lrfd, aisc360_asd } from './codes/aisc360.js?v=4';
import { eurocode3 } from './codes/eurocode3.js?v=4';
import { aci318, eurocode2 } from './codes/concrete.js?v=4';
import { timber_nch1198 } from './codes/timber.js?v=4';
import { eurocode9 } from './codes/eurocode9.js?v=4';

// ── Registration of the built-in codes (idempotent) ─────────────────────────────
let _registered = false;
export function registerBuiltinCodes() {
  if (_registered) return;
  [aisc360_lrfd, aisc360_asd, eurocode3, aci318, eurocode2, timber_nch1198, eurocode9].forEach(registerDesignCode);
  setDefaultCode('steel', 'AISC360-16:LRFD');
  setDefaultCode('concrete', 'ACI318-19');
  setDefaultCode('timber', 'NCh1198');
  setDefaultCode('aluminum', 'EN1999-1-1');        // Eurocode 9 (aluminum)
  _registered = true;
}
registerBuiltinCodes();

export { clasificarMaterial, listDesignCodes, getDesignCode, registerDesignCode };

// ── Main API ───────────────────────────────────────────────────────────────────
// Input (all optional except forces + sec):
//   forces: { N (kN, + tension / − compression), Vy, Vz, My, Mz (kN·m, magnitudes), L (m) }
//   sec:     model section { A, Iz, Iy, J, Avy, Avz, design?:{shape,dims,rebar,...} }
//   mat:     FULL model material (preferred) { name, E, G, nu, design?:{family,Fy,...} }
//   matName: material name (compat; if mat is not passed)
//   params:  design_params.json (legacy fallback for strengths and limits)
//   codeId:  forced code id (otherwise, default by family or designSettings)
//   designSettings: { codeByFamily:{steel:'EN1993-1-1',...} } from the model
//   member:  { Lb, K, Cb, ... } buckling/LTB overrides
//   options: extra factors for the code
export function checkElement({ forces, sec, mat, matName, params = {}, codeId, designSettings, member, options }) {
  const matObj = mat || { name: matName, E: 0, G: 0, nu: 0.3 };
  const M = resolveMaterial(matObj, params);
  const P = resolveSectionProps(sec, { shapeFactor: params?.steel?.Z_over_S });

  // Choose code: explicit → designSettings by family → default by family.
  let code = codeId ? getDesignCode(codeId) : null;
  if (!code && designSettings?.codeByFamily?.[M.family]) code = getDesignCode(designSettings.codeByFamily[M.family]);
  if (!code) code = defaultCodeFor(M.family) || defaultCodeFor('steel');

  const demands = {
    N: forces.N || 0, Vy: forces.Vy || 0, Vz: forces.Vz || 0,
    My: forces.My || 0, Mz: forces.Mz || 0, T: forces.T || 0,
  };
  const mem = { L: forces.L || 1, Lb: (member?.Lb ?? forces.L ?? 1), K: member?.K ?? 1,
    Cb: member?.Cb ?? 1.0, ho: P.ho, ...(member || {}) };

  // warning/fail limits from the legacy JSON or defaults
  const lim = params.limits || {};
  const opt = { ratio_warning: lim.ratio_warning ?? 0.90, ratio_fail: lim.ratio_fail ?? 1.0,
    long_reinf_ratio: params?.concrete?.long_reinf_ratio, cover_mm: params?.concrete?.cover_mm,
    phi: params?.[{ concrete: 'concrete', steel: 'steel', timber: 'timber' }[M.family]]?.phi,
    ...(options || {}) };

  const r = code.check({ demands, mat: M, sec: P, member: mem, options: opt });
  r.code = code.id; r.codigoLabel = code.label; r.familia = M.family;
  return r;
}
