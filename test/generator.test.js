const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const dir = require('./helpers').setupTmpEnv();
const store = require('../services/chapterStore');
const jobService = require('../services/jobService');
const { createGenerator } = require('../services/generator');

const uploadDir = path.join(dir, 'uploads');
const sentence = 'The quick brown fox jumps over the lazy dog again and again. ';
const chapterText = sentence.repeat(15); // ~900 chars -> 3 chunks of <=400

function waitFor(pred, ms = 2000) {
  const end = Date.now() + ms;
  return new Promise((resolve, reject) => {
    (function poll() {
      if (pred()) return resolve();
      if (Date.now() > end) return reject(new Error('waitFor timeout'));
      setTimeout(poll, 5);
    })();
  });
}

let seq = 0;
function setup() {
  const jobId = `job${++seq}`;
  jobService.createJob({ id: jobId, pdf_path: '/p.pdf', pdf_filename: 'p.pdf', pdf_size_bytes: 1, page_count: 1, voice: 'af_heart', speed: 1 });
  const events = [];
  const gate = { blockAt: null, release: null };
  const synthCalls = [];
  const deps = {
    synthesize: async (text, opts, mp3Path) => {
      synthCalls.push({ text, ...opts, mp3Path });
      const n = synthCalls.length - 1;
      if (gate.blockAt === n) await new Promise(r => { gate.release = r; });
      fs.mkdirSync(path.dirname(mp3Path), { recursive: true });
      fs.writeFileSync(mp3Path, 'x');
      return 2.5;
    },
    stitch: async (paths, out) => { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, `stitched:${paths.length}:${Date.now()}`); },
    getChapters: async () => [
      { title: 'Chapter 1', text: `Chapter 1\n${chapterText}` },
      { title: 'Chapter 2', text: chapterText },
      { title: 'Chapter 3', text: chapterText },
      { title: 'Empty', text: '   ' },
    ],
    emit: (id, e) => { if (id === jobId) events.push(e); },
    store,
    jobs: jobService,
    uploadDir,
  };
  const gen = createGenerator(deps);
  const ofStage = (s, ch) => events.filter(e => e.stage === s && (ch == null || e.chapterIndex === ch));
  const chState = ch => store.getChapter(jobId, ch).state;
  return { jobId, gen, events, gate, synthCalls, ofStage, chState };
}

test('chunks are announced in order and chapter becomes ready', async () => {
  const t = setup();
  await t.gen.start(t.jobId, [0]);
  await waitFor(() => t.ofStage('chapter_ready', 0).length === 1);
  const idx = t.ofStage('chunk_ready', 0).map(e => e.chunkIndex);
  assert.ok(idx.length >= 3);
  assert.deepStrictEqual(idx, idx.map((_, i) => i));
  assert.strictEqual(t.gen.state(t.jobId).chapters.find(c => c.chapterIndex === 0).state, 'ready');
  assert.ok(fs.existsSync(path.join(uploadDir, 'audio', t.jobId, 'ch_0.mp3')));
  assert.ok(jobService.getJob(t.jobId).chapter_audios['0']);
});

test('pause mid-chunk keeps chunk and resumes at next index', async () => {
  const t = setup();
  t.gate.blockAt = 1;
  await t.gen.start(t.jobId, [0]);
  await waitFor(() => t.gate.release);
  await t.gen.pauseJob(t.jobId);
  t.gate.release();
  await waitFor(() => t.chState(0) === 'paused');
  const runId = store.getChapter(t.jobId, 0).runId;
  assert.strictEqual(store.listChunks(t.jobId, 0, runId).length, 2);
  await t.gen.resumeJob(t.jobId);
  await waitFor(() => t.chState(0) === 'ready');
  const idx = t.ofStage('chunk_ready', 0).map(e => e.chunkIndex);
  assert.deepStrictEqual(idx, idx.map((_, i) => i));
});

test('stop discards partial run', async () => {
  const t = setup();
  t.gate.blockAt = 1;
  await t.gen.start(t.jobId, [0]);
  await waitFor(() => t.gate.release);
  const runId = store.getChapter(t.jobId, 0).runId;
  await t.gen.stopJob(t.jobId);
  t.gate.release();
  await waitFor(() => t.chState(0) === 'stopped');
  assert.strictEqual(store.listChunks(t.jobId, 0, runId).length, 0);
  assert.ok(!fs.existsSync(path.join(uploadDir, 'chunks', t.jobId, 'ch_0', `run_${runId}`)));
});

test('stop on re-run rolls back to ready', async () => {
  const t = setup();
  await t.gen.start(t.jobId, [0]);
  await waitFor(() => t.chState(0) === 'ready');
  const mp3 = path.join(uploadDir, 'audio', t.jobId, 'ch_0.mp3');
  const before = fs.readFileSync(mp3, 'utf8');
  t.gate.blockAt = t.synthCalls.length;
  await t.gen.start(t.jobId, [0]);
  await waitFor(() => t.gate.release);
  await t.gen.stopJob(t.jobId);
  t.gate.release();
  await waitFor(() => t.chState(0) === 'ready' && t.gen.state(t.jobId).queue.length === 0 && !t.gen.isBusy());
  const ch = store.getChapter(t.jobId, 0);
  assert.strictEqual(ch.hasAudio, true);
  assert.strictEqual(fs.readFileSync(mp3, 'utf8'), before);
  assert.ok(jobService.getJob(t.jobId).chapter_audios['0']);
});

test('queue is FIFO and queued chapter can be removed', async () => {
  const t = setup();
  t.gate.blockAt = 0;
  await t.gen.start(t.jobId, [0, 1, 2]);
  await waitFor(() => t.gate.release);
  assert.strictEqual(t.chState(1), 'queued');
  await t.gen.stopChapter(t.jobId, 2);
  t.gate.release();
  await waitFor(() => t.chState(1) === 'ready');
  assert.strictEqual(t.chState(0), 'ready');
  assert.strictEqual(t.chState(2), 'not_started');
  assert.deepStrictEqual(t.ofStage('chapter_ready').map(e => e.chapterIndex), [0, 1]);
});

test('apply resume uses new speed from next chunk', async () => {
  const t = setup();
  t.gate.blockAt = 1;
  await t.gen.start(t.jobId, [0]);
  await waitFor(() => t.gate.release);
  await t.gen.pauseJob(t.jobId);
  t.gate.release();
  await waitFor(() => t.chState(0) === 'paused');
  await t.gen.applySettings(t.jobId, { voice: 'af_heart', speed: 0.85 }, 'resume');
  await waitFor(() => t.chState(0) === 'ready');
  const chunks = t.ofStage('chunk_ready', 0);
  assert.strictEqual(chunks[0].speed, 1);
  assert.strictEqual(chunks[1].speed, 1);
  assert.ok(chunks.slice(2).length > 0 && chunks.slice(2).every(c => c.speed === 0.85));
});

test('apply restart-chapter starts a new run from chunk 0', async () => {
  const t = setup();
  t.gate.blockAt = 1;
  await t.gen.start(t.jobId, [0]);
  await waitFor(() => t.gate.release);
  const oldRun = store.getChapter(t.jobId, 0).runId;
  await t.gen.pauseJob(t.jobId);
  t.gate.release();
  await waitFor(() => t.chState(0) === 'paused');
  await t.gen.applySettings(t.jobId, { voice: 'af_heart', speed: 0.9 }, 'restart-chapter', 0);
  await waitFor(() => t.chState(0) === 'ready');
  const newRun = store.getChapter(t.jobId, 0).runId;
  assert.strictEqual(newRun, oldRun + 1);
  const first = t.ofStage('chunk_ready', 0).find(e => e.runId === newRun);
  assert.strictEqual(first.chunkIndex, 0);
  assert.strictEqual(first.speed, 0.9);
  assert.ok(!fs.existsSync(path.join(uploadDir, 'chunks', t.jobId, 'ch_0', `run_${oldRun}`)));
});

test('transcript replaced per chapter on re-run', async () => {
  const t = setup();
  await t.gen.start(t.jobId, [0]);
  await waitFor(() => t.ofStage('chapter_ready', 0).length === 1);
  await t.gen.start(t.jobId, [0]);
  await waitFor(() => t.ofStage('chapter_ready', 0).length === 2);
  const runId = store.getChapter(t.jobId, 0).runId;
  const entries = jobService.getJob(t.jobId).transcript.filter(e => e.chapterIndex === 0);
  assert.strictEqual(entries.length, store.listChunks(t.jobId, 0, runId).length);
});

test('chunk duration comes from synthesize result', async () => {
  const t = setup();
  await t.gen.start(t.jobId, [0]);
  await waitFor(() => t.chState(0) === 'ready');
  assert.ok(t.ofStage('chunk_ready', 0).every(e => e.durationSec === 2.5));
  assert.strictEqual(jobService.getJob(t.jobId).transcript.filter(e => e.chapterIndex === 0)[1].startSec, 2.5);
});

test('apply restart-chapter while chunk in flight starts a new run', async () => {
  const t = setup();
  t.gate.blockAt = 1;
  await t.gen.start(t.jobId, [0]);
  await waitFor(() => t.gate.release);
  const oldRun = store.getChapter(t.jobId, 0).runId;
  await t.gen.pauseJob(t.jobId);
  const applied = t.gen.applySettings(t.jobId, { voice: 'af_heart', speed: 0.8 }, 'restart-chapter', 0);
  t.gate.release();
  await applied;
  await waitFor(() => t.chState(0) === 'ready');
  const newRun = store.getChapter(t.jobId, 0).runId;
  assert.strictEqual(newRun, oldRun + 1);
  const run2 = t.ofStage('chunk_ready', 0).filter(e => e.runId === newRun);
  assert.strictEqual(run2[0].chunkIndex, 0);
  assert.ok(run2.every(e => e.speed === 0.8));
});

test('pause then resume keeps queued chapters', async () => {
  const t = setup();
  t.gate.blockAt = 0;
  await t.gen.start(t.jobId, [0, 1, 2]);
  await waitFor(() => t.gate.release);
  await t.gen.pauseJob(t.jobId);
  t.gate.release();
  await waitFor(() => t.chState(0) === 'paused');
  await t.gen.resumeJob(t.jobId);
  await waitFor(() => t.chState(2) === 'ready', 4000);
  assert.deepStrictEqual([0, 1, 2].map(t.chState), ['ready', 'ready', 'ready']);
});

test('stop bumps runId so clients drop deleted chunks', async () => {
  const t = setup();
  t.gate.blockAt = 1;
  await t.gen.start(t.jobId, [0, 1]);
  await waitFor(() => t.gate.release);
  const run0 = store.getChapter(t.jobId, 0).runId;
  const run1 = store.getChapter(t.jobId, 1).runId;
  await t.gen.stopJob(t.jobId);
  t.gate.release();
  await waitFor(() => t.chState(0) === 'stopped');
  assert.strictEqual(store.getChapter(t.jobId, 0).runId, run0 + 1);
  assert.strictEqual(store.getChapter(t.jobId, 1).runId, run1 + 1);
  const last = t.ofStage('chapter_state', 0).at(-1);
  assert.strictEqual(last.runId, run0 + 1);
});

test('recover marks interrupted chapters', () => {
  const t = setup();
  store.setChapter(t.jobId, 0, { state: 'generating', runId: 1 });
  store.addChunk({ jobId: t.jobId, chapterIndex: 0, runId: 1, chunkIndex: 0, text: 'a', voice: 'af_heart', speed: 1, durationSec: 1, filePath: '/x' });
  store.setChapter(t.jobId, 1, { state: 'queued', runId: 1 });
  t.gen.recover();
  assert.strictEqual(t.chState(0), 'paused');
  assert.strictEqual(t.chState(1), 'not_started');
});

test('recover keeps a queued re-run of a ready chapter as ready', () => {
  const t = setup();
  store.setChapter(t.jobId, 0, { state: 'queued', runId: 2, hasAudio: true });
  t.gen.recover();
  assert.strictEqual(t.chState(0), 'ready');
});

test('empty chapter is skipped without stitching', async () => {
  const t = setup();
  await t.gen.start(t.jobId, [3, 0]);
  await waitFor(() => t.chState(0) === 'ready');
  assert.strictEqual(t.chState(3), 'not_started');
  assert.ok(!fs.existsSync(path.join(uploadDir, 'audio', t.jobId, 'ch_3.mp3')));
  assert.strictEqual(t.ofStage('chapter_state', 3).at(-1).error, 'Chapter has no text');
});

test('stopAll stops the active chapter and clears the queue across books', async () => {
  const a = setup();
  const b = setup();
  b.gen = a.gen; // one generator, two books
  a.gate.blockAt = 0;
  await a.gen.start(a.jobId, [0, 1]);
  await a.gen.start(b.jobId, [0]);
  await waitFor(() => a.gate.release);
  await a.gen.stopAll();
  a.gate.release();
  await waitFor(() => a.chState(0) === 'stopped' && !a.gen.isBusy());
  assert.strictEqual(a.chState(1), 'not_started');
  assert.strictEqual(b.chState(0), 'not_started');
  assert.deepStrictEqual(a.gen.state(a.jobId).queue, []);
});

test('chunk events and state report the chapter total', async () => {
  const t = setup();
  t.gate.blockAt = 1;
  await t.gen.start(t.jobId, [0]);
  await waitFor(() => t.gate.release);
  const total = t.ofStage('chunk_ready', 0)[0].totalChunks;
  assert.ok(total >= 3);
  assert.strictEqual(t.ofStage('chapter_state', 0).at(-1).totalChunks, total);
  assert.strictEqual(t.gen.state(t.jobId).chapters.find(c => c.chapterIndex === 0).totalChunks, total);
  t.gate.release();
  await waitFor(() => t.chState(0) === 'ready');
});

test('chapter announcement is synthesized with a 3s pause after it', async () => {
  const t = setup();
  await t.gen.start(t.jobId, [0]);
  await waitFor(() => t.chState(0) === 'ready');
  assert.strictEqual(t.synthCalls[0].text, 'Chapter 1');
  assert.strictEqual(t.synthCalls[0].padSec, 3);
  assert.ok(t.synthCalls.slice(1).every(c => !c.padSec));
});

function setupParallel(parallel) {
  const t = setup();
  const running = new Set();
  let maxConcurrent = 0;
  const slow = async (text, opts, mp3Path) => {
    running.add(mp3Path); maxConcurrent = Math.max(maxConcurrent, running.size);
    await new Promise(r => setTimeout(r, 20));
    fs.mkdirSync(path.dirname(mp3Path), { recursive: true });
    fs.writeFileSync(mp3Path, 'x');
    running.delete(mp3Path);
    return 2;
  };
  t.gen = createGenerator({
    synthesize: slow,
    stitch: async (paths, out) => fs.writeFileSync(out, 'x'),
    getChapters: async () => [0, 1, 2].map(i => ({ title: `Chapter ${i + 1}`, text: chapterText })),
    emit: (id, e) => { if (id === t.jobId) t.events.push(e); },
    store, jobs: jobService, uploadDir, parallel,
  });
  return { ...t, maxConcurrent: () => maxConcurrent };
}

test('parallel generator runs up to N chapters at once, FIFO for the rest', async () => {
  const t = setupParallel(2);
  await t.gen.start(t.jobId, [0, 1, 2]);
  await waitFor(() => t.chState(0) === 'generating' && t.chState(1) === 'generating');
  assert.strictEqual(t.chState(2), 'queued');
  await waitFor(() => [0, 1, 2].every(i => t.chState(i) === 'ready'), 5000);
  assert.strictEqual(t.maxConcurrent(), 2);
  assert.strictEqual(t.gen.state(t.jobId).parallel, 2);
});

test('pause and stopAll reach every active chapter', async () => {
  const t = setupParallel(2);
  await t.gen.start(t.jobId, [0, 1, 2]);
  await waitFor(() => t.chState(0) === 'generating' && t.chState(1) === 'generating');
  await t.gen.pauseJob(t.jobId);
  await waitFor(() => [0, 1, 2].every(i => t.chState(i) === 'paused'));
  await t.gen.resumeJob(t.jobId);
  await waitFor(() => t.chState(0) === 'generating');
  await t.gen.stopAll();
  await waitFor(() => !t.gen.isBusy());
  assert.ok([0, 1, 2].every(i => ['stopped', 'not_started'].includes(t.chState(i))));
});

test('chunk events carry a time-left estimate that reaches zero', async () => {
  const t = setupParallel(1);
  await t.gen.start(t.jobId, [0]);
  await waitFor(() => t.chState(0) === 'ready');
  const etas = t.ofStage('chunk_ready', 0).map(e => e.etaSec);
  assert.ok(etas.every(e => typeof e === 'number' && e >= 0));
  assert.strictEqual(etas.at(-1), 0);
  assert.ok(etas.every((e, i) => i === 0 || e <= etas[i - 1]), 'estimate never goes up');
  assert.ok(t.gen.state(t.jobId).msPerChar > 0);
});
