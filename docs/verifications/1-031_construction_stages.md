# Verification 1-031 — Construction stages — propped cantilever by phases

**English** · [Español](1-031_construction_stages.es.md)

**Verified capability:** STAGED analysis with activation of elements/supports and state accumulation (weight/loads per phase).
**Reference:** analytical beam solution (cantilever and propped beam, Hibbeler/Gere) — the construction order changes the forces relative to monolithic assembly.
**PORTICO model:** [`examples/verif_1-031_construction_stages.s3d`](../../examples/verif_1-031_construction_stages.s3d)

## Problem description

8 m beam (2 elements of 4 m) fixed at node 1, built in **three stages**: (A) as a **cantilever**
under uniform load w₁ = 12 kN/m → the tip (node 3) deflects freely; (B) a **prop** (vertical
support) is placed at the tip, with no load; (C) w₂ = 20 kN/m is added with the tip **already
propped** (propped beam). The prop added in B **does not recover** the stage-A deflection (it
only restrains future increments), just as in real construction. That is why the final
deflection is NOT zero and the fixed-end moment differs from monolithic assembly.

| Property | Value |
| --- | --- |
| Geometry | 8 m beam (2 × 4 m), fixed at node 1 |
| Stage A | cantilever, w₁ = 12 kN/m (free tip) |
| Stage B | vertical prop at the tip (no load) |
| Stage C | w₂ = 20 kN/m (propped tip) |
| E | 2.1·10⁸ kN/m² |
| I | 8.333·10⁻⁶ m⁴ (shear-rigid) |

## PORTICO model

- **2D** model; self-weight is disabled (ρ=0) to isolate the staging effect.
- The **StagedSolver** assembles K with only the active elements and solves the **increment** of each phase; U and forces are **accumulated** per element.
- The tip support is **activated in stage B** → freezes the deflection already reached and only restrains the later increments.

![Accumulated deformed shape at the end of staged construction (×scale). The tip keeps the cantilever deflection (stage A) despite being propped afterward.](img/1-031_construction_stages.svg)

*Figure 1. Accumulated deformed shape at the end of staged construction (×scale). The tip keeps the cantilever deflection (stage A) despite being propped afterward.*

## Results — comparison

Results at the end of the sequence (accumulated state). The analytical reference combines the
stage-A cantilever with the stage-C propped beam.

| Quantity | Description | Independent (—) | SAP2000 (—) | diff. SAP | **PORTICO (—)** | **diff. PORTICO** |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Tip deflection, node 3 · U_z [m] | -3.511 | -3.511 | 0 % | **-3.511** | **0 %** |
| 2 | Fixed-end moment, elem 1 · |M| [kN·m] | 544.000 | 544.000 | 0 % | **544.000** | **0 %** |
| 3 | Prop reaction, node 3 · R_z [kN] | 60.000 | 60.000 | 0 % | **60.000** | **0 %** |

### Contrast with MONOLITHIC assembly

If the same beam were propped from the start and loaded all at once with w₁+w₂ = 32 kN/m
(propped beam), the results would be **different** — that is the whole point of staged analysis:

| Quantity | Staged | Monolithic |
|---|---|---|
| Tip deflection U_z [m] | −3.511 | 0.000 (propped) |
| Fixed-end moment |M| [kN·m] | 544.0 | 256.0 = (w₁+w₂)L²/8 |

**Analytical verification of the stages:** cantilever deflection δ = w₁L⁴/(8EI) = **3.511 m**;
base moment = w₁L²/2 (cantilever) + w₂L²/8 (propped) = 384 + 160 = **544 kN·m**; prop reaction
= 3w₂L/8 = **60 kN** (only w₂, because the prop did not exist under w₁).

## Conclusion

The **StagedSolver** reproduces, with **0.0 %** error, the tip deflection (−3.511 m), the
fixed-end moment (544 kN·m) and the prop reaction (60 kN) computed analytically for the
construction sequence. The result **clearly differs from monolithic assembly** (0 deflection,
256 kN·m moment), confirming that element/support activation and **per-phase state
accumulation** work as in SAP2000/CSiBridge. **Construction-stages capability (#59) verified.**
