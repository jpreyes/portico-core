// test_api.mjs — Verificación de la API pública (pre/solver/post/diseño + extensión).
import { Portico } from '../js/api/portico.js?v=137';

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

console.log('\n── 10. storyDrifts: modal → espectro → derivas por norma ──');
{
  // Edificio de corte de 2 pisos: masa concentrada por piso, columnas verticales. Todo
  // headless por la API — el flujo que antes sólo existía en app.js con DOM.
  const pb = new Portico();
  const mt = pb.material({ name: 'S', E: 2.1e11, G: 8.0e10, nu: 0.3125, rho: 0 });
  const st = pb.section({ name: 'C', A: 0.02, Iy: 4e-4, Iz: 4e-4, J: 1e-5, Avy: 1e30, Avz: 1e30, kappay: 1, kappaz: 1 });
  const base = pb.node(0, 0, 0, { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 });
  const p1 = pb.node(0, 0, 3, { uy: 1, uz: 1, ry: 1, rz: 1 });
  const p2 = pb.node(0, 0, 6, { uy: 1, uz: 1, ry: 1, rz: 1 });
  pb.element(base, p1, { mat: mt, sec: st });
  pb.element(p1, p2, { mat: mt, sec: st });
  pb.model.updateNode(p1, { nodeMass: { mx: 30, my: 30, mz: 30 } });
  pb.model.updateNode(p2, { nodeMass: { mx: 30, my: 30, mz: 30 } });

  const { curve, Rstar } = Portico.spectrumNCh433({ soil: 'D', zone: 3, category: 'II', applyRstar: false, Tstar: 0.4 });
  await pb.solveSpectrum({ spectrum: curve, saFactor: 9.80665 / Rstar, direction: 'X', nModes: 2 });

  const drifts = pb.storyDrifts({ direction: 'X', code: 'NCh433' });
  ok(drifts.length === 2, 'dos pisos', `(${drifts.length})`);
  ok(drifts.every(s => s.limit === 0.002 && s.code === 'NCh433'), 'límite 0.002 viene de la norma, no hardcodeado');
  ok(drifts.every(s => s.drift >= 0 && Number.isFinite(s.ratio)), 'cada piso trae drift y ratio Δ/límite');
  // el mismo cálculo con otra norma cambia sólo el límite/ratio, no el drift
  const asce = pb.storyDrifts({ direction: 'X', code: 'ASCE7' });
  ok(Math.abs(asce[0].drift - drifts[0].drift) < 1e-15, 'el drift es el mismo drift; sólo cambia el límite por norma');
  ok(asce[0].limit === 0.020, 'ASCE7 usa 0.020');
}

console.log('\n── 11. Análisis geométrico-NL e inelástico vía API (Fase 4) ──');
{
  // Helpers para modelos planos reutilizables.
  const planar = () => {
    const q = new Portico(); q.set2D(true);
    const mt = q.material({ name: 'S', E: 2.1e8, G: 8e7, nu: 0.3125, rho: 0 });
    const st = q.section({ name: 'C', A: 0.01, Iy: 8e-5, Iz: 8e-5, J: 1e-6, Avy: 1e30, Avz: 1e30, kappay: 1, kappaz: 1 });
    return { q, mt, st };
  };

  // (a) plasticHinge: voladizo con carga de punta → λc = Mp/(P0·L) = 3.333.
  {
    const { q, mt, st } = planar();
    const A = q.node(0, 0, 0, { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 }), B = q.node(3, 0, 0);
    q.element(A, B, { mat: mt, sec: st });
    const lc = q.loadCase('P'); q.nodalLoad(lc, B, { fz: -10 });
    const r = await q.plasticHinge({ Mp: 100 });
    ok(r.ok && r.collapsed, 'plasticHinge: mecanismo alcanzado');
    approx(r.lambda, 100 / (10 * 3), 1e-4, 'plasticHinge λc = Mp/(P0·L)');
  }

  // (b) pDelta: columna con axial + lateral → amplifica (>1) y converge.
  {
    const { q, mt, st } = planar();
    const N = 8, L = 4, nodes = [];
    for (let i = 0; i <= N; i++) nodes.push(q.node(0, 0, L * i / N, i === 0 ? { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 } : {}));
    for (let i = 0; i < N; i++) q.element(nodes[i], nodes[i + 1], { mat: mt, sec: st });
    const ax = q.loadCase('ax'); q.nodalLoad(ax, nodes[N], { fz: -1200 });
    const lat = q.loadCase('lat'); q.nodalLoad(lat, nodes[N], { fx: 30 });
    const pd = await q.pDelta({});
    ok(pd.ok && pd.conv && pd.amp > 1.05, `pDelta: amplifica y converge (×${pd.amp.toFixed(2)})`);
  }

  // (b2) solveBuckling (unificado con la primitiva linearBuckling): voladizo, carga axial
  //      de punta → λcr·P0 = π²·E·I/(4·L²) (Euler). Antes reimplementación inline sin test.
  {
    const { q, mt, st } = planar();   // sección con Iy = 8e-5
    const N = 10, L = 4, P0 = 100, nodes = [];
    for (let i = 0; i <= N; i++) nodes.push(q.node(0, 0, L * i / N, i === 0 ? { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 } : {}));
    for (let i = 0; i < N; i++) q.element(nodes[i], nodes[i + 1], { mat: mt, sec: st });
    const lc = q.loadCase('P'); q.nodalLoad(lc, nodes[N], { fz: -P0 });   // compresión
    const b = await q.solveBuckling(lc, 2);
    approx(b.factors[0] * P0, Math.PI ** 2 * 2.1e8 * 8e-5 / (4 * L * L), 0.02, 'solveBuckling λcr·P0 = π²EI/(4L²)');
    ok(b.Nby && b.Nby.size > 0, 'solveBuckling devuelve Nby (fuerza axial de referencia por elemento)');
  }

  // (c) nonlinearStatic: cable pretensado con carga central → converge.
  {
    const q = new Portico(); q.set2D(true);
    const mt = q.material({ name: 'S', E: 2.1e8, G: 8e7, nu: 0.3, rho: 0 });
    const sc = q.section({ name: 'B', A: 1e-4, Iy: 1e-6, Iz: 1e-6, J: 1e-7 });
    const A = q.node(0, 0, 0, { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 });
    const M = q.node(1, 0, 0), B = q.node(2, 0, 0, { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 });
    const e1 = q.element(A, M, { mat: mt, sec: sc }), e2 = q.element(M, B, { mat: mt, sec: sc });
    q.model.elements.get(e1).L0factor = 0.99; q.model.elements.get(e2).L0factor = 0.99;
    const lc = q.loadCase('P'); q.nodalLoad(lc, M, { fz: -420 });
    const nl = await q.nonlinearStatic({ nSteps: 20 });
    ok(nl.converged && Math.abs(nl.steps.at(-1).u[3 * 1 + 2]) > 0.2, 'nonlinearStatic: converge con descenso de midspan');
  }

  // (d) corotational: voladizo con momento de punta → la punta se acorta y sube.
  {
    const q = new Portico(); q.set2D(true);
    const mt = q.material({ name: 'S', E: 2.1e8, G: 8e7, nu: 0.3125, rho: 0 });
    const sc = q.section({ name: 'C', A: 0.01, Iy: 8e-5, Iz: 8e-5, J: 1e-6 });
    const nEl = 16, L = 2, nodes = [];
    for (let i = 0; i <= nEl; i++) nodes.push(q.node(L * i / nEl, 0, 0, i === 0 ? { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 } : {}));
    for (let i = 0; i < nEl; i++) q.element(nodes[i], nodes[i + 1], { mat: mt, sec: sc });
    const lc = q.loadCase('M'); q.nodalLoad(lc, nodes[nEl], { my: 2.1e8 * 8e-5 / L });   // θ≈1 rad
    const cr = await q.corotational({ nSteps: 20 });
    const uTip = cr.steps.at(-1).u;
    ok(cr.steps.length > 0 && uTip[3 * nEl] < 0 && Math.abs(uTip[3 * nEl + 2]) > 0, 'corotational: punta acortada y elevada');
  }

  // (e) pushover DC: armadura de von Mises → pico de la trayectoria (carga límite).
  {
    const q = new Portico(); q.set2D(true);
    const mt = q.material({ name: 'S', E: 2.1e8, G: 8e7, nu: 0.3, rho: 0 });
    const sc = q.section({ name: 'B', A: 1e-3, Iy: 1e-6, Iz: 1e-6, J: 1e-7 });
    const A = q.node(0, 0, 0, { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 });
    const C = q.node(1, 0, 0.3), B = q.node(2, 0, 0, { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 });
    q.element(A, C, { mat: mt, sec: sc }); q.element(C, B, { mat: mt, sec: sc });
    const lc = q.loadCase('P'); q.nodalLoad(lc, C, { fz: -500 });
    const po = await q.pushover({ nSteps: 60 });
    let peak = -Infinity; for (const p of po.path) if (p.lambda > peak) peak = p.lambda;
    ok(po.path.length > 2 && peak > 3.5 && peak < 4.5, `pushover: pico λ≈4 (carga límite)  (${peak.toFixed(2)})`);
  }

  // (f) timeHistoryNL: modelo con diafragmas → 2 pisos, T₁ > 0.
  {
    const q = new Portico(); q.set2D(true);
    const mt = q.material({ name: 'S', E: 2.1e8, G: 8e7, nu: 0.3, rho: 0 });
    const sc = q.section({ name: 'C', A: 0.02, Iy: 4e-4, Iz: 4e-4, J: 1e-5 });
    const N0 = q.node(0, 0, 0, { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 });
    const N1 = q.node(0, 0, 3), N2 = q.node(0, 0, 6);
    q.element(N0, N1, { mat: mt, sec: sc }); q.element(N1, N2, { mat: mt, sec: sc });
    q.model.addDiaphragm({ name: 'P1', z: 3, nodes: [N1], mass: { m: 120, Icm: 0 } });
    q.model.addDiaphragm({ name: 'P2', z: 6, nodes: [N2], mass: { m: 90, Icm: 0 } });
    const dt = 0.02, ag = Array.from({ length: 200 }, (_, i) => 0.05 * Math.sin(2 * Math.PI * 1.5 * i * dt) * Math.exp(-i * dt / 3));
    const th = await q.timeHistoryNL({ dir: 'X', ag, dt });
    ok(th.stories.length === 2 && th.T1 > 0, `timeHistoryNL: 2 pisos, T₁=${th.T1.toFixed(3)}s`);
  }

  // (g) movingLoad: LI de reacción → máx = 1 (carga sobre el apoyo).
  {
    const q = new Portico(); q.set2D(true);
    const mt = q.material({ name: 'H', E: 3e7, G: 1.25e7, nu: 0.2, rho: 0 });
    const sc = q.section({ name: 'V', A: 0.4, Iy: 0.05, Iz: 0.05, J: 1e-3, Avy: 1e3, Avz: 1e3, kappay: 1, kappaz: 1 });
    const L = 12, NEL = 6, nodes = [], elems = [];
    for (let i = 0; i <= NEL; i++) { const r = i === 0 ? { ux: 1, uz: 1 } : i === NEL ? { uz: 1 } : {}; nodes.push(q.node(L * i / NEL, 0, 0, r)); }
    for (let i = 0; i < NEL; i++) elems.push(q.element(nodes[i], nodes[i + 1], { mat: mt, sec: sc }));
    const ml = await q.movingLoad({ mode: 'il', nPos: 25, respType: 'reaction', nodeId: nodes[0], comp: 'Fz', label: 'RFz', unit: 'kN', laneIds: elems });
    approx(ml.max, 1, 1e-3, 'movingLoad: IL reacción máx = 1');
  }

  // (h) formFinding: nodo libre fuera de la línea A–B relaja hacia ella (muta geometría).
  {
    const q = new Portico();
    const mt = q.material({ name: 'S', E: 2.1e8, G: 8e7, nu: 0.3, rho: 0 });
    const sc = q.section({ name: 'B', A: 1e-4, Iy: 1e-6, Iz: 1e-6, J: 1e-7 });
    const A = q.node(0, 0, 0, { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 });
    const M = q.node(1, 0, 5), B = q.node(2, 0, 0, { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 });
    q.element(A, M, { mat: mt, sec: sc }); q.element(M, B, { mat: mt, sec: sc });
    await q.formFinding({ q0: 10, axes: [2] });
    ok(Math.abs(q.model.nodes.get(M).z) < 5, `formFinding: nodo reposicionado (z ${q.model.nodes.get(M).z.toFixed(2)} < 5)`);
  }
}

console.log(`\n${fails === 0 ? '✅ TODOS PASAN' : '❌ ' + fails + ' fallos'}`);
process.exit(fails ? 1 : 0);
