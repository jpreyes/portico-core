// ──────────────────────────────────────────────────────────────────────────────
// mesher.js — 2D BLOCK mesher (MESHGEN style from Chandrupatla & Belegundu).
//
// Given a quadrilateral block of 4 corners (P1,P2,P3,P4 counter-clockwise), it
// generates a structured nx×ny cell mesh by BILINEAR INTERPOLATION of the block
// (mapping of the reference square ξ,η ∈ [0,1] to the real geometry).
// Used to mesh walls, panels and slabs (rectangular or trapezoidal) in
// QUAD (4 nodes) or CST (2 triangles per cell).
//
// SELF-CONTAINED (no dependencies) → verifiable in Node.
// Grid index: idx(i,j) = i*(ny+1) + j,  i∈[0,nx], j∈[0,ny].
// ──────────────────────────────────────────────────────────────────────────────

// Grid of (nx+1)×(ny+1) points by bilinear interpolation of the 4 corners.
// corners = [P1,P2,P3,P4] (each Pk = [x,y,z]), CCW. Corners:
//   idx(0,0)=P1, idx(nx,0)=P2, idx(nx,ny)=P3, idx(0,ny)=P4.
export function bilinearGrid(corners, nx, ny) {
  const [P1, P2, P3, P4] = corners;
  const pts = [];
  for (let i = 0; i <= nx; i++) {
    const xi = i / nx;
    for (let j = 0; j <= ny; j++) {
      const eta = j / ny;
      const a = (1 - xi) * (1 - eta), b = xi * (1 - eta), c = xi * eta, d = (1 - xi) * eta;
      pts.push([
        a * P1[0] + b * P2[0] + c * P3[0] + d * P4[0],
        a * P1[1] + b * P2[1] + c * P3[1] + d * P4[1],
        a * P1[2] + b * P2[2] + c * P3[2] + d * P4[2],
      ]);
    }
  }
  return pts;   // pts[idx(i,j)]
}

// Cell connectivity (grid indices). tri=false → QUAD [i,j],[i+1,j],
// [i+1,j+1],[i,j+1]; tri=true → 2 CST triangles per cell.
export function blockCells(nx, ny, tri = false) {
  const idx = (i, j) => i * (ny + 1) + j;
  const cells = [];
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
    const q = [idx(i, j), idx(i + 1, j), idx(i + 1, j + 1), idx(i, j + 1)];
    if (tri) { cells.push([q[0], q[1], q[2]]); cells.push([q[0], q[2], q[3]]); }
    else cells.push(q);
  }
  return cells;
}

// Grid indices of the 4 corners (to reuse the already-existing nodes).
export function cornerGridIndices(nx, ny) {
  const idx = (i, j) => i * (ny + 1) + j;
  return [idx(0, 0), idx(nx, 0), idx(nx, ny), idx(0, ny)];   // P1,P2,P3,P4
}
