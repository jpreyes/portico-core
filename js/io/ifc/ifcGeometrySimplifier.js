// ──────────────────────────────────────────────────────────────────────────────
// io/ifc/ifcGeometrySimplifier.js — IFC geometry and sections → members · #76, G19
//
// From the IFC geometry (which may be swept solids, curves, meshes…) it extracts what
// PORTICO needs of a member: its AXIS (start/end point in global coordinates) and an
// approximate SECTION (A, Iy, Iz, J).  Strategy, in order of preference:
//   1) 'Axis' representation (IfcPolyline / IfcTrimmedCurve) → direct axis line.
//   2) 'Body' representation with an IfcExtrudedAreaSolid → axis = sweep of the extrusion.
// Curves of >2 points are SEGMENTED into straight members (with a warning).  Placements
// (IfcLocalPlacement) are composed recursively up to the project origin.
//
// All in pure JS; lengths come out in METERS (the unit factor is applied at the end).
// STANDALONE (Node + browser).
// ──────────────────────────────────────────────────────────────────────────────

// ── minimal vector algebra (vectors [x,y,z]) ─────────────────────────────────────
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = a => Math.hypot(a[0], a[1], a[2]);
const unit = a => { const l = len(a); return l > 1e-12 ? mul(a, 1 / l) : [0, 0, 0]; };
const IDENT = { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

// transforms a local DIRECTION d by M's basis (without translation)
const tdir = (M, d) => add(add(mul(M.x, d[0]), mul(M.y, d[1])), mul(M.z, d[2]));
// transforms a local POINT p by M (with translation)
const tpt = (M, p) => add(M.o, tdir(M, p));
// composition M = parent ∘ local  (applies local and then parent)
function matMul(parent, local) {
  return { o: tpt(parent, local.o), x: tdir(parent, local.x), y: tdir(parent, local.y), z: tdir(parent, local.z) };
}

// numeric list of an IfcCartesianPoint / IfcDirection (padded to 3 components)
function coords3(ent) {
  if (!ent || !Array.isArray(ent.args[0])) return [0, 0, 0];
  const c = ent.args[0].map(v => +v || 0);
  return [c[0] || 0, c[1] || 0, c[2] || 0];
}

// ── matrix of an IfcAxis2Placement3D / 2D ────────────────────────────────────────
function placementMatrix(model, placement) {
  const pl = model.get(placement);
  if (!pl) return { ...IDENT };
  const o = coords3(model.get(pl.args[0]));                 // Location
  let z = pl.args[1] ? unit(coords3(model.get(pl.args[1]))) : [0, 0, 1]; // Axis
  if (len(z) < 1e-9) z = [0, 0, 1];
  let xref = pl.args[2] ? coords3(model.get(pl.args[2])) : [1, 0, 0];    // RefDirection
  // orthonormalizes X with respect to Z
  let x = unit(sub(xref, mul(z, dot(xref, z))));
  if (len(x) < 1e-9) { // RefDirection parallel to Z → arbitrary perpendicular axis
    x = Math.abs(z[0]) < 0.9 ? unit(sub([1, 0, 0], mul(z, dot([1, 0, 0], z))))
                             : unit(sub([0, 1, 0], mul(z, dot([0, 1, 0], z))));
  }
  const y = cross(z, x);
  return { o, x, y, z };
}

// ── GLOBAL placement of an IfcLocalPlacement (composes the PlacementRelTo chain) ──
function worldPlacement(model, objPlacement, depth = 0) {
  const p = model.get(objPlacement);
  if (!p || depth > 64) return { ...IDENT };
  if (p.type !== 'IFCLOCALPLACEMENT') return { ...IDENT }; // IfcGridPlacement or other → identity
  // IfcLocalPlacement(PlacementRelTo, RelativePlacement)
  const local = placementMatrix(model, p.args[1]);
  const parent = p.args[0] ? worldPlacement(model, p.args[0], depth + 1) : IDENT;
  return matMul(parent, local);
}

// ── local AXIS points from a curve ────────────────────────────────────────────────
function curvePoints(model, curve) {
  const c = model.get(curve);
  if (!c) return null;
  if (c.type === 'IFCPOLYLINE') {
    const pts = (c.args[0] || []).map(r => coords3(model.get(r)));
    return pts.length >= 2 ? pts : null;
  }
  if (c.type === 'IFCTRIMMEDCURVE') {
    // IfcTrimmedCurve(BasisCurve, Trim1, Trim2, SenseAgreement, MasterRepresentation)
    const basis = model.get(c.args[0]);
    if (!basis || basis.type !== 'IFCLINE') return null;
    const p0 = coords3(model.get(basis.args[0]));            // Pnt
    const vec = model.get(basis.args[1]);                    // IfcVector(Orientation, Magnitude)
    const dir = vec ? coords3(model.get(vec.args[0])) : [1, 0, 0];
    const mag = vec ? (+vec.args[1] || 1) : 1;
    const trim = (slot) => {
      for (const t of (slot || [])) {
        if (model.isRef(t)) { const tp = model.get(t); if (tp && tp.type === 'IFCCARTESIANPOINT') return coords3(tp); }
        else if (typeof t === 'object' && t.type === 'IFCPARAMETERVALUE') return add(p0, mul(unit(dir), (+t.value[0] || 0) * mag));
        else if (typeof t === 'number') return add(p0, mul(unit(dir), t * mag));
      }
      return null;
    };
    const a = trim(c.args[1]) || p0;
    const b = trim(c.args[2]) || add(p0, mul(unit(dir), mag));
    return [a, b];
  }
  return null;
}

// ── B-rep / SurfaceModel fallback: oriented bounding box → bar or panel ──────────
// When there is no 'Axis' polyline and no IfcExtrudedAreaSolid (e.g. Archicad's
// "SurfaceGeometryAddOnView" exports every element as a faceted mesh), the member/section
// is approximated from the mesh's bounding box, taken in the element's LOCAL frame (tight
// for the axis-aligned boxes these exporters emit) and mapped to global. Dimensionality
// decides the kind: one dominant axis → bar; one thin axis → panel; all comparable → 3D
// block (skipped).
const K_SLENDER = 3;   // aspect ratio to call an axis "dominant"

// torsion constant of a solid rectangle b×h (Saint-Venant)
function rectTorsion(b, h) { const a = Math.max(b, h) / 2, c = Math.min(b, h) / 2; return a * c * c * c * (16 / 3 - 3.36 * (c / a) * (1 - (c ** 4) / (12 * a ** 4))); }

// all local-coordinate vertices of the element's Body B-rep / SurfaceModel items
function bodyBrepVertices(model, element) {
  const repDef = model.get(element.args[6]);
  if (!repDef || !Array.isArray(repDef.args[2])) return [];
  const pts = [];
  const loop = (ref) => { const l = model.get(ref); if (l && l.type === 'IFCPOLYLOOP') for (const pr of (l.args[0] || [])) { const p = model.get(pr); if (p && p.type === 'IFCCARTESIANPOINT') pts.push(coords3(p)); } };
  const face = (ref) => { const fc = model.get(ref); if (!fc || fc.type !== 'IFCFACE') return; for (const br of (fc.args[0] || [])) { const b = model.get(br); if (b && (b.type === 'IFCFACEOUTERBOUND' || b.type === 'IFCFACEBOUND')) loop(b.args[0]); } };
  const shell = (ref) => { const s = model.get(ref); if (!s) return; if (s.type === 'IFCCLOSEDSHELL' || s.type === 'IFCOPENSHELL') for (const f of (s.args[0] || [])) face(f); };
  for (const r of repDef.args[2]) {
    const sr = model.get(r);
    if (!sr || sr.type !== 'IFCSHAPEREPRESENTATION') continue;
    const ident = (sr.args[1] || '').toString();
    if (ident === 'Axis' || ident === 'FootPrint' || ident === 'Annotation') continue;   // skip 2D reps
    for (const it of (sr.args[3] || [])) {
      const g = model.get(it);
      if (!g) continue;
      if (g.type === 'IFCFACETEDBREP') shell(g.args[0]);
      else if (g.type === 'IFCFACEBASEDSURFACEMODEL' || g.type === 'IFCSHELLBASEDSURFACEMODEL') for (const sh of (g.args[0] || [])) shell(sh);
      else if (g.type === 'IFCFACE') face(it);
    }
  }
  return pts;
}

// oriented bounding box of the element's mesh → { shape:'bar'|'panel'|'block', … } in meters
function brepOBB(model, element, world, factor) {
  const V = bodyBrepVertices(model, element);
  if (V.length < 4) return null;
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const v of V) for (let i = 0; i < 3; i++) { if (v[i] < mn[i]) mn[i] = v[i]; if (v[i] > mx[i]) mx[i] = v[i]; }
  const extL = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]];
  const cL = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2];
  const axes = [unit(world.x), unit(world.y), unit(world.z)];
  const center = mul(tpt(world, cL), factor);
  const order = [0, 1, 2].sort((i, j) => extL[j] - extL[i]);   // descending extent
  const L = order.map(i => Math.max(extL[i] * factor, 0));       // L[0] ≥ L[1] ≥ L[2]
  const A = order.map(i => axes[i]);
  let shape = 'block';
  if (L[1] > 1e-9 && L[0] / L[1] >= K_SLENDER) shape = 'bar';
  else if (L[1] > 1e-9 && (L[2] <= 1e-9 || L[1] / L[2] >= K_SLENDER)) shape = 'panel';
  const out = { shape, L, center };
  if (shape === 'bar') {
    const half = mul(A[0], L[0] / 2);
    out.a = sub(center, half); out.b = add(center, half);
    out.section = { b: Math.max(L[1], 1e-4), h: Math.max(L[2], 1e-4) };
  } else if (shape === 'panel') {
    const h1 = mul(A[0], L[0] / 2), h2 = mul(A[1], L[1] / 2);
    out.corners = [sub(sub(center, h1), h2), sub(add(center, h1), h2), add(add(center, h1), h2), add(sub(center, h1), h2)];
    out.thickness = L[2] > 1e-6 ? L[2] : 0.2;
  }
  return out;
}

// PORTICO section from a rectangular (or circular, by name hint) bounding box (meters)
export function boxSectionProps(b, h, circular) {
  if (circular) {
    const d = Math.min(b, h), r = d / 2, I = Math.PI * r ** 4 / 4;
    return { name: `⌀${(d * 1000).toFixed(0)} (bbox)`, A: Math.PI * r * r, Iy: I, Iz: I, J: 2 * I, approx: true };
  }
  return { name: `${(b * 1000).toFixed(0)}×${(h * 1000).toFixed(0)} (bbox)`, A: b * h, Iz: b * h ** 3 / 12, Iy: h * b ** 3 / 12, J: rectTorsion(b, h), approx: true };
}

/**
 * Axis of an IFC member in GLOBAL coordinates (meters), as straight segments.
 * @returns {{ segments: number[][][], via:string } | null}
 *   segments: [[ [x,y,z], [x,y,z] ], …]  (one per straight span);  via: 'axis'|'body'
 */
export function memberAxis(model, element, factor, warn) {
  const world = worldPlacement(model, element.args[5]);     // ObjectPlacement
  const repDef = model.get(element.args[6]);                // Representation (IfcProductDefinitionShape)
  if (!repDef || !Array.isArray(repDef.args[2])) return null;

  // locate the 'Axis' representation (preferred) or, failing that, 'Body'/'Reference'
  let axisRep = null, bodyRep = null;
  for (const r of repDef.args[2]) {
    const sr = model.get(r);
    if (!sr || sr.type !== 'IFCSHAPEREPRESENTATION') continue;
    const ident = (sr.args[1] || '').toString();
    if (ident === 'Axis') axisRep = sr;
    else if (ident === 'Body' || ident === 'Reference') bodyRep = sr || bodyRep;
    else if (!bodyRep) bodyRep = sr;
  }

  // 1) direct axis
  if (axisRep && Array.isArray(axisRep.args[3]) && axisRep.args[3].length) {
    const pts = curvePoints(model, axisRep.args[3][0]);
    if (pts && pts.length >= 2) {
      if (pts.length > 2) warn && warn.add('Eje con más de 2 puntos: barra curva/poligonal segmentada en tramos rectos');
      const g = pts.map(p => mul(tpt(world, p), factor));
      const segments = [];
      for (let i = 0; i + 1 < g.length; i++) segments.push([g[i], g[i + 1]]);
      return { segments, via: 'axis' };
    }
  }

  // 2) extruded solid → sweep of the extrusion
  if (bodyRep && Array.isArray(bodyRep.args[3])) {
    for (const it of bodyRep.args[3]) {
      const solid = model.get(it);
      if (!solid) continue;
      if (solid.type === 'IFCEXTRUDEDAREASOLID') {
        // IfcExtrudedAreaSolid(SweptArea, Position, ExtrudedDirection, Depth)
        const pos = placementMatrix(model, solid.args[1]);
        const exDir = coords3(model.get(solid.args[2]));
        const depth = +solid.args[3] || 0;
        const start = pos.o;
        const end = tpt(pos, mul(exDir, depth));
        const a = mul(tpt(world, start), factor);
        const b = mul(tpt(world, end), factor);
        if (len(sub(b, a)) > 1e-9) { warn && warn.add('Eje derivado del sólido extruido (sin representación «Axis»)'); return { segments: [[a, b]], via: 'body' }; }
      }
    }
  }

  // 3) B-rep / mesh fallback: oriented bounding box → bar
  const obb = brepOBB(model, element, world, factor);
  if (obb) {
    if (obb.shape === 'bar') { warn && warn.add('Eje y sección aproximados por el bounding box de la malla (B-rep)'); return { segments: [[obb.a, obb.b]], via: 'brep-obb', section: obb.section }; }
    warn && warn.add(obb.shape === 'panel' ? 'Elemento con forma de panel en un tipo de barra: no se importa' : 'Geometría de bloque 3D (no unidimensional): omitida');
  }
  return null;
}

// ── profile of the 'Body' representation (SweptArea of the extrusion) ─────────────
export function bodyProfile(model, element) {
  const repDef = model.get(element.args[6]);
  if (!repDef || !Array.isArray(repDef.args[2])) return null;
  for (const r of repDef.args[2]) {
    const sr = model.get(r);
    if (!sr || sr.type !== 'IFCSHAPEREPRESENTATION' || !Array.isArray(sr.args[3])) continue;
    for (const it of sr.args[3]) {
      const solid = model.get(it);
      if (solid && solid.type === 'IFCEXTRUDEDAREASOLID') return solid.args[0]; // ref to SweptArea
    }
  }
  return null;
}

// ── SECTION properties from an IfcProfileDef ──────────────────────────────────────
/**
 * Converts an IfcProfileDef into PORTICO section properties (in meters).
 * Recognizes rectangle, circle (solid/hollow), I-shape and rectangular tube; the rest
 * are approximated by their bounding box (with a warning).  Never blocks.
 * @returns {{ name:string, A:number, Iy:number, Iz:number, J:number, approx:boolean } | null}
 */
export function profileProps(model, profile, factor, warn) {
  const p = model.get(profile);
  if (!p) return null;
  const f = factor, f2 = factor * factor, f4 = f2 * f2;
  const name = (p.args[1] || p.type.replace(/^IFC|PROFILEDEF$/g, '')).toString();
  const rectJ = (b, h) => { const a = Math.max(b, h) / 2, c = Math.min(b, h) / 2; return a * c * c * c * (16 / 3 - 3.36 * (c / a) * (1 - (c * c * c * c) / (12 * a * a * a * a))); };

  switch (p.type) {
    case 'IFCRECTANGLEPROFILEDEF': {            // (.., XDim, YDim)
      const b = (+p.args[3] || 0) * f, h = (+p.args[4] || 0) * f;
      if (b <= 0 || h <= 0) break;
      return { name, A: b * h, Iz: b * h * h * h / 12, Iy: h * b * b * b / 12, J: rectJ(b, h), approx: false };
    }
    case 'IFCRECTANGLEHOLLOWPROFILEDEF': {       // (.., XDim, YDim, WallThickness, …)
      const b = (+p.args[3] || 0) * f, h = (+p.args[4] || 0) * f, t = (+p.args[5] || 0) * f;
      if (b <= 0 || h <= 0 || t <= 0) break;
      const bi = b - 2 * t, hi = h - 2 * t;
      return { name, A: b * h - bi * hi, Iz: (b * h ** 3 - bi * hi ** 3) / 12, Iy: (h * b ** 3 - hi * bi ** 3) / 12, J: 2 * (b - t) * (b - t) * (h - t) * (h - t) * t / (b + h - 2 * t), approx: false };
    }
    case 'IFCCIRCLEPROFILEDEF': {                // (.., Radius)
      const r = (+p.args[3] || 0) * f;
      if (r <= 0) break;
      const I = Math.PI * r ** 4 / 4;
      return { name, A: Math.PI * r * r, Iy: I, Iz: I, J: 2 * I, approx: false };
    }
    case 'IFCCIRCLEHOLLOWPROFILEDEF': {          // (.., Radius, WallThickness)
      const r = (+p.args[3] || 0) * f, t = (+p.args[4] || 0) * f, ri = r - t;
      if (r <= 0 || ri <= 0) break;
      const I = Math.PI * (r ** 4 - ri ** 4) / 4;
      return { name, A: Math.PI * (r * r - ri * ri), Iy: I, Iz: I, J: 2 * I, approx: false };
    }
    case 'IFCISHAPEPROFILEDEF': {                // (.., OverallWidth bf, OverallDepth h, WebThickness tw, FlangeThickness tf, …)
      const bf = (+p.args[3] || 0) * f, h = (+p.args[4] || 0) * f, tw = (+p.args[5] || 0) * f, tf = (+p.args[6] || 0) * f;
      if (bf <= 0 || h <= 0 || tw <= 0 || tf <= 0) break;
      const hw = h - 2 * tf;
      const A = 2 * bf * tf + hw * tw;
      const Iz = (bf * h ** 3 - (bf - tw) * hw ** 3) / 12;          // strong axis (bending in the web plane)
      const Iy = (2 * tf * bf ** 3 + hw * tw ** 3) / 12;            // weak axis
      const J = (2 * bf * tf ** 3 + (h - tf) * tw ** 3) / 3;        // open thin-walled torsion
      return { name, A, Iz, Iy, J, approx: false };
    }
    case 'IFCARBITRARYCLOSEDPROFILEDEF': {       // approximation by the outline's bounding box
      const bb = profileBBox(model, p.args[2]);
      if (bb) { warn && warn.add(`Sección «${name}» aproximada por su bounding box`); const b = bb.w * f, h = bb.h * f; return { name, A: b * h, Iz: b * h ** 3 / 12, Iy: h * b ** 3 / 12, J: rectJ(b, h), approx: true }; }
      break;
    }
    default:
      warn && warn.add(`Tipo de perfil ${p.type} no reconocido: sección genérica`);
      return null;
  }
  return null;
}

// bounding box (width/height) of an IfcArbitraryClosedProfileDef's outline
function profileBBox(model, curveRef) {
  const pts = curvePoints(model, curveRef);
  if (!pts || !pts.length) return null;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const pt of pts) { x0 = Math.min(x0, pt[0]); x1 = Math.max(x1, pt[0]); y0 = Math.min(y0, pt[1]); y1 = Math.max(y1, pt[1]); }
  return { w: Math.max(x1 - x0, 1e-6), h: Math.max(y1 - y0, 1e-6) };
}

// ── surface of an AREA (wall/slab/plate) from the extruded solid ──────────────────
// 2D polygon of the profile (in profile coords): rectangle (4 corners) or outline.
function profilePolygon2D(model, profile) {
  const p = model.get(profile);
  if (!p) return null;
  if (p.type === 'IFCRECTANGLEPROFILEDEF') {
    const b = +p.args[3] || 0, h = +p.args[4] || 0;
    if (b <= 0 || h <= 0) return null;
    return [[-b / 2, -h / 2], [b / 2, -h / 2], [b / 2, h / 2], [-b / 2, h / 2]];
  }
  if (p.type === 'IFCARBITRARYCLOSEDPROFILEDEF') {
    const pts = curvePoints(model, p.args[2]);          // OuterCurve
    if (!pts || pts.length < 3) return null;
    let poly = pts.map(q => [q[0], q[1]]);
    const f = poly[0], l = poly[poly.length - 1];        // drop the duplicated closing point
    if (Math.hypot(f[0] - l[0], f[1] - l[1]) < 1e-9) poly = poly.slice(0, -1);
    return poly.length >= 3 ? poly : null;
  }
  return null;
}

/**
 * Structural surface (3–4 global corners + thickness) of an IfcWall/IfcSlab/IfcPlate.
 * Strategy on the 'Body' IfcExtrudedAreaSolid:
 *   • horizontal SLAB/PLATE → the profile outline at the MID-PLANE (zoff = depth/2),
 *     thickness = extrusion depth.
 *   • WALL (vertical panel) → rectangle (long axis of the profile) × extrusion height,
 *     at the mid-plane of the thickness (the short dimension of the profile).
 * @returns {{ corners:number[][], thickness:number, via:string } | null}
 */
export function areaSurface(model, element, kind, factor, warn) {
  const world = worldPlacement(model, element.args[5]);
  const repDef = model.get(element.args[6]);
  if (!repDef || !Array.isArray(repDef.args[2])) return null;
  let solid = null;
  for (const r of repDef.args[2]) {
    const sr = model.get(r);
    if (!sr || sr.type !== 'IFCSHAPEREPRESENTATION' || !Array.isArray(sr.args[3])) continue;
    for (const it of sr.args[3]) { const s = model.get(it); if (s && s.type === 'IFCEXTRUDEDAREASOLID') { solid = s; break; } }
    if (solid) break;
  }
  if (!solid) {
    // B-rep / mesh fallback: oriented bounding box → panel (mid-surface + thickness)
    const obb = brepOBB(model, element, world, factor);
    if (obb && obb.shape === 'panel') { warn && warn.add('Superficie y espesor aproximados por el bounding box de la malla (B-rep)'); return { corners: obb.corners, thickness: obb.thickness, via: 'brep-obb' }; }
    warn && warn.add(obb && obb.shape === 'bar' ? 'Elemento con forma de barra en un tipo de área: no se importa como área' : 'Sin geometría de área reconocible: omitida');
    return null;
  }

  const pos = placementMatrix(model, solid.args[1]);     // profile system
  const depth = +solid.args[3] || 0;                     // extrusion depth
  const poly = profilePolygon2D(model, solid.args[0]);
  if (!poly) { warn && warn.add('Perfil de área no reconocido (sólo rectángulo o polígono)'); return null; }

  // profile point (x, y, zoff along the extrusion) → global in meters
  const G = (x, y, z) => mul(tpt(world, tpt(pos, [x, y, z])), factor);

  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const q of poly) { x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]); }
  const wx = x1 - x0, wy = y1 - y0, H = Math.abs(depth);

  // «real» wall (long×thin footprint extruded in height) vs slab/panel (outline
  // extruded by the thickness): decided by GEOMETRY, not by the IFC type — this way the
  // walls this exporter writes as polygon×thickness also re-import correctly.
  const thinProfile = Math.min(wx, wy) < Math.max(wx, wy) * 0.5 && Math.min(wx, wy) < H * 0.5;
  const asWall = thinProfile && H > Math.min(wx, wy);

  if (asWall) {
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    let e1, e2, thick;
    if (wx >= wy) { e1 = [x0, cy]; e2 = [x1, cy]; thick = wy; } else { e1 = [cx, y0]; e2 = [cx, y1]; thick = wx; }
    const corners = [G(e1[0], e1[1], 0), G(e2[0], e2[1], 0), G(e2[0], e2[1], depth), G(e1[0], e1[1], depth)];
    return { corners, thickness: (thick || 0.2) * factor, via: 'wall' };
  }

  if (poly.length > 4) { warn && warn.add(`Losa/placa con ${poly.length} vértices: sólo se importan 3–4 (rectángulo/triángulo)`); return null; }
  const corners = poly.map(q => G(q[0], q[1], depth / 2));
  return { corners, thickness: (H || 0.2) * factor, via: 'slab' };
}
