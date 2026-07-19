// performance_point.mjs — Tutorial 3: performance-based assessment (ASCE 41 / FEMA
// 440 coefficient method) laid over the pushover capacity curve from Tutorial 2.
// Computes the seismic weight from the model, the target displacement δt, and renders
// the capacity curve with δt and the IO/LS/CP performance bands.  node …/performance_point.mjs [es|en]
import fs from 'fs';
globalThis.window = globalThis; await import('../../lib/numeric.js'); globalThis.window.numeric = globalThis.numeric;
const { Serializer } = await import('../../js/model/serializer.js');
const { Portico } = await import('../../js/api/portico.js');
const lang = process.argv[2] || 'es';
const t = (es, en) => lang === 'en' ? en : es;

// capacity curve [δ(m), V(kN)] (origin prepended), from the Tutorial-2 pushover.
const PTS = [[0,0],[0.109,3562],[0.115,3736],[0.119,3836],[0.121,3865],[0.130,4020],
  [0.131,4034],[0.135,4084],[0.152,4250],[0.155,4274],[0.194,4541],[0.216,4660],
  [0.284,4771],[0.329,4834],[0.339,4846],[0.576,5064],[0.589,5075],[0.823,5228]];
const H = 17.5;                       // roof height (m)
const Vy = 3562, dy = 0.109;          // idealized yield (first significant yield)

// ── seismic weight from the model (self-weight + dead) ────────────────────────
const m = new Serializer().fromJSON(fs.readFileSync('examples/tutorial2_pushover.s3d','utf8'));
const p = new Portico(m);
const rG = await p.solveStatic(1, { selfWeight: true });     // case 1 = Gravedad (+ self-weight)
let W = 0; for (const n of m.nodes.values()) { const R = rG.getReaction?.(n.id); if (R) W += R[2]; }

// ── coefficient method (ASCE 41-17 §7.4.3 / FEMA 440) ─────────────────────────
const g = 9.80665;
// Effective period in the PUSH direction (X). The frame's lowest mode is a Y-sway
// (0.375 s), but the pushover — and thus this assessment — runs in X, whose modal
// period is 0.295 s (the W-columns present their major axis to X). Use that one.
const Te = 0.30;                      // effective period ≈ X-sway modal (0.295 s)
const SDS = 1.5, SD1 = 0.9;           // high-seismic design spectrum (g)
const Ts = SD1 / SDS;
const Sa = Te <= Ts ? SDS : SD1 / Te; // design spectral acceleration (g)
const C0 = 1.4;                       // MDOF→roof (ASCE 41 Table 7-5, 5 storeys)
const Cm = 0.9;                       // effective mass factor
const R = (Sa * g) / (Vy / (W / g)) * Cm;   // strength ratio  Sa / (Vy/W) · Cm
const a = 90;                         // site-class factor (class C)
const C1 = 1 + (R - 1) / (a * Te * Te);
const C2 = Te >= 0.7 ? 1 : 1 + (1 / 800) * ((R - 1) ** 2) / (Te * Te);
const SdSDOF = Sa * g * (Te / (2 * Math.PI)) ** 2;   // elastic SDOF spectral displacement (m)
const dt = C0 * C1 * C2 * SdSDOF;     // target roof displacement (m)

// performance-level roof-drift limits (steel MRF, ASCE 41): IO .7%, LS 2.5%, CP 5%
const LEVELS = [['IO', 0.007], ['LS', 0.025], ['CP', 0.050]].map(([n, r]) => ({ n, r, d: r * H }));
const level = dt < LEVELS[0].d ? '≤ IO' : dt < LEVELS[1].d ? 'IO–LS' : dt < LEVELS[2].d ? 'LS–CP' : '> CP';

console.log(`W=${W.toFixed(0)} kN  Sa=${Sa}g  R=${R.toFixed(2)}  C1=${C1.toFixed(3)} C2=${C2.toFixed(3)}`);
console.log(`δt=${(dt*1000).toFixed(0)} mm (drift ${(dt/H*100).toFixed(2)}%)  →  performance ${level}`);

// ── figure: capacity curve + δt + IO/LS/CP bands ──────────────────────────────
const Wt=640,Ht=400,ml=64,mr=20,mt=24,mb=48, xmax=0.9, ymax=5600;
const X=d=>ml+(d/xmax)*(Wt-ml-mr), Y=v=>Ht-mb-(v/ymax)*(Ht-mt-mb);
let s=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${Wt} ${Ht}" width="${Wt}" height="${Ht}"><rect width="${Wt}" height="${Ht}" fill="#fff"/>`;
// performance bands
const bandCol=['#dcfce7','#fef9c3','#fee2e2']; let prev=0;
LEVELS.forEach((L,i)=>{ s+=`<rect x="${X(prev)}" y="${mt}" width="${X(L.d)-X(prev)}" height="${Ht-mb-mt}" fill="${bandCol[i]}" opacity="0.6"/>`;
  s+=`<text x="${(X(prev)+X(L.d))/2}" y="${mt+14}" font-family="Segoe UI,Arial" font-size="11" fill="#475569" text-anchor="middle">${L.n}</text>`; prev=L.d; });
for(let v=0;v<=5000;v+=1000){const y=Y(v);s+=`<line x1="${ml}" y1="${y}" x2="${Wt-mr}" y2="${y}" stroke="#e2e8f0"/><text x="${ml-8}" y="${y+4}" font-family="Segoe UI,Arial" font-size="11" fill="#475569" text-anchor="end">${v}</text>`;}
for(let d=0;d<=0.8+1e-9;d+=0.2){const x=X(d);s+=`<text x="${x}" y="${Ht-mb+16}" font-family="Segoe UI,Arial" font-size="11" fill="#475569" text-anchor="middle">${d.toFixed(1)}</text>`;}
s+=`<line x1="${ml}" y1="${mt}" x2="${ml}" y2="${Ht-mb}" stroke="#94a3b8"/><line x1="${ml}" y1="${Ht-mb}" x2="${Wt-mr}" y2="${Ht-mb}" stroke="#94a3b8"/>`;
s+=`<text x="${(ml+Wt-mr)/2}" y="${Ht-8}" font-family="Segoe UI,Arial" font-size="12" fill="#334155" text-anchor="middle">${t('Desplazamiento de techo δ (m)','Roof displacement δ (m)')}</text>`;
s+=`<text x="16" y="${(mt+Ht-mb)/2}" font-family="Segoe UI,Arial" font-size="12" fill="#334155" text-anchor="middle" transform="rotate(-90 16 ${(mt+Ht-mb)/2})">${t('Cortante basal V (kN)','Base shear V (kN)')}</text>`;
s+=`<polyline points="${PTS.map(([d,v])=>`${X(d).toFixed(1)},${Y(v).toFixed(1)}`).join(' ')}" fill="none" stroke="#2563eb" stroke-width="2.5"/>`;
// target-displacement marker (vertical line + point on the curve)
const Vt=(()=>{ for(let i=1;i<PTS.length;i++){ if(PTS[i][0]>=dt){ const[[d0,v0],[d1,v1]]=[PTS[i-1],PTS[i]]; return v0+(v1-v0)*(dt-d0)/(d1-d0); } } return PTS[PTS.length-1][1]; })();
s+=`<line x1="${X(dt)}" y1="${mt}" x2="${X(dt)}" y2="${Ht-mb}" stroke="#7c3aed" stroke-width="1.5" stroke-dasharray="4 3"/>`;
s+=`<circle cx="${X(dt)}" cy="${Y(Vt)}" r="5" fill="#7c3aed"/>`;
s+=`<text x="${X(dt)+8}" y="${Y(Vt)-8}" font-family="Segoe UI,Arial" font-size="11" fill="#6d28d9">${t('punto de desempeño','performance point')} δt=${(dt*1000).toFixed(0)} mm</text>`;
s+=`</svg>`;
fs.writeFileSync(`docs/tutorials/img/t3-01-performance.${lang==='en'?'en.':''}svg`, s, 'utf8');
console.log('✓ performance figure ('+lang+')');
