#!/usr/bin/env node
// ──────────────────────────────────────────────────────────────────────────────
// generate_cli.mjs — wrapper de línea de comandos para el generador determinista.
// Lee una FICHA (JSON) por stdin y emite el modelo .s3d (JSON) por stdout.
// Pensado para el nodo "Execute Command" de n8n:  node assistant/generate_cli.mjs
// Errores → stderr + exit 1 (n8n los captura).
//
// Uso:
//   echo '{"modo":"3D",...}' | node assistant/generate_cli.mjs
//   node assistant/generate_cli.mjs ruta/ficha.json
// ──────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateModel } from './generator.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(dir, p), 'utf8');

function parseCSV(txt) {
  const lines = txt.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
  const head = lines[0].split(',').map((s) => s.trim());
  return lines.slice(1).map((l) => {
    const c = l.split(',').map((s) => s.trim());
    return Object.fromEntries(head.map((h, i) => [h, c[i]]));
  });
}

async function leerEntrada() {
  const arg = process.argv[2];
  if (arg) return fs.readFileSync(arg, 'utf8');
  // stdin
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

try {
  const fichaText = (await leerEntrada()).trim();
  if (!fichaText) throw new Error('Ficha vacía: pásela por stdin o como argumento.');
  const ficha = JSON.parse(fichaText);

  const libs = {
    reglas: JSON.parse(read('rules.json')),
    perfiles: parseCSV(read('profiles.csv')),
    materiales: parseCSV(read('materials.csv')),
    sobrecargas: parseCSV(read('live_loads.csv')),
  };

  const modelo = generateModel(ficha, libs);
  process.stdout.write(JSON.stringify(modelo, null, 2));
} catch (e) {
  process.stderr.write(`generate_cli: ${e.message}\n`);
  process.exit(1);
}
