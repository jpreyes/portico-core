// ──────────────────────────────────────────────────────────────────────────────
// profiles.js — CATALOG of tabulated commercial profiles (#66).
//
// Library of standard profiles (European IPE, HEA, HEB I-shapes; typical pipes and
// boxes) with their nominal DIMENSIONS. Section properties (A, I, S, Z, J, Cw…) are
// derived from the shape with `section_props.fromShape`, so the catalog gives
// normalized NAMES + exact geometry and the design uses consistent plastic moduli /
// slendernesses (without the error of an equivalent rectangle).
//
// Note: the dimensions are nominal (without web-flange fillet radii), so A and I come
// out ~1–3 % below the tabulated rounded values (conservative side for design).
// Dimensions in METERS when exposed.
// ──────────────────────────────────────────────────────────────────────────────

import { fromShape } from './section_props.js?v=5';

// [h, b, tw, tf] en mm.
const IPE = {
  IPE80: [80, 46, 3.8, 5.2], IPE100: [100, 55, 4.1, 5.7], IPE120: [120, 64, 4.4, 6.3],
  IPE140: [140, 73, 4.7, 6.9], IPE160: [160, 82, 5.0, 7.4], IPE180: [180, 91, 5.3, 8.0],
  IPE200: [200, 100, 5.6, 8.5], IPE220: [220, 110, 5.9, 9.2], IPE240: [240, 120, 6.2, 9.8],
  IPE270: [270, 135, 6.6, 10.2], IPE300: [300, 150, 7.1, 10.7], IPE330: [330, 160, 7.5, 11.5],
  IPE360: [360, 170, 8.0, 12.7], IPE400: [400, 180, 8.6, 13.5], IPE450: [450, 190, 9.4, 14.6],
  IPE500: [500, 200, 10.2, 16.0], IPE550: [550, 210, 11.1, 17.2], IPE600: [600, 220, 12.0, 19.0],
};
const HEA = {
  HEA100: [96, 100, 5.0, 8.0], HEA120: [114, 120, 5.0, 8.0], HEA140: [133, 140, 5.5, 8.5],
  HEA160: [152, 160, 6.0, 9.0], HEA180: [171, 180, 6.0, 9.5], HEA200: [190, 200, 6.5, 10.0],
  HEA220: [210, 220, 7.0, 11.0], HEA240: [230, 240, 7.5, 12.0], HEA260: [250, 260, 7.5, 12.5],
  HEA280: [270, 280, 8.0, 13.0], HEA300: [290, 300, 8.5, 14.0], HEA340: [330, 300, 9.5, 16.5],
  HEA400: [390, 300, 11.0, 19.0],
};
const HEB = {
  HEB100: [100, 100, 6.0, 10.0], HEB120: [120, 120, 6.5, 11.0], HEB140: [140, 140, 7.0, 12.0],
  HEB160: [160, 160, 8.0, 13.0], HEB180: [180, 180, 8.5, 14.0], HEB200: [200, 200, 9.0, 15.0],
  HEB220: [220, 220, 9.5, 16.0], HEB240: [240, 240, 10.0, 17.0], HEB260: [260, 260, 10.0, 17.5],
  HEB280: [280, 280, 10.5, 18.0], HEB300: [300, 300, 11.0, 19.0], HEB320: [320, 300, 11.5, 20.5],
  HEB360: [360, 300, 12.5, 22.5], HEB400: [400, 300, 13.5, 24.0],
};
// Circular pipes CHS [D, t] mm; boxes RHS/SHS [h, b, t] mm.
const CHS = { 'CHS 88.9x4': [88.9, 4], 'CHS 114.3x5': [114.3, 5], 'CHS 168.3x6': [168.3, 6], 'CHS 219.1x8': [219.1, 8] };
const RHS = { 'RHS 100x50x4': [100, 50, 4], 'RHS 150x100x6': [150, 100, 6], 'SHS 100x100x5': [100, 100, 5], 'SHS 150x150x8': [150, 150, 8] };

// Families → { name → { shape, dims(m) } }
function buildFamily(table, shape, keys) {
  const out = {};
  for (const [name, v] of Object.entries(table)) {
    const dims = {};
    keys.forEach((k, i) => { dims[k] = v[i] / 1000; });
    out[name] = { shape, dims };
  }
  return out;
}

export const CATALOG = {
  IPE: buildFamily(IPE, 'I', ['d', 'bf', 'tw', 'tf']),
  HEA: buildFamily(HEA, 'I', ['d', 'bf', 'tw', 'tf']),
  HEB: buildFamily(HEB, 'I', ['d', 'bf', 'tw', 'tf']),
  CHS: buildFamily(CHS, 'pipe', ['D', 't']),
  'RHS/SHS': buildFamily(RHS, 'box', ['h', 'b', 't']),
};

// List of names per family (to populate a <select>).
export function catalogFamilies() { return Object.keys(CATALOG); }
export function catalogNames(family) { return CATALOG[family] ? Object.keys(CATALOG[family]) : []; }

// Returns a profile definition { family, name, shape, dims } or null.
export function getProfile(name) {
  for (const fam of Object.keys(CATALOG)) if (CATALOG[fam][name]) return { family: fam, name, ...CATALOG[fam][name] };
  return null;
}

// Resolves a profile to model + design properties ready to assign to a section:
// { A, Iz, Iy, J, design:{ shape, dims } } (all in m / m² / m⁴).
export function profileToSection(name) {
  const p = getProfile(name); if (!p) return null;
  const g = fromShape(p.shape, p.dims);
  if (!g) return null;
  return { A: g.A, Iz: g.Iz, Iy: g.Iy, J: g.J,
    Avy: g.Avz_web, Avz: g.Avy_flange,
    design: { shape: p.shape, dims: { ...p.dims }, profile: name } };
}
