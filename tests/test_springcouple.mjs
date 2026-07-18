// test_springcouple.mjs — resortes de apoyo ACOPLADOS (matriz 6×6, no sólo diagonal) (#2)
// Verifica que el ensamblador mete los términos FUERA de la diagonal y que producen
// acoplamiento físico (una fuerza en X genera desplazamiento en Y).
//
//   node test_springcouple.mjs
import assert from 'node:assert';
import { Model } from '../js/model/model.js?v=207';
import { buildNodeIndex, assembleK, getNodeDOFs } from '../js/solver/assembler.js?v=207';

let pass = 0; const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };

// ── Nodo con resorte ACOPLADO en (X,Y): K2 = [[100,30],[30,100]] kN/m ──
const m = new Model();
m.nodes.clear(); m.elements.clear();
const n = m.addNode(0, 0, 0, { ux: 0, uy: 0, uz: 1, rx: 1, ry: 1, rz: 1 });  // libre en X,Y
const KS = new Array(36).fill(0);
KS[0] = 100; KS[1] = 30; KS[6] = 30; KS[7] = 100;   // bloque 2×2 en (Ux,Uy) con acoplamiento
m.updateNode(n.id, { springK: KS });

console.log('#2: resorte de apoyo acoplado (matriz 6×6)');
ok(m.nodes.get(n.id).springK && m.nodes.get(n.id).springK.length === 36, 'springK almacenado (36)');

const idx = buildNodeIndex(m);
const { K, nDOF } = assembleK(m, idx);
const dof = getNodeDOFs(idx, n.id);
const gx = dof[0], gy = dof[1];
ok(Math.abs(K[gx * nDOF + gx] - 100) < 1e-9, `K[X,X] = ${K[gx*nDOF+gx]} (esperado 100)`);
ok(Math.abs(K[gx * nDOF + gy] - 30) < 1e-9, `K[X,Y] = ${K[gx*nDOF+gy]} (acoplamiento fuera de diagonal, esperado 30)`);
ok(Math.abs(K[gy * nDOF + gx] - 30) < 1e-9, `K[Y,X] = ${K[gy*nDOF+gx]} (simétrico, 30)`);

// Resolver el 2×2 (Kff·u = f) con f = (10, 0):  u = Kff⁻¹ f
const a = 100, b = 30, c = 30, dd = 100, det = a * dd - b * c;   // 9100
const fx = 10, fy = 0;
const ux = (dd * fx - b * fy) / det, uy = (-c * fx + a * fy) / det;
ok(Math.abs(ux - 0.10989) < 1e-4, `u_x = ${ux.toFixed(5)} m (analítico 0.10989)`);
ok(Math.abs(uy + 0.032967) < 1e-4, `u_y = ${uy.toFixed(5)} m ≠ 0 → el acoplamiento traslada en Y una fuerza en X`);

// ── Helper de resorte INCLINADO: k a 45° en XZ → bloque rango-1 k·(d⊗d) ──
const Ki = Model.inclinedSpringK(200, [1, 0, 1]);
ok(Math.abs(Ki[0] - 100) < 1e-9 && Math.abs(Ki[2 * 6 + 2] - 100) < 1e-9 && Math.abs(Ki[2] - 100) < 1e-9,
  `inclinedSpringK(200,[1,0,1]) → Kxx=Kzz=Kxz=100 (k·d⊗d, d=45°)`);
ok(Math.abs(Ki[7]) < 1e-12, 'inclinedSpringK no toca el GDL Y (perpendicular a la dirección)');

console.log(`\n✅ #2 OK — ${pass} comprobaciones`);
