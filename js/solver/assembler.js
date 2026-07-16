// ──────────────────────────────────────────────────────────────────────────────
// Assembler — builds global stiffness K and force vector F
// ──────────────────────────────────────────────────────────────────────────────
import {
  localAxes, stiffnessMatrix, massMatrix,
  transformMatrix, globalStiffness,
  applyReleases, fixedEndForces, condenseFEF,
  elemLocalK, elemLocalM
} from './timoshenko.js?v=2';
import { applyDiaphragmConstraints, applyDiaphragmMass } from './diaphragm.js?v=2';
import { applyLinkConstraints } from './links.js?v=2';
import { assembleAreasInto, assembleAreasMassInto, areaThermalContribs, areaSelfWeightContribs } from './membrane.js?v=2';

// ── Self-weight ───────────────────────────────────────────────────────────────
// A material's `rho` is a MASS density: massMatrix() spends it as `rho*A*L = total
// element mass`, and verification 1-014 validates the modal periods that come out of it
// against a closed form. In the kN-m unit system that means t/m³ — concrete 2.5, steel 7.85.
//
// Self-weight is a FORCE, so it is `rho*A*g`, not `rho*A`. This is the single place that
// conversion lives; every self-weight path calls it (assembleF, the diagram integrator in
// postprocess.js, staged.js, and the NL-lite drivers in app.js) so they cannot drift apart.
export const G_ACC = 9.80665;   // m/s²

/** Self-weight of a frame element as a distributed load [force/length], along global −Z. */
export function selfWeightPerLength(mat, sec) {
  return (+mat?.rho || 0) * (+sec?.A || 0) * G_ACC;
}

// ── Node index (contiguous 0-based numbering) ─────────────────────────────
export function buildNodeIndex(model) {
  const idx = new Map();
  let i = 0;
  for (const id of model.nodes.keys()) idx.set(id, i++);
  return idx;
}

// DOF indices for a node (0-based index → 6 global DOFs)
function dofs(nodeIndex, nodeId) {
  const i = nodeIndex.get(nodeId);
  const b = 6 * i;
  return [b, b+1, b+2, b+3, b+4, b+5];
}

// ── Global stiffness matrix ────────────────────────────────────────────────
/**
 * Returns K as a flat Float64Array (nDOF × nDOF, row-major)
 * Also returns mass matrix M (for modal analysis later)
 */
export function assembleK(model, nodeIndex) {
  const nDOF = nodeIndex.size * 6;
  const K = new Float64Array(nDOF * nDOF);
  const M = new Float64Array(nDOF * nDOF);

  for (const elem of model.elements.values()) {
    const n1  = model.nodes.get(elem.n1);
    const n2  = model.nodes.get(elem.n2);
    const mat = model.materials.get(elem.matId);
    const sec = model.sections.get(elem.secId);
    if (!n1 || !n2 || !mat || !sec) continue;

    const { ex, ey, ez, L } = localAxes(n1, n2);
    let Ke = elemLocalK(elem, mat, sec, L);   // includes rigid end zone (#87) if any
    const Me = elemLocalM(elem, mat, sec, L);

    // Apply end releases (hinges)
    const hasRelease = elem.releases?.some(r => r !== 0);
    if (hasRelease) {
      Ke = applyReleases(Ke, elem.releases.map(r => r !== 0));
    }

    const T   = transformMatrix(ex, ey, ez);
    const KG  = globalStiffness(Ke, T);
    const MG  = globalStiffness(Me, T);

    // Element DOF mapping
    const ed  = [...dofs(nodeIndex, elem.n1), ...dofs(nodeIndex, elem.n2)];

    // Add to global matrices
    for (let i=0; i<12; i++) {
      for (let j=0; j<12; j++) {
        K[ed[i]*nDOF + ed[j]] += KG[i][j];
        M[ed[i]*nDOF + ed[j]] += MG[i][j];
      }
    }
  }

  // Elastic supports: spring stiffness on the node's global DOFs.
  //  • node.springs  = {kux…krz} → terms on the DIAGONAL (usual case).
  //  • node.springK  = 6×6 matrix (36, row-major) COUPLED (#2): inclined springs /
  //    cross soil-structure stiffness (translation↔rotation). Assembled FULL and
  //    symmetrized for safety; coexists with the diagonal (they add up).
  for (const node of model.nodes.values()) {
    const b = nodeIndex.get(node.id) * 6;
    const sp = node.springs;
    if (sp) {
      const ks = [sp.kux, sp.kuy, sp.kuz, sp.krx, sp.kry, sp.krz];
      for (let i = 0; i < 6; i++) if (ks[i] > 0) K[(b + i) * nDOF + (b + i)] += ks[i];
    }
    const KS = node.springK;
    if (KS && KS.length === 36) {
      for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) {
        const kij = 0.5 * ((+KS[i * 6 + j] || 0) + (+KS[j * 6 + i] || 0));   // symmetrize
        if (kij) K[(b + i) * nDOF + (b + j)] += kij;
      }
    }
  }

  // Area elements (CST/QUAD membrane) → global translational DOFs
  assembleAreasInto({ add: (i, j, v) => { K[i * nDOF + j] += v; } }, model, nodeIndex);
  // Area mass (ρ·t·A lumped) for the modal analysis
  assembleAreasMassInto({ add: (i, j, v) => { M[i * nDOF + j] += v; } }, model, nodeIndex);

  // Apply rigid diaphragm constraints (penalty method)
  applyDiaphragmConstraints(K, model, nodeIndex, nDOF);

  // Apply link/coupling constraints (deck↔beam, offsets) — penalty method
  applyLinkConstraints(K, model, nodeIndex, nDOF);

  // Apply diaphragm concentrated masses (for modal analysis)
  applyDiaphragmMass(M, model, nodeIndex, nDOF);

  // Apply user-defined nodal point masses: translational (mx, my, mz in ton) +
  // rotational inertia (irx, iry, irz in ton·m²) on the rotational DOFs Rx/Ry/Rz (#6).
  for (const node of model.nodes.values()) {
    const nm = node.nodeMass;
    if (!nm || (!nm.mx && !nm.my && !nm.mz && !nm.irx && !nm.iry && !nm.irz)) continue;
    const b = nodeIndex.get(node.id) * 6;
    M[b*nDOF     + b    ] += nm.mx  || 0;   // Ux
    M[(b+1)*nDOF + (b+1)] += nm.my  || 0;   // Uy
    M[(b+2)*nDOF + (b+2)] += nm.mz  || 0;   // Uz
    M[(b+3)*nDOF + (b+3)] += nm.irx || 0;   // Rx
    M[(b+4)*nDOF + (b+4)] += nm.iry || 0;   // Ry
    M[(b+5)*nDOF + (b+5)] += nm.irz || 0;   // Rz
  }

  // Seismic mass from load patterns (ETABS/SAP "mass source").
  applyMassSourceInto({ add: (i, j, v) => { M[i * nDOF + j] += v; } }, model, nodeIndex);

  return { K, M, nDOF };
}

// ── Seismic mass source: load patterns → translational mass ───────────────────
// Converts the gravity (global −Z) component of one or more load cases (× factors)
// into a lumped translational mass m = |W|/g applied EQUALLY on the three
// translational DOFs (UX, UY, UZ) of each node. This is the standard "mass source
// from loads" of ETABS/SAP: the superimposed dead/live weight participates in the
// dynamic response in every direction, not only where it was modelled.
//
// Reuses assembleF so distributed loads are lumped to nodes by the same tributary
// (FEF) rule as the static analysis. Only the vertical (Z) nodal component is taken
// as weight; horizontal applied loads and FEF moments are ignored (they are not mass).
export function applyMassSourceInto(writer, model, nodeIndex) {
  const ms = model.massSource;
  if (!ms || !ms.enabled) return;
  const entries = ms.entries || [];
  if (!entries.length && !ms.selfWeight) return;
  const g = (ms.g > 0) ? ms.g : 9.80665;
  const nDOF = nodeIndex.size * 6;

  // Combined vertical force field from the source load cases (× factors) + self-weight.
  const F = new Float64Array(nDOF);
  for (const e of entries) {
    if (e == null || e.lcId == null) continue;
    const f = (e.factor != null) ? +e.factor : 1;
    if (!f) continue;
    const Fi = assembleF(model, nodeIndex, e.lcId, false);
    for (let i = 0; i < nDOF; i++) F[i] += f * Fi[i];
  }
  if (ms.selfWeight) {
    const Fsw = assembleF(model, nodeIndex, null, true);   // self-weight only
    for (let i = 0; i < nDOF; i++) F[i] += Fsw[i];
  }

  // Vertical nodal weight → mass on UX, UY, UZ.
  for (const node of model.nodes.values()) {
    const b = 6 * nodeIndex.get(node.id);
    const W = Math.abs(F[b + 2]);            // |F_z| = tributary gravity weight at the node
    if (!(W > 1e-30)) continue;
    const m = W / g;
    writer.add(b,     b,     m);             // UX
    writer.add(b + 1, b + 1, m);             // UY
    writer.add(b + 2, b + 2, m);             // UZ
  }
}

// ── Force vector assembly ─────────────────────────────────────────────────
/**
 * Builds force vector F from load case (lcId).
 * Also applies self-weight if selfWeight=true.
 */
export function assembleF(model, nodeIndex, lcId, selfWeight = false) {
  const nDOF = nodeIndex.size * 6;
  const F = new Float64Array(nDOF);

  // Load case loads
  const lc = model.loadCases.get(lcId);
  if (lc) {
    for (const load of lc.loads) {
      if (load.type === 'nodal') {
        const nd = model.nodes.get(load.nodeId);
        if (!nd) continue;
        const d = dofs(nodeIndex, nd.id);
        for (let i=0; i<6; i++) F[d[i]] += (load.F[i] || 0);
      }

      if (load.type === 'dist') {
        const elem = model.elements.get(load.elemId);
        if (!elem) continue;
        const n1  = model.nodes.get(elem.n1);
        const n2  = model.nodes.get(elem.n2);
        const mat = model.materials.get(elem.matId);
        const sec = model.sections.get(elem.secId);
        if (!n1 || !n2) continue;

        const { ex, ey, ez, L } = localAxes(n1, n2);
        const T = transformMatrix(ex, ey, ez);
        const hasRelease = elem.releases?.some(r => r !== 0);
        const relBool    = hasRelease ? elem.releases.map(r => r !== 0) : null;
        const Ke_loc     = (hasRelease && mat && sec) ? stiffnessMatrix(L, mat, sec) : null;

        const ed = [...dofs(nodeIndex, elem.n1), ...dofs(nodeIndex, elem.n2)];
        for (const ll of _toLocalDistLoad(load, ex, ey, ez)) {
          let f_local = fixedEndForces(L, ll);
          if (Ke_loc) f_local = condenseFEF(Ke_loc, relBool, f_local);
          const f_global = Array(12).fill(0);
          for (let i=0; i<12; i++)
            for (let j=0; j<12; j++)
              f_global[i] += T[j][i] * f_local[j];
          for (let i=0; i<12; i++) F[ed[i]] -= f_global[i];
        }
      }

      // Uniform TEMPERATURE load ΔT: the element wants to expand by α·ΔT·L.
      // Thermal FEF (same convention as distributed loads, F -= FEF):
      //   axial node1 = +EA·α·ΔT,  axial node2 = −EA·α·ΔT  (rest 0).
      // Free bar → N=0 (expands α·ΔT·L); fixed → N=−EA·α·ΔT.
      // Temperature over an AREA: surface thermal load (membrane) + a GRADIENT
      // through the thickness (thermal bending moment, #57).
      // Faces: dTtop = +z face (red), dTbot = −z face (blue). Mean → membrane;
      // gradient (dTbot − dTtop) → moment. Compatible with the legacy uniform ΔT (dT).
      if (load.type === 'temp' && load.areaId != null) {
        const area = model.areas.get(load.areaId);
        if (!area) continue;
        const hasFaces = load.dTtop != null || load.dTbot != null;
        const dTmean = hasFaces ? ((+load.dTtop || 0) + (+load.dTbot || 0)) / 2 : (load.dT || 0);
        // gradient = hot face below (−z) → the plate curves toward +z (the hotter
        // face elongates and becomes convex). gradT = T(−z) − T(+z).
        const gradT  = hasFaces ? ((+load.dTbot || 0) - (+load.dTtop || 0)) : 0;
        for (const { dof, val } of areaThermalContribs(area, model, nodeIndex, dTmean, gradT)) F[dof] += val;
        continue;
      }

      if (load.type === 'temp') {
        const elem = model.elements.get(load.elemId);
        if (!elem) continue;
        const n1  = model.nodes.get(elem.n1);
        const n2  = model.nodes.get(elem.n2);
        const mat = model.materials.get(elem.matId);
        const sec = model.sections.get(elem.secId);
        if (!n1 || !n2 || !mat || !sec) continue;

        const { ex, ey, ez, L } = localAxes(n1, n2);
        const T  = transformMatrix(ex, ey, ez);
        const EA = mat.E * sec.A * (sec.mod?.A ?? 1);
        const Nt = EA * (mat.alpha ?? 0) * (load.dT || 0);
        let f_local = Array(12).fill(0);
        f_local[0] = +Nt; f_local[6] = -Nt;
        const hasRelease = elem.releases?.some(r => r !== 0);
        if (hasRelease) f_local = condenseFEF(stiffnessMatrix(L, mat, sec), elem.releases.map(r => r !== 0), f_local);
        const ed = [...dofs(nodeIndex, elem.n1), ...dofs(nodeIndex, elem.n2)];
        const f_global = Array(12).fill(0);
        for (let i=0; i<12; i++)
          for (let j=0; j<12; j++)
            f_global[i] += T[j][i] * f_local[j];
        for (let i=0; i<12; i++) F[ed[i]] -= f_global[i];
      }
    }
  }

  // Self-weight: gravity in -Z direction — full FEF (forces + moments)
  if (selfWeight) {
    for (const elem of model.elements.values()) {
      const n1  = model.nodes.get(elem.n1);
      const n2  = model.nodes.get(elem.n2);
      const mat = model.materials.get(elem.matId);
      const sec = model.sections.get(elem.secId);
      if (!n1 || !n2 || !mat || !sec) continue;

      const { ex, ey, ez, L } = localAxes(n1, n2);
      const T  = transformMatrix(ex, ey, ez);
      const ed = [...dofs(nodeIndex, elem.n1), ...dofs(nodeIndex, elem.n2)];
      const hasRel_sw  = elem.releases?.some(r => r !== 0);
      const relBool_sw = hasRel_sw ? elem.releases.map(r => r !== 0) : null;
      const Ke_loc_sw  = hasRel_sw ? stiffnessMatrix(L, mat, sec) : null;
      const swLoad = { w: selfWeightPerLength(mat, sec), dir: 'gravity' };
      for (const ll of _toLocalDistLoad(swLoad, ex, ey, ez)) {
        let f_local = fixedEndForces(L, ll);
        if (Ke_loc_sw) f_local = condenseFEF(Ke_loc_sw, relBool_sw, f_local);
        const f_global = Array(12).fill(0);
        for (let i=0; i<12; i++)
          for (let j=0; j<12; j++)
            f_global[i] += T[j][i] * f_local[j];
        for (let i=0; i<12; i++) F[ed[i]] -= f_global[i];
      }
    }
    // Areas weigh too. A slab or a wall modelled with area elements used to contribute
    // nothing here, so a model built entirely out of them (a shear-wall building) had a
    // self-weight of exactly zero — with the box ticked and no warning.
    for (const area of model.areas.values())
      for (const { dof, val } of areaSelfWeightContribs(area, model, nodeIndex, G_ACC)) F[dof] += val;
  }

  return F;
}

// ── Helpers ───────────────────────────────────────────────────────────────
// Returns array of {dir, w} components in local coordinates (x, y and z).
// 'gravity' and legacy 'globalZ' both map to Global -Z (positive w = downward).
// Includes axial projection so gravity on vertical columns gets correct axial FEF.
function _toLocalDistLoad(load, ex, ey, ez) {
  const w   = load.w;
  const w2  = (load.w2 == null) ? w : load.w2;   // trapezoidal: intensity at end j
  const dir = load.dir || 'gravity';

  if (dir === 'localY') return [{ dir: 'y', w, w2 }];
  if (dir === 'localZ') return [{ dir: 'z', w, w2 }];
  if (dir === 'localX') return [{ dir: 'x', w, w2 }];

  const g = dir === 'globalX' ? [1,0,0]
          : dir === 'globalY' ? [0,1,0]
          : [0,0,-1];   // 'gravity' and legacy 'globalZ' both mean downward (positive w = ↓)

  // Same projection for both ends (the direction does not change along the length).
  const px = g[0]*ex[0] + g[1]*ex[1] + g[2]*ex[2];
  const py = g[0]*ey[0] + g[1]*ey[1] + g[2]*ey[2];
  const pz = g[0]*ez[0] + g[1]*ez[1] + g[2]*ez[2];
  const res = [];
  if (Math.abs(w*px) > 1e-14 || Math.abs(w2*px) > 1e-14) res.push({ dir: 'x', w: w*px, w2: w2*px });
  if (Math.abs(w*py) > 1e-14 || Math.abs(w2*py) > 1e-14) res.push({ dir: 'y', w: w*py, w2: w2*py });
  if (Math.abs(w*pz) > 1e-14 || Math.abs(w2*pz) > 1e-14) res.push({ dir: 'z', w: w*pz, w2: w2*pz });
  return res;
}

// ── Export DOF helper (used by solver) ────────────────────────────────────
export { dofs as getNodeDOFs };
