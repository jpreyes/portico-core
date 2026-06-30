# Verification 1-017 — Vibration of a string under tension (modal with geometric stiffness)

**English** · [Español](1-017_taut_string.es.md)

**Verified capability:** modal analysis with geometric stiffness Kg from a reference state (stiffening by tension / pre-stress).
**Reference:** CSI *Software Verification — SAP2000*, Example 1-017; independent by vibrating-string theory (Kreyszig 1983, pp. 506-510).
**PORTICO model:** [`examples/verif_1-017_taut_string.s3d`](../../examples/verif_1-017_taut_string.s3d)

## Problem description

A flexible 100 in string, anchored at both ends and **tensioned to 0.5 k**, vibrates
laterally. The first three frequencies come from the **geometric stiffness due to tension**
(the string has almost no bending stiffness: a 1/16" wire). It is modeled as a bar
discretized into 10 elements; the tension is applied with a static load (0.5 k axial at the
moving end) that generates the **reference state for Kg**, and the modal runs over **K +
Kg(state)** (#55). f₁, f₂, f₃ are compared with vibrating-string theory.

| Property | Value |
| --- | --- |
| Geometry | 100 in string, 10 elements |
| Section | 1/16" Ø wire, A = 0.00306796 in² |
| Modulus E | 30 000 k/in² |
| Mass per volume | 7.324×10⁻⁷ k·s²/in⁴ |
| Tension | T = 0.5 k (reference axial load) |

## PORTICO model

- The **tension** is introduced with a static case (F_x = 0.5 k axially at the free end) → reference state with N = +0.5 k uniform.
- The modal runs over **K + Kg** with the "include P-Δ geometric stiffness" toggle (#55): the tension stiffens the lateral modes. Without Kg, the string (EI≈0) would have no transverse stiffness.
- Analytical string frequency: f_n = (n/2L)·√(T/μ), with μ = ρ·A the mass per unit length.

![First lateral mode of the tensioned string (×scale) — a half sine wave, stiffness provided entirely by the tension (Kg).](img/1-017_taut_string.svg)

*Figure 1. First lateral mode of the tensioned string (×scale) — a half sine wave, stiffness provided entirely by the tension (Kg).*

## Results — comparison

First three frequencies of the tensioned string. The independent reference is vibrating-string
theory (Kreyszig). PORTICO's modal uses K+Kg of the tensioned state.

| Mode | Description | Independent (Hz) | SAP2000 (Hz) | diff. SAP | **PORTICO (Hz)** | **diff. PORTICO** |
| --- | --- | --- | --- | --- | --- | --- |
| f₁ | First mode (half wave) | 74.586 | 74.579 | -0.01 % | **74.587** | **0 %** |
| f₂ | Second mode (full wave) | 149.170 | 148.930 | -0.16 % | **149.185** | **+0.01 %** |
| f₃ | Third mode (1½ wave) | 223.760 | 222.060 | -0.76 % | **223.804** | **+0.02 %** |

### Stiffening by tension (Kg)

The string barely resists bending (EI of the 1/16" wire ≈ 0); all lateral stiffness comes
from the **tension**: the Kg matrix (assembled with N = +0.5 k from the reference state) is
added to K before the modal. This is the **modal-with-geometric-stiffness** mechanism (#55),
analogous to SAP2000's "modal on a nonlinear case with P-Δ".

The theoretical frequency f_n = (n/2L)·√(T/μ) = 74.586·n Hz gives 74.586 / 149.17 / 223.76 Hz.

### Consistent vs lumped mass

With only 10 elements and **consistent mass**, PORTICO reaches the analytical solution (diff
≤ 0.02 %), surpassing SAP2000's Model A (10 elements, **lumped** mass: f₃ −0.76 %) and
matching its Model B (100 elements). Refining to 100 elements does not change PORTICO's result.

## Conclusion

PORTICO reproduces the first three frequencies of the tensioned string with **difference ≤
0.02 %** (74.587 / 149.18 / 223.80 Hz vs 74.586 / 149.17 / 223.76 Hz analytical), with only 10
elements. The **modal with geometric stiffness Kg** (#55) —where the lateral stiffness comes
entirely from the reference-state tension— is validated against vibrating-string theory.
**Modal with Kg / pre-stress capability verified.**
