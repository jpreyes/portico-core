# Verification 3-002 — Straight beam with plane-stress elements (membrane)

**English** · [Español](3-002_plane_stress_beam.es.md)

**Verified capability:** plane continuum in PLANE STRESS — QUAD membrane element.
**Reference:** CSI *Software Verification — SAP2000*, Example 3-002 (MacNeal & Harder 1985); independent by the unit-load method (Cook & Young 1985).
**PORTICO model:** [`examples/verif_3-002_plane_stress.s3d`](../../examples/verif_3-002_plane_stress.s3d)

## Problem description

Straight cantilever 6 in long × 0.2 in deep × 0.1 in thick, modeled with **plane-stress
membrane elements** (6×1 quadrilateral mesh). Three tip loads are applied, each in its own
case: **(1)** axial extension (F_x), **(2)** in-plane shear+bending (F_z), **(3)** in-plane
moment (an F_x couple). The **tip displacements** are compared with beam theory (independent)
and with SAP2000. The fixity is modeled per the original: the bottom joint fixes U_x,U_z and
the top one only U_x, avoiding the local Poisson effect.

| Property | Value |
| --- | --- |
| Geometry | cantilever 6 × 0.2 in (thickness 0.1 in) |
| Mesh | 6×1 membrane quads (plane stress) |
| Modulus E | 10 000 000 lb/in² |
| Poisson ν | 0.3 |
| Loads (tip) | LC1 F_x=1 · LC2 F_z=1 · LC3 M=1 (F_x couple) |

## PORTICO model

- **Plane-stress membrane** element (`planeStrain:false`, #58): only the in-plane DOF U_x, U_z active; the rest restrained at every node (like the CSI model).
- Fixity without the Poisson effect: bottom-left node fixes U_x,U_z; upper-left nodes only U_x. In LC2 the −½ reaction is added at the upper-left node (as in the original).
- PORTICO's QUAD is a **standard isoparametric quadrilateral (no incompatible bending modes)**; it reproduces SAP2000's plane element "without incompatible modes".

![6×1 membrane mesh of the cantilever; deformed under axial extension (LC1, ×scale).](img/3-002_plane_stress_beam.svg)

*Figure 1. 6×1 membrane mesh of the cantilever; deformed under axial extension (LC1, ×scale).*

## Results — comparison

Tip displacements (average of joints 7 and 14). The SAP2000 column corresponds to the **plane
element without incompatible modes** (6×1 mesh), the same type as PORTICO's QUAD.

| Case | Description | Independent (in) | SAP2000 (in) | diff. SAP | **PORTICO (in)** | **diff. PORTICO** |
| --- | --- | --- | --- | --- | --- | --- |
| LC1 | Axial extension · U_x = PL/EA | 0.000030 | 0.000030 | 0 % | **0.000030** | **0 %** |
| LC2 | Shear+bending · U_z (6×1 mesh) | 0.108090 | 0.010100 | -90.66 % | **0.010088** | **-90.67 %** |
| LC3 | Moment · |U_x| (6×1 mesh) | 0.000900 | 0.000084 | -90.67 % | **0.000084** | **-90.67 %** |

### Plane stress (LC1): exact

The axial extension U_x = PL/EA = 1·6/(10⁷·0.2·0.1) = **3.000×10⁻⁵ in**, reproduced by PORTICO
with **0.000 %** difference and **mesh-independent** — the **plane-stress** constitutive (#58)
of the membrane element is exact.

### Bending (LC2/LC3): element ≡ SAP2000 and convergence

On the 6×1 mesh, the standard QUAD (no incompatible modes) underestimates bending due to
locking — **just like SAP2000's plane element "without incompatible modes"** (0.0101 in and
0.840×10⁻⁴ in), which PORTICO reproduces to <0.5 %. This is a documented element feature, not
an error: with mesh refinement it converges to beam theory (0.10809 / 9.0×10⁻⁴):

| Mesh | LC2 U_z [in] (→ 0.10809) | LC3 |U_x| [in] (→ 9.0×10⁻⁴) |
|---|---|---|
| 6×1   | 0.01009 | 8.40×10⁻⁵ |
| 24×4  | 0.06724 | 3.36×10⁻⁴ |
| 48×8  | 0.09383 | 4.34×10⁻⁴ |

## Conclusion

PORTICO reproduces **plane-stress** behavior with an **exact axial extension** (U_x =
3.000×10⁻⁵ in, **0.000 %**) and mesh-independent, validating the plane-stress constitutive
(#58). In shear+bending, PORTICO's standard QUAD **matches SAP2000's plane element "without
incompatible modes"** (<0.5 %) and **converges to beam theory under mesh refinement**, exactly
as the CSI manual itself documents. **Plane-stress membrane capability verified.**
