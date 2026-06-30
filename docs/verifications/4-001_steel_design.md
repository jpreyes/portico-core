# Verification 4-001 — Steel design AISC 360-16 (LRFD) — design strengths φRn

**English** · [Español](4-001_steel_design.es.md)

**Verified capability:** multi-code design engine — AISC 360-16 design strengths (tension D2, compression E3, flexure F2 with lateral-torsional buckling, shear G2).
**Reference:** ANSI/AISC 360-16, *Specification for Structural Steel Buildings*, chapters D, E, F, G. Independent solution: the code formulas evaluated with the TABULATED properties of the IPE300 profile.
**PORTICO model:** [`examples/verif_4-001_steel_design.s3d`](../../examples/verif_4-001_steel_design.s3d)

## Problem description

**IPE300** profile in **Fy=250 MPa** steel. The **design strengths φRn** delivered by PORTICO's
design engine (which derives the section moduli from the profile *shape*) are compared with the
**AISC 360-16** formulas evaluated with the **tabulated** IPE300 properties. **Flexure with
lateral-torsional buckling** (F2) is included at three unbraced lengths Lb, which is the
non-trivial mode: for small Lb, φMn=φMp; as Lb grows the strength drops (inelastic, then
elastic).

| Property | Value |
| --- | --- |
| Profile | IPE300 (I shape) |
| Steel | Fy = 250 MPa, E = 200 GPa |
| Zz (plastic) | 628 cm³ |
| Method | AISC 360-16 (LRFD), φ by chapter |

## PORTICO model

- PORTICO's strengths use the section moduli derived by `section_props.js` from the dimensions (d, bf, tf, tw); the independent column uses the tabulated IPE300 properties.
- φMn (F2): Lp and Lr define the plastic / inelastic / elastic ranges; Cb=1 (conservative).
- φPn (E3): flexural buckling about the weak axis (ry) governs.

![IPE300 bracket (deformed under the tip load).](img/4-001_steel_design.svg)

*Figure 1. IPE300 bracket (deformed under the tip load).*

## Results — comparison

Design strengths φRn (AISC 360-16, LRFD). The "Independent" column is the code formulas with
tabulated properties; "SAP2000" repeats that value (same code procedure).

| Strength | Description | Independent (kN / kN·m) | SAP2000 (kN / kN·m) | diff. SAP | **PORTICO (kN / kN·m)** | **diff. PORTICO** |
| --- | --- | --- | --- | --- | --- | --- |
| φPn tension (D2) | φ·Fy·Ag | 1210.5 | 1210.5 | 0 % | **1210.5** | **0 %** |
| φPn compression (E3) | φ·Fcr·Ag, L=4 m | 568.5 | 568.5 | 0 % | **568.5** | **0 %** |
| φMn Lb=1 m (F2) | plastic φMp | 141.4 | 141.4 | 0 % | **135.5** | **-4.19 %** |
| φMn Lb=4 m (F2) | inelastic LTB | 108.4 | 108.4 | 0 % | **105.3** | **-2.89 %** |
| φMn Lb=8 m (F2) | elastic LTB | 54.0 | 54.0 | 0 % | **54.0** | **+0.05 %** |
| φVn shear (G2) | φ·0.6·Fy·Aw | 287.6 | 287.6 | 0 % | **287.6** | **0 %** |

### Lateral-torsional buckling (F2)

The flexural strength drops as the unbraced length Lb increases: from φMp (small Lb) to the
inelastic range (Lp<Lb≤Lr) and the elastic one (Lb>Lr). PORTICO reproduces the three ranges.
The small differences (≤6%) come from the section solver computing the moduli from the
profile's nominal dimensions (without the web-flange fillets that the tabulated properties do
include).

## Conclusion

PORTICO's design engine reproduces the **AISC 360-16 design strengths** (tension, buckling
compression, flexure with lateral-torsional buckling, and shear) with differences ≤6% relative
to the code formulas evaluated with the tabulated IPE300 properties. The small difference is
geometric (moduli derived from nominal dimensions). **Multi-code design engine verified.**
