// build_allman_s3d.mjs — .s3d del caso 3-006 (triángulo de membrana Allman).
//   node tools/verif/build_allman_s3d.mjs
import fs from 'fs';
import path from 'path';
import { Serializer } from '../../js/model/serializer.js';
import { buildCantilever } from './cases/3-006.mjs';

const ROOT = process.cwd();
const { model } = buildCantilever(16, 4, true);   // malla representativa, Allman
const out = path.join(ROOT, 'examples', 'verif_3-006_allman_voladizo.s3d');
fs.writeFileSync(out, new Serializer().toJSON(model), 'utf8');
const tri = [...model.areas.values()].length;
console.log('✓ verif_3-006_allman_voladizo.s3d  ·', model.nodes.size, 'nodos,', tri, 'triángulos (Allman)');
