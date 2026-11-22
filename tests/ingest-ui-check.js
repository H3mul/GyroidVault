/**
 * Frontend logic tests for URL import (components.js / app.js / api.js) in a vm sandbox with a tiny fake DOM.
 * Not a substitute for a real browser, but exercises the handlers and templates without one.
 * Run via: node tests/ingest-ui-check.js (chained from `npm test`)
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
let passed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (e) { console.error(`  \x1b[31m✗\x1b[0m ${name}\n    ${e.stack}`); process.exitCode = 1; }
}

// ── fake DOM ──
const els = {};
const mk = (id, extra = {}) => (els[id] = { id, innerHTML: '', textContent: '', value: '', disabled: false, style: {}, children: [], classList: { add() {}, remove() {}, toggle() {} },
  appendChild(c) { this.children.push(c); }, focus() {}, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, ...extra });
let timers = [];
const sandbox = {
  window: {}, document: {
    getElementById: id => els[id] || null,
    querySelector: sel => (sel === 'input[name="source_url"]' ? els.__source : null),
    querySelectorAll: () => [], createElement: () => ({ style: {}, classList: { add() {} }, appendChild() {}, set innerHTML(v) { this._h = v; }, get innerHTML() { return this._h; } }),
    body: { appendChild() {}, setAttribute() {}, getAttribute: () => null, classList: { toggle() {}, add() {}, remove() {} }, style: {} },
    documentElement: { setAttribute() {}, getAttribute: () => null }, addEventListener() {},
  },
  localStorage: { _s: {}, getItem(k) { return this._s[k] || null; }, setItem(k, v) { this._s[k] = String(v); }, removeItem(k) { delete this._s[k]; } },
  navigator: {}, location: { hash: '', search: '', pathname: '/', origin: 'https://vault.example', reload() {} }, history: { replaceState() {} },
  fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
  FormData: class { constructor(form) { this.f = form.__fields || {}; } get(k) { return k in this.f ? this.f[k] : null; } getAll() { return []; } has(k) { return k in this.f; } },
  URLSearchParams, encodeURIComponent, decodeURIComponent, console,
  setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
};
sandbox.window.document = sandbox.document; sandbox.window.localStorage = sandbox.localStorage; sandbox.window.location = sandbox.location; sandbox.window.history = sandbox.history;
const code = ['api', 'components', 'app'].map(f => fs.readFileSync(path.join(ROOT, `public/js/${f}.js`), 'utf8')).join('\n');
vm.createContext(sandbox);
vm.runInContext(`${code}\nthis.__API = API; this.__UI = UI; this.__App = App;`, sandbox);
const { __API: API, __UI: UI, __App: App } = sandbox;
const realRefreshIngest = App.refreshIngestBanner;
App.currentUser = { id: 1, username: 'u', role: 'admin' };
App.toast = (m, t) => App.__toasts.push([m, t]); App.__toasts = [];

function buildForm(tagBoxes = {}) {
  const src = { value: '' };
  els.__source = src;
  const form = { __fields: {}, elements: { name: { value: '' }, description: { value: '' }, source_url: src },
    querySelector: sel => { const m = sel.match(/value="([^"]*)"/); return m && tagBoxes[m[1]] ? tagBoxes[m[1]] : null; },
    querySelectorAll: () => [] };
  els['model-form'] = form;
  mk('import-url-input', { value: 'https://www.printables.com/model/1-x' }); mk('import-url-status'); mk('import-url-btn'); mk('import-files-list');
  mk('new-tag-input'); mk('model-tags-container');
  return form;
}
const PREVIEW = { title: 'Bracket', description: 'Desc', url: 'https://www.printables.com/model/1', tags: ['source:printables', 'bracket', 'wall mount'], coverUrl: 'https://media.printables.com/c.jpg',
  files: [{ id: 'stl:1', name: 'a<b>.stl', size: 2048 }, { id: 'stl:2', name: 'big.3mf', size: 5 * 1048576 }], filesNeedToken: false, existing_model: null };

(async () => {
  console.log('\nURL import UI');

  await check('API.ingest* methods call the right endpoints', async () => {
    const calls = []; API.request = (u, o) => (calls.push([u, o?.method, o?.body]), Promise.resolve({}));
    await API.ingestPreview('https://x/y'); await API.ingestDownload(5, 'https://x/y', ['stl:1']); await API.ingestJobForModel(5); await API.ingestRetry(9);
    assert.deepStrictEqual(calls.map(c => [c[0], c[1] || 'GET']), [['/api/ingest/preview', 'POST'], ['/api/ingest/download', 'POST'], ['/api/ingest/models/5/job', 'GET'], ['/api/ingest/jobs/9/retry', 'POST']]);
    assert.deepStrictEqual(JSON.parse(calls[1][2]), { model_id: 5, url: 'https://x/y', file_ids: ['stl:1'] });
    assert.strictEqual(API.importModelUrl, undefined, 'dead stub for a non-existent endpoint should be gone');
  });

  await check('New Model form has the import field and bookmarklet; Edit form does not', () => {
    const html = UI.modelForm(null, [], []);
    assert.ok(html.includes('id="import-url-input"') && html.includes('App.importFromUrl()'));
    assert.ok(html.includes('javascript:(function(){window.open(\'https://vault.example/#/import?url=\'+encodeURIComponent(location.href)'), 'bookmarklet targets this instance');
    assert.ok(!UI.modelForm({ id: 3, name: 'x', tags: [] }, [], []).includes('import-url-input'));
  });

  await check('Banner: hidden when completed/none, progress while running, failures + retry when partial, all text escaped', () => {
    assert.strictEqual(UI.ingestBanner(null), '');
    assert.strictEqual(UI.ingestBanner({ id: 1, status: 'completed', detail: [] }), '');
    const run = UI.ingestBanner({ id: 1, model_id: 2, status: 'running', done: 1, total: 3, detail: [] });
    assert.ok(run.includes('1/3') && !run.includes('Retry'));
    const bad = UI.ingestBanner({ id: 7, model_id: 2, status: 'partial', done: 1, total: 2, error: '<script>x</script>', detail: [{ name: '<img src=x onerror=1>', status: 'failed', reason: 'bad "file"' }] });
    assert.ok(bad.includes('App.retryIngest(7,2)'));
    assert.ok(!bad.includes('<img') && !bad.includes('<script>'), 'untrusted text must be escaped');
  });

  await check('importFromUrl fills name/description/source, ticks existing tags, adds new tags, lists files escaped, remembers selection state', async () => {
    const form = buildForm({ 5: { checked: false } });
    App.cache = { tags: [{ id: 5, name: 'Bracket' }], categories: [] };
    API.ingestPreview = async url => { assert.strictEqual(url, 'https://www.printables.com/model/1-x'); return PREVIEW; };
    await App.importFromUrl();
    assert.strictEqual(form.elements.name.value, 'Bracket');
    assert.strictEqual(form.elements.description.value, 'Desc');
    assert.strictEqual(form.elements.source_url.value, 'https://www.printables.com/model/1');
    const kids = els['model-tags-container'].children.map(c => c.innerHTML);
    assert.ok(kids.some(h => h.includes('value="NEW:source:printables"')) && kids.some(h => h.includes('value="NEW:wall mount"')));
    assert.ok(!kids.some(h => h.includes('NEW:bracket')), 'existing tag reused, not recreated');
    const files = els['import-files-list'].innerHTML;
    assert.ok(files.includes('value="stl:1"') && files.includes('5.0 MB') && files.includes('2 KB'));
    assert.ok(!files.includes('a<b>'), 'file names escaped');
    assert.deepStrictEqual(App.pendingImport.url, PREVIEW.url);
    assert.strictEqual(els['import-url-btn'].disabled, false);
  });

  await check('importFromUrl failure keeps the form usable: error shown, URL kept as source, no pending import', async () => {
    const form = buildForm(); App.pendingImport = { url: 'stale' };
    API.ingestPreview = async () => { throw new Error('Site answered HTTP 403'); };
    await App.importFromUrl();
    assert.strictEqual(App.pendingImport, null);
    assert.ok(els['import-url-status'].textContent.includes('Site answered HTTP 403'));
    assert.strictEqual(form.elements.source_url.value, 'https://www.printables.com/model/1-x');
    assert.strictEqual(els['import-url-btn'].disabled, false);
  });

  await check('Files-need-token and no-files hints render instead of a checklist', () => {
    mk('import-files-list');
    App.renderImportFiles({ files: [], filesNeedToken: true });
    assert.ok(els['import-files-list'].innerHTML.includes('THINGIVERSE_TOKEN'));
    App.renderImportFiles({ files: [], filesNeedToken: false });
    assert.ok(els['import-files-list'].innerHTML.includes('No downloadable files'));
  });

  const submit = (chosen, extra = {}) => {
    const target = { __fields: { name: 'Bracket', description: '', print_tips: '', source_url: 'u', category_id: '' },
      querySelectorAll: sel => (sel.includes('import_files') ? chosen.map(v => ({ value: v })) : []) };
    return App.handleModelSubmit({ preventDefault() {}, target, ...extra }, null);
  };
  const stubSave = () => { const log = { downloads: [], nav: [] };
    API.createModel = async () => ({ id: 42 }); API.ingestDownload = async (...a) => { log.downloads.push(a); return { job_id: 1 }; };
    App.closeModal = () => {}; App.navigate = p => log.nav.push(p); App.pendingFiles = []; return log; };

  await check('Saving an imported model starts the download job with only the ticked files', async () => {
    const log = stubSave(); App.pendingImport = { url: 'https://www.printables.com/model/1', files: [], coverUrl: '' };
    await submit(['stl:1']);
    assert.strictEqual(JSON.stringify(log.downloads), JSON.stringify([[42, 'https://www.printables.com/model/1', ['stl:1']]])); // JSON: arrays cross vm realms
    assert.deepStrictEqual(log.nav, ['/models/42']);
    assert.strictEqual(App.pendingImport, null);
  });

  await check('Cover-only import still starts a job; nothing ticked and no cover does not; plain create never does', async () => {
    let log = stubSave(); App.pendingImport = { url: 'u', files: [], coverUrl: 'https://c/x.jpg' };
    await submit([]); assert.strictEqual(log.downloads.length, 1);
    log = stubSave(); App.pendingImport = { url: 'u', files: [], coverUrl: '' };
    await submit([]); assert.strictEqual(log.downloads.length, 0);
    log = stubSave(); App.pendingImport = null;
    await submit([]); assert.strictEqual(log.downloads.length, 0);
  });

  await check('If the download job cannot start, the model is still created, the user is told, and navigation proceeds', async () => {
    const log = stubSave(); App.__toasts = [];
    API.ingestDownload = async () => { throw new Error('Too many import requests'); };
    App.pendingImport = { url: 'u', files: [], coverUrl: '' };
    await submit(['stl:1']);
    assert.deepStrictEqual(log.nav, ['/models/42']);
    assert.ok(App.__toasts.some(([m, t]) => t === 'error' && m.includes('Too many import requests')));
  });

  await check('Banner polling: polls while active, re-renders the page once when done, stops without a banner element, ignores API errors', async () => {
    mk('ingest-banner'); timers = [];
    const seq = [{ id: 1, model_id: 3, status: 'running', done: 0, total: 2, detail: [] }, { id: 1, model_id: 3, status: 'completed', done: 2, total: 2, detail: [] }];
    let i = 0, rerenders = 0, apiCalls = 0;
    API.ingestJobForModel = async () => { apiCalls++; return seq[Math.min(i++, 1)]; };
    App.renderModelDetail = async id => { rerenders++; assert.strictEqual(id, 3); };
    await App.refreshIngestBanner(3);
    assert.ok(els['ingest-banner'].innerHTML.includes('Importing files')); assert.strictEqual(timers.length, 1); assert.strictEqual(timers[0].ms, 2000);
    await timers[0].fn(); await sleepTick();
    assert.strictEqual(rerenders, 1); assert.strictEqual(timers.length, 1, 'no further timer after completion');
    delete els['ingest-banner']; const before = apiCalls; await App.refreshIngestBanner(3); assert.strictEqual(apiCalls, before, 'no request when the page changed');
    mk('ingest-banner'); API.ingestJobForModel = async () => { throw new Error('offline'); }; await App.refreshIngestBanner(3);
    assert.strictEqual(timers.length, 1);
  });

  await check('Deep link #/import?url= opens New Model and imports that URL', async () => {
    const stubs = ['toggleMobileSidebar', 'renderBulkBar', 'renderBulkBrowseBar'];
    stubs.forEach(n => (App[n] = () => {}));
    const nav = []; App.navigate = p => nav.push(p);
    let imported = null; buildForm();
    App.showCreateModel = async () => {}; App.importFromUrl = () => { imported = els['import-url-input'].value; };
    sandbox.location.hash = '#/import?url=' + encodeURIComponent('https://www.printables.com/model/9-z?x=1&y=2');
    App.route(); await sleepTick();
    assert.deepStrictEqual(nav, ['/models']);
    assert.strictEqual(imported, 'https://www.printables.com/model/9-z?x=1&y=2');
  });

  // ── source update tracking UI ──
  const info = (o = {}) => ({ tracked: true, supported: true, site: 'printables', source_url: 'https://www.printables.com/model/1', state: 'current', dismissed: false, summary: null, last_checked_at: '2026-11-22 03:00:00', last_error: null, estimate: false, ...o });

  await check('API.source* methods call the right endpoints', async () => {
    const calls = []; API.request = (u, o) => (calls.push([u, o?.method || 'GET', o?.body]), Promise.resolve({}));
    await API.sourceInfo(4); await API.sourceCheck(4); await API.sourceTrack(4); await API.sourceDismiss(4); await API.sourceUpdatePreview(4); await API.sourceUpdate(4, ['stl:1']); await API.sourceRefreshMetadata(4); await API.checkAllSources();
    assert.strictEqual(JSON.stringify(calls.map(c => [c[0], c[1]])), JSON.stringify([
      ['/api/ingest/models/4/source', 'GET'], ['/api/ingest/models/4/check', 'POST'], ['/api/ingest/models/4/track', 'POST'], ['/api/ingest/models/4/dismiss', 'POST'],
      ['/api/ingest/models/4/update-preview', 'POST'], ['/api/ingest/models/4/update', 'POST'], ['/api/ingest/models/4/refresh-metadata', 'POST'], ['/api/ingest/check-all', 'POST']]));
    assert.deepStrictEqual(JSON.parse(calls[5][2]), { file_ids: ['stl:1'] });
  });

  await check('Source banner: nothing for unsupported sources; Track button when untracked; quiet line when current', () => {
    assert.strictEqual(UI.sourceBanner(null, 1), '');
    assert.strictEqual(UI.sourceBanner({ tracked: false, supported: false }, 1), '');
    assert.ok(UI.sourceBanner({ tracked: false, supported: true, site: 'printables' }, 7).includes('App.trackSource(7)'));
    const cur = UI.sourceBanner(info(), 7);
    assert.ok(cur.includes('Tracking printables') && cur.includes('App.checkSourceNow(7)') && !cur.includes('Update from source'));
  });
  await check('Source banner: outdated shows counts and actions; dismissed returns to the quiet line; unknown_changed explains the estimate', () => {
    const out = UI.sourceBanner(info({ state: 'outdated', summary: { added: [{}, {}], changed: [{}], removed: [] } }), 7);
    assert.ok(out.includes('Update available on printables') && out.includes('2 new, 1 changed, 0 removed'));
    for (const fn of ['openSourceUpdate', 'dismissSource', 'checkSourceNow']) assert.ok(out.includes(`App.${fn}(7)`), fn);
    assert.ok(!UI.sourceBanner(info({ state: 'outdated', dismissed: true, summary: {} }), 7).includes('Update available'));
    const unk = UI.sourceBanner(info({ state: 'unknown_changed', estimate: true, summary: {} }), 7);
    assert.ok(unk.includes('Possibly updated') && unk.includes('an estimate'));
  });
  await check('Source banner: metadata_changed offers refresh; unavailable source is reassuring; last error is shown', () => {
    assert.ok(UI.sourceBanner(info({ state: 'metadata_changed' }), 7).includes('App.refreshSourceMeta(7)'));
    const gone = UI.sourceBanner(info({ state: 'source_unavailable' }), 7);
    assert.ok(gone.includes('no longer available') && gone.includes('Your files are untouched'));
    assert.ok(UI.sourceBanner(info({ last_error: 'Printables answered HTTP 429' }), 7).includes('HTTP 429'));
  });
  await check('Source banner escapes every untrusted value and neutralises non-http source links', () => {
    const html = UI.sourceBanner(info({ site: '<img src=x onerror=1>', last_error: '<script>x</script>', source_url: 'javascript:alert(1)', last_checked_at: '"><b>' }), 7);
    assert.ok(!html.includes('<img') && !html.includes('<script>') && !html.includes('javascript:alert') && !html.includes('"><b>'), html);
  });
  await check('Update dialog: per-file checkboxes with status, removed files, metadata note; no submit when files unavailable; escaped', () => {
    const pv = { files: [{ id: 'stl:1', name: 'a<i>.stl', size: 2048, status: 'new' }, { id: 'stl:2', name: 'b.stl', size: 3 * 1048576, status: 'unchanged' }], removed: [{ name: 'old<b>.stl' }], metaDiff: { title: true, description: false, tags: true }, estimate: true };
    const html = UI.sourceUpdateDialog(pv, 9);
    assert.ok(html.includes('value="stl:1" checked') && html.includes('value="stl:2" checked') && html.includes('>new<') && html.includes('>unchanged<'));
    assert.ok(html.includes('3.0 MB') && html.includes('title, tags') && html.includes('estimate') && html.includes('App.runSourceUpdate(9)'));
    assert.ok(!html.includes('<i>') && !html.includes('old<b>'), 'names escaped');
    const tok = UI.sourceUpdateDialog({ files: [], filesNeedToken: true, removed: [], metaDiff: {} }, 9);
    assert.ok(tok.includes('THINGIVERSE_TOKEN') && !tok.includes('runSourceUpdate'));
  });
  await check('Library: card shows an Update badge only when update_state is set; toolbar has the Updates filter', () => {
    assert.ok(UI.modelCard({ id: 1, name: 'x', update_state: 'outdated' }).includes('>Update<'));
    assert.ok(!UI.modelCard({ id: 1, name: 'x', update_state: null }).includes('>Update<'));
    assert.ok(UI.toolbar([], [], [], 'all').includes('id="filter-updates"'));
  });
  await check('Settings form has the check interval (default 24) and a check-all button', () => {
    const f = UI.systemSettingsForm({});
    assert.ok(f.includes('name="source_check_interval_hours" value="24"') && f.includes('App.checkAllSources()'));
    assert.ok(UI.systemSettingsForm({ source_check_interval_hours: '0' }).includes('name="source_check_interval_hours" value="0"'));
  });
  await check('Library filter: "Updates available" is sent as updates=1 and counts as an active filter even in folder view', () => {
    const vals = { 'filter-updates': '1' };
    const real = sandbox.document.getElementById;
    sandbox.document.getElementById = id => (id in vals ? { value: vals[id] } : { value: '' });
    App.libraryViewMode = 'folder'; let hash = null, browsed = false;
    Object.defineProperty(sandbox.window.location, 'hash', { set: v => { hash = v; }, get: () => '', configurable: true });
    App.renderBrowse = () => { browsed = true; };
    App.handleFilter();
    sandbox.document.getElementById = real; App.libraryViewMode = 'grid';
    assert.ok(hash && hash.includes('updates=1'), `hash=${hash}`); assert.strictEqual(browsed, false);
  });

  const lastToast = () => App.__toasts[App.__toasts.length - 1];
  await check('Banner actions: Check now toasts the result or the failure and refreshes; Track and Dismiss refresh; errors toast', async () => {
    mk('source-banner'); App.__toasts = []; let refreshed = 0;
    API.sourceInfo = async () => { refreshed++; return info(); };
    API.sourceCheck = async () => ({ ok: true, state: 'outdated' }); await App.checkSourceNow(5);
    assert.strictEqual(lastToast()[0], 'Source has changes');
    API.sourceCheck = async () => ({ ok: true, state: 'current' }); await App.checkSourceNow(5); assert.strictEqual(lastToast()[0], 'Up to date');
    API.sourceCheck = async () => ({ ok: false, error: 'Printables answered HTTP 429' }); await App.checkSourceNow(5);
    assert.deepStrictEqual([lastToast()[1], lastToast()[0].includes('HTTP 429')], ['error', true]);
    API.sourceTrack = async () => ({}); API.sourceDismiss = async () => ({}); await App.trackSource(5); await App.dismissSource(5);
    assert.strictEqual(refreshed, 5);
    API.sourceDismiss = async () => { throw new Error('Forbidden'); }; await App.dismissSource(5); assert.strictEqual(lastToast()[0], 'Forbidden');
    assert.ok(els['source-banner'].innerHTML.includes('Tracking printables'));
  });
  await check('Refresh metadata reports kept edits and re-renders the page', async () => {
    let rendered = null; App.renderModelDetail = async id => { rendered = id; }; App.__toasts = [];
    API.sourceRefreshMetadata = async () => ({ state: 'current', kept: ['description'] }); await App.refreshSourceMeta(5);
    assert.ok(lastToast()[0].includes('kept your edits to description')); assert.strictEqual(rendered, 5);
  });
  await check('Update dialog flow: opens with the preview; submitting sends only ticked files, closes, and starts job tracking; empty selection is refused', async () => {
    let modal = null, closed = false, tracked = null, sent = null; App.__toasts = [];
    App.openModal = (t, h) => { modal = [t, h]; }; App.closeModal = () => { closed = true; };
    API.sourceUpdatePreview = async () => ({ files: [{ id: 'stl:1', name: 'a.stl', size: 1, status: 'new' }], removed: [], metaDiff: {} });
    await App.openSourceUpdate(5);
    assert.strictEqual(modal[0], 'Update from source'); assert.ok(modal[1].includes('value="stl:1"'));
    const realQ = sandbox.document.querySelectorAll;
    sandbox.document.querySelectorAll = () => [];
    await App.runSourceUpdate(5); assert.strictEqual(lastToast()[0], 'Select at least one file'); assert.strictEqual(sent, null);
    sandbox.document.querySelectorAll = sel => (sel.includes('update_files') ? [{ value: 'stl:1' }, { value: 'stl:3' }] : []);
    API.sourceUpdate = async (id, ids) => { sent = [id, ids]; return { job_id: 1 }; };
    App.refreshIngestBanner = id => { tracked = id; };
    await App.runSourceUpdate(5);
    sandbox.document.querySelectorAll = realQ;
    assert.strictEqual(JSON.stringify(sent), JSON.stringify([5, ['stl:1', 'stl:3']])); assert.ok(closed); assert.strictEqual(tracked, 5);
    API.sourceUpdatePreview = async () => { throw new Error('Site answered HTTP 403'); }; App.__toasts = [];
    await App.openSourceUpdate(5); assert.ok(lastToast()[0].includes('HTTP 403'));
  });
  await check('Import banner for update jobs: wording, retry label, and navigation to the created version when the job finishes', async () => {
    App.refreshIngestBanner = realRefreshIngest; // an earlier test stubs it
    const run = UI.ingestBanner({ id: 1, model_id: 3, kind: 'update', status: 'running', done: 1, total: 3, detail: [] });
    assert.ok(run.includes('Creating a new version'));
    const bad = UI.ingestBanner({ id: 1, model_id: 3, kind: 'update', status: 'failed', error: 'x', detail: [] });
    assert.ok(bad.includes('The update could not be completed') && bad.includes('Retry update'));
    mk('ingest-banner'); timers = [];
    const seq = [{ id: 1, model_id: 3, kind: 'update', status: 'running', done: 0, total: 2, detail: [] }, { id: 1, model_id: 3, kind: 'update', status: 'completed', result_model_id: 44, done: 2, total: 2, detail: [] }];
    let i = 0, nav = null, rerender = false; API.ingestJobForModel = async () => seq[Math.min(i++, 1)];
    App.navigate = p => { nav = p; }; App.renderModelDetail = async () => { rerender = true; };
    await App.refreshIngestBanner(3); await timers[0].fn(); await sleepTick();
    assert.strictEqual(nav, '/models/44'); assert.strictEqual(rerender, false);
    // a failed update does not navigate anywhere
    i = 0; nav = null; seq[1] = { id: 1, model_id: 3, kind: 'update', status: 'failed', result_model_id: null, detail: [] }; timers = [];
    await App.refreshIngestBanner(3); await timers[0].fn(); await sleepTick();
    assert.strictEqual(nav, null);
  });
  await check('Import banner: cover-only warning on a completed job is a quiet note (escaped), not a failure panel; warnings are listed on partial jobs', () => {
    const quiet = UI.ingestBanner({ id: 1, model_id: 3, status: 'completed', detail: [{ name: 'cover image', status: 'warning', reason: "Blocked by the site's <b>bot protection</b>" }] });
    assert.ok(quiet.includes('Imported.') && quiet.includes('cover image could not be downloaded') && quiet.includes('bot protection'));
    assert.ok(!quiet.includes('Retry') && !quiet.includes('could not be imported') && !quiet.includes('<b>'));
    assert.strictEqual(UI.ingestBanner({ id: 1, model_id: 3, status: 'completed', detail: [{ name: 'a.stl', status: 'ok' }] }), '');
    const part = UI.ingestBanner({ id: 1, model_id: 3, status: 'partial', done: 1, total: 3, detail: [{ name: 'b.stl', status: 'failed', reason: 'HTTP 404' }, { name: 'cover image', status: 'warning', reason: 'blocked' }] });
    assert.ok(part.includes('b.stl: HTTP 404') && part.includes('cover image: blocked') && part.includes('Retry import'));
  });
  await check('Model detail page includes the source banner placeholder and loads it', async () => {
    // static guard: renderModelDetail must create #source-banner and call refreshSourceBanner
    const appSrc = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
    assert.ok(appSrc.includes('<div id="source-banner"></div>') && appSrc.includes('this.refreshSourceBanner(model.id)'));
  });

  console.log(`\n${passed} ingest UI checks passed`);
  process.exit(process.exitCode || 0);
})();
function sleepTick() { return new Promise(r => setImmediate(r)); }
