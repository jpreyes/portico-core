// ──────────────────────────────────────────────────────────────────────────────
// material_props.js — GENERALIZED DESIGN properties of a material.
//
// Previously the design depended on a global JSON by TYPE (a single Fy for all steel,
// a single f'c for all concrete) and guessed the type from the NAME. Now each
// material can carry its own `design` block with its family and strengths, so ANY
// material —with whatever properties— is designable. The legacy JSON
// (design_params.json) remains only as a fallback.
//
// Strengths are stored in MPa in mat.design (intuitive for the user) and this
// resolver returns them in MODEL UNITS (kN/m²) so the codes work consistently
// alongside E (kN/m²) and the forces (kN).
// ──────────────────────────────────────────────────────────────────────────────

const MPA = 1000;   // 1 MPa → kN/m²

// Classification by name (compatibility: materials without design.family).
export function clasificarMaterial(nombre) {
  const n = String(nombre || '').toLowerCase();
  if (/(horm|concret|h\s*\d|fc|c\d{2}\/\d{2})/.test(n)) return 'concrete';
  if (/(mader|pino|wood|gl\b|lvl|conif|timber)/.test(n)) return 'timber';
  if (/(alum)/.test(n)) return 'aluminum';
  if (/(acero|steel|s\s*\d{2,3}|a\s*\d{2,3}|metalcon|ipe|heb|hea|ipn|astm)/.test(n)) return 'steel';
  return 'steel';   // default: steel
}

// Family alias map (es/en) → canonical key.
const FAM = { steel: 'steel', steel: 'steel', concrete: 'concrete', hormigón: 'concrete',
  concrete: 'concrete', timber: 'timber', timber: 'timber', aluminio: 'aluminum', aluminum: 'aluminum' };

// Default strengths per family (MPa), if neither the material nor the JSON provide them.
const DEF = {
  steel:    { Fy: 250, Fu: 400 },
  concrete: { fc: 25, fyRebar: 420 },
  timber:   { Fb: 10, Fv: 1.2, Fc: 8, Ft: 7, Fcp: 2.5 },
  aluminum: { Fy: 165, Fu: 215 },
};

// Takes a design value (MPa) → kN/m², with the cascade material → legacy JSON → default.
function val(mat, legacy, keysDesign, keyLegacy, def) {
  const d = mat.design || {};
  for (const k of keysDesign) if (typeof d[k] === 'number' && d[k] > 0) return d[k] * MPA;
  if (legacy && typeof legacy[keyLegacy] === 'number' && legacy[keyLegacy] > 0) return legacy[keyLegacy] * MPA;
  return def * MPA;
}

// Resolves the family and ALL the design strengths (in kN/m²) of a material.
//   mat:    model material { name, E (kN/m²), G, nu, design?:{...} }
//   params: design_params.json (legacy fallback) — optional.
export function resolveMaterial(mat, params = {}) {
  const d = mat.design || {};
  const family = FAM[String(d.family || '').toLowerCase()] || clasificarMaterial(mat.name);
  // legacy JSON keys per family
  const legKey = { steel: 'steel', concrete: 'concrete', timber: 'timber', aluminum: 'steel' }[family];
  const legacy = params[legKey] || {};
  const def = DEF[family] || DEF.steel;

  const E = mat.E > 0 ? mat.E : (legacy.E_MPa || 200000) * MPA;   // kN/m² (from the material)
  const G = mat.G > 0 ? mat.G : E / (2 * (1 + (mat.nu ?? 0.3)));
  const out = { family, E, G, nu: mat.nu ?? 0.3, name: mat.name };

  if (family === 'steel' || family === 'aluminum') {
    out.Fy = val(mat, legacy, ['Fy', 'Fy_MPa'], 'Fy_MPa', def.Fy);
    out.Fu = val(mat, legacy, ['Fu', 'Fu_MPa'], 'Fu_MPa', def.Fu);
  } else if (family === 'concrete') {
    out.fc = val(mat, legacy, ['fc', 'fc_MPa'], 'fc_MPa', def.fc);
    out.fyRebar = val(mat, legacy, ['fyRebar', 'fy_rebar_MPa'], 'fy_rebar_MPa', def.fyRebar);
    out.Ec = mat.E > 0 ? mat.E : (legacy.E_MPa || 23500) * MPA;
  } else if (family === 'timber') {
    out.Fb = val(mat, legacy, ['Fb', 'Fb_MPa'], 'Fb_MPa', def.Fb);
    out.Fv = val(mat, legacy, ['Fv', 'Fv_MPa'], 'Fv_MPa', def.Fv);
    out.Fc = val(mat, legacy, ['Fc', 'Fc_MPa'], 'Fc_MPa', def.Fc);
    out.Ft = val(mat, legacy, ['Ft', 'Ft_MPa'], 'Ft_MPa', def.Ft);
    out.Fcp = val(mat, legacy, ['Fcp', 'Fcp_MPa'], 'Fcp_MPa', def.Fcp || 2.5);
    // modification factors (timber): product of Ki
    const fmod = d.modification_factors || legacy.modification_factors || {};
    out.kmod = (fmod.KD_load_duration ?? 1) * (fmod.KH_moisture ?? 1) *
               (fmod.Kt_temperature ?? 1) * (fmod.others ?? 1);
  }
  return out;
}

export { MPA };
