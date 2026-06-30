// build_links_s3d.mjs — .s3d del caso de verificación de LINKS/COUPLINGS (#puentes).
//   node tools/verif/build_links_s3d.mjs
// Tablero excéntrico sobre una pila: carga vertical en el eje del tablero (offset e)
// ligada a la punta de la pila con un LINK RÍGIDO → momento base = P·e.
import fs from 'fs';
import path from 'path';
import { Model } from '../../js/model/model.js';
import { Serializer } from '../../js/model/serializer.js';

const ROOT = process.cwd();
const E = 2e8, Iy = 1e-4, A = 0.02, H = 5, e = 2, P = 100;

const m = new Model(); m.mode = '3D'; m.materials.clear(); m.sections.clear();
const mat = m.addMaterial({ name: 'Hormigón', E, G: E / 2.4, nu: 0.2, rho: 0 });
const sec = m.addSection({ name: 'Pila', A, Iy, Iz: Iy, J: 1e-4, Avy: 1e3, Avz: 1e3, kappay: 1, kappaz: 1 });
const n1 = m.addNode(0, 0, 0, { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 });   // base empotrada
const n2 = m.addNode(0, 0, H);                                                  // punta de la pila
const n3 = m.addNode(e, 0, H);                                                  // eje del tablero (offset)
m.addElement(n1.id, n2.id, mat.id, sec.id);
m.addLink({ name: 'Tablero↔Pila', master: n2.id, slave: n3.id, rigid: true });
const lc = m.addLoadCase('Tablero', false);
m.addLoad(lc.id, { type: 'nodal', nodeId: n3.id, F: [0, 0, -P, 0, 0, 0] });

fs.writeFileSync(path.join(ROOT, 'examples', 'verif_1-010_link_offset.s3d'), new Serializer().toJSON(m), 'utf8');
console.log('✓ verif_1-010_link_offset.s3d  · pila H=' + H + ', offset e=' + e + ', P=' + P);
