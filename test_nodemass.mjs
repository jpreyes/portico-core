// test_nodemass.mjs — verificación de la masa nodal ROTACIONAL (#6)
// Barra vertical a torsión: node1 empotrado, node2 libre SOLO en Rz, con inercia
// rotacional nodal Irz. La rigidez torsional de la barra es GJ/L (eje local = Z global),
// así que el modo torsional tiene  f = (1/2π)·√(GJ/L / Irz).  Verifica que el ensamblador
// suma Irz en el GDL Rz de M (antes sólo soportaba mx/my/mz).
//
//   node test_nodemass.mjs
import assert from 'node:assert';
import { Model } from './js/model/model.js?v=207';
import { buildNodeIndex, assembleK, getNodeDOFs } from './js/solver/assembler.js?v=207';

let pass = 0; const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };

const G = 8.1e7;      // kN/m²
const J = 1e-5;       // m⁴
const L = 1.0;        // m
const Irz = 10;       // ton·m²
const ktor = G * J / L;        // 810 kN·m/rad
const fEsperada = Math.sqrt(ktor / Irz) / (2 * Math.PI);

const m = new Model();
m.nodes.clear(); m.elements.clear(); m.materials.clear(); m.sections.clear();
// material casi sin masa para aislar la inercia nodal
const mat = m.addMaterial({ name: 'Acero', E: 2.1e8, G, nu: 0.3, rho: 1e-9 });
const sec = m.addSection({ name: 'S', A: 1e-3, Iy: 1e-6, Iz: 1e-6, J });
const n1 = m.addNode(0, 0, 0, { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 });   // empotrado
const n2 = m.addNode(0, 0, L, { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 0 });   // libre sólo en Rz
m.addElement(n1.id, n2.id, mat.id, sec.id);
m.updateNode(n2.id, { nodeMass: { irz: Irz } });

console.log('#6: masa nodal rotacional');
ok(m.nodes.get(n2.id).nodeMass.irz === Irz, `nodeMass.irz almacenado = ${m.nodes.get(n2.id).nodeMass.irz}`);

const idx = buildNodeIndex(m);
const { K, M, nDOF } = assembleK(m, idx);
const g = getNodeDOFs(idx, n2.id)[5];   // GDL Rz de node2

const Mrz = M[g * nDOF + g];
const Krz = K[g * nDOF + g];
ok(Math.abs(Mrz - Irz) / Irz < 1e-4, `M[Rz,Rz] = ${Mrz.toFixed(4)} ton·m² (esperado Irz=${Irz}, masa de barra ~0)`);
ok(Math.abs(Krz - ktor) / ktor < 1e-9, `K[Rz,Rz] = ${Krz.toFixed(2)} kN·m/rad (GJ/L = ${ktor})`);

const fCalc = Math.sqrt(Krz / Mrz) / (2 * Math.PI);
ok(Math.abs(fCalc - fEsperada) / fEsperada < 1e-3, `frecuencia torsional ${fCalc.toFixed(4)} Hz ≈ ${fEsperada.toFixed(4)} Hz analítica`);

// Sin la inercia rotacional, el GDL Rz quedaría con masa ~0 (modo espurio) → comprobamos
// que ANTES de irz la diagonal era ~0 y que irz la llena.
ok(Mrz > 1e-3, 'el GDL de giro deja de tener masa nula gracias a Irz (evita modo espurio)');

console.log(`\n✅ #6 OK — ${pass} comprobaciones (f torsional = ${fCalc.toFixed(4)} Hz)`);
