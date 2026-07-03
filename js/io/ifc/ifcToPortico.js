// ──────────────────────────────────────────────────────────────────────────────
// io/ifc/ifcToPortico.js — IFC → PORTICO model (via the neutral model) · #76, G19
//
// Orchestrates loader + classifier + geometry to produce, in TWO separate steps:
//   1) analyzeIFC(text)  → `items`: one record per element (axis in global coords,
//      approximate section and material, level, status and warnings) WITHOUT touching
//      the model.  This is what feeds the table and side-by-side preview of the dialog (#77).
//   2) itemsToNeutral(items, selected) → `io/`'s NEUTRAL model with the chosen elements:
//      creates nodes with tolerance SNAP, deduplicates materials/sections and builds the
//      members.  The PORTICO model is built with `neutralToModel`.
//
// Axis convention: IFC and PORTICO share VERTICAL Z, so coordinates pass through directly
// (only unit conversion to meters).  STANDALONE (Node + browser).
// ──────────────────────────────────────────────────────────────────────────────
import { parseIFC, lengthUnit } from './ifcLoader.js?v=2';
import { classify, KIND_LABEL } from './ifcClassifier.js?v=2';
import { memberAxis, bodyProfile, profileProps, areaSurface, boxSectionProps } from './ifcGeometrySimplifier.js?v=2';
import { Warnings } from './ifcWarnings.js?v=2';
import { neutralToModel } from '../neutral.js?v=2';

const DEFAULT_TOL = 0.01;       // m — snap tolerance for coincident nodes
// generic material (steel) when the IFC carries no mechanical properties — kN/m²
const GENERIC = { E: 2.0e8, nu: 0.3, rho: 7.85, alpha: 1.2e-5 };

// ── material + profile resolution from the associated RelatingMaterial ────────────
function resolveMaterial(model, materialRef, mechE) {
  const out = { name: '', E: null, profile: null };
  let m = model.get(materialRef), guard = 0;
  while (m && guard++ < 8) {
    switch (m.type) {
      case 'IFCMATERIAL':
        out.name = out.name || (m.args[0] || '').toString();
        if (mechE.has(m.id)) out.E = mechE.get(m.id);
        return out;
      case 'IFCMATERIALLIST':
        m = model.get((m.args[0] || [])[0]); continue;
      case 'IFCMATERIALPROFILESETUSAGE':
        m = model.get(m.args[0]); continue;                 // ForProfileSet
      case 'IFCMATERIALPROFILESET':
        m = model.get((m.args[2] || [])[0]); continue;       // MaterialProfiles[0] (args: Name,Desc,Profiles,…)
      case 'IFCMATERIALPROFILE':                             // (Name, Desc, Material, Profile, …)
        if (m.args[3]) out.profile = m.args[3];              // the material name comes from IfcMaterial, not the profile
        m = model.get(m.args[2]); continue;                  // → IfcMaterial (name/E)
      case 'IFCMATERIALLAYERSETUSAGE':                        // areas: walls/slabs by layers
        m = model.get(m.args[0]); continue;                  // ForLayerSet
      case 'IFCMATERIALLAYERSET':
        m = model.get((m.args[0] || [])[0]); continue;       // MaterialLayers[0]
      case 'IFCMATERIALLAYER':
        m = model.get(m.args[0]); continue;                  // → IfcMaterial
      default:
        return out;                                          // layers (walls) or others → generic
    }
  }
  return out;
}

// map  materialId → E (kN/m²)  from IfcMechanicalMaterialProperties (IFC2x3)
function mechModulus(model) {
  const map = new Map();
  for (const p of model.ofType('IFCMECHANICALMATERIALPROPERTIES')) {
    // (Material, DynamicViscosity, YoungModulus[Pa], ShearModulus, PoissonRatio, ThermalExpansion)
    const mid = model.isRef(p.args[0]) ? p.args[0].ref : null;
    const Epa = +p.args[2] || 0;
    if (mid && Epa > 0) map.set(mid, Epa / 1000);            // Pa → kN/m²
  }
  return map;
}

/**
 * Analyzes a .ifc and produces the records of all elements (without building the model).
 * @param {string} text  contents of the .ifc
 * @param {object} [opts]  { tol }
 * @returns {{ schema, unit, levels, counts, items, warnings:Warnings }}
 */
export function analyzeIFC(text, opts = {}) {
  const model = parseIFC(text);
  const unit = lengthUnit(model);
  const { elements, levels, counts } = classify(model);
  const mechE = mechModulus(model);
  const levelName = new Map(levels.map(l => [l.id, l.name]));
  const W = new Warnings();

  const items = [];
  for (const el of elements) {
    const w = new Warnings();
    const item = {
      ifcId: el.id, ifcType: el.ifcType, kind: el.kind, kindLabel: KIND_LABEL[el.kind] || el.kind,
      supported: el.supported, isArea: !!el.isArea, name: el.name,
      levelName: el.storeyId != null ? (levelName.get(el.storeyId) || '—') : '—',
      segments: [], corners: null, thickness: 0, matName: '', E: null, secName: '', sec: null,
      status: 'unsupported', warnings: w,
    };

    if (!el.supported) {
      item.warnings.add(`${item.kindLabel} aún no soportado`);
      items.push(item); continue;
    }

    // material (common to members and areas)
    const setMaterial = () => {
      const mat = resolveMaterial(model, el.materialRef, mechE);
      item.matName = mat.name || 'Genérico (IFC)';
      if (mat.E && mat.E > 0) item.E = mat.E;
      else { item.E = GENERIC.E; w.add('Sin propiedades mecánicas: material genérico (acero)'); }
      return mat;
    };

    // ── AREA (wall/slab/plate): surface of 3–4 corners + thickness ──
    if (el.isArea) {
      const surf = areaSurface(model, model.get(el.id), el.kind, unit.factor, w);
      if (!surf || surf.corners.length < 3) { item.status = 'no-geom'; w.add('Sin geometría de superficie reconocible: no se puede importar'); items.push(item); continue; }
      item.corners = surf.corners;
      item.thickness = surf.thickness;
      item.areaKind = surf.via;
      setMaterial();
      item.secName = `e = ${(surf.thickness * 1000).toFixed(0)} mm`;
      item.status = 'ok';
      items.push(item); continue;
    }

    // geometry → axis/axes
    const axis = memberAxis(model, model.get(el.id), unit.factor, w);
    if (!axis || !axis.segments.length) { item.status = 'no-geom'; w.add('Sin geometría de eje reconocible: no se puede importar'); items.push(item); continue; }
    item.segments = axis.segments;

    // material
    const mat = setMaterial();

    // section: profile of the extruded solid, or the material's; failing that, for a
    // B-rep mesh, the bounding-box section from the axis fallback (rectangular, or
    // circular when the name/material hints at it, e.g. "perfil circular").
    let prof = bodyProfile(model, model.get(el.id)) || mat.profile;
    const sp = prof ? profileProps(model, prof, unit.factor, w) : null;
    if (sp) { item.sec = { A: sp.A, Iy: sp.Iy, Iz: sp.Iz, J: sp.J }; item.secName = sp.name; if (sp.approx) item.secApprox = true; }
    else if (axis.via === 'brep-obb' && axis.section) {
      const circular = /c[ií]rc|tub|pipe|ø|⌀/i.test(`${item.name} ${item.matName}`);
      const bx = boxSectionProps(axis.section.b, axis.section.h, circular);
      item.sec = { A: bx.A, Iy: bx.Iy, Iz: bx.Iz, J: bx.J }; item.secName = bx.name; item.secApprox = true;
    }
    else { item.secName = 'Genérica'; w.add('Sin sección reconocible: sección genérica'); }

    item.status = 'ok';
    items.push(item);
  }

  // global summary of warnings (grouped)
  for (const it of items) for (const m of it.warnings.list) W.add(m);

  return { schema: model.schema, unit, levels, counts, items, warnings: W };
}

// ── spatial node snap by tolerance (cell hash) ────────────────────────────────────
function makeSnapper(tol) {
  const nodes = [];                 // [ [x,y,z], … ]
  const grid = new Map();           // 'cx,cy,cz' → [idx, …]
  const cell = (p) => `${Math.round(p[0] / tol)},${Math.round(p[1] / tol)},${Math.round(p[2] / tol)}`;
  const t2 = tol * tol;
  return (p) => {
    const cx = Math.round(p[0] / tol), cy = Math.round(p[1] / tol), cz = Math.round(p[2] / tol);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const bucket = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
      if (!bucket) continue;
      for (const i of bucket) { const q = nodes[i], d0 = q[0] - p[0], d1 = q[1] - p[1], d2 = q[2] - p[2]; if (d0 * d0 + d1 * d1 + d2 * d2 <= t2) return i; }
    }
    const idx = nodes.length; nodes.push([p[0], p[1], p[2]]);
    const k = cell(p); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(idx);
    return idx;
  };
}

/**
 * Converts the SELECTED records (with status 'ok') into an `io/` neutral model.
 * @param {Array} items   records from `analyzeIFC`
 * @param {Set<number>} [selected]  chosen ifcIds; if omitted, all the 'ok' ones
 * @param {object} [opts]  { tol, name }
 * @returns {{ neutral, stats, warnings:string[] }}
 */
export function itemsToNeutral(items, selected = null, opts = {}) {
  const tol = opts.tol || DEFAULT_TOL;
  const snap = makeSnapper(tol);
  const warnings = [];

  const matKey = new Map(), materials = [];
  const secKey = new Map(), sections = [];
  const members = [], areas = [];
  const nodeCoords = [];   // filled at the end from the snapper

  // node accumulator: the snapper returns indices 0..N-1; we rebuild coords afterwards
  const usedNodes = new Map(); // idx → [x,y,z]
  const getNode = (p) => { const i = snap(p); if (!usedNodes.has(i)) usedNodes.set(i, p); return i; };

  let skipped = 0, skippedAreas = 0;
  for (const it of items) {
    if (it.status !== 'ok') continue;
    if (selected && !selected.has(it.ifcId)) continue;

    // material (dedupe by name+E) — common to members and areas
    const mk = `${it.matName}|${Math.round((it.E || GENERIC.E))}`;
    let mIdx = matKey.get(mk);
    if (mIdx == null) { mIdx = materials.length + 1; matKey.set(mk, mIdx); materials.push({ id: mIdx, name: it.matName, E: it.E || GENERIC.E, nu: GENERIC.nu, rho: GENERIC.rho, alpha: GENERIC.alpha }); }

    // ── AREA (wall/slab/plate) → membrane (wall) / shell (the rest) of 3–4 nodes ──
    if (it.corners && it.corners.length >= 3) {
      const ids = it.corners.map(p => getNode(p) + 1);
      const uniq = []; for (const id of ids) if (!uniq.includes(id)) uniq.push(id);   // collapses coincident corners
      const behavior = it.kind === 'wall' ? 'membrane' : 'shell';   // wall → in-plane; slab/plate/other → shell
      if (uniq.length >= 3 && uniq.length <= 4) areas.push({ id: areas.length + 1, nodes: uniq, mat: mIdx, thickness: it.thickness || 0.2, behavior });
      else skippedAreas++;
      continue;
    }

    // ── MEMBER → section + member(s) ──
    const s = it.sec;
    const sk = s ? `${it.secName}|${s.A.toExponential(4)}|${s.Iy.toExponential(4)}|${s.Iz.toExponential(4)}` : `gen|${it.secName}`;
    let sIdx = secKey.get(sk);
    if (sIdx == null) { sIdx = sections.length + 1; secKey.set(sk, sIdx); sections.push(s ? { id: sIdx, name: it.secName, A: s.A, Iy: s.Iy, Iz: s.Iz, J: s.J } : { id: sIdx, name: it.secName }); }

    for (const [pa, pb] of it.segments) {
      if (Math.hypot(pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]) < tol) { skipped++; continue; }
      const ni = getNode(pa) + 1, nj = getNode(pb) + 1;   // ids 1..N
      if (ni === nj) { skipped++; continue; }
      members.push({ id: members.length + 1, ni, nj, mat: mIdx, sec: sIdx, releases: Array(12).fill(0), beta: 0 });
    }
  }

  // nodes in index order
  const maxIdx = Math.max(-1, ...usedNodes.keys());
  for (let i = 0; i <= maxIdx; i++) {
    const c = usedNodes.get(i) || [0, 0, 0];
    nodeCoords.push({ id: i + 1, x: c[0], y: c[1], z: c[2], restraints: { ux: 0, uy: 0, uz: 0, rx: 0, ry: 0, rz: 0 }, mass: null });
  }

  if (skipped) warnings.push(`${skipped} tramo(s) de longitud ~0 descartado(s) tras el snap (tol ${tol} m)`);
  if (skippedAreas) warnings.push(`${skippedAreas} área(s) descartada(s): tras el snap no quedaron 3–4 esquinas distintas`);
  if (!members.length && !areas.length) warnings.push('No se generó ninguna barra ni área con la selección actual');

  const neutral = {
    units: { length: 'm', force: 'kN' },
    meta: { name: opts.name || 'IFC', source: 'ifc', warnings },
    nodes: nodeCoords, materials, sections, members, areas, loadCases: [],
  };
  return { neutral, stats: { nodes: nodeCoords.length, members: members.length, areas: areas.length, materials: materials.length, sections: sections.length }, warnings };
}

/** Shortcut: IFC text → PORTICO `Model` with ALL supported elements (for Node/tests). */
export function ifcToModel(text, opts = {}) {
  const { items, warnings } = analyzeIFC(text, opts);
  const { neutral, stats, warnings: w2 } = itemsToNeutral(items, null, opts);
  return { model: neutralToModel(neutral), stats, warnings: [...warnings.summary(), ...w2] };
}
