const express = require('express');
const jobService = require('../services/jobService');
const config = require('../config');
const store = require('../services/chapterStore');

const router = express.Router();

// GET /api/job/summary?ids=a,b — status of the books this browser has opened (no list-all: the server is public)
router.get('/summary', (req, res) => {
  const ids = String(req.query.ids || '').split(',').filter(Boolean).slice(0, 100);
  res.json(ids.map(id => jobService.getJob(id)).filter(Boolean).map(job => {
    const states = store.listChapters(job.id).map(c => c.state);
    const has = (...s) => states.some(x => s.includes(x));
    return {
      id: job.id,
      filename: job.pdf_filename,
      createdAt: job.created_at,
      totalChapters: job.chapters ? job.chapters.length : 0,
      readyChapters: states.filter(s => s === 'ready').length,
      status: has('generating', 'queued') ? 'generating' : has('paused', 'stopped') ? 'stopped' : has('ready') ? 'done' : 'not_started',
    };
  }));
});

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
