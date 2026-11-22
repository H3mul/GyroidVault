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
    env: { ...process.env, DATA_DIR: tmp, LIBRARY_PATH: path.join(tmp, 'library'), PORT: String(port), THINGIVERSE_TOKEN: '', INGEST_RATE_LIMIT_PER_MIN: '60' },
  });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(base + '/healthz')).ok) break; } catch {} await sleep(250); }

  console.log('\nIngest HTTP API');
  const admin = await login('admin_i', 'admin_i@test.local');
  await req('/api/settings/system', { method: 'POST', session: admin, body: { open_registration: 'true' } });
  const owner = await login('owner_i', 'owner_i@test.local');           // default role: can upload
  const viewer = await login('viewer_i', 'viewer_i@test.local', 'viewer', admin);
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
    const other = await login('other_i', 'other_i@test.local');
    assert.strictEqual((await req(`/api/ingest/jobs/${jobId}`, { session: other })).status, 403);
    assert.strictEqual((await req(`/api/ingest/jobs/${jobId}`, { session: admin })).status, 200);
    assert.strictEqual((await post(`/api/ingest/jobs/${jobId}/retry`, {}, other)).status, 403);
  });

  await check('/download: 404 unknown model, 403 for non-owner, 400 for bad URL, 202 for owner; retry restarts a finished job', async () => {
    const other = await login('other2_i', 'other2_i@test.local');
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

  await check('Rate limit: bursts of ingest requests are throttled with 429', async () => {
    let limited = 0;
    for (let i = 0; i < 90; i++) if ((await post('/api/ingest/preview', { url: 'bad' })).status === 429) limited++;
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
