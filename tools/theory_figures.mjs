// theory_figures.mjs — headless figures for the Analysis Reference (Theory) Manual.
// Builds small representative models and renders them with tools/verif/figure.mjs
// (which draws area meshes as filled polygons, so membrane / plate / shell elements
// show their MESH, not just the corner nodes). Also emits a couple of hand-drawn
// schematic SVGs (element local axes, DOF numbering, Z-up triad) written inline.
//   node tools/theory_figures.mjs
import fs from 'fs';
import path from 'path';
import { Model } from '../js/model/model.js';
import { renderModelSVG } from './verif/figure.mjs';

const OUT = 'docs/theory/img';
fs.mkdirSync(path.join(process.cwd(), OUT), { recursive: true });
const write = (name, svg) => { fs.writeFileSync(path.join(process.cwd(), OUT, name), svg, 'utf8'); console.log('✓', `${OUT}/${name}`); };

// Model → renderModelSVG inputs (nodes Map, line elements, area polygons, supports).
function toRender(model, opts = {}) {
  const nodes = new Map();
  for (const n of model.nodes.values()) nodes.set(n.id, [n.x, n.y, n.z]);
  const elements = [...model.elements.values()].map(e => ({ n1: e.n1, n2: e.n2 }));
  const areas = [...(model.areas?.values?.() || [])].map(a => a.nodes).filter(ns => ns && ns.length >= 3);
  const supports = new Set([...model.nodes.values()]
    .filter(n => { const r = n.restraints || {}; return r.ux || r.uy || r.uz; }).map(n => n.id));
  // No embedded caption: the SVG stays language-neutral (the caption text lives in the
  // per-language markdown, so the same figure serves both the EN and ES manuals without
  // mixing languages inside the image).
  return renderModelSVG({ nodes, elements, areas, supports, width: opts.width || 620 });
}

// ── 1) Portal frame (line elements) ─────────────────────────────────────────
function framePortal() {
  const m = new Model(); m.materials.clear(); m.sections.clear();
  const mat = m.addMaterial({ name: 'S', E: 2e8, G: 8e7, nu: 0.3, rho: 0 });
  const sec = m.addSection({ name: 'B', A: 0.01, Iy: 1e-4, Iz: 1e-4, J: 1e-5 });
  const H = 3, B = 5, bays = 2, storeys = 2;
  const nid = [];
  for (let s = 0; s <= storeys; s++) for (let b = 0; b <= bays; b++)
    nid[s * (bays + 1) + b] = m.addNode(b * B, 0, s * H, s === 0 ? { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 } : {}).id;
  for (let s = 0; s < storeys; s++) for (let b = 0; b <= bays; b++)            // columns
    m.addElement(nid[s * (bays + 1) + b], nid[(s + 1) * (bays + 1) + b], mat.id, sec.id);
  for (let s = 1; s <= storeys; s++) for (let b = 0; b < bays; b++)           // beams
    m.addElement(nid[s * (bays + 1) + b], nid[s * (bays + 1) + b + 1], mat.id, sec.id);
  write('frame-portal.svg', toRender(m, { caption: 'Frame model — 12-DOF line elements (columns + beams)' }));
}

// ── 2) Membrane shear wall (vertical XZ plane) meshed into QUADs ─────────────
function membraneWall() {
  const m = new Model(); m.mode = '3D'; m.materials.clear(); m.sections.clear();
  const mat = m.addMaterial({ name: 'C', E: 2.5e7, G: 1e7, nu: 0.2, rho: 0 });
  const W = 4, Hh = 6, NX = 4, NZ = 6, id = [];
  for (let j = 0; j <= NZ; j++) for (let i = 0; i <= NX; i++)
    id[j * (NX + 1) + i] = m.addNode((i / NX) * W, 0, (j / NZ) * Hh, j === 0 ? { ux: 1, uy: 1, uz: 1 } : {}).id;
  for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++)
    m.addArea([id[j * (NX + 1) + i], id[j * (NX + 1) + i + 1], id[(j + 1) * (NX + 1) + i + 1], id[(j + 1) * (NX + 1) + i]],
      mat.id, { thickness: 0.25, behavior: 'membrane' });
  write('membrane-wall.svg', toRender(m, { caption: 'Membrane (plane-stress) shear wall — 4×6 QUAD mesh' }));
}

// ── 3) Plate slab (horizontal XY plane) meshed into QUADs ────────────────────
function plateSlab() {
  const m = new Model(); m.mode = '3D'; m.materials.clear(); m.sections.clear();
  const mat = m.addMaterial({ name: 'C', E: 2.5e7, G: 1e7, nu: 0.2, rho: 0 });
  const A = 5, N = 6, id = [];
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
    const edge = i === 0 || i === N || j === 0 || j === N;
    id[j * (N + 1) + i] = m.addNode((i / N) * A, (j / N) * A, 0, edge ? { uz: 1 } : {}).id;
  }
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++)
    m.addArea([id[j * (N + 1) + i], id[j * (N + 1) + i + 1], id[(j + 1) * (N + 1) + i + 1], id[(j + 1) * (N + 1) + i]],
      mat.id, { thickness: 0.2, behavior: 'plate' });
  write('plate-slab.svg', toRender(m, { caption: 'Plate (bending) slab — 6×6 QUAD mesh, simply supported edges' }));
}

// ── 4) Shell — a pitched (folded) roof, QUADs in 3D → membrane+plate ─────────
function shellRoof() {
  const m = new Model(); m.mode = '3D'; m.materials.clear(); m.sections.clear();
  const mat = m.addMaterial({ name: 'C', E: 2.5e7, G: 1e7, nu: 0.2, rho: 0 });
  const span = 6, len = 8, rise = 2, N = 4, NL = 5, id = [];
  for (let l = 0; l <= NL; l++) for (let i = 0; i <= 2 * N; i++) {
    const x = (i / (2 * N)) * span;
    const z = rise * (1 - Math.abs((i - N) / N));   // ridge in the middle
    id[l * (2 * N + 1) + i] = m.addNode(x, (l / NL) * len, z, (i === 0 || i === 2 * N) ? { ux: 1, uy: 1, uz: 1 } : {}).id;
  }
  for (let l = 0; l < NL; l++) for (let i = 0; i < 2 * N; i++)
    m.addArea([id[l * (2 * N + 1) + i], id[l * (2 * N + 1) + i + 1], id[(l + 1) * (2 * N + 1) + i + 1], id[(l + 1) * (2 * N + 1) + i]],
      mat.id, { thickness: 0.15, behavior: 'shell' });
  write('shell-roof.svg', toRender(m, { width: 680, caption: 'Shell (membrane+plate) — folded roof, QUAD mesh in 3D' }));
}

framePortal();
membraneWall();
plateSlab();
shellRoof();
console.log('Listo.');
