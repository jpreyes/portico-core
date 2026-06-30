// test_ifc.mjs — verificación del importador IFC (#75/#76, G19)
// Pórtico en IFC (mm): 2 pilares (eje 'Axis' + perfil IPE vía material) + 1 viga
// (sólido extruido + perfil rectangular).  Comprueba: parseo, unidades mm→m, snap de
// nodos coincidentes (pilar-viga), conteo de barras, secciones y material desde IFC.
//
//   node test_ifc.mjs
import assert from 'node:assert';
import { parseIFC, lengthUnit } from './js/io/ifc/ifcLoader.js?v=203';
import { classify } from './js/io/ifc/ifcClassifier.js?v=203';
import { analyzeIFC, itemsToNeutral } from './js/io/ifc/ifcToPortico.js?v=203';
import { neutralToIFC } from './js/io/ifc/ifcWriter.js?v=203';

const IFC = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('portal.ifc','',( ''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#2=IFCUNITASSIGNMENT((#1));
#100=IFCCARTESIANPOINT((0.,0.,0.));
#101=IFCAXIS2PLACEMENT3D(#100,$,$);
#5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#101,$);
#102=IFCLOCALPLACEMENT($,#101);
#3=IFCBUILDINGSTOREY('guidS',$,'Planta 1',$,$,$,$,$,.ELEMENT.,0.);
/* material acero con módulo mecánico (E=210 GPa) y perfil IPE300 */
#10=IFCMATERIAL('Acero S275');
#11=IFCMECHANICALMATERIALPROPERTIES(#10,$,210000000000.,81000000000.,0.3,1.2E-05);
#20=IFCISHAPEPROFILEDEF(.AREA.,'IPE300',$,150.,300.,7.1,10.7,15.);
#21=IFCMATERIALPROFILE('IPE300',$,#10,#20,$,$);
#22=IFCMATERIALPROFILESET('set',$,(#21),$);
#23=IFCMATERIALPROFILESETUSAGE(#22,$,$);
/* pilar 1: eje (0,0,0)-(0,0,3000) */
#110=IFCCARTESIANPOINT((0.,0.,0.));
#111=IFCCARTESIANPOINT((0.,0.,3000.));
#112=IFCPOLYLINE((#110,#111));
#113=IFCSHAPEREPRESENTATION(#5,'Axis','Curve3D',(#112));
#114=IFCPRODUCTDEFINITIONSHAPE($,$,(#113));
#115=IFCCOLUMN('guidC1',$,'C1',$,$,#102,#114,$,.COLUMN.);
/* pilar 2: eje (5000,0,0)-(5000,0,3000) */
#120=IFCCARTESIANPOINT((5000.,0.,0.));
#121=IFCCARTESIANPOINT((5000.,0.,3000.));
#122=IFCPOLYLINE((#120,#121));
#123=IFCSHAPEREPRESENTATION(#5,'Axis','Curve3D',(#122));
#124=IFCPRODUCTDEFINITIONSHAPE($,$,(#123));
#125=IFCCOLUMN('guidC2',$,'C2',$,$,#102,#124,$,.COLUMN.);
/* viga: sólido extruido desde (0,0,3000) a lo largo de X, 5000 mm, R200x400 */
#130=IFCCARTESIANPOINT((0.,0.,3000.));
#131=IFCAXIS2PLACEMENT3D(#130,$,$);
#132=IFCLOCALPLACEMENT($,#131);
#140=IFCCARTESIANPOINT((0.,0.,0.));
#141=IFCAXIS2PLACEMENT3D(#140,$,$);
#142=IFCRECTANGLEPROFILEDEF(.AREA.,'R200x400',$,200.,400.);
#143=IFCDIRECTION((1.,0.,0.));
#144=IFCEXTRUDEDAREASOLID(#142,#141,#143,5000.);
#145=IFCSHAPEREPRESENTATION(#5,'Body','SweptSolid',(#144));
#146=IFCPRODUCTDEFINITIONSHAPE($,$,(#145));
#147=IFCBEAM('guidB1',$,'B1',$,$,#132,#146,$,.BEAM.);
/* asociaciones de material y contención en el nivel */
#24=IFCRELASSOCIATESMATERIAL('g1',$,$,$,(#115,#125),#23);
#25=IFCRELASSOCIATESMATERIAL('g2',$,$,$,(#147),#10);
#4=IFCRELCONTAINEDINSPATIALSTRUCTURE('gR',$,$,$,(#115,#125,#147),#3);
/* un muro para verificar el listado de "no soportado" */
#150=IFCWALL('guidW',$,'Muro 1',$,$,#102,$,$,.STANDARD.);
ENDSEC;
END-ISO-10303-21;
`;

let pass = 0; const ok = (c, m) => { assert.ok(c, m); console.log('  ✓ ' + m); pass++; };

console.log('IFC: parseo y unidades');
const model = parseIFC(IFC);
ok(model.entities.size >= 25, `instancias parseadas: ${model.entities.size}`);
const u = lengthUnit(model);
ok(Math.abs(u.factor - 1e-3) < 1e-12, `unidad de longitud mm → factor ${u.factor}`);

console.log('IFC: clasificación');
const { elements, levels, counts } = classify(model);
ok(counts.column === 2, `2 pilares (IfcColumn): ${counts.column}`);
ok(counts.beam === 1, `1 viga (IfcBeam): ${counts.beam}`);
ok(counts.wall === 1, `1 muro listado como no soportado: ${counts.wall}`);
ok(levels.length === 1 && levels[0].name === 'Planta 1', `nivel "${levels[0]?.name}"`);

console.log('IFC: análisis (geometría + sección + material)');
const an = analyzeIFC(IFC);
const supported = an.items.filter(i => i.status === 'ok');
ok(supported.length === 3, `3 elementos importables: ${supported.length}`);
const wall = an.items.find(i => i.kind === 'wall');
ok(wall && wall.supported && wall.status === 'no-geom', 'muro soportado pero sin geometría (no tiene representación)');

const beam = supported.find(i => i.ifcType === 'IFCBEAM');
const [p1, p2] = beam.segments[0];
ok(Math.abs(p1[0]) < 1e-9 && Math.abs(p1[2] - 3) < 1e-9, `viga inicia en (0,0,3): (${p1.map(v => v.toFixed(2))})`);
ok(Math.abs(p2[0] - 5) < 1e-9 && Math.abs(p2[2] - 3) < 1e-9, `viga termina en (5,0,3): (${p2.map(v => v.toFixed(2))})`);
ok(Math.abs(beam.sec.A - 0.08) < 1e-6, `sección viga R200x400 A=${beam.sec.A.toFixed(5)} m² (esperado 0.08)`);

const col = supported.find(i => i.ifcType === 'IFCCOLUMN');
ok(col.secName === 'IPE300', `pilar con perfil IPE300 desde material: "${col.secName}"`);
ok(Math.abs(col.E - 2.1e8) < 1, `E del pilar 210 GPa → ${col.E} kN/m² (esperado 2.1e8)`);
ok(Math.abs(col.sec.A - 0.005188) < 5e-5, `A del IPE300 ≈ ${col.sec.A.toFixed(6)} m²`);

console.log('IFC: conversión a modelo neutro (snap de nodos)');
const { neutral, stats } = itemsToNeutral(an.items);
ok(stats.members === 3, `3 barras: ${stats.members}`);
ok(stats.nodes === 4, `4 nodos tras snap pilar-viga (tol 0.01 m): ${stats.nodes}`);
ok(stats.materials === 1, `1 material deduplicado: ${stats.materials}`);
ok(stats.sections === 2, `2 secciones (IPE300 + R200x400): ${stats.sections}`);

// equilibrio topológico: cada nodo de viga debe coincidir con un tope de pilar
const tops = neutral.nodes.filter(n => Math.abs(n.z - 3) < 1e-6);
ok(tops.length === 2, `2 nodos a z=3 (los pilares y la viga comparten nodo): ${tops.length}`);

console.log('IFC: round-trip EXPORTAR → reimportar');
const ifcOut = neutralToIFC(neutral, { name: 'RoundTrip' });
ok(/ISO-10303-21/.test(ifcOut) && /END-ISO-10303-21/.test(ifcOut), 'archivo IFC bien formado');
ok((ifcOut.match(/IFCCOLUMN\(/g) || []).length === 2, `2 IfcColumn escritos (pilares verticales): ${(ifcOut.match(/IFCCOLUMN\(/g) || []).length}`);
ok((ifcOut.match(/IFCBEAM\(/g) || []).length === 1, `1 IfcBeam escrito (viga horizontal): ${(ifcOut.match(/IFCBEAM\(/g) || []).length}`);

const an2 = analyzeIFC(ifcOut);
const sup2 = an2.items.filter(i => i.status === 'ok');
ok(sup2.length === 3, `reimportadas 3 barras: ${sup2.length}`);
const { stats: st2 } = itemsToNeutral(an2.items);
ok(st2.members === 3 && st2.nodes === 4, `topología preservada: ${st2.members} barras, ${st2.nodes} nodos`);

// A e Iz de las secciones se reproducen exactos (rectángulo b,h = √(12·Iz/A), A/h)
const secOrig = neutral.sections;
const beam2 = sup2.find(i => i.ifcType === 'IFCBEAM');
const secBeamOrig = secOrig.find(s => Math.abs(s.A - 0.08) < 1e-6);
ok(Math.abs(beam2.sec.A - secBeamOrig.A) < 1e-6, `A de la viga preservada: ${beam2.sec.A.toFixed(5)} vs ${secBeamOrig.A.toFixed(5)}`);
ok(Math.abs(beam2.sec.Iz - secBeamOrig.Iz) / secBeamOrig.Iz < 1e-4, `Iz de la viga preservada: ${beam2.sec.Iz.toExponential(3)} vs ${secBeamOrig.Iz.toExponential(3)}`);

console.log('IFC: áreas (muro/losa) round-trip EXPORTAR → reimportar');
// neutral hecho a mano: 1 losa horizontal (z=0, 4×3) + 1 muro vertical (plano y=0, 4×3)
const areasNeutral = {
  units: { length: 'm', force: 'kN' },
  meta: { name: 'Areas', source: 'test', warnings: [] },
  nodes: [
    { id: 1, x: 0, y: 0, z: 0 }, { id: 2, x: 4, y: 0, z: 0 }, { id: 3, x: 4, y: 3, z: 0 },
    { id: 4, x: 0, y: 3, z: 0 }, { id: 5, x: 4, y: 0, z: 3 }, { id: 6, x: 0, y: 0, z: 3 },
  ],
  materials: [{ id: 1, name: 'H30', E: 2.5e7, G: 1.04e7, nu: 0.2, rho: 2.5, alpha: 1e-5 }],
  sections: [], members: [],
  areas: [
    { id: 1, nodes: [1, 2, 3, 4], mat: 1, thickness: 0.20, behavior: 'shell' },   // losa
    { id: 2, nodes: [1, 2, 5, 6], mat: 1, thickness: 0.25, behavior: 'shell' },   // muro
  ],
  loadCases: [],
};
const areaIfc = neutralToIFC(areasNeutral, { name: 'Areas' });
ok((areaIfc.match(/IFCSLAB\(/g) || []).length === 1, `1 IfcSlab escrito (losa horizontal): ${(areaIfc.match(/IFCSLAB\(/g) || []).length}`);
ok((areaIfc.match(/IFCWALL\(/g) || []).length === 1, `1 IfcWall escrito (muro vertical): ${(areaIfc.match(/IFCWALL\(/g) || []).length}`);

const anA = analyzeIFC(areaIfc);
const areasOk = anA.items.filter(i => i.status === 'ok' && i.isArea);
ok(areasOk.length === 2, `2 áreas importables: ${areasOk.length}`);
const { neutral: nA, stats: stA } = itemsToNeutral(anA.items);
ok(stA.areas === 2, `2 áreas reimportadas: ${stA.areas}`);
ok(stA.nodes === 6, `6 nodos de las áreas (esquinas compartidas): ${stA.nodes}`);
const thicks = nA.areas.map(a => a.thickness).sort((x, y) => x - y);
ok(Math.abs(thicks[0] - 0.20) < 1e-6 && Math.abs(thicks[1] - 0.25) < 1e-6, `espesores preservados: ${thicks.map(t => t.toFixed(3))}`);
ok(nA.areas.every(a => a.nodes.length === 4), 'cada área reimportada con 4 nodos');
ok(nA.materials.length === 1 && Math.abs(nA.materials[0].E - 2.5e7) < 1, `material del área (E) preservado: ${nA.materials[0].E}`);

console.log('IFC: import directo de geometría arquitectónica (losa footprint, muro altura)');
const IFC_AREAS = `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#2=IFCUNITASSIGNMENT((#1));
#5=IFCCARTESIANPOINT((0.,0.,0.));
#6=IFCAXIS2PLACEMENT3D(#5,$,$);
#7=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#6,$);
#8=IFCLOCALPLACEMENT($,#6);
/* losa 4x3 m, espesor 200 mm (footprint extruido por el espesor) */
#10=IFCRECTANGLEPROFILEDEF(.AREA.,'Losa',$,4000.,3000.);
#13=IFCEXTRUDEDAREASOLID(#10,#6,#6,200.);
#14=IFCSHAPEREPRESENTATION(#7,'Body','SweptSolid',(#13));
#15=IFCPRODUCTDEFINITIONSHAPE($,$,(#14));
#16=IFCSLAB('s1',$,'Losa L1',$,$,#8,#15,$,.FLOOR.);
/* muro 4 m largo x 200 mm espesor, extruido 3000 mm en altura */
#20=IFCRECTANGLEPROFILEDEF(.AREA.,'Muro',$,4000.,200.);
#23=IFCEXTRUDEDAREASOLID(#20,#6,#6,3000.);
#24=IFCSHAPEREPRESENTATION(#7,'Body','SweptSolid',(#23));
#25=IFCPRODUCTDEFINITIONSHAPE($,$,(#24));
#26=IFCWALL('w1',$,'Muro M1',$,$,#8,#25,$,.STANDARD.);
ENDSEC;
END-ISO-10303-21;
`;
const anArch = analyzeIFC(IFC_AREAS);
const slab = anArch.items.find(i => i.kind === 'slab');
const muro = anArch.items.find(i => i.kind === 'wall');
ok(slab && slab.status === 'ok', 'losa arquitectónica importable');
ok(Math.abs(slab.thickness - 0.20) < 1e-6, `espesor de losa = ${slab.thickness?.toFixed(3)} m (extrusión, esperado 0.20)`);
ok(slab.corners.length === 4 && slab.corners.every(c => Math.abs(c[2] - 0.1) < 1e-6), 'losa: 4 esquinas en el plano medio z=0.1');
ok(muro && muro.status === 'ok' && muro.areaKind === 'wall', 'muro arquitectónico importable (lógica de muro)');
ok(Math.abs(muro.thickness - 0.20) < 1e-6, `espesor de muro = ${muro.thickness?.toFixed(3)} m (dim. corta, esperado 0.20)`);
const zs = muro.corners.map(c => c[2]).sort((a, b) => a - b);
ok(Math.abs(zs[0]) < 1e-6 && Math.abs(zs[3] - 3) < 1e-6, `muro: panel de z=0 a z=3 m (altura de extrusión): ${zs.map(z => z.toFixed(1))}`);

console.log(`\n✅ IFC OK — ${pass} comprobaciones`);
