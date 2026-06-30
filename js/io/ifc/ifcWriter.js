// ──────────────────────────────────────────────────────────────────────────────
// io/ifc/ifcWriter.js — IFC exporter (STEP / ISO-10303-21) · #75-#77, G19
//
// Writes `io/`'s NEUTRAL model as a TEXT .ifc (IFC4), no dependencies — the
// counterpart of `ifcLoader.js`'s parser.  Each member is emitted as an IfcBeam (or
// IfcColumn if nearly vertical) with:
//   • the minimal spatial hierarchy  IfcProject → IfcSite → IfcBuilding → IfcBuildingStorey;
//   • its AXIS as an 'Axis' representation (IfcPolyline of the two endpoints, in global
//     meters) → what our own importer reads back (round-trip);
//   • material (IfcMaterial + IfcMechanicalMaterialProperties with E in Pa) and section
//     (IfcRectangleProfileDef dimensioned to REPRODUCE exact A and Iz).
// Output units: meters (factor 1).  STANDALONE (Node + browser).
// ──────────────────────────────────────────────────────────────────────────────

// IFC GUID (22 chars of the IFC base64 alphabet; the 1st limited to 2 bits). Viewers
// don't require strict uniqueness; it's enough that they are valid and distinct.
const G64 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';
function ifcGuid() {
  let s = G64[Math.floor(Math.random() * 4)];
  for (let i = 1; i < 22; i++) s += G64[Math.floor(Math.random() * 64)];
  return s;
}

// minimal vector algebra (for area surfaces)
const vsub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vmul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const vdot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vcross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const vlen = a => Math.hypot(a[0], a[1], a[2]);
const vunit = a => { const l = vlen(a); return l > 1e-12 ? vmul(a, 1 / l) : [0, 0, 0]; };

// IFC real: always with a decimal point (1 → "1.")
function num(v) { let s = (+v || 0).toString(); if (!/[.eE]/.test(s)) s += '.'; return s; }
// IFC string: escaped quote '' and non-ASCII as \X2\HHHH…\X0\ (broad compatibility)
function str(s) {
  s = String(s ?? '');
  let out = '', i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c > 0x7e || c < 0x20) {
      let hex = '';
      while (i < s.length && (s.charCodeAt(i) > 0x7e || s.charCodeAt(i) < 0x20)) { hex += s.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0'); i++; }
      out += `\\X2\\${hex}\\X0\\`;
    } else { out += s[i] === "'" ? "''" : s[i]; i++; }
  }
  return `'${out}'`;
}

/**
 * `io/`'s neutral model → IFC4 text (.ifc).
 * @param {object} neutral  output of `modelToNeutral`
 * @param {object} [opts]   { name }
 * @returns {string}
 */
export function neutralToIFC(neutral, opts = {}) {
  const name = opts.name || neutral.meta?.name || 'PORTICO';
  const lines = [];
  let id = 0;
  const e = (body) => { const ref = '#' + (++id); lines.push(`${ref}=${body};`); return ref; };

  // ── context, units, project ───────────────────────────────────────────────────
  const origin = e('IFCCARTESIANPOINT((0.,0.,0.))');
  const cs = e(`IFCAXIS2PLACEMENT3D(${origin},$,$)`);
  const lenUnit = e('IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)');
  const angUnit = e('IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)');
  const unitAssign = e(`IFCUNITASSIGNMENT((${lenUnit},${angUnit}))`);
  const ctx = e(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,${cs},$)`);
  const project = e(`IFCPROJECT(${str(ifcGuid())},$,${str(name)},$,$,$,$,(${ctx}),${unitAssign})`);

  // ── spatial hierarchy: Site → Building → Storey (identity placements) ──
  const sitePl = e(`IFCLOCALPLACEMENT($,${cs})`);
  const bldgPl = e(`IFCLOCALPLACEMENT(${sitePl},${cs})`);
  const storeyPl = e(`IFCLOCALPLACEMENT(${bldgPl},${cs})`);
  const site = e(`IFCSITE(${str(ifcGuid())},$,'Site',$,$,${sitePl},$,$,.ELEMENT.,$,$,$,$,$)`);
  const building = e(`IFCBUILDING(${str(ifcGuid())},$,'Building',$,$,${bldgPl},$,$,.ELEMENT.,$,$,$)`);
  const storey = e(`IFCBUILDINGSTOREY(${str(ifcGuid())},$,'Planta 1',$,$,${storeyPl},$,$,.ELEMENT.,0.)`);
  e(`IFCRELAGGREGATES(${str(ifcGuid())},$,$,$,${project},(${site}))`);
  e(`IFCRELAGGREGATES(${str(ifcGuid())},$,$,$,${site},(${building}))`);
  e(`IFCRELAGGREGATES(${str(ifcGuid())},$,$,$,${building},(${storey}))`);

  // ── materials (IfcMaterial + mechanical properties: E in Pa) ──
  const matRef = new Map();
  for (const m of (neutral.materials || [])) {
    const mr = e(`IFCMATERIAL(${str(m.name || 'Material')})`);
    matRef.set(m.id, mr);
    const E = (m.E || 0) * 1000, G = (m.G || 0) * 1000;   // kN/m² → Pa
    if (E > 0) e(`IFCMECHANICALMATERIALPROPERTIES(${mr},$,${num(E)},${num(G)},${num(m.nu ?? 0.3)},${num(m.alpha ?? 1.2e-5)})`);
  }
  const secById = new Map((neutral.sections || []).map(s => [s.id, s]));

  // section → rectangle (b,h) reproducing exact A and Iz:  h=√(12·Iz/A), b=A/h
  const rectOf = (s) => {
    const A = s.A > 0 ? s.A : 1e-3;
    let h = (s.Iz > 0 && A > 0) ? Math.sqrt(12 * s.Iz / A) : Math.sqrt(A);
    if (!isFinite(h) || h <= 0) h = Math.sqrt(A);
    let b = A / h; if (!isFinite(b) || b <= 0) b = Math.sqrt(A);
    return { b, h };
  };

  // ── members: point×2 → 'Axis' polyline → IfcBeam/IfcColumn ──
  const memPl = e(`IFCLOCALPLACEMENT(${storeyPl},${cs})`);
  const nodeById = new Map((neutral.nodes || []).map(n => [n.id, n]));
  const elemsByMatSec = new Map();   // "mat|sec" → [elemRef, …]
  const allElems = [];
  for (const mb of (neutral.members || [])) {
    const a = nodeById.get(mb.ni), b = nodeById.get(mb.nj);
    if (!a || !b) continue;
    const p1 = e(`IFCCARTESIANPOINT((${num(a.x)},${num(a.y)},${num(a.z)}))`);
    const p2 = e(`IFCCARTESIANPOINT((${num(b.x)},${num(b.y)},${num(b.z)}))`);
    const pl = e(`IFCPOLYLINE((${p1},${p2}))`);
    const sr = e(`IFCSHAPEREPRESENTATION(${ctx},'Axis','Curve3D',(${pl}))`);
    const ps = e(`IFCPRODUCTDEFINITIONSHAPE($,$,(${sr}))`);
    const L = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) || 1;
    const vertical = Math.abs(b.z - a.z) / L > 0.85;
    const tipo = vertical ? 'IFCCOLUMN' : 'IFCBEAM';
    const pdt = vertical ? '.COLUMN.' : '.BEAM.';
    const elName = `${vertical ? 'Pilar' : 'Viga'} ${mb.id}`;
    const el = e(`${tipo}(${str(ifcGuid())},$,${str(elName)},$,$,${memPl},${ps},$,${pdt})`);
    allElems.push(el);
    const key = `${mb.mat || 1}|${mb.sec || 1}`;
    if (!elemsByMatSec.has(key)) elemsByMatSec.set(key, []);
    elemsByMatSec.get(key).push(el);
  }

  // ── material+profile association per used (mat,sec) combination ──
  for (const [key, els] of elemsByMatSec) {
    const [mi, si] = key.split('|').map(Number);
    const sec = secById.get(si);
    const mr = matRef.get(mi) || matRef.values().next().value;
    const { b, h } = rectOf(sec || { A: 1e-3, Iz: 0 });
    const prof = e(`IFCRECTANGLEPROFILEDEF(.AREA.,${str(sec?.name || 'Sección')},$,${num(b)},${num(h)})`);
    const mProf = e(`IFCMATERIALPROFILE(${str(sec?.name || 'Sección')},$,${mr || '$'},${prof},$,$)`);
    const mSet = e(`IFCMATERIALPROFILESET(${str(sec?.name || 'Sección')},$,(${mProf}),$)`);
    const mUse = e(`IFCMATERIALPROFILESETUSAGE(${mSet},$,$)`);
    e(`IFCRELASSOCIATESMATERIAL(${str(ifcGuid())},$,$,$,(${els.join(',')}),${mUse})`);
  }

  // ── areas: wall/slab as an extruded solid (mid-surface outline × thickness) ──
  const nById = new Map((neutral.nodes || []).map(n => [n.id, [n.x, n.y, n.z]]));
  for (const ar of (neutral.areas || [])) {
    const cs = (ar.nodes || []).map(i => nById.get(i)).filter(Boolean);
    if (cs.length < 3) continue;
    const t = ar.thickness || 0.2;
    let nrm = vunit(vcross(vsub(cs[1], cs[0]), vsub(cs[2], cs[0])));
    if (vlen(nrm) < 1e-9) continue;
    const vertical = Math.abs(nrm[2]) <= 0.7;
    const lx = vunit(vsub(cs[1], cs[0])), lz = nrm, ly = vcross(lz, lx);
    const base0 = vsub(cs[0], vmul(lz, t / 2));                 // base plane of the solid (centered on the mid-surface)
    const poly2d = cs.map(c => [vdot(vsub(c, cs[0]), lx), vdot(vsub(c, cs[0]), ly)]);
    const ptRefs = poly2d.map(q => e(`IFCCARTESIANPOINT((${num(q[0])},${num(q[1])}))`));
    const pl = e(`IFCPOLYLINE((${ptRefs.join(',')},${ptRefs[0]}))`);   // closed outline
    const prof = e(`IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,${str(ar.name || 'Área')},${pl})`);
    const oPt = e(`IFCCARTESIANPOINT((${num(base0[0])},${num(base0[1])},${num(base0[2])}))`);
    const zD = e(`IFCDIRECTION((${num(lz[0])},${num(lz[1])},${num(lz[2])}))`);
    const xD = e(`IFCDIRECTION((${num(lx[0])},${num(lx[1])},${num(lx[2])}))`);
    const ap = e(`IFCAXIS2PLACEMENT3D(${oPt},${zD},${xD})`);
    const solid = e(`IFCEXTRUDEDAREASOLID(${prof},${ap},${e('IFCDIRECTION((0.,0.,1.))')},${num(t)})`);
    const sr = e(`IFCSHAPEREPRESENTATION(${ctx},'Body','SweptSolid',(${solid}))`);
    const ps = e(`IFCPRODUCTDEFINITIONSHAPE($,$,(${sr}))`);
    const tipo = vertical ? 'IFCWALL' : 'IFCSLAB';
    const pdt = vertical ? '.STANDARD.' : '.FLOOR.';
    const el = e(`${tipo}(${str(ifcGuid())},$,${str((vertical ? 'Muro ' : 'Losa ') + ar.id)},$,$,${memPl},${ps},$,${pdt})`);
    allElems.push(el);
    const mr = matRef.get(ar.mat) || matRef.values().next().value;
    if (mr) {
      const ml = e(`IFCMATERIALLAYER(${mr},${num(t)},$)`);
      const mls = e(`IFCMATERIALLAYERSET((${ml}),${str((vertical ? 'Muro ' : 'Losa ') + ar.id)})`);
      const mlu = e(`IFCMATERIALLAYERSETUSAGE(${mls},.AXIS2.,.POSITIVE.,0.)`);
      e(`IFCRELASSOCIATESMATERIAL(${str(ifcGuid())},$,$,$,(${el}),${mlu})`);
    }
  }

  // ── containment of ALL elements (members + areas) in the story ──
  if (allElems.length)
    e(`IFCRELCONTAINEDINSPATIALSTRUCTURE(${str(ifcGuid())},$,'Elementos',$,(${allElems.join(',')}),${storey})`);

  // ── assemble the file ──
  const ts = new Date().toISOString().slice(0, 19);
  const header =
    `ISO-10303-21;\nHEADER;\n` +
    `FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');\n` +
    `FILE_NAME(${str(name + '.ifc')},'${ts}',(''),(''),'PORTICO','PORTICO','');\n` +
    `FILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n`;
  return header + lines.join('\n') + '\nENDSEC;\nEND-ISO-10303-21;\n';
}
