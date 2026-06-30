// Timoshenko beam element — analytical contrast at the ELEMENT level. The beam is
// only exercised indirectly (full models, global equilibrium) elsewhere; this probes
// the convention-sensitive internals directly, the way a wrong local-axis transform,
// a sign clash between the two bending planes, a bad fixed-end force or a faulty hinge
// condensation would hide behind a globally-balanced model.
import { localAxes, stiffnessMatrix, transformMatrix, globalStiffness, massMatrix,
         fixedEndForces, applyReleases, condenseFEF } from './js/solver/timoshenko.js';

const E = 2.1e11, G = 8.0e10, nu = E/(2*G)-1;
let failures = 0;
const check = (cond, msg, extra='') => { console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${msg}${extra ? '  '+extra : ''}`); if (!cond) failures++; };
const rel = (a, b) => Math.abs(a-b)/Math.abs(b);

// solve K x = f for a free DOF set (dense Gauss)
function solve(K, f, n) {
  const M = K.map(r => r.slice()), x = f.slice();
  for (let k=0;k<n;k++){ let p=k; for(let i=k+1;i<n;i++) if(Math.abs(M[i][k])>Math.abs(M[p][k]))p=i;
    [M[k],M[p]]=[M[p],M[k]];[x[k],x[p]]=[x[p],x[k]];
    for(let i=k+1;i<n;i++){const c=M[i][k]/M[k][k];for(let j=k;j<n;j++)M[i][j]-=c*M[k][j];x[i]-=c*x[k];}}
  for(let k=n-1;k>=0;k--){let s=x[k];for(let j=k+1;j<n;j++)s-=M[k][j]*x[j];x[k]=s/M[k][k];}
  return x;
}

// Cantilever: node1 fixed, node2 at p2; build global K, apply tip force F3 (3-vec) at
// node2 translations, return node2 displacement (6-vec).
function cantileverTip(p2, sec, F3, slender=true) {
  const n1 = { id:1, x:0, y:0, z:0 }, n2 = { id:2, x:p2[0], y:p2[1], z:p2[2] };
  const { ex, ey, ez, L } = localAxes(n1, n2);
  const Kl = stiffnessMatrix(L, { E, G }, sec);
  const T = transformMatrix(ex, ey, ez);
  const Kg = globalStiffness(Kl, T);
  // free DOFs = node2 (indices 6..11); fixed = node1
  const free = [6,7,8,9,10,11];
  const Kff = free.map(i => free.map(j => Kg[i][j]));
  const f = [F3[0], F3[1], F3[2], 0, 0, 0];
  const u = solve(Kff, f, 6);
  return { u, L, ex, ey, ez };
}

const A = 0.01, Iy = 8e-6, Iz = 8e-6, J = 1.2e-5;       // square-ish, Iy=Iz (isotropic bending)
const secStiff = { A, Iy, Iz, J, Avy: 1e30, Avz: 1e30 }; // Avy,Avz huge → Euler (no shear)
const L = 3.0, P = 1000;

// ── (1) Orientation invariance of a cantilever tip deflection ────────────────
// With Iy=Iz and no shear, the tip deflection under a transverse tip load is
// PL³/3EI regardless of the beam's orientation in space, and regardless of which
// transverse direction the load points. A wrong local-axis/transform breaks this.
console.log('── (1) Cantilever tip deflection PL³/3EI — orientation invariance ──');
const wEuler = P * L**3 / (3 * E * Iz);
// orientations: along X, Y, Z, a skew diagonal, and near-vertical (ref-vector switch)
const dirs = {
  'along X': [1,0,0], 'along Y': [0,1,0], 'along Z (vert)': [0,0,1],
  'diagonal': unit([1,1,1]), 'near-vert 1.5°': unit([Math.sin(1.5*Math.PI/180),0,Math.cos(1.5*Math.PI/180)]),
};
function unit(v){ const n=Math.hypot(...v); return v.map(x=>x/n); }
function anyPerp(d){ const t = Math.abs(d[2])<0.9 ? [0,0,1] : [1,0,0];
  const c = [d[1]*t[2]-d[2]*t[1], d[2]*t[0]-d[0]*t[2], d[0]*t[1]-d[1]*t[0]]; return unit(c); }
for (const [name, d] of Object.entries(dirs)) {
  const p2 = d.map(c => c*L);
  const load = anyPerp(d);                       // load perpendicular to the axis
  const { u } = cantileverTip(p2, secStiff, load.map(c => c*P));
  const defl = u[0]*load[0] + u[1]*load[1] + u[2]*load[2];   // deflection along load
  check(rel(defl, wEuler) < 1e-6, `${name.padEnd(15)} δ=${defl.toExponential(5)}`, `(PL³/3EI=${wEuler.toExponential(5)})`);
}

// ── (2) Timoshenko shear contribution (thick beam) ───────────────────────────
console.log('\n── (2) Shear deflection (Timoshenko): δ = PL³/3EI + PL/GAv ──');
const Av = 0.8 * A;
const secShear = { A, Iy, Iz, J, Avy: Av, Avz: Av };
const Lt = 1.0;                                  // short/thick → shear matters
const { u: ut } = cantileverTip([Lt,0,0], secShear, [0,0,P]);   // load along local y (global Z)
const wShear = P*Lt**3/(3*E*Iz) + P*Lt/(G*Av);
check(rel(ut[2], wShear) < 1e-6, `δ=${ut[2].toExponential(5)}`, `(analytic ${wShear.toExponential(5)})`);
check(ut[2] > P*Lt**3/(3*E*Iz), 'shear increases deflection vs Euler');

// ── (3) Torsion: twist = T·L/(G·J) ───────────────────────────────────────────
console.log('\n── (3) Torsion twist θ = TL/GJ ──');
const Tq = 500;
const { u: utw } = cantileverTip([L,0,0], secStiff, [0,0,0]);   // no force; apply torque manually
// rebuild with a torque about local x = global x: apply moment at DOF rx (index 9→ free idx 3)
{
  const n1={id:1,x:0,y:0,z:0}, n2={id:2,x:L,y:0,z:0};
  const { ex,ey,ez } = localAxes(n1,n2);
  const Kg = globalStiffness(stiffnessMatrix(L,{E,G},secStiff), transformMatrix(ex,ey,ez));
  const free=[6,7,8,9,10,11];
  const Kff=free.map(i=>free.map(j=>Kg[i][j]));
  const u = solve(Kff, [0,0,0,Tq,0,0], 6);
  const twist = Tq*L/(G*J);
  check(rel(u[3], twist) < 1e-9, `θx=${u[3].toExponential(5)}`, `(TL/GJ=${twist.toExponential(5)})`);
}

// ── (4) Fixed-end forces: fixed-fixed beam, both bending planes ───────────────
// Uniform load w: |end moment| = wL²/12, end shear = wL/2 (each end). The two
// transverse directions 'y' and 'z' must give consistent magnitudes (a relative
// sign bug between planes is the beam analog of the DKT convention clash).
console.log('\n── (4) Fixed-end forces (clamped-clamped), planes y & z ──');
const w = 2000;
for (const dir of ['y','z']) {
  const f = fixedEndForces(L, { dir, w });
  // shear DOFs: y→[1,7], z→[2,8]; moment DOFs: y→[5,11], z→[4,10]
  const [s1,s2] = dir==='y' ? [f[1],f[7]] : [f[2],f[8]];
  const [m1,m2] = dir==='y' ? [f[5],f[11]] : [f[4],f[10]];
  const Vexp = w*L/2, Mexp = w*L*L/12;
  check(rel(Math.abs(s1),Vexp)<1e-9 && rel(Math.abs(s2),Vexp)<1e-9, `dir ${dir}: |V|=wL/2`, `(${Math.abs(s1).toFixed(1)}, ${Vexp.toFixed(1)})`);
  check(rel(Math.abs(m1),Mexp)<1e-9 && rel(Math.abs(m2),Mexp)<1e-9, `dir ${dir}: |M|=wL²/12`, `(${Math.abs(m1).toFixed(1)}, ${Mexp.toFixed(1)})`);
  check(Math.abs(m1+m2) < 1e-6*Mexp || Math.sign(m1)!==Math.sign(m2), `dir ${dir}: end moments oppose (hogging both ends)`, '');
}
// triangular load 0→g: V1=3gL/20, V2=7gL/20, M1=gL²/30, M2=gL²/20
{
  const g = 3000, f = fixedEndForces(L, { dir:'y', w:0, w2:g });
  check(rel(Math.abs(f[1]), 3*g*L/20)<1e-9, `tri: V1=3gL/20`, `(${Math.abs(f[1]).toFixed(1)}, ${(3*g*L/20).toFixed(1)})`);
  check(rel(Math.abs(f[7]), 7*g*L/20)<1e-9, `tri: V2=7gL/20`, `(${Math.abs(f[7]).toFixed(1)}, ${(7*g*L/20).toFixed(1)})`);
  check(rel(Math.abs(f[5]), g*L*L/30)<1e-9, `tri: M1=gL²/30`);
  check(rel(Math.abs(f[11]), g*L*L/20)<1e-9, `tri: M2=gL²/20`);
  // global equilibrium of the FEF: ΣV = total load = gL/2
  check(rel(Math.abs(f[1])+Math.abs(f[7]), g*L/2)<1e-9, `tri: ΣV = gL/2 (equilibrium)`);
}

// ── (5) Moment release → propped cantilever fixed-end moment = wL²/8 ──────────
// A clamped-clamped beam with a hinge (rz release) at end j, under uniform load,
// has fixed-end moment wL²/8 at the clamped end i (vs wL²/12 without the hinge).
console.log('\n── (5) Hinge release: condensed FEM = wL²/8 (propped cantilever) ──');
{
  const Kl = stiffnessMatrix(L, { E, G }, secStiff);
  const rel12 = Array(12).fill(false); rel12[11] = true;   // release θz at node 2 (XY plane)
  const fef = fixedEndForces(L, { dir:'y', w });
  const fc = condenseFEF(Kl, rel12, fef);
  const Mi = Math.abs(fc[5]);
  check(rel(Mi, w*L*L/8) < 1e-9, `M_i (hinged far end) = wL²/8`, `(${Mi.toFixed(1)}, ${(w*L*L/8).toFixed(1)})`);
  check(Math.abs(fc[11]) < 1e-9, `M_j at the hinge = 0`);
  // released stiffness: θz2 row/col must be zero
  const Kr = applyReleases(Kl, rel12);
  const rowsum = Kr[11].reduce((s,v)=>s+Math.abs(v),0) + Kr.reduce((s,r)=>s+Math.abs(r[11]),0);
  check(rowsum < 1e-9, `released DOF row/col zeroed`);
}

// ── (6) Consistent mass: total translational mass = ρAL on each axis ─────────
console.log('\n── (6) Consistent mass: lumped row-sum = element mass ρAL ──');
{
  const rho = 7850, sec = { A, Iy, Iz, J };
  const Me = massMatrix(L, { E, G, rho }, sec);
  const mTot = rho*A*L;
  // sum of the translational block in each direction (u: 0,6 / v: 1,7 / w: 2,8)
  for (const [name, idx] of [['axial',[0,6]],['trans-y',[1,7]],['trans-z',[2,8]]]) {
    let s = 0; for (const i of idx) for (const j of idx) s += Me[i][j];
    // rotational coupling rows excluded → translational consistent mass sums to ρAL
    check(rel(s, mTot) < 1e-9, `${name} mass = ρAL`, `(${s.toFixed(3)}, ${mTot.toFixed(3)})`);
  }
}

console.log(`\n=== ${failures === 0 ? 'ALL OK' : failures + ' FAILURE(S)'} ===`);
process.exit(failures === 0 ? 0 : 1);
