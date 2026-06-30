# Verification 1-014 — Modal analysis of a cantilever beam

**English** · [Español](1-014_modal_cantilever.es.md)

**Verified capability:** modal analysis (bending frequencies and mode shapes).
**Reference:** CSI *Software Verification — SAP2000*, Example 1-014; independent solution from **Clough & Penzien (1975)** for a cantilever of uniform mass and constant `EI`.
**PORTICO model:** [`examples/verif_1-014_modal_cantilever.s3d`](../../examples/verif_1-014_modal_cantilever.s3d)

## Problem description

Concrete cantilever beam **96 in** (8 ft) long, rectangular 12×18 in section, with a
different `I` about each axis. The **first five bending modes** are compared against the
analytical solution. Only bending modes are considered: the axial (Ux) and torsional (Rx)
DOFs are excluded, and **shear deformation is ignored** (Euler-Bernoulli theory).

| Property | Value |
| --- | --- |
| Length L | 96 in |
| Modulus E | 3 600 k/in² |
| Mass per volume ρ | 2.3·10⁻⁷ k·s²/in⁴ |
| Area A | 216 in² |
| I about the strong axis (Y) | 5 832 in⁴ |
| I about the weak axis (Z) | 2 592 in⁴ |

## PORTICO model

- **`Avy = Avz = 0`** → the element behaves as **Euler-Bernoulli** (no shear deformation), as in the original (which zeroes the shear area).
- **Ux and Rx are restrained** at every node → only bending modes appear.
- **Consistent** mass (PORTICO) — converges to the analytical value faster than the reference software's lumped mass.

![Mode 1 (T = 0.038 s) — first bending of the cantilever. In gray the undeformed geometry; in blue the mode shape.](img/1-014_modal_cantilever.svg)

*Figure 1. Mode 1 (T = 0.038 s) — first bending of the cantilever. In gray the undeformed geometry; in blue the mode shape.*

## Results — comparison

Periods of the first five bending modes. Analytical reference = independent solution from
Clough & Penzien; reference software = **SAP2000** at its finest mesh (Model G, 96
elements, lumped mass). The difference is computed against the independent solution.

| Mode | Description | Independent (s) | SAP2000 (s) | diff. SAP | **PORTICO (s)** | **diff. PORTICO** |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 1st bending, weak axis | 0.038005 | 0.038003 | -0.01 % | **0.038001** | **-0.01 %** |
| 2 | 1st bending, strong axis | 0.025337 | 0.025335 | -0.01 % | **0.025334** | **-0.01 %** |
| 3 | 2nd bending, weak axis | 0.006064 | 0.006065 | +0.02 % | **0.006064** | **0 %** |
| 4 | 2nd bending, strong axis | 0.004043 | 0.004043 | 0 % | **0.004042** | **-0.01 %** |
| 5 | 3rd bending, weak axis | 0.002165 | 0.002166 | +0.05 % | **0.002166** | **+0.02 %** |

### Convergence (mode 1) — consistent vs. lumped mass

SAP2000 uses **lumped mass**, which converges slowly with discretization; PORTICO uses
**consistent mass**, which converges much faster. Mode-1 period (independent = 0.038005 s):

| Discretization | SAP2000 (s) | diff. SAP | PORTICO 16 el (s) | diff. PORTICO |
|---|---|---|---|---|
| 1 elem (A) | 0.054547 | +43.53 % | — | — |
| 2 elem (B) | 0.042333 | +11.39 % | — | — |
| 4 elem (C) | 0.039090 | +2.85 % | — | — |
| 8 elem (E) | 0.038273 | +0.71 % | — | — |
| 10 elem (F) | 0.038175 | +0.45 % | **0.038001** | **-0.01 %** |
| 96 elem (G) | 0.038003 | −0.01 % | — | — |

With only **16 elements** PORTICO reaches the accuracy SAP2000 achieves with **96**.

## Conclusion

PORTICO reproduces the modal periods with **error ≤ 0.05 % across all five modes**, in
agreement with the analytical solution of Clough & Penzien and with the reference
software's converged result (SAP2000, 96 elements). The fast convergence with only 16
elements comes from combining **consistent mass** and the **Euler-Bernoulli** element
(`Avy = Avz = 0`, no shear deformation). **PORTICO's modal capability verified.**
