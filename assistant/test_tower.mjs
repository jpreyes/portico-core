// Test del generador de TORRE DE TRANSMISIÓN (#53): ficha.tower → celosía 3D.
// Verifica geometría (patas cónicas, anillos, diagonales, crucetas, apoyos), cargas
// (viento/cable) y que el modelo es ESTABLE (el solver estático no da mecanismo).
// Uso: node assistant/test_tower.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateModel } from './generator.js';
import '../lib/numeric.js';                       // setea global.numeric (efecto lateral)
import { Model } from '../js/model/model.js';
import { Serializer } from '../js/model/serializer.js';
import { StaticSolver } from '../js/solver/static_solver.js';
globalThis.window = globalThis;

const dir = path.dirname(fileURLToPath(import.meta.url));
function parseCSV(txt) { const L = txt.split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#')); const h = L[0].split(',').map(s => s.trim()); return L.slice(1).map(l => { const c = l.split(',').map(s => s.trim()); return Object.fromEntries(h.map((k, i) => [k, c[i]])); }); }
const read = (p) => fs.readFileSync(path.join(dir, p), 'utf8');
const libs = { reglas: JSON.parse(read('rules.json')), perfiles: parseCSV(read('profiles.csv')), materiales: parseCSV(read('materials.csv')) };

let fail = 0; const ok = (c, m) => { console.log(`${c ? '  ok ' : ' FAIL'}  ${m}`); if (!c) fail++; };

// ── Ficha de una torre 30 m, base 6 → cima 1.5, 8 paneles, 3 crucetas ──
const ficha = {
  project: 'Torre 220 kV', typology: 'torre de transmisión',
  tower: {
    height_m: 30, base_m: 6, top_m: 1.5, panels: 8, bracing: 'X',
    chord_profile: 'L120x120x12', diagonal_profile: 'L80x80x8', rotulado: false,
    crossarms: [
      { z_m: 22.5, length_m: 4, vertical_load_kN: 12, transverse_load_kN: 6 },
      { z_m: 26.25, length_m: 3.5, vertical_load_kN: 12, transverse_load_kN: 6 },
      { z_m: 30, length_m: 3, vertical_load_kN: 12, transverse_load_kN: 6 },
    ],
  },
  loads: { viento_kPa: 0.6 },
};

const m = generateModel(ficha, libs);
console.log('──', m._generado.resumen);

console.log('── Geometría ──');
ok(m.mode === '3D', 'modo 3D');
// 4 patas × (8+1 niveles) = 36 nodos de cuerpo + 2 puntas por cruceta × 3 = 6
ok(m.nodes.length === 36 + 6, `nodos = 42 (es ${m.nodes.length})`);
const base = m.nodes.filter(n => Math.abs(n.z) < 1e-6);
ok(base.length === 4, `4 nodos en la base (es ${base.length})`);
ok(base.every(n => n.restraints.ux && n.restraints.uz && n.restraints.rx), 'base empotrada (rígida)');
// cónica: el semiancho arriba < abajo
const topW = Math.max(...m.nodes.filter(n => Math.abs(n.z - 30) < 1e-6 && Math.abs(Math.abs(n.x) - Math.abs(n.y)) < 1e-6).map(n => Math.abs(n.x)));
const botW = Math.max(...base.map(n => Math.abs(n.x)));
ok(Math.abs(botW - 3) < 1e-6, `semiancho base = 3 m (es ${botW})`);
ok(topW < botW, `cónica: cima (${topW.toFixed(2)}) < base (${botW})`);
// crossarms: 6 puntas a |x| > semiancho del cuerpo
const tips = m.nodes.filter(n => Math.abs(n.y) < 1e-6 && Math.abs(n.x) > 1.6 && n.z > 20);
ok(tips.length >= 6, `≥6 puntas de cruceta (es ${tips.length})`);
ok(m.sections.length === 2, '2 secciones (montante + diagonal)');

console.log('── Cargas ──');
const lcCa = m.loadCases.find(l => l.name === 'Cables');
const sumFz = lcCa.loads.reduce((s, ld) => s + ld.F[2], 0);
ok(Math.abs(sumFz - (-6 * 12)) < 1e-6, `ΣFz cables = −72 kN (6 puntas × 12) (es ${sumFz})`);
const lcVi = m.loadCases.find(l => l.name === 'Viento');
ok(lcVi.loads.length > 0 && lcVi.loads.every(l => l.F[0] > 0), 'wind: cargas +X en los nodos');
ok(m.combinations.length === 2, '2 combinaciones');

console.log('── Estabilidad: solver estático (sin mecanismo) ──');
const mod = new Serializer().fromJSON(JSON.stringify(m));
let solved = false, dmax = 0;
try {
  const res = new StaticSolver().solve(mod, lcCa.id, true);   // cables + peso propio
  for (const nd of mod.nodes.values()) { const d = res.getNodeDisp(nd.id); dmax = Math.max(dmax, Math.hypot(d[0], d[1], d[2])); }
  solved = isFinite(dmax) && dmax > 0;
} catch (e) { console.log('   solver:', e.message); }
ok(solved, `estable (δmax = ${dmax.toExponential(3)} m, finito)`);

console.log(fail ? `\n❌ ${fail} FALLARON` : '\n✅ TODO OK');
process.exit(fail ? 1 : 0);
