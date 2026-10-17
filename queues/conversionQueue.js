const jobService = require('../services/jobService');
const pdfService = require('../services/pdfService');
const log = require('../services/logger');

// ─── Phase A: Analyze job (fast, runs immediately on upload) ─────────────────

async function analyzeJob(jobId) {
  const job = jobService.getJob(jobId);
  if (!job) {
    log.error('analyze', `Job ${jobId} not found`);
    return;
  }

  const t0 = Date.now();
  try {
    emit(jobId, { stage: 'analyzing', status: 'analyzing', progress: 3,
      message: 'Detecting chapters...' });

    const { rawText, chapters: detectedChapters, pageCount } = await pdfService.extractText(job.pdf_path);

    if (!rawText || rawText.trim().length < 10) {
      throw new Error('Could not extract readable text from this PDF. It may be image-based or encrypted.');
    }

    // Attach charCount to chapters
    const chaptersWithText = pdfService.splitChapterTexts(rawText, detectedChapters);
    const chapters = chaptersWithText.map(({ text, ...rest }) => ({
      ...rest,
      charCount: text.length,
    }));

    jobService.updateJob(jobId, {
      page_count: pageCount,
      chapters_json: JSON.stringify(chapters),
      status: 'analyzed',
      stage: 'analyzed',
    });

    emit(jobId, {
      stage: 'analyzed',
      status: 'analyzed',
      progress: 5,
      message: `Detected ${chapters.length} chapter(s)`,
      chapters,
      pageCount,
    });

    log.info('analyze', `${jobId} analyzed: ${chapters.length} chapters`, { pageCount, ms: Date.now() - t0 });
  } catch (err) {
    const msg = errStr(err);
    log.error('analyze', `${jobId} failed: ${msg}`, { err });
    emit(jobId, { stage: 'error', status: 'error', progress: 0, message: msg, errorMessage: msg });
  }
}

function emit(jobId, data) {
  jobService.emitProgress(jobId, data);
}

function errStr(err) {
  if (!err) return 'Unknown error';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message || String(err);
  if (typeof err === 'object') return err.message || err.reason || err.code || JSON.stringify(err);
  return String(err);
}

module.exports = { analyzeJob };
