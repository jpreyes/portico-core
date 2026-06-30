# Verification 1-012 — Braced frame — tension / compression limits

**English** · [Español](1-012_no_tension_no_compression.es.md)

**Verified capability:** members with a tension limit (compression-only / strut) and a compression limit (tension-only / cable) in the NL-lite solver.
**Reference:** CSI *Software Verification — SAP2000*, Example 1-012; independent by the unit-load method + statics (Cook & Young 1985).
**PORTICO model:** [`examples/verif_1-012c_no_tension.s3d`](../../examples/verif_1-012c_no_tension.s3d)

## Problem description

Single-bay, single-story braced frame (120 × 120 in) with two diagonals (an X-brace, not
connected at the crossing), under a 100 k horizontal load at the top corner. Beam and
diagonals with pinned ends (axial truss). The **tension/compression limits** are tested per
member in three models: **A** without limits (linear), **B** without compression in the
compressed diagonal (member 5 → **cable**, tension-only), **C** without tension in the
tensioned diagonal (member 4 → **strut**, compression-only, #56). The horizontal displacement
of the loaded corner and the support reactions are compared.

| Property | Value |
| --- | --- |
| Geometry | 120 × 120 in frame, 2-diagonal X-brace |
| Modulus E · Area | E = 30 000 k/in² · A = 8 in² |
| Load | 100 k horizontal at node 2 (top-left corner) |
| Member 4 (diag. 1-4) | tensioned — no tension in Model C (strut) |
| Member 5 (diag. 2-3) | compressed — no compression in Model B (cable) |

## PORTICO model

- All members as **axial bars** (corotational NL-lite truss). The "no tension" limit = **`compressionOnly`** (#56); the "no compression" limit = **`cable`** (tension-only).
- The three models are solved with the **same NL-lite solver**; A in 1 step (linear), B and C incrementally (the limited diagonal goes slack → N=0).
- Pinned supports at nodes 1 and 3. The figure shows Model C (strut): the tensioned diagonal goes slack and the brace works in compression only.

![Model C (strut): deformed shape under the horizontal load (×scale). The tensioned diagonal goes slack (N=0); the frame resists through the compressed diagonal and the columns.](img/1-012_no_tension_no_compression.svg)

*Figure 1. Model C (strut): deformed shape under the horizontal load (×scale). The tensioned diagonal goes slack (N=0); the frame resists through the compressed diagonal and the columns.*

## Results — comparison

Horizontal displacement U_x of node 2 and reactions F_x, F_z of supports 1 and 3, for the
three models. The independent reference matches SAP2000 exactly.

| Model | Description | Independent (in · kip) | SAP2000 (in · kip) | diff. SAP | **PORTICO (in · kip)** | **diff. PORTICO** |
| --- | --- | --- | --- | --- | --- | --- |
| A | U_x(2) — no limits (linear) | 0.1068 | 0.1068 | 0 % | **0.1068** | **0 %** |
| A | F_x(1) | -44.2240 | -44.2240 | 0 % | **-44.2917** | **+0.15 %** |
| A | F_x(3) | -55.7760 | -55.7760 | 0 % | **-55.7083** | **-0.12 %** |
| B | U_x(2) — no compression (cable, member 5) | 0.2414 | 0.2414 | 0 % | **0.2415** | **+0.05 %** |
| B | F_x(1) | -100.0000 | -100.0000 | 0 % | **-100.1597** | **+0.16 %** |
| B | F_x(3) | 0.0000 | 0.0000 | ≈0 | **0.1597** | **≈0** |
| C | U_x(2) — no tension (strut, member 4) | 0.1914 | 0.1914 | 0 % | **0.1913** | **-0.05 %** |
| C | F_x(1) | 0.0000 | 0.0000 | ≈0 | **-0.1594** | **≈0** |
| C | F_x(3) | -100.0000 | -100.0000 | 0 % | **-99.8406** | **-0.16 %** |

### Verticals and equilibrium

In all three models F_z(1) = −100 kip and F_z(3) = +100 kip (the horizontal load generates a
couple resisted by the columns), reproduced exactly. The small differences (<0.6 %) in the
horizontal reactions come from the **corotational geometric nonlinearity** of the NL-lite
solver versus the small-displacement analysis of the original; the displacement and the
force split between diagonals match.

## Conclusion

PORTICO reproduces the three models of Example 1-012 with **difference ≤ 0.6 %**: the linear
truss (A), the **no-compression** diagonal (cable, B → the compressed diagonal goes slack and
the tensioned one takes 100√2) and the **no-tension** diagonal (strut `compressionOnly`, C →
the tensioned diagonal goes slack and the compressed one takes −100√2). The **per-member
tension/compression limits** (#56) are validated against the CSI manual. **Compression-only /
tension-only member capability verified.**
