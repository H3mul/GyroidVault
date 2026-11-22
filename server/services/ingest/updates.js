/**
 * Source update tracking: snapshots, classification, scheduled and manual checks.
 * Network goes through ./index (provider + guarded fetch); persistence is model_sources.
 */
const crypto = require('crypto');
const { get, all, run } = require('../../database');
const { preview, resolveProvider } = require('./index');
const { IngestError } = require('./fetchGuard');
const logger = require('../../utils/logger');

const sha = s => crypto.createHash('sha1').update(s).digest('hex');
const toFiles = files => (files || []).map(f => ({ id: String(f.id), name: String(f.name), size: Number(f.size) || 0 }));
const upstreamTags = tags => (tags || []).filter(t => !t.startsWith('source:'));
const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));
const num = t => (t ? Date.parse(t) : NaN);

function intervalHours() {
  const s = get("SELECT value FROM system_settings WHERE key='source_check_interval_hours'");
  const n = s && s.value !== undefined && s.value !== '' ? Number(s.value) : 24;
  return Number.isFinite(n) && n >= 0 ? n : 24;
}
const nextCheckSql = h => `datetime('now','+${Math.max(1, Math.floor(h * 60))} minutes')`;

/** Pure: compare a stored snapshot with a fresh preview. snap = {remote_modified, files|null, meta|null}. */
function classify(snap, remote) {
  const rFiles = toFiles(remote.files);
  const filesKnown = Array.isArray(snap.files) && !remote.filesNeedToken;
  const sMap = new Map((snap.files || []).map(f => [f.name, f]));
  const added = [], changed = [], unchanged = [];
  if (filesKnown) {
    for (const f of rFiles) {
      const s = sMap.get(f.name);
      if (!s) added.push(f);
      else if (s.id !== f.id || s.size !== f.size) changed.push({ ...f, previous: s });
      else unchanged.push(f);
      sMap.delete(f.name);
    }
  }
  const removed = filesKnown ? [...sMap.values()] : [];
  const m = snap.meta;
  const rTags = upstreamTags(remote.tags);
  const metaDiff = !m ? { title: false, description: false, tags: false } : {
    title: remote.title !== m.title,
    description: remote.description !== m.description,
    tags: !sameSet(rTags, m.tags || []),
  };
  const metaChanged = metaDiff.title || metaDiff.description || metaDiff.tags;
  let state;
  if (filesKnown) {
    state = added.length || changed.length || removed.length ? 'outdated' : metaChanged ? 'metadata_changed' : 'current';
  } else {
    const newer = remote.remoteModified && (Number.isNaN(num(snap.remote_modified)) || num(remote.remoteModified) > num(snap.remote_modified));
    state = newer ? 'unknown_changed' : metaChanged ? 'metadata_changed' : 'current';
  }
  return { state, filesKnown, added, changed, removed, unchanged, metaDiff, remoteModified: remote.remoteModified || null };
}

const remoteKey = p => sha(`${p.remoteModified || ''}|${JSON.stringify(toFiles(p.files).sort((a, b) => a.name.localeCompare(b.name)))}`);

function snapshotFrom(p, modelName) {
  return {
    site: p.site, source_url: p.url, remote_id: p._raw?._printId || p._raw?._thingId || null,
    remote_modified: p.remoteModified || null,
    files: p.filesNeedToken ? null : toFiles(p.files),
    meta: { name: modelName, title: p.title, description: p.description, tags: upstreamTags(p.tags) },
  };
}

/** Writes a fresh baseline snapshot (state current) for a model from a preview. */
function saveSnapshot(modelId, p, modelName) {
  const s = snapshotFrom(p, modelName);
  run(`INSERT OR REPLACE INTO model_sources
    (model_id, site, source_url, remote_id, remote_modified, files_fingerprint, meta_snapshot, state, remote_key, last_checked_at, next_check_at)
    VALUES (?,?,?,?,?,?,?, 'current', ?, datetime('now'), ${nextCheckSql(intervalHours() || 24)})`,
    [modelId, s.site, s.source_url, s.remote_id, s.remote_modified, s.files ? JSON.stringify(s.files) : null, JSON.stringify(s.meta), remoteKey(p)]);
}

function parseRow(row) {
  if (!row) return null;
  return { ...row, files: row.files_fingerprint ? JSON.parse(row.files_fingerprint) : null, meta: row.meta_snapshot ? JSON.parse(row.meta_snapshot) : null, summary: row.summary ? JSON.parse(row.summary) : null };
}

function supportedSite(url) {
  try { const p = resolveProvider(url); return p.id !== 'generic' ? p.id : null; } catch { return null; }
}

/** Row for a model, creating a legacy baseline (estimate from created_at) when it has a supported source but no snapshot yet. */
function ensureRow(model) {
  let row = get('SELECT * FROM model_sources WHERE model_id=?', [model.id]);
  if (row) return parseRow(row);
  const site = model.source_url && supportedSite(model.source_url);
  if (!site) throw new IngestError('This model has no supported source (Printables or Thingiverse) to track', 400);
  const created = new Date(`${String(model.created_at).replace(' ', 'T')}Z`).toISOString();
  run(`INSERT INTO model_sources (model_id, site, source_url, remote_modified, files_fingerprint, meta_snapshot, state) VALUES (?,?,?,?,NULL,NULL,'current')`,
    [model.id, site, model.source_url, created]);
  return parseRow(get('SELECT * FROM model_sources WHERE model_id=?', [model.id]));
}

function recordFailure(modelId, row, e) {
  const notFound = e.code === 'not_found';
  const fails = (row.fail_count || 0) + 1, misses = notFound ? (row.miss_count || 0) + 1 : 0;
  const state = notFound && misses >= 3 ? 'source_unavailable' : row.state;
  const backoffMin = Math.min(Math.pow(2, fails) * 60, Math.max(intervalHours(), 1) * 60);
  run(`UPDATE model_sources SET fail_count=?, miss_count=?, state=?, last_error=?, last_checked_at=datetime('now'), next_check_at=datetime('now','+${Math.floor(backoffMin)} minutes') WHERE model_id=?`,
    [fails, notFound ? misses : row.miss_count || 0, state, e.message, modelId]);
  return { ok: false, state, error: e.message, code: e.code || 'error' };
}

/** Check one model against its source and persist the result. Never changes state on transient failures. */
async function checkModel(modelId) {
  const model = get('SELECT * FROM models WHERE id=?', [modelId]);
  if (!model) throw new IngestError('Model not found', 404);
  const row = ensureRow(model);
  let p;
  try { p = await preview(row.source_url); } catch (e) { return recordFailure(modelId, row, e); }

  const c = classify(row, p);
  const upgrade = c.state === 'current' && row.files === null && !p.filesNeedToken; // legacy baseline becomes a real snapshot
  if (upgrade) saveSnapshot(modelId, p, model.name);
  else if (c.state === 'current' && p.remoteModified) run('UPDATE model_sources SET remote_modified=? WHERE model_id=?', [p.remoteModified, modelId]);
  const summary = { added: c.added, changed: c.changed, removed: c.removed, metaDiff: c.metaDiff, remoteModified: c.remoteModified, estimate: row.files === null };
  run(`UPDATE model_sources SET state=?, summary=?, remote_key=?, last_checked_at=datetime('now'), next_check_at=${nextCheckSql(intervalHours() || 24)}, fail_count=0, miss_count=0, last_error=NULL WHERE model_id=?`,
    [c.state, JSON.stringify(summary), remoteKey(p), modelId]);
  return { ok: true, state: c.state, summary };
}

const dismissed = r => !!r.dismissed_key && r.dismissed_key === r.remote_key;

function sourceInfo(modelId) {
  const model = get('SELECT * FROM models WHERE id=?', [modelId]);
  if (!model) return null;
  const row = parseRow(get('SELECT * FROM model_sources WHERE model_id=?', [modelId]));
  const site = row ? row.site : (model.source_url && supportedSite(model.source_url));
  if (!row) return { tracked: false, supported: !!site, site: site || null, source_url: model.source_url || '' };
  return {
    tracked: true, supported: true, site: row.site, source_url: row.source_url, state: row.state, dismissed: dismissed(row),
    summary: row.summary, last_checked_at: row.last_checked_at, last_error: row.last_error, estimate: row.files === null,
  };
}

function dismiss(modelId) {
  const row = get('SELECT remote_key FROM model_sources WHERE model_id=?', [modelId]);
  if (!row || !row.remote_key) throw new IngestError('Nothing to dismiss: check this model first', 400);
  run('UPDATE model_sources SET dismissed_key=remote_key WHERE model_id=?', [modelId]);
}

/** Start tracking an existing model: baseline snapshot from the source's current state. */
async function trackModel(modelId) {
  const model = get('SELECT * FROM models WHERE id=?', [modelId]);
  if (!model) throw new IngestError('Model not found', 404);
  if (!model.source_url || !supportedSite(model.source_url)) throw new IngestError('This model has no supported source (Printables or Thingiverse) to track', 400);
  const p = await preview(model.source_url);
  saveSnapshot(modelId, p, model.name);
  return sourceInfo(modelId);
}

// m must be the newest member of its family (matches how the library picks "latest")
const LATEST_SQL = `(CASE WHEN m.parent_id IS NULL
  THEN NOT EXISTS (SELECT 1 FROM models c WHERE c.parent_id = m.id)
  ELSE NOT EXISTS (SELECT 1 FROM models c WHERE c.parent_id = m.parent_id AND (c.created_at > m.created_at OR (c.created_at = m.created_at AND c.id > m.id)))
END)`;

let running = false;
const realSleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * One scheduled pass: due, latest-version models only, oldest first, capped, paced per site.
 * Skips a site for the rest of the pass when it rate-limits or challenges us.
 */
async function runScheduledChecks({ sleep = realSleep, minGapMs = 2000, jitterMs = 500, cap = 50, force = false } = {}) {
  if (running) return { skipped: 'already running' };
  if (!force && intervalHours() === 0) return { skipped: 'disabled' };
  running = true;
  const result = { checked: 0, skippedSites: [] };
  try {
    const due = all(`SELECT ms.model_id AS id, ms.site FROM model_sources ms JOIN models m ON m.id = ms.model_id
      WHERE (ms.next_check_at IS NULL OR ms.next_check_at <= datetime('now')) AND ${LATEST_SQL}
      ORDER BY ms.last_checked_at IS NOT NULL, ms.last_checked_at LIMIT ?`, [cap]);
    if (due.length < cap) { // legacy imports (origin tag, no snapshot yet)
      due.push(...all(`SELECT m.id, NULL AS site FROM models m
        WHERE m.source_url != '' AND m.id NOT IN (SELECT model_id FROM model_sources) AND ${LATEST_SQL}
          AND m.id IN (SELECT mt.model_id FROM model_tags mt JOIN tags t ON t.id = mt.tag_id WHERE t.name LIKE 'source:%') LIMIT ?`, [cap - due.length]));
    }
    const lastAt = new Map(), blocked = new Set();
    for (const d of due) {
      const model = get('SELECT source_url FROM models WHERE id=?', [d.id]);
      const site = d.site || (model && supportedSite(model.source_url)) || 'other';
      if (blocked.has(site)) continue;
      const wait = (lastAt.get(site) || 0) + minGapMs - Date.now();
      if (wait > 0) await sleep(wait + Math.floor(Math.random() * jitterMs));
      let r;
      try { r = await checkModel(d.id); } catch (e) { r = { ok: false, code: e.code, error: e.message }; }
      lastAt.set(site, Date.now());
      result.checked++;
      if (!r.ok && (r.code === 'rate_limited' || r.code === 'blocked')) { blocked.add(site); result.skippedSites.push(site); }
    }
    return result;
  } finally { running = false; }
}

let timer = null;
/** Cheap poll; due-ness comes from next_check_at, so the interval setting needs no timer restart. */
function startUpdateScheduler() {
  stopUpdateScheduler();
  timer = setInterval(() => runScheduledChecks().catch(e => logger.error('Updates', 'scheduled check failed', e)), 15 * 60 * 1000);
  timer.unref?.();
}
function stopUpdateScheduler() { if (timer) clearInterval(timer); timer = null; }

module.exports = {
  classify, remoteKey, toFiles, upstreamTags, snapshotFrom, saveSnapshot, parseRow, ensureRow, supportedSite,
  checkModel, sourceInfo, dismiss, trackModel, runScheduledChecks, startUpdateScheduler, stopUpdateScheduler, intervalHours,
};
