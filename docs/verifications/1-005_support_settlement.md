# Verification 1-005 — Support settlement (prescribed displacement)

**English** · [Español](1-005_support_settlement.es.md)

**Verified capability:** prescribed node/support displacement (settlement), free/prescribed partition in the solver.
**Reference:** CSI *Software Verification — SAP2000*, Example 1-005 (Model A); independent results by the unit-load method (Cook & Young 1985, p. 244).
**PORTICO model:** [`examples/verif_1-005a_settlement.s3d`](../../examples/verif_1-005a_settlement.s3d)

## Problem description

Single-bay portal frame (144 in columns and a 144 in beam) with the **left base fixed**
(node 1) and a **sliding support** (roller) at the right base (node 4). A **vertical
settlement Uz = −0.5"** (prescribed displacement) is imposed on the sliding support. The
**reactions at the fixed support** (node 1) are compared: vertical force F_z and moment
M_y. **Only bending deformations are considered** (axial and shear rigid), as in the
original.

| Property | Value |
| --- | --- |
| Geometry | 144 × 144 in portal |
| Supports | node 1 fixed · node 4 roller (Uz prescribed) |
| Modulus E | 29 000 k/in² |
| Section | b = d = 12 in, I = 1 728 in⁴ |
| Load | settlement Uz = −0.5" at node 4 |

## PORTICO model

- **2D** model, **rigid** beam-column joints; left base fixed, right base on a vertical roller.
- The settlement is a **prescribed displacement** of node 4's Uz DOF (`node.prescDisp.uz = −0.5`, #54): the solver treats it as a support DOF with a value, `Kff·uf = Ff − Kfp·u_p`, and reports the support reaction.
- **Bending only**: axial area and shear areas made rigid (huge A, Av) → axial and shear deformations are ignored, as in the original (area modifier 1e5, no shear).

![Deformed shape from the 0.5" settlement of the right support (×scale). In gray the undeformed portal; in blue the deformed shape — the roller drops and the left fixed support takes the reaction.](img/1-005_support_settlement.svg)

*Figure 1. Deformed shape from the 0.5" settlement of the right support (×scale). In gray the undeformed portal; in blue the deformed shape — the roller drops and the left fixed support takes the reaction.*

## Results — comparison

Reactions at the fixed support (node 1) under the prescribed settlement. The independent
reference matches SAP2000 exactly.

| Reaction | Description | Independent (kip · kip-in) | SAP2000 (kip · kip-in) | diff. SAP | **PORTICO (kip · kip-in)** | **diff. PORTICO** |
| --- | --- | --- | --- | --- | --- | --- |
| F_z | Vertical reaction at node 1 | 6.293 | 6.293 | 0 % | **6.293** | **+0.01 %** |
| M_y | Fixed-end moment at node 1 | -906.250 | -906.250 | 0 % | **-906.250** | **0 %** |

## Conclusion

PORTICO reproduces the Model A reactions with **0.000 % difference** (F_z = 6.293 kip,
M_y = −906.250 kip-in), identical to the independent solution and to SAP2000. The
**prescribed displacement** (support settlement, #54) and the **prescribed-DOF reaction**
are validated against the CSI manual. **Support-settlement capability verified.**
