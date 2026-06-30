// Test de la tipología CERCHA WARREN: ficha → modelo → solver (equilibrio).
// Uso: node assistant/test_truss.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generateModel } from './generator.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const raiz = path.resolve(dir, '..');
function parseCSV(txt) {
  const lines = txt.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
  const head = lines[0].split(',').map((s) => s.trim());
  return lines.slice(1).map((l) => { const c = l.split(',').map((s) => s.trim()); return Object.fromEntries(head.map((h, i) => [h, c[i]])); });
}
const read = (p) => fs.readFileSync(path.join(dir, p), 'utf8');
const reglas = JSON.parse(read('rules.json'));
const materiales = parseCSV(read('materials.csv'));

let fail = 0;
const ok = (cond, msg) => { console.log(`${cond ? '  ok ' : ' FAIL'}  ${msg}`); if (!cond) fail++; };

// Cercha Warren a dos aguas, luz 10 m, pendiente 10%, @60 cm, pino radiata.
const ficha = {
  mode: '2D', typology: 'truss', sections: { material: 'Pino Radiata' },
  truss: { span_m: 10, slope_pct: 10, n_panels: 8, spacing_m: 0.6, chord_size: '2x6', diagonal_size: '2x4' },
};
const m0 = generateModel(ficha, { reglas, materiales });

console.log('── Modelo generado ──');
console.log('  ', m0._generado.resumen);
ok(m0.mode === '2D', 'modo 2D (cercha plana)');
ok(m0.sections.length === 2, 'secciones = 2 (cordón + diagonal)');
// cumbrera al centro: altura = 0.10 * (10/2) = 0.5 m
const zMax = Math.max(...m0.nodes.map((nd) => nd.z));
ok(Math.abs(zMax - 0.5) < 1e-6, `cumbrera a 0.5 m (es ${zMax})`);
// nodo de cumbrera en x=5
const cumbrera = m0.nodes.find((nd) => Math.abs(nd.x - 5) < 1e-6 && Math.abs(nd.z - 0.5) < 1e-6);
ok(!!cumbrera, 'nodo de cumbrera en x=5, z=0.5');
// hay diagonales (sección 2) y cordones (sección 1)
ok(m0.elements.some((e) => e.secId === 2), 'tiene diagonales/montantes');
ok(m0.elements.some((e) => e.secId === 1), 'tiene cordones');
// supports: 2 nodos restringidos en uz
const apoyos = m0.nodes.filter((nd) => nd.restraints.uz === 1);
ok(apoyos.length === 2, `2 apoyos (es ${apoyos.length})`);

console.log('── Conservación de carga (CV) ──');
const elemL = new Map(m0.elements.map((e) => { const a = m0.nodes[e.n1 - 1], b = m0.nodes[e.n2 - 1]; return [e.id, Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)]; }));
const lcCV = m0.loadCases.find((l) => l.name === 'CV');
let Wcv = 0; for (const ld of lcCV.loads) Wcv += ld.w * elemL.get(ld.elemId);
const Wesp = 1.0 * 0.6 * 10;  // qCV · sep · luz
ok(Math.abs(Wcv - Wesp) / Wesp < 1e-4, `ΣCV = qCV·sep·luz (${Wcv.toFixed(3)} vs ${Wesp.toFixed(3)} kN)`);

console.log('── Solver estático real: equilibrio (CV) ──');
globalThis.window = globalThis;
vm.runInThisContext(fs.readFileSync(path.join(raiz, 'lib', 'numeric.js'), 'utf8'));
ok(!!globalThis.numeric, 'numeric.js cargado');
const tmp = path.join(dir, '_cer_tmp');
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} fs.mkdirSync(tmp, { recursive: true });
const buscarEn = ['js/solver', 'js/model', 'js'];
const localizar = (base) => { for (const d of buscarEn) { const p = path.join(raiz, d, base); if (fs.existsSync(p)) return p; } return null; };
const copiados = new Set();
const copiar = (base) => {
  if (copiados.has(base)) return; copiados.add(base);
  const src0 = localizar(base); if (!src0) return;
  const src = fs.readFileSync(src0, 'utf8').replace(/\?v=\d+/g, '');
  fs.writeFileSync(path.join(tmp, base), src);
  for (const mm of src.matchAll(/from\s+['"]\.[^'"]*\/([\w.-]+\.js)['"]/g)) copiar(mm[1]);
};
copiar('static_solver.js'); copiar('model.js');
const { Model } = await import(pathToFileURL(path.join(tmp, 'model.js')).href);
const { StaticSolver } = await import(pathToFileURL(path.join(tmp, 'static_solver.js')).href);
const m = new Model();
m.materials.clear(); m.sections.clear();
m.units = m0.units; m.mode = m0.mode;
for (const d of m0.materials) m.materials.set(d.id, d);
for (const d of m0.sections) m.sections.set(d.id, d);
for (const d of m0.nodes) m.nodes.set(d.id, d);
for (const d of m0.elements) m.elements.set(d.id, d);
for (const d of m0.loadCases) m.loadCases.set(d.id, d);
const res = new StaticSolver().solve(m, lcCV.id, false);
let Rz = 0; for (const nd of m.nodes.values()) { const r = res.getReaction(nd.id); if (r) Rz += r[2]; }
ok(Math.abs(Rz - Wcv) / Wcv < 1e-4, `ΣRz = ΣCV aplicada (Rz=${Rz.toFixed(3)} kN vs ${Wcv.toFixed(3)})`);
// Best-effort cleanup: Windows ESM loader keeps the copies locked → EPERM. Gitignored.
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

console.log('── Avisos ──'); for (const a of m0._warnings) console.log(`   [${a.type}] ${a.msg}`);
console.log(fail === 0 ? '\n✅ CERCHA: TODOS LOS CHEQUEOS OK' : `\n❌ ${fail} CHEQUEO(S) FALLARON`);
process.exit(fail === 0 ? 0 : 1);
