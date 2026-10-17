const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const jobService = require('../services/jobService');
const store = require('../services/chapterStore');
const log = require('../services/logger');
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

// GET /api/audio/:id/ch/:ch/run/:run/chunk/:n — one streamed chunk
router.get('/:id/ch/:ch/run/:run/chunk/:n', (req, res) => {
  if (!jobService.getJob(req.params.id)) return res.status(404).json({ error: 'Job not found' });
  const [ch, run, n] = [req.params.ch, req.params.run, req.params.n].map(v => parseInt(v, 10));
  if ([ch, run, n].some(isNaN)) return res.status(400).json({ error: 'Invalid chunk path' });
  const file = path.join(config.uploadDir, 'chunks', req.params.id, `ch_${ch}`, `run_${run}`, `${String(n).padStart(4, '0')}.mp3`);
  serveFile(res, file);
});

// GET /api/audio/:id/zip — all ready chapters, one MP3 each
router.get('/:id/zip', (req, res, next) => {
  const job = jobService.getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const titles = job.chapters || [];
  const ready = store.listChapters(job.id).filter(c => c.hasAudio)
    .map(c => ({ ch: c.chapterIndex, file: path.join(config.uploadDir, 'audio', job.id, `ch_${c.chapterIndex}.mp3`) }))
    .filter(r => fs.existsSync(r.file));
  if (ready.length === 0) return res.status(404).json({ error: 'No chapters ready' });

  const t0 = Date.now();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vmb-zip-'));
  const names = ready.map(({ ch, file }) => {
    const title = (titles[ch]?.title || `Chapter ${ch + 1}`).replace(/[\\/:*?"<>|]/g, '_');
    const name = `${String(ch + 1).padStart(2, '0')} - ${title}.mp3`;
    fs.symlinkSync(file, path.join(tmp, name));
    return name;
  });
  const out = path.join(tmp, 'book.zip');

  execFile('zip', ['-q', '-0', '-j', out, ...names], { cwd: tmp }, err => {
    if (err) {
      fs.rmSync(tmp, { recursive: true, force: true });
      return next(new Error(`zip failed: ${err.message}`));
    }
    const book = job.pdf_filename.replace(/\.pdf$/i, '').replace(/[^\w .-]/g, '_');
    const size = fs.statSync(out).size;
    log.info('zip', `${job.id} ${names.length} chapters`, { bytes: size, ms: Date.now() - t0 });
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': size,
      'Content-Disposition': `attachment; filename="${book}.zip"`,
    });
    const stream = fs.createReadStream(out);
    res.on('close', () => fs.rmSync(tmp, { recursive: true, force: true }));
    stream.pipe(res);
  });
});

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
