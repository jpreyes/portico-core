// build_bridge_s3d.mjs — construye los .s3d de los casos de verificación de PUENTES
// (#59 etapas · #60 pretensado · #61 cargas móviles).  Geometría plana 2D (X–Z).
//   node tools/verif/build_bridge_s3d.mjs
import fs from 'fs';
import path from 'path';
import { Model } from '../../js/model/model.js';
import { Serializer } from '../../js/model/serializer.js';

const ROOT = process.cwd();
const ser = new Serializer();
const save = (m, file) => { fs.writeFileSync(path.join(ROOT, 'examples', file), ser.toJSON(m), 'utf8'); console.log('✓', file); };

// Viga simplemente apoyada 2D con NEL elementos a lo largo de X.
function ssBeam({ L, NEL, E, I, A, rho = 0, name }) {
  const m = new Model(); m.mode = '2D'; m.materials.clear(); m.sections.clear();
  const mat = m.addMaterial({ name: 'Material', E, G: E / 2.4, nu: 0.2, rho });
  const sec = m.addSection({ name, A, Iy: I, Iz: I, J: 1e-3, Avy: 1e3, Avz: 1e3, kappay: 1, kappaz: 1 });
  const nodes = [];
  for (let i = 0; i <= NEL; i++) {
    const r = i === 0 ? { ux: 1, uz: 1 } : i === NEL ? { uz: 1 } : {};
    nodes.push(m.addNode(L * i / NEL, 0, 0, r));
  }
  for (let i = 0; i < NEL; i++) m.addElement(nodes[i].id, nodes[i + 1].id, mat.id, sec.id);
  return m;
}

// ── #60 Pretensado: viga simple, el tendón lo aplica el runner ─────────────────
{
  const m = ssBeam({ L: 20, NEL: 4, E: 3e7, I: 0.1, A: 0.5, name: 'Tablero' });
  m.addLoadCase('Pretensado', false);   // caso 1: lo llena el tendón
  save(m, 'verif_1-009_pretensado.s3d');
}

// ── #61 Cargas móviles / líneas de influencia: viga simple ────────────────────
{
  const m = ssBeam({ L: 24, NEL: 6, E: 3e7, I: 0.05, A: 0.4, name: 'Tablero' });
  save(m, 'verif_1-030_lineas_influencia.s3d');
}

// ── #59 Etapas constructivas: voladizo apuntalado por etapas ──────────────────
{
  const m = new Model(); m.mode = '2D'; m.materials.clear(); m.sections.clear();
  const mat = m.addMaterial({ name: 'Acero', E: 2.1e8, G: 2.1e8 / 2.6, nu: 0.3, rho: 0 });
  const sec = m.addSection({ name: 'Viga', A: 0.02, Iy: 8.333e-6, Iz: 8.333e-6, J: 1e-6, Avy: 1e3, Avz: 1e3, kappay: 1, kappaz: 1 });
  const n1 = m.addNode(0, 0, 0, { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 });   // empotrado
  const n2 = m.addNode(4, 0, 0);
  const n3 = m.addNode(8, 0, 0);                                                  // punta (se apuntala en etapa B)
  m.addElement(n1.id, n2.id, mat.id, sec.id);
  m.addElement(n2.id, n3.id, mat.id, sec.id);
  save(m, 'verif_1-031_etapas_constructivas.s3d');
}
