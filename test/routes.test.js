const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const dir = require('./helpers').setupTmpEnv();
// A reference clip and a stand-in Python so Chatterbox voices are listed
process.env.VOICES_REF_DIR = path.join(dir, 'voices-ref');
process.env.CHATTERBOX_PYTHON = path.join(dir, 'fake-python');
fs.mkdirSync(process.env.VOICES_REF_DIR, { recursive: true });
fs.writeFileSync(path.join(process.env.VOICES_REF_DIR, 'epilogue.wav'), 'x');
fs.writeFileSync(process.env.CHATTERBOX_PYTHON, '');
const app = require('../server');
const store = require('../services/chapterStore');
const jobService = require('../services/jobService');
const { createGenerator } = require('../services/generator');

const uploadDir = path.join(dir, 'uploads');
app.locals.generator = createGenerator({
  synthesize: async (t, o, p) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'x'); return 1; },
  stitch: async (paths, out) => fs.writeFileSync(out, 'x'),
  getChapters: async () => [{ title: 'Chapter 1', text: 'Hello there. '.repeat(5) }, { title: 'Ch: 2?', text: 'Second chapter. '.repeat(5) }],
  emit: () => {},
  store,
  jobs: jobService,
  uploadDir,
});

let base;
const server = app.listen(0);
test.before(() => { base = `http://127.0.0.1:${server.address().port}/api`; });
test.after(() => server.close());

let seq = 0;
function seedJob(chapters = [{ title: 'Chapter 1', charOffset: 0 }, { title: 'Ch: 2?', charOffset: 10 }]) {
  const id = `r${++seq}`;
  jobService.createJob({ id, pdf_path: '/p.pdf', pdf_filename: 'My Book.pdf', pdf_size_bytes: 1, page_count: 1, voice: 'af_heart', speed: 1 });
  jobService.updateJob(id, { chapters_json: JSON.stringify(chapters), status: 'analyzed', stage: 'analyzed' });
  return id;
}
const post = (url, body) => fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('start validates speed', async () => {
  const id = seedJob();
  assert.strictEqual((await post(`/generate/${id}/start`, { chapters: [0], speed: 2.5 })).status, 400);
  assert.strictEqual((await post(`/generate/${id}/start`, { chapters: [0], speed: 0.85 })).status, 202);
  assert.strictEqual(jobService.getJob(id).speed, 0.85);
});

test('start rejects unknown voice and empty chapters', async () => {
  const id = seedJob();
  assert.strictEqual((await post(`/generate/${id}/start`, { chapters: [0], voice: 'nope' })).status, 400);
  assert.strictEqual((await post(`/generate/${id}/start`, { chapters: [] })).status, 400);
  assert.strictEqual((await post(`/generate/${id}/start`, { chapters: [5] })).status, 400);
});

test('generator state endpoint', async () => {
  const id = seedJob();
  assert.strictEqual((await fetch(`${base}/generate/nope`)).status, 404);
  const s = await (await fetch(`${base}/generate/${id}`)).json();
  assert.deepStrictEqual(s.chapters, []);
});

const pdfBytes = Buffer.from('%PDF-1.4\n% fake test pdf\n');
const sha = crypto.createHash('sha256').update(pdfBytes).digest('hex');
async function upload(name) {
  const fd = new FormData();
  fd.append('file', new Blob([pdfBytes], { type: 'application/pdf' }), name);
  return (await fetch(`${base}/upload`, { method: 'POST', body: fd })).json();
}

test('duplicate upload returns existing job', async () => {
  const a = await upload('a.pdf');
  const b = await upload('b.pdf');
  assert.strictEqual(a.jobId, b.jobId);
  assert.strictEqual(b.cached, true);
  assert.strictEqual(fs.readdirSync(path.join(uploadDir, 'pdfs')).length, 1);
});

test('lookup by hash', async () => {
  const r = await fetch(`${base}/upload/lookup?sha256=${sha}`);
  assert.strictEqual(r.status, 200);
  assert.ok((await r.json()).jobId);
  assert.strictEqual((await fetch(`${base}/upload/lookup?sha256=${'0'.repeat(64)}`)).status, 404);
});

test('zip contains ready chapters with titles', async () => {
  const id = seedJob();
  for (const ch of [0, 1]) {
    store.setChapter(id, ch, { state: 'ready', hasAudio: true });
    fs.mkdirSync(path.join(uploadDir, 'audio', id), { recursive: true });
    fs.writeFileSync(path.join(uploadDir, 'audio', id, `ch_${ch}.mp3`), `mp3-${ch}`);
  }
  const r = await fetch(`${base}/audio/${id}/zip`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('content-type'), 'application/zip');
  const out = path.join(dir, 'out.zip');
  fs.writeFileSync(out, Buffer.from(await r.arrayBuffer()));
  const names = execFileSync('unzip', ['-Z1', out], { encoding: 'utf8' }).trim().split('\n');
  assert.deepStrictEqual(names, ['01 - Chapter 1.mp3', '02 - Ch_ 2_.mp3']);
});

test('zip 404 when nothing ready', async () => {
  assert.strictEqual((await fetch(`${base}/audio/${seedJob()}/zip`)).status, 404);
});

test('chunk route serves file and 404s missing', async () => {
  const id = seedJob();
  const f = path.join(uploadDir, 'chunks', id, 'ch_0', 'run_1', '0000.mp3');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, 'abc');
  const ok = await fetch(`${base}/audio/${id}/ch/0/run/1/chunk/0`);
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(await ok.text(), 'abc');
  assert.strictEqual((await fetch(`${base}/audio/${id}/ch/0/run/1/chunk/1`)).status, 404);
});

test('chunk route 404s for unknown job', async () => {
  const f = path.join(uploadDir, 'chunks', 'ghost', 'ch_0', 'run_1', '0000.mp3');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, 'abc');
  assert.strictEqual((await fetch(`${base}/audio/ghost/ch/0/run/1/chunk/0`)).status, 404);
});

// Uses the local test book (outside this repo); skipped when it isn't there
const book = path.join(__dirname, '..', '..', 'testing book', 'Oh_God_Not_Again.pdf');
test('cache hit on a failed job re-runs analysis', { skip: !fs.existsSync(book) }, async () => {
  const id = 'failed1';
  jobService.createJob({ id, pdf_path: book, pdf_filename: 'b.pdf', pdf_size_bytes: 1, page_count: 1, voice: 'af_heart', speed: 1, pdf_sha256: 'f'.repeat(64) });
  jobService.updateJob(id, { status: 'error', stage: 'error', error_message: 'boom' });
  assert.strictEqual((await fetch(`${base}/upload/lookup?sha256=${'f'.repeat(64)}`)).status, 200);
  const end = Date.now() + 10000;
  while (!jobService.getJob(id).chapters && Date.now() < end) await new Promise(r => setTimeout(r, 100));
  assert.ok(jobService.getJob(id).chapters?.length > 0);
});

test('upload racing on the same new pdf returns the existing job', async () => {
  const bytes = Buffer.from('%PDF-1.4\n% race ' + Date.now() + '\n');
  const send = name => {
    const fd = new FormData();
    fd.append('file', new Blob([bytes], { type: 'application/pdf' }), name);
    return fetch(`${base}/upload`, { method: 'POST', body: fd });
  };
  const first = await (await send('r1.pdf')).json();
  const before = fs.readdirSync(path.join(uploadDir, 'pdfs')).length;
  // Simulate the race: second request's lookup misses, so its insert hits the unique index
  const real = jobService.findJobByHash;
  jobService.findJobByHash = () => { jobService.findJobByHash = real; return null; };
  const r = await send('r2.pdf');
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await r.json()).jobId, first.jobId);
  assert.strictEqual(fs.readdirSync(path.join(uploadDir, 'pdfs')).length, before);
});

test('stop-all route clears the queue', async () => {
  const id = seedJob();
  assert.strictEqual((await post(`/generate/${id}/start`, { chapters: [0, 1] })).status, 202);
  assert.strictEqual((await post('/generate/stop-all', {})).status, 202);
  const s = await (await fetch(`${base}/generate/${id}`)).json();
  assert.deepStrictEqual(s.queue, []);
});

const synthCalls = [];
const fakeSynthPool = name => ({ synthesize: async (t, o, p) => { synthCalls.push(name); fs.writeFileSync(p, 'x'); return 1; }, status: () => 'ready' });
app.locals.synth = require('../services/synth').createSynth({ kokoro: fakeSynthPool('kokoro'), turbo: fakeSynthPool('turbo'), chatterbox: fakeSynthPool('chatterbox') });

test('voices list includes engine status', async () => {
  const body = await (await fetch(`${base}/voices`)).json();
  assert.deepStrictEqual(Object.keys(body.engineStatus).sort(), ['chatterbox', 'turbo']);
  assert.ok(body.voices.every(v => v.engine));
  assert.ok(body.voices.some(v => v.id === 'turbo:epilogue') && body.voices.some(v => v.id === 'cb:epilogue'));
});

test('resume across engines is rejected', async () => {
  const id = seedJob();
  const r1 = await post(`/generate/${id}/settings`, { voice: 'turbo:epilogue', speed: 1, mode: 'resume' });
  assert.strictEqual(r1.status, 400);
  assert.match((await r1.json()).error, /Switching engines restarts the chapter/);
  assert.strictEqual((await post(`/generate/${id}/settings`, { voice: 'turbo:epilogue', speed: 1, mode: 'restart-chapter' })).status, 202);
  assert.strictEqual(jobService.getJob(id).voice, 'turbo:epilogue');
});

test('preview routes chatterbox voice to its pool', async () => {
  synthCalls.length = 0;
  const r = await post('/voices/preview', { voice: 'cb:epilogue', speed: 1, text: 'Hello there.' });
  assert.strictEqual(r.status, 200);
  assert.ok(synthCalls.includes('chatterbox') && !synthCalls.includes('kokoro'));
  assert.strictEqual((await post('/voices/preview', { voice: 'turbo:nope', speed: 1, text: 'x' })).status, 400);
});

test('cancelled preview stops generating the remaining parts', async () => {
  const saved = app.locals.synth;
  let calls = 0, lastSignal;
  app.locals.synth = { synthesize: async (t, o, p, signal) => { calls++; lastSignal = signal; await new Promise(r => setTimeout(r, 30)); fs.writeFileSync(p, 'x'); return 1; }, engineStatus: () => ({}) };
  const ac = new AbortController();
  const req = fetch(`${base}/voices/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ voice: 'turbo:epilogue', speed: 1, text: 'This sentence is part of the test. '.repeat(20) }), signal: ac.signal }).catch(() => {});
  setTimeout(() => ac.abort(), 80);
  await req;
  await new Promise(r => setTimeout(r, 400));
  app.locals.synth = saved;
  assert.ok(calls < 10, `expected generation to stop early, got ${calls} of 20 parts`);
  assert.strictEqual(lastSignal?.aborted, true, 'the running part is told to stop');
});

test('preview progress reports parts done and an ETA while generating', async () => {
  const saved = app.locals.synth;
  app.locals.synth = { synthesize: async (t, o, p) => { await new Promise(r => setTimeout(r, 40)); fs.writeFileSync(p, 'x'); return 1; }, engineStatus: () => ({}) };
  const id = 'progress-test-1';
  const done = post('/voices/preview', { id, voice: 'turbo:epilogue', speed: 1, text: 'This sentence is part of the test. '.repeat(10) });
  await new Promise(r => setTimeout(r, 150));
  const mid = await (await fetch(`${base}/voices/preview/progress/${id}`)).json();
  assert.strictEqual(mid.total, 10);
  assert.ok(mid.done >= 1 && mid.done < 10, `done=${mid.done}`);
  assert.ok(mid.etaSec >= 0);
  await done; // stitching the fake 'x' files fails; only the cleanup matters here
  assert.strictEqual((await fetch(`${base}/voices/preview/progress/${id}`)).status, 404);
  app.locals.synth = saved;
});

test('preview stream sends each part as it finishes, without ID3 or Info headers', async () => {
  const saved = app.locals.synth;
  const id3 = Buffer.concat([Buffer.from('ID3'), Buffer.from([4, 0, 0, 0, 0, 0, 2]), Buffer.from('xx')]);
  // LAME "Info" frame (MPEG-2 layer III, 64 kbps, 22050 Hz = 208 bytes): it states one part's length, so the browser would stop there
  const info = Buffer.alloc(208);
  info.set([0xff, 0xf3, 0x80, 0xc4]);
  info.write('Info', 13);
  app.locals.synth = { synthesize: async (t, o, p) => { await new Promise(r => setTimeout(r, 30)); fs.writeFileSync(p, Buffer.concat([id3, info, Buffer.from(`[${t}]`)])); return 1; }, engineStatus: () => ({}) };
  const id = 'stream-test-1';
  const text = 'The first sentence is here now. The second sentence is here now. The third sentence is here now.';
  const stream = fetch(`${base}/voices/preview/stream/${id}`); // may arrive before the POST registers the id
  await new Promise(r => setTimeout(r, 50));
  const done = post('/voices/preview', { id, voice: 'turbo:epilogue', speed: 1, text });
  const r = await stream;
  assert.strictEqual(r.headers.get('content-type'), 'audio/mpeg');
  assert.strictEqual(await r.text(), '[The first sentence is here now.][The second sentence is here now.][The third sentence is here now.]');
  await done;
  assert.strictEqual((await fetch(`${base}/voices/preview/stream/unknown-id`)).status, 404);
  app.locals.synth = saved;
});
