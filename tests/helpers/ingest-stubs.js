/**
 * Offline network stubs for ingestion tests: DNS resolves everything to a public IP (except *.internal.test)
 * and global fetch serves Printables/Thingiverse fixtures. Usable in-process or via `node --require`.
 */
const assert = require('assert');
// DNS: everything public except *.internal.test
require('dns').promises.lookup = async host => [{ address: host.endsWith('internal.test') ? '10.0.0.5' : '93.184.216.34', family: 4 }];

// Fixtures
const STL = Buffer.concat([Buffer.alloc(80, 0x20), Buffer.from([0, 0, 0, 0])]);
const EXE = Buffer.from('MZ' + 'x'.repeat(100));
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const printable = {
  id: '99', modified: '2026-01-01T00:00:00+00:00', name: 'Test <b>Bracket</b>', summary: 'sum', description: '<p>Hello <script>alert(1)</script>world &amp; co</p>',
  tags: [{ name: 'Bracket' }, { name: 'bracket' }, { name: 'Wall Mount' }], image: { filePath: 'media/prints/x/img.jpg' },
  stls: [{ id: '1', name: 'part.stl', fileSize: STL.length }, { id: '2', name: 'evil.stl', fileSize: EXE.length }, { id: '3', name: 'huge.stl', fileSize: 900 * 1024 * 1024 }],
  gcodes: [], slas: [],
};
const THING_HTML = `<html><head><title>x</title><meta property="og:title" content="Benchy &amp; friends"><meta property="og:description" content="A boat"><meta property="og:image" content="https://cdn.example.com/b.jpg"><script type="application/ld+json">{"@type":"Product","name":"Benchy &amp; friends","description":"A boat"}</script></head></html>`;

// Mutable server state so tests can simulate upstream edits and outages.
// mode: null | 'rate_limit' | 'not_found' | 'offline' (applies to Printables metadata queries, not file downloads)
const state = { calls: [], mode: null, coverFail: false, lastUA: null, models: { 99: printable }, files: { 1: STL, 2: EXE } };

/** Registers a Printables model with files [{id,name,body}] and returns its fixture (mutate it to simulate edits). */
function addModel(id, files, extra = {}) {
  const m = { id: String(id), modified: '2026-01-01T00:00:00+00:00', name: `Model ${id}`, summary: 's', description: `<p>Desc ${id}</p>`, tags: [{ name: 'alpha' }], image: { filePath: `media/prints/${id}/c.jpg` },
    stls: files.map(f => ({ id: String(f.id), name: f.name, fileSize: f.body.length })), gcodes: [], slas: [], ...extra };
  files.forEach(f => { state.files[f.id] = f.body; });
  state.models[id] = m;
  return m;
}
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
// Cross-process control: when STUB_STATE_FILE is set (HTTP tests spawn the real server with this preload),
// the file is re-read on every request: {mode, models: {id: fixture}, files: {id: 'STL'|'STL2'|'EXE'|null}}
function syncFromFile() {
  const f = process.env.STUB_STATE_FILE;
  if (!f) return;
  try {
    const c = JSON.parse(require('fs').readFileSync(f, 'utf8'));
    state.mode = c.mode || null;
    for (const [id, m] of Object.entries(c.models || {})) state.models[id] = m;
    const bodies = { STL, STL2: Buffer.concat([STL, Buffer.from('v2')]), EXE };
    for (const [id, b] of Object.entries(c.files || {})) { if (bodies[b]) state.files[id] = bodies[b]; else delete state.files[id]; }
  } catch { /* no state yet */ }
}

global.fetch = async (url, opts = {}) => {
  syncFromFile();
  url = String(url); state.calls.push(url); state.lastUA = opts.headers && opts.headers['user-agent'];
  if (url === 'https://api.printables.com/graphql/') {
    const q = JSON.parse(opts.body).query;
    if (q.includes('getDownloadLink')) {
      const id = q.match(/id:"(\d+)"/)[1];
      return json({ data: { getDownloadLink: { ok: true, output: { link: `https://files.printables.com/f/${id}.stl` } } } });
    }
    if (state.mode === 'rate_limit') return json({ error: 'slow down' }, 429);
    if (state.mode === 'offline') throw new TypeError('fetch failed');
    const id = q.match(/print\(id:"(\d+)"/)?.[1];
    return json({ data: { print: state.mode === 'not_found' ? null : state.models[id] || null } });
  }
  const fm = url.match(/^https:\/\/files\.printables\.com\/f\/(\d+)\.stl/);
  if (fm) return state.files[fm[1]] ? new Response(state.files[fm[1]]) : new Response('missing', { status: 404 });
  if (url.startsWith('https://media.printables.com/')) return state.coverFail ? new Response('challenge', { status: 403, headers: { 'cf-mitigated': 'challenge' } }) : new Response(JPG);
  if (url === 'https://www.thingiverse.com/thing:5') return new Response(THING_HTML);
  if (url === 'https://api.thingiverse.com/things/5') {
    assert.strictEqual(opts.headers.authorization, 'Bearer tok');
    return json({ name: 'TV thing', description: 'd', tags: [{ name: 'Boat' }], default_image: { url: 'https://cdn.example.com/c.jpg' } });
  }
  if (url === 'https://api.thingiverse.com/things/5/files') return json([{ id: 7, name: 'boat.stl', size: STL.length, direct_url: 'https://cdn.example.com/boat.stl' }]);
  if (url === 'https://cdn.example.com/boat.stl') return new Response(STL);
  if (url === 'https://cdn.example.com/c.jpg') return new Response(JPG);
  if (url === 'https://redirect.example.com/') return new Response(null, { status: 302, headers: { location: 'http://10.1.1.1/secret' } });
  if (url === 'https://blocked.example.com/') return new Response('Just a moment', { status: 403 });
  return new Response('not found', { status: 404 });
};


module.exports = { STL, EXE, JPG, printable, THING_HTML, state, json, addModel };
