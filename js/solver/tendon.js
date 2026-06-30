// ──────────────────────────────────────────────────────────────────────────────
// tendon.js — TENDON PRESTRESS (equivalent loads) · #60
//
// EQUIVALENT LOADS method (load balancing, T.Y. Lin): a tendon with a curved
// profile and force P exerts on the concrete a system of loads that can be replaced
// by ordinary gravity/nodal loads, which the linear solver already handles. For a
// PARABOLIC tendon with sag `a` (relative to the chord joining the anchors) over a
// span L:
//
//     w_eq = 8 · P · a / L²      (UPWARD if the tendon hangs below the axis)
//
// plus, at each anchor, an axial force P (compression) and, if the anchor is
// eccentric (e≠0), a moment P·e. The PRIMARY moment at any section is M(x)=P·e(x).
//
// POLYGONAL profile: at each break point the tendon applies a transverse point load
// equal to P·(slope change).
//
// Losses: friction/wobble model  P(x) = P0·e^(−(μ·θ + k·x))  (θ = accumulated
// angular change) and/or a global lump-sum fraction. The equivalent load uses the
// mean EFFECTIVE force along the tendon.
//
// Model convention: the beam is assumed roughly horizontal (global X axis) with
// bending in the X–Z plane; `e` (eccentricity) is POSITIVE DOWNWARD (−Z), the
// typical case of a hanging tendon. Load `gravity` w>0 = ↓, w<0 = ↑.
// ──────────────────────────────────────────────────────────────────────────────

// Length of an element.
function elemLen(model, el) {
  const a = model.nodes.get(el.n1), b = model.nodes.get(el.n2);
  return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
}

// Effective tendon force with friction/wobble + lump-sum losses.
//   tendon.jack  = P0 (kN) at the jack (active end)
//   tendon.P     = direct effective force (if given, used as-is)
//   tendon.friction = { mu, k }  (μ per radian, k per meter)
//   tendon.lumpSum  = additional global loss fraction (0..1) (shrinkage, creep,
//                     long-term relaxation, elastic shortening)
//   a = sag, L = span  (to estimate the parabola's total angular change)
// Returns { P0, Pavg, Pend } (Pend = at the passive end, the lowest).
export function tendonForce(tendon, L, a) {
  if (tendon.P != null && tendon.jack == null) {
    const P = +tendon.P; return { P0: P, Pavg: P, Pend: P };
  }
  const P0 = +tendon.jack || 0;
  const fr = tendon.friction || {};
  const mu = +fr.mu || 0, k = +fr.k || 0;
  // Total angular change of a parabola with sag a and span L: end slope = 4a/L;
  // from one end to the other the accumulated turn ≈ 8a/L.
  const thetaTot = L > 0 ? 8 * Math.abs(a) / L : 0;
  const Pend = P0 * Math.exp(-(mu * thetaTot + k * L));
  // Mean P along the length (integral of the exponential ≈ endpoint average for small β).
  let Pavg = (P0 + Pend) / 2;
  const lump = Math.min(Math.max(+tendon.lumpSum || 0, 0), 1);
  Pavg *= (1 - lump); const PendEff = Pend * (1 - lump);
  return { P0, Pavg, Pend: PendEff };
}

// Eccentricity of the profile at the span fraction s∈[0,1] (positive ↓).
//   parabola: e(s) = e1 + (e2−e1)·s + 4·a·s(1−s),  a = em − (e1+e2)/2  (sag)
export function tendonEcc(tendon, s) {
  const e1 = +tendon.e?.start || 0, e2 = +tendon.e?.end || 0, em = +tendon.e?.mid || 0;
  const a = em - (e1 + e2) / 2;
  return e1 + (e2 - e1) * s + 4 * a * s * (1 - s);
}

/**
 * Equivalent loads of a tendon → array of model loads
 * ({type:'dist'…} and {type:'nodal'…}) ready to add to a load case.
 *
 * @param {Model}  model
 * @param {object} tendon
 *    elems   : [elemId…] COLLINEAR elements forming the beam (in order).
 *    profile : 'parabola' (def.) | 'polygon'
 *    e       : { start, mid, end }  eccentricities ↓+ (m) — parabola
 *    points  : [{s,e}]              break points (s∈[0,1], e ↓+) — polygonal
 *    P | jack/friction/lumpSum      effective or jacking force + losses
 * @returns {{loads: Array, P: number, weq: number, L: number}}
 */
export function tendonEquivalentLoads(model, tendon) {
  const elems = (tendon.elems || []).map(id => model.elements.get(id)).filter(Boolean);
  if (!elems.length) throw new Error('tendón sin elementos válidos');

  // Total span and accumulated position (s) of each node along the tendon.
  const lens = elems.map(e => elemLen(model, e));
  const L = lens.reduce((x, y) => x + y, 0);
  if (!(L > 0)) throw new Error('tendón de luz nula');

  // End nodes and axial direction of the first/last element (unit).
  const first = elems[0], last = elems[elems.length - 1];
  const nA = model.nodes.get(first.n1), nB = model.nodes.get(last.n2);
  const axA = unit(nA, model.nodes.get(first.n2));   // from node A toward the interior
  const axB = unit(nB, model.nodes.get(last.n1));    // from node B toward the interior

  const e1 = +tendon.e?.start || 0, e2 = +tendon.e?.end || 0, em = +tendon.e?.mid || 0;
  const a  = em - (e1 + e2) / 2;                       // sag relative to the chord
  const { Pavg: P } = tendonForce(tendon, L, a);

  const loads = [];
  let weq = 0;

  if ((tendon.profile || 'parabola') === 'parabola') {
    // Uniform equivalent load (↑ if a>0): w = 8 P a / L². In the model,
    // gravity w>0 = ↓, so an upward push is w_model = −8Pa/L².
    weq = 8 * P * a / (L * L);                         // physical magnitude (↑+)
    for (const e of elems) loads.push({ type: 'dist', elemId: e.id, dir: 'gravity', w: -weq });
  } else {
    // Polygonal: point load at each break = P·(Δslope). Distributed to the element
    // containing the point via shape functions (consistent).
    const pts = (tendon.points || []).slice().sort((p, q) => p.s - q.s);
    for (let i = 1; i < pts.length - 1; i++) {
      const sPrev = pts[i - 1].s, sCur = pts[i].s, sNext = pts[i + 1].s;
      const slopeIn  = (pts[i].e - pts[i - 1].e) / ((sCur - sPrev) * L);
      const slopeOut = (pts[i + 1].e - pts[i].e) / ((sNext - sCur) * L);
      const dSlope = slopeOut - slopeIn;              // slope change (↓+)
      const Fup = P * dSlope;                          // upward force ↑ (if the break hangs)
      addTransversePoint(model, elems, lens, L, sCur * L, -Fup, loads);
    }
  }

  // Anchors: axial P (compression) + moment P·e at each end (if eccentric).
  // Axial force toward the member interior at each anchor → compression P.
  loads.push({ type: 'nodal', nodeId: nA.id, F: [P * axA[0], P * axA[1], P * axA[2], 0, 0, 0] });
  loads.push({ type: 'nodal', nodeId: nB.id, F: [P * axB[0], P * axB[1], P * axB[2], 0, 0, 0] });
  // Primary anchor moment M = P·e (bending in the X–Z plane → global moment My).
  // e ↓+: a compression P applied below the axis produces a moment that tensions the
  // bottom fiber (sagging). With the model's My convention the anchor moment that
  // reproduces M(x)=P·e at the end is −P·e at the start node and +P·e at the end.
  if (Math.abs(e1) > 1e-12) addEndMoment(loads, nA.id, -P * e1);
  if (Math.abs(e2) > 1e-12) addEndMoment(loads, nB.id, +P * e2);

  return { loads, P, weq, L };
}

// Convenience: applies the tendon loads to a model load case.
export function applyTendon(model, lcId, tendon) {
  const { loads } = tendonEquivalentLoads(model, tendon);
  const lc = model.loadCases.get(lcId);
  if (!lc) throw new Error('caso de carga inexistente: ' + lcId);
  for (const ld of loads) lc.loads.push(ld);
  return loads;
}

// ── helpers ─────────────────────────────────────────────────────────────────
function unit(from, to) {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  const L = Math.hypot(dx, dy, dz) || 1; return [dx / L, dy / L, dz / L];
}

function addEndMoment(loads, nodeId, My) {
  loads.push({ type: 'nodal', nodeId, F: [0, 0, 0, 0, My, 0] });
}

// Distributes a transverse point load (global vertical Z, sign in `Fz`) located at
// distance `x` from the start of the tendon, to the element that contains it, via
// cubic Hermite shape functions (consistent nodal forces and moments).
function addTransversePoint(model, elems, lens, L, x, Fz, loads) {
  let acc = 0, idx = 0;
  for (; idx < elems.length; idx++) { if (x <= acc + lens[idx] + 1e-9) break; acc += lens[idx]; }
  idx = Math.min(idx, elems.length - 1);
  const el = elems[idx], Le = lens[idx];
  const xi = Math.min(Math.max((x - acc) / Le, 0), 1);
  const n1 = model.nodes.get(el.n1), n2 = model.nodes.get(el.n2);
  // Beam shape functions (upward global vertical load): consistent distribution.
  const N1 = 1 - 3 * xi * xi + 2 * xi ** 3, N2 = 3 * xi * xi - 2 * xi ** 3;
  const M1 =  Le * (xi - 2 * xi * xi + xi ** 3), M2 = Le * (-xi * xi + xi ** 3);
  // Fz global vertical (Z); associated bending moment → My (X–Z plane).
  loads.push({ type: 'nodal', nodeId: n1.id, F: [0, 0, Fz * N1, 0, -Fz * M1, 0] });
  loads.push({ type: 'nodal', nodeId: n2.id, F: [0, 0, Fz * N2, 0, -Fz * M2, 0] });
}
