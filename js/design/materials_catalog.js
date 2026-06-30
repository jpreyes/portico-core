// ──────────────────────────────────────────────────────────────────────────────
// materials_catalog.js — Preloaded LIBRARY of standard MATERIALS (#69).
//
// Typical materials (steel, concrete, timber, aluminum) ready to insert into the
// model. Each carries E/G/ν/ρ/α in MODEL UNITS (E,G in kN/m²; ρ in t/m³; α in 1/°C)
// and its `design` block with family + strengths in MPa (what the G15 design engine
// consumes). Editable after insertion.
//
// (The steel PROFILE library is in `profiles.js`, #66.)
// ──────────────────────────────────────────────────────────────────────────────

const STEEL = (Fy, Fu, E = 2.1e8) => ({ E, G: E / 2.6, nu: 0.3, rho: 7.85, alpha: 1.2e-5,
  design: { family: 'steel', Fy, Fu, E: E / 1000 } });
const CONC = (fc, E) => ({ E, G: E / 2.4, nu: 0.2, rho: 2.5, alpha: 1.0e-5,
  design: { family: 'concrete', fc, fyRebar: 420 } });
const TIMBER = (Fb, Fc, Ft, Fv, E, rho) => ({ E, G: E / 16, nu: 0.3, rho, alpha: 5e-6,
  design: { family: 'timber', Fb, Fc, Ft, Fv, Fcp: 2.5 } });

export const MATERIALS = {
  // Structural steel (E≈210 GPa; A36/A572 at 200 GPa per ASTM convention).
  'Acero A36':         STEEL(250, 400, 2.0e8),
  'Acero A572 Gr.50':  STEEL(345, 450, 2.0e8),
  'Acero S275':        STEEL(275, 430, 2.1e8),
  'Acero S355':        STEEL(355, 490, 2.1e8),
  // Concrete — grade G by characteristic cylindrical f'c (NCh170:2016).
  // E = 4700√f'c MPa approx → kN/m².
  'Hormigón G20':      CONC(20, 2.10e7),
  'Hormigón G25':      CONC(25, 2.35e7),
  'Hormigón G30':      CONC(30, 2.57e7),
  'Hormigón G40':      CONC(40, 2.97e7),
  // Sawn timber (EN 338 / typical characteristic values).
  'Madera C16':        TIMBER(16, 17, 8.5, 1.8, 8.0e6, 0.37),
  'Madera C24':        TIMBER(24, 21, 14, 2.5, 1.1e7, 0.42),
  // Aluminum (E≈70 GPa; fo = 0.2 % proof stress).
  'Aluminio 6061-T6':  { E: 7.0e7, G: 2.6e7, nu: 0.33, rho: 2.7, alpha: 2.3e-5,
                         design: { family: 'aluminum', Fy: 240, Fu: 260, E: 70000 } },
};

// Families to group in the UI.
export const MATERIAL_FAMILIES = {
  Acero:    ['Acero A36', 'Acero A572 Gr.50', 'Acero S275', 'Acero S355'],
  Hormigón: ['Hormigón G20', 'Hormigón G25', 'Hormigón G30', 'Hormigón G40'],
  Madera:   ['Madera C16', 'Madera C24'],
  Aluminio: ['Aluminio 6061-T6'],
};

export function materialNames() { return Object.keys(MATERIALS); }

// Definition ready for `model.addMaterial(...)` (deep copy + name).
export function getMaterialDef(name) {
  const m = MATERIALS[name];
  return m ? { name, ...JSON.parse(JSON.stringify(m)) } : null;
}
