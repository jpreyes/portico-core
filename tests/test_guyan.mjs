// test_guyan.mjs — condensación de Guyan de GDL sin masa en el modal (#5)
// Cadena axial de 3 GDL (resortes k a tierra-1, 1-2, 2-3) con masa m en los GDL 1 y 3
// y el GDL 2 SIN masa. La masa nula genera un modo espurio de frecuencia altísima.
// Guyan condensa el GDL 2 y deja exactamente las 2 frecuencias reales — que deben
// coincidir con los 2 autovalores bajos del sistema completo.
//
//   node test_guyan.mjs
globalThis.window = globalThis;
await import('../lib/numeric.js');
const num = globalThis.numeric;
const { guyanReduce } = await import('../js/solver/modal_solver.js?v=207');

let pass = 0; const ok = (c, m) => { if (!c) { console.log('FAIL ' + m); process.exitCode = 1; } else { console.log('  ✓ ' + m); pass++; } };

const k = 100, m = 2;
// K (3×3): resortes en serie con tierra en el extremo izquierdo
const K = [[2*k, -k, 0], [-k, 2*k, -k], [0, -k, k]];
const M = [[m, 0, 0], [0, 0, 0], [0, 0, m]];   // GDL 2 sin masa

console.log('#5: Guyan — condensación de GDL sin masa');
const red = guyanReduce(K, M, 3, m, num);
ok(red && red.nCondensed === 1 && red.nM === 2, `condensa 1 GDL sin masa → sistema reducido 2×2 (nM=${red?.nM})`);

// autovalores del reducido  Kr φ = ω² Mr φ
const eigR = num.eig(num.dot(num.inv(red.Mr), red.Kr)).lambda.x.slice().sort((a, b) => a - b);
// analítico: ω² = (k/m)·(1 ∓ √2/2)
const w1 = (k / m) * (1 - Math.SQRT1_2), w2 = (k / m) * (1 + Math.SQRT1_2);
ok(Math.abs(eigR[0] - w1) / w1 < 1e-9, `ω₁² reducido = ${eigR[0].toFixed(4)} (analítico ${w1.toFixed(4)})`);
ok(Math.abs(eigR[1] - w2) / w2 < 1e-9, `ω₂² reducido = ${eigR[1].toFixed(4)} (analítico ${w2.toFixed(4)})`);

// sistema COMPLETO con masa-piso en el GDL 2 (como hacía antes): los 2 bajos deben
// coincidir con Guyan, y el 3.º es ESPURIO (frecuencia ~1e8 × mayor).
const Mf = [[m, 0, 0], [0, m * 1e-8, 0], [0, 0, m]];
const eigF = num.eig(num.dot(num.inv(Mf), K)).lambda.x.slice().sort((a, b) => a - b);
ok(Math.abs(eigF[0] - w1) / w1 < 1e-4 && Math.abs(eigF[1] - w2) / w2 < 1e-4,
  `los 2 modos bajos del completo coinciden con Guyan (${eigF[0].toFixed(3)}, ${eigF[1].toFixed(3)})`);
ok(eigF[2] > 1e6 * eigF[1], `el 3.º modo del completo es ESPURIO (ω²=${eigF[2].toExponential(2)}, lo elimina Guyan)`);

// expand: el GDL esclavo se recupera por la relación estática (Kss·φs + Ksm·φm = 0)
const phiM = num.eig(num.dot(num.inv(red.Mr), red.Kr)).E.x;   // columnas = vectores
const vM = [phiM[0][0], phiM[1][0]];
const vF = red.expand(vM);
const resid = K[1][0] * vF[0] + K[1][1] * vF[1] + K[1][2] * vF[2];   // fila del GDL esclavo · φ
ok(Math.abs(resid) < 1e-9, `el GDL condensado cumple el equilibrio estático (resid=${resid.toExponential(2)})`);

// no condensa cuando todos los GDL tienen masa (modelo normal → camino intacto)
ok(guyanReduce(K, [[m,0,0],[0,m,0],[0,0,m]], 3, m, num) === null, 'con masa en todos los GDL no condensa (modelos normales intactos)');

console.log(`\n✅ #5 OK — ${pass} comprobaciones`);
