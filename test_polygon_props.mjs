// test_polygon_props.mjs — propiedades de sección poligonal (#70)
//   node test_polygon_props.mjs
import { polygonProps, compositeProps } from './js/design/polygon_props.js';

let fails = 0;
const ok = (name, got, exp, tol) => { const e = Math.abs(got - exp) / (Math.abs(exp) || 1); const p = e <= tol; if (!p) fails++; console.log(`${p ? '✓' : '✗'} ${name}: got=${got.toExponential(5)} exp=${exp.toExponential(5)} err=${(e * 100).toFixed(3)}%`); };
const okv = (name, got, exp, abs) => { const p = Math.abs(got - exp) <= abs; if (!p) fails++; console.log(`${p ? '✓' : '✗'} ${name}: got=${got.toFixed(5)} exp=${exp.toFixed(5)}`); };
const assert = (name, c, info = '') => { if (!c) fails++; console.log(`${c ? '✓' : '✗'} ${name}${info ? ' · ' + info : ''}`); };

// (1) Rectángulo b×h = 0.3×0.5 → A, Iz=bh³/12, Iy=hb³/12, Zz=bh²/4, Zy=hb²/4, Iyz=0.
{
  const b = 0.3, h = 0.5;
  const P = polygonProps({ outline: [[0, 0], [b, 0], [b, h], [0, h]] });
  ok('1a. A = b·h', P.A, b * h, 1e-9);
  okv('1b. centroide cx', P.cx, b / 2, 1e-9); okv('1c. centroide cy', P.cy, h / 2, 1e-9);
  ok('1d. Iz = b·h³/12', P.Iz, b * h ** 3 / 12, 1e-9);
  ok('1e. Iy = h·b³/12', P.Iy, h * b ** 3 / 12, 1e-9);
  okv('1f. Iyz = 0 (bisimétrico)', P.Iyz, 0, 1e-12);
  ok('1g. Zz = b·h²/4', P.Zz, b * h ** 2 / 4, 1e-6);
  ok('1h. Zy = h·b²/4', P.Zy, h * b ** 2 / 4, 1e-6);
}
// (2) Rectángulo 0.4×0.4 con hueco central 0.2×0.2 (tipo cajón).
{
  const o = [[0, 0], [.4, 0], [.4, .4], [0, .4]];
  const hole = [[.1, .1], [.3, .1], [.3, .3], [.1, .3]];
  const P = polygonProps({ outline: o, holes: [hole] });
  ok('2a. A = 0.16 − 0.04', P.A, 0.16 - 0.04, 1e-9);
  ok('2b. Iz = (0.4⁴ − 0.2⁴)/12', P.Iz, (0.4 ** 4 - 0.2 ** 4) / 12, 1e-9);
  okv('2c. centroide centrado', P.cy, 0.2, 1e-9);
}
// (3) Sección en L (100×100, espesor 20, en mm→m): centroide desplazado, Iyz≠0.
{
  const t = 0.02, a = 0.10;
  // L: pierna vertical [0,a]×[0,t]... mejor por vértices del contorno en L.
  const P = polygonProps({ outline: [[0, 0], [a, 0], [a, t], [t, t], [t, a], [0, a]] });
  const Aexp = a * t + (a - t) * t;
  ok('3a. A de la L', P.A, Aexp, 1e-9);
  okv('3b. cx>0, cy>0 desplazados', (P.cx > 0 && P.cy > 0) ? 1 : 0, 1, 0);
  okv('3c. Iyz ≠ 0 (asimétrica)', Math.abs(P.Iyz) > 1e-8 ? 1 : 0, 1, 0);
  // simetría diagonal de la L de piernas iguales → cx=cy, Iz=Iy
  okv('3d. L simétrica: cx=cy', P.cx, P.cy, 1e-9);
  ok('3e. L simétrica: Iz=Iy', P.Iz, P.Iy, 1e-9);
}
// (4) Invariancia: I1+I2 = Iz+Iy (traza), y rectángulo girado 30° tiene Iyz≠0 con
//     mismos principales que sin girar.
{
  const b = 0.2, h = 0.6, c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6);
  const base = [[-b / 2, -h / 2], [b / 2, -h / 2], [b / 2, h / 2], [-b / 2, h / 2]];
  const rot = base.map(([x, y]) => [x * c - y * s, x * s + y * c]);
  const P = polygonProps({ outline: rot });
  ok('4a. traza I1+I2 = Iz+Iy', P.I1 + P.I2, P.Iz + P.Iy, 1e-9);
  ok('4b. I1 (mayor) = h·b³? no — = b·h³/12 de la sección', P.I1, b * h ** 3 / 12, 1e-6);
  ok('4c. I2 (menor) = h·b³/12', P.I2, h * b ** 3 / 12, 1e-6);
  okv('4d. Iyz ≠ 0 al estar girada', Math.abs(P.Iyz) > 1e-6 ? 1 : 0, 1, 0);
}

// (5) Compuesta MISMA E = sección monolítica (control). Dos rect 0.3×0.25 apiladas.
{
  const rect = (y0, y1) => [[0, y0], [0.3, y0], [0.3, y1], [0, y1]];
  const C = compositeProps({ parts: [{ outline: rect(0, 0.25), E: 1 }, { outline: rect(0.25, 0.5), E: 1 }], Ebase: 1 });
  const mono = polygonProps({ outline: [[0, 0], [0.3, 0], [0.3, 0.5], [0, 0.5]] });
  ok('5a. compuesta misma E: A_tr = A monolítica', C.A_tr, mono.A, 1e-9);
  ok('5b. compuesta misma E: Iz_tr = Iz monolítica', C.Iz_tr, mono.Iz, 1e-9);
  okv('5c. centroide al medio', C.cy, 0.25, 1e-9);
}
// (6) Madera (abajo) + plancha de acero (arriba): el eje neutro sube hacia el acero
//     y EI = Ebase·Iz_tr (transformada). Comparación con cálculo a mano.
{
  const Ew = 11e6, Es = 210e6, n = Es / Ew;                // razón modular
  const wood = [[0, 0], [0.2, 0], [0.2, 0.3], [0, 0.3]];   // 0.2×0.3 madera
  const steel = [[0, 0.3], [0.2, 0.3], [0.2, 0.31], [0, 0.31]];  // plancha 0.2×0.01 acero arriba
  const C = compositeProps({ parts: [{ outline: wood, E: Ew }, { outline: steel, E: Es }], Ebase: Ew });
  // a mano: área transformada y centroide (base madera)
  const Aw = 0.2 * 0.3, As = 0.2 * 0.01, Atr = Aw + n * As;
  const cy = (Aw * 0.15 + n * As * 0.305) / Atr;
  ok('6a. A_tr (base madera)', C.A_tr, Atr, 1e-9);
  ok('6b. centroide transformado', C.cy, cy, 1e-6);
  assert('6c. el eje neutro sube hacia el acero (>0.15)', C.cy > 0.16, `cy=${C.cy.toFixed(4)}`);
  const Iz = (0.2 * 0.3 ** 3 / 12 + Aw * (0.15 - cy) ** 2) + n * (0.2 * 0.01 ** 3 / 12 + As * (0.305 - cy) ** 2);
  ok('6d. Iz_tr (paralelo a ejes + razón modular)', C.Iz_tr, Iz, 1e-6);
  ok('6e. EIz = Ebase·Iz_tr', C.EIz, Ew * Iz, 1e-9);
}

console.log(fails === 0 ? '\nTODO OK ✓' : `\n${fails} FALLO(S) ✗`);
process.exit(fails ? 1 : 0);
