// ──────────────────────────────────────────────────────────────────────────────
// mesh_quality.js — mesh QUALITY and SMOOTHING · #52 (Phase 2)
//
// Per-element quality metrics (triangle and quadrilateral), global mesh statistics
// (worst cells + histogram) and constrained Laplacian SMOOTHING (moves the interior
// nodes without inverting elements). Works on generic lists nodes=[[x,y,z]…] and
// cells=[[i,j,k]|[i,j,k,l]…], so it serves both structured (mesh_map) and free
// (mesh_free) meshes. SELF-CONTAINED → verifiable in Node.
// ──────────────────────────────────────────────────────────────────────────────
import { quadMinScaledJacobian } from './mesh_map.js?v=7';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const DEG = 180 / Math.PI;

// Interior angle (degrees) at vertex b of triangle a-b-c.
function angleAt(a, b, c) {
  const u = sub(a, b), v = sub(c, b);
  const lu = norm(u), lv = norm(v);
  if (lu < 1e-15 || lv < 1e-15) return 0;
  let cosT = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (lu * lv);
  cosT = Math.min(1, Math.max(-1, cosT));
  return Math.acos(cosT) * DEG;
}

// Quality of a triangle: area, angles and normalized shape
//   q = 4√3·A / (a²+b²+c²)  ∈ (0,1]  (1 = equilateral, →0 = degenerate).
export function triQuality(p0, p1, p2) {
  const a = norm(sub(p1, p0)), b = norm(sub(p2, p1)), c = norm(sub(p0, p2));
  const area = 0.5 * norm(cross(sub(p1, p0), sub(p2, p0)));
  const ang = [angleAt(p2, p0, p1), angleAt(p0, p1, p2), angleAt(p1, p2, p0)];
  const sumSq = a * a + b * b + c * c;
  const quality = sumSq > 1e-30 ? 4 * Math.sqrt(3) * area / sumSq : 0;
  return { area, minAngle: Math.min(...ang), maxAngle: Math.max(...ang), quality };
}

// Quality of a quadrilateral: area, minimum scaled Jacobian (shape), angles,
// aspect ratio (longest/shortest side) and warp (degrees between the two halves).
export function quadQuality(p0, p1, p2, p3) {
  const P = [p0, p1, p2, p3];
  const e = [norm(sub(p1, p0)), norm(sub(p2, p1)), norm(sub(p3, p2)), norm(sub(p0, p3))];
  const ang = [angleAt(p3, p0, p1), angleAt(p0, p1, p2), angleAt(p1, p2, p3), angleAt(p2, p3, p0)];
  // area via two triangles
  const area = 0.5 * (norm(cross(sub(p1, p0), sub(p2, p0))) + norm(cross(sub(p2, p0), sub(p3, p0))));
  // warp: angle between the normals of (0,1,2) and (0,2,3)
  const n1 = cross(sub(p1, p0), sub(p2, p0)), n2 = cross(sub(p2, p0), sub(p3, p0));
  const l1 = norm(n1), l2 = norm(n2);
  let warp = 0;
  if (l1 > 1e-15 && l2 > 1e-15) {
    let cosW = (n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2]) / (l1 * l2);
    warp = Math.acos(Math.min(1, Math.max(-1, cosW))) * DEG;
  }
  return {
    area, minScaledJac: quadMinScaledJacobian(...P),
    minAngle: Math.min(...ang), maxAngle: Math.max(...ang),
    aspect: Math.max(...e) / Math.max(Math.min(...e), 1e-30), warp,
  };
}

// Global statistics of a mesh. cells = array of [i,j,k] or [i,j,k,l].
// Returns minima/maxima, worst cell, counts and a quality histogram (0..1).
export function meshStats(nodes, cells) {
  let minQ = Infinity, minJac = Infinity, minAng = Infinity, maxAng = -Infinity, maxAspect = 0, maxWarp = 0;
  let nTri = 0, nQuad = 0, worst = null;
  const hist = [0, 0, 0, 0, 0];   // [0-0.2,0.2-0.4,0.4-0.6,0.6-0.8,0.8-1]
  for (let ci = 0; ci < cells.length; ci++) {
    const c = cells[ci];
    if (c.length === 3) {
      nTri++;
      const q = triQuality(nodes[c[0]], nodes[c[1]], nodes[c[2]]);
      minAng = Math.min(minAng, q.minAngle); maxAng = Math.max(maxAng, q.maxAngle);
      hist[Math.min(4, Math.floor(q.quality * 5))]++;
      if (q.quality < minQ) { minQ = q.quality; worst = { cell: ci, type: 'tri', ...q }; }
    } else {
      nQuad++;
      const q = quadQuality(nodes[c[0]], nodes[c[1]], nodes[c[2]], nodes[c[3]]);
      minJac = Math.min(minJac, q.minScaledJac); minAng = Math.min(minAng, q.minAngle); maxAng = Math.max(maxAng, q.maxAngle);
      maxAspect = Math.max(maxAspect, q.aspect); maxWarp = Math.max(maxWarp, q.warp);
      const qn = Math.max(0, q.minScaledJac);
      hist[Math.min(4, Math.floor(qn * 5))]++;
      if (q.minScaledJac < minQ) { minQ = q.minScaledJac; worst = { cell: ci, type: 'quad', ...q }; }
    }
  }
  return { nTri, nQuad, n: cells.length, minQuality: minQ, minScaledJac: minJac, minAngle: minAng, maxAngle: maxAng, maxAspect, maxWarp, inverted: (minJac <= 0 || minAng <= 0), worst, hist };
}

// ── Adjacency and boundaries ─────────────────────────────────────────────────────
// Edges of a cell (pairs of local indices in polygon order).
function cellEdges(c) {
  const out = [];
  for (let i = 0; i < c.length; i++) out.push([c[i], c[(i + 1) % c.length]]);
  return out;
}

// BOUNDARY nodes = endpoints of edges belonging to a single cell.
export function boundaryNodes(nodes, cells) {
  const count = new Map();
  const key = (a, b) => a < b ? `${a},${b}` : `${b},${a}`;
  for (const c of cells) for (const [a, b] of cellEdges(c)) { const k = key(a, b); count.set(k, (count.get(k) || 0) + 1); }
  const bnd = new Set();
  for (const [k, n] of count) if (n === 1) { const [a, b] = k.split(',').map(Number); bnd.add(a); bnd.add(b); }
  return bnd;
}

// Neighbors of each node (through cell edges).
function nodeNeighbors(nodes, cells) {
  const nb = Array.from({ length: nodes.length }, () => new Set());
  for (const c of cells) for (const [a, b] of cellEdges(c)) { nb[a].add(b); nb[b].add(a); }
  return nb.map(s => [...s]);
}

// Checks that no cell incident to `ni` becomes inverted if the node moves to `p`.
function moveKeepsValid(nodes, cells, incident, ni, p) {
  const old = nodes[ni]; nodes[ni] = p;
  let ok = true;
  for (const ci of incident) {
    const c = cells[ci];
    const q = c.length === 3 ? triQuality(nodes[c[0]], nodes[c[1]], nodes[c[2]]).area
                             : quadMinScaledJacobian(nodes[c[0]], nodes[c[1]], nodes[c[2]], nodes[c[3]]);
    if (!(q > 1e-12)) { ok = false; break; }
  }
  nodes[ni] = old;
  return ok;
}

// NORMALIZED quality of a cell (0 = degenerate/inverted, 1 = ideal):
// triangle → 4√3·A/Σℓ² (1 = equilateral); quadrilateral → minimum scaled Jacobian.
function cellQuality(nodes, c) {
  return c.length === 3
    ? triQuality(nodes[c[0]], nodes[c[1]], nodes[c[2]]).quality
    : quadMinScaledJacobian(nodes[c[0]], nodes[c[1]], nodes[c[2]], nodes[c[3]]);
}

// Minimum quality among the cells incident to node `ni` (with the node at its current pos.).
function incidentMinQuality(nodes, cells, incident, ni) {
  let q = Infinity;
  for (const ci of incident) { const v = cellQuality(nodes, cells[ci]); if (v < q) q = v; }
  return q;
}

/**
 * CONSTRAINED Laplacian smoothing of the interior nodes. Moves each interior node
 * toward the centroid of its neighbors (factor ω). In "smart" mode (def.) the step
 * is accepted only if it does NOT reduce the minimum quality of the incident cells
 * (with a damped step search ω → ω/2 → ω/4); thus the mesh's minimum quality is
 * monotonically non-decreasing. The boundary nodes stay fixed.
 * @param {Array} nodes  [[x,y,z]…]  (a smoothed COPY is returned)
 * @param {Array} cells  [[i,j,k]|[i,j,k,l]…]
 * @param {object} opts  { iters=5, omega=0.5, fixed=Set|bool[], smart=true }
 * @returns { nodes, before, after, moved }
 */
export function laplacianSmooth(nodes, cells, opts = {}) {
  const iters = opts.iters ?? 5, omega = opts.omega ?? 0.5;
  const smart = opts.smart ?? true;
  const out = nodes.map(p => [p[0], p[1], p[2]]);
  const nb = nodeNeighbors(out, cells);
  const incident = Array.from({ length: out.length }, () => []);
  cells.forEach((c, ci) => c.forEach(n => incident[n].push(ci)));
  let fixed = opts.fixed;
  if (!fixed) { const b = boundaryNodes(out, cells); fixed = i => b.has(i); }
  else if (fixed instanceof Set) { const s = fixed; fixed = i => s.has(i); }
  else if (Array.isArray(fixed)) { const a = fixed; fixed = i => !!a[i]; }
  const before = meshStats(out, cells);
  let moved = 0;
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < out.length; i++) {
      if (fixed(i) || nb[i].length === 0) continue;
      let cx = 0, cy = 0, cz = 0;
      for (const j of nb[i]) { cx += out[j][0]; cy += out[j][1]; cz += out[j][2]; }
      const k = nb[i].length;
      const dir = [cx / k - out[i][0], cy / k - out[i][1], cz / k - out[i][2]];
      if (!smart) {
        const target = [out[i][0] + omega * dir[0], out[i][1] + omega * dir[1], out[i][2] + omega * dir[2]];
        if (moveKeepsValid(out, cells, incident[i], i, target)) { out[i] = target; if (it === 0) moved++; }
        continue;
      }
      // Smart: accept the (damped) step only if it improves the local minimum quality.
      const q0 = incidentMinQuality(out, cells, incident[i], i);
      const old = out[i]; let accepted = false;
      for (let w = omega; w >= omega / 4 - 1e-9; w *= 0.5) {
        const target = [old[0] + w * dir[0], old[1] + w * dir[1], old[2] + w * dir[2]];
        if (!moveKeepsValid(out, cells, incident[i], i, target)) continue;
        out[i] = target;
        if (incidentMinQuality(out, cells, incident[i], i) >= q0 - 1e-12) { accepted = true; break; }
        out[i] = old;
      }
      if (accepted && it === 0) moved++;
    }
  }
  return { nodes: out, before, after: meshStats(out, cells), moved };
}

// Applies the smoothing to a subset of model areas (in place). Rebuilds nodes/cells
// from the model, smooths and rewrites the coordinates of the non-fixed interior
// nodes. fixedExtra = Set of additional nodeIds to fix (e.g. with
// supports/loads/diaphragm). Returns the before/after meshStats report.
export function smoothAreasInModel(model, areaIds, opts = {}) {
  const ids = areaIds && areaIds.length ? areaIds : [...model.areas.keys()];
  const nodeIdList = []; const idxOf = new Map();
  const add = (nid) => { if (!idxOf.has(nid)) { idxOf.set(nid, nodeIdList.length); nodeIdList.push(nid); } };
  for (const aid of ids) { const a = model.areas.get(aid); if (a) a.nodes.forEach(add); }
  const nodes = nodeIdList.map(id => { const n = model.nodes.get(id); return [n.x, n.y, n.z]; });
  const cells = ids.map(aid => model.areas.get(aid)).filter(Boolean).map(a => a.nodes.map(n => idxOf.get(n)));
  // Fix nodes with supports, nodal loads, mass, diaphragm or belonging to bars.
  const extra = new Set(opts.fixedNodeIds || []);
  for (const n of model.nodes.values()) if (n.restraints && Object.values(n.restraints).some(v => v)) extra.add(n.id);
  for (const el of model.elements.values()) { extra.add(el.n1); extra.add(el.n2); }
  const fixedArr = nodeIdList.map(id => extra.has(id));
  const res = laplacianSmooth(nodes, cells, { ...opts, fixed: fixedArr });
  res.nodes.forEach((p, i) => model.updateNode(nodeIdList[i], { x: p[0], y: p[1], z: p[2] }));
  return { before: res.before, after: res.after };
}
