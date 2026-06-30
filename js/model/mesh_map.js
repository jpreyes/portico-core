// ──────────────────────────────────────────────────────────────────────────────
// mesh_map.js — TRANSFINITE (Coons) and MULTI-PATCH area meshing · #52 (Phase 1)
//
// Generalizes the block mesher (`mesher.js`): instead of 4 corners with STRAIGHT
// sides, it accepts a 4-sided region defined by 4 **edge curves** (node polylines).
// The mesh follows the edges by **transfinite Coons interpolation**:
//
//   S(u,v) = (1−v)·B(u) + v·T(u) + (1−u)·L(v) + u·R(v)
//            − [ (1−u)(1−v)P₀₀ + u(1−v)P₁₀ + (1−u)v·P₀₁ + u·v·P₁₁ ]
//
// With straight sides it reduces EXACTLY to the bilinear interpolation of
// `mesher.js`, so it is a superset: it covers rectangles, trapezoids, parallelograms
// and quadrilaterals with curved/polygonal edges — the "better and faster than a
// rectangle" case of irregular walls, decks and slabs. Generates QUAD (better: QUAD4
// + MITC4) or CST/DKT.
//
// Multi-patch: several 4-sided regions are meshed separately and the coincident
// nodes are **welded** (tolerance), so L/U/broken floor plans are built as 2–3
// patches that become conforming automatically (manual submapping).
//
// SELF-CONTAINED (no dependencies except the connectivity from `mesher.js`) →
// verifiable in Node. Grid index identical to mesher.js: idx(i,j)=i*(ny+1)+j.
// ──────────────────────────────────────────────────────────────────────────────
import { blockCells, cornerGridIndices } from './mesher.js?v=1';

// Re-export of the connectivity (same grid convention) for convenience.
export { blockCells, cornerGridIndices };

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// Reparametrizes a polyline [[x,y,z],…] to n+1 points equally spaced by ARC LENGTH
// (so the node density is uniform even if the control points are uneven). With 2
// points it gives the straight line subdivided into n segments.
export function resamplePolyline(poly, n) {
  if (!Array.isArray(poly) || poly.length < 2) throw new Error('polilínea con <2 puntos');
  if (n < 1) throw new Error('n debe ser ≥ 1');
  const cum = [0];
  for (let i = 1; i < poly.length; i++) cum.push(cum[i - 1] + dist(poly[i - 1], poly[i]));
  const total = cum[cum.length - 1];
  if (!(total > 0)) throw new Error('polilínea de longitud nula');
  const out = [];
  let seg = 0;
  for (let k = 0; k <= n; k++) {
    const s = total * k / n;
    while (seg < poly.length - 2 && cum[seg + 1] < s) seg++;
    const segLen = cum[seg + 1] - cum[seg] || 1;
    const t = Math.min(Math.max((s - cum[seg]) / segLen, 0), 1);
    const a = poly[seg], b = poly[seg + 1];
    out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])]);
  }
  return out;
}

// Transfinite mesh of a 4-sided region.
//   edges = { bottom, right, top, left }  (each a polyline [[x,y,z],…])
//   Orientation: bottom P₀₀→P₁₀ (v=0), top P₀₁→P₁₁ (v=1), left P₀₀→P₀₁ (u=0),
//   right P₁₀→P₁₁ (u=1).  The corners must coincide between adjacent sides.
//   bottom/top are sampled at nx+1 points; left/right at ny+1.
// Returns pts[idx(i,j)] with idx(i,j)=i*(ny+1)+j, i∈[0,nx], j∈[0,ny].
export function coonsGrid(edges, nx, ny) {
  const B = resamplePolyline(edges.bottom, nx), T = resamplePolyline(edges.top, nx);
  const L = resamplePolyline(edges.left, ny),  R = resamplePolyline(edges.right, ny);
  const P00 = B[0], P10 = B[nx], P01 = T[0], P11 = T[nx];
  const pts = new Array((nx + 1) * (ny + 1));
  for (let i = 0; i <= nx; i++) {
    const u = i / nx;
    for (let j = 0; j <= ny; j++) {
      const v = j / ny;
      const s = new Array(3);
      for (let c = 0; c < 3; c++) {
        s[c] = (1 - v) * B[i][c] + v * T[i][c] + (1 - u) * L[j][c] + u * R[j][c]
             - ((1 - u) * (1 - v) * P00[c] + u * (1 - v) * P10[c] + (1 - u) * v * P01[c] + u * v * P11[c]);
      }
      pts[i * (ny + 1) + j] = s;
    }
  }
  return pts;
}

// Convenience: 4 corners (straight sides) → identical to bilinearGrid of mesher.js.
// corners = [P1,P2,P3,P4] CCW with P1=P₀₀, P2=P₁₀, P3=P₁₁, P4=P₀₁.
export function coonsGridFromCorners(corners, nx, ny) {
  const [P1, P2, P3, P4] = corners;
  return coonsGrid({ bottom: [P1, P2], right: [P2, P3], top: [P4, P3], left: [P1, P4] }, nx, ny);
}

// Minimum scaled Jacobian of a quadrilateral (corners in order p0,p1,p2,p3).
// >0 = valid (not inverted); ≈1 = near-square; ≤0 = inverted/degenerate.
// Works in 3D using the cell's mean normal (suitable for inclined shells).
export function quadMinScaledJacobian(p0, p1, p2, p3) {
  const P = [p0, p1, p2, p3];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  // Mean normal (sum of the normals of the 4 corners).
  let nrm = [0, 0, 0];
  for (let i = 0; i < 4; i++) {
    const e1 = sub(P[(i + 1) % 4], P[i]), e2 = sub(P[(i + 3) % 4], P[i]);
    const c = cross(e1, e2);
    nrm = [nrm[0] + c[0], nrm[1] + c[1], nrm[2] + c[2]];
  }
  const nl = Math.hypot(...nrm) || 1; nrm = nrm.map(x => x / nl);
  let mn = Infinity;
  for (let i = 0; i < 4; i++) {
    const e1 = sub(P[(i + 1) % 4], P[i]), e2 = sub(P[(i + 3) % 4], P[i]);
    const l1 = Math.hypot(...e1), l2 = Math.hypot(...e2);
    if (l1 < 1e-12 || l2 < 1e-12) return -1;
    const c = cross(e1, e2);
    const sj = (c[0] * nrm[0] + c[1] * nrm[1] + c[2] * nrm[2]) / (l1 * l2);   // signed sine of the angle
    mn = Math.min(mn, sj);
  }
  return mn;
}

// Quality of the whole mesh: minimum scaled Jacobian over all QUAD cells.
export function meshQuality(pts, nx, ny) {
  const idx = (i, j) => i * (ny + 1) + j;
  let minJac = Infinity;
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
    const q = quadMinScaledJacobian(pts[idx(i, j)], pts[idx(i + 1, j)], pts[idx(i + 1, j + 1)], pts[idx(i, j + 1)]);
    minJac = Math.min(minJac, q);
  }
  return { minJac, inverted: minJac <= 0 };
}

// ── Welding of coincident points ─────────────────────────────────────────────────
// Returns { unique:[[x,y,z]…], remap:[origIdx→uniqueIdx] }. Spatial hash by cells of
// size tol → O(n) in practice.
export function weldPoints(points, tol = 1e-6) {
  const inv = 1 / Math.max(tol, 1e-12);
  const key = (p) => `${Math.round(p[0] * inv)},${Math.round(p[1] * inv)},${Math.round(p[2] * inv)}`;
  const map = new Map(); const unique = []; const remap = [];
  for (const p of points) {
    // Search in the cell and its neighbors (a point near the cell boundary).
    let found = -1;
    const bx = Math.round(p[0] * inv), by = Math.round(p[1] * inv), bz = Math.round(p[2] * inv);
    outer:
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const arr = map.get(`${bx + dx},${by + dy},${bz + dz}`);
      if (!arr) continue;
      for (const ui of arr) if (dist(unique[ui], p) <= tol) { found = ui; break outer; }
    }
    if (found < 0) { found = unique.length; unique.push(p); const k = key(p); if (!map.has(k)) map.set(k, []); map.get(k).push(found); }
    remap.push(found);
  }
  return { unique, remap };
}

// ── Integration with the Model ────────────────────────────────────────────────────
// Spatial index of the model's existing nodes (to weld the new mesh).
function nodeHash(model, tol) {
  const inv = 1 / Math.max(tol, 1e-12);
  const h = new Map();
  for (const n of model.nodes.values()) {
    const k = `${Math.round(n.x * inv)},${Math.round(n.y * inv)},${Math.round(n.z * inv)}`;
    if (!h.has(k)) h.set(k, []); h.get(k).push(n.id);
  }
  return { h, inv };
}
function findOrAddNode(model, hash, p, tol) {
  const { h, inv } = hash;
  const bx = Math.round(p[0] * inv), by = Math.round(p[1] * inv), bz = Math.round(p[2] * inv);
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
    const arr = h.get(`${bx + dx},${by + dy},${bz + dz}`);
    if (!arr) continue;
    for (const id of arr) { const n = model.nodes.get(id); if (n && Math.hypot(n.x - p[0], n.y - p[1], n.z - p[2]) <= tol) return id; }
  }
  const nd = model.addNode(p[0], p[1], p[2]);
  const k = `${bx},${by},${bz}`; if (!h.has(k)) h.set(k, []); h.get(k).push(nd.id);
  return nd.id;
}

/**
 * Meshes a 4-sided region within the model, welding to the existing nodes.
 * @param {Model} model
 * @param {object} edges  { bottom, right, top, left } polylines [[x,y,z]…] (or use
 *                        coonsGridFromCorners for 4 corners)
 * @param {object} opts   { nx, ny, tri, thickness, behavior, planeStrain, matId, weldTol }
 * @returns { nodeIds, areaIds, minJac }
 */
export function meshRegionIntoModel(model, edges, opts = {}) {
  const nx = Math.max(1, Math.round(opts.nx ?? 1)), ny = Math.max(1, Math.round(opts.ny ?? 1));
  const tri = !!opts.tri, tol = opts.weldTol ?? 1e-6;
  const pts = coonsGrid(edges, nx, ny);
  const { minJac } = meshQuality(pts, nx, ny);
  const matId = opts.matId ?? [...model.materials.keys()][0];
  const hash = nodeHash(model, tol);
  const nodeIds = pts.map(p => findOrAddNode(model, hash, p, tol));
  const areaIds = [];
  for (const cell of blockCells(nx, ny, tri)) {
    const a = model.addArea(cell.map(g => nodeIds[g]), matId,
      { thickness: opts.thickness ?? 0.2, behavior: opts.behavior ?? 'membrane', planeStrain: !!opts.planeStrain });
    if (a) areaIds.push(a.id);
  }
  return { nodeIds, areaIds, minJac };
}

// Meshes several patches (manual submapping of L/U/broken floor plans). Each patch
// = { edges|corners, nx, ny, tri?, thickness?, behavior?, planeStrain?, matId? }.
// Nodes shared between patches are welded → conforming mesh automatically.
export function meshPatchesIntoModel(model, patches, opts = {}) {
  const out = [];
  for (const pch of patches) {
    const edges = pch.edges || (pch.corners
      ? { bottom: [pch.corners[0], pch.corners[1]], right: [pch.corners[1], pch.corners[2]], top: [pch.corners[3], pch.corners[2]], left: [pch.corners[0], pch.corners[3]] }
      : null);
    if (!edges) throw new Error('parche sin edges ni corners');
    out.push(meshRegionIntoModel(model, edges, { ...opts, ...pch }));
  }
  return out;
}
