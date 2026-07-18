// test_formfind.mjs — verifica el FIX #29 del form-finding: acotar la red a los
// elementos OBJETIVO sin destruir apoyos ni la geometría no participante.
//
// Marco: 2 pilares + 1 viga (subdividida). Se "forma" SÓLO la viga (selección).
// Esperado: los pilares y sus nodos (incluidos los extremos de viga = tope de
// pilar) quedan INTACTOS; sólo los nodos interiores de la viga bajan formando la
// funicular de la carga. Antes (#29) el form-finding borraba los pilares (techo→z=0).
//
// Ejecutar:  node test_formfind.mjs
import { formFind } from '../js/solver/formfind.js?v=107';

// Nodos: 0 base-izq (apoyo), 1 base-der (apoyo), 2 tope-izq, 6 tope-der,
//        3,4,5 = interiores de la viga (z=3, x=1,2,3).
const H = 3, B = 4;
const NODES = [
  { id: 0, x: 0, y: 0, z: 0, fix: true },   // apoyo
  { id: 1, x: B, y: 0, z: 0, fix: true },   // apoyo
  { id: 2, x: 0, y: 0, z: H },              // tope pilar izq = extremo viga
  { id: 3, x: 1, y: 0, z: H },
  { id: 4, x: 2, y: 0, z: H },
  { id: 5, x: 3, y: 0, z: H },
  { id: 6, x: B, y: 0, z: H },              // tope pilar der = extremo viga
];
// Elementos: columnas (0-2, 1-6) y viga (2-3,3-4,4-5,5-6)
const COLS = [[0, 2], [1, 6]];
const BEAM = [[2, 3], [3, 4], [4, 5], [5, 6]];

// ── Replica de la lógica de acotamiento de app.runFormFinding ────────────────
function scopedFormFind(selectBeamOnly, axes) {
  const partSet = selectBeamOnly ? BEAM.slice() : [...COLS, ...BEAM];
  const boundary = new Set();
  if (selectBeamOnly) for (const [a, b] of COLS) { boundary.add(a); boundary.add(b); }

  const coords = new Float64Array(3 * NODES.length);
  const fixed = NODES.map((nd, i) => {
    coords[3 * i] = nd.x; coords[3 * i + 1] = nd.y; coords[3 * i + 2] = nd.z;
    return !!nd.fix || boundary.has(nd.id);
  });
  const branches = partSet.map(([a, b]) => [a, b]);
  const q = branches.map(() => 10);

  // Carga: hacia abajo en los nodos interiores de la viga (3,4,5).
  const loads = NODES.map(() => [0, 0, 0]);
  for (const id of [3, 4, 5]) loads[id][2] = -5;   // −Z

  return formFind({ coords, fixed, branches, q, loads, axes });
}

let allOk = true;
const z = (res, id) => res.coords[3 * id + 2];
const x = (res, id) => res.coords[3 * id];

// ── Caso A: SÓLO la viga seleccionada, sólo eje Z (el fix recomendado) ────────
{
  const res = scopedFormFind(true, [2]);
  const colsIntact = Math.abs(z(res, 2) - H) < 1e-9 && Math.abs(z(res, 6) - H) < 1e-9
    && Math.abs(z(res, 0)) < 1e-9 && Math.abs(z(res, 1)) < 1e-9;
  const interiorSagged = z(res, 3) < H && z(res, 4) < H && z(res, 5) < H;
  const symmetric = Math.abs(z(res, 3) - z(res, 5)) < 1e-9 && z(res, 4) <= z(res, 3) + 1e-12;
  const xKept = Math.abs(x(res, 3) - 1) < 1e-9 && Math.abs(x(res, 4) - 2) < 1e-9 && Math.abs(x(res, 5) - 3) < 1e-9;
  const ok = res.ok && colsIntact && interiorSagged && symmetric && xKept;
  allOk = allOk && ok;
  console.log(`A) sólo viga, eje Z: ${ok ? '✓' : '✗'}`);
  console.log(`   pilares intactos (tope z=${z(res, 2).toFixed(2)},${z(res, 6).toFixed(2)} base z=${z(res, 0).toFixed(2)},${z(res, 1).toFixed(2)}) ${colsIntact ? '✓' : '✗'}`);
  console.log(`   viga funicular z=[${[3, 4, 5].map(i => z(res, i).toFixed(3)).join(', ')}] (sag, simétrica) ${interiorSagged && symmetric ? '✓' : '✗'}`);
  console.log(`   luces en planta intactas (x=[${[3, 4, 5].map(i => x(res, i).toFixed(2)).join(', ')}]) ${xKept ? '✓' : '✗'}`);
}

// ── Caso B: SÓLE la viga, 3D — verifica que los pilares siguen intactos ──────
{
  const res = scopedFormFind(true, [0, 1, 2]);
  const colsIntact = Math.abs(z(res, 2) - H) < 1e-9 && Math.abs(z(res, 6) - H) < 1e-9;
  allOk = allOk && res.ok && colsIntact;
  console.log(`B) sólo viga, 3D: pilares intactos ${colsIntact ? '✓' : '✗'}`);
}

// ── Caso C (anti-regresión del bug): TODO el modelo en 3D colapsa el techo a z≈0
//    — demuestra POR QUÉ hay que acotar. No es un "pase", es la causa de #29. ──
{
  const res = scopedFormFind(false, [0, 1, 2]);
  const collapsed = z(res, 2) < 0.5 * H && z(res, 6) < 0.5 * H;   // techo cae
  console.log(`C) todo el modelo, 3D (causa de #29): techo z=${z(res, 2).toFixed(2)},${z(res, 6).toFixed(2)} → ${collapsed ? 'COLAPSA (esperado sin acotar)' : 'no colapsa'}`);
}

console.log('\n' + (allOk ? '✅ PASA — el fix acota el form-finding sin destruir la estructura.' : '❌ FALLA'));
process.exit(allOk ? 0 : 1);
