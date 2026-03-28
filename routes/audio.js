const express = require('express');
const fs = require('fs');
const path = require('path');
const jobService = require('../services/jobService');
const config = require('../config');

const router = express.Router();

function serveFile(res, filePath) {
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Audio file not found on disk' });
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = res.req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = end - start + 1;

    res.writeHead(206, {
      'Content-Range':  `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges':  'bytes',
      'Content-Length': chunkSize,
      'Content-Type':   'audio/mpeg',
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type':   'audio/mpeg',
      'Accept-Ranges':  'bytes',
      'Content-Disposition': `inline; filename="${path.basename(filePath)}"`,
    });
    fs.createReadStream(filePath).pipe(res);
  }
}

// GET /api/audio/:id/ch/:chapterIndex — per-chapter audio
router.get('/:id/ch/:chapterIndex', (req, res) => {
  const job = jobService.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const chIdx = parseInt(req.params.chapterIndex, 10);
  if (isNaN(chIdx)) return res.status(400).json({ error: 'Invalid chapterIndex' });

  const filePath = path.join(config.uploadDir, 'audio', req.params.id, `ch_${chIdx}.mp3`);
  serveFile(res, filePath);
});

// GET /api/audio/:id — full combined audio (legacy / fallback)
router.get('/:id', (req, res) => {
  const job = jobService.getJob(req.params.id);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  // If job has per-chapter audios, redirect to chapter 0 as default
  if (job.chapter_audios) {
    const audios = job.chapter_audios;
    const firstKey = Object.keys(audios).sort((a, b) => Number(a) - Number(b))[0];
    if (firstKey != null) {
      return res.redirect(`/api/audio/${req.params.id}/ch/${firstKey}`);
    }
  }

  if (job.status !== 'complete' || !job.audio_path) {
    return res.status(202).json({
      status: job.status,
      progress: job.progress || 0,
      message: 'Audio is not ready yet',
    });
  }

  serveFile(res, job.audio_path);
});

module.exports = router;
