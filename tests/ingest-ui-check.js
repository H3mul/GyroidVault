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

  console.log(`\n${passed} ingest UI checks passed`);
  process.exit(process.exitCode || 0);
})();
function sleepTick() { return new Promise(r => setImmediate(r)); }
