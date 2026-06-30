// Test de la tipología ENTRAMADO DE MADERA: ficha → modelo → solver (equilibrio).
// Reproduce el ejemplo de la casa habitacional de 2 niveles con tabique interior
// y vano de puerta. Uso: node assistant/test_timber.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generateModel, sizeToSection } from './generator.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const raiz = path.resolve(dir, '..');

function parseCSV(txt) {
  const lines = txt.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
  const head = lines[0].split(',').map((s) => s.trim());
  return lines.slice(1).map((l) => {
    const c = l.split(',').map((s) => s.trim());
    return Object.fromEntries(head.map((h, i) => [h, c[i]]));
  });
}
const read = (p) => fs.readFileSync(path.join(dir, p), 'utf8');
const reglas = JSON.parse(read('rules.json'));
const materiales = parseCSV(read('materials.csv'));

let fail = 0;
const ok = (cond, msg) => { console.log(`${cond ? '  ok ' : ' FAIL'}  ${msg}`); if (!cond) fail++; };

console.log('── Escuadrías (pulgadas → mm) ──');
const e24 = sizeToSection('2x4');
ok(Math.abs(e24.sec.A - 0.038 * 0.089) < 1e-9, `2x4 → A = 38×89 mm (es ${(e24.sec.A * 1e4).toFixed(2)} cm²)`);
const e28 = sizeToSection('2x8');
ok(Math.abs(e28.sec.A - 0.038 * 0.184) < 1e-9, `2x8 → A = 38×184 mm (es ${(e28.sec.A * 1e4).toFixed(2)} cm²)`);
ok(e28.sec.Iz > e28.sec.Iy, '2x8: Iz (fuerte, canto) > Iy (débil)');

// ── Ficha del ejemplo: casa de 2 niveles 8×6, tabique central con puerta 80cm ──
const ficha = {
  mode: '3D',
  typology: 'timber_walls',
  sections: { material: 'Pino Radiata' },
  geometry: {
    base_plan: { Lx_m: 8, Ly_m: 6 },
    levels: [{ height_m: 3 }, { height_m: 3 }],
  },
  stud_walls: {
    nominal_size: '2x4', spacing_m: 0.4, perimeter: true,
    interior: [{ nivel: 1, dir: 'Y', pos_m: 4.0, openings: [{ type: 'door', width_m: 0.8, opening_height_m: 2.0, center_m: 3.0 }] }],
  },
  floors: { nominal_size: '2x8', spacing_m: 0.6, dir: 'X' },
};

const modelo = generateModel(ficha, { reglas, materiales });

console.log('── Modelo generado ──');
console.log('  ', modelo._generado.resumen);
ok(modelo.mode === '3D', 'modo 3D');
ok(modelo.materials.length === 1 && /Pino/.test(modelo.materials[0].name), `material = ${modelo.materials[0].name}`);
ok(modelo.sections.length === 2, 'secciones = 2 (pie derecho + vigueta)');
ok(modelo.nodes.length > 0 && modelo.elements.length > 0, `${modelo.nodes.length} nodos, ${modelo.elements.length} elementos`);
ok(modelo.loadCases.length === 2, 'casos CM + CV');
ok(modelo.combinations.length === 2, 'combinaciones 1.4CM y 1.2CM+1.6CV');

// La puerta debe haber quitado pies derechos: el tabique interior cubre y∈[0,6]
// con vano [2.6, 3.4] → ningún pie derecho con 2.6 < y < 3.4. Verificamos que
// exista el dintel (elemento horizontal a z=2.0 en x=4.0 entre y=2.6 e y=3.4).
const dintel = modelo.elements.find((e) => {
  const a = modelo.nodes[e.n1 - 1], b = modelo.nodes[e.n2 - 1];
  return Math.abs(a.z - 2.0) < 1e-3 && Math.abs(b.z - 2.0) < 1e-3 &&
    Math.abs(a.x - 4.0) < 1e-3 && Math.abs(b.x - 4.0) < 1e-3 &&
    ((Math.abs(a.y - 2.6) < 1e-3 && Math.abs(b.y - 3.4) < 1e-3) || (Math.abs(a.y - 3.4) < 1e-3 && Math.abs(b.y - 2.6) < 1e-3));
});
ok(!!dintel, 'dintel (header) sobre el vano de puerta a z=2.0 m');
const pieEnVano = modelo.elements.some((e) => {
  const a = modelo.nodes[e.n1 - 1], b = modelo.nodes[e.n2 - 1];
  return Math.abs(a.x - 4.0) < 1e-3 && Math.abs(b.x - 4.0) < 1e-3 && Math.abs(a.y - b.y) < 1e-3 &&
    a.y > 2.6 + 1e-3 && a.y < 3.4 - 1e-3 && Math.abs(a.z - b.z) > 0.5;
});
ok(!pieEnVano, 'sin pies derechos dentro del vano de puerta');

// ── Carga total esperada: CV en piso (k=1) 2.0 kN/m² sobre 8×6; techo (k=2) 1.0 ──
const elemL = new Map(modelo.elements.map((e) => {
  const n1 = modelo.nodes[e.n1 - 1], n2 = modelo.nodes[e.n2 - 1];
  return [e.id, Math.hypot(n2.x - n1.x, n2.y - n1.y, n2.z - n1.z)];
}));
const lcCV = modelo.loadCases.find((l) => l.name === 'CV');
let Wcv = 0; for (const ld of lcCV.loads) Wcv += ld.w * elemL.get(ld.elemId);
const Wesp = 2.0 * 8 * 6 + 1.0 * 8 * 6;  // piso + techo
ok(Math.abs(Wcv - Wesp) / Wesp < 1e-3, `ΣCV = piso(2.0)+techo(1.0) sobre 48 m² (${Wcv.toFixed(1)} vs ${Wesp.toFixed(1)} kN)`);

console.log('── Solver estático real: equilibrio (CV) ──');
globalThis.window = globalThis;
vm.runInThisContext(fs.readFileSync(path.join(raiz, 'lib', 'numeric.js'), 'utf8'));
ok(!!globalThis.numeric, 'numeric.js cargado');

const tmp = path.join(dir, '_mad_tmp');
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}   // best-effort (Windows lock)
fs.mkdirSync(tmp, { recursive: true });
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
m.units = modelo.units; m.mode = modelo.mode;
for (const d of modelo.materials) m.materials.set(d.id, d);
for (const d of modelo.sections) m.sections.set(d.id, d);
for (const d of modelo.nodes) m.nodes.set(d.id, d);
for (const d of modelo.elements) m.elements.set(d.id, d);
for (const d of modelo.loadCases) m.loadCases.set(d.id, d);

const res = new StaticSolver().solve(m, lcCV.id, false);
let Rz = 0;
for (const n of m.nodes.values()) { const r = res.getReaction(n.id); if (r) Rz += r[2]; }
ok(Math.abs(Rz - Wcv) / Wcv < 1e-4, `ΣRz = ΣCV aplicada (Rz=${Rz.toFixed(2)} kN vs ${Wcv.toFixed(2)})`);

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}   // best-effort (Windows lock)
console.log('── Avisos del generador ──');
for (const a of modelo._warnings) console.log(`   [${a.type}] ${a.msg}`);
console.log(fail === 0 ? '\n✅ MADERA: TODOS LOS CHEQUEOS OK' : `\n❌ ${fail} CHEQUEO(S) FALLARON`);
process.exit(fail === 0 ? 0 : 1);
