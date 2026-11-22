const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const { get } = require('../database');
const { authenticate, requireUploader } = require('../middleware/auth');
const { preview } = require('../services/ingest');
const { startJob, getJob } = require('../services/ingest/jobs');
const { createModelRecord } = require('./models');

// Each call triggers outbound requests to third-party sites, so keep it well below the global limit.
const limiter = rateLimit({ windowMs: 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many import requests, slow down' } });
router.use(limiter);

const fail = (res, e) => {
  if (!e.status) console.error('[ingest]', e);
  res.status(e.status || 500).json({ error: e.status ? e.message : 'Import failed' });
};

/** Public fields only (drops provider-private data). */
const pub = p => ({ ...p });

// POST /api/ingest/preview {url} -> metadata, tags (incl. source:<site>), files, cover
router.post('/preview', authenticate, requireUploader, async (req, res) => {
  try {
    const p = await preview(req.body?.url);
    const dup = p.url && get('SELECT id, name FROM models WHERE source_url=?', [p.url]);
    res.json({ ...pub(p), existing_model: dup || null });
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
  let job_id = null;
  if (body.download_files !== false && (p.files.length || p.coverUrl)) job_id = startJob(r.body.id, p.url, Array.isArray(body.file_ids) ? body.file_ids.map(String) : null);
  return { status: 201, body: { model: r.body, job_id, files_need_token: p.filesNeedToken } };
}

router.post('/', authenticate, requireUploader, async (req, res) => {
  try {
    const r = await importFromUrl(req.user.id, req.body || {});
    res.status(r.status).json(r.body);
  } catch (e) { fail(res, e); }
});

// POST /api/ingest/download {model_id, url, file_ids?} -> start a file job for a model saved from the preview form
router.post('/download', authenticate, requireUploader, async (req, res) => {
  try {
    const { model_id, url, file_ids } = req.body || {};
    const model = get('SELECT * FROM models WHERE id=?', [Number(model_id)]);
    if (!model) return res.status(404).json({ error: 'Model not found' });
    if (req.user.role !== 'admin' && model.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    await preview(url); // validates the URL and provider before queueing
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
  const row = get('SELECT id FROM ingest_jobs WHERE model_id=? ORDER BY id DESC LIMIT 1', [Number(req.params.modelId)]);
  res.json(row ? getJob(row.id) : null);
});

router.get('/jobs/:id', authenticate, (req, res) => {
  const job = ownedJob(req, res);
  if (job) res.json(job);
});

// Retry downloads only what the model is still missing
router.post('/jobs/:id/retry', authenticate, requireUploader, (req, res) => {
  const job = ownedJob(req, res);
  if (!job) return;
  if (['pending', 'running'].includes(job.status)) return res.status(409).json({ error: 'Job is still running' });
  res.status(202).json({ job_id: startJob(job.model_id, job.source_url, job.selected ? JSON.parse(job.selected) : null) });
});

module.exports = router;
module.exports.importFromUrl = importFromUrl;
