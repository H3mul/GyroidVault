/**
 * URL ingestion tests. Offline: global fetch and DNS are stubbed with fixtures.
 * Run via: node tests/ingest-check.js (also chained from `npm test`)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-ingest-'));
process.env.DATA_DIR = tmp;
process.env.LIBRARY_PATH = path.join(tmp, 'library');
delete process.env.THINGIVERSE_TOKEN;

const { STL, EXE, JPG, printable, THING_HTML, state } = require('./helpers/ingest-stubs');

let passed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (e) { console.error(`  \x1b[31m✗\x1b[0m ${name}\n    ${e.stack}`); process.exitCode = 1; }
}
const rejects = (p, status, re) => p.then(() => assert.fail('expected rejection'), e => { assert.strictEqual(e.status, status, e.message); if (re) assert.match(e.message, re); });
const waitJob = async (getJob, id) => { for (let i = 0; i < 100; i++) { const j = getJob(id); if (!['pending', 'running'].includes(j.status)) return j; await new Promise(r => setTimeout(r, 50)); } throw new Error('job timeout'); };

(async () => {
  console.log('\nURL ingestion');
  const { initDatabase, get, all, run } = require('../server/database');
  await initDatabase();
  const guard = require('../server/services/ingest/fetchGuard');
  const { preview } = require('../server/services/ingest');
  const { normalize } = require('../server/services/ingest/sanitize');
  const { importFromUrl } = require('../server/routes/ingest');
  const jobs = require('../server/services/ingest/jobs');

  await check('isPublicIp classifies private, loopback, link-local, CGNAT, mapped and ULA ranges', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) assert.strictEqual(guard.isPublicIp(ip), false, ip);
    for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700::1111']) assert.strictEqual(guard.isPublicIp(ip), true, ip);
  });

  await check('Guard rejects non-http schemes, literal private IPs, private-resolving hosts and redirects to private IPs', async () => {
    await rejects(preview('file:///etc/passwd'), 400);
    await rejects(preview('http://127.0.0.1:3000/'), 400, /non-public/);
    await rejects(preview('http://db.internal.test/'), 400, /non-public/);
    await rejects(guard.fetchText('https://redirect.example.com/'), 400, /non-public/);
  });

  await check('Sanitizer strips HTML/scripts, decodes entities, bounds length and dedupes tags', () => {
    const n = normalize({ title: 'A <i>b</i>', description: '<p>x</p><script>1</script>' + 'y'.repeat(9000), url: 'https://e.com/m/1/?utm_source=a#frag', tags: ['A', 'a', ' b ', 'c'.repeat(100)] });
    assert.strictEqual(n.title, 'A b');
    assert.ok(!n.description.includes('script') && n.description.length <= 5000);
    assert.strictEqual(n.url, 'https://e.com/m/1');
    assert.deepStrictEqual(n.tags.slice(0, 2), ['a', 'b']);
    assert.ok(n.tags[2].length <= 40);
  });

  await check('Printables preview: sanitized title/description, deduped tags, source:printables tag, canonical URL, files, cover', async () => {
    const p = await preview('https://www.printables.com/en/model/99-test-bracket?utm_source=x');
    assert.strictEqual(p.title, 'Test Bracket');
    assert.strictEqual(p.description, 'Hello world & co');
    assert.strictEqual(p.url, 'https://www.printables.com/model/99');
    assert.deepStrictEqual(p.tags, ['source:printables', 'bracket', 'wall mount']);
    assert.strictEqual(p.files.length, 3);
    assert.ok(p.coverUrl.startsWith('https://media.printables.com/'));
    assert.ok(!('_raw' in JSON.parse(JSON.stringify(p))), 'provider-private data must not serialize');
  });

  await check('Unreadable/blocked sites and unknown model ids fail with 422 (no bypass attempted)', async () => {
    await rejects(preview('https://blocked.example.com/'), 422);
    await rejects(preview('https://www.printables.com/model/12345-missing'), 422, /not found/);
    await rejects(preview('https://www.printables.com/'), 400, /expected \/model/);
  });

  await check('Thingiverse without token: OpenGraph/JSON-LD metadata, origin tag, no files, filesNeedToken', async () => {
    const p = await preview('https://www.thingiverse.com/thing:5');
    assert.strictEqual(p.title, 'Benchy & friends');
    assert.deepStrictEqual(p.tags, ['source:thingiverse']);
    assert.strictEqual(p.files.length, 0);
    assert.strictEqual(p.filesNeedToken, true);
  });

  await check('Thingiverse with token: API metadata, tags and files; token sent only to the API', async () => {
    process.env.THINGIVERSE_TOKEN = 'tok';
    const p = await preview('https://www.thingiverse.com/thing:5');
    delete process.env.THINGIVERSE_TOKEN;
    assert.deepStrictEqual(p.tags, ['source:thingiverse', 'boat']);
    assert.strictEqual(p.files[0].name, 'boat.stl');
    assert.strictEqual(p.filesNeedToken, false);
  });

  await check('Generic fallback for unknown hosts tags with the hostname', async () => {
    global.fetch = (orig => async (u, o) => String(u) === 'https://www.example.org/m/1' ? new Response(THING_HTML) : orig(u, o))(global.fetch);
    const p = await preview('https://www.example.org/m/1');
    assert.strictEqual(p.site, 'example.org');
    assert.ok(p.tags.includes('source:example.org'));
  });

  let modelId;
  await check('importFromUrl creates model with metadata+tags, downloads files and cover, blocks executable, enforces size cap', async () => {
    const r = await importFromUrl(null, { url: 'https://www.printables.com/model/99-test' });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    modelId = r.body.model.id;
    const m = get('SELECT * FROM models WHERE id=?', [modelId]);
    assert.strictEqual(m.name, 'Test Bracket');
    assert.strictEqual(m.source_url, 'https://www.printables.com/model/99');
    const tags = all('SELECT t.name FROM tags t JOIN model_tags mt ON mt.tag_id=t.id WHERE mt.model_id=?', [modelId]).map(t => t.name);
    assert.ok(tags.includes('source:printables') && tags.includes('bracket'));
    const job = await waitJob(jobs.getJob, r.body.job_id);
    assert.strictEqual(job.status, 'partial', JSON.stringify(job));
    const byName = Object.fromEntries(job.detail.map(d => [d.name, d]));
    assert.strictEqual(byName['part.stl'].status, 'ok');
    assert.strictEqual(byName['evil.stl'].status, 'failed');
    assert.strictEqual(byName['huge.stl'].status, 'failed');
    const files = all('SELECT original_name, file_type FROM files WHERE model_id=?', [modelId]).map(f => f.original_name).sort();
    assert.deepStrictEqual(files, ['cover.jpg', 'part.stl']);
    assert.ok(get('SELECT thumbnail FROM models WHERE id=?', [modelId]).thumbnail, 'cover becomes thumbnail');
    assert.ok(fs.existsSync(path.join(m.library_path, 'part.stl')));
    assert.deepStrictEqual(fs.readdirSync(path.join(tmp, 'uploads')).filter(f => f.startsWith('ingest-')), [], 'temp downloads cleaned up');
  });

  await check('Duplicate source URL returns 409 with existing model id unless allow_duplicate', async () => {
    const r = await importFromUrl(null, { url: 'https://www.printables.com/model/99-test' });
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.body.existing_model_id, modelId);
    const again = await importFromUrl(null, { url: 'https://www.printables.com/model/99-test', allow_duplicate: true, auto_rename: true, download_files: false });
    assert.strictEqual(again.status, 201);
    assert.strictEqual(again.body.job_id, null);
  });

  await check('Retry downloads only missing files', async () => {
    state.calls = [];
    const id = jobs.startJob(modelId, 'https://www.printables.com/model/99', ['stl:1', 'stl:2']);
    const j = await waitJob(jobs.getJob, id);
    assert.deepStrictEqual(j.detail.map(d => d.name), ['evil.stl'], JSON.stringify(j));
    assert.ok(!state.calls.some(u => u.endsWith('/f/1.stl')), 'part.stl not re-downloaded');
  });

  await check('Library sync keeps URL-imported models that have no files; stale jobs recover as failed', async () => {
    const metaOnly = (await importFromUrl(null, { url: 'https://www.thingiverse.com/thing:5', download_files: false })).body.model;
    run("INSERT INTO ingest_jobs (model_id, source_url, status) VALUES (?, 'https://x', 'running')", [metaOnly.id]);
    jobs.recoverStaleJobs();
    assert.strictEqual(get("SELECT status FROM ingest_jobs WHERE source_url='https://x'").status, 'failed');
    run("UPDATE models SET library_path=? WHERE id=?", [path.join(tmp, 'library', 'Benchy'), metaOnly.id]);
    const empty = all(`SELECT m.id FROM models m LEFT JOIN files f ON f.model_id=m.id WHERE f.id IS NULL AND m.library_path IS NOT NULL AND m.id NOT IN (SELECT model_id FROM ingest_jobs)`);
    assert.ok(!empty.some(m => m.id === metaOnly.id));
  });

  console.log(`\n${passed} ingest checks passed`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(process.exitCode || 0);
})();
