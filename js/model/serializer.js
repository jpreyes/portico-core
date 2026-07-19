// ──────────────────────────────────────────────────────────────────────────────
// Serializer — JSON (.s3d) and CSV import/export
// ──────────────────────────────────────────────────────────────────────────────
import { Model } from './model.js?v=4';

export class Serializer {

  // ══ JSON (.s3d) ════════════════════════════════════════════════════════════

  toJSON(model) {
    const obj = {
      version: '1.0',
      units: model.units,
      mode: model.mode || '3D',
      nodes:      [...model.nodes.values()],
      elements:   [...model.elements.values()],
      areas:      [...model.areas.values()],
      materials:  [...model.materials.values()],
      sections:   [...model.sections.values()],
      diaphragms:   [...model.diaphragms.values()],
      links:        [...model.links.values()],
      loadCases:    [...model.loadCases.values()],
      combinations: [...model.combinations.values()],
      grids:        model.grids || { x: [], y: [], z: [] },
      // massSource changes the mass matrix → it MUST take part in the results-cache
      // signature, so it lives here (unlike memoria/analysisParams).
      massSource:   model.massSource || null,
      _counters:   { ...model._cnt }
    };
    // NOTE: `memoria` (#41) and `analysisParams` (#39) are intentionally NOT included
    // here. This serialization feeds `_modelSig` (results cache) and must depend only
    // on the geometry/loads. Those per-project data are embedded by `_fullSaveJSON`
    // when saving to disk and read by `fromJSON` further below.
    return JSON.stringify(obj, null, 2);
  }

  fromJSON(jsonStr) {
    let obj;
    try { obj = JSON.parse(jsonStr); }
    catch { throw new Error('JSON inválido'); }

    // Robust import: a corrupt / hand-edited .s3d must fail with a CLEAR message, not a
    // cryptic TypeError ("Cannot create property 'nodeMass' on string …", "X is not
    // iterable"). Top-level must be a JSON object; each collection present must be a list.
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj))
      throw new Error('Archivo .s3d inválido: se esperaba un objeto JSON.');
    const arr = (v, name) => {
      if (v == null) return [];
      if (!Array.isArray(v)) throw new Error(`Archivo .s3d inválido: el campo "${name}" debe ser una lista.`);
      return v;
    };

    const m = new Model();
    // Clear defaults, we'll load from file
    m.materials.clear(); m.sections.clear();
    m._cnt = { nodes:0, elements:0, areas:0, materials:0, sections:0, diaphragms:0, loadCases:0, combinations:0, links:0 };

    m.units = obj.units || 'kN-m';
    m.mode  = obj.mode === '2D' ? '2D' : '3D';

    for (const d of arr(obj.materials, 'materials'))  { m.materials.set(d.id, d); }
    for (const d of arr(obj.sections, 'sections'))  { m.sections.set(d.id, d); }
    for (const d of arr(obj.nodes, 'nodes'))  {
      // backfill de masa nodal incl. inercia rotacional irx/iry/irz (#6, archivos viejos)
      d.nodeMass = { mx: 0, my: 0, mz: 0, irx: 0, iry: 0, irz: 0, ...(d.nodeMass || {}) };
      if (!d.springs)  d.springs  = { kux: 0, kuy: 0, kuz: 0, krx: 0, kry: 0, krz: 0 };
      m.nodes.set(d.id, d);
    }
    for (const d of arr(obj.elements, 'elements'))  {
      if (!d.releases) d.releases = Array(12).fill(0);
      m.elements.set(d.id, d);
    }
    for (const d of arr(obj.areas, 'areas'))  {
      if (!d.kind) d.kind = (d.nodes || []).length === 3 ? 'CST' : 'QUAD';
      if (!d.behavior) d.behavior = 'membrane';
      m.areas.set(d.id, d);
    }
    for (const d of arr(obj.diaphragms, 'diaphragms'))  { m.diaphragms.set(d.id, d); }
    for (const d of arr(obj.links, 'links')) {
      if (!d.dofs) d.dofs = { ux: 1, uy: 1, uz: 1, rx: 1, ry: 1, rz: 1 };
      if (d.rigid === undefined) d.rigid = true;
      m.links.set(d.id, d);
    }
    for (const d of arr(obj.loadCases, 'loadCases')) {
      if (d.type !== 'spectrum') { d.type = 'static'; d.specDir = null; }
      m.loadCases.set(d.id, d);
    }
    for (const d of arr(obj.combinations, 'combinations')) { m.combinations.set(d.id, d); }
    m.grids = obj.grids || { x: [], y: [], z: [] };
    // Datos por proyecto (#41 / #39); ausentes en archivos viejos → null (defaults app).
    m.report        = obj.report || null;
    m.analysisParams = obj.analysisParams || null;
    m.designSettings = obj.designSettings || null;
    m.massSource     = obj.massSource || null;

    if (obj._counters) {
      m._cnt = { ...m._cnt, ...obj._counters };
    } else {
      // Recompute counters from max IDs
      const maxId = (map) => Math.max(0, ...[...map.keys()]);
      m._cnt.nodes      = maxId(m.nodes);
      m._cnt.elements   = maxId(m.elements);
      m._cnt.materials  = maxId(m.materials);
      m._cnt.sections   = maxId(m.sections);
      m._cnt.diaphragms = maxId(m.diaphragms);
      m._cnt.loadCases  = maxId(m.loadCases);
      m._cnt.links      = maxId(m.links);
    }

    // If empty after loading, add defaults
    if (m.materials.size === 0) m._initDefaults();

    return m;
  }

  // ══ CSV ═══════════════════════════════════════════════════════════════════

  toCSV(model) {
    const lines = [];
    const fmt = (v) => {
      if (typeof v === 'number') {
        // Use exponential for very small/large numbers
        if (Math.abs(v) > 0 && (Math.abs(v) < 1e-3 || Math.abs(v) >= 1e7)) {
          return v.toExponential(4);
        }
        return +v.toPrecision(8) + '';
      }
      return String(v);
    };

    lines.push('# PORTICO CSV Export');
    lines.push(`# Unidades: ${model.units}`);
    lines.push('#');

    lines.push('# TYPE, ID, name, E, G, nu, rho');
    for (const m of model.materials.values()) {
      lines.push(`MATERIAL, ${m.id}, ${m.name}, ${fmt(m.E)}, ${fmt(m.G)}, ${fmt(m.nu)}, ${fmt(m.rho)}`);
    }
    lines.push('#');

    lines.push('# TYPE, ID, name, A, Iz, Iy, J, Avy, Avz, kappay, kappaz');
    for (const s of model.sections.values()) {
      lines.push(`SECTION, ${s.id}, ${s.name}, ${fmt(s.A)}, ${fmt(s.Iz)}, ${fmt(s.Iy)}, ${fmt(s.J)}, ${fmt(s.Avy)}, ${fmt(s.Avz)}, ${fmt(s.kappay)}, ${fmt(s.kappaz)}`);
    }
    lines.push('#');

    lines.push('# TYPE, ID, X, Y, Z, ux, uy, uz, rx, ry, rz  (1=fijo 0=libre)');
    for (const n of model.nodes.values()) {
      const r = n.restraints;
      lines.push(`NODE, ${n.id}, ${fmt(n.x)}, ${fmt(n.y)}, ${fmt(n.z)}, ${r.ux|0}, ${r.uy|0}, ${r.uz|0}, ${r.rx|0}, ${r.ry|0}, ${r.rz|0}`);
    }
    lines.push('#');

    lines.push('# TYPE, ID, n1, n2, mat_id, sec_id[, r0..r11  1=libera 0=fijo]');
    for (const e of model.elements.values()) {
      const rel = e.releases ?? Array(12).fill(0);
      const hasRel = rel.some(r => r !== 0);
      const relStr = hasRel ? ', ' + rel.join(', ') : '';
      lines.push(`ELEMENT, ${e.id}, ${e.n1}, ${e.n2}, ${e.matId}, ${e.secId}${relStr}`);
    }
    lines.push('#');

    if (model.diaphragms.size > 0) {
      lines.push('# TYPE, ID, z, nodes(;sep), cm_x, cm_y, mass_m, mass_Icm, ex, ey');
      for (const d of model.diaphragms.values()) {
        const nodes = d.nodes.join(';');
        lines.push(`DIAPHRAGM, ${d.id}, ${fmt(d.z)}, ${nodes}, ${fmt(d.cm.x)}, ${fmt(d.cm.y)}, ${fmt(d.mass.m)}, ${fmt(d.mass.Icm)}, ${fmt(d.eccentricity.ex)}, ${fmt(d.eccentricity.ey)}`);
      }
      lines.push('#');
    }

    if (model.loadCases.size > 0) {
      lines.push('# TYPE, ID, nombre, peso_propio(1/0), tipo(static/spectrum), dir_espectral(X/Y)');
      for (const lc of model.loadCases.values()) {
        lines.push(`LOAD_CASE, ${lc.id}, ${lc.name}, ${lc.selfWeight ? 1 : 0}, ${lc.type || 'static'}, ${lc.specDir || '-'}`);
      }
      lines.push('#');
      lines.push('# TYPE, lc_id, node_id, Fx, Fy, Fz, Mx, My, Mz');
      lines.push('# TYPE, lc_id, elem_id, dir, w');
      for (const lc of model.loadCases.values()) {
        for (const load of lc.loads) {
          if (load.type === 'nodal') {
            lines.push(`LOAD_NODAL, ${lc.id}, ${load.nodeId}, ${load.F.map(fmt).join(', ')}`);
          } else if (load.type === 'dist') {
            // w2 opcional (trapecial); se omite si es uniforme para compatibilidad.
            const w2 = (load.w2 == null || load.w2 === load.w) ? '' : `, ${fmt(load.w2)}`;
            lines.push(`LOAD_DIST, ${lc.id}, ${load.elemId}, ${load.dir || 'gravity'}, ${fmt(load.w)}${w2}`);
          }
        }
      }
      lines.push('#');
    }

    const hasNodeMass = [...model.nodes.values()].some(n => n.nodeMass && (n.nodeMass.mx || n.nodeMass.my || n.nodeMass.mz || n.nodeMass.irx || n.nodeMass.iry || n.nodeMass.irz));
    if (hasNodeMass) {
      lines.push('# TYPE, node_id, mx(ton), my(ton), mz(ton), irx(ton·m²), iry, irz');
      for (const n of model.nodes.values()) {
        const nm = n.nodeMass;
        if (!nm || (!nm.mx && !nm.my && !nm.mz && !nm.irx && !nm.iry && !nm.irz)) continue;
        lines.push(`NODE_MASS, ${n.id}, ${fmt(nm.mx || 0)}, ${fmt(nm.my || 0)}, ${fmt(nm.mz || 0)}, ${fmt(nm.irx || 0)}, ${fmt(nm.iry || 0)}, ${fmt(nm.irz || 0)}`);
      }
      lines.push('#');
    }

    const hasSprings = [...model.nodes.values()].some(n => n.springs && Object.values(n.springs).some(k => k > 0));
    if (hasSprings) {
      lines.push('# TYPE, node_id, kux(kN/m), kuy, kuz, krx(kN·m/rad), kry, krz');
      for (const n of model.nodes.values()) {
        const sp = n.springs;
        if (!sp || !Object.values(sp).some(k => k > 0)) continue;
        lines.push(`NODE_SPRING, ${n.id}, ${fmt(sp.kux || 0)}, ${fmt(sp.kuy || 0)}, ${fmt(sp.kuz || 0)}, ${fmt(sp.krx || 0)}, ${fmt(sp.kry || 0)}, ${fmt(sp.krz || 0)}`);
      }
      lines.push('#');
    }

    if (model.combinations.size > 0) {
      lines.push('# TYPE, ID, nombre, lc_id1, factor1[, lc_id2, factor2, ...]');
      for (const combo of model.combinations.values()) {
        const factorsStr = combo.factors.map(f => `${f.lcId}, ${fmt(f.factor)}`).join(', ');
        lines.push(`COMBINATION, ${combo.id}, ${combo.name}, ${factorsStr}`);
      }
    }

    return lines.join('\r\n');
  }

  // fromCSV merges into an existing model (or creates a new one if model=null).
  // `t` is an optional translator (UI passes i18n.t) for user-visible parse errors;
  // defaults to identity so the model module stays neutral (no i18n dependency).
  fromCSV(csvStr, baseModel = null, t = (s) => s) {
    const model  = baseModel ?? new Model();
    const errors = [];

    const rows = csvStr
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'));

    // Parse all rows, group by type
    const parsed = {
      MATERIAL:[], SECTION:[], NODE:[], ELEMENT:[], DIAPHRAGM:[],
      LOAD_CASE:[], LOAD_NODAL:[], LOAD_DIST:[], NODE_MASS:[], NODE_SPRING:[], COMBINATION:[]
    };

    rows.forEach((line, lineIdx) => {
      const cols = line.split(',').map(c => c.trim());
      const type = (cols[0] || '').toUpperCase();
      if (!parsed[type]) {
        errors.push(`${t('Línea')} ${lineIdx+1}: ${t('tipo desconocido')} "${cols[0]}"`);
        return;
      }
      parsed[type].push({ cols, line: lineIdx + 1 });
    });

    // ── Materials ────────────────────────────────────────────────────────────
    for (const { cols, line } of parsed.MATERIAL) {
      // MATERIAL, id, name, E, G, nu, rho
      if (cols.length < 7) { errors.push(`${t('Línea')} ${line}: ${t('MATERIAL necesita 7 columnas')}`); continue; }
      const [, id, name, E, G, nu, rho] = cols;
      const obj = { id: +id, name, E: +E, G: +G, nu: +nu, rho: +rho };
      if (isNaN(obj.id) || isNaN(obj.E)) { errors.push(`${t('Línea')} ${line}: ${t('valores numéricos inválidos en MATERIAL')}`); continue; }
      model.materials.set(obj.id, obj);
      if (obj.id > model._cnt.materials) model._cnt.materials = obj.id;
    }

    // ── Sections ─────────────────────────────────────────────────────────────
    for (const { cols, line } of parsed.SECTION) {
      // SECTION, id, name, A, Iz, Iy, J, Avy, Avz, kappay, kappaz
      if (cols.length < 11) { errors.push(`${t('Línea')} ${line}: ${t('SECTION necesita 11 columnas')}`); continue; }
      const [, id, name, A, Iz, Iy, J, Avy, Avz, kappay, kappaz] = cols;
      const obj = { id: +id, name, A: +A, Iz: +Iz, Iy: +Iy, J: +J,
                    Avy: +Avy, Avz: +Avz, kappay: +kappay, kappaz: +kappaz };
      if (isNaN(obj.id)) { errors.push(`${t('Línea')} ${line}: ${t('ID inválido en SECTION')}`); continue; }
      model.sections.set(obj.id, obj);
      if (obj.id > model._cnt.sections) model._cnt.sections = obj.id;
    }

    // ── Nodes ─────────────────────────────────────────────────────────────────
    for (const { cols, line } of parsed.NODE) {
      // NODE, id, x, y, z, ux, uy, uz, rx, ry, rz
      if (cols.length < 5) { errors.push(`${t('Línea')} ${line}: ${t('NODE necesita al menos 5 columnas')}`); continue; }
      const [, id, x, y, z, ux=0, uy=0, uz=0, rx=0, ry=0, rz=0] = cols;
      const obj = {
        id: +id, x: +x, y: +y, z: +z,
        restraints: { ux: +ux, uy: +uy, uz: +uz, rx: +rx, ry: +ry, rz: +rz }
      };
      if (isNaN(obj.id) || isNaN(obj.x) || isNaN(obj.y) || isNaN(obj.z)) {
        errors.push(`${t('Línea')} ${line}: ${t('coordenadas inválidas en NODE')}`); continue;
      }
      model.nodes.set(obj.id, obj);
      if (obj.id > model._cnt.nodes) model._cnt.nodes = obj.id;
    }

    // ── Elements ──────────────────────────────────────────────────────────────
    for (const { cols, line } of parsed.ELEMENT) {
      // ELEMENT, id, n1, n2, mat_id, sec_id[, r0..r11]
      if (cols.length < 6) { errors.push(`${t('Línea')} ${line}: ${t('ELEMENT necesita 6 columnas')}`); continue; }
      const [, id, n1, n2, matId, secId, ...relCols] = cols;
      const releases = Array(12).fill(0);
      for (let i = 0; i < Math.min(relCols.length, 12); i++) releases[i] = +relCols[i] || 0;
      const obj = { id: +id, n1: +n1, n2: +n2, matId: +matId, secId: +secId, releases };
      if (!model.nodes.has(obj.n1)) { errors.push(`${t('Línea')} ${line}: ${t('nodo')} n1=${obj.n1} ${t('no existe')}`); continue; }
      if (!model.nodes.has(obj.n2)) { errors.push(`${t('Línea')} ${line}: ${t('nodo')} n2=${obj.n2} ${t('no existe')}`); continue; }
      model.elements.set(obj.id, obj);
      if (obj.id > model._cnt.elements) model._cnt.elements = obj.id;
    }

    // ── Diaphragms ────────────────────────────────────────────────────────────
    for (const { cols, line } of parsed.DIAPHRAGM) {
      if (cols.length < 10) { errors.push(`${t('Línea')} ${line}: ${t('DIAPHRAGM necesita 10 columnas')}`); continue; }
      const [, id, z, nodesList, cmx, cmy, massM, massIcm, ex, ey] = cols;
      const nodes = nodesList.split(';').map(n => +n.trim()).filter(n => !isNaN(n));
      const obj = {
        id: +id, z: +z, nodes,
        cm: { x: +cmx, y: +cmy },
        mass: { m: +massM, Icm: +massIcm },
        eccentricity: { ex: +ex, ey: +ey }
      };
      model.diaphragms.set(obj.id, obj);
      if (obj.id > model._cnt.diaphragms) model._cnt.diaphragms = obj.id;
    }

    // ── Load Cases ────────────────────────────────────────────────────────────
    for (const { cols, line } of parsed.LOAD_CASE) {
      // LOAD_CASE, id, name[, self_weight 1/0][, tipo static/spectrum][, dir X/Y]
      if (cols.length < 3) { errors.push(`${t('Línea')} ${line}: ${t('LOAD_CASE necesita 3 columnas')}`); continue; }
      const [, id, name, sw, tipo, dir] = cols;
      if (isNaN(+id)) { errors.push(`${t('Línea')} ${line}: ${t('ID inválido en LOAD_CASE')}`); continue; }
      const isSpec = (tipo || '').trim().toLowerCase() === 'spectrum';
      const lc = {
        id: +id, name: name || `LC${id}`, loads: [],
        selfWeight: +sw === 1 && !isSpec,
        type: isSpec ? 'spectrum' : 'static',
        specDir: isSpec ? ((dir || 'X').trim().toUpperCase() === 'Y' ? 'Y' : 'X') : null,
      };
      model.loadCases.set(lc.id, lc);
      if (lc.id > model._cnt.loadCases) model._cnt.loadCases = lc.id;
    }

    // ── Nodal Loads ───────────────────────────────────────────────────────────
    for (const { cols, line } of parsed.LOAD_NODAL) {
      // LOAD_NODAL, lc_id, node_id, Fx, Fy, Fz, Mx, My, Mz
      if (cols.length < 9) { errors.push(`${t('Línea')} ${line}: ${t('LOAD_NODAL necesita 9 columnas')}`); continue; }
      const [, lcId, nodeId, Fx, Fy, Fz, Mx, My, Mz] = cols;
      const lc = model.loadCases.get(+lcId);
      if (!lc) { errors.push(`${t('Línea')} ${line}: ${t('caso de carga')} ${lcId} ${t('no existe')}`); continue; }
      if (!model.nodes.has(+nodeId)) { errors.push(`${t('Línea')} ${line}: ${t('nodo')} ${nodeId} ${t('no existe')}`); continue; }
      lc.loads.push({ type: 'nodal', nodeId: +nodeId, F: [+Fx, +Fy, +Fz, +Mx, +My, +Mz] });
    }

    // ── Distributed Loads ─────────────────────────────────────────────────────
    for (const { cols, line } of parsed.LOAD_DIST) {
      // LOAD_DIST, lc_id, elem_id, dir, w [, w2]   (w2 opcional → trapecial)
      if (cols.length < 5) { errors.push(`${t('Línea')} ${line}: ${t('LOAD_DIST necesita 5 columnas')}`); continue; }
      const [, lcId, elemId, dir, w, w2] = cols;
      const lc = model.loadCases.get(+lcId);
      if (!lc) { errors.push(`${t('Línea')} ${line}: ${t('caso de carga')} ${lcId} ${t('no existe')}`); continue; }
      if (!model.elements.has(+elemId)) { errors.push(`${t('Línea')} ${line}: ${t('elemento')} ${elemId} ${t('no existe')}`); continue; }
      const load = { type: 'dist', elemId: +elemId, dir: dir || 'gravity', w: +w };
      if (w2 != null && w2 !== '' && isFinite(+w2)) load.w2 = +w2;
      lc.loads.push(load);
    }

    // ── Node Masses ───────────────────────────────────────────────────────────
    for (const { cols, line } of parsed.NODE_MASS) {
      // NODE_MASS, node_id, mx, my, mz [, irx, iry, irz]  (las rotacionales son opcionales)
      if (cols.length < 5) { errors.push(`${t('Línea')} ${line}: ${t('NODE_MASS necesita al menos 5 columnas')}`); continue; }
      const [, nodeId, mx, my, mz, irx, iry, irz] = cols;
      const node = model.nodes.get(+nodeId);
      if (!node) { errors.push(`${t('Línea')} ${line}: ${t('nodo')} ${nodeId} ${t('no existe')}`); continue; }
      node.nodeMass = { mx: +mx, my: +my, mz: +mz, irx: +(irx || 0), iry: +(iry || 0), irz: +(irz || 0) };
    }

    // ── Node Springs (elastic supports) ───────────────────────────────────────
    for (const { cols, line } of parsed.NODE_SPRING) {
      // NODE_SPRING, node_id, kux, kuy, kuz, krx, kry, krz
      if (cols.length < 8) { errors.push(`${t('Línea')} ${line}: ${t('NODE_SPRING necesita 8 columnas')}`); continue; }
      const [, nodeId, kux, kuy, kuz, krx, kry, krz] = cols;
      const node = model.nodes.get(+nodeId);
      if (!node) { errors.push(`${t('Línea')} ${line}: ${t('nodo')} ${nodeId} ${t('no existe')}`); continue; }
      node.springs = { kux: +kux, kuy: +kuy, kuz: +kuz, krx: +krx, kry: +kry, krz: +krz };
    }

    // ── Combinations ──────────────────────────────────────────────────────────
    for (const { cols, line } of parsed.COMBINATION) {
      // COMBINATION, id, name, lc_id1, factor1[, lc_id2, factor2, ...]
      if (cols.length < 5) { errors.push(`${t('Línea')} ${line}: ${t('COMBINATION necesita al menos 5 columnas')}`); continue; }
      const [, id, name, ...rest] = cols;
      const factors = [];
      for (let i = 0; i + 1 < rest.length; i += 2) {
        factors.push({ lcId: +rest[i], factor: +rest[i + 1] });
      }
      const combo = { id: +id, name: name || `Combo ${id}`, factors };
      model.combinations.set(combo.id, combo);
      if (combo.id > model._cnt.combinations) model._cnt.combinations = combo.id;
    }

    return { model, errors };
  }

  // ══ CSV Template ══════════════════════════════════════════════════════════

  getTemplate() {
    return `# ══════════════════════════════════════════════════════════════
# PORTICO — Plantilla CSV v2.0
# Instrucciones:
#   1. Llene las filas de datos en Excel / Google Sheets
#   2. Exporte como CSV (separado por comas)
#   3. Use Archivo → Importar CSV en PORTICO
#   4. Las líneas que comienzan con # son ignoradas
#   5. El orden correcto: MATERIAL → SECTION → NODE → ELEMENT
#      → DIAPHRAGM → LOAD_CASE → LOAD_NODAL/LOAD_DIST → NODE_MASS → COMBINATION
# ══════════════════════════════════════════════════════════════

# ── MATERIALES ─────────────────────────────────────────────────
# TYPE,     ID,  nombre,           E (kN/m²),    G (kN/m²),    nu,    rho (ton/m³)
MATERIAL,    1,  Hormigón G30,     28700000,     11960000,     0.2,   2.5
MATERIAL,    2,  Acero A630-420H,  200000000,    77000000,     0.3,   7.85

# ── SECCIONES ──────────────────────────────────────────────────
# TYPE,    ID,  nombre,      A(m²),   Iz(m⁴),    Iy(m⁴),    J(m⁴),     Avy(m²),  Avz(m²),  κy,     κz
SECTION,   1,  Col 30x30,   0.09,    6.75e-4,   6.75e-4,   1.13e-4,   0.075,    0.075,    0.833,  0.833
SECTION,   2,  Viga 30x50,  0.15,    3.125e-3,  5.625e-4,  1.30e-4,   0.125,    0.075,    0.833,  0.833

# ── NODOS ──────────────────────────────────────────────────────
# TYPE, ID, X(m),  Y(m),  Z(m),  ux, uy, uz, rx, ry, rz   (1=fijo, 0=libre)
NODE,   1,  0.0,   0.0,   0.0,   1,  1,  1,  1,  1,  1
NODE,   2,  5.0,   0.0,   0.0,   1,  1,  1,  1,  1,  1
NODE,   3,  10.0,  0.0,   0.0,   1,  1,  1,  1,  1,  1
NODE,   4,  0.0,   0.0,   3.0,   0,  0,  0,  0,  0,  0
NODE,   5,  5.0,   0.0,   3.0,   0,  0,  0,  0,  0,  0
NODE,   6,  10.0,  0.0,   3.0,   0,  0,  0,  0,  0,  0
NODE,   7,  0.0,   0.0,   6.0,   0,  0,  0,  0,  0,  0
NODE,   8,  5.0,   0.0,   6.0,   0,  0,  0,  0,  0,  0
NODE,   9,  10.0,  0.0,   6.0,   0,  0,  0,  0,  0,  0

# ── ELEMENTOS ──────────────────────────────────────────────────
# TYPE,    ID, n1, n2, mat_id, sec_id[, r0, r1, r2, r3, r4, r5, r6, r7, r8, r9,r10,r11]
# DOF orden: [ux1,uy1,uz1,rx1,ry1,rz1, ux2,uy2,uz2,rx2,ry2,rz2]  1=libera  0=fijo
# Las columnas de liberacion son opcionales (default 0 = sin rotulas)
ELEMENT,   1,  1,  4,  1,      1
ELEMENT,   2,  2,  5,  1,      1
ELEMENT,   3,  3,  6,  1,      1
ELEMENT,   4,  4,  7,  1,      1
ELEMENT,   5,  5,  8,  1,      1
ELEMENT,   6,  6,  9,  1,      1
# Vigas con rotulas Mz en ambos extremos (viga simplemente apoyada):
# ELEMENT, 7,  4,  5,  1,      2,  0,0,0,0,0,1, 0,0,0,0,0,1
ELEMENT,   7,  4,  5,  1,      2
ELEMENT,   8,  5,  6,  1,      2
ELEMENT,   9,  7,  8,  1,      2
ELEMENT,  10,  8,  9,  1,      2

# ── DIAFRAGMAS (opcional) ──────────────────────────────────────
# TYPE,       ID, Z(m), nodos(sep;), cm_x, cm_y, masa(ton), Icm(ton·m²), ex(m), ey(m)
# DIAPHRAGM,  1,  3.0,  4;5;6,       5.0,  0.0,  50.0,       120.0,       0.05,  0.05
# DIAPHRAGM,  2,  6.0,  7;8;9,       5.0,  0.0,  50.0,       120.0,       0.05,  0.05

# ── CASOS DE CARGA ─────────────────────────────────────────────
# TYPE,       ID,  nombre,        peso_propio (1 = incluye peso propio de los elementos)
LOAD_CASE,    1,   Carga Muerta,  1
LOAD_CASE,    2,   Carga Viva,    0
LOAD_CASE,    3,   Sismo X,       0

# ── CARGAS NODALES ─────────────────────────────────────────────
# TYPE,        lc_id, node_id, Fx(kN),  Fy(kN),  Fz(kN),  Mx(kN·m), My(kN·m), Mz(kN·m)
# Fuerza horizontal en nodo 7 (sismo X en LC3):
LOAD_NODAL,    3,     7,       100.0,   0.0,     0.0,     0.0,      0.0,      0.0

# ── CARGAS DISTRIBUIDAS ────────────────────────────────────────
# TYPE,       lc_id, elem_id, dir,     w(kN/m)
# dir opciones: gravity (↓, w>0=abajo), globalZ (+Z), globalX (+X), globalY (+Y), localY, localZ
# Carga muerta en vigas del nivel 1 (LC1):
LOAD_DIST,    1,     7,       gravity, 25.0
LOAD_DIST,    1,     8,       gravity, 25.0
# Carga viva en vigas del nivel 2 (LC2):
LOAD_DIST,    2,     9,       gravity, 15.0
LOAD_DIST,    2,     10,      gravity, 15.0

# ── MASAS NODALES (para análisis modal sin diafragma) ──────────
# TYPE,      node_id, mx(ton), my(ton), mz(ton)
# NODE_MASS, 4,       5.0,     5.0,     0.0
# NODE_MASS, 5,       5.0,     5.0,     0.0
# NODE_MASS, 6,       5.0,     5.0,     0.0

# ── APOYOS ELÁSTICOS / RESORTES (opcional) ─────────────────────
# Rigidez de resorte en cada GDL global del nodo (0 = sin resorte).
# Útil para apoyos parciales: no marque la restricción rígida de ese GDL.
# TYPE,        node_id, kux(kN/m), kuy,   kuz,    krx(kN·m/rad), kry,  krz
# NODE_SPRING, 2,       0,         0,     50000,  0,             0,    0
# NODE_SPRING, 3,       0,         0,     0,      0,             8000, 0

# ── COMBINACIONES DE CARGA ─────────────────────────────────────
# TYPE,          ID, nombre,          lc_id1, factor1[, lc_id2, factor2, ...]
COMBINATION,     1,  1.2CM+1.6CV,     1,      1.2,      2,      1.6
COMBINATION,     2,  1.2CM+CV+Ex,     1,      1.2,      2,      1.0,      3,  1.0
`;
  }
}
