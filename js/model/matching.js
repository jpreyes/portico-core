// ──────────────────────────────────────────────────────────────────────────────
// matching.js — MAXIMUM-WEIGHT MATCHING in general graphs (Edmonds/Blossom)
//
// Implementation of Edmonds' algorithm ("Blossom") for the maximum-weight matching
// in a NON-bipartite graph, in O(V³) time. It is the core of the "Blossom-type"
// triangle-to-quadrilateral recombination (#52): the triangles are the graph
// vertices, the adjacent pairs that form a good quad are the edges, and the weight is
// the quad quality → the optimal matching maximizes the global quality, not locally
// like greedy pairing.
//
// Faithful port of Joris van Rantwijk's algorithm (2008, public domain), the same one
// used by NetworkX and others. Works with INTEGER weights (scale them yourself: the
// dual arithmetic is exact this way). SELF-CONTAINED → verifiable in Node.
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Maximum-weight matching in a general graph.
 * @param {Array<[number,number,number]>} edges  edges [i, j, weight] (i≠j, integer weight)
 * @param {number} [nvertexHint=0]  minimum number of vertices (to include isolated vertices)
 * @param {boolean} [maxcardinality=false]  if true, maximizes cardinality first
 * @returns {Int32Array} mate, where mate[v] = vertex matched with v, or −1 if free.
 */
export function maxWeightMatching(edges, nvertexHint = 0, maxcardinality = false) {
  const nedge = edges.length;
  let nvertex = nvertexHint | 0;
  for (const [i, j] of edges) { if (i + 1 > nvertex) nvertex = i + 1; if (j + 1 > nvertex) nvertex = j + 1; }
  if (nvertex === 0) return new Int32Array(0);

  let maxweight = 0;
  for (const e of edges) if (e[2] > maxweight) maxweight = e[2];

  // endpoint[p] = vertex of endpoint p (edge k = ⌊p/2⌋, side p%2)
  const endpoint = new Array(2 * nedge);
  for (let p = 0; p < 2 * nedge; p++) endpoint[p] = edges[(p / 2) | 0][p & 1];

  // neighbend[v] = endpoints "p" such that endpoint[p] is a neighbor of v.
  const neighbend = Array.from({ length: nvertex }, () => []);
  for (let k = 0; k < nedge; k++) { const [i, j] = edges[k]; neighbend[i].push(2 * k + 1); neighbend[j].push(2 * k); }

  const mate = new Int32Array(nvertex).fill(-1);
  const label = new Int32Array(2 * nvertex);                 // 0 free, 1 S, 2 T, 5 marked
  const labelend = new Int32Array(2 * nvertex).fill(-1);
  const inblossom = new Int32Array(nvertex);
  for (let i = 0; i < nvertex; i++) inblossom[i] = i;
  const blossomparent = new Int32Array(2 * nvertex).fill(-1);
  const blossomchilds = new Array(2 * nvertex).fill(null);
  const blossombase = new Int32Array(2 * nvertex).fill(-1);
  for (let i = 0; i < nvertex; i++) blossombase[i] = i;
  const blossomendps = new Array(2 * nvertex).fill(null);
  const bestedge = new Int32Array(2 * nvertex).fill(-1);
  const blossombestedges = new Array(2 * nvertex).fill(null);
  const unusedblossoms = [];
  for (let i = nvertex; i < 2 * nvertex; i++) unusedblossoms.push(i);
  const dualvar = new Float64Array(2 * nvertex);
  for (let i = 0; i < nvertex; i++) dualvar[i] = maxweight;
  const allowedge = new Array(nedge).fill(false);
  let queue = [];

  const slack = (k) => { const e = edges[k]; return dualvar[e[0]] + dualvar[e[1]] - 2 * e[2]; };

  function blossomLeaves(b, out) {
    if (b < nvertex) out.push(b);
    else for (const t of blossomchilds[b]) { if (t < nvertex) out.push(t); else blossomLeaves(t, out); }
    return out;
  }

  function assignLabel(w, t, p) {
    const b = inblossom[w];
    label[w] = label[b] = t;
    labelend[w] = labelend[b] = p;
    bestedge[w] = bestedge[b] = -1;
    if (t === 1) { for (const leaf of blossomLeaves(b, [])) queue.push(leaf); }
    else if (t === 2) { const base = blossombase[b]; assignLabel(endpoint[mate[base]], 1, mate[base] ^ 1); }
  }

  function scanBlossom(v, w) {
    const path = [];
    let base = -1;
    while (v !== -1 || w !== -1) {
      let b = inblossom[v];
      if (label[b] & 4) { base = blossombase[b]; break; }
      path.push(b);
      label[b] = 5;
      if (labelend[b] === -1) v = -1;
      else { v = endpoint[labelend[b]]; b = inblossom[v]; v = endpoint[labelend[b]]; }
      if (w !== -1) { const tmp = v; v = w; w = tmp; }
    }
    for (const bb of path) label[bb] = 1;
    return base;
  }

  function addBlossom(base, k) {
    let v = edges[k][0], w = edges[k][1];
    const bb = inblossom[base];
    let bv = inblossom[v], bw = inblossom[w];
    const b = unusedblossoms.pop();
    blossombase[b] = base;
    blossomparent[b] = -1;
    blossomparent[bb] = b;
    const path = []; const endps = [];
    blossomchilds[b] = path; blossomendps[b] = endps;
    while (bv !== bb) {
      blossomparent[bv] = b;
      path.push(bv); endps.push(labelend[bv]);
      v = endpoint[labelend[bv]]; bv = inblossom[v];
    }
    path.push(bb); path.reverse(); endps.reverse(); endps.push(2 * k);
    while (bw !== bb) {
      blossomparent[bw] = b;
      path.push(bw); endps.push(labelend[bw] ^ 1);
      w = endpoint[labelend[bw]]; bw = inblossom[w];
    }
    label[b] = 1; labelend[b] = labelend[bb]; dualvar[b] = 0;
    for (const leaf of blossomLeaves(b, [])) { if (label[inblossom[leaf]] === 2) queue.push(leaf); inblossom[leaf] = b; }
    const bestedgeto = new Int32Array(2 * nvertex).fill(-1);
    for (const bvv of path) {
      let nblists;
      if (blossombestedges[bvv] === null) { nblists = blossomLeaves(bvv, []).map(vv => neighbend[vv].map(p => (p / 2) | 0)); }
      else nblists = [blossombestedges[bvv]];
      for (const nblist of nblists) for (const kk of nblist) {
        let i = edges[kk][0], j = edges[kk][1];
        if (inblossom[j] === b) { const tmp = i; i = j; j = tmp; }
        const bj = inblossom[j];
        if (bj !== b && label[bj] === 1 && (bestedgeto[bj] === -1 || slack(kk) < slack(bestedgeto[bj]))) bestedgeto[bj] = kk;
      }
      blossombestedges[bvv] = null; bestedge[bvv] = -1;
    }
    const bbe = []; for (let i = 0; i < bestedgeto.length; i++) if (bestedgeto[i] !== -1) bbe.push(bestedgeto[i]);
    blossombestedges[b] = bbe;
    bestedge[b] = -1;
    for (const kk of bbe) if (bestedge[b] === -1 || slack(kk) < slack(bestedge[b])) bestedge[b] = kk;
  }

  function expandBlossom(b, endstage) {
    for (const s of blossomchilds[b]) {
      blossomparent[s] = -1;
      if (s < nvertex) inblossom[s] = s;
      else if (endstage && dualvar[s] === 0) expandBlossom(s, endstage);
      else for (const vv of blossomLeaves(s, [])) inblossom[vv] = s;
    }
    if (!endstage && label[b] === 2) {
      const entrychild = inblossom[endpoint[labelend[b] ^ 1]];
      let j = blossomchilds[b].indexOf(entrychild);
      let jstep, endptrick;
      if (j & 1) { j -= blossomchilds[b].length; jstep = 1; endptrick = 0; }
      else { jstep = -1; endptrick = 1; }
      let p = labelend[b];
      while (j !== 0) {
        label[endpoint[p ^ 1]] = 0;
        label[endpoint[blossomendps[b][wrap(j - endptrick, blossomchilds[b].length)] ^ endptrick ^ 1]] = 0;
        assignLabel(endpoint[p ^ 1], 2, p);
        allowedge[(blossomendps[b][wrap(j - endptrick, blossomchilds[b].length)] / 2) | 0] = true;
        j += jstep;
        p = blossomendps[b][wrap(j - endptrick, blossomchilds[b].length)] ^ endptrick;
        allowedge[(p / 2) | 0] = true;
        j += jstep;
      }
      let bv = blossomchilds[b][wrap(j, blossomchilds[b].length)];
      label[endpoint[p ^ 1]] = label[bv] = 2;
      labelend[endpoint[p ^ 1]] = labelend[bv] = p;
      bestedge[bv] = -1;
      j += jstep;
      while (blossomchilds[b][wrap(j, blossomchilds[b].length)] !== entrychild) {
        bv = blossomchilds[b][wrap(j, blossomchilds[b].length)];
        if (label[bv] === 1) { j += jstep; continue; }
        let vv = -1;
        for (const leaf of blossomLeaves(bv, [])) { if (label[leaf] !== 0) { vv = leaf; break; } }
        if (vv !== -1) {
          label[vv] = 0;
          label[endpoint[mate[blossombase[bv]]]] = 0;
          assignLabel(vv, 2, labelend[vv]);
        }
        j += jstep;
      }
    }
    label[b] = labelend[b] = -1;
    blossomchilds[b] = blossomendps[b] = null;
    blossombase[b] = -1;
    blossombestedges[b] = null;
    bestedge[b] = -1;
    unusedblossoms.push(b);
  }

  function augmentBlossom(b, v) {
    let t = v;
    while (blossomparent[t] !== b) t = blossomparent[t];
    if (t >= nvertex) augmentBlossom(t, v);
    const len = blossomchilds[b].length;
    let i = blossomchilds[b].indexOf(t), j = i, jstep, endptrick;
    if (i & 1) { j -= len; jstep = 1; endptrick = 0; }
    else { jstep = -1; endptrick = 1; }
    while (j !== 0) {
      j += jstep;
      t = blossomchilds[b][wrap(j, len)];
      const p = blossomendps[b][wrap(j - endptrick, len)] ^ endptrick;
      if (t >= nvertex) augmentBlossom(t, endpoint[p]);
      j += jstep;
      t = blossomchilds[b][wrap(j, len)];
      if (t >= nvertex) augmentBlossom(t, endpoint[p ^ 1]);
      mate[endpoint[p]] = p ^ 1;
      mate[endpoint[p ^ 1]] = p;
    }
    blossomchilds[b] = blossomchilds[b].slice(i).concat(blossomchilds[b].slice(0, i));
    blossomendps[b] = blossomendps[b].slice(i).concat(blossomendps[b].slice(0, i));
    blossombase[b] = blossombase[blossomchilds[b][0]];
  }

  function augmentMatching(k) {
    const v = edges[k][0], w = edges[k][1];
    for (const [s0, p0] of [[v, 2 * k + 1], [w, 2 * k]]) {
      let s = s0, p = p0;
      while (true) {
        const bs = inblossom[s];
        if (bs >= nvertex) augmentBlossom(bs, s);
        mate[s] = p;
        if (labelend[bs] === -1) break;
        const t = endpoint[labelend[bs]];
        const bt = inblossom[t];
        s = endpoint[labelend[bt]];
        const jj = endpoint[labelend[bt] ^ 1];
        if (bt >= nvertex) augmentBlossom(bt, jj);
        mate[jj] = labelend[bt];
        p = labelend[bt] ^ 1;
      }
    }
  }

  const wrap = (x, n) => ((x % n) + n) % n;   // circular index (j may be negative)

  for (let t = 0; t < nvertex; t++) {
    label.fill(0);
    bestedge.fill(-1);
    for (let i = nvertex; i < 2 * nvertex; i++) blossombestedges[i] = null;
    allowedge.fill(false);
    queue = [];
    for (let v = 0; v < nvertex; v++) if (mate[v] === -1 && label[inblossom[v]] === 0) assignLabel(v, 1, -1);

    let augmented = false;
    while (true) {
      while (queue.length && !augmented) {
        const v = queue.pop();
        for (const p of neighbend[v]) {
          const k = (p / 2) | 0;
          const w = endpoint[p];
          if (inblossom[v] === inblossom[w]) continue;
          let kslack = 0;
          if (!allowedge[k]) { kslack = slack(k); if (kslack <= 0) allowedge[k] = true; }
          if (allowedge[k]) {
            if (label[inblossom[w]] === 0) assignLabel(w, 2, p ^ 1);
            else if (label[inblossom[w]] === 1) {
              const base = scanBlossom(v, w);
              if (base >= 0) addBlossom(base, k);
              else { augmentMatching(k); augmented = true; break; }
            } else if (label[w] === 0) { label[w] = 2; labelend[w] = p ^ 1; }
          } else if (label[inblossom[w]] === 1) {
            const b = inblossom[v];
            if (bestedge[b] === -1 || kslack < slack(bestedge[b])) bestedge[b] = k;
          } else if (label[w] === 0) {
            if (bestedge[w] === -1 || kslack < slack(bestedge[w])) bestedge[w] = k;
          }
        }
      }
      if (augmented) break;

      let deltatype = -1, delta = 0, deltaedge = -1, deltablossom = -1;
      if (!maxcardinality) {
        deltatype = 1; let mn = Infinity;
        for (let v = 0; v < nvertex; v++) mn = Math.min(mn, dualvar[v]);
        delta = Math.max(0, mn);
      }
      for (let v = 0; v < nvertex; v++) {
        if (label[inblossom[v]] === 0 && bestedge[v] !== -1) {
          const d = slack(bestedge[v]);
          if (deltatype === -1 || d < delta) { delta = d; deltatype = 2; deltaedge = bestedge[v]; }
        }
      }
      for (let b = 0; b < 2 * nvertex; b++) {
        if (blossomparent[b] === -1 && label[b] === 1 && bestedge[b] !== -1) {
          const d = slack(bestedge[b]) / 2;
          if (deltatype === -1 || d < delta) { delta = d; deltatype = 3; deltaedge = bestedge[b]; }
        }
      }
      for (let b = nvertex; b < 2 * nvertex; b++) {
        if (blossombase[b] >= 0 && blossomparent[b] === -1 && label[b] === 2 && (deltatype === -1 || dualvar[b] < delta)) {
          delta = dualvar[b]; deltatype = 4; deltablossom = b;
        }
      }
      if (deltatype === -1) { deltatype = 1; let mn = Infinity; for (let v = 0; v < nvertex; v++) mn = Math.min(mn, dualvar[v]); delta = Math.max(0, mn); }

      for (let v = 0; v < nvertex; v++) {
        if (label[inblossom[v]] === 1) dualvar[v] -= delta;
        else if (label[inblossom[v]] === 2) dualvar[v] += delta;
      }
      for (let b = nvertex; b < 2 * nvertex; b++) {
        if (blossombase[b] >= 0 && blossomparent[b] === -1) {
          if (label[b] === 1) dualvar[b] += delta;
          else if (label[b] === 2) dualvar[b] -= delta;
        }
      }

      if (deltatype === 1) break;
      else if (deltatype === 2) { allowedge[deltaedge] = true; let i = edges[deltaedge][0], j = edges[deltaedge][1]; if (label[inblossom[i]] === 0) { const tmp = i; i = j; j = tmp; } queue.push(i); }
      else if (deltatype === 3) { allowedge[deltaedge] = true; queue.push(edges[deltaedge][0]); }
      else if (deltatype === 4) expandBlossom(deltablossom, false);
    }

    if (!augmented) break;

    for (let b = nvertex; b < 2 * nvertex; b++) {
      if (blossomparent[b] === -1 && blossombase[b] >= 0 && label[b] === 1 && dualvar[b] === 0) expandBlossom(b, true);
    }
  }

  // During the algorithm mate[v] holds the ENDPOINT of the matched edge; we
  // translate it to the remote vertex to return the matching as mate[v] = neighbor.
  for (let v = 0; v < nvertex; v++) if (mate[v] >= 0) mate[v] = endpoint[mate[v]];
  return mate;
}
