const express = require('express');
const jobService = require('../services/jobService');
const log = require('../services/logger');
const config = require('../config');

const router = express.Router();

const VALID_VOICES = new Set(config.voices.map(v => v.id));

// Validates voice/speed; missing fields fall back to the job's current values
function validateSettings(body, job = {}) {
  const voice = body.voice ?? job.voice ?? config.tts.defaultVoice;
  const speed = body.speed ?? job.speed ?? 1.0;
  if (!VALID_VOICES.has(voice)) return { error: `Unknown voice: ${voice}` };
  if (typeof speed !== 'number' || !(speed >= 0.5 && speed <= 2.0)) return { error: 'speed must be a number between 0.5 and 2.0' };
  return { voice, speed };
}

function validChapter(job, ch) {
  return Number.isInteger(ch) && ch >= 0 && ch < (job.chapters || []).length;
}

function loadJob(req, res, next) {
  req.job = jobService.getJob(req.params.jobId);
  if (!req.job) return res.status(404).json({ error: 'Job not found' });
  next();
}

const ok = res => res.status(202).json({ ok: true });

// POST /api/generate/stop-all — stop the active chapter and clear the queue for every book
router.post('/stop-all', async (req, res, next) => {
  try {
    log.info('api', 'stop all');
    await req.app.locals.generator.stopAll();
    ok(res);
  } catch (err) { next(err); }
});

router.get('/:jobId', loadJob, (req, res) => {
  res.json(req.app.locals.generator.state(req.job.id));
});

router.post('/:jobId/start', loadJob, async (req, res, next) => {
  try {
    const { chapters } = req.body;
    if (!Array.isArray(chapters) || chapters.length === 0 || !chapters.every(ch => validChapter(req.job, ch))) {
      return res.status(400).json({ error: 'chapters must be a non-empty array of valid chapter indices' });
    }
    const s = validateSettings(req.body, req.job);
    if (s.error) return res.status(400).json({ error: s.error });
    jobService.updateJob(req.job.id, { voice: s.voice, speed: s.speed });
    log.info('api', `start ${req.job.id} chapters=${chapters.join(',')}`, s);
    await req.app.locals.generator.start(req.job.id, chapters);
    ok(res);
  } catch (err) { next(err); }
});

for (const action of ['pause', 'resume', 'stop']) {
  router.post(`/:jobId/${action}`, loadJob, async (req, res, next) => {
    try {
      log.info('api', `${action} ${req.job.id}`);
      await req.app.locals.generator[`${action}Job`](req.job.id);
      ok(res);
    } catch (err) { next(err); }
  });
}

for (const action of ['pause', 'stop']) {
  router.post(`/:jobId/chapters/:ch/${action}`, loadJob, async (req, res, next) => {
    try {
      const ch = Number(req.params.ch);
      if (!validChapter(req.job, ch)) return res.status(400).json({ error: 'Invalid chapter' });
      log.info('api', `${action} ${req.job.id} ch${ch}`);
      await req.app.locals.generator[`${action}Chapter`](req.job.id, ch);
      ok(res);
    } catch (err) { next(err); }
  });
}

router.post('/:jobId/settings', loadJob, async (req, res, next) => {
  try {
    const { mode, chapterIndex } = req.body;
    if (mode !== 'restart-chapter' && mode !== 'resume') return res.status(400).json({ error: 'mode must be restart-chapter or resume' });
    if (chapterIndex != null && !validChapter(req.job, chapterIndex)) return res.status(400).json({ error: 'Invalid chapterIndex' });
    const s = validateSettings(req.body, req.job);
    if (s.error) return res.status(400).json({ error: s.error });
    await req.app.locals.generator.applySettings(req.job.id, s, mode, chapterIndex);
    ok(res);
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.validateSettings = validateSettings;
