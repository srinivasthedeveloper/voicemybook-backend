const express = require('express');
const jobService = require('../services/jobService');
const { enqueueJob } = require('../queues/conversionQueue');
const config = require('../config');

const router = express.Router();

const VALID_VOICES = config.voices.map(v => v.id);

router.post('/', async (req, res, next) => {
  try {
    const { jobId, voice, speed, selectedChapterIndices } = req.body;

    if (!jobId) return res.status(400).json({ error: 'jobId is required' });

    const job = jobService.getJob(jobId);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    if (['queued', 'extracting', 'tts', 'stitching', 'complete'].includes(job.status)) {
      return res.status(409).json({ error: `Job is already in status: ${job.status}` });
    }

    const selectedVoice = VALID_VOICES.includes(voice) ? voice : config.tts.defaultVoice;
    const selectedSpeed = (typeof speed === 'number' && speed >= 0.5 && speed <= 2.0) ? speed : 1.0;

    // Validate selectedChapterIndices
    const chapterIndices = Array.isArray(selectedChapterIndices)
      ? selectedChapterIndices.filter(i => typeof i === 'number' && Number.isInteger(i) && i >= 0)
      : null;

    // Update job with chosen settings
    jobService.updateJob(jobId, {
      voice: selectedVoice,
      speed: selectedSpeed,
      status: 'queued',
      stage: 'queued',
    });

    // Enqueue async processing
    enqueueJob(jobId, chapterIndices);

    res.status(202).json({
      jobId,
      status: 'queued',
      voice: selectedVoice,
      speed: selectedSpeed,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
