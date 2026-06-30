# Diseño de elementos — motor multinorma generalizado

[English](design.md) · **Español**

Portico verifica elementos (flexión, corte, axial e interacción) contra códigos de
diseño reales —**AISC 360-16 (LRFD/ASD)** y **Eurocódigo 3 (EN 1993-1-1)** para
acero, **ACI 318-19 / EC2** para hormigón y **NCh1198** para madera— igual que la
verificación de SAP2000 para los modos cubiertos. Todo corre en el navegador (y en
Node a través de la [API pública](api.md)).

## Idea central: el diseño es **generalizado**

Antes los parámetros de diseño vivían en un JSON global *por tipología* (un único
`Fy` para todo el acero, un único `f'c` para todo el hormigón) y el tipo de
material se adivinaba por su **nombre**. Eso impedía diseñar un material con
propiedades distintas. Ahora:

1. **Las resistencias son del MATERIAL** (`mat.design`).
2. **La geometría de diseño es de la SECCIÓN** (`sec.design`).
3. **Los códigos son módulos conectables** en un registro, extensibles por la API.

Así, **cualquier material y cualquier sección** se pueden diseñar, y se puede
elegir el código por familia.

## Datos de diseño del material — `mat.design`

```js
mat.design = {
  family: 'steel' | 'concrete' | 'timber' | 'aluminum',
  // acero / aluminio (MPa):
  Fy: 355, Fu: 470,
  // hormigón (MPa):
  fc: 30, fyRebar: 420,
  // madera (MPa) + factores de modificación:
  Fb: 11, Fv: 1.5, Fc: 9, Ft: 8, Fcp: 2.5,
  factores_modificacion: { KD_duracion_carga: 0.9, KH_contenido_humedad: 1, Kt_temperatura: 1, otros: 1 },
}
```

Las resistencias se dan en **MPa**; el módulo elástico `E` se toma del material
(en kN/m², como en el solver). Si `mat.design` no existe, se clasifica el material
por su nombre y las resistencias caen al JSON legado `assistant/design_params.json`
(compatibilidad). `material_props.js` resuelve todo a kN/m².

## Datos de diseño de la sección — `sec.design`

La sección del modelo aporta `A, Iy, Iz, J` para el **análisis**. Para el **diseño**
se necesita además la **forma**, de la que `section_props.js` deriva los módulos
elásticos `S`, los **módulos plásticos `Z`**, los radios `r`, la constante de
alabeo `Cw`, las áreas de corte `Av` y las esbelteces de pared (`b/t`, `h/tw`):

```js
sec.design = { shape: 'I',     d: 0.30, bf: 0.15, tf: 0.0107, tw: 0.0071 }   // doble T
sec.design = { shape: 'rect',  b: 0.30, h: 0.50 }                            // rectángulo macizo
sec.design = { shape: 'circle', D: 0.40 }                                    // círculo macizo
sec.design = { shape: 'pipe',  D: 0.40, t: 0.012 }                           // tubo circular
sec.design = { shape: 'box',   b: 0.20, h: 0.30, t: 0.010 }                  // tubo rectangular
// hormigón armado:
sec.design = { shape: 'rect', b: 0.3, h: 0.5, rebar: { rho: 0.012, cover_mm: 40 } }
```

Si no hay `shape` (o es `'generic'`), se usa un **rectángulo equivalente** a partir
de `A, I` (comportamiento histórico), con `Z = shapeFactor·S`. Para `A, Iy, Iz, J`
se prefieren siempre los valores del modelo (lo que ve el solver) por consistencia.
Cualquier propiedad puede sobreescribirse explícitamente (p.ej. dar `Zz` y `Cw`
tabulados de un perfil real).

Verificado contra el **IPE300** tabulado (A, Iz, Wel, Wpl, r) con error ≤6% (la
diferencia es el redondeo de las uniones alma-ala que no se modela).

## Códigos implementados

| Código | id | Familia | Modos |
|---|---|---|---|
| AISC 360-16 (LRFD) | `AISC360-16:LRFD` | acero | D2, E3, F2 (+LTB), F6, G2, H1.1 |
| AISC 360-16 (ASD)  | `AISC360-16:ASD`  | acero | igual, con Ω |
| Eurocódigo 3       | `EN1993-1-1`      | acero | 6.2.3, 6.3.1 (χ), 5.5, 6.3.2 (χLT), 6.2.6, 6.3.3 |
| ACI 318-19         | `ACI318-19`       | hormigón | flexión, corte, axial, P-M |
| Eurocódigo 2       | `EN1992-1-1`      | hormigón | ídem (bloque rectangular) |
| NCh1198            | `NCh1198`         | madera | tens. admisibles + estabilidad |

**Acero — qué se chequea de verdad:** tracción (fluencia del área bruta),
compresión por pandeo por flexión (`Fcr` AISC E3 / curvas χ EC3), flexión con
**pandeo lateral-torsional** (`Lp/Lr/Cb` en AISC F2; `Mcr` y `χLT` en EC3),
corte (`0.6·Fy·Aw·Cv` / `Av·fy/√3`) e interacción flexo-axial (H1.1 / lineal
conservadora). El LTB reduce la capacidad cuando la viga no está arriostrada.

## Elegir el código

- **Por modelo:** `model.designSettings = { codeByFamily: { steel: 'EN1993-1-1' } }`.
- **Forzado:** pasar `codeId` a `verificarElemento` / `Portico.design({ codeId })`.
- **Por defecto:** AISC 360 LRFD (acero), ACI 318 (hormigón), NCh1198 (madera).

Parámetros de pandeo/LTB por elemento en `el.design = { Lb, K, Cb }` (longitud no
arriostrada, factor de longitud efectiva, factor de gradiente de momento). Por
defecto `Lb = L` (conservador: viga sin arriostrar), `K = 1`, `Cb = 1`.

## Añadir un código nuevo (extensión)

```js
import { Portico } from './js/api/portico.js';
Portico.registerDesignCode({
  id: 'MI-NORMA:2025', family: 'steel', label: 'Mi norma',
  check({ demands, mat, sec, member, options }) {
    // demands: {N (+tracción/−compresión), Vy, Vz, My, Mz} en kN, kN·m
    // mat: {family, E, Fy, Fu, ...} en kN/m² ; sec: {A, Iz, Zz, rz, Cw, ...} en m
    // devolver { flexion, corte, axial, interaccion, ratioMax, gobierna, estado }
  },
});
```

El helper `finalize(r, options)` calcula `ratioMax`, `gobierna` y `estado` a partir
de los cuatro chequeos.

## Limitaciones declaradas

- La interacción de EC3 es **lineal conservadora** (no usa `kyy/kzz` del Anexo
  A/B). Para hormigón la interacción P-M es lineal simplificada (no diagrama P-M
  exacto). El LTB se aplica a perfiles I; secciones cerradas/macizas → `Mn = Mp`.
- El hormigón se diseña con una **cuantía** ρ declarada (las secciones del modelo
  son genéricas); ajuste `sec.design.rebar` a su armado real.

Verificaciones: `test_design.mjs` (raíz) compara contra cálculos de manual e IPE300
tabulado; el caso `tools/verif/cases/4-001` lo ejerce en el pipeline headless.
