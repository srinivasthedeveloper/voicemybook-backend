require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const config = require('./config');

// Initialize DB (runs migrations)
require('./db');

// Ensure upload directories exist
['pdfs', 'chunks', 'audio', 'previews'].forEach(dir => {
  fs.mkdirSync(path.join(config.uploadDir, dir), { recursive: true });
});

const app = express();

app.use(cors({
  origin: process.env.NODE_ENV === 'production' ? true : ['http://localhost:5173', 'http://127.0.0.1:5173'],
  methods: ['GET', 'POST'],
}));
app.use(express.json());

// Routes
app.use('/api/upload',   require('./routes/upload'));
app.use('/api/convert',  require('./routes/convert'));
app.use('/api/audio',    require('./routes/audio'));
app.use('/api/progress', require('./routes/progress'));
app.use('/api/job',      require('./routes/job'));
app.use('/api/voices',   require('./routes/voices'));

// Global error handler
app.use(require('./middleware/errorHandler'));

// Serve React app in production
if (process.env.NODE_ENV === 'production' && fs.existsSync(path.join(__dirname, '../frontend/dist'))) {
  const distPath = path.join(__dirname, '../frontend/dist');
  app.use(express.static(distPath));
  app.get('*', (req, res) => res.sendFile(path.join(distPath, 'index.html')));
}

// ── Cleanup old jobs ──────────────────────────────────────────────────────────
if (config.cleanupAfterHours > 0) {
  const jobService = require('./services/jobService');
  const audioService = require('./services/audioService');

  setInterval(() => {
    const oldJobs = jobService.getOldJobs(config.cleanupAfterHours);
    for (const job of oldJobs) {
      try {
        if (job.pdf_path && fs.existsSync(job.pdf_path)) fs.unlinkSync(job.pdf_path);
        if (job.audio_path && fs.existsSync(job.audio_path)) fs.unlinkSync(job.audio_path);
        // Clean up per-chapter audio directory
        const jobAudioDir = path.join(config.uploadDir, 'audio', job.id);
        if (fs.existsSync(jobAudioDir)) audioService.cleanupDir(jobAudioDir);
        // Clean up chunk directories
        const jobChunksDir = path.join(config.uploadDir, 'chunks', job.id);
        if (fs.existsSync(jobChunksDir)) audioService.cleanupDir(jobChunksDir);
        jobService.deleteJob(job.id);
        console.log(`[Cleanup] Deleted job ${job.id}`);
      } catch (err) {
        console.error(`[Cleanup] Failed to delete job ${job.id}:`, err.message);
      }
    }
  }, 60 * 60 * 1000); // run every hour
}

app.listen(config.port, () => {
  console.log(`VoiceMyBook backend running on http://localhost:${config.port}`);
});
