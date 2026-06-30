// test_section_shapes.mjs — verificación de las formas de sección C/L/T (#67)
//
// Compara fromShape('channel'|'angle'|'tee') (analítico, vía rectsProps) contra
// una INTEGRACIÓN NUMÉRICA por celda fina del mismo perfil (método independiente):
// A, centroide implícito (vía Iz/Iy centroidales), módulos elásticos S y módulos
// PLÁSTICOS Z.  Valida el cálculo del eje neutro plástico por bisección.
//
//   node test_section_shapes.mjs
//
import { fromShape } from './js/design/section_props.js';

let fails = 0;
const ok = (name, got, exp, tol) => {
  const err = Math.abs(got - exp) / (Math.abs(exp) || 1);
  const pass = err <= tol;
  if (!pass) fails++;
  console.log(`${pass ? '✓' : '✗'} ${name}: got=${got.toExponential(5)} exp=${exp.toExponential(5)} err=${(err * 100).toFixed(3)}%`);
};

// Integración por celdas: rects = [{x0,x1,y0,y1}]. Devuelve A, Iz, Iy, Sz, Sy, Zz, Zy.
function bruteForce(rects, ng = 1200) {
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (const r of rects) { xmin = Math.min(xmin, r.x0); xmax = Math.max(xmax, r.x1); ymin = Math.min(ymin, r.y0); ymax = Math.max(ymax, r.y1); }
  const dx = (xmax - xmin) / ng, dy = (ymax - ymin) / ng, da = dx * dy;
  const inside = (x, y) => rects.some(r => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1);
  let A = 0, Sx = 0, Sy = 0;
  const cells = [];
  for (let i = 0; i < ng; i++) for (let j = 0; j < ng; j++) {
    const x = xmin + (i + 0.5) * dx, y = ymin + (j + 0.5) * dy;
    if (!inside(x, y)) continue;
    A += da; Sx += x * da; Sy += y * da; cells.push([x, y]);
  }
  const cx = Sx / A, cy = Sy / A;
  let Iz = 0, Iy = 0, maxYd = 0, maxXd = 0;
  for (const [x, y] of cells) { Iz += (y - cy) ** 2 * da; Iy += (x - cx) ** 2 * da; maxYd = Math.max(maxYd, Math.abs(y - cy)); maxXd = Math.max(maxXd, Math.abs(x - cx)); }
  // ejes neutros plásticos por mediana
  const ys = cells.map(c => c[1]).sort((a, b) => a - b); const yp = ys[Math.floor(ys.length / 2)];
  const xs = cells.map(c => c[0]).sort((a, b) => a - b); const xp = xs[Math.floor(xs.length / 2)];
  let Zz = 0, Zy = 0; for (const [x, y] of cells) { Zz += Math.abs(y - yp) * da; Zy += Math.abs(x - xp) * da; }
  return { A, Iz, Iy, Sz: Iz / maxYd, Sy: Iy / maxXd, Zz, Zy };
}

function compare(label, shape, dims, rects, tol = 8e-3) {
  const g = fromShape(shape, dims);
  const b = bruteForce(rects);
  console.log(`\n— ${label} —`);
  ok(`${label} A`, g.A, b.A, tol);
  ok(`${label} Iz (fuerte)`, g.Iz, b.Iz, tol);
  ok(`${label} Iy (débil)`, g.Iy, b.Iy, tol);
  ok(`${label} Sz`, g.Sz, b.Sz, tol);
  ok(`${label} Sy`, g.Sy, b.Sy, tol);
  ok(`${label} Zz (plástico fuerte)`, g.Zz, b.Zz, tol);
  ok(`${label} Zy (plástico débil)`, g.Zy, b.Zy, tol);
}

// Canal tipo UPN200 aproximado (m): H=0.20, bf=0.075, tf=0.0115, tw=0.0085
compare('Canal C', 'channel', { d: 0.20, bf: 0.075, tf: 0.0115, tw: 0.0085 }, [
  { x0: 0, x1: 0.0085, y0: 0, y1: 0.20 },
  { x0: 0.0085, x1: 0.075, y0: 0.20 - 0.0115, y1: 0.20 },
  { x0: 0.0085, x1: 0.075, y0: 0, y1: 0.0115 },
]);

// Angular L 100x75x10 (m)
compare('Angular L', 'angle', { d: 0.100, b: 0.075, t: 0.010 }, [
  { x0: 0, x1: 0.010, y0: 0, y1: 0.100 },
  { x0: 0.010, x1: 0.075, y0: 0, y1: 0.010 },
]);

// Tee 150x100 (m): H=0.150, bf=0.100, tf=0.012, tw=0.008
compare('Tee T', 'tee', { d: 0.150, bf: 0.100, tf: 0.012, tw: 0.008 }, [
  { x0: (0.100 - 0.008) / 2, x1: (0.100 + 0.008) / 2, y0: 0, y1: 0.150 - 0.012 },
  { x0: 0, x1: 0.100, y0: 0.150 - 0.012, y1: 0.150 },
]);

console.log(fails === 0 ? '\nTODO OK ✓' : `\n${fails} FALLO(S) ✗`);
process.exit(fails ? 1 : 0);
