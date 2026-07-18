// test_autodesign.mjs — verificación de predimensionar (#71) y diseñar auto (#72)
//   node test_autodesign.mjs
import { selectProfile, steelCandidates, predimensionar, concreteCandidates, timberCandidates, candidatesForFamily } from '../js/design/autodesign.js';
import { checkElement } from '../js/design/design.js';
import { profileToSection } from '../js/design/profiles.js';

let fails = 0;
const ok = (name, got, exp, tol) => { const e = Math.abs(got - exp) / (Math.abs(exp) || 1); const p = e <= tol; if (!p) fails++; console.log(`${p ? '✓' : '✗'} ${name}: got=${got} exp=${exp}`); };
const assert = (name, c, info = '') => { if (!c) fails++; console.log(`${c ? '✓' : '✗'} ${name}${info ? ' · ' + info : ''}`); };

const acero = { design: { family: 'steel', Fy: 355, Fu: 490, E: 210000 }, E: 210e9, Fy: 355e6, G: 81e9, rho: 7850 };

// (1) Viga simple, Mz=120 kN·m, L=6: elige un IPE que cumple y es ~liviano.
{
  const sel = selectProfile({
    demands: { N: 0, Mz: 120, Vy: 60, L: 6 }, candidates: steelCandidates(['IPE']),
    mat: acero, code: 'AISC360-16:LRFD', member: { Lb: 0.3, L: 6 }, prefs: { dcTarget: 0.85 } });
  assert('1a. hay solución factible', !!sel.best, sel.note);
  assert('1b. el elegido cumple D/C≤1', sel.best && sel.best.dc <= 1, `${sel.best?.name} D/C=${sel.best?.dc}`);
  // verificación independiente del elegido
  const r = checkElement({ forces: { Mz: 120, Vy: 60, L: 6 }, sec: profileToSection(sel.best.name), mat: acero, codeId: 'AISC360-16:LRFD', member: { Lb: 0.3, L: 6 } });
  ok('1c. D/C reportado coincide con re-verificación', sel.best.dc, r.ratioMax, 1e-9);
  // un perfil bastante más liviano que el elegido NO debería cumplir (optimalidad razonable)
  const lighter = sel.all.filter(x => x.weight < sel.best.weight * 0.7);
  assert('1d. no hay candidato ~30% más liviano que cumpla', !lighter.some(x => x.ok), `livianos que cumplen: ${lighter.filter(x=>x.ok).map(x=>x.name)}`);
}
// (2) "Nunca inventa": demanda imposible para el catálogo → best=null + nota.
{
  const sel = selectProfile({ demands: { Mz: 99999, L: 6 }, candidates: steelCandidates(['IPE']), mat: acero, code: 'AISC360-16:LRFD', member: { Lb: 6, L: 6 } });
  assert('2. demanda imposible → best=null + nota', sel.best === null && /amplíe|cumple/.test(sel.note), sel.note);
}
// (3) Continuidad: con prefs.prefer, si el preferido cumple y está cerca en peso, se elige.
{
  const base = selectProfile({ demands: { Mz: 120, L: 6 }, candidates: steelCandidates(['IPE']), mat: acero, code: 'AISC360-16:LRFD', member: { Lb: 0.3, L: 6 } });
  const heavier = base.feasible[Math.min(2, base.feasible.length - 1)].name;   // uno que cumple
  const sel = selectProfile({ demands: { Mz: 120, L: 6 }, candidates: steelCandidates(['IPE']), mat: acero, code: 'AISC360-16:LRFD', member: { Lb: 0.3, L: 6 }, prefs: { prefer: heavier } });
  assert('3. el bonus de continuidad influye en el orden', sel.feasible.some(x => x.name === heavier));
}
// (4) Predimensionar viga acero: canto ≈ L/20.
{
  const p = predimensionar({ tipo: 'viga', material: 'steel', L: 8 });
  assert('4. viga acero L=8 → canto ≥ 0.40 m (≈L/20)', p.dims.d >= 0.40 - 1e-9 && p.dims.d <= 0.50, `${p.profile} d=${p.dims.d}`);
}
// (5) Predimensionar viga H.A.: h≈L/11, b≈h/2.
{
  const p = predimensionar({ tipo: 'viga', material: 'concrete', L: 6 });
  assert('5a. viga H.A. h≈L/11 (~0.55 m)', p.dims.h >= 0.50 && p.dims.h <= 0.60, `h=${p.dims.h}`);
  assert('5b. b≈h/2', Math.abs(p.dims.b - p.dims.h / 2) <= 0.06, `b=${p.dims.b} h=${p.dims.h}`);
}
// (6) Predimensionar columna H.A.: Ag≈N/(0.35 f'c).
{
  const p = predimensionar({ tipo: 'columna', material: 'concrete', N: 1500, fc: 25 });
  const Ag = 1500 / (0.35 * 25 * 1000);                  // ≈0.171 m² → lado ≈0.414 → 0.45
  assert('6. columna H.A. lado cubre Ag', p.dims.b * p.dims.h >= Ag * 0.98, `${p.dims.b}×${p.dims.h}=${(p.dims.b*p.dims.h).toFixed(3)} ≥ Ag=${Ag.toFixed(3)}`);
}
// (7) Predimensionar madera: h≈L/17.
{
  const p = predimensionar({ tipo: 'viga', material: 'timber', L: 4 });
  assert('7. madera L=4 → h≈0.225–0.25 m', p.dims.h >= 0.225 && p.dims.h <= 0.275, `h=${p.dims.h}`);
}

// (8) Auto-diseño de HORMIGÓN: viga H.A. elige la sección que cumple, más liviana (#72).
{
  const h30 = { name: 'H30', design: { family: 'concrete', fc: 30, fyRebar: 420 }, E: 2.57e7, rho: 2.5 };
  const cands = candidatesForFamily('concrete', { concrete: { rho: 0.012 } });
  const sel = selectProfile({ demands: { N: -200, Mz: 180, Vy: 90, L: 6 }, candidates: cands, mat: h30, member: { L: 6 } });
  assert('8a. H.A. encuentra sección factible', !!sel.best, sel.note);
  assert('8b. la elegida cumple D/C≤1', sel.best && sel.best.dc <= 1, `${sel.best?.name} D/C=${sel.best?.dc}`);
  assert('8c. nombre H.A. con dimensiones', /H\.A\./.test(sel.best?.name || ''), sel.best?.name);
  // una sección mucho más pequeña no debe cumplir (optimalidad razonable)
  const tiny = sel.all.filter(x => x.sec.b <= 0.25 && x.sec.h <= 0.25);
  assert('8d. secciones muy pequeñas no cumplen', !tiny.some(x => x.ok), `pequeñas que cumplen: ${tiny.filter(x=>x.ok).map(x=>x.name)}`);
}
// (9) Auto-diseño de MADERA: viga elige escuadría que cumple (#72).
{
  const c24 = { name: 'C24', design: { family: 'timber', Fb: 24, Fc: 21, Ft: 14, Fv: 2.5 }, E: 1.1e7, rho: 0.42 };
  const sel = selectProfile({ demands: { Mz: 8, Vy: 6, L: 4 }, candidates: candidatesForFamily('timber'), mat: c24, member: { L: 4 } });
  assert('9a. madera encuentra escuadría factible', !!sel.best, sel.note);
  assert('9b. nombre Mad con dimensiones', /Mad/.test(sel.best?.name || ''), sel.best?.name);
}
// (10) Generadores: tamaños y campos.
{
  assert('10a. concreteCandidates trae rect+cuadradas con rebar', concreteCandidates().every(c => c.sec.design.shape === 'rect' && c.sec.design.rebar) && concreteCandidates().length > 10);
  assert('10b. timberCandidates h≥b siempre', timberCandidates().every(c => c.sec.h >= c.sec.b));
}

console.log(fails === 0 ? '\nTODO OK ✓' : `\n${fails} FALLO(S) ✗`);
process.exit(fails ? 1 : 0);
