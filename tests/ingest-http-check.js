/**
 * HTTP-level tests for /api/ingest against a real server process (isolated DB/library) with
 * stubbed outbound network (tests/helpers/ingest-stubs.js preloaded via --require).
 * Run via: node tests/ingest-http-check.js (chained from `npm test`)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-http-'));
const stubFile = path.join(tmp, 'stub-state.json');
const setStub = o => fs.writeFileSync(stubFile, JSON.stringify(o));
let passed = 0, base, srv;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function check(name, fn) {
  try { await fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (e) { console.error(`  \x1b[31m✗\x1b[0m ${name}\n    ${e.stack}`); process.exitCode = 1; }
}
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });

async function req(p, { method = 'GET', body, session } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (session) { headers.cookie = session.cookie; if (method !== 'GET') headers['x-csrf-token'] = session.csrf; }
  const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, data: await r.json().catch(() => ({})), setCookie: r.headers.get('set-cookie') };
}
async function login(username, email, role, admin) {
  const reg = await req('/api/auth/register', { method: 'POST', body: { username, email, password: 'Password123!' } });
  if (role) await req(`/api/users/${reg.data.id}/role`, { method: 'PUT', session: admin, body: { role } });
  const l = await req('/api/auth/login', { method: 'POST', body: { username, password: 'Password123!' } });
  return { cookie: l.setCookie.split(';')[0], csrf: l.data.csrfToken, id: reg.data.id };
}
async function waitJob(session, id) {
  for (let i = 0; i < 100; i++) {
    const j = await req(`/api/ingest/jobs/${id}`, { session });
    if (!['pending', 'running'].includes(j.data.status)) return j.data;
    await sleep(50);
  }
  throw new Error('job timeout');
}

(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  srv = spawn('node', ['-r', path.join(__dirname, 'helpers/ingest-stubs.js'), 'server/index.js'], {
    cwd: ROOT, stdio: 'ignore',
    env: { ...process.env, DATA_DIR: tmp, LIBRARY_PATH: path.join(tmp, 'library'), PORT: String(port), THINGIVERSE_TOKEN: '', INGEST_RATE_LIMIT_PER_MIN: '300', STUB_STATE_FILE: stubFile },
  });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch {} await sleep(250); }

  console.log('\nIngest HTTP API');
  const admin = await login('admin_i', 'admin_i@test.local');
  await req('/api/settings/system', { method: 'POST', session: admin, body: { open_registration: 'true' } });
  const owner = await login('owner_i', 'owner_i@test.local');           // default role: can upload
  const viewer = await login('viewer_i', 'viewer_i@test.local', 'viewer', admin);
  const stranger = await login('stranger_i', 'stranger_i@test.local');   // uploader who owns nothing (the auth limiter caps registrations)
  const url = 'https://www.printables.com/model/99-test-bracket';
  const post = (p, body, session = owner) => req(p, { method: 'POST', body, session });

  await check('All ingest endpoints require login', async () => {
    for (const [m, p] of [['POST', '/api/ingest/preview'], ['POST', '/api/ingest'], ['POST', '/api/ingest/download'], ['GET', '/api/ingest/jobs/1'], ['GET', '/api/ingest/models/1/job'], ['POST', '/api/ingest/jobs/1/retry']]) {
      const r = await req(p, { method: m, body: m === 'POST' ? { url } : undefined });
      assert.strictEqual(r.status, 401, `${m} ${p} -> ${r.status}`);
    }
  });

  await check('Viewers cannot preview, import, download or retry', async () => {
    for (const p of ['/api/ingest/preview', '/api/ingest', '/api/ingest/download', '/api/ingest/jobs/1/retry']) {
      const r = await post(p, { url, model_id: 1 }, viewer);
      assert.strictEqual(r.status, 403, `${p} -> ${r.status}`);
      assert.match(r.data.error, /viewer accounts|privileges/i, `${p} rejected for the wrong reason: ${r.data.error}`);
    }
  });

  await check('Preview validates input: missing/garbage URL, bad scheme, private address, unknown model, blocked site', async () => {
    assert.strictEqual((await post('/api/ingest/preview', {})).status, 400);
    assert.strictEqual((await post('/api/ingest/preview', { url: 'not a url' })).status, 400);
    assert.strictEqual((await post('/api/ingest/preview', { url: 'javascript:alert(1)' })).status, 400);
    assert.strictEqual((await post('/api/ingest/preview', { url: 'http://169.254.169.254/latest/meta-data' })).status, 400);
    assert.strictEqual((await post('/api/ingest/preview', { url: 'http://db.internal.test/' })).status, 400);
    assert.strictEqual((await post('/api/ingest/preview', { url: 'https://www.printables.com/model/12345-nope' })).status, 422);
    const blocked = await post('/api/ingest/preview', { url: 'https://blocked.example.com/' });
    assert.strictEqual(blocked.status, 422);
    assert.ok(!/stack|at /.test(blocked.data.error), 'error message must not leak internals');
  });

  await check('Preview returns the public shape without provider-private fields and without creating anything', async () => {
    const r = await post('/api/ingest/preview', { url });
    assert.strictEqual(r.status, 200);
    const d = r.data;
    assert.strictEqual(d.title, 'Test Bracket');
    assert.strictEqual(d.site, 'printables');
    assert.strictEqual(d.tags[0], 'source:printables');
    assert.deepStrictEqual(Object.keys(d).filter(k => k.startsWith('_')), []);
    assert.ok(d.files.every(f => f.id && f.name && !('_direct' in f)));
    assert.strictEqual(d.existing_model, null);
    assert.strictEqual((await req('/api/models', { session: owner })).data.models?.length ?? (await req('/api/models', { session: owner })).data.length ?? 0, 0);
  });

  await check('Thingiverse URLs without a configured token: 422 with code token_required on preview, import and download; nothing created', async () => {
    const tv = 'https://www.thingiverse.com/thing:5';
    for (const [p, body] of [['/api/ingest/preview', { url: tv }], ['/api/ingest', { url: tv }]]) {
      const r = await post(p, body);
      assert.strictEqual(r.status, 422, `${p} -> ${r.status}`); assert.strictEqual(r.data.code, 'token_required');
      assert.ok(r.data.error.includes('THINGIVERSE_TOKEN') && r.data.error.includes('thingiverse.com/apps/create'));
    }
    const manual = await post('/api/models', { name: 'Needs thing download' });
    const dl = await post('/api/ingest/download', { model_id: manual.data.id, url: tv });
    assert.strictEqual(dl.status, 422); assert.strictEqual(dl.data.code, 'token_required');
  });

  let modelId, jobId;
  await check('One-shot import creates model, owner is the importer, job runs and reports per-file results', async () => {
    const r = await post('/api/ingest', { url, file_ids: ['stl:1', 'stl:2'] });
    assert.strictEqual(r.status, 201, JSON.stringify(r.data));
    modelId = r.data.model.id; jobId = r.data.job_id;
    assert.ok(jobId);
    const job = await waitJob(owner, jobId);
    assert.strictEqual(job.status, 'partial');                 // evil.stl is rejected
    const m = (await req(`/api/models/${modelId}`, { session: owner })).data;
    assert.strictEqual(m.source_url, 'https://www.printables.com/model/99');
    assert.ok(m.tags.some(t => t.name === 'source:printables'));
    assert.deepStrictEqual(m.files.map(f => f.original_name).sort(), ['cover.jpg', 'part.stl']);
    assert.ok(m.thumbnail || m.thumbnail_url);
  });

  await check('Origin tag is filterable by tag id and by typed search (tag:source:printables, -tag:)', async () => {
    const tagId = (await req(`/api/models/${modelId}`, { session: owner })).data.tags.find(x => x.name === 'source:printables').id;
    const byId = await req(`/api/models?tag=${tagId}`, { session: owner });
    assert.ok(byId.data.models.some(m => m.id === modelId), JSON.stringify(byId.data).slice(0, 200));
    const typed = await req('/api/models?search=' + encodeURIComponent('tag:source:printables'), { session: owner });
    assert.ok(typed.data.models.some(m => m.id === modelId));
    const excl = await req('/api/models?search=' + encodeURIComponent('-tag:source:printables'), { session: owner });
    assert.ok(!excl.data.models.some(m => m.id === modelId));
  });

  await check('Preview of an imported URL flags the existing model; second import is 409 unless allowed', async () => {
    const p = await post('/api/ingest/preview', { url });
    assert.strictEqual(p.data.existing_model.id, modelId);
    const dup = await post('/api/ingest', { url });
    assert.strictEqual(dup.status, 409);
    assert.strictEqual(dup.data.existing_model_id, modelId);
    const ok = await post('/api/ingest', { url, allow_duplicate: true, auto_rename: true, download_files: false });
    assert.strictEqual(ok.status, 201);
    assert.strictEqual(ok.data.job_id, null);
    assert.notStrictEqual(ok.data.model.name, 'Test Bracket');
  });

  await check('Name collision with an existing manual model returns 409 with suggestions (create path unchanged by refactor)', async () => {
    const mk = await post('/api/models', { name: 'Collide Me' });
    assert.strictEqual(mk.status, 201);
    const again = await post('/api/models', { name: 'Collide Me' });
    assert.strictEqual(again.status, 409);
    assert.ok(again.data.suggested_names.length > 0);
    const auto = await post('/api/models', { name: 'Collide Me', auto_rename: true, tags: ['alpha', 'NEW:beta'] });
    assert.strictEqual(auto.status, 201);
    const m = (await req(`/api/models/${auto.data.id}`, { session: owner })).data;
    assert.deepStrictEqual(m.tags.map(t => t.name).sort(), ['alpha', 'beta']);
  });

  await check('Job and latest-job endpoints: shape, 404, ownership', async () => {
    const latest = await req(`/api/ingest/models/${modelId}/job`, { session: owner });
    assert.strictEqual(latest.data.id, jobId);
    assert.ok(Array.isArray(latest.data.detail));
    assert.strictEqual((await req(`/api/ingest/models/${modelId + 999}/job`, { session: owner })).data, null);
    assert.strictEqual((await req('/api/ingest/jobs/9999', { session: owner })).status, 404);
    const other = stranger;
    assert.strictEqual((await req(`/api/ingest/jobs/${jobId}`, { session: other })).status, 403);
    assert.strictEqual((await req(`/api/ingest/jobs/${jobId}`, { session: admin })).status, 200);
    assert.strictEqual((await post(`/api/ingest/jobs/${jobId}/retry`, {}, other)).status, 403);
  });

  await check('/download: 404 unknown model, 403 for non-owner, 400 for bad URL, 202 for owner; retry restarts a finished job', async () => {
    const other = stranger;
    assert.strictEqual((await post('/api/ingest/download', { model_id: 99999, url })).status, 404);
    assert.strictEqual((await post('/api/ingest/download', { model_id: modelId, url }, other)).status, 403);
    assert.strictEqual((await post('/api/ingest/download', { model_id: modelId, url: 'http://127.0.0.1/' })).status, 400);
    const ok = await post('/api/ingest/download', { model_id: modelId, url, file_ids: ['stl:1'] });
    assert.strictEqual(ok.status, 202);
    assert.strictEqual((await waitJob(owner, ok.data.job_id)).status, 'completed');   // part.stl already present: nothing to do
    const retry = await post(`/api/ingest/jobs/${jobId}/retry`, {});
    assert.strictEqual(retry.status, 202);
    await waitJob(owner, retry.data.job_id);
  });

  await check('Deleting an imported model removes its job rows (cascade) without errors', async () => {
    const del = await req(`/api/models/${modelId}?deleteDisk=true`, { method: 'DELETE', session: owner });
    assert.ok([200, 204].includes(del.status), `delete -> ${del.status}`);
    assert.strictEqual((await req(`/api/ingest/jobs/${jobId}`, { session: admin })).status, 404);
  });

  // ── update tracking over HTTP ──
  const mdl = (id, files, extra = {}) => ({ id: String(id), modified: '2026-01-01T00:00:00+00:00', name: `HTTP ${id}`, summary: 's', description: '<p>d</p>', tags: [{ name: 'alpha' }],
    image: { filePath: 'media/prints/x/c.jpg' }, stls: files.map(([i, n]) => ({ id: String(i), name: n, fileSize: 84 })), gcodes: [], slas: [], ...extra });
  const track = { rootId: null, other: null };
  await check('Import is tracked; GET source reports state; ownership and roles are enforced on source routes', async () => {
    setStub({ models: { 200: mdl(200, [[1001, 'a.stl'], [1002, 'b.stl']]) }, files: { 1001: 'STL', 1002: 'STL2' } });
    const r = await post('/api/ingest', { url: 'https://www.printables.com/model/200-x' });
    assert.strictEqual(r.status, 201);
    track.rootId = r.data.model.id; await waitJob(owner, r.data.job_id);
    const s = await req(`/api/ingest/models/${track.rootId}/source`, { session: owner });
    assert.deepStrictEqual([s.data.tracked, s.data.state, s.data.site, s.data.dismissed], [true, 'current', 'printables', false]);
    track.other = stranger;
    for (const [p, body] of [['check', {}], ['track', {}], ['dismiss', {}], ['update-preview', {}], ['update', {}], ['refresh-metadata', {}]]) {
      assert.strictEqual((await post(`/api/ingest/models/${track.rootId}/${p}`, body, track.other)).status, 403, `${p} non-owner`);
      assert.strictEqual((await post(`/api/ingest/models/${track.rootId}/${p}`, body, viewer)).status, 403, `${p} viewer`);
      assert.strictEqual((await req(`/api/ingest/models/${track.rootId}/${p}`, { method: 'POST', body })).status, 401, `${p} anon`);
      assert.strictEqual((await post(`/api/ingest/models/999999/${p}`, body)).status, 404, `${p} unknown model`);
    }
    assert.strictEqual((await req('/api/ingest/models/999999/source', { session: owner })).status, 404);
    assert.strictEqual((await req(`/api/ingest/models/${track.rootId}/source`)).status, 401);
  });
  await check('Check detects a new upstream file; library shows update_state and the updates filter; preview of the tracked URL offers the update', async () => {
    setStub({ models: { 200: mdl(200, [[1001, 'a.stl'], [1002, 'b.stl'], [1003, 'c.stl']], { modified: '2026-02-01T00:00:00+00:00' }) }, files: { 1003: 'STL' } });
    const c = await post(`/api/ingest/models/${track.rootId}/check`, {});
    assert.strictEqual(c.status, 200); assert.strictEqual(c.data.state, 'outdated'); assert.deepStrictEqual(c.data.summary.added.map(f => f.name), ['c.stl']);
    const list = await req('/api/models?updates=1', { session: owner });
    const hit = list.data.models.find(m => m.id === track.rootId);
    assert.ok(hit && hit.update_state === 'outdated');
    assert.ok(!(await req('/api/models', { session: owner })).data.models.some(m => m.update_state && m.id !== track.rootId), 'only this family is flagged');
    const pv = await post('/api/ingest/preview', { url: 'https://www.printables.com/model/200-x' });
    assert.deepStrictEqual([pv.data.existing_model.id, pv.data.update_available.state], [track.rootId, 'outdated']);
  });
  await check('Update preview lists file statuses; update creates a new latest version; filter clears; old version intact', async () => {
    const pv = await post(`/api/ingest/models/${track.rootId}/update-preview`, {});
    assert.deepStrictEqual(pv.data.files.map(f => [f.name, f.status]), [['a.stl', 'unchanged'], ['b.stl', 'unchanged'], ['c.stl', 'new']]);
    const up = await post(`/api/ingest/models/${track.rootId}/update`, {});
    assert.strictEqual(up.status, 202);
    const job = await waitJob(owner, up.data.job_id);
    assert.strictEqual(job.status, 'completed', JSON.stringify(job));
    const root = (await req(`/api/models/${track.rootId}`, { session: owner })).data;
    const v = (await req(`/api/models/${job.result_model_id}`, { session: owner })).data;
    assert.deepStrictEqual(v.files.map(f => f.original_name).sort(), ['a.stl', 'b.stl', 'c.stl', 'cover.jpg']);
    assert.strictEqual(root.files.length, 3, 'old version unchanged'); assert.strictEqual(root.latest_version.id, job.result_model_id);
    assert.ok(!(await req('/api/models?updates=1', { session: owner })).data.models.some(m => m.id === track.rootId), 'family no longer flagged');
    assert.strictEqual((await req(`/api/ingest/models/${job.result_model_id}/job`, { session: owner })).data.id, job.id, 'new version shows the update job');
    track.v2 = job.result_model_id;
  });
  await check('Failed update over HTTP reports the reason and the previous version stays latest', async () => {
    setStub({ models: { 200: mdl(200, [[1001, 'a.stl'], [1002, 'b.stl'], [1003, 'c.stl'], [1004, 'd.stl']], { modified: '2026-03-01T00:00:00+00:00' }) }, files: { 1004: null } });
    const up = await post(`/api/ingest/models/${track.v2}/update`, { file_ids: ['stl:1004'] });
    const job = await waitJob(owner, up.data.job_id);
    assert.strictEqual(job.status, 'failed'); assert.ok(job.error);
    assert.strictEqual((await req(`/api/models/${track.rootId}`, { session: owner })).data.latest_version.id, track.v2);
    // retrying a failed update runs the update again (kind update), it must not import files into the old version
    setStub({ models: { 200: mdl(200, [[1001, 'a.stl'], [1002, 'b.stl'], [1003, 'c.stl'], [1004, 'd.stl']], { modified: '2026-03-01T00:00:00+00:00' }) }, files: { 1004: 'STL' } });
    const filesBefore = (await req(`/api/models/${track.v2}`, { session: owner })).data.files.length;
    const rt = await post(`/api/ingest/jobs/${job.id}/retry`, {});
    assert.strictEqual(rt.status, 202);
    const again = await waitJob(owner, rt.data.job_id);
    assert.strictEqual(again.kind, 'update'); assert.strictEqual(again.status, 'completed', JSON.stringify(again));
    assert.strictEqual((await req(`/api/models/${track.v2}`, { session: owner })).data.files.length, filesBefore, 'old version untouched by the retry');
    assert.notStrictEqual((await req(`/api/models/${track.rootId}`, { session: owner })).data.latest_version.id, track.v2, 'a new version now exists');
  });
  await check('Dismiss clears the library flag; refresh-metadata returns state; check-all is admin-only', async () => {
    setStub({ models: { 201: mdl(201, [[2001, 'x.stl']]) }, files: { 2001: 'STL' } });
    const id = (await post('/api/ingest', { url: 'https://www.printables.com/model/201-y' })).data;
    await waitJob(owner, id.job_id);
    setStub({ models: { 201: mdl(201, [[2001, 'x.stl'], [2002, 'y.stl']], { modified: '2026-02-01T00:00:00+00:00', name: 'Renamed 201' }) } });
    assert.strictEqual((await post(`/api/ingest/models/${id.model.id}/check`, {})).data.state, 'outdated');
    assert.strictEqual((await post(`/api/ingest/models/${id.model.id}/dismiss`, {})).data.dismissed, true);
    assert.ok(!(await req('/api/models?updates=1', { session: owner })).data.models.some(m => m.id === id.model.id));
    const rm = await post(`/api/ingest/models/${id.model.id}/refresh-metadata`, {});
    assert.strictEqual(rm.status, 200); assert.strictEqual(rm.data.state, 'outdated'); assert.strictEqual(rm.data.name, 'Renamed 201');
    assert.strictEqual((await post('/api/ingest/check-all', {}, owner)).status, 403);
    assert.strictEqual((await post('/api/ingest/check-all', {}, admin)).status, 202);
  });
  await check('Transient source failure on manual check returns ok:false with the code and leaves state alone', async () => {
    setStub({ mode: 'rate_limit' });
    const r = await post(`/api/ingest/models/${track.v2}/check`, {});
    assert.strictEqual(r.status, 200); assert.deepStrictEqual([r.data.ok, r.data.code], [false, 'rate_limited']);
    setStub({});
  });
  await check('Track updates endpoint: refuses unsupported sources, baselines supported ones', async () => {
    const manual = await post('/api/models', { name: 'Linked by hand', source_url: 'https://example.com/m/1' });
    assert.strictEqual((await post(`/api/ingest/models/${manual.data.id}/track`, {})).status, 400);
    setStub({ models: { 202: mdl(202, [[3001, 'z.stl']]) } });
    const hand = await post('/api/models', { name: 'Hand 202', source_url: 'https://www.printables.com/model/202-z' });
    const t = await post(`/api/ingest/models/${hand.data.id}/track`, {});
    assert.deepStrictEqual([t.status, t.data.tracked, t.data.state], [200, true, 'current']);
  });

  await check('Rate limit: bursts of ingest requests are throttled with 429', async () => {
    let limited = 0;
    for (let i = 0; i < 330; i++) if ((await post('/api/ingest/preview', { url: 'bad' })).status === 429) limited++;
    assert.ok(limited > 0, 'expected at least one 429');
    // status polling must stay available while the outbound limit is exhausted
    assert.strictEqual((await req(`/api/ingest/models/1/job`, { session: owner })).status, 200);
  });

  console.log(`\n${passed} ingest HTTP checks passed`);
  srv.kill();
  await sleep(300);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(process.exitCode || 0);
})().catch(e => { console.error(e); srv?.kill(); process.exit(1); });
