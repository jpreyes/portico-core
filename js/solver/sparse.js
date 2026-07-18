// ──────────────────────────────────────────────────────────────────────────────
// sparse.js — SPARSE assembly of the global stiffness matrix.
//
// Replicates EXACTLY the dense assembly (assembler.js + diaphragm.js) but
// accumulating into a sparse storage (per-row map) instead of an n×n
// Float64Array. For large models this avoids the O(nDOF²) memory and the
// O(nDOF²) sweeps: assembly, the free–free extraction, the factorization
// (banded Cholesky) and matrix·vector products all stay in O(nnz).
//
// The output is CSR (compressed sparse row) of K_ff (free–free), plus a
// fixed–free coupling to compute the reactions, all without densifying.
// ──────────────────────────────────────────────────────────────────────────────
import {
  localAxes, stiffnessMatrix, massMatrix,
  transformMatrix, globalStiffness, applyReleases,
  elemLocalK, elemLocalM
} from './timoshenko.js?v=3';
import { applyDiaphragmConstraintsW, applyDiaphragmMassW } from './diaphragm.js?v=3';
import { applyLinkConstraintsW } from './links.js?v=3';
import { assembleAreasInto, assembleAreasMassInto } from './membrane.js?v=3';
import { applyMassSourceInto } from './assembler.js?v=3';

// ── Sparse symmetric matrix (per-row accumulator) ─────────────────────────────
export class SparseSym {
  constructor(n) {
    this.n = n;
    this.rows = Array.from({ length: n }, () => new Map());   // col → value
  }
  add(i, j, v) {
    if (v === 0) return;
    const r = this.rows[i];
    r.set(j, (r.get(j) || 0) + v);
  }
  diag(i) { return this.rows[i].get(i) || 0; }
  // "writer" interface consumed by the shared logic in diaphragm.js
  writer() { return { add: (i, j, v) => this.add(i, j, v), diag: (i) => this.diag(i) }; }
}

// Global DOFs (0-based) of a node
function dofs(nodeIndex, nodeId) {
  const b = 6 * nodeIndex.get(nodeId);
  return [b, b + 1, b + 2, b + 3, b + 4, b + 5];
}

// ── Sparse assembly of K (and optionally M) over ALL DOFs ─────────────────────
// Returns { S, M, nDOF }. S and M are SparseSym (M=null if withMass=false).
export function assembleSparseGlobal(model, nodeIndex, { withMass = false } = {}) {
  const nDOF = nodeIndex.size * 6;
  const S = new SparseSym(nDOF);
  const M = withMass ? new SparseSym(nDOF) : null;

  for (const elem of model.elements.values()) {
    const n1  = model.nodes.get(elem.n1);
    const n2  = model.nodes.get(elem.n2);
    const mat = model.materials.get(elem.matId);
    const sec = model.sections.get(elem.secId);
    if (!n1 || !n2 || !mat || !sec) continue;

    const { ex, ey, ez, L } = localAxes(n1, n2);
    let Ke = elemLocalK(elem, mat, sec, L);   // includes rigid end zone (#87)
    const hasRelease = elem.releases?.some(r => r !== 0);
    if (hasRelease) Ke = applyReleases(Ke, elem.releases.map(r => r !== 0));

    const T  = transformMatrix(ex, ey, ez);
    const KG = globalStiffness(Ke, T);
    const ed = [...dofs(nodeIndex, elem.n1), ...dofs(nodeIndex, elem.n2)];
    for (let i = 0; i < 12; i++)
      for (let j = 0; j < 12; j++)
        S.add(ed[i], ed[j], KG[i][j]);

    if (withMass) {
      const MG = globalStiffness(elemLocalM(elem, mat, sec, L), T);
      for (let i = 0; i < 12; i++)
        for (let j = 0; j < 12; j++)
          M.add(ed[i], ed[j], MG[i][j]);
    }
  }

  // Elastic supports (springs) on the diagonal
  for (const node of model.nodes.values()) {
    const sp = node.springs;
    if (!sp) continue;
    const ks = [sp.kux, sp.kuy, sp.kuz, sp.krx, sp.kry, sp.krz];
    if (!ks.some(k => k > 0)) continue;
    const b = nodeIndex.get(node.id) * 6;
    for (let i = 0; i < 6; i++) if (ks[i] > 0) S.add(b + i, b + i, ks[i]);
  }

  // Area elements (CST/QUAD membrane) → global translational DOFs
  assembleAreasInto(S.writer(), model, nodeIndex);

  // Rigid diaphragm constraints (penalty) — shared logic
  applyDiaphragmConstraintsW(S.writer(), model, nodeIndex, nDOF);

  // Links/couplings (deck↔beam, offsets) — penalty
  applyLinkConstraintsW(S.writer(), model, nodeIndex, nDOF);

  if (withMass) {
    assembleAreasMassInto(M.writer(), model, nodeIndex);   // area mass (ρ·t·A)
    applyDiaphragmMassW(M.writer(), model, nodeIndex);
    // Nodal point masses: translational (mx, my, mz) + rotational inertia
    // (irx, iry, irz). Must match the dense path in assembler.js — all six DOFs,
    // and a node with ONLY rotational inertia must not be skipped.
    for (const node of model.nodes.values()) {
      const nm = node.nodeMass;
      if (!nm || (!nm.mx && !nm.my && !nm.mz && !nm.irx && !nm.iry && !nm.irz)) continue;
      const b = nodeIndex.get(node.id) * 6;
      M.add(b,     b,     nm.mx  || 0);
      M.add(b + 1, b + 1, nm.my  || 0);
      M.add(b + 2, b + 2, nm.mz  || 0);
      M.add(b + 3, b + 3, nm.irx || 0);
      M.add(b + 4, b + 4, nm.iry || 0);
      M.add(b + 5, b + 5, nm.irz || 0);
    }
    // Seismic mass from load patterns (ETABS/SAP "mass source") — same as the dense path.
    applyMassSourceInto(M.writer(), model, nodeIndex);
  }

  return { S, M, nDOF };
}

// ── Free–free extraction to CSR + fixed–free coupling for reactions ───────────
// freeMap: Int32Array(nDOF) with the free index 0..nF-1, or −1 if the DOF is fixed.
// Returns:
//   csr  = { n:nF, rowPtr, colIdx, val }                 (K_ff compressed)
//   cf   = { rowDof, ptr, freeIdx, val }                 (fixed→free coupling)
//          rowDof[r] = fixed global DOF; its entries (freeIdx, val) are K[fixed, free].
export function extractFreeCSR(S, freeMap, nF) {
  const n = S.n;
  // Count of non-zeros per free row
  const cnt = new Int32Array(nF);
  for (let i = 0; i < n; i++) {
    const fi = freeMap[i];
    if (fi < 0) continue;
    const row = S.rows[i];
    let c = 0;
    for (const [j, v] of row) if (v !== 0 && freeMap[j] >= 0) c++;   // skip zeros (exact cancellations)
    cnt[fi] = c;
  }
  const rowPtr = new Int32Array(nF + 1);
  for (let r = 0; r < nF; r++) rowPtr[r + 1] = rowPtr[r] + cnt[r];
  const nnz = rowPtr[nF];
  const colIdx = new Int32Array(nnz);
  const val = new Float64Array(nnz);
  const cur = rowPtr.slice(0, nF);

  // Fixed–free coupling (reactions)
  const cfRowDof = [], cfPtrArr = [0], cfFreeIdx = [], cfVal = [];

  for (let i = 0; i < n; i++) {
    const fi = freeMap[i];
    const row = S.rows[i];
    if (fi >= 0) {
      // free row → free columns, ordered by free index
      const entries = [];
      for (const [j, v] of row) { if (v === 0) continue; const fj = freeMap[j]; if (fj >= 0) entries.push([fj, v]); }
      entries.sort((a, b) => a[0] - b[0]);
      for (const [fj, v] of entries) { const p = cur[fi]++; colIdx[p] = fj; val[p] = v; }
    } else {
      // fixed row → coupling to free columns (for reactions). The fixed DOF is
      // ALWAYS included (even with no coupling) so the reaction also captures the
      // loads applied directly on it (e.g. thermal):
      // reac = Σ K[fixed,free]·u_free − F[fixed]  →  if there is no coupling, −F.
      for (const [j, v] of row) {
        if (v === 0) continue;
        const fj = freeMap[j];
        if (fj >= 0) { cfFreeIdx.push(fj); cfVal.push(v); }
      }
      cfRowDof.push(i); cfPtrArr.push(cfFreeIdx.length);
    }
  }

  return {
    csr: { n: nF, rowPtr, colIdx, val },
    cf: {
      rowDof: Int32Array.from(cfRowDof),
      ptr: Int32Array.from(cfPtrArr),
      freeIdx: Int32Array.from(cfFreeIdx),
      val: Float64Array.from(cfVal),
    },
  };
}
