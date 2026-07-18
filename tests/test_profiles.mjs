// test_profiles.mjs — verificación del catálogo de perfiles tabulados (#66)
//   node test_profiles.mjs
import { getProfile, profileToSection, catalogNames, CATALOG } from '../js/design/profiles.js';

let fails = 0;
const ok = (name, got, exp, tol) => { const e = Math.abs(got - exp) / (Math.abs(exp) || 1); const p = e <= tol; if (!p) fails++; console.log(`${p ? '✓' : '✗'} ${name}: got=${got.toExponential(4)} exp=${exp.toExponential(4)} err=${(e * 100).toFixed(2)}%`); };
const assert = (name, c, info = '') => { if (!c) fails++; console.log(`${c ? '✓' : '✗'} ${name}${info ? ' · ' + info : ''}`); };

// (1) IPE300: A≈53.8 cm², Iz≈8356 cm⁴, Wpl,z(Zz)≈628 cm³ (valores tabulados EN).
{
  const s = profileToSection('IPE300');
  ok('1a. IPE300 A ≈ 53.8 cm² (nominal, sin radios)', s.A, 53.8e-4, 0.05);
  ok('1b. IPE300 Iz ≈ 8356 cm⁴ (nominal <tabulado por radios)', s.Iz, 8356e-8, 0.05);
  const g = (await import('../js/design/section_props.js')).fromShape('I', s.design.dims);
  ok('1c. IPE300 Zz ≈ 628 cm³', g.Zz, 628e-6, 0.05);
}
// (2) HEB200: A≈78.1 cm², Iz≈5696 cm⁴.
{
  const s = profileToSection('HEB200');
  ok('2a. HEB200 A ≈ 78.1 cm²', s.A, 78.1e-4, 0.05);
  ok('2b. HEB200 Iz ≈ 5696 cm⁴', s.Iz, 5696e-8, 0.05);
}
// (3) Estructura del catálogo y resolución.
{
  assert('3a. IPE tiene 18 perfiles', catalogNames('IPE').length === 18, `n=${catalogNames('IPE').length}`);
  assert('3b. getProfile devuelve familia+dims', getProfile('HEA240')?.family === 'HEA');
  assert('3c. perfil inexistente → null', profileToSection('XXX999') === null);
  const s = profileToSection('CHS 114.3x5');
  assert('3d. CHS resuelve como tubo (Iz=Iy)', Math.abs(s.Iz - s.Iy) < 1e-12, `Iz=${s.Iz}`);
}
// (4) profileToSection escribe design.shape + design.profile + props del solver.
{
  const s = profileToSection('IPE400');
  assert('4. props completas', s.A > 0 && s.Iz > 0 && s.J > 0 && s.design.shape === 'I' && s.design.profile === 'IPE400');
}

console.log(fails === 0 ? '\nTODO OK ✓' : `\n${fails} FALLO(S) ✗`);
process.exit(fails ? 1 : 0);
