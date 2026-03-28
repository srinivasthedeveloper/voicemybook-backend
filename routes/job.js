const express = require('express');
const jobService = require('../services/jobService');
const config = require('../config');

const router = express.Router();

// GET /api/job/:id — polling fallback
router.get('/:id', (req, res) => {
  const job = jobService.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// GET /api/job/voices — list available TTS voices
router.get('/voices/list', (req, res) => {
  res.json({ voices: config.voices });
});

module.exports = router;
