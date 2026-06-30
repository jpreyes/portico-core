// ──────────────────────────────────────────────────────────────────────────────
// polygon_props.js — Properties of an arbitrary POLYGONAL section (#70).
//
// For the «Section Designer»: given an outline (polygon) and, optionally, holes
// (inner polygons), computes via Green's theorem ALL the section properties: area,
// centroid (y,z), moments of inertia Iz, Iy and the PRODUCT Iyz, principal axes
// (I₁, I₂, θ), elastic moduli Sz/Sy, PLASTIC moduli Zz/Zy (equal-area neutral axis
// by bisection + half-plane clipping), perimeter and bounding box. Supports concave
// sections and sections with holes.
//
// Project axis convention: z = strong axis (horizontal), Iz = ∫y²dA; y = weak axis
// (vertical), Iy = ∫x²dA. Polygon coordinates: x = horizontal, y = vertical.
// Units: those of the input (m → m², m⁴).
// ──────────────────────────────────────────────────────────────────────────────

// Integrals of a loop about the ORIGIN (CCW → positive). Normalizes to positive area.
function loopIntegrals(loop) {
  let A = 0, Qx = 0, Qy = 0, Ixx = 0, Iyy = 0, Ixy = 0, per = 0;
  const n = loop.length;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = loop[i], [x1, y1] = loop[(i + 1) % n];
    const cr = x0 * y1 - x1 * y0;
    A += cr;
    Qx += (x0 + x1) * cr;                          // 6·∫x dA
    Qy += (y0 + y1) * cr;                          // 6·∫y dA
    Iyy += (x0 * x0 + x0 * x1 + x1 * x1) * cr;     // 12·∫x² dA
    Ixx += (y0 * y0 + y0 * y1 + y1 * y1) * cr;     // 12·∫y² dA
    Ixy += (x0 * y1 + 2 * x0 * y0 + 2 * x1 * y1 + x1 * y0) * cr;   // 24·∫xy dA
    per += Math.hypot(x1 - x0, y1 - y0);
  }
  let r = { A: A / 2, Qx: Qx / 6, Qy: Qy / 6, Iyy: Iyy / 12, Ixx: Ixx / 12, Ixy: Ixy / 24, per };
  if (r.A < 0) { r.A = -r.A; r.Qx = -r.Qx; r.Qy = -r.Qy; r.Iyy = -r.Iyy; r.Ixx = -r.Ixx; r.Ixy = -r.Ixy; }
  return r;
}

// Clips a loop to the half-plane coord(axis) ≥ c (Sutherland–Hodgman). axis: 'x'|'y'.
function clipGE(loop, axis, c) {
  const val = p => axis === 'y' ? p[1] : p[0];
  const out = []; const n = loop.length;
  for (let i = 0; i < n; i++) {
    const a = loop[i], b = loop[(i + 1) % n];
    const va = val(a), vb = val(b), inA = va >= c, inB = vb >= c;
    if (inA) out.push(a);
    if (inA !== inB) { const t = (c - va) / (vb - va); out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]); }
  }
  return out.length >= 3 ? out : null;
}

// Combines outline (+) and holes (−) for an integral; clipAxis/clipC optional.
function combine(outline, holes, field, clipAxis, clipC) {
  const loops = [{ loop: outline, s: 1 }, ...holes.map(h => ({ loop: h, s: -1 }))];
  let v = 0;
  for (const { loop, s } of loops) {
    const L = (clipAxis ? clipGE(loop, clipAxis, clipC) : loop);
    if (!L) continue;
    v += s * loopIntegrals(L)[field];
  }
  return v;
}

/**
 * @param {object} o  { outline:[[x,y]…], holes?:[[[x,y]…]…] }
 * @returns section properties (see header).
 */
export function polygonProps({ outline, holes = [] }) {
  if (!outline || outline.length < 3) throw new Error('contorno poligonal inválido (≥3 vértices)');
  const loops = [{ loop: outline, s: 1 }, ...holes.map(h => ({ loop: h, s: -1 }))];
  let A = 0, Qx = 0, Qy = 0, Ixx0 = 0, Iyy0 = 0, Ixy0 = 0, per = 0;
  for (const { loop, s } of loops) {
    const g = loopIntegrals(loop);
    A += s * g.A; Qx += s * g.Qx; Qy += s * g.Qy; Ixx0 += s * g.Ixx; Iyy0 += s * g.Iyy; Ixy0 += s * g.Ixy;
    per += g.per;
  }
  if (!(A > 1e-12)) throw new Error('área de la sección nula o negativa (¿orden de vértices?)');
  const cx = Qx / A, cy = Qy / A;
  // Centroidal (project: Iz=∫y²dA, Iy=∫x²dA, Iyz=∫(y)(x)dA).
  const Iz = Ixx0 - A * cy * cy;
  const Iy = Iyy0 - A * cx * cx;
  const Iyz = Ixy0 - A * cx * cy;
  // Principal axes.
  const avg = (Iz + Iy) / 2, dif = (Iz - Iy) / 2;
  const R = Math.hypot(dif, Iyz);
  const I1 = avg + R, I2 = avg - R;
  const theta = 0.5 * Math.atan2(-Iyz, dif);     // angle of the major principal axis
  // Bounding box.
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (const p of outline) { xmin = Math.min(xmin, p[0]); xmax = Math.max(xmax, p[0]); ymin = Math.min(ymin, p[1]); ymax = Math.max(ymax, p[1]); }
  const Sz = Iz / Math.max(ymax - cy, cy - ymin);
  const Sy = Iy / Math.max(xmax - cx, cx - xmin);
  // Plastic neutral axis (equal areas) by bisection and plastic modulus by clipping.
  const areaGE = (axis, c) => combine(outline, holes, 'A', axis, c);
  const bisect = (axis, lo, hi) => { for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; (areaGE(axis, m) > A / 2 ? lo = m : hi = m); } return (lo + hi) / 2; };
  const yp = bisect('y', ymin, ymax), xp = bisect('x', xmin, xmax);
  // Zz = 2·Qy_above − A·cy ;  Zy = 2·Qx_right − A·cx   (Qy_above=∫_{y≥yp} y dA)
  const QyAbove = combine(outline, holes, 'Qy', 'y', yp);
  const QxRight = combine(outline, holes, 'Qx', 'x', xp);
  const Zz = Math.abs(2 * QyAbove - A * cy);
  const Zy = Math.abs(2 * QxRight - A * cx);
  return {
    shape: 'polygon', A, cx, cy, Iz, Iy, Iyz, I1, I2, theta,
    Sz, Sy, Zz, Zy, perimeter: per,
    h: ymax - ymin, b: xmax - xmin, xmin, xmax, ymin, ymax,
  };
}

// ── COMPOSITE section by the TRANSFORMED-SECTION method (#70) ─────────────────────
// Several materials (e.g. steel + timber) → equivalent properties referred to the
// BASE material: each part is transformed by the modular ratio n=E/Ebase. Returns
// transformed area and inertias (the stiffness is EI = Ebase·Iz_tr).
//   parts: [{ outline:[[x,y]…], holes?, E }]  (E in consistent units).
export function compositeProps({ parts, Ebase }) {
  if (!parts || !parts.length) throw new Error('sección compuesta sin partes');
  const Eb = Ebase || parts[0].E;
  const sub = parts.map(p => ({ g: polygonProps({ outline: p.outline, holes: p.holes || [] }), n: p.E / Eb, E: p.E }));
  let A = 0, Qx = 0, Qy = 0;
  for (const { g, n } of sub) { A += n * g.A; Qx += n * g.A * g.cx; Qy += n * g.A * g.cy; }
  const cx = Qx / A, cy = Qy / A;                          // transformed centroid
  let Iz = 0, Iy = 0;
  for (const { g, n } of sub) {
    Iz += n * (g.Iz + g.A * (g.cy - cy) ** 2);             // neutral axis of the composite
    Iy += n * (g.Iy + g.A * (g.cx - cx) ** 2);
  }
  // Real (untransformed) bounding box for equivalent section moduli.
  let ymin = Infinity, ymax = -Infinity, xmin = Infinity, xmax = -Infinity, Areal = 0;
  for (const { g } of sub) { ymin = Math.min(ymin, g.ymin); ymax = Math.max(ymax, g.ymax); xmin = Math.min(xmin, g.xmin); xmax = Math.max(xmax, g.xmax); Areal += g.A; }
  return { Ebase: Eb, A_tr: A, A_real: Areal, cx, cy, Iz_tr: Iz, Iy_tr: Iy,
    EIz: Eb * Iz, EIy: Eb * Iy, Sz_tr: Iz / Math.max(ymax - cy, cy - ymin), parts: sub.length };
}
