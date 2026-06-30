# Verification 2-014 — Thermal gradient through the thickness (annular plate)

**English** · [Español](2-014_thermal_gradient_plate.es.md)

**Verified capability:** temperature gradient through the plate/shell thickness → thermal bending moment.
**Reference:** CSI *Software Verification — SAP2000*, Example 2-014 (Roark & Young 1975, Table 24, item 8e).
**PORTICO model:** [`examples/verif_2-014_thermal_gradient.s3d`](../../examples/verif_2-014_thermal_gradient.s3d)

## Problem description

Flat **annular** plate (inner radius 3 in, outer 30 in, thickness 1 in) **fixed at the outer
perimeter** and free at the inner one. A **100 °F temperature gradient through the thickness**
is applied (the bottom face 100 °F hotter than the top), with α = 6.5×10⁻⁶/°F. The gradient
induces a **thermal curvature** that lifts the free inner edge. The **vertical displacement
U_z** and the (tangential) **rotation R₂** of the inner edge are compared with the Roark &
Young analytical solution.

| Property | Value |
| --- | --- |
| Geometry | annular plate r_in=3, r_out=30, t=1 in |
| Mesh | 18×32 (radial × tangential) shell quads |
| Modulus E | 29 000 k/in² |
| Poisson ν | 0.3 · α = 6.5×10⁻⁶/°F |
| Load | 100 °F gradient (bottom face hotter) |

## PORTICO model

- Areas with **shell** behavior (membrane + MITC4 plate). The gradient is entered as **per-face temperature** (#57): bottom face (−z) +100 °F, top face (+z) 0 °F.
- The difference between faces generates a **thermal curvature** κ₀ = α·ΔT/t → bending moment; the mean (50 °F) only expands in-plane (no effect since the plate is restrained).
- Perfect fixity of the outer ring (6 DOF). The hotter bottom face lifts the inner edge (+z), as in the original.

![Annular plate (fixed at the outer edge); deformed by the thermal gradient (×scale) — the free inner edge lifts due to the thermal curvature.](img/2-014_thermal_gradient_plate.svg)

*Figure 1. Annular plate (fixed at the outer edge); deformed by the thermal gradient (×scale) — the free inner edge lifts due to the thermal curvature.*

## Results — comparison

Displacement and rotation of the inner edge (18×32 mesh, refinement of the original's 9×16
"Model A"). Roark & Young analytical reference.

| Parameter | Description | Independent (in · rad) | SAP2000 (in · rad) | diff. SAP | **PORTICO (in · rad)** | **diff. PORTICO** |
| --- | --- | --- | --- | --- | --- | --- |
| U_z | Vertical displacement of the inner edge | 0.01931 | 0.01922 | -0.47 % | **0.01905** | **-1.33 %** |
| R₂ | Tangential rotation of the inner edge | 0.00352 | 0.00351 | -0.28 % | **0.00342** | **-2.92 %** |

### Thermal curvature (#57)

The gradient imposes a curvature κ₀ = α·ΔT/t = 6.5×10⁻⁶·100/1 = 6.5×10⁻⁴ 1/in. Since the plate
is fixed outside and free inside, that curvature lifts the inner edge. Roark's solution (Table
24, 8e, b/a=0.1): U_z = K_y·α·ΔT·a²/t with K_y=0.0330 → **0.01931 in**; R₂ = K_θ·α·ΔT·a/t with
K_θ=−0.1805 → **0.00352 rad**.

### Mesh convergence

The MITC4 element (Mindlin thick plate) converges under refinement, as the CSI manual itself
documents (its Model B 28×32 gives U_z −2 % / R₂ −1 %):

| Mesh | U_z [in] (→0.01931) | R₂ [rad] (→0.00352) |
|---|---|---|
| 9×16  | 0.01859 (−3.7 %) | 0.00320 (−9 %) |
| 18×32 | 0.01905 (−1.3 %) | 0.00342 (−2.8 %) |

## Conclusion

PORTICO reproduces the annular plate's response to the **through-thickness thermal gradient**
(#57): U_z = 0.01905 in (−1.3 %) and R₂ = 0.00342 rad (−2.8 %) at the inner edge, in line with
the analytical solution (0.01931 / 0.00352) and with SAP2000. The **thermal bending curvature**
(plate thermal moment) is validated, including the **physical sign** (the hotter face elongates
and the plate curves toward it). **Thermal-gradient capability in areas verified.**
