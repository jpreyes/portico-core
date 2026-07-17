// test_api.mjs — Verificación de la API pública (pre/solver/post/diseño + extensión).
import { Portico } from './js/api/portico.js?v=137';

let fails = 0;
const ok = (cond, msg, extra = '') => { console.log(`${cond ? '✓' : '✗'} ${msg} ${extra}`); if (!cond) fails++; };
const approx = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol * Math.abs(b || 1), msg, `(${(+a).toPrecision(5)} vs ${(+b).toPrecision(5)})`);

console.log('── 1. PRE + SOLVER estático: voladizo con carga de punta ──');
// Voladizo en voladizo plano X-Z: viga horizontal, carga vertical en la punta.
const p = new Portico(); p.set2D(true);
const E = 2e8, I = 8.356e-5, L = 5, P = 10;
const ac = p.material({ name: 'Acero', E, G: 7.7e7, nu: 0.3, design: { family: 'steel', Fy: 250, Fu: 400 } });
const sec = p.section({ name: 'IPE300', A: 5.38e-3, Iz: I, Iy: 6.04e-6, J: 2e-7, Avy: 2.57e-3, Avz: 3.2e-3,
  design: { shape: 'I', d: 0.300, bf: 0.150, tf: 0.0107, tw: 0.0071 } });
const A = p.node(0, 0, 0, { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 });
const B = p.node(L, 0, 0);
p.element(A, B, { mat: ac, sec });
const lc = p.loadCase('Q'); p.nodalLoad(lc, B, { fz: -P });
await p.solveStatic(lc);
const tip = Math.abs(p.displacement(B)[2]);
approx(tip, P * L ** 3 / (3 * E * I), 0.02, 'flecha de punta = PL³/3EI');
ok(p.reaction(A) != null, 'reacción en el empotramiento disponible');
const dia = p.diagram(p.model.elements.keys().next().value, 'Mz');
ok(dia && dia.pts && dia.pts.length > 0, 'diagrama Mz disponible');

console.log('\n── 2. POST: diseño multinorma desde la API ──');
let d = p.design({ codeId: 'AISC360-16:LRFD' });
ok(d.length === 1 && d[0].code === 'AISC360-16:LRFD', 'design() AISC LRFD', `gobierna ${d[0].governs}, ratio ${d[0].ratioMax}`);
d = p.design({ codeId: 'EN1993-1-1' });
ok(d[0].code === 'EN1993-1-1', 'design() Eurocódigo 3', `ratio ${d[0].ratioMax}`);
// designSettings por familia
p.designSettings({ codeByFamily: { steel: 'EN1993-1-1' } });
d = p.design();
ok(d[0].code === 'EN1993-1-1', 'design() usa designSettings.codeByFamily');

console.log('\n── 3. checkMember directo (sin análisis) ──');
const r = p.checkMember({ forces: { N: 500, L: 3 }, matId: ac, secId: sec, codeId: 'AISC360-16:LRFD' });
approx(r.axial.capacity, 0.9 * 250e3 * 5.38e-3, 0.01, 'φPn tracción vía checkMember');

console.log('\n── 4. SOLVER modal ──');
const pm = new Portico(); pm.set2D(true);
const m2 = pm.material({ name: 'Ac', E: 2e8, G: 7.7e7, nu: 0.3, rho: 7.85 });
const s2 = pm.section({ name: 'S', A: 5e-3, Iz: 8e-5, Iy: 8e-5, J: 1e-6 });
let prev = pm.node(0, 0, 0, { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 });
for (let i = 1; i <= 8; i++) { const n = pm.node(i * 0.5, 0, 0); pm.element(prev, n, { mat: m2, sec: s2 }); prev = n; }
await pm.solveModal(3);
ok(pm.period(0) > 0, 'modal: T1 > 0', `T1=${pm.period(0).toFixed(4)} s`);

console.log('\n── 5. Extensibilidad: análisis y código de diseño custom ──');
Portico.registerAnalysis('contarNodos', (model) => model.nodes.size);
const cnt = await p.run('contarNodos');
ok(cnt === 2, 'registerAnalysis + run()', `nodos=${cnt}`);
Portico.registerDesignCode({ id: 'CUSTOM:test', family: 'steel', label: 'Custom', check: () => ({ bending: { ratio: 0.42 }, shear: { ratio: 0 }, axial: { ratio: 0 }, interaction: { ratio: 0 }, ratioMax: 0.42, governs: 'flexión', state: 'cumple' }) });
ok(Portico.listDesignCodes('steel').some(c => c.id === 'CUSTOM:test'), 'registerDesignCode aparece en el catálogo');
d = p.design({ codeId: 'CUSTOM:test' });
ok(d[0].code === undefined ? d[0].ratioMax === 0.42 : d[0].ratioMax === 0.42, 'design() usa el código custom', `ratio ${d[0].ratioMax}`);

console.log('\n── 6. Round-trip s3d con datos de diseño ──');
const json = p.toS3D();
const p2 = Portico.fromS3D(json);
const matBack = p2.model.materials.get(ac);
ok(matBack.design && matBack.design.family === 'steel' && matBack.design.Fy === 250, 'mat.design sobrevive round-trip');
const secBack = p2.model.sections.get(sec);
ok(secBack.design && secBack.design.shape === 'I', 'sec.design sobrevive round-trip');

console.log('\n── 7. Catálogo de códigos ──');
const codes = Portico.listDesignCodes();
ok(codes.some(c => c.id === 'AISC360-16:LRFD') && codes.some(c => c.id === 'EN1993-1-1') && codes.some(c => c.id === 'ACI318-19'),
  'catálogo incluye AISC, EC3, ACI', `(${codes.length} códigos)`);

console.log('\n── 8. Espectro NCh433/DS61 ──');
const spec = Portico.spectrumNCh433({ soil: 'D', zone: 2, category: 'II', Ro: 11, Tstar: 0.5 });
ok(spec.curve.length > 2 && spec.curve[0].T === 0, 'devuelve la curva desde T=0');
ok(spec.Rstar > 5 && spec.Rstar < 5.3, 'R* razonable para suelo D, T*=0.5', `(R*=${spec.Rstar.toFixed(3)})`);
ok(spec.params.Tp === 0.85 && spec.params.n === 1.80, 'preserva Tp y n del suelo D');

console.log('\n── 9. solveSpectrum (cableado del SpectrumSolver) ──');
{
  // SDOF: columna vertical de 1 elemento, sin masa propia, con masa concentrada en la
  // punta → un oscilador limpio. Pinchamos las mismas identidades que test_spectrum:
  //   desplazamiento de punta = Sa/ω²   y   corte basal = m_eff·Sa.
  const ps = new Portico();
  const mt = ps.material({ name: 'S', E: 2.1e11, G: 8.0e10, nu: 0.3125, rho: 0 });
  const st = ps.section({ name: 'C', A: 0.01, Iy: 8e-6, Iz: 8e-6, J: 1e-6, Avy: 1e30, Avz: 1e30, kappay: 1, kappaz: 1 });
  const base = ps.node(0, 0, 0, { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 });
  const tip = ps.node(0, 0, 3, { uy: 1, uz: 1, ry: 1, rz: 1 });   // sólo ux libre
  ps.element(base, tip, { mat: mt, sec: st });
  ps.model.updateNode(tip, { nodeMass: { mx: 50, my: 50, mz: 50 } });

  const flatSa = 4.0, spectrum = [{ T: 0.001, Sa: flatSa }, { T: 100, Sa: flatSa }];
  // solveSpectrum resuelve el modal solo si no existe:
  ok(ps.modal == null, 'sin modal previo');
  const res = await ps.solveSpectrum({ spectrum, direction: 'X', method: 'SRSS', nModes: 1 });
  ok(ps.modal != null, 'solveSpectrum resolvió el modal automáticamente');
  ok(res && typeof res.getNodeDisp === 'function', 'devuelve un Results con getNodeDisp');

  const w2 = ps.modal.omega[0] ** 2;
  const uTip = res.getNodeDisp(tip)[0];
  ok(Math.abs(uTip - flatSa / w2) / (flatSa / w2) < 1e-6, 'punta ux = Sa/ω²',
    `(${uTip.toExponential(4)} vs ${(flatSa / w2).toExponential(4)})`);

  // end-to-end: la curva NCh433 alimenta al solver espectral sin fricción.
  const { curve, Rstar } = Portico.spectrumNCh433({ soil: 'D', zone: 2, category: 'II', applyRstar: false, Tstar: 0.3 });
  const res2 = await ps.solveSpectrum({ spectrum: curve, saFactor: 9.80665 / Rstar, direction: 'X', method: 'CQC', nModes: 1 });
  ok(Math.abs(res2.getNodeDisp(tip)[0]) > 0, 'curva NCh433 → solveSpectrum da respuesta no nula');
}

console.log(`\n${fails === 0 ? '✅ TODOS PASAN' : '❌ ' + fails + ' fallos'}`);
process.exit(fails ? 1 : 0);
