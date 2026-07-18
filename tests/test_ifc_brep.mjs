// test_ifc_brep.mjs — IFC B-rep (mesh) fallback: import elements exported as faceted
// meshes (Archicad "SurfaceGeometryAddOnView"), which carry no IfcExtrudedAreaSolid and
// no 3D 'Axis'. The importer approximates each element from the mesh's bounding box:
//   • one dominant axis   → BAR   (axis = longest extent, section = the other two)
//   • one thin axis        → PANEL (mid-surface + thickness; wall → membrane, else shell)
//   • all comparable       → 3D BLOCK → skipped (warned)
import { analyzeIFC, ifcToModel } from '../js/io/ifc/ifcToPortico.js';

let fails = 0;
const ok = (c, m) => { console.log(`  ${c ? 'OK  ' : 'FAIL'} ${m}`); if (!c) fails++; };
const near = (a, b, tol = 1e-3) => Math.abs(a - b) <= tol * Math.abs(b) + 1e-9;

// ── minimal IFC generator: each element is a Body B-rep box (8 corners) ─────────────
let _id = 100;
const N = () => `#${_id++}`;
const E = [];
const CTX = '#3';
function box(type, name, [X, Y, Z], origin = [0, 0, 0]) {
  const cs = [];
  for (const sx of [-X / 2, X / 2]) for (const sy of [-Y / 2, Y / 2]) for (const sz of [-Z / 2, Z / 2]) {
    const id = N(); E.push(`${id}=IFCCARTESIANPOINT((${sx.toFixed(4)},${sy.toFixed(4)},${sz.toFixed(4)}))`); cs.push(id);
  }
  const loop = N(); E.push(`${loop}=IFCPOLYLOOP((${cs.join(',')}))`);
  const bound = N(); E.push(`${bound}=IFCFACEOUTERBOUND(${loop},.T.)`);
  const face = N(); E.push(`${face}=IFCFACE((${bound}))`);
  const shell = N(); E.push(`${shell}=IFCCLOSEDSHELL((${face}))`);
  const brep = N(); E.push(`${brep}=IFCFACETEDBREP(${shell})`);
  const sr = N(); E.push(`${sr}=IFCSHAPEREPRESENTATION(${CTX},'Body','Brep',(${brep}))`);
  const pds = N(); E.push(`${pds}=IFCPRODUCTDEFINITIONSHAPE($,$,(${sr}))`);
  const o = N(); E.push(`${o}=IFCCARTESIANPOINT((${origin.map(v => v.toFixed(3)).join(',')}))`);
  const ax = N(); E.push(`${ax}=IFCAXIS2PLACEMENT3D(${o},$,$)`);
  const pl = N(); E.push(`${pl}=IFCLOCALPLACEMENT($,${ax})`);
  const el = N(); E.push(`${el}=${type}('g${_id}',$,'${name}',$,$,${pl},${pds},$)`);
  return el;
}

box('IFCBEAM', 'Viga-Test', [300, 4000, 400], [0, 0, 0]);              // bar, rectangular 300×400, L=4 m
box('IFCCOLUMN', 'Perfil circular D200', [200, 3000, 220], [10, 0, 0]); // bar, circular by name, L=3 m
box('IFCWALL', 'Muro-Test', [3000, 200, 2400], [20, 0, 0]);            // panel → membrane, t=200 mm
box('IFCCOLUMN', 'Dado', [500, 500, 500], [30, 0, 0]);                 // 3D block → skipped

const IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('test','2026-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC2X3'));
ENDSEC;
DATA;
#1=IFCPROJECT('P',$,'Test',$,$,$,$,(#3),#4);
#3=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,0.01,#8,$);
#4=IFCUNITASSIGNMENT((#6));
#6=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#8=IFCAXIS2PLACEMENT3D(#9,$,$);
#9=IFCCARTESIANPOINT((0.,0.,0.));
${E.join(';\n')};
ENDSEC;
END-ISO-10303-21;
`;

// ── analyzeIFC: per-element status / geometry ───────────────────────────────────
console.log('── analyzeIFC: clasificación por forma del bounding box ──');
const r = analyzeIFC(IFC);
ok(r.unit.factor === 0.001, `unidad mm → factor ${r.unit.factor}`);
const byName = Object.fromEntries(r.items.map(it => [it.name, it]));

const beam = byName['Viga-Test'];
const segLen = beam.segments[0] ? Math.hypot(...beam.segments[0][1].map((v, k) => v - beam.segments[0][0][k])) : 0;
ok(beam.status === 'ok' && beam.segments.length === 1, `viga: importada como barra (status ${beam.status})`);
ok(near(segLen, 4.0), `viga: eje = 4.0 m (${segLen.toFixed(3)})`);
ok(beam.sec && near(beam.sec.A, 0.3 * 0.4), `viga: sección rectangular A = 0.12 m² (${beam.sec ? beam.sec.A.toFixed(4) : '—'})`);

const col = byName['Perfil circular D200'];
ok(col.status === 'ok' && col.sec, `columna circular: importada como barra`);
ok(col.sec && near(col.sec.A, Math.PI * 0.1 * 0.1, 1e-2), `columna: sección CIRCULAR por nombre A = πr² (${col.sec ? col.sec.A.toFixed(4) : '—'})`);
ok(col.sec && near(col.sec.Iy, col.sec.Iz), `columna: Iy = Iz (círculo)`);

const wall = byName['Muro-Test'];
ok(wall.status === 'ok' && wall.corners && wall.corners.length === 4, `muro: importado como panel de 4 nodos (status ${wall.status})`);
ok(near(wall.thickness, 0.2), `muro: espesor = 200 mm (${(wall.thickness * 1000).toFixed(0)} mm)`);

const cube = byName['Dado'];
ok(cube.status === 'no-geom', `dado (bloque 3D): omitido (status ${cube.status})`);
ok(cube.warnings.list.some(w => /bloque 3D/i.test(w)), `dado: avisa "bloque 3D"`);

// ── ifcToModel: the built model (membrane vs shell) ─────────────────────────────
console.log('\n── ifcToModel: modelo construido ──');
const { model } = ifcToModel(IFC);
ok(model.elements.size === 2, `2 barras (viga + columna) en el modelo (${model.elements.size})`);
ok(model.areas.size === 1, `1 área (muro) en el modelo (${model.areas.size})`);
const area = [...model.areas.values()][0];
ok(area.behavior === 'membrane', `muro → comportamiento MEMBRANA (${area.behavior})`);

console.log(`\n=== ${fails === 0 ? 'ALL OK' : fails + ' FAILURE(S)'} ===`);
process.exit(fails ? 1 : 0);
