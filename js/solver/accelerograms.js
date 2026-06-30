// ──────────────────────────────────────────────────────────────────────────────
// accelerograms.js — Accelerogram input for the time-history analysis (#48c).
//
// (1) PARSER of a pasted/loaded record: accepts two columns (t, a) or a single
//     column (a) with a given Δt. Returns { dt, a:Float64Array, n, dur }.
// (2) Generators of **synthetic** DEMO signals (clearly labeled as such — they are
//     NOT real records): Ricker pulse, harmonic and a synthetic earthquake
//     (band-limited noise with a Saragoni–Hart envelope). To use real records
//     (e.g. Llolleo/Constitución 2010) the user pastes or loads them as text (t a) —
//     they are not bundled since the digital series is not available.
//
// Acceleration unit: m/s² (if the record is in g, multiply by 9.81 with the dialog's
// scale factor).
// ──────────────────────────────────────────────────────────────────────────────

export const G = 9.80665;   // m/s² per g

// ── Text-to-record parser ─────────────────────────────────────────────────────
// `text`: rows with 1 or 2 numbers (separated by spaces, comma, tab or ;).
// One column → uses `dtFallback` (s). Two columns → (t, a) and Δt = median of Δt.
// Returns { ok, dt, a, n, dur, cols, note }.
export function parseAccelerogram(text, dtFallback = 0.01) {
  const rows = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^[#%/]/.test(line) || /[a-df-zA-DF-Z]/.test(line.replace(/[eE][+-]?\d/g, ''))) continue; // skip headers/text (keep E notation)
    const nums = line.split(/[\s,;]+/).map(Number).filter(v => Number.isFinite(v));
    if (nums.length) rows.push(nums);
  }
  if (rows.length < 2) return { ok: false, note: 'No se reconocieron ≥ 2 muestras numéricas.' };

  const cols = Math.min(...rows.map(r => r.length)) >= 2 ? 2 : 1;
  let dt, a;
  if (cols >= 2) {
    const t = rows.map(r => r[0]), av = rows.map(r => r[1]);
    const dts = []; for (let i = 1; i < t.length; i++) dts.push(t[i] - t[i - 1]);
    dts.sort((p, q) => p - q);
    dt = dts[Math.floor(dts.length / 2)] || dtFallback;   // median (robust to gaps)
    a = Float64Array.from(av);
  } else {
    dt = dtFallback;
    a = Float64Array.from(rows.map(r => r[0]));
  }
  if (!(dt > 0) || !isFinite(dt)) return { ok: false, note: 'Δt no válido.' };
  return { ok: true, dt, a, n: a.length, dur: (a.length - 1) * dt, cols };
}

// ── Record statistics ─────────────────────────────────────────────────────────
export function accStats(a, dt) {
  let pga = 0, sum2 = 0;
  for (const v of a) { const m = Math.abs(v); if (m > pga) pga = m; sum2 += v * v; }
  const rms = Math.sqrt(sum2 / a.length);
  // Arias intensity ≈ (π/2g)·∫a²dt
  const arias = Math.PI / (2 * G) * sum2 * dt;
  return { pga, rms, arias, dur: (a.length - 1) * dt, n: a.length };
}

// Scales a record to a target PGA (m/s²). Returns a copy.
export function scaleToPGA(a, targetPGA) {
  let pga = 0; for (const v of a) pga = Math.max(pga, Math.abs(v));
  const f = pga > 0 ? targetPGA / pga : 1;
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] * f;
  return out;
}

// ── Deterministic PRNG (mulberry32) for the reproducible synthetic earthquake ──
function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── DEMO generators (synthetic) ───────────────────────────────────────────────
// Ricker pulse (second derivative of the gaussian). fp = peak frequency [Hz].
export function ricker({ fp = 2, pga = 3, dt = 0.005, dur = 6 } = {}) {
  const n = Math.round(dur / dt) + 1, a = new Float64Array(n);
  const t0 = 1.0 / fp;   // centers the pulse
  for (let i = 0; i < n; i++) {
    const t = i * dt - t0, x = Math.PI * fp * t, x2 = x * x;
    a[i] = (1 - 2 * x2) * Math.exp(-x2);
  }
  return { name: `Pulso de Ricker (fp=${fp} Hz) · sintético`, dt, a: scaleToPGA(a, pga), synthetic: true };
}

// Harmonic with a smooth envelope (controlled resonance). freq [Hz].
export function harmonic({ freq = 1, pga = 2, dt = 0.005, dur = 12 } = {}) {
  const n = Math.round(dur / dt) + 1, a = new Float64Array(n), w = 2 * Math.PI * freq;
  for (let i = 0; i < n; i++) {
    const t = i * dt;
    const env = Math.min(1, t / 1.5) * Math.min(1, (dur - t) / 1.5);   // ramp in/out
    a[i] = Math.max(0, env) * Math.sin(w * t);
  }
  return { name: `Armónico (${freq} Hz) · sintético`, dt, a: scaleToPGA(a, pga), synthetic: true };
}

// Synthetic earthquake: band-limited noise with a Saragoni–Hart envelope (rise-
// plateau-decay). It is NOT a real record; it serves as a reproducible demo (seed).
export function syntheticSeismic({ pga = 3, dt = 0.01, dur = 20, seed = 12345 } = {}) {
  const n = Math.round(dur / dt) + 1, raw = new Float64Array(n), rnd = mulberry32(seed);
  // white noise → light smoothing (moving average) to limit the high band
  for (let i = 0; i < n; i++) raw[i] = rnd() * 2 - 1;
  const a = new Float64Array(n);
  const tRise = 0.15 * dur, tLevel = 0.45 * dur, decay = 2.5 / dur;
  for (let i = 0; i < n; i++) {
    const t = i * dt;
    let env;
    if (t < tRise) env = (t / tRise) ** 2;
    else if (t < tLevel) env = 1;
    else env = Math.exp(-decay * (t - tLevel) * 4);
    // 3-point smoothing
    const s = (raw[Math.max(0, i - 1)] + 2 * raw[i] + raw[Math.min(n - 1, i + 1)]) / 4;
    a[i] = env * s;
  }
  return { name: 'Sismo sintético (ruido de banda) · NO es un registro real', dt, a: scaleToPGA(a, pga), synthetic: true };
}

// Catalog of demo presets (for the dialog).
export const DEMO_PRESETS = {
  ricker:    () => ricker(),
  harmonic:  () => harmonic(),
  synthetic: () => syntheticSeismic(),
};
