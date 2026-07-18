// Import robustness — a corrupt / hand-edited / malicious .s3d must fail with a CLEAR
// message, never a cryptic TypeError ("Cannot create property 'nodeMass' on string …",
// "X is not iterable"). Guards Serializer.fromJSON (audit finding #1).
import { Serializer } from '../js/model/serializer.js';

let failures = 0;
const check = (cond, msg, extra='') => { console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${msg}${extra ? '  '+extra : ''}`); if (!cond) failures++; };
const CRYPTIC = /Cannot (read|create)|is not iterable|undefined|of null/i;

console.log('── (1) Malformed .s3d → CLEAR error (not a cryptic TypeError) ──');
const malformed = {
  'nodes is a string':       '{"nodes":"evil"}',
  'elements is a number':    '{"nodes":[],"elements":42}',
  'materials is an object':  '{"nodes":[],"materials":{"a":1}}',
  'areas is a string':       '{"nodes":[],"areas":"boom"}',
  'loadCases is a string':   '{"nodes":[],"loadCases":"x"}',
  'top-level array':         '[]',
  'top-level number':        '42',
  'top-level string':        '"hello"',
  'top-level null':          'null',
  'not JSON at all':         'this is not json',
};
for (const [label, txt] of Object.entries(malformed)) {
  let err = null;
  try { new Serializer().fromJSON(txt); } catch (e) { err = e; }
  const clear = !!err && !CRYPTIC.test(err.message) && /inválido|lista|JSON/i.test(err.message);
  check(clear, label, err ? `→ "${err.message.slice(0, 50)}"` : '→ did NOT throw ❌');
}

console.log('\n── (2) Valid / partial .s3d still loads gracefully ──');
{
  const good = '{"version":"1.0","units":"kN-m","mode":"3D","nodes":[{"id":1,"x":0,"y":0,"z":0}],"elements":[]}';
  let m = null, err = null;
  try { m = new Serializer().fromJSON(good); } catch (e) { err = e; }
  check(!err && m && m.nodes.size === 1, 'valid file loads (1 node)', err ? `(threw: ${err.message})` : '');
}
{
  // missing optional collections → defaults, no crash
  let m = null, err = null;
  try { m = new Serializer().fromJSON('{"nodes":[{"id":1,"x":0,"y":0,"z":0}]}'); } catch (e) { err = e; }
  check(!err && m && m.nodes.size === 1, 'missing collections → graceful (defaults)');
}
{
  // empty object → empty model with default material/section (no crash)
  let err = null;
  try { new Serializer().fromJSON('{}'); } catch (e) { err = e; }
  check(!err, 'empty object {} loads without crash');
}

console.log('\n── (3) Round-trip still intact (toJSON → fromJSON) ──');
{
  const { Model } = await import('../js/model/model.js');
  const mm = new Model();
  const json = new Serializer().toJSON(mm);
  let err = null, round = null;
  try { round = new Serializer().fromJSON(json); } catch (e) { err = e; }
  check(!err && round && round.nodes.size === mm.nodes.size, 'default model round-trips');
}

console.log(`\n=== ${failures === 0 ? 'ALL OK' : failures + ' FAILURE(S)'} ===`);
process.exit(failures === 0 ? 0 : 1);
