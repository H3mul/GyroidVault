/**
 * Source update tracking tests (detection, scheduler, update-as-new-version, metadata refresh).
 * Offline: network is stubbed (tests/helpers/ingest-stubs.js). Run via node tests/ingest-updates-check.js.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-upd-'));
process.env.DATA_DIR = tmp;
process.env.LIBRARY_PATH = path.join(tmp, 'library');
delete process.env.THINGIVERSE_TOKEN;
const { STL, EXE, state, addModel } = require('./helpers/ingest-stubs');
const STL2 = Buffer.concat([STL, Buffer.from('v2')]), STL3 = Buffer.concat([STL, Buffer.from('v3')]);

let passed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (e) { console.error(`  \x1b[31m✗\x1b[0m ${name}\n    ${e.stack}`); process.exitCode = 1; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const rejects = (p, status) => p.then(() => assert.fail('expected rejection'), e => assert.strictEqual(e.status, status, e.message));

(async () => {
  console.log('\nSource update tracking');
  const { initDatabase, get, all, run } = require('../server/database');
  await initDatabase();
  const U = require('../server/services/ingest/updates');
  const S = require('../server/services/ingest/sync');
  const jobs = require('../server/services/ingest/jobs');
  const { importFromUrl } = require('../server/routes/ingest');
  const { syncLibraryWithDisk } = require('../server/services/backgroundTasks');

  const waitJob = async id => { for (let i = 0; i < 200; i++) { const j = jobs.getJob(id); if (!['pending', 'running'].includes(j.status)) return j; await sleep(25); } throw new Error('job timeout'); };
  const importModel = async id => {
    const r = await importFromUrl(null, { url: `https://www.printables.com/model/${id}-x`, auto_rename: true });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    if (r.body.job_id) await waitJob(r.body.job_id);
    return r.body.model.id;
  };
  const bump = (m, ts) => { m.modified = ts; };
  const srcState = id => get('SELECT * FROM model_sources WHERE model_id=?', [id]);
  const names = id => all('SELECT original_name FROM files WHERE model_id=?', [id]).map(f => f.original_name).sort();
  const familyLatest = root => (get('SELECT id FROM models WHERE parent_id=? ORDER BY created_at DESC, id DESC LIMIT 1', [root]) || { id: root }).id;
  const newModelsCount = () => get('SELECT COUNT(*) c FROM models').c;

  // ── pure classification ──
  const f = (id, name, size) => ({ id, name, size });
  const base = { remote_modified: '2026-01-01T00:00:00.000Z', files: [f('1', 'a.stl', 10), f('2', 'b.stl', 20)], meta: { title: 'T', description: 'D', tags: ['x'] } };
  const rem = (o = {}) => ({ remoteModified: '2026-01-01T00:00:00.000Z', files: [f('1', 'a.stl', 10), f('2', 'b.stl', 20)], title: 'T', description: 'D', tags: ['source:printables', 'x'], ...o });

  await check('classify: identical, timestamp-only bump, and tag-order differences are current', () => {
    assert.strictEqual(U.classify(base, rem()).state, 'current');
    assert.strictEqual(U.classify(base, rem({ remoteModified: '2027-01-01T00:00:00.000Z' })).state, 'current');
    assert.strictEqual(U.classify(base, rem({ tags: ['x', 'source:printables'] })).state, 'current');
  });
  await check('classify: new, removed, renamed, resized and re-uploaded files are outdated with a precise diff', () => {
    let c = U.classify(base, rem({ files: [...rem().files, f('3', 'c.stl', 1)] }));
    assert.strictEqual(c.state, 'outdated'); assert.deepStrictEqual(c.added.map(x => x.name), ['c.stl']);
    c = U.classify(base, rem({ files: [f('1', 'a.stl', 10)] }));
    assert.deepStrictEqual(c.removed.map(x => x.name), ['b.stl']);
    c = U.classify(base, rem({ files: [f('1', 'a.stl', 10), f('2', 'b2.stl', 20)] }));
    assert.deepStrictEqual([c.added.map(x => x.name), c.removed.map(x => x.name)], [['b2.stl'], ['b.stl']]);
    c = U.classify(base, rem({ files: [f('1', 'a.stl', 11), f('2', 'b.stl', 20)] }));
    assert.deepStrictEqual(c.changed.map(x => x.name), ['a.stl']);
    c = U.classify(base, rem({ files: [f('9', 'a.stl', 10), f('2', 'b.stl', 20)] }));
    assert.deepStrictEqual(c.changed.map(x => x.name), ['a.stl'], 'same name and size but new file id counts as re-upload');
  });
  await check('classify: title/description/tag edits alone are metadata_changed, not outdated', () => {
    for (const o of [{ title: 'T2' }, { description: 'D2' }, { tags: ['source:printables', 'x', 'y'] }]) assert.strictEqual(U.classify(base, rem(o)).state, 'metadata_changed');
  });
  await check('classify: without a file list only a newer timestamp counts (unknown_changed); legacy snapshots skip metadata diff', () => {
    const noFiles = { ...base, files: null };
    assert.strictEqual(U.classify(noFiles, rem({ remoteModified: '2027-01-01T00:00:00.000Z' })).state, 'unknown_changed');
    assert.strictEqual(U.classify(noFiles, rem()).state, 'current');
    assert.strictEqual(U.classify(base, rem({ filesNeedToken: true, files: [], remoteModified: '2027-01-01T00:00:00.000Z' })).state, 'unknown_changed');
    assert.strictEqual(U.classify({ ...base, files: null, meta: null }, rem({ title: 'whatever' })).state, 'current');
    assert.strictEqual(U.classify({ remote_modified: null, files: null, meta: null }, rem()).state, 'unknown_changed', 'no baseline time: any remote time is newer');
  });

  // ── import writes the snapshot ──
  const M77 = addModel(77, [{ id: 11, name: 'a.stl', body: STL }, { id: 12, name: 'b.stl', body: STL2 }], { name: 'Model 77', tags: [{ name: 'alpha' }] });
  let A;
  await check('Import records a source snapshot (modified time, file fingerprint, imported metadata) with state current', async () => {
    A = await importModel(77);
    const s = U.parseRow(srcState(A));
    assert.strictEqual(s.site, 'printables'); assert.strictEqual(s.remote_modified, '2026-01-01T00:00:00.000Z');
    assert.deepStrictEqual(s.files.map(x => x.name), ['a.stl', 'b.stl']);
    assert.strictEqual(s.meta.title, 'Model 77'); assert.strictEqual(s.state, 'current'); assert.ok(s.remote_key);
    // metadata-only one-shot import still gets tracked
    const r = await importFromUrl(null, { url: 'https://www.printables.com/model/77-x', allow_duplicate: true, auto_rename: true, download_files: false });
    assert.ok(srcState(r.body.model.id));
  });

  // ── detection ──
  await check('Check: unchanged source stays current; a timestamp-only bump advances the stored time without flagging', async () => {
    assert.strictEqual((await U.checkModel(A)).state, 'current');
    bump(M77, '2026-02-01T00:00:00+00:00');
    assert.strictEqual((await U.checkModel(A)).state, 'current');
    assert.strictEqual(srcState(A).remote_modified, '2026-02-01T00:00:00.000Z');
  });
  await check('Check: description-only edit is metadata_changed; not shown as an update in the library filter', async () => {
    M77.description = '<p>New words</p>';
    const r = await U.checkModel(A);
    assert.strictEqual(r.state, 'metadata_changed'); assert.ok(r.summary.metaDiff.description);
    assert.ok(!get(`SELECT ms.state FROM model_sources ms WHERE ms.model_id=? AND ms.state IN ('outdated','unknown_changed')`, [A]));
    M77.description = '<p>Desc 77</p>';
    // restore: snapshot still has the old description, so reset by refreshing
    await S.refreshMetadata(A);
    assert.strictEqual(srcState(A).state, 'current');
  });
  await check('Check: transient failures keep state and back off; three not-found results mark source_unavailable; recovery resets', async () => {
    state.mode = 'rate_limit';
    let r = await U.checkModel(A);
    assert.deepStrictEqual([r.ok, r.code, srcState(A).state, srcState(A).fail_count], [false, 'rate_limited', 'current', 1]);
    assert.ok(srcState(A).next_check_at > srcState(A).last_checked_at, 'backed off into the future');
    state.mode = 'offline'; r = await U.checkModel(A); assert.strictEqual(srcState(A).state, 'current');
    state.mode = 'not_found';
    await U.checkModel(A); await U.checkModel(A);
    assert.strictEqual(srcState(A).state, 'current', 'two misses are not enough');
    await U.checkModel(A);
    assert.strictEqual(srcState(A).state, 'source_unavailable');
    assert.ok(get('SELECT 1 FROM models WHERE id=?', [A]) && names(A).length === 3, 'model and files untouched');
    state.mode = null;
    r = await U.checkModel(A);
    assert.deepStrictEqual([r.state, srcState(A).miss_count, srcState(A).fail_count, srcState(A).last_error], ['current', 0, 0, null]);
  });
  await check('Dismiss hides an update until the source changes again', async () => {
    M77.stls.push({ id: '15', name: 'extra.stl', fileSize: STL.length }); state.files[15] = STL;
    assert.strictEqual((await U.checkModel(A)).state, 'outdated');
    assert.strictEqual(U.sourceInfo(A).dismissed, false);
    U.dismiss(A);
    assert.strictEqual(U.sourceInfo(A).dismissed, true);
    await U.checkModel(A);
    assert.strictEqual(U.sourceInfo(A).dismissed, true, 'same remote state stays dismissed');
    M77.stls.push({ id: '16', name: 'extra2.stl', fileSize: STL.length }); state.files[16] = STL;
    await U.checkModel(A);
    assert.strictEqual(U.sourceInfo(A).dismissed, false);
    M77.stls = M77.stls.filter(s => !['15', '16'].includes(s.id));
    await U.checkModel(A);
    assert.strictEqual(srcState(A).state, 'current');
  });

  // ── legacy and opt-in ──
  await check('Legacy imports (origin tag, no snapshot): estimated from created_at; become real snapshots when current; unsupported sources refused', async () => {
    const mk = (name, created, url) => { const id = run("INSERT INTO models (name, source_url, created_at, description) VALUES (?,?,?,'d')", [name, url, created]).lastId; run("INSERT OR IGNORE INTO tags (name) VALUES ('source:printables')"); run('INSERT INTO model_tags (model_id, tag_id) SELECT ?, id FROM tags WHERE name=?', [id, 'source:printables']); return id; };
    const old = mk('Legacy old', '2020-01-01 00:00:00', 'https://www.printables.com/model/77');
    const fresh = mk('Legacy fresh', '2099-01-01 00:00:00', 'https://www.printables.com/model/77');
    const r1 = await U.checkModel(old);
    assert.strictEqual(r1.state, 'unknown_changed'); assert.strictEqual(r1.summary.estimate, true);
    const r2 = await U.checkModel(fresh);
    assert.strictEqual(r2.state, 'current'); assert.ok(U.parseRow(srcState(fresh)).files, 'baseline upgraded to a real snapshot');
    const manual = run("INSERT INTO models (name, source_url) VALUES ('Manual','https://example.com/x')").lastId;
    await rejects(U.checkModel(manual), 400); await rejects(U.trackModel(manual), 400);
    const noSrc = run("INSERT INTO models (name) VALUES ('No src')").lastId;
    await rejects(U.trackModel(noSrc), 400);
  });
  await check('Track updates on an existing model with a supported source link creates a current baseline', async () => {
    const id = run("INSERT INTO models (name, source_url) VALUES ('Hand made','https://www.printables.com/model/77-whatever')").lastId;
    const info = await U.trackModel(id);
    assert.deepStrictEqual([info.tracked, info.state, info.site], [true, 'current', 'printables']);
  });

  // ── update as new version ──
  let V, W, jobA;
  await check('Update from source creates a new latest version: unchanged file copied (not downloaded), changed/new downloaded, old version untouched', async () => {
    run("UPDATE models SET print_tips='tip', description='My notes' WHERE id=?", [A]);
    const aFilesBefore = names(A);
    M77.stls = [{ id: '11', name: 'a.stl', fileSize: STL.length }, { id: '13', name: 'b.stl', fileSize: STL3.length }, { id: '14', name: 'c.stl', fileSize: STL.length }];
    state.files[13] = STL3; state.files[14] = STL; M77.name = 'Model 77 Pro'; bump(M77, '2026-03-01T00:00:00+00:00');
    assert.strictEqual((await U.checkModel(A)).state, 'outdated');
    const pv = await S.updatePreview(A);
    assert.deepStrictEqual(pv.files.map(x => [x.name, x.status]), [['a.stl', 'unchanged'], ['b.stl', 'changed'], ['c.stl', 'new']]);
    state.calls = [];
    jobA = await waitJob(S.startUpdateJob(A, null, null));
    assert.strictEqual(jobA.status, 'completed', JSON.stringify(jobA));
    V = jobA.result_model_id;
    const v = get('SELECT * FROM models WHERE id=?', [V]);
    assert.strictEqual(v.parent_id, A); assert.strictEqual(familyLatest(A), V);
    assert.deepStrictEqual(names(V), ['a.stl', 'b.stl', 'c.stl', 'cover.jpg']);
    assert.ok(!state.calls.some(u => u.includes('/f/11.stl')), 'unchanged a.stl was not downloaded');
    assert.ok(state.calls.some(u => u.includes('/f/13.stl')) && state.calls.some(u => u.includes('/f/14.stl')));
    assert.deepStrictEqual(names(A), aFilesBefore, 'old version files untouched');
    assert.strictEqual(fs.readFileSync(path.join(v.library_path, 'b.stl')).length, STL3.length);
    assert.ok(fs.existsSync(path.join(get('SELECT library_path p FROM models WHERE id=?', [A]).p, 'b.stl')), 'old folder untouched');
    assert.strictEqual(v.name, 'Model 77 Pro (v2)', 'unedited title follows the source');
    assert.strictEqual(v.print_tips, 'tip'); assert.strictEqual(v.source_url, 'https://www.printables.com/model/77');
    const tags = all('SELECT t.name FROM tags t JOIN model_tags mt ON mt.tag_id=t.id WHERE mt.model_id=?', [V]).map(t => t.name);
    assert.ok(tags.includes('alpha') && tags.includes('source:printables'));
    assert.strictEqual(srcState(V).state, 'current'); assert.strictEqual(U.parseRow(srcState(V)).files.length, 3);
  });
  await check('Metadata the user edited is kept and reported; the version carries the user description', async () => {
    assert.strictEqual(get('SELECT description d FROM models WHERE id=?', [V]).d, 'My notes');
    assert.match(jobA.error, /description/);
    assert.ok(!/title/.test(jobA.error));
  });
  await check('Updating a version joins the same root family and becomes latest (v3)', async () => {
    M77.stls.push({ id: '17', name: 'd.stl', fileSize: STL.length }); state.files[17] = STL; bump(M77, '2026-04-01T00:00:00+00:00');
    assert.strictEqual((await U.checkModel(V)).state, 'outdated');
    const j = await waitJob(S.startUpdateJob(V, null, null));
    W = j.result_model_id;
    assert.strictEqual(get('SELECT parent_id p FROM models WHERE id=?', [W]).p, A);
    assert.strictEqual(familyLatest(A), W);
    assert.strictEqual(get('SELECT name n FROM models WHERE id=?', [W]).n, 'Model 77 Pro (v3)');
    assert.strictEqual(names(W).filter(n => n.endsWith('.stl')).length, 4);
  });
  await check('Scheduler checks only the latest version of a family', async () => {
    for (const id of [A, V, W]) run('UPDATE model_sources SET next_check_at=NULL, last_checked_at=NULL WHERE model_id=?', [id]);
    await U.runScheduledChecks({ sleep: async () => {}, minGapMs: 0 });
    assert.ok(srcState(W).last_checked_at, 'latest checked');
    assert.strictEqual(srcState(A).last_checked_at, null); assert.strictEqual(srcState(V).last_checked_at, null);
  });
  await check('Only one update job per model at a time (409), and a missing model is 404', async () => {
    M77.stls.push({ id: '18', name: 'e.stl', fileSize: STL.length }); state.files[18] = STL; bump(M77, '2026-05-01T00:00:00+00:00');
    const first = S.startUpdateJob(W, null, null);
    assert.throws(() => S.startUpdateJob(W, null, null), e => e.status === 409);
    await waitJob(first);
    assert.throws(() => S.startUpdateJob(99999, null, null), e => e.status === 404);
  });

  // ── failure handling ──
  await check('No version is created when every download fails, is rejected, or the source offers no files; the old version stays latest', async () => {
    const before = newModelsCount();
    const m78 = addModel(78, [{ id: 31, name: 'e.stl', body: EXE }]);          // executable disguised as STL
    const id78 = await importModel(78);
    m78.stls.push({ id: '32', name: 'f.stl', fileSize: 5 }); state.files[32] = EXE; bump(m78, '2026-06-01T00:00:00+00:00');
    let j = await waitJob(S.startUpdateJob(id78, null, null));
    assert.strictEqual(j.status, 'failed'); assert.strictEqual(j.result_model_id, null);
    assert.strictEqual(familyLatest(id78), id78);
    const m79 = addModel(79, [{ id: 33, name: 'g.stl', body: STL }]);
    const id79 = await importModel(79);
    m79.stls = [{ id: '34', name: 'g.stl', fileSize: 5 }]; delete state.files[34]; bump(m79, '2026-06-01T00:00:00+00:00'); // file 404s
    j = await waitJob(S.startUpdateJob(id79, null, null));
    assert.strictEqual(j.status, 'failed'); assert.match(j.error, /HTTP 404|No files/i);
    assert.strictEqual(familyLatest(id79), id79);
    m79.stls = []; bump(m79, '2026-07-01T00:00:00+00:00');
    j = await waitJob(S.startUpdateJob(id79, null, null));
    assert.strictEqual(j.status, 'failed'); assert.match(j.error, /no downloadable files/i);
    assert.strictEqual(newModelsCount(), before + 2, 'only the two imported models were added');
    assert.deepStrictEqual(U.parseRow(srcState(id79)).files.map(x => x.id), ['stl:33']);
  });
  await check('Partial update: version is created with the files that worked; failures are listed', async () => {
    const m80 = addModel(80, [{ id: 41, name: 'g.stl', body: STL }, { id: 42, name: 'h.stl', body: STL2 }]);
    const id80 = await importModel(80);
    m80.stls = [{ id: '41', name: 'g.stl', fileSize: STL.length }, { id: '43', name: 'h.stl', fileSize: 9 }]; delete state.files[43]; bump(m80, '2026-06-01T00:00:00+00:00');
    const j = await waitJob(S.startUpdateJob(id80, null, null));
    assert.strictEqual(j.status, 'partial', JSON.stringify(j));
    assert.deepStrictEqual(names(j.result_model_id), ['cover.jpg', 'g.stl']);
    assert.ok(j.detail.some(d => d.name === 'h.stl' && d.status === 'failed'));
    assert.strictEqual(familyLatest(id80), j.result_model_id);
  });
  await check('Selecting a subset of remote files limits what the new version contains', async () => {
    const m83 = addModel(83, [{ id: 51, name: 'p.stl', body: STL }, { id: 52, name: 'q.stl', body: STL2 }]);
    const id83 = await importModel(83);
    m83.stls.push({ id: '53', name: 'r.stl', fileSize: STL.length }); state.files[53] = STL; bump(m83, '2026-06-01T00:00:00+00:00');
    const j = await waitJob(S.startUpdateJob(id83, ['stl:51', 'stl:53'], null));
    assert.deepStrictEqual(names(j.result_model_id).filter(n => n.endsWith('.stl')), ['p.stl', 'r.stl']);
  });
  await check('Token-less Thingiverse cannot update files: job fails cleanly with guidance and no version', async () => {
    const id = (await importFromUrl(null, { url: 'https://www.thingiverse.com/thing:5', download_files: false })).body.model.id;
    const before = newModelsCount();
    const j = await waitJob(S.startUpdateJob(id, null, null));
    assert.strictEqual(j.status, 'failed'); assert.match(j.error, /THINGIVERSE_TOKEN/);
    assert.strictEqual(newModelsCount(), before);
  });

  // ── metadata refresh ──
  await check('Metadata refresh: unedited title follows source, edited description kept, tags only added, files untouched, state recomputed', async () => {
    const m81 = addModel(81, [{ id: 61, name: 'k.stl', body: STL }], { name: 'Old Title', tags: [{ name: 'alpha' }] });
    const id81 = await importModel(81);
    run("UPDATE models SET description='mine' WHERE id=?", [id81]);
    run("INSERT OR IGNORE INTO tags (name) VALUES ('user-tag')"); run("INSERT INTO model_tags (model_id, tag_id) SELECT ?, id FROM tags WHERE name='user-tag'", [id81]);
    m81.name = 'New Title'; m81.description = '<p>remote new</p>'; m81.tags = [{ name: 'beta' }];
    assert.strictEqual((await U.checkModel(id81)).state, 'metadata_changed');
    const r = await S.refreshMetadata(id81);
    const m = get('SELECT * FROM models WHERE id=?', [id81]);
    assert.deepStrictEqual([m.name, m.description, r.kept, r.state], ['New Title', 'mine', ['description'], 'current']);
    const tags = all('SELECT t.name FROM tags t JOIN model_tags mt ON mt.tag_id=t.id WHERE mt.model_id=?', [id81]).map(t => t.name).sort();
    assert.deepStrictEqual(tags, ['alpha', 'beta', 'source:printables', 'user-tag']);
    assert.deepStrictEqual(names(id81), ['cover.jpg', 'k.stl']);
    m81.stls.push({ id: '62', name: 'l.stl', fileSize: STL.length }); state.files[62] = STL;
    const r2 = await S.refreshMetadata(id81);
    assert.strictEqual(r2.state, 'outdated', 'a metadata refresh never hides a file update');
  });

  // ── scheduler behavior ──
  await check('Scheduler: respects interval 0, due time, per-run cap, and stops hitting a site that rate-limits', async () => {
    run("INSERT OR REPLACE INTO system_settings (key, value) VALUES ('source_check_interval_hours','0')");
    assert.deepStrictEqual(await U.runScheduledChecks({ sleep: async () => {} }), { skipped: 'disabled' });
    run("INSERT OR REPLACE INTO system_settings (key, value) VALUES ('source_check_interval_hours','24')");
    run('UPDATE model_sources SET next_check_at = datetime(\'now\', \'+5 days\')');
    assert.strictEqual((await U.runScheduledChecks({ sleep: async () => {}, minGapMs: 0 })).checked, 0, 'nothing is due');
    run('UPDATE model_sources SET next_check_at = NULL');
    assert.strictEqual((await U.runScheduledChecks({ sleep: async () => {}, minGapMs: 0, cap: 2 })).checked, 2, 'cap respected');
    run('UPDATE model_sources SET next_check_at = NULL, last_checked_at = NULL, fail_count = 0');
    state.mode = 'rate_limit';
    const r = await U.runScheduledChecks({ sleep: async () => {}, minGapMs: 0 });
    state.mode = null;
    assert.deepStrictEqual(r.skippedSites, ['printables']);
    assert.strictEqual(get("SELECT COUNT(*) c FROM model_sources WHERE site='printables' AND last_checked_at IS NOT NULL AND fail_count > 0").c, 1, 'only the first Printables model was tried');
    assert.ok(get("SELECT COUNT(*) c FROM model_sources WHERE site='printables' AND last_checked_at IS NULL").c > 0, 'the rest were skipped for this pass');
  });
  await check('Scheduler paces requests to the same site', async () => {
    run('UPDATE model_sources SET next_check_at = NULL, last_checked_at = NULL');
    const waits = [];
    await U.runScheduledChecks({ sleep: async ms => { waits.push(ms); }, minGapMs: 1000, jitterMs: 1, cap: 3 });
    assert.ok(waits.length >= 2 && waits.every(w => w > 0 && w <= 1002), JSON.stringify(waits));
  });

  // ── cleanup ──
  await check('Library sync keeps tracked models without files but still removes untracked empty ones', async () => {
    const lib = path.join(tmp, 'library', 'x'); fs.mkdirSync(lib, { recursive: true });
    const tracked = run("INSERT INTO models (name, library_path) VALUES ('Tracked empty', ?)", [lib]).lastId;
    run("INSERT INTO model_sources (model_id, site, source_url) VALUES (?, 'printables', 'https://www.printables.com/model/77')", [tracked]);
    const lib2 = path.join(tmp, 'library', 'y'); fs.mkdirSync(lib2, { recursive: true });
    const untracked = run("INSERT INTO models (name, library_path) VALUES ('Untracked empty', ?)", [lib2]).lastId;
    await syncLibraryWithDisk();
    assert.ok(get('SELECT 1 FROM models WHERE id=?', [tracked]));
    assert.ok(!get('SELECT 1 x FROM models WHERE id=?', [untracked]));
  });
  await check('Startup recovery removes an empty version left behind by an interrupted update job', async () => {
    const empty = run("INSERT INTO models (name, parent_id) VALUES ('Half made', ?)", [A]).lastId;
    run("INSERT INTO ingest_jobs (model_id, source_url, kind, status, result_model_id) VALUES (?, 'https://x', 'update', 'running', ?)", [A, empty]);
    jobs.recoverStaleJobs();
    assert.ok(!get('SELECT 1 x FROM models WHERE id=?', [empty]));
    assert.strictEqual(get("SELECT status s FROM ingest_jobs WHERE result_model_id=?", [empty])?.s ?? 'failed', 'failed');
  });
  await check('Deleting a model removes its snapshot (cascade)', async () => {
    run('DELETE FROM models WHERE id=?', [W]);
    assert.ok(!srcState(W));
  });

  console.log(`\n${passed} update-tracking checks passed`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(process.exitCode || 0);
})();
