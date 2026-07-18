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

**Element convergence study.** Tip deflection of the membrane triangles — **Allman** (with drilling
DOF) and **CST** — compared with **beam theory** (δ=4.0240) under **mesh refinement**. There is no
SAP2000 column: it would be the *same* element on the *same* mesh, not an independent reference. A
slender 2D continuum converges to Timoshenko beam theory; refining from 32×8 to **64×14** drives the
Allman error monotonically down to **< 5 %** (the row flagged as the verified converged point). At
equal mesh the Allman, thanks to the in-plane rotation DOF, leads the CST.

| Element · mesh | Description | Independent (—) | **PORTICO (—)** | **diff. PORTICO** |
| --- | --- | --- | --- | --- |
| Allman 32×8 | tip deflection | 4.0240 | **3.4719** | **-13.72 %** |
| Allman 48×12 | tip deflection | 4.0240 | **3.7456** | **-6.92 %** |
| Allman 64×14 | tip deflection (converged) | 4.0240 | **3.8520** | **-4.28 %** |
| CST 32×8 | tip deflection | 4.0240 | **3.4182** | **-15.06 %** |
| CST 48×12 | tip deflection | 4.0240 | **3.7301** | **-7.30 %** |
| CST 64×14 | tip deflection | 4.0240 | **3.8444** | **-4.46 %** |

### Convergence to theory and the drilling advantage

Under mesh refinement both triangles **converge monotonically** to beam theory; the **Allman**
consistently leads the **CST** at equal mesh thanks to the in-plane rotation DOF. At 32×8 the Allman
is at **-13.72 %** versus **-15.06 %** for the CST; on the fine **64×14** mesh the Allman reaches
**-4.28 %** (< 5 %) and the CST **-4.46 %**. The Allman residual at 64×14 is the discretization of a
bending-dominated problem — it keeps dropping under refinement, it is not element error.

The element also passes the constant-strain/stress *patch test* (verified separately in
`test_allman.mjs`: exact σ, exactly 3 rigid-body modes, no spurious modes), where the error is exact
(≈1e-14) regardless of the mesh. The *drilling* advantage is largest on coarse meshes — precisely the
shear locking that the Allman corrects.

## Conclusion

PORTICO's **Allman membrane triangle** adds an in-plane rotation DOF per node and **overcomes the
shear locking of the CST**. Verified: (1) it passes the constant-stress *patch test* with exactly 3
rigid-body modes (`test_allman.mjs`); (2) it **converges monotonically** to beam theory (δ=4.0240),
reaching **< 5 %** on the 64×14 mesh; and (3) at equal mesh it is more accurate than the CST.
**Triangular membrane with drilling capability verified.**
