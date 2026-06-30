// test_seismic.mjs — columna fuerte-viga débil (#68)
//   node test_seismic.mjs
import { strongColumnWeakBeam, classifyMember, jointSCWB } from './js/design/seismic.js';

let fails = 0;
const ok = (name, got, exp, tol) => { const e = Math.abs(got - exp) / (Math.abs(exp) || 1); const p = e <= tol; if (!p) fails++; console.log(`${p ? '✓' : '✗'} ${name}: got=${got} exp=${exp}`); };
const assert = (name, c, info = '') => { if (!c) fails++; console.log(`${c ? '✓' : '✗'} ${name}${info ? ' · ' + info : ''}`); };

// (1) Chequeo puntual: ΣMnc=300, ΣMnb=200, γ=1.2 → demanda 240 ≤ 300 → cumple, ratio 0.8.
{
  const r = strongColumnWeakBeam({ sumMnc: 300, sumMnb: 200, gamma: 1.2 });
  ok('1a. ratio = γ·ΣMnb/ΣMnc', r.ratio, 1.2 * 200 / 300, 1e-6);
  assert('1b. cumple (ratio<1)', r.ok);
}
// (2) Viga fuerte → NO cumple. ΣMnc=200, ΣMnb=200 → 240>200.
{
  const r = strongColumnWeakBeam({ sumMnc: 200, sumMnb: 200 });
  assert('2. columna débil → no cumple', !r.ok && r.ratio > 1, `ratio=${r.ratio}`);
}
// (3) Clasificación por verticalidad.
{
  assert('3a. vertical → column', classifyMember({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 3 }) === 'column');
  assert('3b. horizontal → beam', classifyMember({ x: 0, y: 0, z: 3 }, { x: 5, y: 0, z: 3 }) === 'beam');
  assert('3c. diagonal → brace', classifyMember({ x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 3 }) === 'brace');
}
// (4) Nudo cruz: 2 columnas (arriba/abajo) + 2 vigas (izq/der). MnOf por tipo.
{
  // modelo mínimo simulado
  const nodes = new Map([[1, { id: 1, x: 0, y: 0, z: 3 }], [2, { id: 2, x: 0, y: 0, z: 0 }], [3, { id: 3, x: 0, y: 0, z: 6 }], [4, { id: 4, x: -5, y: 0, z: 3 }], [5, { id: 5, x: 5, y: 0, z: 3 }]]);
  const elements = new Map([
    [10, { id: 10, n1: 2, n2: 1 }], [11, { id: 11, n1: 1, n2: 3 }],   // columnas
    [12, { id: 12, n1: 4, n2: 1 }], [13, { id: 13, n1: 1, n2: 5 }],   // vigas
  ]);
  const model = { nodes, elements };
  const Mn = { 10: 180, 11: 180, 12: 120, 13: 120 };                   // columnas 180, vigas 120
  const res = jointSCWB(model, (id) => Mn[id], { gamma: 1.2 });
  const joint = res.find(r => r.node === 1);
  assert('4a. detecta el nudo con 2 col + 2 vigas', joint && joint.nCol === 2 && joint.nBeam === 2, JSON.stringify(joint));
  ok('4b. ΣMnc=360', joint.sumMnc, 360, 1e-9);
  ok('4c. ΣMnb=240', joint.sumMnb, 240, 1e-9);
  ok('4d. ratio = 1.2·240/360', joint.ratio, 1.2 * 240 / 360, 1e-3);
  assert('4e. cumple', joint.ok);
  // nudos extremos (sólo 1 barra) no aparecen
  assert('4f. sólo nudos con col+viga', res.length === 1, `n=${res.length}`);
}

console.log(fails === 0 ? '\nTODO OK ✓' : `\n${fails} FALLO(S) ✗`);
process.exit(fails ? 1 : 0);
