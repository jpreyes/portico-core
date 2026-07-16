"""run_case.py — solve a PORTICO .s3d model in OpenSees and dump the results as JSON.

This is a SECOND, INDEPENDENT translation of the .s3d model. It deliberately does NOT
go through PORTICO's own .tcl exporter (js/io/formats/opensees.js): validating a solver
against a model it exported itself would let a shared misunderstanding pass unnoticed.
Everything here is built straight from the .s3d JSON.

Formulation is matched to PORTICO on purpose, so a difference means a real difference:
  * ElasticTimoshenkoBeam    — PORTICO's frame element is shear-deformable (Avy/Avz).
                               elasticBeamColumn would be Euler-Bernoulli and would
                               carry a systematic 1/(1+Phi) error.
  * -cMass                   — PORTICO uses a consistent mass matrix; OpenSees defaults
                               to lumped.
  * local axes               — mirrors localAxes() in js/solver/timoshenko.js, same
                               VERT=0.9994 threshold and same cross-product order.

Scope: frame models (nodes, restraints, elastic materials/sections, beam elements,
nodal + uniform/trapezoidal distributed loads, self weight). Areas, springs, links,
diaphragms and releases are NOT translated — the runner refuses rather than solve a
model that silently differs.

Usage:
    python run_case.py <model.s3d> --analysis static --lc 1
    python run_case.py <model.s3d> --analysis modal --modes 6
"""
import argparse
import json
import math
import sys

import openseespy.opensees as ops

G_ACC = 9.80665

# Which OpenSees element(s) the last build() actually used — reported in the JSON so a
# reader never has to guess which formulation produced a number.
_ELEMENT_KIND = set()


# ── vector helpers ────────────────────────────────────────────────────────────
def _sub(a, b):
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]


def _norm(v):
    return math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])


def _unit(v):
    n = _norm(v)
    if n < 1e-12:
        raise ValueError('zero-length vector')
    return [v[0] / n, v[1] / n, v[2] / n]


def _cross(a, b):
    return [a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0]]


def _dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def local_axes(n1, n2):
    """Mirror of localAxes() in js/solver/timoshenko.js:26."""
    d = _sub([n2['x'], n2['y'], n2['z']], [n1['x'], n1['y'], n1['z']])
    L = _norm(d)
    if L < 1e-12:
        raise ValueError('zero-length element between nodes %s and %s' % (n1['id'], n2['id']))
    ex = _unit(d)
    VERT = 0.9994
    ref = [1.0, 0.0, 0.0] if abs(ex[2]) > VERT else [0.0, 0.0, 1.0]
    ez = _unit(_cross(ex, ref))
    ey = _cross(ez, ex)
    return ex, ey, ez, L


# ── model translation ─────────────────────────────────────────────────────────
DOFS = ['ux', 'uy', 'uz', 'rx', 'ry', 'rz']


def _refuse_unsupported(m):
    """Fail loudly on anything this translator does not model. A silent skip here
    would show up downstream as a phantom solver discrepancy."""
    problems = []
    if m.get('areas'):
        problems.append('%d area element(s)' % len(m['areas']))
    if m.get('links'):
        problems.append('%d link(s)' % len(m['links']))
    if m.get('diaphragms'):
        problems.append('%d diaphragm(s)' % len(m['diaphragms']))
    for e in m.get('elements', []):
        if any(e.get('releases') or []):
            problems.append('element %s has end releases' % e['id'])
        for k in ('rigidEnd', 'endSprings', 'foundation', 'cable', 'compressionOnly'):
            if e.get(k):
                problems.append('element %s has %s' % (e['id'], k))
    for n in m.get('nodes', []):
        for k in ('springK', 'springUni', 'soilSpring', 'prescDisp'):
            if n.get(k):
                problems.append('node %s has %s' % (n['id'], k))
        if any(v for v in (n.get('springs') or {}).values()):
            problems.append('node %s has springs' % n['id'])
    if problems:
        raise SystemExit('run_case.py cannot faithfully translate this model:\n  - '
                         + '\n  - '.join(problems)
                         + '\nRefusing rather than solving a model that differs silently.')


def build(m, lc_id=None, self_weight=False):
    _ELEMENT_KIND.clear()
    is2d = m.get('mode') == '2D'
    nodes = {n['id']: n for n in m['nodes']}
    mats = {x['id']: x for x in m['materials']}
    secs = {x['id']: x for x in m['sections']}

    ops.wipe()
    ops.model('basic', '-ndm', 3, '-ndf', 6)

    for n in m['nodes']:
        ops.node(int(n['id']), float(n['x']), float(n['y']), float(n['z']))
        r = dict(n.get('restraints') or {})
        if is2d:
            # Mirror App.runModal / runners.apply2D: planar X-Z models restrain uy, rx, rz.
            r['uy'], r['rx'], r['rz'] = 1, 1, 1
        ops.fix(int(n['id']), *[1 if r.get(d) else 0 for d in DOFS])

    for e in m['elements']:
        n1, n2 = nodes[e['n1']], nodes[e['n2']]
        mat, sec = mats[e['matId']], secs[e['secId']]
        ex, ey, ez, L = local_axes(n1, n2)
        tag = int(e['id'])
        # OpenSees builds y_local = vecxz x x_local; feeding PORTICO's ez reproduces
        # its ey, and z_local = ex x ey = ez. The triads coincide exactly.
        ops.geomTransf('Linear', tag, *[float(v) for v in ez])
        rho = float(mat.get('rho') or 0.0)
        Avy, Avz = float(sec['Avy']), float(sec['Avz'])
        # PORTICO reads Av <= 1e-30 as a SENTINEL for "no shear deformation":
        # timoshenko.js:75 sets Phi = 0 instead of dividing, so the element degrades to
        # Euler-Bernoulli. ElasticTimoshenkoBeam has no such sentinel and would divide by
        # zero, so the faithful translation of Av=0 is elasticBeamColumn.
        euler = Avy <= 1e-30 or Avz <= 1e-30
        if euler:
            args = ['elasticBeamColumn', tag, int(e['n1']), int(e['n2']),
                    float(sec['A']), float(mat['E']), float(mat['G']), float(sec['J']),
                    float(sec['Iy']), float(sec['Iz']), tag]
        else:
            args = ['ElasticTimoshenkoBeam', tag, int(e['n1']), int(e['n2']),
                    float(mat['E']), float(mat['G']), float(sec['A']), float(sec['J']),
                    float(sec['Iy']), float(sec['Iz']), Avy, Avz, tag]
        if rho > 0:
            # -cMass: consistent mass, to match PORTICO's massMatrix(); mass per length.
            args += ['-mass', rho * float(sec['A']), '-cMass']
        ops.element(*args)
        _ELEMENT_KIND.add('elasticBeamColumn' if euler else 'ElasticTimoshenkoBeam')

    if lc_id is None:
        return nodes

    lc = next((c for c in m['loadCases'] if c['id'] == lc_id), None)
    if lc is None:
        raise SystemExit('load case %r not found' % lc_id)

    ops.timeSeries('Linear', 1)
    ops.pattern('Plain', 1, 1)

    for ld in lc.get('loads', []):
        t = ld.get('type')
        if t == 'nodal':
            F = [float(v) for v in ld['F']]
            ops.load(int(ld['nodeId']), *F)
        elif t == 'dist':
            e = next(x for x in m['elements'] if x['id'] == ld['elemId'])
            n1, n2 = nodes[e['n1']], nodes[e['n2']]
            ex, ey, ez, L = local_axes(n1, n2)
            w = float(ld['w'])
            if ld.get('w2') is not None and float(ld['w2']) != w:
                raise SystemExit('element %s: trapezoidal load (w2) not supported by '
                                 'beamUniform; case needs a dedicated translation' % e['id'])
            d = ld.get('dir') or 'gravity'
            if d in ('gravity', 'globalZ'):
                gv = [0.0, 0.0, -w]           # 'gravity'/'globalZ' act along global -Z
            elif d == 'globalX':
                gv = [w, 0.0, 0.0]
            elif d == 'globalY':
                gv = [0.0, w, 0.0]
            elif d in ('localX', 'localY', 'localZ'):
                gv = None
                comp = {'localX': (w, 0.0, 0.0), 'localY': (0.0, w, 0.0), 'localZ': (0.0, 0.0, w)}[d]
                wx, wy, wz = comp
            else:
                raise SystemExit('element %s: unknown dist load dir %r' % (e['id'], d))
            if gv is not None:
                wx, wy, wz = _dot(gv, ex), _dot(gv, ey), _dot(gv, ez)
            # 3D beamUniform takes the LOCAL Wy, Wz, Wx.
            ops.eleLoad('-ele', int(e['id']), '-type', '-beamUniform', wy, wz, wx)
        elif t == 'temp':
            raise SystemExit('thermal loads are not translated by run_case.py')
        else:
            raise SystemExit('unknown load type %r' % t)

    if self_weight or lc.get('selfWeight'):
        for e in m['elements']:
            n1, n2 = nodes[e['n1']], nodes[e['n2']]
            mat, sec = mats[e['matId']], secs[e['secId']]
            rho = float(mat.get('rho') or 0.0)
            if rho <= 0:
                continue
            ex, ey, ez, L = local_axes(n1, n2)
            q = rho * float(sec['A']) * G_ACC      # force per length, global -Z
            gv = [0.0, 0.0, -q]
            ops.eleLoad('-ele', int(e['id']), '-type', '-beamUniform',
                        _dot(gv, ey), _dot(gv, ez), _dot(gv, ex))

    return nodes


# ── analyses ──────────────────────────────────────────────────────────────────
def run_static(m, lc_id, self_weight):
    nodes = build(m, lc_id, self_weight)
    ops.system('BandGeneral')
    ops.numberer('RCM')
    ops.constraints('Plain')
    ops.integrator('LoadControl', 1.0)
    ops.algorithm('Linear')
    ops.analysis('Static')
    if ops.analyze(1) != 0:
        raise SystemExit('OpenSees static analysis failed to converge')
    ops.reactions()
    return {
        'disp': {str(i): [ops.nodeDisp(int(i), k) for k in range(1, 7)] for i in nodes},
        'reaction': {str(i): [ops.nodeReaction(int(i), k) for k in range(1, 7)] for i in nodes},
    }


def run_modal(m, n_modes):
    nodes = build(m, None)
    lam = ops.eigen('-genBandArpack', n_modes)
    omega = [math.sqrt(abs(v)) for v in lam]
    return {
        'omega2': list(lam),
        'omega': omega,
        'freq': [w / (2 * math.pi) for w in omega],
        'period': [(2 * math.pi / w) if w > 1e-12 else None for w in omega],
        'modeShape': {str(i): [[ops.nodeEigenvector(int(i), md, k) for k in range(1, 7)]
                               for md in range(1, n_modes + 1)] for i in nodes},
    }


def main():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('s3d')
    p.add_argument('--analysis', choices=['static', 'modal'], default='static')
    p.add_argument('--lc', type=int, default=None, help='load case id (static)')
    p.add_argument('--modes', type=int, default=6)
    p.add_argument('--self-weight', action='store_true')
    p.add_argument('-o', '--out', default=None, help='write JSON here (default: stdout)')
    a = p.parse_args()

    with open(a.s3d, encoding='utf-8') as f:
        m = json.load(f)
    _refuse_unsupported(m)

    if a.analysis == 'static':
        if a.lc is None:
            a.lc = m['loadCases'][0]['id']
        res = run_static(m, a.lc, a.self_weight)
        res['lcId'] = a.lc
    else:
        res = run_modal(m, a.modes)

    res['_meta'] = {
        'engine': 'OpenSees (openseespy)',
        'version': ops.version() if hasattr(ops, 'version') else None,
        'model': a.s3d,
        'analysis': a.analysis,
        'element': sorted(_ELEMENT_KIND),
        'mass': 'consistent (-cMass)',
    }
    out = json.dumps(res, indent=1)
    if a.out:
        with open(a.out, 'w', encoding='utf-8') as f:
            f.write(out + '\n')
        print('wrote %s' % a.out, file=sys.stderr)
    else:
        print(out)


if __name__ == '__main__':
    main()
