# Asistente de PORTICO — diseño

Convierte una instrucción en lenguaje natural (ej.: *"edificio de 3 niveles de
3 m, planta 10×10 que pasa a 10×8, vigas IPE300, pilares HEB200, diafragmas
rígidos, sismo + sobrecarga de colegio + viento en Valdivia"*) en un modelo
`.s3d` listo para abrir en PORTICO.

## Arquitectura: el LLM traduce, el código construye

1. **LLM → ficha estructurada (JSON pequeño).** Solo rellena campos acotados
   (niveles, alturas, plantas, perfiles, diafragmas, lista de cargas, ciudad).
   No genera geometría ni inventa valores de ingeniería.
2. **Generador determinista.** Ficha + reglas + bibliotecas → `.s3d`. Es la
   fuente de verdad de la ingeniería (auditable, repetible).
3. **Funciones reutilizables en la app.** Cada paso (importar biblioteca,
   aplicar carga de área, generar combinaciones) es además un **botón** propio;
   el asistente solo los invoca.

## Bibliotecas (CSV, ampliables)

- **`profiles.csv`** — 90 perfiles I (IPE, HEA, HEB, HEM) según EN 10365, con
  todas las propiedades (h, b, tw, tf, r, masa, A, Av_y, Av_z, Iy, Wel/Wpl,
  i, Iz, It, Iw). Verificado contra IPE300/HEB200. Se amplía agregando filas.
  *Pendiente:* tubos CHS/RHS/SHS y perfiles IPN/UPN/L.
- **`materials.csv`** — aceros (S235/S275/S355, A270ES, A630-420H) y hormigones
  (H20–H40). E, G, ν, ρ, fy/fc.
- Convención: `Iy` = eje fuerte (mayor), `Iz` = eje débil (menor). El generador
  mapea al sistema local de PORTICO y convierte cm²/cm⁴ → m²/m⁴.

## Sistema de cargas

- **Cargas de área (kN/m²)** — sobrecarga de uso (NCh1537), nieve (NCh431),
  peso de losa. El generador las reparte a las vigas por **ancho tributario**:
  `w = q × ancho_tributario`. También definen la **masa sísmica** (CM + % CV)
  en los diafragmas → alimenta el caso espectral.
- **Viento (NCh432)** y **sísmica (NCh433)** — dependen de la ubicación. Se
  codifican **desde las normas oficiales** (fuente de verdad), no se inventan.
  Sísmica → casos espectrales (dir X e Y), que PORTICO ya soporta.
- **Nieve (NCh431)** — se arma con la norma y se valida.

## Combinaciones (botón + asistente)

- Botón **"Generar combinaciones"**: materializa plantillas NCh3171
  (gravitacional / sísmica / con eventuales) como combos reales sobre los casos
  existentes (CM, CV, SismoX/Y, Viento, Nieve).
- El asistente lo invoca: pedir *"agrega las cargas eventuales"* crea los casos
  faltantes (viento, nieve, sismo) **y** sus combinaciones.

## LLM recomendado (PC sin GPU/poca RAM, sin exponer credenciales)

- Sin modelos locales. **LLM gratis en la nube** (Gemini Flash o Groq) con la
  **credencial del lado del servidor** (n8n cifrado o un Cloudflare Worker como
  proxy). La llave nunca toca el navegador.

## Archivos

- **`rules.json`** (v0.5) — normas codificadas: sobrecargas NCh1537, sismo
  NCh433/DS61, combinaciones NCh3171, viento NCh432, nieve NCh431.
- **`spec.schema.json`** — JSON Schema (draft-07) de la ficha que rellena el LLM.
- **`generator.js`** — generador determinista (ES module puro, Node + navegador):
  `generarModelo(ficha, { reglas, perfiles, materiales, sobrecargas }) → .s3d`.
- **`loads.js`** — magnitudes normativas (puras): `cargaNieveNCh431`,
  `cargaVientoNCh432`, `espectroNCh433` (+ `Rstar`).
- **`example_spec.json`** / **`example_output.s3d`** — ejemplo (colegio 3 niveles,
  planta variable 10×10→10×8, Valdivia).
- **`test_generator.mjs`** — test Node: conteos, mapeo de secciones y EQUILIBRIO
  con el solver estático real (`node assistant/test_generator.mjs`).

### Qué hace el generador hoy

- Grilla (ejes explícitos o subdivisión por `separacion_maxima_vano_m`).
- Multinivel con planta interpolada linealmente (taperizado).
- Nodos, apoyos (empotrado/rotulado), pilares y vigas (X e Y); diafragmas rígidos.
- Mapeo perfil EN → sección PORTICO con conversión cm→m e **intercambio de ejes**
  (`Iz←Iy_EN` fuerte, `Avy←Avz_EN` alma) verificado contra `timoshenko.js`.
- Cargas de área (CM + sobrecarga NCh1537) → líneas en vigas por **ancho
  tributario** (escalado con la planta variable); conserva la resultante.
- **Nieve (NCh431)** → `ps` real sobre el techo (pg por lat/altitud + Ce·Ct·I·Cs).
- **Viento (NCh432)** → `q` y presiones por zona; presión neta de muro
  (zona 1 − zona 4) como carga horizontal `globalX` en pilares de barlovento.
  El desglose completo queda en `loadCase._viento`.
- **Sismo (NCh433)** → curva elástica `Sa(T)` en `loadCase._espectro_NCh433`
  (pegar en F7; `saFactor = g/R*`, con `R*` tras el modal vía `Rstar(T*,To,Ro)`).
- Masa sísmica en diafragmas (CM + fracción CV); casos espectrales Sismo X/Y.
- Combinaciones NCh3171 (LRFD) sobre los casos generados.

## En la app (PORTICO)

- **Menú Asistente → "Generar modelo desde ficha…"**: pega una ficha JSON (hay
  plantilla) y el generador construye el modelo en el navegador (carga
  `generator.js` + bibliotecas y reemplaza el modelo). Incluye un panel opcional
  de **lenguaje natural** que llama al webhook de n8n (URL guardada en
  localStorage) para traer la ficha; la credencial vive en el servidor.
- **Espectro (F7)**: constructor NCh433 con gráfico (ver app).

## Flujo n8n (chat → LLM → ficha → modelo)

LLM vía **OpenRouter** (API compatible con OpenAI; una key, muchos modelos, varios
gratis). Archivos: `n8n_flow.json` (workflow importable), `prompt_llm.md` (prompt
de extracción), `generate_cli.mjs` (CLI: ficha por stdin → `.s3d` por stdout),
`pipeline_cli.mjs` (CLI: prueba TODO sin n8n).

Cadena: **Webhook** (`POST /webhook/portico`, body `{mensaje}`) → **LLM**
(OpenRouter, `$env.OPENROUTER_API_KEY`, modelo `meta-llama/llama-3.3-70b-instruct:free`)
→ **Extraer ficha** (Code) → **Generar modelo** (Code que ejecuta `generate_cli.mjs`)
→ **Responder** (`{ficha, resumen, modelo}`).

### Probar primero SIN n8n (recomendado)
```
$env:OPENROUTER_API_KEY="sk-or-..."
node assistant/pipeline_cli.mjs "edificio de 2 niveles de 3 m, planta 10x8, colegio en Valdivia con sismo" > salida.s3d
```
Imprime la ficha y el resumen (stderr) y el `.s3d` (stdout). Así validas
LLM→ficha→modelo antes de tocar n8n. (Solo el CLI: `node assistant/generate_cli.mjs assistant/example_spec.json`.)

### n8n local (npx n8n)
1. `npx n8n` (abre http://localhost:5678).
2. Importar `n8n_flow.json` (Workflows → ⋯ → Import from File).
3. Variables de entorno antes de lanzar n8n:
   - `OPENROUTER_API_KEY` = tu key de openrouter.ai
   - `PORTICO_DIR` = ruta absoluta del repo (el flujo trae el default de este repo)
   - `NODE_FUNCTION_ALLOW_BUILTIN=child_process,path` (para que el Code node ejecute el CLI)
4. Activar el workflow → copiar la URL del webhook → pegarla en PORTICO
   (menú Asistente → campo "Endpoint n8n").

> Si más adelante n8n corre en la nube (no puede ver el CLI local), se despliega
> el generador como **Cloudflare Worker** y el Code node se reemplaza por una
> llamada HTTP a ese Worker.

## Pendiente

1. Aplicar carga de área e importar biblioteca CSV como botones sueltos (hoy van
   dentro del generador completo).
2. Viento: hoy aplica la presión neta de muro como lateral en X; falta el caso
   en Y, las presiones de techo (zonas 2/3) y franjas de borde (zonas E).
   Sismo: persistir/auto-cargar la curva en el `.s3d`.
3. Completar bibliotecas: tubos CHS/RHS/SHS, IPN/UPN/L.
