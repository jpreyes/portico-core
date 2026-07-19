// ──────────────────────────────────────────────────────────────────────────────
// autodesign.js — PRELIMINARY SIZING (#71) and DESIGN by auto-selection (#72).
//
// CENTRAL RULE (non-negotiable): the system NEVER invents profiles, cross-sections
// or sections; it only PICKS among the candidates handed to it (from the `profiles.js`
// catalog or from a list of model sections). If no candidate passes, it reports it
// clearly (best=null) and suggests widening the candidate set.
//
//  · predimensionar(...)  — BEFORE the analysis: simple engineering rules
//    (h≈L/n, section from approximate axial load…) → editable initial section.
//  · selectProfile(...) — AFTER the analysis: tries each candidate with the G15
//    verification engine and picks the BEST by score (not the first that passes):
//    D/C≤1, prefer D/C in a target band (0.75–0.90), minimize weight, prefer
//    repeated sections (continuity).
// ──────────────────────────────────────────────────────────────────────────────

import { checkElement } from './design.js?v=6';
import { profileToSection, catalogNames } from './profiles.js?v=6';
import { fromShape } from './section_props.js?v=6';

// Weight per meter (kg/m) = A·ρ. ρ may come in t/m³ (model convention, e.g. steel
// 7.85) or in kg/m³ (7850); it is normalized to kg/m³. Without ρ → 7850 (steel).
function weightPerM(sec, mat) {
  let rho = mat?.rho || mat?.density || 7.85;
  if (rho < 100) rho *= 1000;                 // t/m³ → kg/m³
  return (sec.A || 0) * rho;
}

/**
 * Auto-selection of the best candidate that passes (#72).
 * @param {object} o
 *   demands  { N, Vy, Vz, My, Mz, L }   design forces (combo envelope)
 *   candidates  [string] catalog names  |  [{name, sec}]  explicit sections
 *   mat      design material (with design.family/Fy/… and opt. rho)
 *   code     forced codeId (or null → default by family)
 *   member   { Lb, K, Cb, Cmy… } buckling/LTB parameters
 *   prefs    { dcMax=1.0, dcTarget=0.85, prefer=<name> (continuity),
 *              maxWidth, maxHeight (m): cross-sectional dimension limits (#84) }
 * @returns { best, feasible:[…], all:[…] }  each item {name, dc, ok, weight, governs, sec}
 */
export function selectProfile({ demands, candidates, mat, code, member, prefs = {} }) {
  const dcMax = prefs.dcMax ?? 1.0;
  const dcTarget = prefs.dcTarget ?? 0.85;
  const maxW = prefs.maxWidth, maxH = prefs.maxHeight;   // dimension limits (m), opt.
  const all = [];
  let dimExcluded = 0;   // candidates discarded for exceeding the dimension limit (#84)
  for (const cand of candidates) {
    const name = typeof cand === 'string' ? cand : cand.name;
    const sec = (typeof cand === 'string' || !cand.sec) ? profileToSection(name) : cand.sec;
    if (!sec) continue;
    // Dimension limit (#84): exclude those that don't fit BEFORE verifying (e.g.
    // only beams ≤ 20 cm wide for a formwork/wall of fixed thickness).
    const wh = sectionWH(sec);
    if ((maxW != null && wh.w != null && wh.w > maxW + 1e-9) ||
        (maxH != null && wh.h != null && wh.h > maxH + 1e-9)) { dimExcluded++; continue; }
    let r;
    try { r = checkElement({ forces: demands, sec, mat, codeId: code, member }); }
    catch (e) { continue; }
    all.push({ name, dc: r.ratioMax, ok: Number.isFinite(r.ratioMax) && r.ratioMax <= dcMax,
      weight: weightPerM(sec, mat), governs: r.governs, sec });
  }
  all.sort((a, b) => a.weight - b.weight);
  const feasible = all.filter(r => r.ok);
  // Score (minimize): weight × penalty for straying from the target D/C; bonus for
  // continuity (same profile as the neighbor) and for not over-sizing (low D/C).
  const score = r => {
    let s = r.weight * (1 + 0.6 * Math.abs(r.dc - dcTarget));
    if (prefs.prefer && r.name === prefs.prefer) s *= 0.92;   // prefer the repeated one
    return s;
  };
  const ranked = feasible.slice().sort((a, b) => score(a) - score(b));
  // Note: distinguish "none by dimensions" from "none by strength" (#84).
  const lim = [maxW != null ? `ancho ≤ ${(maxW * 100).toFixed(0)} cm` : null,
               maxH != null ? `alto ≤ ${(maxH * 100).toFixed(0)} cm` : null].filter(Boolean).join(' · ');
  let note = '';
  if (!ranked.length) {
    if (!all.length && dimExcluded) note = `Ningún candidato respeta el límite de dimensiones (${lim}); afloje el límite o agregue candidatos más esbeltos.`;
    else { note = 'Ningún candidato ok D/C≤1; amplíe el conjunto de candidatos o revise las cargas.';
           if (dimExcluded) note += ` (${dimExcluded} candidato(s) excluido(s) por el límite ${lim}.)`; }
  }
  return { best: ranked[0] || null, feasible: ranked, all, dimExcluded, note };
}

// Cross-sectional dimensions (width w, height h) of a design section, in meters,
// from its shape+dims; used by the auto-design dimension limit (#84).
function sectionWH(sec) {
  const d = sec?.design?.dims || {};
  const shape = sec?.design?.shape;
  if (shape === 'I') return { w: d.bf, h: d.d };
  if (shape === 'pipe' || shape === 'circle') { const D = d.D ?? d.d; return { w: D, h: D }; }
  if (shape === 'box') return { w: d.b, h: d.h };
  // rect, C/L/T and the rest: use b/h from the dims or from sec itself.
  return { w: d.b ?? sec?.b, h: d.h ?? sec?.h };
}

// Set of steel candidates from the catalog by families.
export function steelCandidates(families = ['IPE', 'HEA', 'HEB']) {
  const out = [];
  for (const f of families) for (const n of catalogNames(f)) out.push(n);
  return out;
}

// Candidate {name, sec} of a rectangular section with solver props from the shape.
function rectCandidate(b, h, rebar, label) {
  const g = fromShape('rect', { b, h });
  return { name: label, sec: { A: g.A, Iz: g.Iz, Iy: g.Iy, J: g.J, b, h, Avy: g.Avz_web, Avz: g.Avy_flange,
    design: { shape: 'rect', dims: { b, h }, ...(rebar ? { rebar } : {}) } } };
}

// CONCRETE candidates: square and rectangular (cm) with reinforcement ratio ρ and cover.
export function concreteCandidates({ rho = 0.012, cover_mm = 40, min = 0.20, max = 0.80, step = 0.05, rect = true } = {}) {
  const out = []; const reb = { rho, cover_mm }; const r2 = v => Math.round(v * 100);
  for (let a = min; a <= max + 1e-9; a += step) {
    a = +a.toFixed(3);
    out.push(rectCandidate(a, a, reb, `H.A. ${r2(a)}×${r2(a)}`));
    if (rect) { const h = +(a * 1.5).toFixed(3); if (h <= max + 1e-9) out.push(rectCandidate(a, h, reb, `H.A. ${r2(a)}×${r2(h)}`)); }
  }
  return out;
}

// TIMBER candidates: typical cross-sections (b×h, cm).
export function timberCandidates({ bs = [0.05, 0.075, 0.10, 0.15], hs = [0.10, 0.15, 0.20, 0.25, 0.30, 0.40] } = {}) {
  const out = []; const r2 = v => Math.round(v * 100);
  for (const b of bs) for (const h of hs) if (h >= b) out.push(rectCandidate(b, h, null, `Mad ${r2(b)}×${r2(h)}`));
  return out;
}

// Candidates by material family (multi-code auto-design #72).
export function candidatesForFamily(family, prefs = {}) {
  if (family === 'concrete') return concreteCandidates(prefs.concrete || {});
  if (family === 'timber') return timberCandidates(prefs.timber || {});
  return steelCandidates(prefs.steelFamilies || ['IPE', 'HEA', 'HEB']);   // steel/aluminum
}

// ── Preliminary sizing (#71): simple rules BEFORE the analysis ───────────────────
// Returns { shape, dims, nota } or, for steel, { profile, nota } (catalog name).
// tipo: 'viga'|'columna' · material: 'steel'|'concrete'|'timber'
//   L  span (m) · q distributed load (kN/m, beams) · N axial (kN, columns) ·
//   fc (MPa, concrete) · H column height (m).
export function predimensionar({ tipo = 'viga', material = 'steel', L = 5, q = 10, N = 100, fc = 25, H = 3 } = {}) {
  if (material === 'steel') {
    if (tipo === 'viga') {
      // depth ≈ L/20 (typical steel beam). Picks the IPE with depth immediately ≥.
      const dObj = L / 20;
      const ipe = catalogNames('IPE').map(profileToSectionNamed).filter(Boolean)
        .sort((a, b) => a.sec.design.dims.d - b.sec.design.dims.d);
      const pick = ipe.find(p => p.sec.design.dims.d >= dObj) || ipe[ipe.length - 1];
      return { profile: pick?.name, shape: 'I', dims: pick?.sec.design.dims, nota: `viga acero: canto objetivo ≈ L/20 = ${(dObj * 1000).toFixed(0)} mm → ${pick?.name}` };
    }
    // steel column: HE with side ≈ H/15 (reasonable slenderness).
    const dObj = H / 15;
    const he = catalogNames('HEB').map(profileToSectionNamed).filter(Boolean)
      .sort((a, b) => a.sec.design.dims.d - b.sec.design.dims.d);
    const pick = he.find(p => p.sec.design.dims.d >= dObj) || he[0];
    return { profile: pick?.name, shape: 'I', dims: pick?.sec.design.dims, nota: `columna acero: lado ≈ H/15 = ${(dObj * 1000).toFixed(0)} mm → ${pick?.name}` };
  }
  if (material === 'concrete') {
    if (tipo === 'viga') {
      // h≈L/11 (constructive, rounded to 5 cm), b≈h/2 (min 0.20 m).
      let h = Math.ceil((L / 11) / 0.05) * 0.05; h = Math.max(h, 0.25);
      let b = Math.max(Math.ceil((h / 2) / 0.05) * 0.05, 0.20);
      return { shape: 'rect', dims: { b, h }, nota: `viga H.A.: h≈L/11=${(h * 100).toFixed(0)} cm, b≈h/2=${(b * 100).toFixed(0)} cm` };
    }
    // concrete column: Ag ≈ N/(0.35·f'c) (compression pre-design); square rounded to 5 cm.
    const Ag = Math.abs(N) / (0.35 * fc * 1000);   // N in kN, fc MPa→kN/m²
    let a = Math.ceil(Math.sqrt(Ag) / 0.05) * 0.05; a = Math.max(a, 0.25);
    return { shape: 'rect', dims: { b: a, h: a }, nota: `columna H.A.: Ag≈N/(0.35·f'c) → ${(a * 100).toFixed(0)}×${(a * 100).toFixed(0)} cm` };
  }
  // timber: cross-section from deflection (h≈L/17), rounded to 25 mm, b≈h/3.
  let h = Math.ceil((L / 17) / 0.025) * 0.025; h = Math.max(h, 0.10);
  let b = Math.max(Math.ceil((h / 3) / 0.025) * 0.025, 0.05);
  return { shape: 'rect', dims: { b, h }, nota: `madera: h≈L/17=${(h * 1000).toFixed(0)} mm, b≈h/3=${(b * 1000).toFixed(0)} mm` };
}

function profileToSectionNamed(name) { const sec = profileToSection(name); return sec ? { name, sec } : null; }
