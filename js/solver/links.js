// ──────────────────────────────────────────────────────────────────────────────
// links.js — LINKS / COUPLINGS between nodes (kinematic constraints) · bridges
//
// They tie two nodes at different positions, without an element between them. The
// typical bridge case: the DECK is modeled on its axis (higher up) and the GIRDER
// on its own; a **rigid link** transmits forces and moments between them honoring
// the lever arm (offset) → the deck force reaches the girder as force + moment =
// F·arm. Also useful for eccentric supports, beams with end offsets (1-010),
// insertion points (1-011) and analysis axes.
//
// Two types:
//   · rigid = true  → RIGID LINK: the slave follows the master as a rigid body
//        u_s = u_m + θ_m × r,   θ_s = θ_m      (r = slave_position − master)
//     Transmits the 6 DOF with the arm. `dofs` can restrict which slave DOFs are
//     tied (e.g. translations only → a hinge that transmits force, not moment).
//   · rigid = false → simple COUPLING: equates the selected DOFs without an arm
//        dof_s = dof_m    (for the marked `dofs`)
//
// Implemented via PENALTY (same as diaphragms): for each constraint equation
// g·u = 0, α·gᵀg is added to K. α = max(diag K)·1e5. SELF-CONTAINED.
// ──────────────────────────────────────────────────────────────────────────────

const PENALTY_FACTOR = 1e5;   // same factor as diaphragms (error <0.001%)

function denseWriter(K, nDOF) {
  return { add: (i, j, v) => { K[i * nDOF + j] += v; }, diag: (i) => K[i * nDOF + i] };
}

function _addPenalty(W, alpha, dofs, coeffs) {
  for (let i = 0; i < dofs.length; i++)
    for (let j = 0; j < dofs.length; j++)
      W.add(dofs[i], dofs[j], alpha * coeffs[i] * coeffs[j]);
}

// Constraint equations of a link → list of {dofs:[gi…], coeffs:[…]}.
// dof(im) = 6·im + {0..5} = [ux,uy,uz, rx,ry,rz].
function _linkEquations(link, master, slave, im, is) {
  const M = k => 6 * im + k, S = k => 6 * is + k;
  const d = link.dofs || { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 };
  const eqs = [];
  if (link.rigid) {
    const dx = slave.x - master.x, dy = slave.y - master.y, dz = slave.z - master.z;
    // u_s = u_m + θ_m × r   (θ×r)=(ry·dz−rz·dy, rz·dx−rx·dz, rx·dy−ry·dx)
    if (d.ux) eqs.push({ dofs: [S(0), M(0), M(4), M(5)], coeffs: [1, -1, -dz, dy] });
    if (d.uy) eqs.push({ dofs: [S(1), M(1), M(5), M(3)], coeffs: [1, -1, -dx, dz] });
    if (d.uz) eqs.push({ dofs: [S(2), M(2), M(3), M(4)], coeffs: [1, -1, -dy, dx] });
    if (d.rx) eqs.push({ dofs: [S(3), M(3)], coeffs: [1, -1] });
    if (d.ry) eqs.push({ dofs: [S(4), M(4)], coeffs: [1, -1] });
    if (d.rz) eqs.push({ dofs: [S(5), M(5)], coeffs: [1, -1] });
  } else {
    // simple coupling: dof_s = dof_m for the marked DOFs
    ['ux', 'uy', 'uz', 'rx', 'ry', 'rz'].forEach((k, idx) => { if (d[k]) eqs.push({ dofs: [S(idx), M(idx)], coeffs: [1, -1] }); });
  }
  return eqs;
}

// ── Dense API (used by assembleK) ───────────────────────────────────────────────
export function applyLinkConstraints(K, model, nodeIndex, nDOF) {
  applyLinkConstraintsW(denseWriter(K, nDOF), model, nodeIndex, nDOF);
}

// Writer-based variant (dense or sparse), for the banded path (sparse.js).
export function applyLinkConstraintsW(W, model, nodeIndex, nDOF) {
  if (!model.links || model.links.size === 0) return;
  let maxKii = 0;
  for (let i = 0; i < nDOF; i++) { const v = W.diag(i); if (v > maxKii) maxKii = v; }
  const alpha = maxKii > 0 ? maxKii * PENALTY_FACTOR : 1e12;

  for (const link of model.links.values()) {
    const master = model.nodes.get(link.master), slave = model.nodes.get(link.slave);
    if (!master || !slave || link.master === link.slave) continue;
    const im = nodeIndex.get(link.master), is = nodeIndex.get(link.slave);
    if (im == null || is == null) continue;
    for (const eq of _linkEquations(link, master, slave, im, is)) _addPenalty(W, alpha, eq.dofs, eq.coeffs);
  }
}
