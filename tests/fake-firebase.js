// Loads the REAL functions/index.js with in-memory fakes for Firebase + the Claude API.
const Module = require('module');
const store = new Map(); // "col/doc" -> object
const clone = o => JSON.parse(JSON.stringify(o));
function setPath(obj, path, val){ const k = path.split('.'); let o = obj; for(let i=0;i<k.length-1;i++){ o[k[i]] = o[k[i]] || {}; o = o[k[i]]; } o[k[k.length-1]] = val; }
function mkRef(col, id){
  const key = `${col}/${id}`;
  return { key,
    async get(){ const d = store.get(key); return { exists: !!d, data: () => d ? clone(d) : undefined }; },
    async set(data, opts){ store.set(key, opts && opts.merge ? { ...(store.get(key)||{}), ...clone(data) } : clone(data)); },
    async update(obj){ const d = store.get(key); if(!d) throw new Error('no doc '+key); for(const [p,v] of Object.entries(obj)) setPath(d, p, clone(v)); } };
}
const db = { collection: c => ({ doc: id => mkRef(c, id) }),
  async runTransaction(fn){ const tx = { get: r => r.get(), set: (r,d,o) => r.set(d,o), update: (r,o) => r.update(o) }; return fn(tx); } };
const fakes = {
  'firebase-functions/v2/https': { onCall: (a, b) => (typeof a === 'function' ? a : b), HttpsError: class extends Error { constructor(c,m){ super(m); this.code = c; } } },
  'firebase-functions/params': { defineSecret: () => ({ value: () => 'test-key' }) },
  'firebase-admin/app': { initializeApp(){} },
  'firebase-admin/firestore': { getFirestore: () => db, FieldValue: { serverTimestamp: () => Date.now() } },
};
const origLoad = Module._load;
Module._load = function(req, ...rest){ return fakes[req] || origLoad.call(this, req, ...rest); };

// Fake Claude: obeys "aim for about N" with some sloppiness, configurable.
const claude = { calls: [], mode: 'good' };
const words = n => Array.from({length:n}, (_,i) => ['moose','wanders','across','snowy','hills','slowly','while','people','watch','quietly'][i%10]).join(' ');
global.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body); const p = body.messages[0].content;
  claude.calls.push(p);
  const m = p.match(/about (\d+)/); const t = m ? +m[1] : 12;
  let n;
  if (p.startsWith('Rewrite this')) n = claude.mode === 'badrewrite' ? t + 15 : t;
  else if (claude.mode === 'verbose') n = 26;
  else n = t + Math.round((Math.random()-0.5)*4); // +/-2 words
  const text = p.includes('"bluff"') && !p.startsWith('Rewrite') ? JSON.stringify({ bluff: words(n) })
    : p.startsWith('Rewrite') ? JSON.stringify({ text: words(n) })
    : JSON.stringify({ term: 'The Moose Who Knew Too Much', real: words(n), source: 'test' });
  return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn' }) };
};
process.env.BALDERLAUGH_TEST = '1';
const fns = require(process.argv[2]);
module.exports = { fns, store, claude, db, mkRef };
