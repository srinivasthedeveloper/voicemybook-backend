const express = require('express');
const { v4: uuidv4 } = require('uuid');
const pdfParse = require('pdf-parse');
const fs = require('fs');
const upload = require('../middleware/uploadMiddleware');
const jobService = require('../services/jobService');
const { analyzeJob } = require('../queues/conversionQueue');
const config = require('../config');

const router = express.Router();

router.post('/', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const jobId = uuidv4();
    let pageCount = null;

    // Try to get page count from PDF
    try {
      const dataBuffer = fs.readFileSync(req.file.path);
      const pdfData = await pdfParse(dataBuffer, { max: 1 }); // parse just metadata
      pageCount = pdfData.numpages;
    } catch {
      // non-fatal — page count is informational
    }

    jobService.createJob({
      id: jobId,
      pdf_path: req.file.path,
      pdf_filename: req.file.originalname,
      pdf_size_bytes: req.file.size,
      page_count: pageCount,
      voice: config.tts.defaultVoice,
      speed: 1.0,
    });

    res.json({
      jobId,
      filename: req.file.originalname,
      sizeBytes: req.file.size,
      pageCount,
    });

    // Analyze asynchronously (non-blocking) — will push SSE 'analyzed' event
    analyzeJob(jobId).catch(err =>
      console.error(`[Upload] analyzeJob failed for ${jobId}:`, err.message)
    );
  } catch (err) {
    next(err);
  }
});

module.exports = router;
