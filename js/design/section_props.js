// ──────────────────────────────────────────────────────────────────────────────
// section_props.js — Section properties for element DESIGN.
//
// Given the shape and dimensions of a section, computes EVERYTHING the design codes
// (AISC 360, Eurocode 3, ACI 318…) need and that the generic solver section
// (A, Iy, Iz, J) does not provide: elastic moduli S, PLASTIC moduli Z, radii of
// gyration r, warping constant Cw, shear areas Av and wall slenderness ratios
// (b/t, h/tw) to classify the section.
//
// Axis convention (same as the solver): z = STRONG axis (major), y = WEAK axis
// (minor). Model units: meters. All lengths in m, A in m², I in m⁴.
//
// Supported shapes (shape):
//   'I'      — double T / bisymmetric I profile: { d, bf, tf, tw }
//   'rect'   — solid rectangle:                  { b, h }   (h = depth, strong axis)
//   'circle' — solid circle:                     { D }
//   'pipe'   — circular tube (hollow):           { D, t }
//   'box'    — rectangular tube (hollow):        { b, h, t }
//   'generic'— only A, Iy, Iz known → equivalent rectangle (Pórtico's historical
//              behavior). Z = shapeFactor·S.
//
// Any property can be explicitly overridden in sec.design (e.g. give the tabulated
// Zz/Cw of a real profile). For A, Iy, Iz, J the value of the model section (what
// the solver sees) is ALWAYS preferred when it exists, so that analysis and design
// stay consistent.
// ──────────────────────────────────────────────────────────────────────────────

import { polygonProps } from './polygon_props.js?v=3';

// St. Venant torsion of a solid rectangle (long side a, short side b).
function rectJ(a, b) {
  if (b <= 0) return 0;
  const [L, W] = a >= b ? [a, b] : [b, a];
  return L * W ** 3 * (1 / 3 - 0.21 * (W / L) * (1 - (W / L) ** 4 / 12));
}

// ── Properties of a COMPOSITE OF RECTANGLES (for C, L, T, …) ─────────────────────
// rects: [{x0,x1,y0,y1}] (m). Computes A, centroid (cx,cy), centroidal inertias
// Iz=∫(y−cy)²dA (strong axis horizontal) and Iy=∫(x−cx)²dA, elastic moduli at the
// extreme fiber and PLASTIC moduli Zz/Zy (plastic neutral axis = line that splits
// the area in halves, found by bisection + analytic integral of the moment |·|).
function rectsProps(rects) {
  let A = 0, Sx = 0, Sy = 0;
  for (const r of rects) { const a = (r.x1 - r.x0) * (r.y1 - r.y0); A += a; Sx += a * (r.x0 + r.x1) / 2; Sy += a * (r.y0 + r.y1) / 2; }
  const cx = Sx / A, cy = Sy / A;
  let Iz = 0, Iy = 0, xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (const r of rects) {
    const w = r.x1 - r.x0, h = r.y1 - r.y0, a = w * h;
    const rx = (r.x0 + r.x1) / 2 - cx, ry = (r.y0 + r.y1) / 2 - cy;
    Iz += w * h ** 3 / 12 + a * ry * ry;        // bending about z (horizontal): integrates y²
    Iy += h * w ** 3 / 12 + a * rx * rx;        // bending about y (vertical):   integrates x²
    xmin = Math.min(xmin, r.x0); xmax = Math.max(xmax, r.x1);
    ymin = Math.min(ymin, r.y0); ymax = Math.max(ymax, r.y1);
  }
  // Area on one side of a horizontal cut y=yc / vertical cut x=xc.
  const areaBelowY = yc => { let s = 0; for (const r of rects) { const lo = Math.min(Math.max(yc, r.y0), r.y1); s += (r.x1 - r.x0) * (lo - r.y0); } return s; };
  const areaLeftX = xc => { let s = 0; for (const r of rects) { const lo = Math.min(Math.max(xc, r.x0), r.x1); s += (r.y1 - r.y0) * (lo - r.x0); } return s; };
  const bisect = (f, lo, hi, target) => { for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; (f(m) < target ? lo = m : hi = m); } return (lo + hi) / 2; };
  const yp = bisect(areaBelowY, ymin, ymax, A / 2);
  const xp = bisect(areaLeftX, xmin, xmax, A / 2);
  // ∫|y−yp| dA and ∫|x−xp| dA (plastic moment = plastic modulus).
  const seg = (a, b, p, w) => {                 // ∫_a^b |t−p|·w dt
    if (p <= a) return w * ((b * b - a * a) / 2 - p * (b - a));
    if (p >= b) return w * (p * (b - a) - (b * b - a * a) / 2);
    const left = w * (p * (p - a) - (p * p - a * a) / 2);
    const right = w * ((b * b - p * p) / 2 - p * (b - p));
    return left + right;
  };
  let Zz = 0, Zy = 0;
  for (const r of rects) { Zz += seg(r.y0, r.y1, yp, r.x1 - r.x0); Zy += seg(r.x0, r.x1, xp, r.y1 - r.y0); }
  const Sz = Iz / Math.max(ymax - cy, cy - ymin);
  const SyV = Iy / Math.max(xmax - cx, cx - xmin);
  return { A, cx, cy, Iz, Iy, Sz, Sy: SyV, Zz, Zy, xmin, xmax, ymin, ymax, h: ymax - ymin, b: xmax - xmin };
}

// Computes the geometric properties from the shape and dimensions.
// Returns null if the shape is not recognizable with dimensions (→ use generic).
function fromShape(shape, d) {
  const s = String(shape || '').toLowerCase();
  if (s === 'i' || s === 'w' || s === 'wf' || s === 'ipe' || s === 'hea' || s === 'heb') {
    const { d: H, bf, tf, tw } = d;
    if (!(H > 0 && bf > 0 && tf > 0 && tw > 0)) return null;
    const hw = H - 2 * tf;                                   // clear web
    const A = 2 * bf * tf + hw * tw;
    const Iz = bf * H ** 3 / 12 - (bf - tw) * hw ** 3 / 12;  // strong
    const Iy = 2 * (tf * bf ** 3 / 12) + hw * tw ** 3 / 12;  // weak
    const Sz = Iz / (H / 2), Sy = Iy / (bf / 2);
    const Zz = bf * tf * (H - tf) + tw * hw ** 2 / 4;
    const Zy = bf ** 2 * tf / 2 + hw * tw ** 2 / 4;
    const J = (2 * bf * tf ** 3 + (H - tf) * tw ** 3) / 3;   // open thin-walled
    const Cw = Iy * (H - tf) ** 2 / 4;                       // warping (bisymmetric I)
    return {
      shape: 'I', A, Iz, Iy, Sz, Sy, Zz, Zy, J, Cw, ho: H - tf,  // ho = distance between flange centroids
      Avz_web: hw * tw, Avy_flange: 2 * bf * tf,             // shear via web / flanges
      lambdaFlange: bf / (2 * tf), lambdaWeb: hw / tw,        // b/t flange, h/tw web
      h: H, b: bf, dmin: Math.min(H, bf),
    };
  }
  if (s === 'rect' || s === 'rectangular' || s === 'r') {
    const { b, h } = d;
    if (!(b > 0 && h > 0)) return null;
    const A = b * h;
    return {
      shape: 'rect', A, Iz: b * h ** 3 / 12, Iy: h * b ** 3 / 12,
      Sz: b * h ** 2 / 6, Sy: h * b ** 2 / 6, Zz: b * h ** 2 / 4, Zy: h * b ** 2 / 4,
      J: rectJ(h, b), Cw: 0, Avz_web: 5 / 6 * A, Avy_flange: 5 / 6 * A,
      lambdaFlange: 0, lambdaWeb: 0, h, b, dmin: Math.min(b, h),
    };
  }
  if (s === 'circle' || s === 'circular' || s === 'round' || s === 'c') {
    const { D } = d;
    if (!(D > 0)) return null;
    const A = Math.PI * D ** 2 / 4, I = Math.PI * D ** 4 / 64;
    return {
      shape: 'circle', A, Iz: I, Iy: I, Sz: Math.PI * D ** 3 / 32, Sy: Math.PI * D ** 3 / 32,
      Zz: D ** 3 / 6, Zy: D ** 3 / 6, J: Math.PI * D ** 4 / 32, Cw: 0,
      Avz_web: 0.9 * A, Avy_flange: 0.9 * A, lambdaFlange: 0, lambdaWeb: 0,
      h: D, b: D, dmin: D,
    };
  }
  if (s === 'pipe' || s === 'tube' || s === 'hss-round' || s === 'chs') {
    const { D, t } = d;
    if (!(D > 0 && t > 0 && t < D / 2)) return null;
    const Di = D - 2 * t;
    const A = Math.PI * (D ** 2 - Di ** 2) / 4, I = Math.PI * (D ** 4 - Di ** 4) / 64;
    return {
      shape: 'pipe', A, Iz: I, Iy: I, Sz: I / (D / 2), Sy: I / (D / 2),
      Zz: (D ** 3 - Di ** 3) / 6, Zy: (D ** 3 - Di ** 3) / 6, J: Math.PI * (D ** 4 - Di ** 4) / 32,
      Cw: 0, Avz_web: 0.5 * A, Avy_flange: 0.5 * A, lambdaFlange: D / t, lambdaWeb: D / t,
      h: D, b: D, dmin: D,
    };
  }
  if (s === 'box' || s === 'hss' || s === 'rhs' || s === 'tube-rect') {
    const { b, h, t } = d;
    if (!(b > 0 && h > 0 && t > 0 && t < Math.min(b, h) / 2)) return null;
    const bi = b - 2 * t, hi = h - 2 * t;
    const A = b * h - bi * hi;
    const Iz = (b * h ** 3 - bi * hi ** 3) / 12, Iy = (h * b ** 3 - hi * bi ** 3) / 12;
    const Am = (b - t) * (h - t);                            // mean area (Bredt)
    const J = 2 * t * Am ** 2 / ((b - t) + (h - t));
    return {
      shape: 'box', A, Iz, Iy, Sz: Iz / (h / 2), Sy: Iy / (b / 2),
      Zz: b * h ** 2 / 4 - bi * hi ** 2 / 4, Zy: h * b ** 2 / 4 - hi * bi ** 2 / 4,
      J, Cw: 0, Avz_web: 2 * h * t, Avy_flange: 2 * b * t,
      lambdaFlange: (b - 2 * t) / t, lambdaWeb: (h - 2 * t) / t, h, b, dmin: Math.min(b, h),
    };
  }
  if (s === 'channel' || s === 'u' || s === 'upn' || s === 'c-shape') {
    const { d: H, bf, tf, tw } = d;
    if (!(H > 0 && bf > 0 && tf > 0 && tw > 0 && tw < bf && 2 * tf < H)) return null;
    const p = rectsProps([
      { x0: 0, x1: tw, y0: 0, y1: H },                       // web (back at x=0)
      { x0: tw, x1: bf, y0: H - tf, y1: H },                 // top flange
      { x0: tw, x1: bf, y0: 0, y1: tf },                     // bottom flange
    ]);
    const hm = H - tf;                                        // between flange centroids
    const Cw = (hm ** 2 * bf ** 3 * tf / 12) * ((3 * bf * tf + 2 * hm * tw) / (6 * bf * tf + hm * tw));
    const J = (2 * bf * tf ** 3 + H * tw ** 3) / 3;
    return {
      shape: 'channel', A: p.A, Iz: p.Iz, Iy: p.Iy, Sz: p.Sz, Sy: p.Sy, Zz: p.Zz, Zy: p.Zy,
      J, Cw, ho: hm, Avz_web: (H - 2 * tf) * tw, Avy_flange: 2 * bf * tf,
      lambdaFlange: bf / tf, lambdaWeb: (H - 2 * tf) / tw, h: H, b: bf, dmin: Math.min(H, bf),
    };
  }
  if (s === 'angle' || s === 'l' || s === 'l-shape') {
    const { d: H, b: B, t } = d;                              // H = vertical leg, B = horizontal leg
    if (!(H > 0 && B > 0 && t > 0 && t < Math.min(H, B))) return null;
    const p = rectsProps([
      { x0: 0, x1: t, y0: 0, y1: H },                         // vertical leg
      { x0: t, x1: B, y0: 0, y1: t },                         // horizontal leg (without corner)
    ]);
    const J = (H * t ** 3 + (B - t) * t ** 3) / 3;            // thin open profile
    return {
      shape: 'angle', A: p.A, Iz: p.Iz, Iy: p.Iy, Sz: p.Sz, Sy: p.Sy, Zz: p.Zz, Zy: p.Zy,
      J, Cw: 0, Avz_web: H * t, Avy_flange: B * t,            // angle: negligible warping
      lambdaFlange: Math.max(H, B) / t, lambdaWeb: Math.max(H, B) / t, h: H, b: B, dmin: Math.min(H, B),
    };
  }
  if (s === 'tee' || s === 't' || s === 't-shape') {
    const { d: H, bf, tf, tw } = d;
    if (!(H > 0 && bf > 0 && tf > 0 && tw > 0 && tw < bf && tf < H)) return null;
    const p = rectsProps([
      { x0: (bf - tw) / 2, x1: (bf + tw) / 2, y0: 0, y1: H - tf },   // web (stem)
      { x0: 0, x1: bf, y0: H - tf, y1: H },                          // flange (head)
    ]);
    const J = (bf * tf ** 3 + (H - tf) * tw ** 3) / 3;
    return {
      shape: 'tee', A: p.A, Iz: p.Iz, Iy: p.Iy, Sz: p.Sz, Sy: p.Sy, Zz: p.Zz, Zy: p.Zy,
      J, Cw: 0, ho: H - tf / 2, Avz_web: (H - tf) * tw, Avy_flange: bf * tf,
      lambdaFlange: bf / (2 * tf), lambdaWeb: (H - tf) / tw, h: H, b: bf, dmin: Math.min(H, bf),
    };
  }
  if (s === 'polygon' || s === 'poly') {
    const outline = d.outline, holes = d.holes || [];
    if (!Array.isArray(outline) || outline.length < 3) return null;
    let p; try { p = polygonProps({ outline, holes }); } catch (e) { return null; }
    // Torsion J: compact-section estimate J ≈ A⁴/(40·Ip) (≈ exact for a circle).
    // Av ≈ 5/6·A (solid). Cw negligible. Iyz/principal axes are exposed.
    const Ip = p.Iz + p.Iy;
    const J = Ip > 0 ? p.A ** 4 / (40 * Ip) : 0;
    return {
      shape: 'polygon', A: p.A, Iz: p.Iz, Iy: p.Iy, Sz: p.Sz, Sy: p.Sy, Zz: p.Zz, Zy: p.Zy,
      J, Cw: 0, Avz_web: 5 / 6 * p.A, Avy_flange: 5 / 6 * p.A,
      lambdaFlange: 0, lambdaWeb: 0, h: p.h, b: p.b, dmin: Math.min(p.h, p.b),
      Iyz: p.Iyz, I1: p.I1, I2: p.I2, theta: p.theta, cx: p.cx, cy: p.cy, perimeter: p.perimeter,
    };
  }
  return null;
}

// Equivalent rectangle from A, Iy, Iz (Pórtico's generic section).
function fromGeneric(sec, shapeFactor) {
  const A = sec.A || 1e-6;
  const Iz = sec.Iz || sec.Iy || 1e-9, Iy = sec.Iy || sec.Iz || 1e-9;
  const cz = Math.sqrt(Math.max(3 * Iz / A, 1e-12));
  const cy = Math.sqrt(Math.max(3 * Iy / A, 1e-12));
  const Sz = Iz / cz, Sy = Iy / cy;
  const h = 2 * cz, b = A / h;
  const sf = shapeFactor || 1.12;
  return {
    shape: 'generic', A, Iz, Iy, Sz, Sy, Zz: sf * Sz, Zy: sf * Sy,
    J: sec.J || rectJ(h, b), Cw: 0,
    Avz_web: sec.Avy || 0.6 * A, Avy_flange: sec.Avz || 0.6 * A,
    lambdaFlange: 0, lambdaWeb: 0, h, b, dmin: 2 * Math.min(cz, cy),
  };
}

// ── API: resolves ALL the design properties of a section ─────────────────────────
// sec: model section { A, Iz, Iy, J, Avy, Avz, design?:{shape,dims,...overrides} }
// Returns a flat object with A, Iy, Iz, Sy, Sz, Zy, Zz, ry, rz, rmin, J, Cw,
// Avy, Avz, lambdaFlange, lambdaWeb, h, b, dmin, shape.
export function resolveSectionProps(sec, opts = {}) {
  const dz = sec.design || {};
  // dims may come in design.dims or directly in design
  const dims = dz.dims || dz;
  let g = dz.shape ? fromShape(dz.shape, dims) : null;
  if (!g) g = fromGeneric(sec, dz.shapeFactor ?? opts.shapeFactor);

  // For A, Iy, Iz, J: ALWAYS prefer the model values (what the solver sees) if
  // they are valid, for analysis↔design consistency.
  const A  = sec.A  > 0 ? sec.A  : g.A;
  const Iz = sec.Iz > 0 ? sec.Iz : g.Iz;
  const Iy = sec.Iy > 0 ? sec.Iy : g.Iy;
  const J  = sec.J  > 0 ? sec.J  : g.J;
  // S, Z, Av, Cw are scaled if the model A/I differs from the shape's (rare).
  const out = {
    shape: g.shape, A, Iz, Iy, J,
    Sz: g.Sz, Sy: g.Sy, Zz: g.Zz, Zy: g.Zy, Cw: g.Cw,
    rz: Math.sqrt(Iz / A), ry: Math.sqrt(Iy / A),
    Avy: sec.Avy > 0 ? sec.Avy : g.Avz_web,        // shear paired with Mz (web)
    Avz: sec.Avz > 0 ? sec.Avz : g.Avy_flange,     // shear paired with My (flanges)
    lambdaFlange: g.lambdaFlange, lambdaWeb: g.lambdaWeb,
    h: g.h, b: g.b, dmin: g.dmin, ho: g.ho || 0,
  };
  // Extra properties of polygonal sections (product of inertia, principal axes).
  for (const k of ['Iyz', 'I1', 'I2', 'theta', 'cx', 'cy', 'perimeter']) if (g[k] !== undefined) out[k] = g[k];
  // RC reinforcement (bars/stirrups) is propagated for concrete design (#70).
  if (dz.rebar) out.rebar = dz.rebar;
  out.rmin = Math.min(out.rz, out.ry);
  // Explicit user overrides (design.Zz, design.Cw, etc.)
  for (const k of ['Sz', 'Sy', 'Zz', 'Zy', 'Cw', 'Avy', 'Avz', 'rz', 'ry', 'lambdaFlange', 'lambdaWeb']) {
    if (typeof dz[k] === 'number' && dz[k] > 0) out[k] = dz[k];
  }
  out.rmin = Math.min(out.rz, out.ry);
  return out;
}

export { rectJ, fromShape, fromGeneric };
