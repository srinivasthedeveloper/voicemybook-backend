const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const dir = require('./helpers').setupTmpEnv();
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
