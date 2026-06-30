// test_matcat.mjs — biblioteca de materiales estándar (#69)
//   node test_matcat.mjs
import { MATERIALS, materialNames, getMaterialDef, MATERIAL_FAMILIES } from './js/design/materials_catalog.js';
import { resolveMaterial } from './js/design/material_props.js';

let fails = 0;
const ok = (name, got, exp, tol) => { const e = Math.abs(got - exp) / (Math.abs(exp) || 1); const p = e <= tol; if (!p) fails++; console.log(`${p ? '✓' : '✗'} ${name}: got=${got} exp=${exp}`); };
const assert = (name, c, info = '') => { if (!c) fails++; console.log(`${c ? '✓' : '✗'} ${name}${info ? ' · ' + info : ''}`); };

// (1) S275 resuelve a acero con Fy=275 MPa (→ kN/m²).
{
  const M = resolveMaterial(getMaterialDef('Acero S275'));
  assert('1a. familia steel', M.family === 'steel');
  ok('1b. Fy = 275 MPa (kN/m²)', M.Fy, 275e3, 1e-9);
  ok('1c. E = 210 GPa (kN/m²)', M.E, 2.1e8, 1e-9);
}
// (2) Hormigón G30 → concrete, f'c=30 (grado G, NCh170:2016).
{
  const M = resolveMaterial(getMaterialDef('Hormigón G30'));
  assert('2a. familia concrete', M.family === 'concrete');
  ok('2b. fc = 30 MPa', M.fc, 30e3, 1e-9);
}
// (3) Aluminio → aluminum, fo=240.
{
  const M = resolveMaterial(getMaterialDef('Aluminio 6061-T6'));
  assert('3a. familia aluminum', M.family === 'aluminum');
  ok('3b. fo (Fy) = 240 MPa', M.Fy, 240e3, 1e-9);
  ok('3c. E = 70 GPa', M.E, 7.0e7, 1e-9);
}
// (4) Madera C24 → timber con Fb/Fc/Ft/Fv.
{
  const M = resolveMaterial(getMaterialDef('Madera C24'));
  assert('4. familia timber con Fb=24', M.family === 'timber' && Math.abs(M.Fb - 24e3) < 1, `Fb=${M.Fb}`);
}
// (5) getMaterialDef es copia profunda (no muta el catálogo).
{
  const a = getMaterialDef('Acero A36'); a.design.Fy = 999;
  assert('5. copia profunda (no muta el catálogo)', MATERIALS['Acero A36'].design.Fy === 250);
}
// (6) familias y conteo.
{
  assert('6a. 11 materiales', materialNames().length === 11, `n=${materialNames().length}`);
  assert('6b. 4 familias', Object.keys(MATERIAL_FAMILIES).length === 4);
}

console.log(fails === 0 ? '\nTODO OK ✓' : `\n${fails} FALLO(S) ✗`);
process.exit(fails ? 1 : 0);
