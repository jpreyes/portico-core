#!/usr/bin/env node
// ──────────────────────────────────────────────────────────────────────────────
// pipeline_cli.mjs — CLI helper (NOT a unit test): runs the FULL assistant pipeline
// end to end without n8n:
//   descripción (lenguaje natural) → OpenRouter (LLM) → ficha → generador → .s3d
// Needs a CLI argument and an OPENROUTER_API_KEY (calls a live LLM over the network),
// so it is NOT part of the test battery.
//
// Uso (PowerShell):
//   $env:OPENROUTER_API_KEY="sk-or-..."; node assistant/pipeline_cli.mjs "edificio de 2 niveles de 3 m, planta 10x8, colegio en Valdivia con sismo"
//   # opcional: $env:OPENROUTER_MODEL="google/gemini-2.0-flash-exp:free"
//   # guardar el .s3d:   node assistant/pipeline_cli.mjs "..." > salida.s3d
//
// Imprime la ficha y el resumen por stderr; el .s3d por stdout (para redirigir).
// ──────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateModel } from './generator.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(dir, p), 'utf8');
const log = (...a) => process.stderr.write(a.join(' ') + '\n');

function parseCSV(txt) {
  const lines = txt.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
  const head = lines[0].split(',').map((s) => s.trim());
  return lines.slice(1).map((l) => {
    const c = l.split(',').map((s) => s.trim());
    return Object.fromEntries(head.map((h, i) => [h, c[i]]));
  });
}

const SYSTEM = `Eres un asistente que convierte la descripcion de una estructura en una FICHA JSON para PORTICO. Responde SOLO con el JSON de la ficha, sin texto ni markdown. Campos: proyecto, modo (2D|3D), ubicacion{ciudad,latitud_sur_deg,altitud_msnm,exposicion(B|C|D)}, geometria{levels:[{altura_m,uso_NCh1537?,sobrecarga_uso_kN_m2?}],vanos_x?,vanos_y?,planta_inferior?{Lx_m,Ly_m},planta_superior?,pendiente_techo_deg?}, secciones{material,vigas,pilares}, apoyo_base(empotrado|rotulado), diafragma_rigido, cargas{muerta_adicional_kN_m2,uso_NCh1537,cierre_viento,nieve,viento,sismo}, sismo{zona(1|2|3),suelo(A..E),categoria(I..IV),R}. vanos_x/spans_y: lista de luces [3,3,3,4] o uniforme {cantidad,luz_m} (ej. "4 vanos de 3 m en X" -> spans_x:{count:4,span_m:3}). Cada nivel puede tener distinta altura y distinto uso (ej. nivel 1 Salas de Clases, nivel 3 Bodegas livianas) -> niveles[k].use_class. Omite lo no mencionado; no inventes valores de ingenieria. secciones.beams/columns: perfil de acero por nombre ('IPE300','HEB200') O seccion rectangular de hormigon {b_cm,h_cm} (ej. viga de HA 20x40cm -> {b_cm:20,h_cm:40}; pilar 30x30 -> {b_cm:30,h_cm:30}). material: acero (S235/S275/S355/A630-420H) u hormigon H20/H25/H30/H40 (fc en MPa -> H{fc}, ej. fc=30 MPa -> "H30"). Si las secciones son de hormigon, el material debe ser un Hxx.`;

async function llmFicha(mensaje) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('Falta OPENROUTER_API_KEY en el entorno.');
  const model = process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free';
  log(`LLM: ${model} (OpenRouter)…`);
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'PORTICO Asistente' },
    body: JSON.stringify({
      model, temperature: 0, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: mensaje }],
    }),
  });
  if (!r.ok) throw new Error(`OpenRouter HTTP ${r.status}: ${await r.text()}`);
  const data = await r.json();
  let raw = String(data.choices?.[0]?.message?.content ?? '').trim()
    .replace(/^```(json)?/i, '').replace(/```$/, '').trim();
  const i = raw.indexOf('{'), j = raw.lastIndexOf('}');
  if (i < 0 || j < 0) throw new Error('El LLM no devolvio JSON: ' + raw.slice(0, 200));
  return JSON.parse(raw.slice(i, j + 1));
}

try {
  const mensaje = process.argv.slice(2).join(' ').trim();
  if (!mensaje) throw new Error('Pase una descripción como argumento.');

  const ficha = await llmFicha(mensaje);
  log('\nFICHA:\n' + JSON.stringify(ficha, null, 2) + '\n');

  const libs = {
    reglas: JSON.parse(read('rules.json')),
    perfiles: parseCSV(read('profiles.csv')),
    materiales: parseCSV(read('materials.csv')),
    sobrecargas: parseCSV(read('live_loads.csv')),
  };
  const modelo = generateModel(ficha, libs);
  log('MODELO: ' + (modelo._generado?.resumen || ''));
  process.stdout.write(JSON.stringify(modelo, null, 2));
} catch (e) {
  log('ERROR: ' + e.message);
  process.exit(1);
}
