// test_uplift.mjs — resortes de apoyo UNILATERALES (solo-compresión/uplift) (#3)
// Ménsula horizontal (empotrada en la base) apuntalada en la PUNTA por un resorte
// vertical SOLO-COMPRESIÓN. Con carga hacia abajo el resorte trabaja (rigidez extra);
// con carga hacia arriba el apoyo se DESPEGA (resorte inactivo, reacción 0) y la punta
// flecta sólo con la rigidez de la ménsula. Rigidez vertical condensada de la ménsula
// en la punta = 3·E·Iy/L³.
//
//   node test_uplift.mjs
globalThis.window = globalThis;
await import('./lib/numeric.js');
const { Model } = await import('./js/model/model.js?v=207');
const { StaticSolver } = await import('./js/solver/static_solver.js?v=207');

let pass = 0; const ok = (c, m) => { if (!c) { console.log('FAIL ' + m); process.exitCode = 1; } else { console.log('  ✓ ' + m); pass++; } };
const rel = (a, b, t, m) => ok(Math.abs(a - b) <= t * Math.abs(b) + 1e-12, `${m}  (${a.toExponential(4)} vs ${b.toExponential(4)})`);

const E = 2.1e8, Iy = 8.333e-6, A = 0.01, L = 2, k = 1000, P = 10;

function build(withSpring) {
  const m = new Model();
  m.nodes.clear(); m.elements.clear(); m.materials.clear(); m.sections.clear();
  const mat = m.addMaterial({ name: 'A', E, G: 8.1e7, nu: 0.3, rho: 0 });
  const sec = m.addSection({ name: 'S', A, Iy, Iz: Iy, J: 1e-5 });
  const n1 = m.addNode(0, 0, 0, { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 });   // empotrado
  const n2 = m.addNode(L, 0, 0);                                                  // punta libre
  m.addElement(n1.id, n2.id, mat.id, sec.id);
  if (withSpring) m.updateNode(n2.id, { springs: { kuz: k }, springUni: { uz: 'c' } });   // solo-compresión
  return { m, n2 };
}

console.log('#3: resorte de apoyo unilateral (solo-compresión / uplift)');

// rigidez vertical EXACTA de la ménsula en la punta (del propio solver, incluye corte)
const { m: mB, n2: nB } = build(false);
const lcB = mB.addLoadCase('ref', false, 'static');
mB.addLoad(lcB.id, { type: 'nodal', nodeId: nB.id, F: [0, 0, -P, 0, 0, 0] });
const dBeam = Math.abs(new StaticSolver().solve(mB, lcB.id, false).getNodeDisp(nB.id)[2]);
const kBeam = P / dBeam;

// ── Carga HACIA ABAJO (Fz<0): el resorte trabaja → rigidez ménsula + resorte ──
{
  const { m, n2 } = build(true);
  const lc = m.addLoadCase('Abajo', false, 'static');
  m.addLoad(lc.id, { type: 'nodal', nodeId: n2.id, F: [0, 0, -P, 0, 0, 0] });
  const res = new StaticSolver().solve(m, lc.id, false);
  const uz = res.getNodeDisp(n2.id)[2];
  const Rz = res.getReaction(n2.id)[2];
  rel(uz, -P / (kBeam + k), 1e-7, 'flecha abajo con resorte activo = -P/(kménsula + k)');
  rel(Rz, k * (P / (kBeam + k)), 1e-7, 'reacción del resorte (compresión, >0)');
  ok(uz < 0, 'la punta baja (resorte en compresión → activo)');
}

// ── Carga HACIA ARRIBA (Fz>0): el apoyo se DESPEGA → solo la ménsula ──
{
  const { m, n2 } = build(true);
  const lc = m.addLoadCase('Arriba', false, 'static');
  m.addLoad(lc.id, { type: 'nodal', nodeId: n2.id, F: [0, 0, +P, 0, 0, 0] });
  const res = new StaticSolver().solve(m, lc.id, false);
  const uz = res.getNodeDisp(n2.id)[2];
  const Rz = res.getReaction(n2.id)[2];
  rel(uz, dBeam, 1e-9, 'flecha arriba = la de la ménsula sola (apoyo despegado, resorte inactivo)');
  ok(Math.abs(Rz) < 1e-9, `reacción del resorte = 0 (se despegó): ${Rz.toExponential(2)}`);
  ok(uz > P / (kBeam + k) * 1.5, 'flecta MÁS que si el resorte siguiera activo (confirma el uplift)');
}

console.log(`\n✅ #3 OK — ${pass} comprobaciones`);
