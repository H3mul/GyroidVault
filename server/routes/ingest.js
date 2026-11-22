const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const { get } = require('../database');
const { authenticate, requireUploader } = require('../middleware/auth');
const { preview } = require('../services/ingest');
const { startJob, getJob } = require('../services/ingest/jobs');
const U = require('../services/ingest/updates');
const sync = require('../services/ingest/sync');
const { createModelRecord } = require('./models');

// Endpoints that trigger outbound requests to third-party sites get a stricter limit than the global one.
// Status polling (GET) is deliberately not limited: the model page polls every 2s while a job runs.
const limiter = rateLimit({
  windowMs: 60 * 1000, limit: Number(process.env.INGEST_RATE_LIMIT_PER_MIN) || 20,
  standardHeaders: true, legacyHeaders: false, message: { error: 'Too many import requests, slow down' },
});

const fail = (res, e) => {
  if (!e.status) console.error('[ingest]', e);
  res.status(e.status || 500).json({ error: e.status ? e.message : 'Import failed', ...(e.code && e.status ? { code: e.code } : {}) });
};

/** Public fields only (drops provider-private data). */
const pub = p => ({ ...p });

// POST /api/ingest/preview {url} -> metadata, tags (incl. source:<site>), files, cover
router.post('/preview', limiter, authenticate, requireUploader, async (req, res) => {
  try {
    const p = await preview(req.body?.url);
    const dup = p.url && get('SELECT id, name FROM models WHERE source_url=?', [p.url]);
    let update = null;
    if (dup) { const si = U.sourceInfo(dup.id); if (si?.tracked && ['outdated', 'unknown_changed', 'metadata_changed'].includes(si.state)) update = { model_id: dup.id, state: si.state }; }
    res.json({ ...pub(p), existing_model: dup || null, update_available: update });
  } catch (e) { fail(res, e); }
});

/**
 * One-shot: enrich, create the model, start the file download job.
 * Body: {url, category_id?, auto_rename?, allow_duplicate?, download_files? (default true), file_ids?}
 */
async function importFromUrl(userId, body) {
  const p = await preview(body.url);
  const dup = p.url && get('SELECT id, name FROM models WHERE source_url=?', [p.url]);
  if (dup && !body.allow_duplicate) {
    return { status: 409, body: { error: 'A model from this URL already exists', existing_model_id: dup.id, existing_model_name: dup.name } };
  }
  const r = createModelRecord(userId, {
    name: p.title, description: p.description, source_url: p.url,
    category_id: body.category_id, tags: p.tags, auto_rename: body.auto_rename,
  });
  if (r.status !== 201) return r;
  U.saveSnapshot(r.body.id, p, r.body.name);
  let job_id = null;
  if (body.download_files !== false && (p.files.length || p.coverUrl)) job_id = startJob(r.body.id, p.url, Array.isArray(body.file_ids) ? body.file_ids.map(String) : null);
  return { status: 201, body: { model: r.body, job_id } };
}

router.post('/', limiter, authenticate, requireUploader, async (req, res) => {
  try {
    const r = await importFromUrl(req.user.id, req.body || {});
    res.status(r.status).json(r.body);
  } catch (e) { fail(res, e); }
});

// POST /api/ingest/download {model_id, url, file_ids?} -> start a file job for a model saved from the preview form
router.post('/download', limiter, authenticate, requireUploader, async (req, res) => {
  try {
    const { model_id, url, file_ids } = req.body || {};
    const model = get('SELECT * FROM models WHERE id=?', [Number(model_id)]);
    if (!model) return res.status(404).json({ error: 'Model not found' });
    if (req.user.role !== 'admin' && model.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    const p = await preview(url); // validates the URL and provider before queueing
    U.saveSnapshot(model.id, p, model.name);
    res.status(202).json({ job_id: startJob(model.id, String(url).trim(), Array.isArray(file_ids) ? file_ids.map(String) : null) });
  } catch (e) { fail(res, e); }
});

function ownedJob(req, res) {
  const job = getJob(Number(req.params.id));
  const model = job && get('SELECT user_id FROM models WHERE id=?', [job.model_id]);
  if (!job || !model) { res.status(404).json({ error: 'Job not found' }); return null; }
  if (req.user.role !== 'admin' && model.user_id !== req.user.id) { res.status(403).json({ error: 'Forbidden' }); return null; }
  return job;
}

// Latest import job for a model (null when the model was not imported from a URL)
router.get('/models/:modelId/job', authenticate, (req, res) => {
  const row = get('SELECT id FROM ingest_jobs WHERE model_id=? OR result_model_id=? ORDER BY id DESC LIMIT 1', [Number(req.params.modelId), Number(req.params.modelId)]);
  res.json(row ? getJob(row.id) : null);
});

router.get('/jobs/:id', authenticate, (req, res) => {
  const job = ownedJob(req, res);
  if (job) res.json(job);
});

// Retry downloads only what the model is still missing
router.post('/jobs/:id/retry', limiter, authenticate, requireUploader, (req, res) => {
  const job = ownedJob(req, res);
  if (!job) return;
  if (['pending', 'running'].includes(job.status)) return res.status(409).json({ error: 'Job is still running' });
  const selected = job.selected ? JSON.parse(job.selected) : null;
  if (job.kind === 'update' && !job.result_model_id) { // nothing was created: run the update again
    try { return res.status(202).json({ job_id: sync.startUpdateJob(job.model_id, selected, req.user.id, !!job.force) }); } catch (e) { return fail(res, e); }
  }
  // import jobs, and partial updates (fill in the missing files of the version they created)
  const target = job.kind === 'update' ? job.result_model_id : job.model_id;
  res.status(202).json({ job_id: startJob(target, job.source_url, selected) });
});

// ─── Source update tracking ──────────────────────────────────────────────────
function ownedModel(req, res) {
  const model = get('SELECT * FROM models WHERE id=?', [Number(req.params.id)]);
  if (!model) { res.status(404).json({ error: 'Model not found' }); return null; }
  if (req.user.role !== 'admin' && model.user_id !== req.user.id) { res.status(403).json({ error: 'Forbidden' }); return null; }
  return model;
}
const guard = fn => async (req, res) => { try { await fn(req, res); } catch (e) { fail(res, e); } };

router.get('/models/:id/source', authenticate, (req, res) => {
  const info = U.sourceInfo(Number(req.params.id));
  info ? res.json(info) : res.status(404).json({ error: 'Model not found' });
});
router.post('/models/:id/check', limiter, authenticate, requireUploader, guard(async (req, res) => {
  if (!ownedModel(req, res)) return;
  res.json(await U.checkModel(Number(req.params.id)));
}));
router.post('/models/:id/track', limiter, authenticate, requireUploader, guard(async (req, res) => {
  if (!ownedModel(req, res)) return;
  res.json(await U.trackModel(Number(req.params.id)));
}));
router.post('/models/:id/dismiss', authenticate, requireUploader, guard((req, res) => {
  if (!ownedModel(req, res)) return;
  U.dismiss(Number(req.params.id));
  res.json(U.sourceInfo(Number(req.params.id)));
}));
router.post('/models/:id/update-preview', limiter, authenticate, requireUploader, guard(async (req, res) => {
  if (!ownedModel(req, res)) return;
  res.json(await sync.updatePreview(Number(req.params.id)));
}));
router.post('/models/:id/update', limiter, authenticate, requireUploader, guard((req, res) => {
  if (!ownedModel(req, res)) return;
  const ids = Array.isArray(req.body?.file_ids) ? req.body.file_ids.map(String) : null;
  res.status(202).json({ job_id: sync.startUpdateJob(Number(req.params.id), ids, req.user.id, req.body?.force === true) });
}));
router.post('/models/:id/refresh-metadata', limiter, authenticate, requireUploader, guard(async (req, res) => {
  if (!ownedModel(req, res)) return;
  res.json(await sync.refreshMetadata(Number(req.params.id)));
}));
router.post('/check-all', limiter, authenticate, guard(async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  U.runScheduledChecks({ force: true }).catch(e => console.error('[ingest] check-all', e)); // runs in the background; polite pacing applies
  res.status(202).json({ started: true });
}));

module.exports = router;
module.exports.importFromUrl = importFromUrl;
