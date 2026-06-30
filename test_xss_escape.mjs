// test_xss_escape.mjs — verifica que los nombres de entidades del modelo que
// provienen de un archivo (.s3d / CSV / IFC) se neutralizan antes de insertarse
// como HTML, evitando XSS almacenado (ver SECURITY.md).
//
// No hay DOM en Node: validamos (a) el helper de escape compartido y (b) que el
// patrón de interpolación real (un <option> con el nombre) no contiene HTML
// ejecutable cuando el nombre es malicioso.
//
// Correr: node test_xss_escape.mjs

import { esc, escapeHtml } from './js/utils/escape.js';

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error('  ✗', msg); fails++; } else console.log('  ✓', msg); };

const PAYLOAD = '<img src=x onerror=alert(1)>';

console.log('1) El helper neutraliza los metacaracteres HTML');
{
  const out = esc(PAYLOAD);
  ok(!out.includes('<'), 'no quedan «<» sin escapar');
  ok(!out.includes('>'), 'no quedan «>» sin escapar');
  ok(out.includes('&lt;img') && out.includes('&gt;'), 'se convierte en entidades');
  ok(esc === escapeHtml, 'esc es alias de escapeHtml');
}

console.log('2) Escapa comillas (uso dentro de atributos title="..."/value="...")');
{
  const out = esc('a"b');
  ok(out.includes('&quot;') && !out.includes('"'), 'la comilla doble se escapa');
  // Un payload que intenta cerrar el atributo y abrir un manejador de eventos
  const attr = `<input value="${esc('" onmouseover="alert(1)')}">`;
  ok((attr.match(/"/g) || []).length === 2, 'no se pueden inyectar comillas extra que rompan el atributo');
}

console.log('3) Valores nulos/indefinidos no rompen');
{
  ok(esc(null) === '' && esc(undefined) === '', 'null/undefined → cadena vacía');
  ok(esc(42) === '42', 'los números se serializan');
}

console.log('4) Los nombres normales NO cambian (sin alterar el comportamiento visible)');
{
  for (const name of ['Hormigón H30', 'IPE 300', 'Caso 1 (D+L)', 'Diafragma N+3.50']) {
    ok(esc(name) === name, `«${name}» se mantiene idéntico`);
  }
}

console.log('5) Patrón real del sink: <option> generado con un nombre malicioso');
{
  // Simula js/ui/properties.js: `<option value="${m.id}">${esc(m.name)}</option>`
  const m = { id: 7, name: PAYLOAD };
  const optionHTML = `<option value="${m.id}">${esc(m.name)}</option>`;
  // El único «<» legítimo es el de la etiqueta <option>; no debe aparecer el <img>.
  ok(!optionHTML.includes('<img'), 'el <option> no contiene la etiqueta <img> inyectada');
  ok(optionHTML.includes('&lt;img src=x onerror=alert(1)&gt;'), 'el nombre aparece como texto escapado');
}

console.log(fails === 0 ? '\n✅ XSS escape OK' : `\n❌ ${fails} fallo(s)`);
process.exit(fails === 0 ? 0 : 1);
