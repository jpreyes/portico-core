# Verification 1-018 — Static — bending, shear and axial in a frame

**English** · [Español](1-018_static_portal.es.md)

**Verified capability:** linear static analysis with bending, shear (Timoshenko) and axial deformation.
**Reference:** CSI *Software Verification — SAP2000*, Example 1-018; independent results by the unit-load method (Cook & Young 1985).
**PORTICO model:** [`examples/verif_1-018_static_portal.s3d`](../../examples/verif_1-018_static_portal.s3d)

## Problem description

Single-bay frame (a 288 in horizontal beam over two 144 in columns) with a **pinned
support** (node 1) and a **sliding support** (node 3), under a uniform vertical load of
0.1 k/in on the beam. The **vertical displacement at the beam midspan** (node 5) is
compared. Model A considers **the three deformations combined** (bending + shear + axial),
which is exactly PORTICO's Timoshenko element.

| Property | Value |
| --- | --- |
| Geometry | 288 in beam (2×144) over 144 in columns |
| Supports | node 1 pinned, node 3 sliding |
| Modulus E | 29 900 k/in² |
| G | 11 500 k/in² |
| Section W8X31 | A = 9.12 in², I = 110 in⁴, Aᵥ = 2.28 in² |
| Load | 0.1 k/in vertical on the beam |

## PORTICO model

- **2D** model, **rigid** beam-column joints; pinned and sliding bases (per the original figure).
- **Real** section (active A, I and shear area Aᵥ) → the element includes **bending + shear + axial** = Model A of the original.
- PORTICO's **Timoshenko** element captures shear deformation through the shear area `Avz`.

![Deformed shape under the vertical load (×scale). In gray the undeformed frame; in blue the deformed shape — the beam bends and the pinned/sliding supports allow rotation/displacement.](img/1-018_static_portal.svg)

*Figure 1. Deformed shape under the vertical load (×scale). In gray the undeformed frame; in blue the deformed shape — the beam bends and the pinned/sliding supports allow rotation/displacement.*

## Results — comparison

Vertical displacement at the beam midspan (node 5), Model A (bending + shear + axial). The
independent reference matches SAP2000 exactly.

| Model | Description | Independent (in) | SAP2000 (in) | diff. SAP | **PORTICO (in)** | **diff. PORTICO** |
| --- | --- | --- | --- | --- | --- | --- |
| A | Bending + shear + axial · U_z(node 5) | -2.77076 | -2.77076 | 0 % | **-2.77076** | **0 %** |

### Breakdown by deformation type (reference)

The original separates the contributions (same in SAP2000 and independent); their **sum
reproduces Model A**, confirming superposition:

| Model | Deformation | U_z(node 5) [in] |
|---|---|---|
| A | bending + shear + axial | −2.77076 |
| B | bending only | −2.72361 |
| C | shear only | −0.03954 |
| D | axial only | −0.00760 |
| | B + C + D | −2.77075 |

## Conclusion

PORTICO reproduces the Model A displacement with **0.000 % difference** (−2.77076 in),
identical to the independent solution and to SAP2000. The result correctly integrates the
**bending, shear and axial** deformations, validating the **Timoshenko** element (including
shear deformation) and the handling of pinned/sliding supports. **Static capability
(bending+shear+axial) verified.**
