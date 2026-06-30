# Preset — Chile (normas NCh)

Tablas reales de la normativa chilena para el generador del asistente y la verificación
de diseño de **portico-core**. Reemplazan las tablas de **ejemplo** del core agnóstico.

## Cómo aplicarlo

Copia estos archivos sobre `assistant/` (mismos nombres):

```bash
cp presets/chile/rules.json            assistant/rules.json
cp presets/chile/design_params.json     assistant/design_params.json
cp presets/chile/live_loads.csv assistant/live_loads.csv
```

Recarga la app. Para volver a la base agnóstica: `git checkout assistant/`.

## Qué cubre

| Archivo | Normas |
|---|---|
| `rules.json` | **NCh431** (sobrecargas de nieve), **NCh432** (viento), **NCh433/DS61** (diseño sísmico: clases de suelo, zonas Ao, categorías, espectro y zonificación por comuna ~180 ciudades), masa sísmica y reglas de modelado. |
| `design_params.json` | Respaldo de resistencias y límites referidos a **AISC 360 / NCh427**, **ACI 318 / NCh430**, **NCh1198** (madera) y flechas/derivas (**NCh1537 / NCh433-DS61**). |
| `live_loads.csv` | Tabla de sobrecargas de uso de **NCh1537** (≈60 usos: edificio, descripción, Lo [kN/m²], Qk [kN]). |

## Avisos

- Estos datos son una **transcripción de normas públicas chilenas** hecha para uso con
  portico-core; **verifícalos** contra la norma oficial antes de un proyecto real.
- Los resultados son **orientativos** y requieren la revisión de un ingeniero
  calculista (ver el aviso del `README` principal).
- Las claves coinciden con las que leen `assistant/loads.js` y `assistant/generator.js`;
  no las renombres si vas a reemplazar los archivos del core.
