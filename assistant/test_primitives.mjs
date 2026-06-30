// Test de la capa de PRIMITIVAS (estructura libre): auto-conexión + equilibrio.
import fs from 'node:fs'; import path from 'node:path'; import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generateModel } from './generator.js';
const dir = path.dirname(fileURLToPath(import.meta.url)); const raiz = path.resolve(dir, '..');
const parseCSV = (t) => { const L = t.split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#')); const h = L[0].split(',').map(s => s.trim()); return L.slice(1).map(l => { const c = l.split(',').map(s => s.trim()); return Object.fromEntries(h.map((k, i) => [k, c[i]])); }); };
const read = (p) => fs.readFileSync(path.join(dir, p), 'utf8');
const reglas = JSON.parse(read('rules.json')); const materiales = parseCSV(read('materials.csv')); const perfiles = parseCSV(read('profiles.csv'));
let fail = 0; const ok = (c, m) => { console.log(`${c ? '  ok ' : ' FAIL'}  ${m}`); if (!c) fail++; };

globalThis.window = globalThis;
vm.runInThisContext(fs.readFileSync(path.join(raiz, 'lib', 'numeric.js'), 'utf8'));
const tmp = path.join(dir, '_prim_tmp'); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} fs.mkdirSync(tmp, { recursive: true });
const find = (b) => ['js/solver', 'js/model', 'js'].map(d => path.join(raiz, d, b)).find(p => fs.existsSync(p));
const vis = new Set(); const cp = (b) => { if (vis.has(b)) return; vis.add(b); const s0 = find(b); if (!s0) return; const s = fs.readFileSync(s0, 'utf8').replace(/\?v=\d+/g, ''); fs.writeFileSync(path.join(tmp, b), s); for (const mm of s.matchAll(/from\s+['"]\.[^'"]*\/([\w.-]+\.js)['"]/g)) cp(mm[1]); };
cp('static_solver.js'); cp('model.js');
const { Model } = await import(pathToFileURL(path.join(tmp, 'model.js')).href);
const { StaticSolver } = await import(pathToFileURL(path.join(tmp, 'static_solver.js')).href);
function eq(modelo, lcName) {
  const m = new Model(); m.materials.clear(); m.sections.clear(); m.units = modelo.units; m.mode = modelo.mode;
  for (const d of modelo.materials) m.materials.set(d.id, d);
  for (const d of modelo.sections) m.sections.set(d.id, d);
  for (const d of modelo.nodes) m.nodes.set(d.id, d);
  for (const d of modelo.elements) m.elements.set(d.id, d);
  for (const d of modelo.loadCases) m.loadCases.set(d.id, d);
  const lc = modelo.loadCases.find(l => l.name === lcName);
  const eL = new Map(modelo.elements.map(e => { const a = modelo.nodes[e.n1 - 1], b = modelo.nodes[e.n2 - 1]; return [e.id, Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)]; }));
  let W = 0; for (const ld of lc.loads) W += ld.w * eL.get(ld.elemId);
  const res = new StaticSolver().solve(m, lc.id, false);
  let Rz = 0; for (const n of m.nodes.values()) { const r = res.getReaction(n.id); if (r) Rz += r[2]; }
  return { W, Rz, finite: Number.isFinite(Rz) };
}

console.log('── Auto-conexión: dos barras en cruz (X) comparten nodo central ──');
const cruz = generateModel({ mode: '2D', typology: 'primitives', default_material: 'S275', elements: [
  { type: 'bar', from: [0, 0, 0], to: [4, 0, 4], section: 'IPE300' },
  { type: 'bar', from: [0, 0, 4], to: [4, 0, 0], section: 'IPE300' },
] }, { reglas, materiales, perfiles });
ok(cruz.nodes.length === 5, `cruz: 5 nodos (4 extremos + 1 centro) (es ${cruz.nodes.length})`);
ok(cruz.elements.length === 4, `cruz: 4 barras (cada diagonal partida) (es ${cruz.elements.length})`);

console.log('── Puente de 3 vigas (2 laterales + 1 central) por primitivas ──');
const puente3 = generateModel({ mode: '3D', typology: 'primitives', default_material: 'H40', elements: [
  { type: 'repeated_beams', from: [0, -4, 5], to: [60, -4, 5], step_dir: 'Y', step: 4, n_repeat: 3, section: { b_cm: 40, h_cm: 120 } },
  { type: 'repeated_beams', from: [0, -4, 5], to: [0, 4, 5], step_dir: 'X', step: 2, to_coord: 60, section: { b_cm: 30, h_cm: 60 }, load_kN_m: 50 },
  { type: 'repeated_beams', from: [0, -4, 0], to: [0, -4, 5], step_dir: 'X', step: 20, to_coord: 60, section: { b_cm: 80, h_cm: 80 } },
  { type: 'repeated_beams', from: [0, 4, 0], to: [0, 4, 5], step_dir: 'X', step: 20, to_coord: 60, section: { b_cm: 80, h_cm: 80 } },
], supports: [{ z: 0, type: 'fixed' }] }, { reglas, materiales, perfiles });
console.log('  ', puente3._generado.resumen);
const central = puente3.nodes.some(n => Math.abs(n.x - 2) < 1e-3 && Math.abs(n.y) < 1e-3 && Math.abs(n.z - 5) < 1e-3);
ok(central, 'nodo de cruce viga central×transversal en (2,0,5) (auto-conexión)');
// Legacy grade "H40" resolves to the NCh170:2016 catalog grade "G40" (generator maps g/h + fc).
ok(/G40/.test(puente3.materials[0].name), `material H40 → G40 (${puente3.materials[0].name})`);
const e3 = eq(puente3, 'CV');
ok(e3.finite, `solución finita: ΣRz=${e3.Rz.toFixed(0)} kN`);
ok(Math.abs(e3.Rz - e3.W) / e3.W < 1e-4, `ΣRz = ΣCV (${e3.Rz.toFixed(0)} vs ${e3.W.toFixed(0)} kN)`);

console.log('── Torre de celosía 4 patas (nunca templada) por primitivas ──');
const torre = generateModel({ mode: '3D', typology: 'primitives', default_material: 'S275', elements: [
  // 4 patas (columnas) de z=0 a z=12
  { type: 'bar', from: [0, 0, 0], to: [0, 0, 12], section: 'HEB200' },
  { type: 'bar', from: [3, 0, 0], to: [3, 0, 12], section: 'HEB200' },
  { type: 'bar', from: [3, 3, 0], to: [3, 3, 12], section: 'HEB200' },
  { type: 'bar', from: [0, 3, 0], to: [0, 3, 12], section: 'HEB200' },
  // anillos horizontales a z=6 y z=12
  { type: 'repeated_beams', from: [0, 0, 6], to: [3, 0, 6], step_dir: 'Y', step: 3, n_repeat: 2, section: 'IPE200' },
  { type: 'repeated_beams', from: [0, 0, 6], to: [0, 3, 6], step_dir: 'X', step: 3, n_repeat: 2, section: 'IPE200' },
  { type: 'repeated_beams', from: [0, 0, 12], to: [3, 0, 12], step_dir: 'Y', step: 3, n_repeat: 2, section: 'IPE200', load_kN_m: 5 },
  { type: 'repeated_beams', from: [0, 0, 12], to: [0, 3, 12], step_dir: 'X', step: 3, n_repeat: 2, section: 'IPE200', load_kN_m: 5 },
  // diagonales en las 4 caras (dos tramos cada una)
  { type: 'bar', from: [0, 0, 0], to: [3, 0, 6], section: 'L100' }, { type: 'bar', from: [3, 0, 6], to: [0, 0, 12], section: 'L100' },
  { type: 'bar', from: [3, 0, 0], to: [3, 3, 6], section: 'L100' }, { type: 'bar', from: [3, 3, 6], to: [3, 0, 12], section: 'L100' },
  { type: 'bar', from: [3, 3, 0], to: [0, 3, 6], section: 'L100' }, { type: 'bar', from: [0, 3, 6], to: [3, 3, 12], section: 'L100' },
  { type: 'bar', from: [0, 3, 0], to: [0, 0, 6], section: 'L100' }, { type: 'bar', from: [0, 0, 6], to: [0, 3, 12], section: 'L100' },
], supports: [{ z: 0, type: 'fixed' }] }, { reglas, materiales, perfiles });
console.log('  ', torre._generado.resumen);
ok(torre.elements.length > 0 && torre.nodes.length > 0, 'torre generada');
const et = eq(torre, 'CV');
ok(et.finite && Math.abs(et.Rz - et.W) / Math.max(1, et.W) < 1e-3, `torre equilibrio: ΣRz=${et.Rz.toFixed(1)} vs ${et.W.toFixed(1)} kN`);

// Best-effort cleanup: Windows ESM loader keeps the copies locked → EPERM. Gitignored.
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
console.log(fail === 0 ? '\n✅ PRIMITIVAS: OK' : `\n❌ ${fail} FALLARON`);
process.exit(fail === 0 ? 0 : 1);
