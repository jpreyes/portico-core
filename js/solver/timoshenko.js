// ──────────────────────────────────────────────────────────────────────────────
// Timoshenko 3D Beam Element
// 12 DOF per element (2 nodes × 6 DOF)
// DOF order (local): [u1,v1,w1,rx1,ry1,rz1,  u2,v2,w2,rx2,ry2,rz2]
//   u=axial, v=transv-y, w=transv-z, rx=torsion, ry=bend-y, rz=bend-z
//
// Coordinate convention (model Z-up, SAP2000):
//   Global: X east, Y north, Z up
//   Local:  x along element, y/z defined by reference vector
// ──────────────────────────────────────────────────────────────────────────────

// ── Vector helpers ─────────────────────────────────────────────────────────
const dot  = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const cross = ([ax,ay,az],[bx,by,bz]) =>
  [ay*bz-az*by, az*bx-ax*bz, ax*by-ay*bx];
const norm = v => Math.sqrt(dot(v,v));
const unit = v => { const n=norm(v); return v.map(x=>x/n); };

// ── Local coordinate system ───────────────────────────────────────────────
/**
 * Returns {ex, ey, ez, L} for an element from n1→n2.
 * - ex: unit vector along element axis
 * - ey: "up" reference (global Z projected perpendicular to ex) or global X for vertical elements
 * - ez: ex × ey (right-hand)
 */
export function localAxes(n1, n2) {
  const d = [n2.x-n1.x, n2.y-n1.y, n2.z-n1.z];
  const L = norm(d);
  if (L < 1e-12) throw new Error(`Elemento de longitud cero entre nodos ${n1.id} y ${n2.id}`);
  const ex = unit(d);

  // Reference vector: global Z=[0,0,1] unless element is nearly vertical
  const VERT = 0.9994;
  const isVert = Math.abs(ex[2]) > VERT;
  const ref = isVert ? [1,0,0] : [0,0,1];  // global X or global Z

  const ez = unit(cross(ex, ref));  // local z perpendicular to ex and ref
  const ey = cross(ez, ex);          // local y (right-hand: ey = ez×ex)

  return { ex, ey, ez, L };
}

// ── 12×12 local stiffness matrix (Timoshenko) ─────────────────────────────
/**
 * @param {number} L   element length
 * @param {object} mat {E, G}
 * @param {object} sec {A, Iz, Iy, J, Avy, Avz}
 * @returns {number[][]} 12×12 symmetric stiffness matrix in local coords
 */
export function stiffnessMatrix(L, mat, sec) {
  const { E, G } = mat;
  // Section modifiers (effective stiffness, e.g. ACI cracked section: beam 0.35·Ig,
  // column 0.70·Ig). They only affect the STIFFNESS, not the mass.
  const md = sec.mod || {};
  const mA = md.A ?? 1, mIz = md.Iz ?? 1, mIy = md.Iy ?? 1, mJ = md.J ?? 1;
  const A   = sec.A  * mA;
  const Iz  = sec.Iz * mIz;
  const Iy  = sec.Iy * mIy;
  const J   = sec.J  * mJ;
  const Avy = sec.Avy * mA;
  const Avz = sec.Avz * mA;

  const Ke = Array.from({length:12}, () => Array(12).fill(0));

  // ── Axial ─────────────────────────────────────────────────────────────
  const a = E * A / L;
  Ke[0][0]=a; Ke[0][6]=-a; Ke[6][0]=-a; Ke[6][6]=a;

  // ── Torsion ───────────────────────────────────────────────────────────
  const t = G * J / L;
  Ke[3][3]=t; Ke[3][9]=-t; Ke[9][3]=-t; Ke[9][9]=t;

  // ── Bending in local XY plane (about local z, uses Iz, Avy) ──────────
  // Timoshenko factor: Φy = 12·E·Iz / (G·Avy·L²)
  const Phy = (Avy > 1e-30) ? 12*E*Iz / (G*Avy*L*L) : 0;
  const fy  = 1 / (1 + Phy);
  const by  = 12*E*Iz*fy / (L*L*L);
  const cy  = 6*E*Iz*fy / (L*L);
  const dy  = (4 + Phy)*E*Iz*fy / L;
  const ey  = (2 - Phy)*E*Iz*fy / L;

  // DOF indices in 12-DOF vector for XY bending: v1=1, θz1=5, v2=7, θz2=11
  const xy = [1, 5, 7, 11];
  const KXY = [
    [ by,  cy, -by,  cy],
    [ cy,  dy, -cy,  ey],
    [-by, -cy,  by, -cy],
    [ cy,  ey, -cy,  dy]
  ];
  for (let i=0; i<4; i++) for (let j=0; j<4; j++) Ke[xy[i]][xy[j]] = KXY[i][j];

  // ── Bending in local XZ plane (about local y, uses Iy, Avz) ──────────
  // Timoshenko factor: Φz = 12·E·Iy / (G·Avz·L²)
  const Phz = (Avz > 1e-30) ? 12*E*Iy / (G*Avz*L*L) : 0;
  const fz  = 1 / (1 + Phz);
  const bz  = 12*E*Iy*fz / (L*L*L);
  const cz  = 6*E*Iy*fz / (L*L);
  const dz  = (4 + Phz)*E*Iy*fz / L;
  const ez  = (2 - Phz)*E*Iy*fz / L;

  // DOF indices: w1=2, θy1=4, w2=8, θy2=10
  // Sign convention: dw/dx = -θy (right-hand rule with Z-up model)
  const xz = [2, 4, 8, 10];
  const KXZ = [
    [ bz, -cz, -bz, -cz],
    [-cz,  dz,  cz,  ez],
    [-bz,  cz,  bz,  cz],
    [-cz,  ez,  cz,  dz]
  ];
  for (let i=0; i<4; i++) for (let j=0; j<4; j++) Ke[xz[i]][xz[j]] = KXZ[i][j];

  return Ke;
}

// ── 12×12 consistent mass matrix ──────────────────────────────────────────
/**
 * Consistent mass matrix (Archer/Przemieniecki) — used in modal analysis (Fase 5)
 */
export function massMatrix(L, mat, sec) {
  const rho = mat.rho;
  const A   = sec.A;
  const m   = rho * A * L;  // total element mass
  const Ix  = mat.G !== 0 ? sec.J * mat.rho : 0;  // approx mass moment about x

  const Me = Array.from({length:12}, () => Array(12).fill(0));

  // Translational mass (consistent, without rotational inertia)
  const c = m / 420;

  // Axial: [u1, u2]
  Me[0][0] = c*140; Me[0][6] = c*70;
  Me[6][0] = c*70;  Me[6][6] = c*140;

  // Bending in XY: [v1, θz1, v2, θz2]
  const Mb = [
    [156,  22*L,  54,   -13*L],
    [22*L,  4*L*L, 13*L, -3*L*L],
    [54,   13*L,  156,  -22*L],
    [-13*L,-3*L*L,-22*L,  4*L*L]
  ];
  const xy = [1, 5, 7, 11];
  for (let i=0; i<4; i++) for (let j=0; j<4; j++) Me[xy[i]][xy[j]] = c * Mb[i][j];

  // Bending in XZ: [w1, θy1, w2, θy2] — same pattern but check signs
  const xz = [2, 4, 8, 10];
  const MbXZ = [
    [156, -22*L,  54,   13*L],
    [-22*L, 4*L*L,-13*L,-3*L*L],
    [54,  -13*L, 156,   22*L],
    [13*L,-3*L*L, 22*L,  4*L*L]
  ];
  for (let i=0; i<4; i++) for (let j=0; j<4; j++) Me[xz[i]][xz[j]] = c * MbXZ[i][j];

  // Torsional mass: [rx1, rx2]
  const mt = rho * Ix * L / 6;
  Me[3][3] = mt*2; Me[3][9] = mt; Me[9][3] = mt; Me[9][9] = mt*2;

  return Me;
}

// ── 12×12 transformation matrix ───────────────────────────────────────────
/**
 * T12 maps global DOF to local DOF: u_local = T12 · u_global
 * T12 = block_diag(R, R, R, R) where R = [ex; ey; ez] (3×3)
 */
export function transformMatrix(ex, ey, ez) {
  const T = Array.from({length:12}, () => Array(12).fill(0));
  const R = [ex, ey, ez];  // each row is a local axis in global coords
  for (let b=0; b<4; b++) {
    for (let i=0; i<3; i++) for (let j=0; j<3; j++) {
      T[3*b+i][3*b+j] = R[i][j];
    }
  }
  return T;
}

// ── Global element stiffness: Ke_global = T^T · Ke_local · T ──────────────
export function globalStiffness(Ke_local, T) {
  const n = 12;
  // KT = Ke_local · T
  const KT = Array.from({length:n}, (_,i) =>
    Array.from({length:n}, (_,j) =>
      Ke_local[i].reduce((s,v,k) => s + v * T[k][j], 0)
    )
  );
  // T^T · KT
  return Array.from({length:n}, (_,i) =>
    Array.from({length:n}, (_,j) =>
      T.reduce((s,row,k) => s + row[i] * KT[k][j], 0)
    )
  );
}

// ── Rigid end zone / end offset (end length offset, #87) ───────────────────
// A bar of length L may have RIGID segments of length `oi` (end i) and `oj` (end
// j); the flexible part measures Lf = L − oi − oj. Stiffness/mass are computed for
// the flexible part and transformed to the DOFs of the real nodes via a rigid arm
// (rigid-body kinematics): u(i') = u(i) + θ(i)×r, with r the vector from the node
// to the flexible end (along the local x axis).
// It is the SAP2000/ETABS beam-column "rigid offset" — it shortens the flexible span.

// Returns { oi, oj, Lf } bounded (the flexible span never collapses), or null if none.
export function rigidEndOffsets(elem, L) {
  const re = elem && elem.rigidEnd; if (!re) return null;
  let oi = Math.max(0, +re.i || 0), oj = Math.max(0, +re.j || 0);
  if (oi < 1e-9 && oj < 1e-9) return null;
  const cap = 0.95 * L;                       // keep at least 5% of flexible span
  if (oi + oj > cap) { const s = cap / (oi + oj); oi *= s; oj *= s; }
  return { oi, oj, Lf: L - oi - oj };
}

// Rigid-arm transform (12×12): flexible-end DOFs = T · node DOFs.
// r_i = (+oi,0,0) → uy'+=oi·rz, uz'+=−oi·ry ; r_j = (−oj,0,0) → uy'+=−oj·rz, uz'+=oj·ry.
export function rigidEndTransform(oi, oj) {
  const T = Array.from({ length: 12 }, (_, i) => { const r = Array(12).fill(0); r[i] = 1; return r; });
  T[1][5] = oi;  T[2][4] = -oi;     // end i
  T[7][11] = -oj; T[8][10] = oj;    // end j
  return T;
}

// LOCAL element stiffness including the rigid end zone (before releases).
// Without a rigid end it returns the normal stiffness of length L.
export function elemLocalK(elem, mat, sec, L) {
  const ro = rigidEndOffsets(elem, L);
  let Ke = ro ? globalStiffness(stiffnessMatrix(ro.Lf, mat, sec), rigidEndTransform(ro.oi, ro.oj))
              : stiffnessMatrix(L, mat, sec);
  // Beam on elastic foundation / line spring (1-013): adds the subgrade stiffness
  // distributed over the span (kN/m per m). (With a rigid end it is applied on the
  // node DOFs at L — approximation; the rigid-end+foundation combo is uncommon.)
  if (elem.foundation) {
    const Kf = foundationMatrix(L, elem.foundation);
    Ke = Ke.map((row, i) => row.map((v, j) => v + Kf[i][j]));
  }
  // End springs / partial fixity (1-008): semi-rigid member↔node connection.
  if (elem.endSprings) Ke = applyEndSprings(Ke, elem.endSprings);
  return Ke;
}

// LOCAL element mass with rigid end zone (consistent mass of the flexible part
// referred to the nodes; the mass of the rigid zones is neglected — approximation).
export function elemLocalM(elem, mat, sec, L) {
  const ro = rigidEndOffsets(elem, L);
  if (!ro) return massMatrix(L, mat, sec);
  return globalStiffness(massMatrix(ro.Lf, mat, sec), rigidEndTransform(ro.oi, ro.oj));
}

// ── Static condensation for end releases ──────────────────────────────────
/**
 * Apply static condensation to element Ke for released DOFs.
 * releases: boolean[12] — true means that DOF is a hinge (released)
 * Returns condensed 12×12 matrix with zero rows/cols for released DOFs.
 */
export function applyReleases(Ke, releases) {
  const n = 12;
  const free  = []; // non-released DOF indices
  const rel   = []; // released DOF indices
  for (let i=0; i<n; i++) {
    if (releases[i]) rel.push(i);
    else free.push(i);
  }
  if (rel.length === 0) return Ke;  // no releases

  // Partition: Kff, Kfr, Krf, Krr
  const Kff = free.map(i => free.map(j => Ke[i][j]));
  const Kfr = free.map(i => rel.map(j => Ke[i][j]));
  const Krr = rel.map(i => rel.map(j => Ke[i][j]));

  // Invert Krr (small matrix: max 6×6 in practice)
  const KrrInv = invertSmall(Krr);
  if (!KrrInv) return Ke;  // fallback if singular

  // Condensed: Kff* = Kff - Kfr · Krr^-1 · Krf
  const nr = rel.length;
  const nf = free.length;
  const KfrKrrInv = Array.from({length:nf}, (_,i) =>
    Array.from({length:nr}, (_,j) =>
      Kfr[i].reduce((s,v,k) => s + v * KrrInv[k][j], 0)
    )
  );
  const KCond = Kff.map((row, i) =>
    row.map((v, j) =>
      v - KfrKrrInv[i].reduce((s,c,k) => s + c * Kfr[j][k], 0)
    )
  );

  // Reassemble into 12×12 (zeros for released rows/cols)
  const result = Array.from({length:n}, () => Array(n).fill(0));
  for (let i=0; i<nf; i++) for (let j=0; j<nf; j++) {
    result[free[i]][free[j]] = KCond[i][j];
  }
  return result;
}

// ── Condense fixed-end forces for released DOFs ───────────────────────────────
// f*[free] = f[free] - Kfr · Krr^-1 · f[released];  f*[released] = 0
export function condenseFEF(Ke, releases, fef) {
  const n = 12;
  const free = [], rel = [];
  for (let i = 0; i < n; i++) {
    if (releases[i]) rel.push(i);
    else free.push(i);
  }
  if (rel.length === 0) return fef;

  const Kfr = free.map(i => rel.map(j => Ke[i][j]));
  const Krr = rel.map(i => rel.map(j => Ke[i][j]));
  const KrrInv = invertSmall(Krr);
  if (!KrrInv) {
    const res = [...fef];
    for (const r of rel) res[r] = 0;
    return res;
  }

  const fr = rel.map(r => fef[r]);
  const KrrInv_fr = rel.map((_, j) =>
    rel.reduce((s, _, k) => s + KrrInv[j][k] * fr[k], 0)
  );

  const result = [...fef];
  for (let i = 0; i < free.length; i++) {
    result[free[i]] -= rel.reduce((s, _, k) => s + Kfr[i][k] * KrrInv_fr[k], 0);
  }
  for (const r of rel) result[r] = 0;
  return result;
}

// ── Recover displacements of released DOFs ─────────────────────────────────────
// At a hinged end, the element's REAL rotation differs from the nodal rotation (it
// was condensed out). To draw the deflected shape correctly it must be recovered:
//   equilibrium at released DOF r:  Krf·uf + Krr·ur + fef_r = 0
//   ⇒  ur = Krr⁻¹ · (−fef_r − Krf·uf)
// Returns a copy of ue with the released values substituted.
export function recoverReleasedDisp(Ke, releases, ue, fef = null) {
  const free = [], rel = [];
  for (let i = 0; i < 12; i++) (releases[i] ? rel : free).push(i);
  if (rel.length === 0) return ue;

  const Krr = rel.map(r => rel.map(c => Ke[r][c]));
  const inv = invertSmall(Krr);
  if (!inv) return ue;

  const rhs = rel.map(r => {
    let s = -(fef ? (fef[r] || 0) : 0);
    for (const f of free) s -= Ke[r][f] * ue[f];
    return s;
  });

  const out = [...ue];
  for (let i = 0; i < rel.length; i++) {
    let s = 0;
    for (let j = 0; j < rel.length; j++) s += inv[i][j] * rhs[j];
    out[rel[i]] = s;
  }
  return out;
}

// Simple Gauss-Jordan inversion for small matrices
function invertSmall(M) {
  const n = M.length;
  const A = M.map((row, i) => [...row, ...Array.from({length:n}, (_,j) => i===j ? 1 : 0)]);
  for (let col=0; col<n; col++) {
    let piv = col;
    for (let r=col+1; r<n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    [A[col], A[piv]] = [A[piv], A[col]];
    if (Math.abs(A[col][col]) < 1e-30) return null;
    const f = A[col][col];
    A[col] = A[col].map(v => v/f);
    for (let r=0; r<n; r++) {
      if (r === col) continue;
      const k = A[r][col];
      A[r] = A[r].map((v,c) => v - k*A[col][c]);
    }
  }
  return A.map(row => row.slice(n));
}

// ── End springs / partial fixity (semi-rigid) — 1-008 ────────────────────────
/**
 * Applies end springs to the element's local stiffness (semi-rigid member↔node
 * connection). `springs` = { [dof 0..11]: k } with k>0 finite (kN·m/rad for
 * rotations, kN/m for translations). Each sprung end is treated as an INTERNAL DOF
 * of the member coupled to the node's DOF through the spring; it is condensed out by
 * statics (Guyan):
 *   k→∞ ⇒ rigid connection (original Ke) · k→0 ⇒ full release (hinge).
 * Rigorous for Timoshenko (operates on the real Ke, not an Euler formula).
 */
export function applyEndSprings(Ke, springs) {
  if (!springs) return Ke;
  const sd = Object.keys(springs).map(Number).filter(i => springs[i] > 0 && isFinite(springs[i]));
  if (!sd.length) return Ke;
  const m = sd.length, N = 12 + m;
  const beamIdx = i => { const p = sd.indexOf(i); return p >= 0 ? 12 + p : i; };
  const K = Array.from({ length: N }, () => Array(N).fill(0));
  for (let a = 0; a < 12; a++) for (let b = 0; b < 12; b++) {
    const v = Ke[a][b]; if (v) K[beamIdx(a)][beamIdx(b)] += v;
  }
  // Spring k between the node's DOF `i` and the member's internal DOF `12+p`.
  sd.forEach((i, p) => { const k = springs[i], P = 12 + p; K[i][i] += k; K[P][P] += k; K[i][P] -= k; K[P][i] -= k; });
  // Condense the internal DOFs (12..N-1): Keff = Knn − Kni·Kii⁻¹·Kin.
  const node = Array.from({ length: 12 }, (_, i) => i);
  const intl = sd.map((_, p) => 12 + p);
  const Knn = node.map(i => node.map(j => K[i][j]));
  const Kni = node.map(i => intl.map(j => K[i][j]));
  const Kii = intl.map(i => intl.map(j => K[i][j]));
  const KiiInv = invertSmall(Kii);
  if (!KiiInv) return Ke;
  const KniInv = node.map((_, i) => intl.map((_, j) =>
    Kni[i].reduce((s, v, k) => s + v * KiiInv[k][j], 0)));
  return Knn.map((row, i) => row.map((v, j) =>
    v - KniInv[i].reduce((s, c, k) => s + c * Kni[j][k], 0)));   // Kin[k][j]=Kni[j][k] (symmetric)
}

// ── Beam on elastic foundation (Winkler) — 1-013 ─────────────────────────────
/**
 * Foundation stiffness matrix (distributed LINE spring) in local coords.
 * `found` = { ky, kz } subgrade moduli per unit length (kN/m per m = kN/m²) in the
 * local transverse directions y / z. CONSISTENT matrix (cubic Hermite), same shape
 * as the consistent mass: Cf = (kf·L/420)·[[156,22L,54,−13L],…]. The sign of the
 * rotation terms is flipped in the x–z plane to match the element's convention
 * (dw/dx = −θy). It is ADDED to the element stiffness.
 */
export function foundationMatrix(L, found) {
  const K = Array.from({ length: 12 }, () => Array(12).fill(0));
  if (!found) return K;
  const L2 = L * L;
  const add = (dofs, kf, s) => {
    if (!(kf > 0) || !isFinite(kf)) return;
    const c = kf * L / 420;
    const C = [
      [156,      s*22*L,  54,      -s*13*L],
      [s*22*L,   4*L2,    s*13*L,  -3*L2  ],
      [54,       s*13*L,  156,     -s*22*L],
      [-s*13*L, -3*L2,   -s*22*L,   4*L2  ],
    ];
    for (let i=0;i<4;i++) for (let j=0;j<4;j++) K[dofs[i]][dofs[j]] += c * C[i][j];
  };
  add([1, 5, 7, 11], found.ky, +1);   // local transverse y  (v, θz)
  add([2, 4, 8, 10], found.kz, -1);   // local transverse z  (w, θy)
  return K;
}

// ── Fixed-end forces for distributed loads ────────────────────────────────
/**
 * Returns 12-element array of fixed-end forces in LOCAL coordinates.
 * load: {dir:'y'|'z'|'x', w:number, w2?:number}
 *   w  = intensity at end i (node 1).
 *   w2 = intensity at end j (node 2); if omitted, uniform load (w2=w).
 * Trapezoidal = uniform(w1) + triangular(g = w2−w1, rising 0→g from i to j).
 * Triangular clamped-clamped FEM: V1=3gL/20, V2=7gL/20, M1=gL²/30, M2=gL²/20.
 */
export function fixedEndForces(L, load) {
  const f = Array(12).fill(0);
  const { dir } = load;
  const w1 = load.w;
  const w2 = (load.w2 == null) ? w1 : load.w2;
  const g  = w2 - w1;                    // triangular part (0 at i → g at j)
  const L2 = L * L;

  if (dir === 'x') {
    // Axial: uniform(w1) splits L/2-L/2; triangular uses linear N → gL/6, gL/3
    f[0]  = -(w1*L/2 + g*L/6);
    f[6]  = -(w1*L/2 + g*L/3);
  } else if (dir === 'y') {
    // Transverse y — XY bending
    f[1]  = -(w1*L/2  + 3*g*L/20);   // Vy1
    f[5]  = -(w1*L2/12 + g*L2/30);   // Mz1
    f[7]  = -(w1*L/2  + 7*g*L/20);   // Vy2
    f[11] =  (w1*L2/12 + g*L2/20);   // Mz2
  } else if (dir === 'z') {
    // Transverse z — XZ bending (moments with opposite sign to 'y')
    f[2]  = -(w1*L/2  + 3*g*L/20);   // Vz1
    f[4]  =  (w1*L2/12 + g*L2/30);   // My1
    f[8]  = -(w1*L/2  + 7*g*L/20);   // Vz2
    f[10] = -(w1*L2/12 + g*L2/20);   // My2
  }
  return f;
}

// ── Fixed-end forces WITH rigid end zones (#87) ───────────────────────────
/**
 * Same contract as fixedEndForces() (local 12-vector, caller does F -= Tᵀ·f),
 * but consistent with the rigid-arm kinematics used by elemLocalK/elemLocalM.
 * The load still acts over the whole length L; it is split in three:
 *   • the part on the rigid segment at i → straight to node i by statics
 *     (resultant P and its moment about the node — a rigid body has no FEF),
 *   • the part over the flexible span → standard FEF of length Lf, carried to
 *     the real node DOFs through the rigid arm (Q_node = Tᵀ·Q_flex),
 *   • the part on the rigid segment at j → straight to node j, likewise.
 * Without a rigid end it degrades exactly to fixedEndForces(L, load).
 */
export function fixedEndForcesRE(elem, L, load) {
  const ro = rigidEndOffsets(elem, L);
  if (!ro) return fixedEndForces(L, load);
  const { oi, oj, Lf } = ro;
  const { dir } = load;
  const w1 = load.w, w2 = (load.w2 == null) ? w1 : load.w2;
  const wAt = x => w1 + (w2 - w1) * (x / L);     // trapezoidal intensity at x

  // Flexible span, referred to the node DOFs through the rigid arm.
  const fFlex = fixedEndForces(Lf, { dir, w: wAt(oi), w2: wAt(L - oj) });
  const T = rigidEndTransform(oi, oj);
  const f = Array(12).fill(0);
  for (let i = 0; i < 12; i++)
    for (let j = 0; j < 12; j++)
      f[i] += T[j][i] * fFlex[j];

  // Rigid segment [x0, x0+len]: resultant P and its first moment M1 about x0.
  const seg = (x0, len) => {
    if (len <= 0) return { P: 0, M1: 0 };
    const wa = wAt(x0), wb = wAt(x0 + len);
    return { P: (wa + wb) / 2 * len, M1: len * len * (wa + 2 * wb) / 6 };
  };
  const si = seg(0, oi);                        // arm measured from node i (+x)
  const sj = seg(L - oj, oj);
  const Pj = sj.P, Mj = oj * sj.P - sj.M1;      // arm measured from node j (−x)

  // f = −(equivalent nodal load). r_i = (+a,0,0), r_j = (−b,0,0) → M = r×F.
  if (dir === 'x') {                            // axial: no lever arm
    f[0] -= si.P;   f[6]  -= Pj;
  } else if (dir === 'y') {
    f[1] -= si.P;   f[5]  -= si.M1;
    f[7] -= Pj;     f[11] += Mj;
  } else if (dir === 'z') {
    f[2] -= si.P;   f[4]  += si.M1;
    f[8] -= Pj;     f[10] -= Mj;
  }
  return f;
}
