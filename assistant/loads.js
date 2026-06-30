// ──────────────────────────────────────────────────────────────────────────────
// loads.js — code-prescribed load magnitudes from the project data + rules.json
//   · snowLoad  → pf, ps (kN/m²)
//   · windLoad → q (N/m²) and pressures by zone
//   · responseSpectrum    → elastic curve Sa(T) [g] + saFactor (g/R*) for PORTICO
// Pure ES module (Node + browser). No DOM. Deterministic and auditable.
// ──────────────────────────────────────────────────────────────────────────────

const G_GRAV = 9.80665; // m/s² (also kN per tonne-force)

// ── step-table / band helpers ─────────────────────────────────────────────────

/** Index of the "lo-hi" band (e.g. "38-42") that contains x; -1 if none. */
function rangeBandIndex(bandas, x) {
  for (let i = 0; i < bandas.length; i++) {
    const [lo, hi] = String(bandas[i]).split('-').map(parseFloat);
    if (x >= lo && (i === bandas.length - 1 ? x <= hi : x < hi)) return i;
  }
  return -1;
}

/** Altitude band key ("0-300"…">4000") that contains alt. */
function altitudeBand(porAltitud, alt) {
  for (const k of Object.keys(porAltitud)) {
    if (k.startsWith('>')) { if (alt >= parseFloat(k.slice(1))) return k; }
    else { const [lo, hi] = k.split('-').map(parseFloat); if (alt >= lo && alt < hi) return k; }
  }
  return null;
}

/** Lookup in a step table [[upperBoundExcl|null, val]] (last null = ∞). */
function stepLookup(tabla, x) {
  for (const [ub, val] of tabla) if (ub === null || x < ub) return val;
  return tabla[tabla.length - 1][1];
}

// ── SNOW (NCh431.Of2010) ──────────────────────────────────────────────────────

/**
 * @returns {object} { pg, Ce, Ct, I, Cs, pf, ps, _notas }  (kN/m²); pf/ps null si pg null.
 */
export function snowLoad(ficha, reglas) {
  const n = reglas?.loads?.snow;
  // Graceful degradation: if rules.json is the example template (or carries no snow
  // table), no snow load is computed instead of breaking.
  if (!n || !n.ground_snow_table) {
    return { pg: null, pf: null, ps: null, _notas: ['Sin tabla de nieve en rules.json (plantilla de ejemplo): reemplázala con la de tu código para calcular la carga de nieve.'] };
  }
  const ub = ficha.location || {};
  const lat = ub.latitude_deg, alt = ub.altitude_masl ?? 0;
  const notas = [];

  const t1 = n.ground_snow_table;
  const li = rangeBandIndex(t1.latitudes, lat);
  const ab = altitudeBand(t1.by_altitude_masl, alt);
  if (li < 0 || ab == null) return { pg: null, pf: null, ps: null, _notas: ['latitud/altitud fuera de la Tabla 1'] };
  const pg = t1.by_altitude_masl[ab][li];
  if (pg == null) notas.push(`Tabla 1 sin dato para lat ${lat}°, altitud ${alt} m (banda ${t1.latitudes[li]} / ${ab})`);

  // Factors: conservative defaults; the project data can refine them.
  const expo = ub.exposure || 'C';
  const proteccion = ficha.loads?.snow_protection || 'Parcialmente expuesto';
  const Ce = n.exposure_factor_table[expo]?.[proteccion] ?? 1.0;
  const Ct = n.thermal_factor_table['Todas las estructuras (salvo las siguientes)'] ?? 1.0;
  const cat = ficha.seismic?.category || ficha.occupancy_category || 'II';
  const I = n.importance_factor_table[cat] ?? 1.0;

  // Roof slope → Cs (ASCE form; VALIDATE Figure 1).
  const pend = ficha.geometry?.roof_slope_deg ?? 0;
  const csQuiebre = Ct >= 1.2 ? 45 : Ct >= 1.1 ? 37.5 : 30;
  const Cs = pend <= csQuiebre ? 1.0 : pend >= 70 ? 0 : (70 - pend) / (70 - csQuiebre);

  const pf = pg == null ? null : +(0.7 * Ce * Ct * I * pg).toFixed(4);
  const ps = pf == null ? null : +(Cs * pf).toFixed(4);
  return { pg, Ce, Ct, I, Cs: +Cs.toFixed(3), pf, ps, _notas: notas, _formula: 'pf=0.7·Ce·Ct·I·pg ; ps=Cs·pf' };
}

// ── WIND (NCh432.Of2010) ──────────────────────────────────────────────────────

/** Basic speed V (m/s): by station (city match) or by latitude band. */
function windSpeed(w, ub) {
  const ciudad = (ub.city || '').trim().toLowerCase();
  if (ciudad) {
    for (const [k, v] of Object.entries(w.basic_speed_m_s.by_station))
      if (k.toLowerCase() === ciudad) return { V: v, fuente: `estación ${k}` };
  }
  // latitude bands: upper bounds aligned to the array (robust to editing V)
  const lat = ub.latitude_deg;
  const ubExcl = [27, 35, 42, 50, Infinity];
  const arr = w.basic_speed_m_s.by_latitude;
  for (let i = 0; i < arr.length && i < ubExcl.length; i++)
    if (lat < ubExcl[i]) return { V: arr[i].V, fuente: `latitud ${arr[i].rango}` };
  return { V: arr[arr.length - 1].V, fuente: `latitud ${arr[arr.length - 1].rango}` };
}

/**
 * @param {number} h_techo  roof height (m)
 * @returns {object} { V, Kz, Kzt, Kd, I, q_Nm2, GCpi, presiones:{zone:p_Nm2}, _notas }
 */
export function windLoad(ficha, reglas, h_techo) {
  const w = reglas?.loads?.wind;
  // Graceful degradation with the example template (or without a wind table).
  if (!w || !w.exposure || !w.basic_speed_m_s || !w.gcpf_external_pressure) {
    return { V: null, q_Nm2: 0, presiones: {}, _notas: ['Sin tabla de viento en rules.json (plantilla de ejemplo): reemplázala con la de tu código para calcular la carga de viento.'] };
  }
  const ub = ficha.location || {};
  const expo = ub.exposure || 'C';
  const e = w.exposure[expo];
  const { V, fuente } = windSpeed(w, ub);

  const z = Math.max(h_techo, 4.6);
  const Kz = 2.01 * Math.pow(z / e.Zg_m, 2 / e.alfa);
  const Kzt = 1.0; // no topographic data in the project → flat terrain
  const Kd = w.kd_directionality['Edificio SPRFV'] ?? 0.85;
  const cat = ficha.seismic?.category || ficha.occupancy_category || 'II';
  const I = w.importance_factor[cat] ?? 1.0;
  const q = 0.613 * Kz * Kzt * Kd * V * V * I; // N/m²

  const cierre = ficha.loads?.wind_enclosure || 'Cerrado';
  const GCpi = w.gcpi_internal_pressure[cierre] ?? 0.18;

  // slope range for GCpf
  const pend = ficha.geometry?.roof_slope_deg ?? 0;
  const tr = pend < 5 ? 0 : pend < 20 ? 1 : pend < 45 ? 2 : 3;
  const presiones = {};
  for (const [zona, vals] of Object.entries(w.gcpf_external_pressure.zonas)) {
    const g = vals[tr];
    const a = q * (g - GCpi), b = q * (g + GCpi);
    presiones[zona] = +(Math.abs(a) > Math.abs(b) ? a : b).toFixed(2);
  }
  return {
    V, fuente_V: fuente, Kz: +Kz.toFixed(4), Kzt, Kd, I,
    q_Nm2: +q.toFixed(2), GCpi, cierre, tramo_pendiente: tr, presiones,
    _formula: 'q=0.613·Kz·Kzt·Kd·V²·I [N/m²] ; p=q·(GCpf−GCpi)',
    _notas: ['Kzt=1 (terreno plano: la ficha no trae topografía)'],
  };
}

// ── SEISMIC (NCh433/DS61) ─────────────────────────────────────────────────────

/** R* = 1 + T* / (0.10·To + T* / Ro), with T* from the modal analysis. */
export function Rstar(Tstar, To, Ro = 11.0) {
  return 1 + Tstar / (0.10 * To + Tstar / Ro);
}

/**
 * ELASTIC NCh433 design spectrum: Sa(T) = S·Ao·I·α(T) in g units.
 * The R* reduction (which needs T* from the modal) is applied as saFactor.
 * @returns {object} { curva:[{T,Sa}], texto, params, saFactor_nota, Rstar_formula }
 */
export function responseSpectrum(ficha, reglas, { Tmax = 3.0, dT = 0.02 } = {}) {
  const s = reglas?.loads?.seismic;
  if (!s || !s.soil_table || !s.zone_table_Ao_g) {
    throw new Error('Sin tabla sísmica en rules.json (plantilla de ejemplo): reemplázala con la de tu código para generar el espectro.');
  }
  const p = ficha.seismic || {};
  const def = s.default_params || {};
  const suelo = s.soil_table[p.soil];
  if (!suelo) throw new Error(`Clase de sitio / suelo no válido: "${p.soil}"`);
  const Ao = s.zone_table_Ao_g[String(p.zone)];
  if (Ao == null) throw new Error(`Zona sísmica no válida: ${p.zone}`);
  const I = s.category_table[p.category || 'II'] ?? 1.0;
  const { S, To, Tp, n: nn, p: pp } = suelo;

  const alpha = (T) => (1 + 4.5 * Math.pow(T / To, pp)) / (1 + Math.pow(T / To, 3));
  const curva = [];
  for (let T = 0; T <= Tmax + 1e-9; T += dT) {
    const Tr = +T.toFixed(4);
    curva.push({ T: Tr, Sa: +(S * Ao * I * alpha(Tr)).toFixed(6) });
  }
  const texto = curva.map((q) => `${q.T}\t${q.Sa}`).join('\n');
  const Ro = def.Ro ?? 11.0, R = p.R ?? def.R ?? 7.0;
  return {
    curva, texto,
    params: { S, Ao, I, To, Tp, n: nn, p: pp, Ro, R },
    Rstar_formula: 'R* = 1 + T*/(0.10·To + T*/Ro), con T* del modal',
    saFactor_nota: `Pegar la curva en F7; saFactor = ${G_GRAV.toFixed(5)}/R* (convierte g→m/s² y aplica R*). R* tras el modal con Rstar(T*, To=${To}, Ro=${Ro}).`,
  };
}
