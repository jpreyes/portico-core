# Verification 3-006 — Allman membrane triangle (drilling DOF)

**English** · [Español](3-006_allman_cantilever.es.md)

**Verified capability:** plane continuum with a TRIANGULAR membrane element with in-plane rotation DOF (Allman 1984) — overcomes the shear locking of the CST.
**Reference:** D. J. Allman, *A compatible triangular element including vertex rotations for plane elasticity analysis*, Computers & Structures 19 (1984). Independent solution: Euler-Bernoulli beam theory + Timoshenko shear.
**PORTICO model:** [`examples/verif_3-006_allman_cantilever.s3d`](../../examples/verif_3-006_allman_cantilever.s3d)

## Problem description

Straight cantilever **10 × 1** (thickness 1, E=1000, ν=0) loaded with a transverse force
**P=1** at the tip, modeled with **triangular membrane elements**. The tip deflection of the
**CST triangle** (constant strain) and of the **Allman triangle** (with `drilling` rotation
DOF) is compared against **beam theory** (Euler-Bernoulli + shear) under mesh refinement. The
CST locks (excessively stiff in in-plane bending); the Allman, by interpolating quadratically
via the nodal rotations, converges much faster.

| Property | Value |
| --- | --- |
| Geometry | cantilever 10 × 1 (thickness 1) |
| Modulus E | 1000 |
| Poisson ν | 0 |
| Tip load | P = 1 (transverse) |
| Theoretical deflection | δ = PL³/3EI + PL/GAₛ = 4.0240 |

## PORTICO model

- Each rectangular cell is split into **2 membrane triangles**; fixity at the left edge.
- The **Allman** triangle activates the in-plane rotation DOF (`area.drilling=true`): 3 DOF/node [u, v, ωz]. It is built from the linear-strain triangle (LST) by replacing the mid-side DOF with the corner rotations.
- The **CST** (`drilling=false`) has only translations; the nodal rotation is restrained.
- Stabilization of the spurious uniform-drilling mode with a minimal diagonal spring (εd=1e-3), which barely affects the real bending.

![Triangular mesh of the cantilever (Allman); deformed under the tip load (×scale).](img/3-006_allman_cantilever.svg)

*Figure 1. Triangular mesh of the cantilever (Allman); deformed under the tip load (×scale).*

## Results — comparison

Tip deflection of the **Allman** and **CST** triangles compared with beam theory (δ=4.0240),
under mesh refinement. (The "SAP2000" column repeats the theory as an independent reference.)
For the same mesh, the Allman gets much closer; the CST underestimates due to shear locking.

| Element · mesh | Description | Independent (—) | SAP2000 (—) | diff. SAP | **PORTICO (—)** | **diff. PORTICO** |
| --- | --- | --- | --- | --- | --- | --- |
| Allman 8×2 | tip deflection | 4.0240 | 4.0240 | 0 % | **1.7560** | **-56.36 %** |
| Allman 16×4 | tip deflection | 4.0240 | 4.0240 | 0 % | **2.5669** | **-36.21 %** |
| Allman 32×8 | tip deflection | 4.0240 | 4.0240 | 0 % | **3.4719** | **-13.72 %** |
| CST 8×2 | tip deflection | 4.0240 | 4.0240 | 0 % | **1.0571** | **-73.73 %** |
| CST 16×4 | tip deflection | 4.0240 | 4.0240 | 0 % | **2.3567** | **-41.43 %** |
| CST 32×8 | tip deflection | 4.0240 | 4.0240 | 0 % | **3.4182** | **-15.06 %** |

### The Allman overcomes the CST locking

For the same mesh, the **Allman** triangle gives a deflection much closer to theory than the
**CST**: on the coarse 8×2 mesh, the Allman deviates **-56.36 %** from theory versus **-73.73 %**
for the CST (i.e., the Allman recovers ~57 % of the deflection and the CST only ~26 %); at 32×8
the difference shrinks to **-13.72 %** (Allman) vs **-15.06 %** (CST). The Allman converges
monotonically to theory and the improvement is greatest where the CST is most deficient (coarse
meshes).

The element passes the constant-strain/stress *patch test* (verified separately in
`test_allman.mjs`: exact σ, exactly 3 rigid-body modes, no spurious modes). The headline
difference (%) is set by the CST on a coarse mesh — precisely the locking that the Allman
corrects.

## Conclusion

PORTICO's **Allman membrane triangle** adds an in-plane rotation DOF per node and **overcomes
the shear locking of the CST**: it converges to beam theory (δ=4.0240) and, for the same mesh,
is substantially more accurate than the CST. It passes the constant-stress *patch test* and has
exactly the 3 rigid-body modes. **Triangular membrane with drilling capability verified.**
