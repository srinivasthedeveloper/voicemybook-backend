const express = require('express');
const { v4: uuidv4 } = require('uuid');
const pdfParse = require('pdf-parse');
const fs = require('fs');
const crypto = require('crypto');
const upload = require('../middleware/uploadMiddleware');
const jobService = require('../services/jobService');
const { analyzeJob } = require('../queues/conversionQueue');
const log = require('../services/logger');
const config = require('../config');
const path = require('path');
const store = require('../services/chapterStore');
const db = require('../db');
const audioService = require('../services/audioService');

const router = express.Router();

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(filePath)
      .on('data', d => hash.update(d))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

const describe = (job, extra = {}) => ({
  jobId: job.id,
  filename: job.pdf_filename,
  sizeBytes: job.pdf_size_bytes,
  pageCount: job.page_count,
  ...extra,
});

// A cached job whose analysis failed or never finished gets analyzed again
function reanalyzeIfBroken(job) {
  if (job.status !== 'error' && job.chapters?.length) return;
  log.info('upload', `re-analyzing cached job ${job.id} (status=${job.status})`);
  analyzeJob(job.id).catch(err => log.error('upload', `analyzeJob failed for ${job.id}`, { err }));
}

// GET /api/upload/lookup?sha256=<hex> — reuse a book uploaded before
router.get('/lookup', (req, res) => {
  const job = /^[a-f0-9]{64}$/.test(req.query.sha256 || '') ? jobService.findJobByHash(req.query.sha256) : null;
  log.info('upload', `lookup ${job ? 'hit' : 'miss'}`, { sha256: req.query.sha256, jobId: job?.id });
  if (!job) return res.status(404).json({ error: 'Not found' });
  reanalyzeIfBroken(job);
  res.json(describe(job, { cached: true }));
});

// POST /api/upload/:jobId/replace — same book entry: drop its audio and detect chapters again
router.post('/:jobId/replace', async (req, res, next) => {
  try {
    const job = jobService.getJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (store.listChapters(job.id).some(c => c.state === 'generating' || c.state === 'queued')) {
      return res.status(409).json({ error: 'Stop generation for this book before replacing it' });
    }
    await req.app.locals.generator.stopJob(job.id);
    jobService.resetGeneration(job.id);
    audioService.cleanupDir(path.join(config.uploadDir, 'audio', job.id));
    audioService.cleanupDir(path.join(config.uploadDir, 'chunks', job.id));
    jobService.updateJob(job.id, {
      chapters_json: null, chapter_audios_json: null, transcript_json: null, error_message: null,
      audio_url: null, audio_path: null, status: 'pending', stage: 'pending', progress: 0,
    });
    log.info('upload', `replace ${job.id}`);
    res.json(describe(job));
    analyzeJob(job.id).catch(err => log.error('upload', `analyzeJob failed for ${job.id}`, { err }));
  } catch (err) { next(err); }
});

// POST /api/upload/:jobId/copy — new book entry from the same PDF; the old one stays as it is
router.post('/:jobId/copy', async (req, res, next) => {
  try {
    const job = jobService.getJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const jobId = uuidv4();
    const sha256 = job.pdf_sha256 || await hashFile(job.pdf_path);
    const pdfPath = path.join(path.dirname(job.pdf_path), `${jobId}.pdf`);
    fs.copyFileSync(job.pdf_path, pdfPath);
    let copy;
    try {
      // The hash moves to the newest copy so the next upload of this PDF finds it
      copy = db.transaction(() => {
        const holder = jobService.findJobByHash(sha256);
        if (holder) jobService.updateJob(holder.id, { pdf_sha256: null });
        return jobService.createJob({
          id: jobId,
          pdf_path: pdfPath,
          pdf_filename: job.pdf_filename,
          pdf_size_bytes: job.pdf_size_bytes,
          page_count: job.page_count,
          voice: job.voice,
          speed: job.speed,
          pdf_sha256: sha256,
        });
      })();
    } catch (err) {
      fs.rmSync(pdfPath, { force: true });
      throw err;
    }
    log.info('upload', `copy ${job.id} -> ${jobId}`);
    res.json(describe(copy));
    analyzeJob(jobId).catch(err => log.error('upload', `analyzeJob failed for ${jobId}`, { err }));
  } catch (err) { next(err); }
});

router.post('/', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const t0 = Date.now();
    const sha256 = await hashFile(req.file.path);
    const existing = jobService.findJobByHash(sha256);
    const cacheHit = job => {
      fs.unlinkSync(req.file.path);
      log.info('upload', `cache hit ${job.id} (${req.file.originalname})`, { ms: Date.now() - t0 });
      reanalyzeIfBroken(job);
      return res.json(describe(job, { cached: true }));
    };
    if (existing) return cacheHit(existing);

    const jobId = uuidv4();
    let pageCount = null;

    // Try to get page count from PDF
    try {
      const dataBuffer = fs.readFileSync(req.file.path);
      const pdfData = await pdfParse(dataBuffer, { max: 1 }); // parse just metadata
      pageCount = pdfData.numpages;
    } catch {
      // non-fatal — page count is informational
    }

    try {
      jobService.createJob({
        id: jobId,
        pdf_path: req.file.path,
        pdf_filename: req.file.originalname,
        pdf_size_bytes: req.file.size,
        page_count: pageCount,
        voice: config.tts.defaultVoice,
        speed: 1.0,
        pdf_sha256: sha256,
      });
    } catch (err) {
      // Same PDF uploaded concurrently: the other request created the job first
      const raced = err.code === 'SQLITE_CONSTRAINT_UNIQUE' && jobService.findJobByHash(sha256);
      if (raced) return cacheHit(raced);
      throw err;
    }
    log.info('upload', `cache miss, new job ${jobId} (${req.file.originalname})`, { bytes: req.file.size, pageCount, ms: Date.now() - t0 });

    res.json({
      jobId,
      filename: req.file.originalname,
      sizeBytes: req.file.size,
      pageCount,
    });

    // Analyze asynchronously (non-blocking) — will push SSE 'analyzed' event
    analyzeJob(jobId).catch(err => log.error('upload', `analyzeJob failed for ${jobId}`, { err }));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
