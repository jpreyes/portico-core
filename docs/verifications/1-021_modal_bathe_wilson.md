# Verification 1-021 — Modal analysis — Bathe-Wilson frame (10 bays × 9 stories)

**English** · [Español](1-021_modal_bathe_wilson.es.md)

**Verified capability:** modal analysis of a large planar frame (ω² eigenvalues).
**Reference:** CSI *Software Verification — SAP2000*, Example 1-021; independent solutions from **Bathe & Wilson (1972)** and **Peterson (1981)**.
**PORTICO model:** [`examples/verif_1-021_modal_bathe_wilson.s3d`](../../examples/verif_1-021_modal_bathe_wilson.s3d)

## Problem description

Planar frame of **10 bays × 9 stories** (10 @ 20 ft = 200 ft wide, 9 @ 10 ft = 90 ft tall),
fixed base — the classic Bathe & Wilson 1972 benchmark. The **first three eigenvalues** (ω²)
are compared. **Bending and axial** deformations are considered (shear deformation is ignored,
shear area = 0).

| Property | Value |
| --- | --- |
| Geometry | 10 bays @ 20 ft × 9 stories @ 10 ft |
| Modulus E | 432 000 k/ft² |
| Area A | 3 ft² |
| Inertia I | 1 ft⁴ |
| Mass per unit length | 3 k·s²/ft² |
| Elements | 189 (99 columns + 90 beams) |

## PORTICO model

- **2D** model (one element per member), fixed base.
- **`Avy = Avz = 0`** → no shear deformation (as in the original); **axial included**.
- Mass per length = `ρ·A` with `ρ = 1`, `A = 3` → 3 k·s²/ft². **Consistent** mass.

![Mode 1 (ω² = 0.5899, T = 8.18 s) — first lateral sway mode of the frame.](img/1-021_modal_bathe_wilson.svg)

*Figure 1. Mode 1 (ω² = 0.5899, T = 8.18 s) — first lateral sway mode of the frame.*

## Results — comparison

First three ω² eigenvalues. SAP2000 matches the independent solutions exactly; the difference
is computed against that value.

| Mode | Description | Independent (ω²) | SAP2000 (ω²) | diff. SAP | **PORTICO (ω²)** | **diff. PORTICO** |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 1st mode | 0.5895 | 0.5895 | 0 % | **0.5899** | **+0.05 %** |
| 2 | 2nd mode | 5.5270 | 5.5270 | 0 % | **5.5524** | **+0.46 %** |
| 3 | 3rd mode | 16.5879 | 16.5879 | 0 % | **16.7925** | **+1.23 %** |

## Conclusion

PORTICO reproduces the **first eigenvalue within +0.05 %** (essentially exact) and the 2nd and
3rd within **+0.5 % and +1.2 %**. The small differences in the higher modes reflect PORTICO's
**consistent-mass** formulation versus the benchmark's mass model (further subdivision of the
members does not reduce them, confirming they are not a discretization error). The subspace-
iteration modal solver correctly handles a large planar frame (110 nodes). **Modal capability
for frames verified.**
