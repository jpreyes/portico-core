// build_verification_manual.mjs — assemble the MASTER Verification Manual from the
// per-case docs and the results index that tools/run_verifs.mjs writes.
//
//   node tools/run_verifs.mjs            # 1) regenerate every case + docs/verifications/_index.json
//   node tools/build_verification_manual.mjs [--no-pdf]   # 2) assemble the manual (ES + EN) + PDF
//
// The manual is a LIVING document: its numbers come from _index.json (produced by the
// same headless run that validates the solver), and its body embeds the per-case
// `<slug>.es.md` / `<slug>.md` verbatim, so it can never drift from the code.
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const ROOT = process.cwd();
const VDIR = 'docs/verifications';
const NOPDF = process.argv.includes('--no-pdf');
const index = JSON.parse(fs.readFileSync(path.join(ROOT, VDIR, '_index.json'), 'utf8'))
  .sort((a, b) => a.id.localeCompare(b.id));

// ── i18n: the two language variants share one structure, differ only in strings ──
const L = {
  es: {
    ext: 'es.md',
    title: 'Manual de Verificación',
    subtitle: 'portico-core — validación del motor de análisis estructural',
    tocMethod: 'Metodología', tocSummary: 'Resumen de resultados', tocRepro: 'Reproducibilidad',
    intro: `Este manual reúne los **casos de verificación** con los que se contrasta el motor de
análisis de **portico-core** contra soluciones **analíticas**, **referencias publicadas** y dos
motores establecidos: **SAP2000** (valores publicados por CSI) y **OpenSees** (corridas
independientes en OpenSeesPy). Cada caso construye un modelo a mano, lo resuelve de forma
**headless** (sin interfaz), y compara el resultado contra la referencia.`,
    method: `## Metodología

**Contra qué se compara.** Cada caso reporta hasta tres referencias:

- **Analítica / publicada** — solución cerrada (Euler, elástica, teoría de vigas…) o valor de una
  referencia de literatura (Cook & Young, Bathe & Wilson, CSI, etc.).
- **SAP2000** — valor publicado por CSI para el **mismo tipo de elemento**. Es la comparación
  *apples-to-apples*: aísla el comportamiento del elemento del error de modelado.
- **OpenSees** — segunda opinión de un motor independiente, ejecutado en OpenSeesPy sobre un modelo
  traducido de forma **independiente** (no por el exportador de Pórtico).

**Criterio de aceptación.** El veredicto se toma contra **SAP2000** cuando está disponible (mismo
elemento), o contra la analítica en su defecto. Se considera **verificado** un error ≤ 5 %; en la
práctica la mayoría cae por debajo de 0.1 %.

**Cómo leer los estudios de elemento y convergencia.** Algunos casos no son "pasa/no pasa" sino
**estudios**: comparan familias de elementos o mallas. Ahí un elemento **básico** (p. ej. el QUAD
sin modos incompatibles, o el triángulo CST) se aleja **a propósito** de la teoría de vigas — es su
rigidez conocida (*shear locking*) —, mientras el elemento mejorado (Allman) o la malla refinada
**convergen**. En esos casos el número grande *vs teoría* es esperado; lo que se verifica es que
Pórtico reproduce el **mismo comportamiento que SAP2000** para el mismo elemento, y que la
**convergencia** ocurre. Se marcan como *estudio* en el resumen.

**Convenciones.** Coordenadas **Z-up** (como SAP2000/ETABS). Unidades por caso (se indican en cada
tabla). Modelos 2D con \`uy, rx, rz\` restringidos.`,
    summaryHead: '## Resumen de resultados',
    summaryIntro: sprintf =>
`Los ${sprintf} casos que componen esta edición del manual. «vs SAP» es el error relativo máximo
contra el valor publicado de SAP2000 para el mismo elemento; «vs Analít.» contra la solución
cerrada / referencia; «vs OpenSees» es la diferencia relativa máxima contra la corrida independiente
de OpenSees (adimensional).`,
    thCase: 'Caso', thTitle: 'Título', thRef: 'Referencia', thSap: 'vs SAP', thAn: 'vs Analít.',
    thOs: 'vs OpenSees', thVerdict: 'Veredicto',
    verifOk: '✓ verificado', study: '△ estudio',
    catN: { '1': 'Barras, pórticos y dinámica', '2': 'Placas y flexión de losas',
            '3': 'Membrana, tensión/deformación plana y malla', '4': 'Diseño de secciones (multinorma)' },
    casesHead: '## Casos de verificación',
    repro: `## Reproducibilidad

Todo el manual se **regenera desde el código** — sus números provienen de la misma corrida headless
que valida el solver:

\`\`\`bash
node tools/run_verifs.mjs              # corre los casos → docs/verifications/_index.json + figuras + PDFs
node tools/build_verification_manual.mjs   # ensambla este manual (ES + EN) + PDF
\`\`\`

Los casos viven en \`tools/verif/cases/*.mjs\` (metadatos + extractores) y los modelos en
\`examples/verif_*.s3d\`. La segunda opinión de **OpenSees** se produce con
\`tools/verif/opensees/run_case.py\` (entorno conda con OpenSeesPy) y se cachea en
\`tools/verif/opensees/results/*.json\`.`,
    generated: 'Generado automáticamente por `tools/build_verification_manual.mjs` — no editar a mano.',
  },
  en: {
    ext: 'md',
    title: 'Verification Manual',
    subtitle: 'portico-core — validation of the structural analysis engine',
    tocMethod: 'Methodology', tocSummary: 'Results summary', tocRepro: 'Reproducibility',
    intro: `This manual collects the **verification cases** that check the **portico-core** analysis
engine against **analytical** solutions, **published references**, and two established engines:
**SAP2000** (values published by CSI) and **OpenSees** (independent OpenSeesPy runs). Each case
builds a model by hand, solves it **headless** (no UI), and compares the result against the reference.`,
    method: `## Methodology

**What is compared against.** Each case reports up to three references:

- **Analytical / published** — a closed-form solution (Euler, elastica, beam theory…) or a value from
  a literature reference (Cook & Young, Bathe & Wilson, CSI, etc.).
- **SAP2000** — the value CSI publishes for the **same element type**. This is the apples-to-apples
  comparison: it isolates the element behaviour from modelling error.
- **OpenSees** — a second opinion from an independent engine, run in OpenSeesPy on a model translated
  **independently** (not by Pórtico's own exporter).

**Acceptance criterion.** The verdict is taken against **SAP2000** where available (same element), or
against the analytical value otherwise. A relative error ≤ 5 % is considered **verified**; in
practice most cases fall below 0.1 %.

**Reading the element and convergence studies.** Some cases are not pass/fail but **studies** that
compare element families or meshes. There a **basic** element (e.g. the QUAD without incompatible
modes, or the CST triangle) departs from beam theory **on purpose** — that is its known stiffness
(*shear locking*) — while the improved element (Allman) or the refined mesh **converge**. In those
cases the large number *vs theory* is expected; what is verified is that Pórtico reproduces the
**same behaviour as SAP2000** for the same element, and that **convergence** happens. They are
flagged as *study* in the summary.

**Conventions.** **Z-up** coordinates (like SAP2000/ETABS). Units per case (stated in each table).
2D models restrain \`uy, rx, rz\`.`,
    summaryHead: '## Results summary',
    summaryIntro: sprintf =>
`The ${sprintf} cases in this edition of the manual. "vs SAP" is the maximum relative error against
SAP2000's published value for the same element; "vs Anal." against the closed-form / reference; "vs
OpenSees" is the maximum relative difference against the independent OpenSees run (dimensionless).`,
    thCase: 'Case', thTitle: 'Title', thRef: 'Reference', thSap: 'vs SAP', thAn: 'vs Anal.',
    thOs: 'vs OpenSees', thVerdict: 'Verdict',
    verifOk: '✓ verified', study: '△ study',
    catN: { '1': 'Frames, portals and dynamics', '2': 'Plates and slab bending',
            '3': 'Membrane, plane stress/strain and meshing', '4': 'Section design (multi-code)' },
    casesHead: '## Verification cases',
    repro: `## Reproducibility

The whole manual is **regenerated from code** — its numbers come from the same headless run that
validates the solver:

\`\`\`bash
node tools/run_verifs.mjs              # runs the cases → docs/verifications/_index.json + figures + PDFs
node tools/build_verification_manual.mjs   # assembles this manual (ES + EN) + PDF
\`\`\`

The cases live in \`tools/verif/cases/*.mjs\` (metadata + extractors) and the models in
\`examples/verif_*.s3d\`. The **OpenSees** second opinion is produced by
\`tools/verif/opensees/run_case.py\` (conda environment with OpenSeesPy) and cached in
\`tools/verif/opensees/results/*.json\`.`,
    generated: 'Auto-generated by `tools/build_verification_manual.mjs` — do not edit by hand.',
  },
};

const pctTxt = v => v == null ? '—' : (v < 0.005 ? '0 %' : `${v.toFixed(2)} %`);
const osTxt = v => v == null ? '—' : v.toExponential(1);
// Verdict: primary reference = SAP2000 (same element) where present, else analytical.
const verdictVal = c => c.maxVsSap != null ? c.maxVsSap : c.maxDiff;

// Embed a per-case markdown: strip its H1 + language switcher, demote headings by +2,
// and fix the relative paths (case docs live one level deeper than the manual).
function embedCase(slug, ext) {
  const p = path.join(ROOT, VDIR, `${slug}.${ext}`);
  if (!fs.existsSync(p)) return null;
  let md = fs.readFileSync(p, 'utf8');
  const lines = md.split('\n');
  const out = [];
  for (let ln of lines) {
    if (/^# (Verificación|Verification) /.test(ln)) continue;            // drop the case H1
    if (/^\[(English|Español)\]\(.*\) · \*\*(Español|English)\*\*\s*$/.test(ln)) continue;  // drop switcher
    if (/^#{2,5} /.test(ln)) ln = ln.replace(/^#+/, m => '#'.repeat(Math.min(6, m.length + 2)));  // demote
    ln = ln.replace(/\]\(img\//g, '](verifications/img/').replace(/\]\(\.\.\/\.\.\//g, '](../');    // fix paths
    out.push(ln);
  }
  return out.join('\n').trim();
}

function buildManual(lang) {
  const t = L[lang];
  const parts = [];
  parts.push(`# ${t.title}\n`);
  parts.push(lang === 'es' ? `[English](verification-manual.md) · **Español**\n` : `**English** · [Español](verification-manual.es.md)\n`);
  parts.push(`*${t.subtitle}*  \nportico-core · v0.2.0\n`);
  parts.push('---\n');
  parts.push(t.intro + '\n');
  parts.push(t.method + '\n');

  // Summary table
  parts.push(t.summaryHead + '\n');
  parts.push(t.summaryIntro(index.length) + '\n');
  const head = [t.thCase, t.thTitle, t.thRef, t.thSap, t.thAn, t.thOs, t.thVerdict];
  const rows = index.map(c => {
    const v = verdictVal(c);
    const verdict = v <= 5 ? t.verifOk : t.study;
    const refShort = (c.referenceText || '').replace(/\*/g, '').split(';')[0].replace(/\.\s*$/, '').slice(0, 52);
    return [c.id, c.title.replace(/\|/g, '\\|'), refShort, pctTxt(c.maxVsSap), pctTxt(c.maxDiff), osTxt(c.osDiff), verdict];
  });
  parts.push(`| ${head.join(' | ')} |\n| ${head.map(() => '---').join(' | ')} |\n`
    + rows.map(r => `| ${r.join(' | ')} |`).join('\n') + '\n');

  // Cases grouped by category
  parts.push(t.casesHead + '\n');
  const byCat = {};
  for (const c of index) (byCat[c.id[0]] ??= []).push(c);
  for (const k of Object.keys(byCat).sort()) {
    parts.push(`### ${t.catN[k] || k}\n`);
    for (const c of byCat[k]) {
      const body = embedCase(c.slug, t.ext);
      parts.push(`#### ${c.id} — ${c.title}\n`);
      parts.push(body ? body + '\n' : `_(caso ${c.slug} sin documento ${t.ext})_\n`);
      parts.push('---\n');
    }
  }

  parts.push(t.repro + '\n');
  parts.push(`\n<sub>${t.generated}</sub>\n`);

  const outPath = path.join(ROOT, 'docs', `verification-manual.${t.ext}`);
  fs.writeFileSync(outPath, parts.join('\n'), 'utf8');
  console.log(`✓ ${path.relative(ROOT, outPath)}  (${index.length} casos, ${parts.join('\n').length} chars)`);
  return outPath;
}

const esPath = buildManual('es');
const enPath = buildManual('en');

if (!NOPDF) {
  for (const p of [esPath, enPath]) {
    try { execFileSync('node', ['tools/md2pdf.mjs', path.relative(ROOT, p), '--membrete', 'PÓRTICO — Manual de Verificación'], { cwd: ROOT, stdio: 'ignore' });
      console.log(`✓ ${path.relative(ROOT, p).replace(/\.md$/, '.pdf')}`);
    } catch (e) { console.error(`✗ PDF ${p}: ${e.message}`); }
  }
}
console.log('Listo.');
