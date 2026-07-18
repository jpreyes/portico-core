// build_theory_manual.mjs — regenerate the Analysis Reference (Theory) Manual end to end:
// its figures (language-neutral SVGs) and both language PDFs, each with a letterhead in
// its own language so the two documents never mix languages.
//   node tools/build_theory_manual.mjs [--no-pdf]
import { execFileSync } from 'child_process';

const NOPDF = process.argv.includes('--no-pdf');
const run = (args) => execFileSync('node', args, { stdio: 'inherit' });

// 1) Figures (caption-free; captions live in each manual's markdown).
run(['tools/theory_figures.mjs']);

if (NOPDF) { console.log('Listo (sin PDF).'); process.exit(0); }

// 2) One PDF per language, each with a same-language letterhead.
const editions = [
  { md: 'docs/analysis-reference.md',    membrete: 'PORTICO — 3D structural analysis' },
  { md: 'docs/analysis-reference.es.md', membrete: 'PÓRTICO — Análisis estructural 3D' },
];
for (const e of editions) {
  run(['tools/md2pdf.mjs', e.md, '--logos', 'icons/icon.svg', '--membrete', e.membrete]);
}
console.log('Listo.');
