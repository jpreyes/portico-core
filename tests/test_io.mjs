// test_io.mjs — interoperabilidad (#74, G18): modelo neutro + registro + adaptadores.
//
//  A) Registro extensible: registrar un formato a medida y resolverlo por id.
//  B) Round-trip VECTOR (.dat, campo fijo): model → export → import → model', comparar
//     geometría, conectividad, secciones (A/Iz/Iy/J), E/G, apoyos y cargas nodales.
//  C) Round-trip Abaqus/CalculiX (.inp, keywords): mismo modelo, mismas comparaciones.
//  D) El .dat exportado respeta el FORMATO de campo fijo del parser de referencia (C).
import { Model } from '../js/model/model.js';
import { registerFormat, listFormats, exportModel, importModel, modelToNeutral } from '../js/io/index.js';

let fails = 0;
const ok = (c, m) => { console.log(`${c ? '  OK ' : 'FAIL '} ${m}`); if (!c) fails++; };
const rel = (a, b, tol, m) => ok(Math.abs(a - b) <= tol * Math.abs(b) + 1e-9, `${m}  (${(+a).toExponential(4)} vs ${(+b).toExponential(4)})`);

// ── modelo de prueba: pórtico 3D con 2 secciones, apoyos y cargas ─────────────
function buildModel() {
  const m = new Model(); m.materials.clear(); m.sections.clear();
  const acero = m.addMaterial({ name: 'Acero', E: 2.1e8, G: 8.08e7, nu: 0.3, rho: 7.85 });
  const horm = m.addMaterial({ name: 'Hormigon', E: 2.5e7, G: 1.04e7, nu: 0.2, rho: 2.5 });
  const colS = m.addSection({ name: 'Col', A: 0.04, Iz: 1.3e-4, Iy: 1.3e-4, J: 2.6e-4 });
  const vigaS = m.addSection({ name: 'Viga', A: 0.02, Iz: 6.7e-5, Iy: 1.2e-5, J: 8.0e-5 });
  // 4 nodos: 2 bases empotradas + 2 superiores
  const n1 = m.addNode(0, 0, 0, { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 });
  const n2 = m.addNode(0, 0, 3);
  const n3 = m.addNode(4, 0, 3);
  const n4 = m.addNode(4, 0, 0, { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 });
  m.addElement(n1.id, n2.id, horm.id, colS.id);    // columna (hormigón)
  m.addElement(n2.id, n3.id, acero.id, vigaS.id);  // viga (acero)
  m.addElement(n4.id, n3.id, horm.id, colS.id);    // columna (hormigón)
  const lc = m.addLoadCase('Sismo', false, 'static');
  m.addLoad(lc.id, { type: 'nodal', nodeId: n2.id, F: [50, 0, -10, 0, 0, 0] });   // Fx=50, Fz=-10
  m.addLoad(lc.id, { type: 'nodal', nodeId: n3.id, F: [0, 0, -10, 0, 5, 0] });    // Fz=-10, My=5
  return m;
}

// compara dos modelos por su contenido físico (los ids pueden diferir tras el remapeo)
function compare(a, b, tag) {
  ok(a.nodes.size === b.nodes.size, `${tag}: nº de nodos (${a.nodes.size} = ${b.nodes.size})`);
  ok(a.elements.size === b.elements.size, `${tag}: nº de barras (${a.elements.size} = ${b.elements.size})`);
  const na = [...a.nodes.values()], nb = [...b.nodes.values()];
  let maxd = 0; for (let i = 0; i < na.length; i++) maxd = Math.max(maxd, Math.abs(na[i].x - nb[i].x), Math.abs(na[i].y - nb[i].y), Math.abs(na[i].z - nb[i].z));
  ok(maxd < 1e-6, `${tag}: coordenadas idénticas (máx Δ ${maxd.toExponential(2)})`);
  // apoyos del primer nodo (empotrado)
  const r0 = nb[0].restraints; ok(r0.ux && r0.uy && r0.uz && r0.rx && r0.ry && r0.rz, `${tag}: nodo 1 sigue empotrado (6 GDL)`);
  ok(Object.values(na[1].restraints).every(v => !v) && Object.values(nb[1].restraints).every(v => !v), `${tag}: nodo 2 sigue libre`);
  // propiedades efectivas por barra — cotejadas por CONECTIVIDAD (el orden puede cambiar
  // al agrupar por ELSET; los ids de nodo 1..N son estables en ambos sentidos)
  const eb = [...b.elements.values()];
  const bByConn = new Map(); for (const e of eb) bByConn.set(`${Math.min(e.n1, e.n2)},${Math.max(e.n1, e.n2)}`, e);
  let okSec = true, okMat = true, matched = 0;
  for (const e of a.elements.values()) {
    const m = bByConn.get(`${Math.min(e.n1, e.n2)},${Math.max(e.n1, e.n2)}`);
    if (!m) { okSec = false; continue; }
    matched++;
    const sa = a.sections.get(e.secId), sb = b.sections.get(m.secId);
    const ma = a.materials.get(e.matId), mb = b.materials.get(m.matId);
    if (Math.max(Math.abs(sa.A - sb.A), Math.abs(sa.Iz - sb.Iz), Math.abs(sa.Iy - sb.Iy), Math.abs(sa.J - sb.J)) > 1e-9 * Math.max(1, sa.A)) okSec = false;
    if (Math.abs(ma.E - mb.E) > 1e-3 * ma.E || Math.abs(ma.G - mb.G) > 1e-3 * Math.max(1, ma.G)) okMat = false;
  }
  ok(okSec && matched === a.elements.size, `${tag}: A/Iz/Iy/J + conectividad por barra preservados`);
  ok(okMat, `${tag}: E/G por barra preservados`);
  // cargas nodales (sumadas por nodo)
  const sumLoads = (mm) => { const map = new Map(); for (const lc of mm.loadCases.values()) for (const l of (lc.loads || [])) if (l.type === 'nodal') { const k = l.nodeId; const cur = map.get(k) || [0, 0, 0, 0, 0, 0]; for (let i = 0; i < 6; i++) cur[i] += (l.F[i] || 0); map.set(k, cur); } return map; };
  const la = sumLoads(a), lb = sumLoads(b);
  let okLoad = la.size === lb.size, maxL = 0;
  for (const [k, v] of la) { const w = lb.get(k) || [0, 0, 0, 0, 0, 0]; for (let i = 0; i < 6; i++) maxL = Math.max(maxL, Math.abs(v[i] - w[i])); }
  ok(okLoad && maxL < 1e-6, `${tag}: cargas nodales preservadas (máx Δ ${maxL.toExponential(2)}, ${la.size} nodos cargados)`);
}

// ── A) registro extensible ────────────────────────────────────────────────────
console.log('\n── A) registro de formatos extensible ───────────────────');
ok(listFormats().some(f => f.id === 'vector'), 'VECTOR registrado');
ok(listFormats().some(f => f.id === 'abaqus'), 'Abaqus/CalculiX registrado');
ok(listFormats().some(f => f.id === 'sap2000'), 'SAP2000 registrado');
ok(listFormats().some(f => f.id === 'etabs'), 'ETABS registrado');
ok(listFormats().some(f => f.id === 'opensees'), 'OpenSees registrado');
ok(listFormats().some(f => f.id === 'sofistik'), 'SOFISTIK registrado');
registerFormat({ id: 'demo', name: 'Demo CSV', ext: 'csv', write: (n) => `nodes,${n.nodes.length}` });
const demo = exportModel(buildModel(), 'demo');
ok(demo.text === 'nodes,4' && demo.ext === 'csv', `formato a medida funciona vía la misma API (${demo.text})`);

// ── B) round-trip VECTOR ──────────────────────────────────────────────────────
console.log('\n── B) round-trip VECTOR (.dat campo fijo) ───────────────');
{
  const m = buildModel();
  const { text } = exportModel(m, 'vector');
  const { model: m2 } = importModel(text, 'vector');
  compare(m, m2, 'VECTOR');
}

// ── C) round-trip Abaqus/CalculiX ─────────────────────────────────────────────
console.log('\n── C) round-trip Abaqus/CalculiX (.inp keywords) ────────');
{
  const m = buildModel();
  const { text } = exportModel(m, 'abaqus');
  const { model: m2 } = importModel(text, 'abaqus');
  compare(m, m2, 'Abaqus');
}

// ── C2) round-trip SAP2000 (.s2k tablas) + liberaciones de extremo ────────────
console.log('\n── C2) round-trip SAP2000 (.s2k tablas) ─────────────────');
{
  const m = buildModel();
  // libera flexión en el extremo j de la viga (barra 2) → SAP lo preserva 1:1
  const viga = [...m.elements.values()][1];
  const rel = Array(12).fill(0); rel[11] = 1;   // M3J (rz en j)
  m.updateElement(viga.id, { releases: rel });
  const { text } = exportModel(m, 'sap2000');
  const { model: m2 } = importModel(text, 'sap2000');
  compare(m, m2, 'SAP2000');
  // la liberación sobrevive (busca por conectividad)
  const eb = [...m2.elements.values()].find(e => {
    const a = m2.nodes.get(e.n1), b = m2.nodes.get(e.n2);
    return Math.abs(a.z - 3) < 1e-9 && Math.abs(b.z - 3) < 1e-9;   // la viga (ambos nodos a z=3)
  });
  ok(eb && eb.releases[11] === 1, `SAP2000: liberación de extremo M3J preservada (rel[11]=${eb ? eb.releases[11] : '—'})`);
  ok(text.includes('TABLE:  "JOINT COORDINATES"') && text.includes('FRAME SECTION PROPERTIES'), 'SAP2000: estructura de tablas correcta');
}

// ── C3) round-trip ETABS (.e2k por pisos) + liberaciones ──────────────────────
console.log('\n── C3) round-trip ETABS (.e2k modelo por pisos) ─────────');
{
  const m = buildModel();
  const viga = [...m.elements.values()][1];
  const rel = Array(12).fill(0); rel[11] = 1;   // M3J en la viga
  m.updateElement(viga.id, { releases: rel });
  const { text } = exportModel(m, 'etabs');
  const { model: m2 } = importModel(text, 'etabs');
  compare(m, m2, 'ETABS');
  ok(text.includes('$ STORIES') && text.includes('LINE ') && text.includes('FRAMESECTION'), 'ETABS: estructura por pisos/líneas correcta');
  ok(/STORY "BASE"\s+ELEV 0/.test(text), 'ETABS: BASE en ELEV 0');
  const eb = [...m2.elements.values()].find(e => { const a = m2.nodes.get(e.n1), b = m2.nodes.get(e.n2); return Math.abs(a.z - 3) < 1e-9 && Math.abs(b.z - 3) < 1e-9; });
  ok(eb && eb.releases[11] === 1, `ETABS: liberación M3J preservada (rel[11]=${eb ? eb.releases[11] : '—'})`);
}

// ── C4) round-trip OpenSees (.tcl) ────────────────────────────────────────────
console.log('\n── C4) round-trip OpenSees (.tcl script) ────────────────');
{
  const m = buildModel();
  const { text } = exportModel(m, 'opensees');
  const { model: m2 } = importModel(text, 'opensees');
  compare(m, m2, 'OpenSees');
  ok(text.includes('model BasicBuilder -ndm 3 -ndf 6') && text.includes('element elasticBeamColumn'), 'OpenSees: comandos Tcl correctos');
}

// ── C5) round-trip SOFISTIK (.dat por módulos) ────────────────────────────────
console.log('\n── C5) round-trip SOFISTIK (.dat por módulos) ───────────');
{
  const m = buildModel();
  const { text } = exportModel(m, 'sofistik');
  const { model: m2 } = importModel(text, 'sofistik');
  compare(m, m2, 'SOFISTIK');
  ok(text.includes('+PROG AQUA') && text.includes('+PROG SOFIMSHA') && text.includes('BEAM NO'), 'SOFISTIK: estructura por módulos correcta');
}

// ── D) el .dat respeta el campo fijo del parser de referencia ─────────────────
console.log('\n── D) formato de campo fijo VECTOR ──────────────────────');
{
  const m = buildModel();
  const { text } = exportModel(m, 'vector');
  const lines = text.split('\n');
  // línea 2 = constantes: I2,I3,5I5,I2,I3,I5 → NS=3 (cols 3-5), NP=4 (cols 6-10), NT=2 (cols 11-15)
  const hdr = lines[1];
  rel(parseInt(hdr.slice(2, 5)), 3, 0, 'NS (barras) en cols 3-5');
  rel(parseInt(hdr.slice(5, 10)), 4, 0, 'NP (nodos) en cols 6-10');
  rel(parseInt(hdr.slice(10, 15)), 2, 0, 'NT (tipos) en cols 11-15');
  // primera línea de nodo: X en cols 1-10, restraints (7 chars) tras col 30
  const n1line = lines[2];
  ok(n1line.length >= 37, `línea de nodo con ancho de campo fijo (${n1line.length} ≥ 37)`);
  ok(n1line.slice(30, 37) === '0111111', `nodo 1 empotrado → 7I1 = 0111111 (leído «${n1line.slice(30, 37)}»)`);
}

console.log(fails === 0 ? '\n✔ Todos los asserts pasaron\n' : `\n✗ ${fails} fallaron\n`);
process.exit(fails ? 1 : 0);
