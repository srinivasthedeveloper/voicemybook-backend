const express = require('express');
const jobService = require('../services/jobService');

const router = express.Router();

router.get('/:id', (req, res) => {
  const { id } = req.params;
  const job = jobService.getJob(id);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Send current state immediately (late joiner support)
  const current = {
    stage:            job.stage || job.status,
    status:           job.status,
    progress:         job.progress || 0,
    message:          statusMessage(job),
    chunksTotal:      job.chunks_total,
    chunksDone:       job.chunks_done,
    audioUrl:         job.audio_url || null,
    chapters:         job.chapters  || null,
    chapterAudios:    job.chapter_audios || null,
    transcript:       job.transcript || null,
    error:            job.error_message || null,
  };
  res.write(`event: status\ndata: ${JSON.stringify(current)}\n\n`);

  // If already terminal, close immediately
  if (job.status === 'complete' || job.status === 'error') {
    res.write(`event: close\ndata: {}\n\n`);
    res.end();
    return;
  }

  // Register for future updates
  jobService.registerSSEClient(id, res);

  // Heartbeat to prevent proxy timeouts
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(':heartbeat\n\n');
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    jobService.unregisterSSEClient(id, res);
  });
});

function statusMessage(job) {
  switch (job.stage || job.status) {
    case 'pending':    return 'Waiting to start...';
    case 'analyzing':  return 'Detecting chapters...';
    case 'analyzed':   return `Detected ${job.chapters?.length || 0} chapter(s)`;
    case 'queued':     return 'Queued for processing...';
    case 'extracting': return 'Extracting text from PDF...';
    case 'tts':        return job.chunks_total
      ? `Converting chunk ${job.chunks_done} of ${job.chunks_total}...`
      : 'Converting text to speech...';
    case 'chapter_ready': return 'Chapter ready!';
    case 'stitching':  return 'Combining audio fragments...';
    case 'complete':   return 'All chapters ready!';
    case 'error':      return job.error_message || 'An error occurred';
    default:           return 'Processing...';
  }
}

module.exports = router;
