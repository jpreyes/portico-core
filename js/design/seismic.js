// ──────────────────────────────────────────────────────────────────────────────
// seismic.js — SEISMIC capacity–demand detailing (#68).
//
// "Strong column – weak beam" (ACI 318-19 §18.7.3.2 / AISC 341): at each joint, the
// sum of the flexural capacities of the COLUMNS must exceed that of the BEAMS by a
// factor γ (6/5=1.2 in ACI; 1.0 with overstrength in AISC):
//
//     Σ Mnc  ≥  γ · Σ Mnb
//
// The module is analysis-agnostic: it receives the nominal capacities Mn of each bar
// (via an `MnOf` callback) and the model topology, classifies each bar reaching the
// joint as column/beam by its verticality, and returns the demand/capacity ratio per
// joint.
// ──────────────────────────────────────────────────────────────────────────────

// Pointwise strong-column weak-beam check. Returns demand/capacity/ratio.
export function strongColumnWeakBeam({ sumMnc, sumMnb, gamma = 1.2 }) {
  const dem = gamma * sumMnb, cap = sumMnc;
  return {
    demand: +dem.toFixed(4), capacity: +cap.toFixed(4),
    ratio: cap > 1e-12 ? +(dem / cap).toFixed(4) : Infinity,
    ok: cap >= dem - 1e-9,
    formula: `ΣMnc ≥ ${gamma}·ΣMnb (columna fuerte–viga débil)`,
  };
}

// Classifies a bar by its verticality: 'column' | 'beam' | 'brace'.
export function classifyMember(n1, n2) {
  const dx = n2.x - n1.x, dy = n2.y - n1.y, dz = n2.z - n1.z;
  const L = Math.hypot(dx, dy, dz) || 1;
  const vert = Math.abs(dz) / L;
  return vert > 0.8 ? 'column' : vert < 0.2 ? 'beam' : 'brace';
}

/**
 * Walks the model joints and applies the strong-column weak-beam check.
 * @param {Model} model
 * @param {(elemId)=>number} MnOf  NOMINAL flexural capacity of the bar (kN·m).
 * @param {object} opts  { gamma = 1.2 }
 * @returns [{ node, sumMnc, sumMnb, ratio, ok, nCol, nBeam }]  (only joints with
 *          at least one column and one beam; sorted by descending ratio).
 */
export function jointSCWB(model, MnOf, opts = {}) {
  const gamma = opts.gamma ?? 1.2;
  // Bars connected to each node.
  const byNode = new Map();
  for (const el of model.elements.values()) {
    for (const nid of [el.n1, el.n2]) { if (!byNode.has(nid)) byNode.set(nid, []); byNode.get(nid).push(el); }
  }
  const out = [];
  for (const [nid, els] of byNode) {
    let sumMnc = 0, sumMnb = 0, nCol = 0, nBeam = 0;
    for (const el of els) {
      const n1 = model.nodes.get(el.n1), n2 = model.nodes.get(el.n2);
      if (!n1 || !n2) continue;
      const kind = classifyMember(n1, n2);
      const Mn = Math.abs(MnOf(el.id) || 0);
      if (kind === 'column') { sumMnc += Mn; nCol++; }
      else if (kind === 'beam') { sumMnb += Mn; nBeam++; }
    }
    if (nCol && nBeam) {
      const r = strongColumnWeakBeam({ sumMnc, sumMnb, gamma });
      out.push({ node: nid, sumMnc: +sumMnc.toFixed(2), sumMnb: +sumMnb.toFixed(2), ratio: r.ratio, ok: r.ok, nCol, nBeam });
    }
  }
  out.sort((a, b) => b.ratio - a.ratio);
  return out;
}
