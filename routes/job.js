const express = require('express');
const jobService = require('../services/jobService');
const config = require('../config');
const store = require('../services/chapterStore');
const pdfService = require('../services/pdfService');
const log = require('../services/logger');

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

// POST /api/job/:id/range { startPage, endPage } — add (or reuse) a chapter covering those PDF pages
router.post('/:id/range', async (req, res, next) => {
  try {
    const job = jobService.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const busy = () => res.status(409).json({ error: 'Chapters are still being detected; try again in a moment' });
    if (!job.chapters?.length) return busy();
    const { startPage, endPage } = req.body || {};
    const { rawText, pageOffsets } = await pdfService.extractText(job.pdf_path);
    const range = pdfService.pageRangeChapter(pageOffsets, rawText, startPage, endPage);
    if (!range) return res.status(400).json({ error: `Pick pages between 1 and ${pageOffsets.length} that contain text` });

    const chapters = jobService.getJob(job.id).chapters;
    if (!chapters?.length) return busy();
    let index = chapters.findIndex(c => c.isPageRange && c.startPage === startPage && c.endPage === endPage);
    if (index === -1) {
      index = chapters.push(range) - 1;
      jobService.updateJob(job.id, { chapters_json: JSON.stringify(chapters) });
      log.info('api', `range ${job.id} p${startPage}-${endPage} -> ch${index}`);
    }
    res.json({ index, chapters });
  } catch (err) { next(err); }
});

// GET /api/job/voices — list available TTS voices
router.get('/voices/list', (req, res) => {
  res.json({ voices: config.voices });
});

module.exports = router;
