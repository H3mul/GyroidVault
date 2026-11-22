/**
 * Manual "update from source": diff preview, new-vault-version job, metadata-only refresh.
 * A new version is built from copied (unchanged) and downloaded (new/changed) files staged in temp,
 * and the version row is only created once there is something to put in it.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { get, all, run } = require('../../database');
const { UPLOADS_DIR } = require('../../config');
const { ALLOWED_EXTENSIONS } = require('../../middleware/upload');
const { preview } = require('./index');
const { IngestError } = require('./fetchGuard');
const jobs = require('./jobs');
const U = require('./updates');
const logger = require('../../utils/logger');

const tmpName = ext => path.join(UPLOADS_DIR, `ingest-${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
const stripVersion = n => n.replace(/\s*\(v\d+\)\s*$/i, '');
const suffixOf = n => (n.match(/\s*\(v\d+\)\s*$/i) || [''])[0];

/** Three-way merge of title/description/tags: a field the user edited since the snapshot is kept. */
function mergeMeta(model, snap, p, currentTagNames) {
  const m = snap.meta;
  const nameEdited = !m || model.name !== m.name;
  const descEdited = !m || model.description !== m.description;
  const kept = [];
  if (nameEdited) kept.push('title');
  if (descEdited) kept.push('description');
  const title = nameEdited ? stripVersion(model.name) : p.title;
  const suffix = nameEdited ? suffixOf(model.name) : (m && m.name !== m.title ? suffixOf(m.name) : '');
  return {
    title, suffix, kept,
    description: descEdited ? model.description : p.description,
    addTags: p.tags.filter(t => !currentTagNames.includes(t)), // tags are only ever added, never removed
  };
}

const tagNames = id => all('SELECT t.name FROM tags t JOIN model_tags mt ON mt.tag_id=t.id WHERE mt.model_id=?', [id]).map(t => t.name);

async function updatePreview(modelId) {
  const model = get('SELECT * FROM models WHERE id=?', [modelId]);
  if (!model) throw new IngestError('Model not found', 404);
  const row = U.ensureRow(model);
  const p = await preview(row.source_url);
  const c = U.classify(row, p);
  const status = new Map([...c.added.map(f => [f.name, 'new']), ...c.changed.map(f => [f.name, 'changed']), ...c.unchanged.map(f => [f.name, 'unchanged'])]);
  return {
    state: c.state, filesKnown: c.filesKnown, filesNeedToken: !!p.filesNeedToken, source_url: p.url, remoteModified: c.remoteModified,
    files: p.files.map(f => ({ ...f, status: status.get(f.name) || 'unknown' })),
    removed: c.removed, metaDiff: c.metaDiff, remote: { title: p.title, description: p.description, tags: U.upstreamTags(p.tags) },
    estimate: row.files === null,
  };
}

function startUpdateJob(modelId, selected, userId) {
  const model = get('SELECT * FROM models WHERE id=?', [modelId]);
  if (!model) throw new IngestError('Model not found', 404);
  const row = U.ensureRow(model);
  if (get("SELECT id FROM ingest_jobs WHERE model_id=? AND kind='update' AND status IN ('pending','running')", [modelId])) {
    throw new IngestError('An update is already running for this model', 409);
  }
  const r = run("INSERT INTO ingest_jobs (model_id, source_url, kind, selected) VALUES (?,?,'update',?)", [modelId, row.source_url, selected ? JSON.stringify(selected) : null]);
  jobs.enqueue(() => runUpdateJob(r.lastId, userId), r.lastId);
  return r.lastId;
}

function versionName(base, rootId, suffix) {
  const taken = n => get('SELECT 1 FROM models WHERE name=?', [n]);
  let n = get('SELECT COUNT(*) c FROM models WHERE id=? OR parent_id=?', [rootId, rootId]).c + 1;
  if (suffix && !taken(`${base}${suffix}`)) return `${base}${suffix}`;
  while (taken(`${base} (v${n})`)) n++;
  return `${base} (v${n})`;
}

async function runUpdateJob(jobId, userId) {
  const { addFilesToModel, attachTags, createVersionRecord } = require('../../routes/models');
  const job = get('SELECT * FROM ingest_jobs WHERE id=?', [jobId]);
  const old = job && get('SELECT * FROM models WHERE id=?', [job.model_id]);
  if (!old) return jobs.setJob(jobId, { status: 'failed', error: 'Model no longer exists' });
  const detail = [];
  const staged = [];
  const flush = () => jobs.setJob(jobId, { detail: JSON.stringify(detail), done: detail.filter(d => d.status === 'ok').length });
  const fail = msg => { flush(); jobs.setJob(jobId, { status: 'failed', error: msg }); };
  try {
    jobs.setJob(jobId, { status: 'running', error: null });
    const row = U.ensureRow(old);
    const p = await preview(row.source_url); // fresh: signed links expire, and the snapshot must reflect what we fetch
    const provider = p._provider, raw = p._raw;
    if (p.filesNeedToken || !p.files.length) {
      return fail(p.filesNeedToken
        ? 'This site needs an API token (THINGIVERSE_TOKEN) to download files. Open the source page to get the new files, or refresh metadata only.'
        : 'The source lists no downloadable files.');
    }
    const c = U.classify(row, p);
    const unchanged = new Set(c.unchanged.map(f => f.name));
    const sel = job.selected ? new Set(JSON.parse(job.selected)) : null;
    const oldFiles = all('SELECT * FROM files WHERE model_id=? AND (is_archive_entry IS NULL OR is_archive_entry=0)', [old.id]);

    let budget = jobs.maxTotal();
    for (const f of raw.files) {
      if (sel && !sel.has(String(f.id))) continue;
      const name = path.basename(String(f.name));
      const ext = path.extname(name).toLowerCase();
      if (!ALLOWED_EXTENSIONS.includes(ext)) { detail.push({ name, status: 'skipped', reason: 'file type not allowed' }); continue; }
      try {
        const prev = unchanged.has(name) && oldFiles.find(o => o.original_name === name && fs.existsSync(o.library_path));
        if (prev) { // unchanged upstream: copy from the previous version instead of downloading
          const tmp = tmpName(ext);
          fs.copyFileSync(prev.library_path, tmp);
          staged.push({ path: tmp, originalname: name, size: fs.statSync(tmp).size });
          detail.push({ name, status: 'ok', reason: 'copied from previous version' });
          continue;
        }
        const declared = Number(f.size) || 0;
        if (declared > jobs.maxFile()) throw new Error(`larger than the ${jobs.maxFile() / 1048576} MB per-file limit`);
        if (declared > budget) throw new Error('import size limit reached');
        const file = await jobs.fetchOne(provider, raw, f, name, Math.min(jobs.maxFile(), budget));
        budget -= file.size;
        staged.push(file);
        detail.push({ name, status: 'ok' });
      } catch (e) { detail.push({ name, status: 'failed', reason: e.message }); }
    }
    if (p.coverUrl) { try { staged.push(await jobs.stageCover(p.coverUrl)); } catch (e) { detail.push({ name: 'cover image', status: 'failed', reason: e.message }); } }
    if (!staged.some(s => !/^cover\./.test(s.originalname))) return fail(detail.find(d => d.status === 'failed')?.reason || 'No files could be fetched');

    // Something to put in the version: create it now
    const root = old.parent_id || old.id;
    const cur = tagNames(old.id);
    const merged = mergeMeta(old, row, p, cur);
    const name = versionName(merged.title, root, merged.suffix);
    const vId = createVersionRecord(root, {
      name, description: merged.description, category_id: old.category_id, print_tips: old.print_tips,
      custom_meta: old.custom_meta, source_url: p.url,
    }, userId || old.user_id);
    jobs.setJob(jobId, { result_model_id: vId });
    attachTags(vId, [...cur, ...merged.addTags]);
    const version = get('SELECT * FROM models WHERE id=?', [vId]);
    version.library_path = jobs.ensureLibraryDir(version);
    const added = addFilesToModel(version, staged.splice(0));
    if (!added.some(a => a.file_type !== 'image' || !/^cover\./.test(a.original_name))) {
      run('DELETE FROM models WHERE id=?', [vId]); // nothing accepted: never leave an empty latest version
      try { fs.rmSync(version.library_path, { recursive: true, force: true }); } catch { /* best effort */ }
      jobs.setJob(jobId, { result_model_id: null });
      return fail('The new files were rejected by file validation; no new version was created');
    }
    U.saveSnapshot(vId, p, name);
    run("UPDATE models SET updated_at=datetime('now') WHERE id=?", [vId]);
    const bad = detail.filter(d => d.status === 'failed').length;
    flush();
    jobs.setJob(jobId, { status: bad ? 'partial' : 'completed', error: merged.kept.length ? `Kept your edits: ${merged.kept.join(', ')}` : null });
  } catch (e) {
    logger.warn('Ingest', `update job ${jobId} failed: ${e.message}`);
    fail(e.message);
  } finally {
    for (const s of staged) fs.rmSync(s.path, { force: true });
  }
}

/** Refresh title/description/tags on the current model, keeping the user's edits; files are untouched. */
async function refreshMetadata(modelId) {
  const model = get('SELECT * FROM models WHERE id=?', [modelId]);
  if (!model) throw new IngestError('Model not found', 404);
  const row = U.ensureRow(model);
  const p = await preview(row.source_url);
  const cur = tagNames(modelId);
  const m = mergeMeta(model, row, p, cur);
  const { attachTags } = require('../../routes/models');
  const newName = m.kept.includes('title') ? model.name : `${m.title}${m.suffix}`;
  const nameTaken = newName !== model.name && get('SELECT 1 FROM models WHERE name=? AND id != ?', [newName, modelId]);
  const finalName = nameTaken ? model.name : newName;
  run("UPDATE models SET name=?, description=?, updated_at=datetime('now') WHERE id=?", [finalName, m.description, modelId]);
  attachTags(modelId, m.addTags);
  const meta = { name: m.kept.includes('title') || nameTaken ? row.meta?.name ?? null : finalName, title: p.title, description: p.description, tags: U.upstreamTags(p.tags) };
  const next = { ...row, meta };
  const c = U.classify(next, p);
  run(`UPDATE model_sources SET meta_snapshot=?, state=?, remote_key=?, last_checked_at=datetime('now'), remote_modified=CASE WHEN ?='current' AND ? IS NOT NULL THEN ? ELSE remote_modified END WHERE model_id=?`,
    [JSON.stringify(meta), c.state, U.remoteKey(p), c.state, p.remoteModified || null, p.remoteModified || null, modelId]);
  return { state: c.state, kept: m.kept, name: finalName };
}

module.exports = { updatePreview, startUpdateJob, runUpdateJob, refreshMetadata, mergeMeta, versionName };
