// ──────────────────────────────────────────────────────────────────────────────
// drift.js — INTERSTORY DRIFT, the primitive. Code-agnostic.
//
// The drift is always the same drift: the difference in lateral displacement between two
// levels, over the height between them. WHAT displacement represents a level — the
// diaphragm master (drift between centers of mass), the worst of a set of nodes (drift
// between external points), or any single point — is the caller's choice; this module
// only differences the series. It knows nothing about any code: the LIMIT (NCh433 0.002,
// ASCE7 0.020, …) lives in js/design/serviceability.js (driftLimit / checkDrift), so a
// new norm is one row there, never a change here.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Interstory drift ratios between consecutive levels. Pure geometry.
 *
 * @param {{z:number, u:number, label?:string}[]} levels
 *        each level's `u` is the lateral displacement (in one direction) that REPRESENTS
 *        it — the caller decides what that is. Order does not matter; sorted by z here.
 * @param {object} [opts]
 * @param {number} [opts.baseZ=0]  ground level z (implicit reference)
 * @param {number} [opts.baseU=0]  ground displacement
 * @param {number} [opts.hMin=1e-6] levels closer than this in z are merged (skipped)
 * @returns {{story:number, z:number, h:number, du:number, drift:number, label?:string}[]}
 *          `drift = |Δu|/h` (a ratio). No limit, no pass/fail — that is the code layer.
 */
export function interstoryDrifts(levels, { baseZ = 0, baseU = 0, hMin = 1e-6 } = {}) {
  const sorted = [...(levels || [])]
    .filter(L => L && Number.isFinite(L.z) && Number.isFinite(L.u))
    .sort((a, b) => a.z - b.z);

  const out = [];
  let prev = { z: baseZ, u: baseU };
  let story = 0;
  for (const cur of sorted) {
    const h = cur.z - prev.z;
    if (h <= hMin) { prev = cur; continue; }   // same level (or below base) → merge
    const du = cur.u - prev.u;
    story++;
    out.push({ story, z: cur.z, h, du, drift: Math.abs(du) / h, ...(cur.label ? { label: cur.label } : {}) });
    prev = cur;
  }
  return out;
}

/**
 * Build story levels from a model and a per-node displacement function. Still code-agnostic
 * and still a primitive — it only decides which node represents each floor.
 *
 * @param {Model}    model
 * @param {(nodeId:number)=>number} dispOf  lateral displacement of a node in the chosen
 *        direction (already signed or |abs|; interstoryDrifts abs-es the difference).
 * @param {object}  [opts]
 * @param {'cm'|'ext'|'auto'} [opts.mode='auto']
 *        'cm'   → each level's u is its diaphragm master's displacement (center of mass).
 *        'ext'  → each level's u is the max |displacement| over the level's nodes.
 *        'auto' → 'cm' if the model has diaphragms, else 'ext'.
 * @param {number}  [opts.zTol=0.01]  grouping tolerance when falling back to nodes-by-z.
 * @returns {{z:number, u:number, label:string, masterId:number|null, nodeIds:number[]}[]}
 */
export function buildStoryLevels(model, dispOf, { mode = 'auto', zTol = 0.01 } = {}) {
  const diaphs = [...model.diaphragms.values()];
  const useCM = mode === 'cm' || (mode === 'auto' && diaphs.length > 0);

  let levels;
  if (diaphs.length) {
    levels = diaphs.map(d => {
      const masterId = d.masterId ?? (d.nodes && d.nodes[0]) ?? null;
      const nodeIds = (d.nodes || []).filter(id => model.nodes.has(id));
      const u = useCM && masterId != null && model.nodes.has(masterId)
        ? dispOf(masterId)
        : nodeIds.reduce((mx, id) => Math.max(mx, Math.abs(dispOf(id))), 0);
      return { z: d.z, u, label: d.name || `z=${d.z}`, masterId, nodeIds };
    });
  } else {
    // No diaphragms: group nodes by z (skip the base) and take the worst per level.
    const round = z => Math.round(z / zTol) * zTol;
    const byZ = new Map();
    for (const n of model.nodes.values()) {
      if (Math.abs(n.z) < zTol) continue;          // base level
      const zk = round(n.z);
      if (!byZ.has(zk)) byZ.set(zk, []);
      byZ.get(zk).push(n.id);
    }
    levels = [...byZ.entries()].map(([z, ids]) => ({
      z, u: ids.reduce((mx, id) => Math.max(mx, Math.abs(dispOf(id))), 0),
      label: `z=${z}`, masterId: null, nodeIds: ids,
    }));
  }
  return levels.sort((a, b) => a.z - b.z);
}
