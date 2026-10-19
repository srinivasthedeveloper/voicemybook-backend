const fs = require('fs');
const path = require('path');
const log = require('./logger');
const { chapterChunks } = require('./ttsService');
const { engineOf } = require('./refVoices');

const pad = n => String(n).padStart(4, '0');

function createGenerator(deps) {
  const { synthesize, stitch, getChapters, emit, store, jobs, uploadDir } = deps;
  const slots = { kokoro: deps.parallel ?? 1, turbo: 1, chatterbox: 1, ...deps.slots };
  const engineStatus = deps.engineStatus || (() => ({}));
  const modelCached = deps.modelCached || (() => true);
  const queue = [];           // [{ jobId, chapterIndex, engine }]
  const actives = new Map();  // key -> { jobId, chapterIndex, request: null | 'pause' | 'stop', done }
  const totals = new Map();   // key -> chunk count of the chapter text
  const etas = new Map();     // key -> estimated seconds left
  const msPerChar = {};       // engine -> moving average of synthesis time per character
  const DOWNLOAD = { turbo: '~4 GB', chatterbox: '~3.2 GB' };

  const runDir = (jobId, ch, runId) => path.join(uploadDir, 'chunks', jobId, `ch_${ch}`, `run_${runId}`);
  const chunkUrl = (jobId, ch, runId, i) => `/api/audio/${jobId}/ch/${ch}/run/${runId}/chunk/${i}`;
  const keyOf = (jobId, ch) => `${jobId}:${ch}`;
  const engineOfJob = jobId => engineOf(jobs.getJob(jobId)?.voice);
  const enqueue = (jobId, ch) => queue.push({ jobId, chapterIndex: ch, engine: engineOfJob(jobId) });
  const activeOf = (jobId, ch) => [...actives.values()].filter(a => a.jobId === jobId && (ch == null || a.chapterIndex === ch));

  function setState(jobId, ch, patch, extra = {}) {
    const c = store.setChapter(jobId, ch, patch);
    emit(jobId, { stage: 'chapter_state', chapterIndex: c.chapterIndex, state: c.state, runId: c.runId, hasAudio: c.hasAudio, ...extra });
    log.info('gen', `${jobId} ch${c.chapterIndex} -> ${c.state}`, { runId: c.runId, ...extra });
    return c;
  }

  function emitQueue(extraJobIds = []) {
    const payload = queue.map(q => ({ jobId: q.jobId, chapterIndex: q.chapterIndex, engine: q.engine }));
    for (const id of new Set([...extraJobIds, ...queue.map(q => q.jobId)])) {
      const engine = engineOfJob(id);
      emit(id, { stage: 'generator_state', queue: payload, parallel: slots[engine], msPerChar: msPerChar[engine] ?? 0 });
    }
  }

  function discardRun(jobId, ch, runId) {
    store.deleteRunChunks(jobId, ch, runId);
    fs.rmSync(runDir(jobId, ch, runId), { recursive: true, force: true });
  }

  function removeQueued(jobId, ch) {
    const removed = [];
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i].jobId === jobId && (ch == null || queue[i].chapterIndex === ch)) removed.unshift(...queue.splice(i, 1));
    }
    return removed;
  }

  // Fills each engine's free slots from the FIFO queue; a busy engine never holds up another
  function kick() {
    const busy = engine => [...actives.values()].filter(a => a.engine === engine).length;
    for (let i = 0; i < queue.length;) {
      if (busy(queue[i].engine) >= slots[queue[i].engine]) { i++; continue; }
      const item = queue.splice(i, 1)[0];
      const key = keyOf(item.jobId, item.chapterIndex);
      const current = { ...item, request: null };
      actives.set(key, current);
      emitQueue([item.jobId]);
      current.done = runChapter(current)
        .catch(err => {
          log.error('gen', `${item.jobId} ch${item.chapterIndex} failed`, { err });
          setState(item.jobId, item.chapterIndex, { state: 'paused' }, { error: err.message || String(err) });
        })
        .finally(() => { actives.delete(key); etas.delete(key); kick(); });
    }
  }

  function applyRequest(item, runId) {
    const { jobId, chapterIndex: ch } = item;
    if (item.request === 'pause') return setState(jobId, ch, { state: 'paused' });
    discardRun(jobId, ch, runId);
    // New runId tells clients the discarded chunks are gone
    return setState(jobId, ch, { state: store.getChapter(jobId, ch).hasAudio ? 'ready' : 'stopped', runId: runId + 1 });
  }

  async function runChapter(item) {
    const { jobId, chapterIndex: ch } = item;
    const chapter = (await getChapters(jobId))[ch] || {};
    const engine = item.engine;
    const chunks = chapterChunks(chapter.title, chapter.text || '', engine);
    if (chunks.length === 0) {
      log.warn('gen', `${jobId} ch${ch} has no text, skipping`);
      const c = store.getChapter(jobId, ch);
      return setState(jobId, ch, { state: c.hasAudio ? 'ready' : 'not_started' }, { error: 'Chapter has no text' });
    }
    const key = keyOf(jobId, ch);
    const charsFrom = i => chunks.slice(i).reduce((n, c) => n + c.text.length, 0);
    totals.set(key, chunks.length);
    // A run's chunks must all come from one engine: left-over chunks from another engine start a new run
    const prev = store.getChapter(jobId, ch);
    const leftover = store.listChunks(jobId, ch, prev.runId);
    const stale = leftover.length > 0 && engineOf(leftover[0].voice) !== engine;
    if (stale) discardRun(jobId, ch, prev.runId);
    const { runId } = setState(jobId, ch, stale ? { state: 'generating', runId: prev.runId + 1 } : { state: 'generating' }, { totalChunks: chunks.length });
    const dir = runDir(jobId, ch, runId);
    if (engine !== 'kokoro' && engineStatus()[engine] !== 'ready') {
      const note = `Loading the expressive voice…${modelCached(engine) ? '' : ` (first use downloads ${DOWNLOAD[engine]})`}`;
      setState(jobId, ch, { state: 'generating' }, { totalChunks: chunks.length, note });
    }

    for (let i = store.listChunks(jobId, ch, runId).length; i < chunks.length; i++) {
      if (item.request) return applyRequest(item, runId);
      const { voice, speed } = jobs.getJob(jobId);
      if (engineOf(voice) !== engine) {
        // The book switched engine mid-run: start this chapter over on the new engine
        discardRun(jobId, ch, runId);
        setState(jobId, ch, { state: 'queued', runId: runId + 1 });
        enqueue(jobId, ch);
        return;
      }
      const filePath = path.join(dir, `${pad(i)}.mp3`);
      const t0 = Date.now();
      const durationSec = await synthesize(chunks[i].text, { voice, speed, padSec: chunks[i].pauseAfterSec }, filePath);
      const sample = (Date.now() - t0) / Math.max(1, chunks[i].text.length);
      msPerChar[engine] = msPerChar[engine] ? msPerChar[engine] * 0.7 + sample * 0.3 : sample;
      const etaSec = Math.round((charsFrom(i + 1) * msPerChar[engine]) / 1000);
      etas.set(key, etaSec);
      store.addChunk({ jobId, chapterIndex: ch, runId, chunkIndex: i, text: chunks[i].text, voice, speed, durationSec, filePath });
      emit(jobId, { stage: 'chunk_ready', chapterIndex: ch, runId, chunkIndex: i, totalChunks: chunks.length, etaSec, url: chunkUrl(jobId, ch, runId, i), text: chunks[i].text, durationSec, voice, speed });
      log.debug('gen', () => {
        const ms = Date.now() - t0;
        return `${jobId} ch${ch} chunk ${i + 1}/${chunks.length} chars=${chunks[i].text.length} ms=${ms} rtf=${(durationSec / (ms / 1000)).toFixed(2)}`;
      });
    }
    if (item.request) return applyRequest(item, runId);
    await finishChapter(jobId, ch, runId);
  }

  async function finishChapter(jobId, ch, runId) {
    const all = store.listChunks(jobId, ch, runId);
    const outDir = path.join(uploadDir, 'audio', jobId);
    const out = path.join(outDir, `ch_${ch}.mp3`);
    const tmp = path.join(outDir, `ch_${ch}.tmp.mp3`);
    const t0 = Date.now();
    fs.mkdirSync(outDir, { recursive: true });
    await stitch(all.map(c => c.filePath), tmp);
    fs.renameSync(tmp, out);
    log.info('gen', `${jobId} ch${ch} stitched ${all.length} chunks`, { ms: Date.now() - t0 });

    let acc = 0;
    const transcript = all.map(c => {
      const entry = { startSec: acc, endSec: acc + c.durationSec, text: c.text, chapterIndex: ch };
      acc = entry.endSec;
      return entry;
    });
    const job = jobs.getJob(jobId);
    const merged = (job.transcript || []).filter(e => e.chapterIndex !== ch).concat(transcript)
      .sort((a, b) => a.chapterIndex - b.chapterIndex);
    const audioUrl = `/api/audio/${jobId}/ch/${ch}`;
    jobs.updateJob(jobId, {
      transcript_json: JSON.stringify(merged),
      chapter_audios_json: JSON.stringify({ ...(job.chapter_audios || {}), [ch]: audioUrl }),
    });

    // Older runs are superseded once this one is stitched
    const chDir = path.dirname(runDir(jobId, ch, runId));
    for (const name of fs.existsSync(chDir) ? fs.readdirSync(chDir) : []) {
      const old = Number(name.replace('run_', ''));
      if (name.startsWith('run_') && old !== runId) discardRun(jobId, ch, old);
    }

    setState(jobId, ch, { state: 'ready', hasAudio: true });
    emit(jobId, { stage: 'chapter_ready', chapterIndex: ch, audioUrl, transcript });
  }

  async function start(jobId, chapterIndices) {
    for (const ch of chapterIndices) {
      const c = store.getChapter(jobId, ch);
      if (c.state === 'queued' || c.state === 'generating') continue;
      setState(jobId, ch, c.state === 'paused' ? { state: 'queued' } : { state: 'queued', runId: c.runId + 1 });
      enqueue(jobId, ch);
    }
    emitQueue([jobId]);
    kick();
  }

  // Queued/paused chapter leaves the generator: held as paused (resume re-queues it), or discarded on stop
  function release(jobId, ch, mode) {
    const c = store.getChapter(jobId, ch);
    if (mode === 'pause') return setState(jobId, ch, { state: 'paused' });
    discardRun(jobId, ch, c.runId);
    setState(jobId, ch, { state: c.hasAudio ? 'ready' : 'not_started', runId: c.runId + 1 });
  }

  async function pauseJob(jobId) {
    for (const a of activeOf(jobId)) a.request = 'pause';
    for (const q of removeQueued(jobId)) release(jobId, q.chapterIndex, 'pause');
    emitQueue([jobId]);
  }

  async function resumeJob(jobId, first) {
    for (const a of activeOf(jobId)) if (a.request === 'pause') a.request = null;
    const paused = store.listChapters(jobId).filter(c => c.state === 'paused').map(c => c.chapterIndex);
    const order = first != null && paused.includes(first) ? [first, ...paused.filter(i => i !== first)] : paused;
    for (const ch of order) {
      setState(jobId, ch, { state: 'queued' });
      enqueue(jobId, ch);
    }
    emitQueue([jobId]);
    kick();
  }

  async function stopJob(jobId) {
    for (const a of activeOf(jobId)) a.request = 'stop';
    for (const q of removeQueued(jobId)) release(jobId, q.chapterIndex, 'stop');
    for (const c of store.listChapters(jobId)) {
      if (c.state === 'paused') release(jobId, c.chapterIndex, 'stop');
    }
    emitQueue([jobId]);
  }

  // Stops the active chapters and empties the queue for every book; paused chapters keep their chunks
  async function stopAll() {
    const jobIds = [...new Set([...[...actives.values()].map(a => a.jobId), ...queue.map(q => q.jobId)])];
    for (const a of actives.values()) a.request = 'stop';
    for (const q of queue.splice(0)) release(q.jobId, q.chapterIndex, 'stop');
    log.info('gen', `stop all (${jobIds.length} book(s))`);
    emitQueue(jobIds);
  }

  async function pauseChapter(jobId, ch) {
    const [a] = activeOf(jobId, ch);
    if (a) a.request = 'pause';
    else if (removeQueued(jobId, ch).length) release(jobId, ch, 'pause');
    emitQueue([jobId]);
  }

  async function stopChapter(jobId, ch) {
    const [a] = activeOf(jobId, ch);
    if (a) a.request = 'stop';
    else if (removeQueued(jobId, ch).length || store.getChapter(jobId, ch).state === 'paused') release(jobId, ch, 'stop');
    emitQueue([jobId]);
  }

  async function applySettings(jobId, { voice, speed }, mode, chapterIndex) {
    jobs.updateJob(jobId, { voice, speed });
    log.info('gen', `${jobId} settings voice=${voice} speed=${speed} mode=${mode}`, { chapterIndex });
    const [a] = chapterIndex != null ? activeOf(jobId, chapterIndex) : [];
    if (mode === 'restart-chapter' && a) {
      // Let the in-flight chunk finish and the chapter settle as paused before restarting it
      a.request = 'pause';
      await a.done;
    }
    if (mode === 'restart-chapter' && chapterIndex != null) {
      removeQueued(jobId, chapterIndex);
      const c = store.getChapter(jobId, chapterIndex);
      if (c.state !== 'ready') discardRun(jobId, chapterIndex, c.runId);
      setState(jobId, chapterIndex, { state: 'paused', runId: c.runId + 1 });
    }
    await resumeJob(jobId, chapterIndex);
  }

  function state(jobId) {
    const job = jobs.getJob(jobId);
    return {
      voice: job ? job.voice : null,
      speed: job ? job.speed : null,
      queue: queue.map(q => ({ jobId: q.jobId, chapterIndex: q.chapterIndex, engine: q.engine })),
      parallel: slots[engineOfJob(jobId)],
      msPerChar: msPerChar[engineOfJob(jobId)] ?? 0,
      chapters: store.listChapters(jobId).map(c => ({
        chapterIndex: c.chapterIndex,
        state: c.state,
        runId: c.runId,
        hasAudio: c.hasAudio,
        totalChunks: totals.get(keyOf(jobId, c.chapterIndex)) ?? null,
        etaSec: etas.get(keyOf(jobId, c.chapterIndex)) ?? null,
        chunks: store.listChunks(jobId, c.chapterIndex, c.runId).map(x => ({
          chunkIndex: x.chunkIndex,
          url: chunkUrl(jobId, c.chapterIndex, c.runId, x.chunkIndex),
          text: x.text,
          durationSec: x.durationSec,
          voice: x.voice,
          speed: x.speed,
        })),
      })),
    };
  }

  function recover() {
    for (const r of store.findInterrupted()) {
      const has = store.listChunks(r.jobId, r.chapterIndex, r.runId).length > 0;
      const state = has ? 'paused' : r.hasAudio ? 'ready' : 'not_started';
      store.setChapter(r.jobId, r.chapterIndex, { state });
      log.info('gen', `recovered ${r.jobId} ch${r.chapterIndex} -> ${state}`);
    }
  }

  return { start, pauseJob, resumeJob, stopJob, stopAll, pauseChapter, stopChapter, applySettings, state, recover, isBusy: () => actives.size > 0 };
}

// Real wiring: lazy so tests that only use createGenerator never load Kokoro/ffmpeg
let _generator = null;
function getGenerator() {
  if (_generator) return _generator;
  const config = require('../config');
  const store = require('./chapterStore');
  const jobService = require('./jobService');
  const pdfService = require('./pdfService');
  const { getSynth } = require('./synth');
  const { modelCached } = require('./refVoices');
  const audioService = require('./audioService');
  const textCache = new Map();
  _generator = createGenerator({
    synthesize: (text, opts, mp3Path) => getSynth().synthesize(text, opts, mp3Path),
    engineStatus: () => getSynth().engineStatus(),
    modelCached,
    slots: { kokoro: config.tts.workers, turbo: config.tts.turboWorkers, chatterbox: config.tts.cbWorkers },
    stitch: audioService.stitchFiles,
    getChapters: jobId => {
      if (!textCache.has(jobId)) {
        const job = jobService.getJob(jobId);
        textCache.set(jobId, pdfService.extractText(job.pdf_path)
          .then(({ rawText }) => pdfService.splitChapterTexts(rawText, job.chapters || []).map(c => ({ title: c.title, text: c.text })))
          .catch(err => { textCache.delete(jobId); throw err; }));
      }
      return textCache.get(jobId);
    },
    emit: jobService.emitEvent,
    store,
    jobs: jobService,
    uploadDir: config.uploadDir,
  });
  return _generator;
}

module.exports = { createGenerator, getGenerator };
