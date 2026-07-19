// capacity_curve.mjs — render a pushover capacity curve (base shear vs roof
// displacement) as a standalone SVG for the tutorials. Points passed inline.
import fs from 'fs';
// [δ (m), V (kN)] — from the event-to-event pushover (origin prepended).
const PTS = [[0,0],[0.109,3562],[0.115,3736],[0.119,3836],[0.121,3865],[0.130,4020],
  [0.131,4034],[0.135,4084],[0.152,4250],[0.155,4274],[0.194,4541],[0.216,4660],
  [0.284,4771],[0.329,4834],[0.339,4846],[0.576,5064],[0.589,5075],[0.823,5228]];
const MARKS = [{i:1,label:'primera fluencia · 3562 kN @ 0.11 m',en:'first yield · 3562 kN @ 0.11 m'},
  {i:PTS.length-1,label:'colapso · 5228 kN @ 0.82 m',en:'collapse · 5228 kN @ 0.82 m'}];
const lang = process.argv[2] || 'es';
const W=640,H=400,ml=64,mr=20,mt=24,mb=48;
const xmax=0.9, ymax=5600;
const X=d=>ml+(d/xmax)*(W-ml-mr), Y=v=>H-mb-(v/ymax)*(H-mt-mb);
const t=(es,en)=>lang==='en'?en:es;
let s=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`;
s+=`<rect width="${W}" height="${H}" fill="#fff"/>`;
// grid + axes
for(let v=0;v<=5000;v+=1000){const y=Y(v);s+=`<line x1="${ml}" y1="${y}" x2="${W-mr}" y2="${y}" stroke="#e2e8f0"/><text x="${ml-8}" y="${y+4}" font-family="Segoe UI,Arial" font-size="11" fill="#475569" text-anchor="end">${v}</text>`;}
for(let d=0;d<=0.8+1e-9;d+=0.2){const x=X(d);s+=`<line x1="${x}" y1="${mt}" x2="${x}" y2="${H-mb}" stroke="#eef2f7"/><text x="${x}" y="${H-mb+16}" font-family="Segoe UI,Arial" font-size="11" fill="#475569" text-anchor="middle">${d.toFixed(1)}</text>`;}
s+=`<line x1="${ml}" y1="${mt}" x2="${ml}" y2="${H-mb}" stroke="#94a3b8"/><line x1="${ml}" y1="${H-mb}" x2="${W-mr}" y2="${H-mb}" stroke="#94a3b8"/>`;
// axis labels
s+=`<text x="${(ml+W-mr)/2}" y="${H-8}" font-family="Segoe UI,Arial" font-size="12" fill="#334155" text-anchor="middle">${t('Desplazamiento de techo δ (m)','Roof displacement δ (m)')}</text>`;
s+=`<text x="16" y="${(mt+H-mb)/2}" font-family="Segoe UI,Arial" font-size="12" fill="#334155" text-anchor="middle" transform="rotate(-90 16 ${(mt+H-mb)/2})">${t('Cortante basal V (kN)','Base shear V (kN)')}</text>`;
// curve
s+=`<polyline points="${PTS.map(([d,v])=>`${X(d).toFixed(1)},${Y(v).toFixed(1)}`).join(' ')}" fill="none" stroke="#2563eb" stroke-width="2.5"/>`;
// markers
for(const m of MARKS){const [d,v]=PTS[m.i];const x=X(d),y=Y(v);s+=`<circle cx="${x}" cy="${y}" r="4.5" fill="#ef4444"/>`;
  const tx=m.i<2?x+8:x-8,anc=m.i<2?'start':'end';
  s+=`<text x="${tx}" y="${y-8}" font-family="Segoe UI,Arial" font-size="10.5" fill="#b91c1c" text-anchor="${anc}">${t(m.label,m.en)}</text>`;}
s+=`</svg>`;
fs.writeFileSync(`docs/tutorials/img/t2-03-capacity-curve.${lang==='en'?'en.':''}svg`, s, 'utf8');
console.log('✓ capacity curve ('+lang+')');
