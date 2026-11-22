const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { get, all, run } = require('../../database');
const { UPLOADS_DIR, LIBRARY_PATH } = require('../../config');
const { ALLOWED_EXTENSIONS } = require('../../middleware/upload');
const { validatePathConfinement } = require('../../middleware/security');
const { preview } = require('./index');
const { downloadToFile } = require('./fetchGuard');
const logger = require('../../utils/logger');

const mb = (env, def) => (Number(process.env[env]) || def) * 1024 * 1024;
const maxFile = () => mb('INGEST_MAX_FILE_MB', 200);
const maxTotal = () => mb('INGEST_MAX_TOTAL_MB', 500);

// ponytail: one in-process queue, one download at a time; swap for per-site limits if throughput matters
let queue = Promise.resolve();

const setJob = (id, f) => {
  const cols = Object.keys(f);
  run(`UPDATE ingest_jobs SET ${cols.map(c => `${c}=?`).join(',')}, updated_at=datetime('now') WHERE id=?`, [...cols.map(c => f[c]), id]);
};

function startJob(modelId, url, selected = null) {
  const r = run('INSERT INTO ingest_jobs (model_id, source_url, selected) VALUES (?,?,?)', [modelId, url, selected ? JSON.stringify(selected) : null]);
  const id = r.lastId;
  enqueue(() => runJob(id), id);
  return id;
}

function enqueue(fn, id) {
  queue = queue.then(fn).catch(e => logger.error('Ingest', `job ${id} crashed`, e));
}

/** Jobs left running by a crash/restart cannot resume; mark failed so the user can retry. */
function recoverStaleJobs() {
  // An update job that died after creating its version row but before adding files would leave an empty "latest" version
  for (const j of all("SELECT result_model_id FROM ingest_jobs WHERE kind='update' AND status IN ('pending','running') AND result_model_id IS NOT NULL")) {
    if (!get('SELECT 1 FROM files WHERE model_id=?', [j.result_model_id])) run('DELETE FROM models WHERE id=?', [j.result_model_id]);
  }
  run("UPDATE ingest_jobs SET status='failed', error='Interrupted by server restart', updated_at=datetime('now') WHERE status IN ('pending','running')");
}

function ensureLibraryDir(model) {
  if (model.library_path && fs.existsSync(model.library_path)) return model.library_path;
  const safe = model.name.replace(/[<>:"/\\|?*]/g, '').trim() || `model_${model.id}`;
  const dir = validatePathConfinement(LIBRARY_PATH, safe);
  if (!dir) throw new Error('Invalid model library path');
  fs.mkdirSync(dir, { recursive: true });
  run('UPDATE models SET library_path=? WHERE id=?', [dir, model.id]);
  return dir;
}

async function fetchOne(provider, raw, file, name, limit) {
  const { url, headers } = await provider.resolveFile(raw, file);
  const tmp = path.join(UPLOADS_DIR, `ingest-${Date.now()}-${crypto.randomBytes(6).toString('hex')}${path.extname(name).toLowerCase()}`);
  const size = await downloadToFile(url, tmp, limit, headers);
  return { path: tmp, originalname: name, size };
}

/** Downloads the cover image to a temp file; returns an addFilesToModel descriptor. */
async function stageCover(coverUrl) {
  const ext = path.extname(new URL(coverUrl).pathname).toLowerCase();
  const name = `cover${['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext) ? ext : '.jpg'}`;
  const tmp = path.join(UPLOADS_DIR, `ingest-${Date.now()}-${crypto.randomBytes(6).toString('hex')}${path.extname(name)}`);
  const size = await downloadToFile(coverUrl, tmp, 10 * 1024 * 1024);
  return { path: tmp, originalname: name, size };
}

async function runJob(jobId) {
  const job = get('SELECT * FROM ingest_jobs WHERE id=?', [jobId]);
  const model = job && get('SELECT * FROM models WHERE id=?', [job.model_id]);
  if (!model) return setJob(jobId, { status: 'failed', error: 'Model no longer exists' });
  const { addFilesToModel } = require('../../routes/models'); // lazy: models.js is loaded after services
  const detail = [];
  const flush = () => setJob(jobId, { detail: JSON.stringify(detail), done: detail.filter(d => d.status === 'ok').length });
  try {
    setJob(jobId, { status: 'running', error: null });
    model.library_path = ensureLibraryDir(model);
    const meta = await preview(job.source_url); // fresh: signed links expire
    const raw = meta._raw, provider = meta._provider;
    const have = new Set(all('SELECT original_name FROM files WHERE model_id=?', [model.id]).map(f => f.original_name));
    const sel = job.selected ? new Set(JSON.parse(job.selected)) : null;

    const todo = [];
    for (const f of raw.files || []) {
      if (sel && !sel.has(String(f.id))) continue;
      const name = path.basename(String(f.name));
      if (have.has(name)) continue;
      if (!ALLOWED_EXTENSIONS.includes(path.extname(name).toLowerCase())) { detail.push({ name, status: 'skipped', reason: 'file type not allowed' }); continue; }
      todo.push({ f, name });
    }
    setJob(jobId, { total: todo.length + (meta.coverUrl && !model.thumbnail ? 1 : 0) });

    let budget = maxTotal();
    if (meta.coverUrl && !model.thumbnail) {
      try {
        addFilesToModel(model, [await stageCover(meta.coverUrl)]);
        detail.push({ name: 'cover image', status: 'ok' });
      } catch (e) { detail.push({ name: 'cover image', status: 'warning', reason: e.message }); } // the model is still usable without a cover
    }

    for (const { f, name } of todo) {
      try {
        const declared = Number(f.size) || 0;
        if (declared > maxFile()) throw new Error(`larger than the ${maxFile() / 1048576} MB per-file limit`);
        if (declared > budget) throw new Error('import size limit reached');
        const file = await fetchOne(provider, raw, f, name, Math.min(maxFile(), budget));
        budget -= file.size;
        const added = addFilesToModel(model, [file]);
        detail.push(added.length ? { name, status: 'ok' } : { name, status: 'failed', reason: 'rejected by file validation' });
      } catch (e) {
        detail.push({ name, status: 'failed', reason: e.message });
      }
      flush();
    }
    flush();
    const ok = detail.filter(d => d.status === 'ok').length;
    const bad = detail.filter(d => d.status === 'failed').length;
    setJob(jobId, { status: bad === 0 ? 'completed' : ok ? 'partial' : 'failed', error: bad && !ok ? (detail.find(d => d.status === 'failed').reason) : null });
  } catch (e) {
    logger.warn('Ingest', `job ${jobId} failed: ${e.message}`);
    flush();
    setJob(jobId, { status: 'failed', error: e.message });
  }
}

function getJob(id) {
  const j = get('SELECT * FROM ingest_jobs WHERE id=?', [id]);
  if (j) j.detail = JSON.parse(j.detail || '[]');
  return j;
}

module.exports = { startJob, runJob, recoverStaleJobs, getJob, enqueue, setJob, fetchOne, stageCover, ensureLibraryDir, maxFile, maxTotal };
