const express = require('express');
const jobService = require('../services/jobService');
const { validateSettings } = require('./generate');

const router = express.Router();

// Legacy one-shot convert: thin wrapper over the generator
router.post('/', async (req, res, next) => {
  try {
    const { jobId, selectedChapterIndices } = req.body;

    if (!jobId) return res.status(400).json({ error: 'jobId is required' });

    const job = jobService.getJob(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const s = validateSettings(req.body, job);
    if (s.error) return res.status(400).json({ error: s.error });

    const total = (job.chapters || []).length;
    const chapterIndices = Array.isArray(selectedChapterIndices) && selectedChapterIndices.length
      ? selectedChapterIndices.filter(i => Number.isInteger(i) && i >= 0 && i < total)
      : (job.chapters || []).map((c, i) => i).filter(i => !job.chapters[i].isSkippable);

    jobService.updateJob(jobId, { voice: s.voice, speed: s.speed });
    await req.app.locals.generator.start(jobId, chapterIndices);

    res.status(202).json({ jobId, status: 'queued', voice: s.voice, speed: s.speed });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
