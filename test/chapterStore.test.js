const test = require('node:test');
const assert = require('node:assert');
require('./helpers').setupTmpEnv();
const store = require('../services/chapterStore');
const jobService = require('../services/jobService');

function chunk(chunkIndex, runId) {
  return { jobId: 'j', chapterIndex: 2, runId, chunkIndex, text: `t${chunkIndex}`, voice: 'af_heart', speed: 1, durationSec: 1.5, filePath: `/x/${chunkIndex}.mp3` };
}

test('missing chapter defaults to not_started', () => {
  assert.deepStrictEqual(store.getChapter('j', 0), { jobId: 'j', chapterIndex: 0, state: 'not_started', runId: 0, hasAudio: false });
});

test('setChapter upserts', () => {
  store.setChapter('j', 2, { state: 'queued', runId: 1 });
  store.setChapter('j', 2, { state: 'generating' });
  const c = store.getChapter('j', 2);
  assert.strictEqual(c.state, 'generating');
  assert.strictEqual(c.runId, 1);
});

test('chunks round-trip ordered and per run', () => {
  store.addChunk(chunk(1, 1));
  store.addChunk(chunk(0, 1));
  store.addChunk(chunk(0, 2));
  assert.deepStrictEqual(store.listChunks('j', 2, 1).map(c => c.chunkIndex), [0, 1]);
  assert.strictEqual(store.listChunks('j', 2, 1)[0].durationSec, 1.5);
  store.deleteRunChunks('j', 2, 1);
  assert.strictEqual(store.listChunks('j', 2, 1).length, 0);
  assert.strictEqual(store.listChunks('j', 2, 2).length, 1);
});

test('findInterrupted returns generating and queued only', () => {
  store.setChapter('k', 0, { state: 'generating', runId: 1 });
  store.setChapter('k', 1, { state: 'queued', runId: 1 });
  store.setChapter('k', 2, { state: 'paused', runId: 1 });
  store.setChapter('k', 3, { state: 'ready', runId: 1 });
  const got = store.findInterrupted().filter(r => r.jobId === 'k').map(r => r.chapterIndex).sort();
  assert.deepStrictEqual(got, [0, 1]);
});

test('findJobByHash', () => {
  const base = { pdf_path: '/p.pdf', pdf_filename: 'p.pdf', pdf_size_bytes: 1, page_count: 1, voice: 'af_heart', speed: 1 };
  jobService.createJob({ ...base, id: 'h1', pdf_sha256: 'abc' });
  assert.strictEqual(jobService.findJobByHash('abc').id, 'h1');
  assert.strictEqual(jobService.findJobByHash('zzz'), null);
  assert.throws(() => jobService.createJob({ ...base, id: 'h2', pdf_sha256: 'abc' }));
  jobService.createJob({ ...base, id: 'h3' });
  jobService.createJob({ ...base, id: 'h4' });
});

test('deleteJob removes chapter runs and chunks', () => {
  const base = { pdf_path: '/p.pdf', pdf_filename: 'p.pdf', pdf_size_bytes: 1, page_count: 1, voice: 'af_heart', speed: 1 };
  jobService.createJob({ ...base, id: 'del1' });
  store.setChapter('del1', 0, { state: 'ready', runId: 1, hasAudio: true });
  store.addChunk({ jobId: 'del1', chapterIndex: 0, runId: 1, chunkIndex: 0, text: 'a', voice: 'af_heart', speed: 1, durationSec: 1, filePath: '/x' });
  jobService.deleteJob('del1');
  assert.strictEqual(store.listChapters('del1').length, 0);
  assert.strictEqual(store.listChunks('del1', 0, 1).length, 0);
});
