// ──────────────────────────────────────────────────────────────────────────────
// Diaphragm — rigid diaphragm constraints + mass discretisation
//
// Master node = Center of Rigidity (CR):
//   x_CR = Σ(Ky_j · xj) / Σ(Ky_j)   Ky_j = 12·E·Iy_j/h_j³
//   y_CR = Σ(Kx_j · yj) / Σ(Kx_j)   Kx_j = 12·E·Iz_j/h_j³
//   (vertical columns: local y = global X, local z = global Y)
//
// Mass distribution: m distributed to structural nodes by tributary area.
// Tributary area = half-span of connected FLOOR BEAMS in each direction.
// This correctly clips to the real floor boundary (handles L-shapes, etc.).
//
// Accidental eccentricity (ex_acc, ey_acc): adds coupling terms at master:
//   M[UX_m][RZ_m] += −m·ey_acc,  M[UY_m][RZ_m] += m·ex_acc  (+ symmetric)
//   M[RZ_m][RZ_m] += m·(ex_acc² + ey_acc² + 2·ex_nat·ex_acc + 2·ey_nat·ey_acc)
//   where ex_nat = xcm − x_CR (natural eccentricity, already in distributed mass)
// ──────────────────────────────────────────────────────────────────────────────

// 1e5: stiff enough (<0.001% constraint error); 1e8 over-conditions K and
// breaks Stodola convergence.
const PENALTY_FACTOR = 1e5;

// ── Tributary weights by beam connectivity ────────────────────────────────────
/**
 * Compute tributary area weights for floor nodes using the ACTUAL beam
 * connectivity at floor level. For each node the tributary half-span in X
 * equals the average half-length of its horizontal (floor-level) beam neighbours
 * in the X direction, and similarly for Y.
 *
 * This correctly handles L-shapes and other irregular floors: nodes that are
 * at the perimeter of a partial wing receive no credit for the empty space
 * beyond them, because no floor beam spans that gap.
 *
 * Falls back to the axis-aligned grid method when no floor beams are found
 * (e.g. nodes connected only by columns, or manually placed diaphragm nodes
 * not yet joined by beams).
 *
 * @param {object[]} nodes    — array of {id, x, y, z} model nodes on this floor
 * @param {Model}    model    — full model (to access elements)
 * @param {number}   floorZ  — Z coordinate of the floor
 * @param {number}   zTol    — tolerance to decide "horizontal" (default 0.01)
 */
function _tributaryWeights(nodes, model, floorZ, zTol = 0.01) {
  if (nodes.length === 0) return new Map();
  if (nodes.length === 1) return new Map([[nodes[0].id, 1]]);

  const floorNodeSet = new Set(nodes.map(n => n.id));

  // Build per-node tributary span accumulator {x: [spans], y: [spans]}
  const spans = new Map();
  for (const n of nodes) spans.set(n.id, { x: [], y: [] });

  let hasBeams = false;

  for (const elem of model.elements.values()) {
    const n1 = model.nodes.get(elem.n1);
    const n2 = model.nodes.get(elem.n2);
    if (!n1 || !n2) continue;
    if (!floorNodeSet.has(n1.id) || !floorNodeSet.has(n2.id)) continue;

    // Check element is horizontal (floor beam): both ends at same Z ≈ floorZ
    if (Math.abs(n1.z - floorZ) > zTol || Math.abs(n2.z - floorZ) > zTol) continue;

    const dx = Math.abs(n2.x - n1.x);
    const dy = Math.abs(n2.y - n1.y);
    const L  = Math.sqrt(dx*dx + dy*dy);
    if (L < 1e-9) continue;

    hasBeams = true;

    // Classify as primarily X-beam or Y-beam
    if (dx >= dy) {
      // X-direction beam: contributes to X tributary of both end nodes
      const half = L / 2;
      spans.get(n1.id).x.push(half);
      spans.get(n2.id).x.push(half);
    } else {
      // Y-direction beam
      const half = L / 2;
      spans.get(n1.id).y.push(half);
      spans.get(n2.id).y.push(half);
    }
  }

  if (!hasBeams) {
    // Fallback: axis-aligned grid (original method, works for rectangular floors)
    return _tributaryWeightsGrid(nodes);
  }

  // Tributary area = sum_x_spans × sum_y_spans
  let totalArea = 0;
  const areas = new Map();
  for (const n of nodes) {
    const sp = spans.get(n.id);
    const wx = sp.x.reduce((s, v) => s + v, 0);
    const wy = sp.y.reduce((s, v) => s + v, 0);
    const a  = wx * wy;
    areas.set(n.id, a);
    totalArea += a;
  }

  if (totalArea < 1e-30) return _tributaryWeightsGrid(nodes);

  return new Map(nodes.map(n => [n.id, (areas.get(n.id) || 0) / totalArea]));
}

/** Fallback: axis-aligned grid tributary areas */
function _tributaryWeightsGrid(nodes) {
  const snap = v => Math.round(v * 1e6) / 1e6;
  const xs = [...new Set(nodes.map(n => snap(n.x)))].sort((a, b) => a - b);
  const ys = [...new Set(nodes.map(n => snap(n.y)))].sort((a, b) => a - b);

  const xw = new Map();
  for (let i = 0; i < xs.length; i++) {
    const L = i > 0             ? (xs[i] - xs[i-1]) / 2 : 0;
    const R = i < xs.length - 1 ? (xs[i+1] - xs[i]) / 2 : 0;
    xw.set(xs[i], L + R);
  }
  const yw = new Map();
  for (let i = 0; i < ys.length; i++) {
    const D = i > 0             ? (ys[i] - ys[i-1]) / 2 : 0;
    const U = i < ys.length - 1 ? (ys[i+1] - ys[i]) / 2 : 0;
    yw.set(ys[i], D + U);
  }

  let totalArea = 0;
  const areas = new Map();
  for (const n of nodes) {
    const a = (xw.get(snap(n.x)) || 0) * (yw.get(snap(n.y)) || 0);
    areas.set(n.id, a);
    totalArea += a;
  }

  if (totalArea < 1e-30) {
    const eq = 1 / nodes.length;
    return new Map(nodes.map(n => [n.id, eq]));
  }

  return new Map(nodes.map(n => [n.id, (areas.get(n.id) || 0) / totalArea]));
}

// ── Center of Rigidity ────────────────────────────────────────────────────────
/**
 * Compute CR from lateral stiffness of vertical columns (12EI/h³).
 * For vertical columns: local y = global X (uses Iz), local z = global Y (uses Iy).
 *   Kx = 12·E·Iz/h³  →  y_CR = Σ(Kx·y) / ΣKx
 *   Ky = 12·E·Iy/h³  →  x_CR = Σ(Ky·x) / ΣKy
 *
 * Recalculated fresh every time it is needed (no stale-data risk).
 */
export function computeFloorCR(model, floorNodeSet, floorZ, zTol = 0.01) {
  let sumKy_x = 0, sumKy = 0;
  let sumKx_y = 0, sumKx = 0;

  for (const elem of model.elements.values()) {
    const n1 = model.nodes.get(elem.n1);
    const n2 = model.nodes.get(elem.n2);
    if (!n1 || !n2) continue;

    const dz = n2.z - n1.z;
    const L  = Math.sqrt((n2.x-n1.x)**2 + (n2.y-n1.y)**2 + dz**2);
    if (L < 1e-12 || Math.abs(dz/L) < 0.9994) continue;  // skip non-vertical

    // Floor CR = stiffness of the STORY BELOW: each column is counted ONLY at its
    // TOP node (the one reaching this floor). It used to be counted at either of its
    // two nodes → interior columns were double-counted (floor above and below) and
    // the CR came out shifted in irregular/multistory buildings.
    const top = n1.z >= n2.z ? n1 : n2;     // top node of the column
    if (!(Math.abs(top.z - floorZ) < zTol && floorNodeSet.has(top.id))) continue;
    const topNode = top;

    const mat = model.materials.get(elem.matId);
    const sec = model.sections.get(elem.secId);
    if (!mat || !sec) continue;

    const h3 = L*L*L;
    const Kx = 12 * mat.E * sec.Iz / h3;   // resists global-X
    const Ky = 12 * mat.E * sec.Iy / h3;   // resists global-Y

    sumKy_x += Ky * topNode.x;  sumKy += Ky;
    sumKx_y += Kx * topNode.y;  sumKx += Kx;
  }

  if (sumKy < 1e-30 || sumKx < 1e-30) return null;
  return { x: sumKy_x / sumKy, y: sumKx_y / sumKx };
}

// ── CM from tributary-weighted centroid ───────────────────────────────────────
/**
 * Mass-weighted centroid of floor nodes using the same tributary weights.
 * If diaphragm mass m > 0 the tributary distribution defines the CM.
 * If m == 0 (constraint-only diaphragm) we return the geometric centroid.
 */
function _floorCM(nodes, weights) {
  let wx = 0, wy = 0;
  for (const n of nodes) {
    const f = weights.get(n.id) || 0;
    wx += f * n.x;
    wy += f * n.y;
  }
  return { x: wx, y: wy };  // weights already sum to 1
}

// ── Writers ───────────────────────────────────────────────────────────────────
// Minimal abstraction to write into the global matrix: the DENSE path writes into a
// Float64Array (n×n), the SPARSE path writes into a SparseSym. This keeps the
// diaphragm penalty/mass logic in ONE single source.
function denseWriter(K, nDOF) {
  return { add: (i, j, v) => { K[i * nDOF + j] += v; }, diag: (i) => K[i * nDOF + i] };
}

// ── Diaphragm constraints ─────────────────────────────────────────────────────
export function applyDiaphragmConstraints(K, model, nodeIndex, nDOF) {
  applyDiaphragmConstraintsW(denseWriter(K, nDOF), model, nodeIndex, nDOF);
}

// Variant with a writer (dense or sparse).
export function applyDiaphragmConstraintsW(W, model, nodeIndex, nDOF) {
  if (model.diaphragms.size === 0) return;

  let maxKii = 0;
  for (let i = 0; i < nDOF; i++) {
    const v = W.diag(i);
    if (v > maxKii) maxKii = v;
  }
  const alpha = maxKii > 0 ? maxKii * PENALTY_FACTOR : 1e12;

  for (const d of model.diaphragms.values()) {
    _constrainDiaphragm(W, d, model, nodeIndex, alpha);
  }
}

function _constrainDiaphragm(W, diaphragm, model, nodeIndex, alpha) {
  const nodeIds = diaphragm.nodes.filter(id => model.nodes.has(id));
  if (nodeIds.length < 2) return;

  const masterId = diaphragm.masterId || nodeIds[0];
  const master   = model.nodes.get(masterId);
  if (!master) return;
  const im = nodeIndex.get(masterId);
  if (im == null) return;

  const MUX = 6*im, MUY = 6*im+1, MRZ = 6*im+5;

  for (const slaveId of nodeIds) {
    if (slaveId === masterId) continue;
    const slave = model.nodes.get(slaveId);
    if (!slave) continue;
    const is = nodeIndex.get(slaveId);
    if (is == null) continue;

    const SUX = 6*is, SUY = 6*is+1, SRZ = 6*is+5;
    const dx = slave.x - master.x;
    const dy = slave.y - master.y;

    _addPenalty(W, alpha, [SUX, MUX, MRZ], [1, -1, dy]);   // ux_s - ux_m + dy·rz_m = 0
    _addPenalty(W, alpha, [SUY, MUY, MRZ], [1, -1, -dx]);  // uy_s - uy_m - dx·rz_m = 0
    _addPenalty(W, alpha, [SRZ, MRZ],      [1, -1]);        // rz_s - rz_m = 0
  }
}

function _addPenalty(W, alpha, dofs, coeffs) {
  for (let i = 0; i < dofs.length; i++)
    for (let j = 0; j < dofs.length; j++)
      W.add(dofs[i], dofs[j], alpha * coeffs[i] * coeffs[j]);
}

// ── Diaphragm mass — tributary + accidental eccentricity ──────────────────────
/**
 * Called at every modal/static analysis (via assembleK) — always uses the
 * CURRENT diaphragm.mass.m and diaphragm.eccentricity values.
 *
 * Step 1 — Distribute m to structural nodes by beam-connectivity tributary area.
 *   Adds mᵢ to M[UXᵢ][UXᵢ] and M[UYᵢ][UYᵢ].
 *   Rotational inertia Io = Σ mᵢ·rᵢ² emerges from the rigid-body coupling
 *   through the constraint; no explicit Icm at master is needed.
 *   The natural eccentricity (xcm − x_CR) is captured automatically this way.
 *
 * Step 2 — Accidental eccentricity correction at master (CR node).
 *   Shifts the effective CM by (ex_acc, ey_acc):
 *     M[UX_m][RZ_m] += −m·ey_acc   (+ symmetric)
 *     M[UY_m][RZ_m] += +m·ex_acc   (+ symmetric)
 *     M[RZ_m][RZ_m] += m·(ex_acc²+ey_acc²) + 2m·(ex_nat·ex_acc + ey_nat·ey_acc)
 *   where ex_nat = xcm − x_CR (natural eccentricity).
 *   This does NOT double-count the natural eccentricity because the
 *   distributed-mass step already handles it.
 *
 * Step 3 — Optional explicit Icm at master RZ (user-supplied correction).
 */
export function applyDiaphragmMass(M, model, nodeIndex, nDOF) {
  applyDiaphragmMassW(denseWriter(M, nDOF), model, nodeIndex);
}

// Variant with a writer (dense or sparse). nDOF is unused (the writer encapsulates
// the storage); the dense signature is kept for compatibility.
export function applyDiaphragmMassW(W, model, nodeIndex) {
  for (const diaphragm of model.diaphragms.values()) {
    const { mass, eccentricity, nodes } = diaphragm;
    if (!mass) continue;

    const m    = mass.m   || 0;
    const Icm  = mass.Icm || 0;
    const ex_a = eccentricity?.ex ?? 0;   // accidental eccentricity X
    const ey_a = eccentricity?.ey ?? 0;   // accidental eccentricity Y
    if (m <= 0 && Icm <= 0) continue;

    // ── Get master node ──────────────────────────────────────────────────────
    const masterId = diaphragm.masterId || nodes[0];
    const master   = model.nodes.get(masterId);
    const im       = master ? nodeIndex.get(masterId) : null;

    if (m > 0) {
      // ── Step 1: distribute to floor nodes by beam-connectivity tributary ──
      const floorZ     = diaphragm.z;
      const floorNodes = nodes
        .filter(id => model.nodes.has(id))
        .map(id => model.nodes.get(id));
      if (floorNodes.length === 0) continue;

      const weights = _tributaryWeights(floorNodes, model, floorZ);

      // Recompute CM from this distribution (always fresh, no stale data)
      const cm_fresh = _floorCM(floorNodes, weights);

      for (const node of floorNodes) {
        const idx = nodeIndex.get(node.id);
        if (idx == null) continue;
        const mi = m * (weights.get(node.id) || 0);
        if (mi < 1e-30) continue;
        W.add(6*idx,   6*idx,   mi);   // UX
        W.add(6*idx+1, 6*idx+1, mi);   // UY
      }

      // ── Step 2: accidental eccentricity correction at master ─────────────
      if ((ex_a !== 0 || ey_a !== 0) && im != null) {
        const MUX = 6*im, MUY = 6*im+1, MRZ = 6*im+5;

        // Natural eccentricity (CM − CR/master), for cross-term in Steiner
        const ex_n = cm_fresh.x - (master?.x ?? 0);
        const ey_n = cm_fresh.y - (master?.y ?? 0);

        // Off-diagonal coupling from accidental shift
        W.add(MUX, MRZ, -m * ey_a);
        W.add(MRZ, MUX, -m * ey_a);
        W.add(MUY, MRZ,  m * ex_a);
        W.add(MRZ, MUY,  m * ex_a);

        // Steiner correction: ΔIo = m·(ea²) + 2m·(e_nat·e_acc)
        const deltaIo = m * (ex_a*ex_a + ey_a*ey_a)
                      + 2*m * (ex_n*ex_a + ey_n*ey_a);
        W.add(MRZ, MRZ, deltaIo);
      }
    }

    // ── Step 3: optional explicit Icm at master ────────────────────────────
    if (Icm > 0 && im != null) {
      W.add(6*im+5, 6*im+5, Icm);
    }
  }
}

// ── Auto-detect floors ────────────────────────────────────────────────────────
/**
 * For each Z-level with ≥ 2 nodes:
 *   1. Compute CM  = tributary-weighted centroid.
 *   2. Compute CR  = stiffness-weighted centroid of vertical columns.
 *   3. Create (or reuse) master node at CR (falls back to CM if no columns found).
 *
 * Returns { diaphragms, nodes } — `nodes` lists newly created master nodes.
 */
export function autoDetectDiaphragms(model, zTol = 0.01, skipGroundFloor = true) {
  const floors = new Map();

  for (const node of model.nodes.values()) {
    if (skipGroundFloor && Math.abs(node.z) < zTol) continue;
    const zKey = Math.round(node.z / zTol) * zTol;
    if (!floors.has(zKey)) floors.set(zKey, []);
    floors.get(zKey).push(node.id);
  }

  const createdDiaphragms = [];
  const createdNodes      = [];

  for (const [z, nodeIds] of [...floors.entries()].sort((a, b) => a[0] - b[0])) {
    if (nodeIds.length < 2) continue;

    const alreadyExists = [...model.diaphragms.values()]
      .some(d => Math.abs(d.z - z) < zTol);
    if (alreadyExists) continue;

    const floorNodes   = nodeIds.map(id => model.nodes.get(id));
    const floorNodeSet = new Set(nodeIds);

    // CM from beam-connectivity tributary weights
    const weights  = _tributaryWeights(floorNodes, model, z, zTol);
    const cm       = _floorCM(floorNodes, weights);

    // CR from column lateral stiffness
    const cr       = computeFloorCR(model, floorNodeSet, z, zTol);
    const masterPos = cr ?? cm;

    // Find or create master node at CR/CM
    const CTOL = 0.01;
    let masterNode = floorNodes.find(n =>
      Math.abs(n.x - masterPos.x) < CTOL &&
      Math.abs(n.y - masterPos.y) < CTOL
    );
    let masterId;
    if (masterNode) {
      masterId = masterNode.id;
    } else {
      // Virtual master: restrain out-of-plane DOFs (no element connections)
      masterNode = model.addNode(masterPos.x, masterPos.y, z, { uz: 1, rx: 1, ry: 1 });
      masterId   = masterNode.id;
      nodeIds.push(masterId);
      createdNodes.push(masterNode);
    }

    const d = model.addDiaphragm({
      name:         `Piso Z=${z}`,
      z,
      nodes:        [...nodeIds],
      masterId,
      cm,
      cr:           cr ?? cm,
      mass:         { m: 0, Icm: 0 },
      eccentricity: { ex: 0, ey: 0 }
    });
    createdDiaphragms.push(d);
  }

  return { diaphragms: createdDiaphragms, nodes: createdNodes };
}

// ── Exported helpers for UI (CM/CR recalculation, mass display) ───────────────
export const computeFloorCM           = _floorCM;
export const computeTributaryWeights  = _tributaryWeights;
