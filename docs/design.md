# Element design — generalized multi-code engine

**English** · [Español](design.es.md)

PORTICO checks elements (bending, shear, axial and interaction) against real design codes
—**AISC 360-16 (LRFD/ASD)** and **Eurocode 3 (EN 1993-1-1)** for steel, **ACI 318-19 / EC2**
for concrete and **NCh1198** for timber— just like SAP2000's verification for the covered modes.
Everything runs in the browser (and in Node through the [public API](api.md)).

## Core idea: design is **generalized**

Previously the design parameters lived in a global JSON *per typology* (a single `Fy` for all
steel, a single `f'c` for all concrete) and the material type was guessed from its **name**.
That made it impossible to design a material with different properties. Now:

1. **Strengths belong to the MATERIAL** (`mat.design`).
2. **The design geometry belongs to the SECTION** (`sec.design`).
3. **Codes are pluggable modules** in a registry, extensible via the API.

So **any material and any section** can be designed, and the code can be chosen per family.

## Material design data — `mat.design`

```js
mat.design = {
  family: 'steel' | 'concrete' | 'timber' | 'aluminum',
  // steel / aluminum (MPa):
  Fy: 355, Fu: 470,
  // concrete (MPa):
  fc: 30, fyRebar: 420,
  // timber (MPa) + modification factors:
  Fb: 11, Fv: 1.5, Fc: 9, Ft: 8, Fcp: 2.5,
  factores_modificacion: { KD_duracion_carga: 0.9, KH_contenido_humedad: 1, Kt_temperatura: 1, otros: 1 },
}
```

Strengths are given in **MPa**; the elastic modulus `E` is taken from the material (in kN/m², as
in the solver). If `mat.design` does not exist, the material is classified by its name and the
strengths fall back to the legacy JSON `assistant/design_params.json` (compatibility).
`material_props.js` resolves everything to kN/m².

## Section design data — `sec.design`

The model section provides `A, Iy, Iz, J` for **analysis**. For **design** the **shape** is also
needed, from which `section_props.js` derives the elastic moduli `S`, the **plastic moduli `Z`**,
the radii `r`, the warping constant `Cw`, the shear areas `Av` and the wall slendernesses (`b/t`,
`h/tw`):

```js
sec.design = { shape: 'I',     d: 0.30, bf: 0.15, tf: 0.0107, tw: 0.0071 }   // I-beam
sec.design = { shape: 'rect',  b: 0.30, h: 0.50 }                            // solid rectangle
sec.design = { shape: 'circle', D: 0.40 }                                    // solid circle
sec.design = { shape: 'pipe',  D: 0.40, t: 0.012 }                           // circular tube
sec.design = { shape: 'box',   b: 0.20, h: 0.30, t: 0.010 }                  // rectangular tube
// reinforced concrete:
sec.design = { shape: 'rect', b: 0.3, h: 0.5, rebar: { rho: 0.012, cover_mm: 40 } }
```

If there is no `shape` (or it is `'generic'`), an **equivalent rectangle** is used from `A, I`
(historical behavior), with `Z = shapeFactor·S`. For `A, Iy, Iz, J` the model values are always
preferred (what the solver sees) for consistency. Any property can be overridden explicitly
(e.g., giving the tabulated `Zz` and `Cw` of a real profile).

Verified against the tabulated **IPE300** (A, Iz, Wel, Wpl, r) with error ≤6% (the difference is
the web-flange fillet rounding that is not modeled).

## Implemented codes

| Code | id | Family | Modes |
|---|---|---|---|
| AISC 360-16 (LRFD) | `AISC360-16:LRFD` | steel | D2, E3, F2 (+LTB), F6, G2, H1.1 |
| AISC 360-16 (ASD)  | `AISC360-16:ASD`  | steel | same, with Ω |
| Eurocode 3         | `EN1993-1-1`      | steel | 6.2.3, 6.3.1 (χ), 5.5, 6.3.2 (χLT), 6.2.6, 6.3.3 |
| ACI 318-19         | `ACI318-19`       | concrete | bending, shear, axial, P-M |
| Eurocode 2         | `EN1992-1-1`      | concrete | idem (rectangular block) |
| NCh1198            | `NCh1198`         | timber | allowable stresses + stability |

**Steel — what is actually checked:** tension (gross-area yielding), flexural buckling
compression (`Fcr` AISC E3 / χ curves EC3), bending with **lateral-torsional buckling**
(`Lp/Lr/Cb` in AISC F2; `Mcr` and `χLT` in EC3), shear (`0.6·Fy·Aw·Cv` / `Av·fy/√3`) and
flexure-axial interaction (H1.1 / conservative linear). LTB reduces the capacity when the beam is
not braced.

## Choosing the code

- **Per model:** `model.designSettings = { codeByFamily: { steel: 'EN1993-1-1' } }`.
- **Forced:** pass `codeId` to `verificarElemento` / `Portico.design({ codeId })`.
- **Default:** AISC 360 LRFD (steel), ACI 318 (concrete), NCh1198 (timber).

Per-element buckling/LTB parameters in `el.design = { Lb, K, Cb }` (unbraced length, effective
length factor, moment gradient factor). Default `Lb = L` (conservative: unbraced beam), `K = 1`,
`Cb = 1`.

## Adding a new code (extension)

```js
import { Portico } from './js/api/portico.js';
Portico.registerDesignCode({
  id: 'MY-CODE:2025', family: 'steel', label: 'My code',
  check({ demands, mat, sec, member, options }) {
    // demands: {N (+tension/−compression), Vy, Vz, My, Mz} in kN, kN·m
    // mat: {family, E, Fy, Fu, ...} in kN/m² ; sec: {A, Iz, Zz, rz, Cw, ...} in m
    // return { flexion, corte, axial, interaccion, ratioMax, gobierna, estado }
  },
});
```

The helper `finalize(r, options)` computes `ratioMax`, `gobierna` and `estado` from the four
checks.

## Declared limitations

- The EC3 interaction is **conservative linear** (it does not use the `kyy/kzz` of Annex A/B).
  For concrete, the P-M interaction is a simplified linear one (not an exact P-M diagram). LTB is
  applied to I profiles; closed/solid sections → `Mn = Mp`.
- Concrete is designed with a declared **reinforcement ratio** ρ (the model sections are
  generic); set `sec.design.rebar` to your real reinforcement.

Verifications: `test_design.mjs` (root) compares against manual calculations and the tabulated
IPE300; the case `tools/verif/cases/4-001` exercises it in the headless pipeline.
