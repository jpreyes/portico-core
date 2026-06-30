// build_design_s3d.mjs — .s3d del caso 4-001 (diseño de acero AISC/EC3).
//   node tools/verif/build_design_s3d.mjs
import fs from 'fs'; import path from 'path';
import { Model } from '../../js/model/model.js';
import { Serializer } from '../../js/model/serializer.js';
const m = new Model(); m.mode = '2D'; m.materials.clear(); m.sections.clear();
const mat = m.addMaterial({ name: 'Acero A36', E: 2e8, G: 7.7e7, nu: 0.3, rho: 7.85,
  design: { family: 'steel', Fy: 250, Fu: 400 } });
const sec = m.addSection({ name: 'IPE300', A: 5.38e-3, Iz: 8.356e-5, Iy: 6.038e-6, J: 2.012e-7,
  Avy: 2.568e-3, Avz: 3.21e-3, design: { shape: 'I', d: 0.300, bf: 0.150, tf: 0.0107, tw: 0.0071 } });
const n1 = m.addNode(0, 0, 0, { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 });
const n2 = m.addNode(5, 0, 0);
m.addElement(n1.id, n2.id, mat.id, sec.id);
const lc = m.addLoadCase('Q'); m.addLoad(lc.id, { type: 'nodal', nodeId: n2.id, F: [0, 0, -20, 0, 0, 0] });
fs.writeFileSync(path.join(process.cwd(), 'examples', 'verif_4-001_diseno_acero.s3d'), new Serializer().toJSON(m), 'utf8');
console.log('✓ verif_4-001_diseno_acero.s3d');
