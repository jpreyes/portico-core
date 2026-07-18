// run_verifs.mjs — pipeline BATCHED de verificaciones.
//   node tools/run_verifs.mjs            # todos los casos de tools/verif/cases/
//   node tools/run_verifs.mjs 1-014      # sólo los que matcheen
//
// Por cada caso: carga el .s3d (construido a mano) → corre el solver de Pórtico
// HEADLESS → genera la figura 3D (SVG isométrico) → compara contra la referencia
// → arma el .md → genera el .pdf con md2pdf (membrete del proyecto). Lo único caso-a-caso
// es construir el .s3d y validar; todo lo demás es automático.
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { Serializer } from '../js/model/serializer.js';
import { runAnalysis } from './verif/runners.mjs';
import { renderModelSVG } from './verif/figure.mjs';

const ROOT = process.cwd();
const LOGOS = '';
const pat = process.argv[2] || '';

const pct = (v, ref) => {
  if (Math.abs(ref) < 1e-9) return Math.abs(v) < 0.5 ? '≈0' : `${v.toFixed(2)}`;   // referencia nula
  const d = (v - ref) / ref * 100; return Math.abs(d) < 0.005 ? '0 %' : `${d >= 0 ? '+' : ''}${d.toFixed(2)} %`;
};
const esc = s => String(s);

function mdTable(header, rows) {
  return `| ${header.join(' | ')} |\n| ${header.map(() => '---').join(' | ')} |\n`
    + rows.map(r => `| ${r.join(' | ')} |`).join('\n') + '\n';
}

// Figura: nodos/elementos + deformada de la forma modal (amp auto).
function buildFigure(model, out, caseDef) {
  const nodes = new Map(), elements = [], supports = new Set();
  for (const n of model.nodes.values()) {
    nodes.set(n.id, [n.x, n.y, n.z]);
    // Apoyo "real" = ≥2 restricciones de traslación (pin/empotramiento). Evita
    // marcar restricciones artificiales de un solo GDL (p.ej. Ux para excluir axial).
    const r = n.restraints; if (r && ((r.ux ? 1 : 0) + (r.uy ? 1 : 0) + (r.uz ? 1 : 0)) >= 2) supports.add(n.id);
  }
  for (const e of model.elements.values()) elements.push({ n1: e.n1, n2: e.n2 });
  // Áreas (shell / membrane / placa): polígonos de nodos → renderModelSVG los dibuja
  // como caras rellenas. Sin esto, los casos 2D sólo mostraban los nodos exteriores.
  const areas = [...(model.areas?.values?.() || [])]
    .map(a => a.nodes || a.n || a.nodeIds || []).filter(ns => ns.length >= 3);
  // diagonal del bbox para escalar la amplitud
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const c of nodes.values()) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], c[k]); mx[k] = Math.max(mx[k], c[k]); }
  const diag = Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) || 1;
  let deformed = null;
  if (caseDef.figure) {
    // campo de deformación crudo (modal: forma del modo; estático: desplazamientos)
    const defo = new Map(); let maxT = 0;
    for (const id of nodes.keys()) {
      let d = [0, 0, 0];
      if (out.type === 'modal') { const s = out.res.getModeShape((caseDef.figure.mode || 1) - 1).get(id); if (s) d = [s[0], s[1], s[2]]; }
      else if (out.res.getNodeDisp) { const s = out.res.getNodeDisp(id); if (s) d = [s[0], s[1], s[2]]; }   // static / nllite
      defo.set(id, d); maxT = Math.max(maxT, Math.hypot(d[0], d[1], d[2]));
    }
    if (maxT > 0) {
      const amp = 0.16 * diag / maxT;   // escala para que la deformada sea visible
      deformed = new Map();
      for (const [id, c] of nodes) { const d = defo.get(id); deformed.set(id, [c[0] + amp * d[0], c[1] + amp * d[1], c[2] + amp * d[2]]); }
    }
  }
  // optimización: la forma modal sólo se calcula una vez por nodo arriba; recalcular
  // getModeShape en el bucle es O(n²) pero los modelos de verificación son chicos.
  return renderModelSVG({ nodes, elements, areas, supports, deformed, width: 900 });
}

// Committed OpenSees run for a case, if one exists. Produced by
// tools/verif/opensees/run_case.py — see that file for how the model is translated.
// Absent → the case simply gets no OpenSees column.
function openseesResult(id) {
  const p = path.join(ROOT, 'tools/verif/opensees/results', id + '.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

// Prose for the OpenSees column: says where the numbers came from and how closely the
// two engines agree. The engine-vs-engine gap is the point — it separates "PORTICO is
// wrong" from "this mesh cannot reach the closed-form answer", which the difference
// against the analytical reference alone cannot distinguish.
function osNote(ov, meta, pv, mod) {
  if (!ov || !meta) return '';
  const rel = ov.map((o, i) => Math.abs(o) < 1e-12 ? Math.abs(pv[i] - o) : Math.abs((pv[i] - o) / o));
  const worst = Math.max(...rel);
  const elems = (meta.element || []).join(' + ');
  return `\n### Contraste con OpenSees\n\n` +
    `Segunda opinión de un motor independiente y establecido: **OpenSees ${meta.version || ''}** ` +
    `(\`openseespy\`), corrido sobre el mismo \`.s3d\` mediante ` +
    `[\`tools/verif/opensees/run_case.py\`](../../tools/verif/opensees/run_case.py), que **traduce el ` +
    `modelo por su cuenta** — no pasa por el exportador de Pórtico, para que un malentendido ` +
    `compartido no se cuele. Elemento: \`${elems}\`; masa ${meta.mass}.\n\n` +
    `Diferencia máxima **Pórtico ↔ OpenSees: ${worst.toExponential(1)}** (relativa). ` +
    `Ambos resuelven la **misma malla** con la formulación de elemento igualada, así que lo ` +
    `que los dos comparten frente a la referencia analítica es discretización, no error de ` +
    `Pórtico. El residuo entre motores acota lo que aportan las diferencias de método que ` +
    `quedan (p. ej. Pórtico impone links y diafragmas por penalti, OpenSees por restricción ` +
    `exacta).\n\n`;
}

async function buildComparison(cmp, out, id) {
  // `out` se pasa también (2º arg) para casos multi-LC: cmp.portico(res, out) →
  // los casos sencillos ignoran el 2º argumento (compatibilidad). portico puede
  // ser async (p.ej. correr variantes adicionales del modelo).
  const pv = await cmp.portico(out.res, out);

  // OpenSees column: only when the case says how to read it AND a run is committed.
  const osRaw = cmp.opensees ? openseesResult(id) : null;
  const ov = osRaw ? cmp.opensees(osRaw) : null;

  // The SAP2000 column is only shown when the case carries a REAL same-element SAP value.
  // A convergence/element study compared only against the analytical target leaves `sap`
  // null on every row — showing a stubbed "SAP = analytical, diff 0 %" would falsely imply
  // an independent same-element engine validated it.
  const hasSap = cmp.rows.some(r => r.sap != null);
  const idxLabel = cmp.indexLabel || 'Modo';
  const header = [idxLabel, 'Descripción', `Independiente (${cmp.unit})`];
  if (hasSap) header.push(`SAP2000 (${cmp.unit})`, 'dif. SAP');
  if (ov) header.push(`OpenSees (${cmp.unit})`, 'dif. OpenSees');
  header.push(`**Pórtico (${cmp.unit})**`, '**dif. Pórtico**');

  const rows = cmp.rows.map((r, i) => {
    const p = pv[i];
    const row = [String(r.idx ?? (i + 1)), r.desc, r.indep.toFixed(cmp.decimals)];
    if (hasSap) row.push(r.sap != null ? r.sap.toFixed(cmp.decimals) : '—', r.sap != null ? pct(r.sap, r.indep) : '—');
    if (ov) row.push(ov[i].toFixed(cmp.decimals), pct(ov[i], r.indep));
    row.push(`**${p.toFixed(cmp.decimals)}**`, `**${pct(p, r.indep)}**`);
    return row;
  });
  return { table: mdTable(header, rows), pv, ov, osMeta: osRaw?._meta || null };
}

async function runCase(file) {
  const mod = (await import('./verif/cases/' + file)).default;
  const model = new Serializer().fromJSON(fs.readFileSync(path.join(ROOT, mod.s3d), 'utf8'));
  const out = await runAnalysis(model, mod);

  // figura
  const svg = buildFigure(model, out, mod);
  const imgRel = `img/${mod.slug}.svg`;
  fs.mkdirSync(path.join(ROOT, 'docs/verifications/img'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'docs/verifications', imgRel), svg, 'utf8');

  // comparación + sustitución de placeholders {{Pi}}/{{Di}} en `extra`
  const { table, pv, ov, osMeta } = await buildComparison(mod.compare, out, mod.id);
  let extra = mod.extra || '';
  extra = extra.replace(/\{\{P(\d+)\}\}/g, (_, i) => pv[+i].toFixed(mod.compare.decimals))
               .replace(/\{\{D(\d+)\}\}/g, (_, i) => pct(pv[+i], mod.compare.rows[+i].indep));
  const caption = typeof mod.figure?.caption === 'function' ? mod.figure.caption(out.res) : (mod.figure?.caption || '');

  const md = `# Verificación ${mod.id} — ${mod.title}

[English](${mod.slug}.md) · **Español**

**Capacidad verificada:** ${mod.capability}.
**Referencia:** ${mod.referenceText}
**Modelo Pórtico:** [\`${mod.s3d}\`](../../${mod.s3d})

## Descripción del problema

${mod.intro}

${mdTable(['Propiedad', 'Valor'], mod.props)}
## Modelo en Pórtico

${mod.modelNotes.map(n => `- ${n}`).join('\n')}

![${esc(caption)}](${imgRel})

*Figura 1. ${caption}*

## Resultados — comparación

${mod.compare.intro}

${table}
${osNote(ov, osMeta, pv, mod)}${extra ? extra + '\n\n' : ''}## Conclusión

${mod.conclusion}
`;
  // The case prose is Spanish, so this pipeline owns `<slug>.es.md`. `<slug>.md` is the
  // English translation, maintained by hand — regenerating must not clobber it.
  const mdPath = path.join(ROOT, 'docs/verifications', mod.slug + '.es.md');
  fs.writeFileSync(mdPath, md, 'utf8');

  // PDF
  execFileSync('node', ['tools/md2pdf.mjs', path.relative(ROOT, mdPath), '--logos', LOGOS], { cwd: ROOT, stdio: 'ignore' });

  // resumen a consola
  const relPct = (v, ref) => Math.abs(ref) < 1e-9 ? 0 : Math.abs((v - ref) / ref * 100);
  const maxDiff = Math.max(...mod.compare.rows.map((r, i) => relPct(pv[i], r.indep)));
  // Same-element / same-software reference: portico vs SAP2000 (apples-to-apples). For
  // element-behaviour or convergence studies this is the honest verdict — the analytical
  // column is the ideal a basic element intentionally does not reach.
  const sapRows = mod.compare.rows.filter(r => r.sap != null);
  const maxVsSap = sapRows.length ? Math.max(...mod.compare.rows.map((r, i) => r.sap != null ? relPct(pv[i], r.sap) : 0)) : null;
  const osDiff = ov ? Math.max(...ov.map((o, i) => Math.abs(o) < 1e-12 ? Math.abs(pv[i] - o) : Math.abs((pv[i] - o) / o))) : null;
  console.log(`✓ ${mod.id}  ${mod.slug}  ·  máx |dif| = ${maxDiff.toFixed(3)} %` +
    (osDiff !== null ? `  ·  vs OpenSees = ${osDiff.toExponential(1)}` : '') +
    `  ·  ${mod.slug}.pdf`);
  return { id: mod.id, slug: mod.slug, title: mod.title, capability: mod.capability,
    referenceText: mod.referenceText, unit: mod.compare?.unit || '', maxDiff, maxVsSap, osDiff };
}

const files = fs.readdirSync(path.join(ROOT, 'tools/verif/cases')).filter(f => f.endsWith('.mjs') && (!pat || f.includes(pat))).sort();
if (!files.length) { console.error('Sin casos en tools/verif/cases/ que matcheen', pat); process.exit(1); }
console.log(`Corriendo ${files.length} caso(s)…`);
const index = [];
for (const f of files) { try { index.push(await runCase(f)); } catch (e) { console.error(`✗ ${f}: ${e.message}`); } }
// Persist a results index for the master Verification Manual generator (living doc).
fs.writeFileSync(path.join(ROOT, 'docs/verifications/_index.json'), JSON.stringify(index, null, 2), 'utf8');
console.log(`Listo. Índice → docs/verifications/_index.json (${index.length} casos).`);
