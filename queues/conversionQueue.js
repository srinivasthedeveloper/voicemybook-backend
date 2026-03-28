const path = require('path');
const fs = require('fs');
const jobService = require('../services/jobService');
const pdfService = require('../services/pdfService');
const ttsService = require('../services/ttsService');
const audioService = require('../services/audioService');
const config = require('../config');

// ─── Simple in-memory async queue ────────────────────────────────────────────

class SimpleQueue {
  constructor(concurrency = 1) {
    this.concurrency = concurrency;
    this.running = 0;
    this.pending = [];
  }

  add(task) {
    return new Promise((resolve, reject) => {
      this.pending.push({ task, resolve, reject });
      this._run();
    });
  }

  async _run() {
    if (this.running >= this.concurrency || this.pending.length === 0) return;
    this.running++;
    const { task, resolve, reject } = this.pending.shift();
    try {
      resolve(await task());
    } catch (err) {
      reject(err);
    } finally {
      this.running--;
      this._run();
    }
  }
}

// One conversion job at a time (safe for single-server use)
const queue = new SimpleQueue(1);

// ─── Phase A: Analyze job (fast, runs immediately on upload) ─────────────────

async function analyzeJob(jobId) {
  const job = jobService.getJob(jobId);
  if (!job) {
    console.error(`[Queue] analyzeJob: Job ${jobId} not found`);
    return;
  }

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

    console.log(`[Queue] Job ${jobId} analyzed: ${chapters.length} chapters`);
  } catch (err) {
    const msg = errStr(err);
    console.error(`[Queue] analyzeJob ${jobId} failed:`, msg);
    emit(jobId, { stage: 'error', status: 'error', progress: 0, message: msg, errorMessage: msg });
  }
}

// ─── Enqueue Phase B ──────────────────────────────────────────────────────────

function enqueueJob(jobId, selectedChapterIndices) {
  queue.add(() => processJob(jobId, selectedChapterIndices)).catch(err => {
    console.error(`[Queue] Unhandled error for job ${jobId}:`, err);
  });
}

// ─── Phase B: Process selected chapters ──────────────────────────────────────

async function processJob(jobId, selectedChapterIndices) {
  const job = jobService.getJob(jobId);
  if (!job) {
    console.error(`[Queue] processJob: Job ${jobId} not found`);
    return;
  }

  try {
    // Re-parse chapter texts from the stored chapters_json
    const storedChapters = job.chapters || [];
    if (storedChapters.length === 0) {
      throw new Error('No chapters found. Please re-upload the PDF.');
    }

    // Re-extract raw text (needed to slice chapter texts)
    emit(jobId, { stage: 'extracting', status: 'extracting', progress: 8,
      message: 'Re-reading PDF text...' });

    const { rawText } = await pdfService.extractText(job.pdf_path);
    const chaptersWithText = pdfService.splitChapterTexts(rawText, storedChapters);

    // Determine which chapters to process
    const toProcess = selectedChapterIndices && selectedChapterIndices.length > 0
      ? selectedChapterIndices.filter(i => i >= 0 && i < chaptersWithText.length)
      : chaptersWithText.map((_, i) => i).filter(i => !chaptersWithText[i].isSkippable);

    if (toProcess.length === 0) {
      throw new Error('No chapters selected for conversion.');
    }

    emit(jobId, {
      stage: 'tts', status: 'tts', progress: 10,
      message: `Processing ${toProcess.length} chapter(s)...`,
    });

    const audioDir = path.join(config.uploadDir, 'audio', jobId);
    fs.mkdirSync(audioDir, { recursive: true });

    // Accumulate chapter_audios and transcript across chapters
    const chapterAudios = job.chapter_audios || {};
    const allTranscript = job.transcript || [];

    for (let i = 0; i < toProcess.length; i++) {
      const chIdx = toProcess[i];
      const chapter = chaptersWithText[chIdx];

      emit(jobId, {
        stage: 'tts', status: 'tts',
        chapterIndex: chIdx,
        chapterTitle: chapter.title,
        progress: Math.round(10 + (i / toProcess.length) * 75),
        message: `Converting "${chapter.title}" (${i + 1}/${toProcess.length})...`,
      });

      // Split this chapter's text into TTS chunks
      const chunks = ttsService.splitIntoChunks(chapter.text);

      if (chunks.length === 0) {
        console.warn(`[Queue] Chapter ${chIdx} has no TTS chunks, skipping`);
        continue;
      }

      // Per-chapter chunks directory
      const chapterChunksDir = path.join(config.uploadDir, 'chunks', jobId, `ch_${chIdx}`);

      await ttsService.convertChunks(
        chunks,
        job.voice,
        job.speed,
        chapterChunksDir,
        (done, total) => {
          const chapterProgress = Math.round(10 + ((i + done / total) / toProcess.length) * 75);
          emit(jobId, {
            stage: 'tts', status: 'tts',
            chapterIndex: chIdx,
            progress: chapterProgress,
            chunksTotal: total, chunksDone: done,
            message: `"${chapter.title}": chunk ${done}/${total}...`,
          });
        }
      );

      // Stitch chapter audio
      const chapterAudioPath = path.join(audioDir, `ch_${chIdx}.mp3`);
      await audioService.stitchAudio(chapterChunksDir, chapterAudioPath, chunks.length);

      // Compute transcript timings
      let chapterTranscript = [];
      try {
        chapterTranscript = await audioService.computeChapterTranscript(
          chapterChunksDir, chunks, chIdx
        );
      } catch (err) {
        console.warn(`[Queue] Transcript timing failed for ch ${chIdx}:`, err.message);
      }

      // Cleanup chunk files
      audioService.cleanupDir(chapterChunksDir);

      // Update accumulated data
      const audioUrl = `/api/audio/${jobId}/ch/${chIdx}`;
      chapterAudios[chIdx] = audioUrl;
      allTranscript.push(...chapterTranscript);

      // Persist to DB
      jobService.updateJob(jobId, {
        chapter_audios_json: JSON.stringify(chapterAudios),
        transcript_json: JSON.stringify(allTranscript),
      });

      emit(jobId, {
        stage: 'chapter_ready',
        status: 'tts',
        chapterIndex: chIdx,
        audioUrl,
        transcript: chapterTranscript,
        chapterAudios: { ...chapterAudios },
      });

      console.log(`[Queue] Job ${jobId} chapter ${chIdx} ready`);
    }

    // All done
    emit(jobId, {
      stage: 'complete',
      status: 'complete',
      progress: 100,
      message: 'All chapters ready!',
      chapterAudios: { ...chapterAudios },
    });

    console.log(`[Queue] Job ${jobId} completed successfully`);

  } catch (err) {
    const msg = errStr(err);
    console.error(`[Queue] processJob ${jobId} failed:`, msg);
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

module.exports = { analyzeJob, enqueueJob };
