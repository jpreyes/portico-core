// Verificación — suavizado «smart Laplacian» (#52, calidad avanzada).
// El smart smoothing acepta el paso sólo si NO reduce la calidad mínima incidente →
// la calidad mínima de la malla es monótona no-decreciente. El Laplaciano plano
// (centroide ω sin chequeo de calidad) PUEDE empeorar la calidad mínima.
import { triangulatePolygon } from '../js/model/mesh_free.js';
import { laplacianSmooth, meshStats } from '../js/model/mesh_quality.js';

// Polígono en L (cóncavo) → malla mixta con celdas de calidad dispar.
const L = [[0,0],[6,0],[6,2],[2,2],[2,6],[0,6]];
// adaptive:false → aísla el suavizado del refinamiento por curvatura (que es otra feature)
const { V, cells } = triangulatePolygon(L, { h: 1.0, smooth: 0, adaptive: false });   // sin suavizar
const nodes0 = V.map(p => [p[0], p[1], 0]);
const base = meshStats(nodes0, cells);

const plain = laplacianSmooth(nodes0, cells, { iters: 6, omega: 0.5, smart: false });
const smart = laplacianSmooth(nodes0, cells, { iters: 6, omega: 0.5, smart: true });

let ok = true;
const line = (pass, msg) => { console.log(`${pass ? 'OK ' : 'XX '} ${msg}`); ok = pass && ok; };

console.log(`malla: ${base.nTri} tri + ${base.nQuad} quad = ${base.n} celdas`);
console.log(`minQuality:  sin suavizar=${base.minQuality.toFixed(4)}  ·  plano=${plain.after.minQuality.toFixed(4)}  ·  smart=${smart.after.minQuality.toFixed(4)}`);

// 1) El smart NUNCA reduce la calidad mínima (garantía de monotonía).
line(smart.after.minQuality >= base.minQuality - 1e-9,
     `smart no reduce la calidad mínima (${smart.after.minQuality.toFixed(4)} ≥ ${base.minQuality.toFixed(4)})`);

// 2) El smart no es peor que el plano en la calidad mínima.
line(smart.after.minQuality >= plain.after.minQuality - 1e-9,
     `smart ≥ plano en calidad mínima (${smart.after.minQuality.toFixed(4)} ≥ ${plain.after.minQuality.toFixed(4)})`);

// 3) Ninguna celda queda invertida tras el smart.
line(!smart.after.inverted, `smart sin celdas invertidas (minJac=${smart.after.minScaledJac.toFixed(4)})`);

// 4) El smart efectivamente movió nodos interiores (no es un no-op).
line(smart.moved > 0, `smart movió ${smart.moved} nodos interiores`);

console.log(ok ? '\n✅ TODO OK' : '\n❌ FALLÓ');
process.exit(ok ? 0 : 1);
