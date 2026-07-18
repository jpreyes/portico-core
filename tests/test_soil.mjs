// test_soil.mjs — resortes de SUELO NO LINEALES (curva p-y/t-z/q-z tabulada) (#4)
// Ménsula apuntalada en la punta por un resorte de suelo con curva ELASTOPLÁSTICA
// (lineal de rigidez k hasta la fuerza última ±Fy, luego meseta). Con carga pequeña el
// resorte trabaja elástico; con carga grande SATURA en Fy y el resto lo toma la ménsula.
//
//   node test_soil.mjs
globalThis.window = globalThis;
await import('../lib/numeric.js');
const { Model } = await import('../js/model/model.js?v=207');
const { StaticSolver } = await import('../js/solver/static_solver.js?v=207');

let pass = 0; const ok = (c, m) => { if (!c) { console.log('FAIL ' + m); process.exitCode = 1; } else { console.log('  ✓ ' + m); pass++; } };
const rel = (a, b, t, m) => ok(Math.abs(a - b) <= t * Math.abs(b) + 1e-9, `${m}  (${a.toExponential(4)} vs ${b.toExponential(4)})`);

const E = 2.1e8, Iy = 8.333e-6, A = 0.01, L = 2, k = 2000, Fy = 5;
// curva elastoplástica simétrica: meseta −Fy / lineal pendiente k / meseta +Fy
const curve = [[-0.1, -Fy], [-Fy / k, -Fy], [0, 0], [Fy / k, Fy], [0.1, Fy]];

function build(withSoil) {
  const m = new Model();
  m.nodes.clear(); m.elements.clear(); m.materials.clear(); m.sections.clear();
  const mat = m.addMaterial({ name: 'A', E, G: 8.1e7, nu: 0.3, rho: 0 });
  const sec = m.addSection({ name: 'S', A, Iy, Iz: Iy, J: 1e-5 });
  const n1 = m.addNode(0, 0, 0, { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 });
  const n2 = m.addNode(L, 0, 0);
  m.addElement(n1.id, n2.id, mat.id, sec.id);
  if (withSoil) m.updateNode(n2.id, { soilSpring: { uz: curve } });
  return { m, n2 };
}

console.log('#4: resorte de suelo no lineal (curva tabulada)');

// rigidez de la ménsula en la punta (del solver, exacta)
const { m: mB, n2: nB } = build(false);
const lcB = mB.addLoadCase('ref', false, 'static');
mB.addLoad(lcB.id, { type: 'nodal', nodeId: nB.id, F: [0, 0, -1, 0, 0, 0] });
const kBeam = 1 / Math.abs(new StaticSolver().solve(mB, lcB.id, false).getNodeDisp(nB.id)[2]);

// ── Carga PEQUEÑA (elástica): el resorte trabaja con rigidez k ──
{
  const P = 4;
  const { m, n2 } = build(true);
  const lc = m.addLoadCase('chica', false, 'static');
  m.addLoad(lc.id, { type: 'nodal', nodeId: n2.id, F: [0, 0, -P, 0, 0, 0] });
  const res = new StaticSolver().solve(m, lc.id, false);
  const uz = res.getNodeDisp(n2.id)[2], Rz = res.getReaction(n2.id)[2];
  ok(Math.abs(uz) < Fy / k, `tramo elástico: |u|=${Math.abs(uz).toExponential(3)} < Fy/k=${(Fy/k).toExponential(3)}`);
  rel(uz, -P / (kBeam + k), 1e-7, 'flecha elástica = -P/(kménsula + k)');
  rel(Rz, k * (P / (kBeam + k)), 1e-7, 'reacción del suelo = k·|u| (elástica)');
}

// ── Carga GRANDE (plástica): el resorte satura en Fy, el resto lo toma la ménsula ──
{
  const P = 10;
  const { m, n2 } = build(true);
  const lc = m.addLoadCase('grande', false, 'static');
  m.addLoad(lc.id, { type: 'nodal', nodeId: n2.id, F: [0, 0, -P, 0, 0, 0] });
  const res = new StaticSolver().solve(m, lc.id, false);
  const uz = res.getNodeDisp(n2.id)[2], Rz = res.getReaction(n2.id)[2];
  ok(Math.abs(uz) > Fy / k, 'el resorte entró en la meseta (saturó)');
  rel(uz, -(P - Fy) / kBeam, 1e-6, 'flecha plástica = -(P − Fy)/kménsula (resorte en la fuerza última)');
  rel(Rz, Fy, 1e-6, 'reacción del suelo = Fy (fuerza última, no crece más)');
}

console.log(`\n✅ #4 OK — ${pass} comprobaciones`);
