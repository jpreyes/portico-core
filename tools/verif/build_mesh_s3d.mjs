// build_mesh_s3d.mjs — construye el .s3d del caso de verificación del MALLADOR
// transfinito (#52 F1): patch test de membrana en una malla TRAPEZOIDAL distorsionada.
//   node tools/verif/build_mesh_s3d.mjs
//
// Se impone un campo de desplazamiento LINEAL u=(εx·x, −ν·εx·y) en el borde (vía
// prescDisp #54). Si el mallador produce QUADs conformes, el interior reproduce el
// campo exacto y la tensión es la constante teórica (σ₁=E·εx, σ₂=0).
import fs from 'fs';
import path from 'path';
import { Model } from '../../js/model/model.js';
import { Serializer } from '../../js/model/serializer.js';
import { coonsGridFromCorners, blockCells } from '../../js/model/mesh_map.js';
import { meshPolygonIntoModel } from '../../js/model/mesh_free.js';

const ROOT = process.cwd();
const E = 2.1e11, nu = 0.3, t = 0.01, exx = 1e-4;
const TNX = 4, TNY = 3;
const trap = [[0, 0, 0], [4, 0, 0], [4, 2, 0], [0, 1, 0]];   // trapecio (izq h=1, der h=2)

const m = new Model(); m.mode = '3D'; m.materials.clear(); m.sections.clear();
const mat = m.addMaterial({ name: 'Acero', E, G: E / 2.6, nu, rho: 0 });
const pts = coonsGridFromCorners(trap, TNX, TNY);
const tidx = (i, j) => i * (TNY + 1) + j;
const isB = (i, j) => i === 0 || i === TNX || j === 0 || j === TNY;
const nid = [];
for (let i = 0; i <= TNX; i++) for (let j = 0; j <= TNY; j++) {
  const p = pts[tidx(i, j)];
  const r = { uz: 1, rx: 1, ry: 1, rz: 1, ux: isB(i, j) ? 1 : 0, uy: isB(i, j) ? 1 : 0 };
  const nd = m.addNode(p[0], p[1], p[2], r);
  if (isB(i, j)) m.updateNode(nd.id, { prescDisp: { ux: exx * p[0], uy: -nu * exx * p[1] } });
  nid[tidx(i, j)] = nd.id;
}
for (const cell of blockCells(TNX, TNY, false)) m.addArea(cell.map(g => nid[g]), mat.id, { thickness: t, behavior: 'membrane' });

fs.writeFileSync(path.join(ROOT, 'examples', 'verif_3-001_patch_test_malla.s3d'), new Serializer().toJSON(m), 'utf8');
console.log('✓ verif_3-001_patch_test_malla.s3d  ·', m.nodes.size, 'nodos,', m.areas.size, 'QUAD');

// ── 3-005: patch test en MALLA LIBRE de una planta en L (cóncava) ─────────────
const mL = new Model(); mL.mode = '3D'; mL.materials.clear(); mL.sections.clear();
const matL = mL.addMaterial({ name: 'Acero', E, G: E / 2.6, nu, rho: 0 });
const Lshape = [[0, 0, 0], [2, 0, 0], [2, 1, 0], [1, 1, 0], [1, 2, 0], [0, 2, 0]];
const mp = meshPolygonIntoModel(mL, Lshape, { h: 1.0, recombine: true, smooth: 3, thickness: t, behavior: 'membrane', matId: matL.id });
for (const id of mp.nodeIds) {
  const n = mL.nodes.get(id), bnd = mp.boundaryNodeIds.has(id);
  mL.updateNode(id, { restraints: { uz: 1, rx: 1, ry: 1, rz: 1, ux: bnd ? 1 : 0, uy: bnd ? 1 : 0 } });
  if (bnd) mL.updateNode(id, { prescDisp: { ux: exx * n.x, uy: -nu * exx * n.y } });
}
fs.writeFileSync(path.join(ROOT, 'examples', 'verif_3-005_malla_libre_L.s3d'), new Serializer().toJSON(mL), 'utf8');
const nq = [...mL.areas.values()].filter(a => a.nodes.length === 4).length;
console.log('✓ verif_3-005_malla_libre_L.s3d  ·', mL.nodes.size, 'nodos,', mL.areas.size, 'celdas (', nq, 'QUAD,', mL.areas.size - nq, 'CST)');
