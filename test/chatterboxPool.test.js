const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const dir = require('./helpers').setupTmpEnv();
const { createChatterboxPool } = require('../services/chatterboxPool');

const fake = path.join(__dirname, 'fixtures', 'fakeChatterboxWorker.js');
const out = n => path.join(dir, n);
const logs = [];
const log = { info: (scope, msg) => logs.push(`${scope} ${msg}`), warn() {}, error() {} };
const make = (extra = {}) => createChatterboxPool({ engine: 'turbo', size: 1, command: process.execPath, args: [fake], idleMs: 60000, log, ...extra });
const opts = { voice: 'turbo:x', speed: 1, padSec: 0 };

test('starts lazily and synthesizes', async () => {
  const pool = make();
  assert.strictEqual(pool.status(), 'stopped');
  assert.strictEqual(await pool.synthesize('abc', opts, out('a.mp3')), 3);
  assert.strictEqual(pool.status(), 'ready');
  assert.ok(logs.some(l => l === 'tts-turbo fake worker log line'));
  pool.close();
});

test('queues requests until ready', async () => {
  const pool = make();
  const r = await Promise.all(['a', 'bb', 'ccc'].map((t, i) => pool.synthesize(t, opts, out(`q${i}.mp3`))));
  assert.deepStrictEqual(r, [1, 2, 3]);
  pool.close();
});

test('missing clip rejects with clear error', async () => {
  const pool = make();
  await assert.rejects(pool.synthesize('missing', opts, out('m.mp3')), /Voice clip x.wav is missing/);
  assert.strictEqual(await pool.synthesize('ok', opts, out('m2.mp3')), 2);
  pool.close();
});

test('fails fast after two failed starts', async () => {
  const pool = make({ env: { ...process.env, FAKE_MODE: 'crash-on-start' } });
  await assert.rejects(pool.synthesize('a', opts, out('c1.mp3')), /exited/);
  await assert.rejects(pool.synthesize('a', opts, out('c2.mp3')), /exited/);
  const t0 = Date.now();
  await assert.rejects(pool.synthesize('a', opts, out('c3.mp3')));
  assert.ok(Date.now() - t0 < 50, 'third call should fail fast');
  assert.strictEqual(pool.status(), 'error');
  pool.close();
});

test('idle stop', async () => {
  const pool = make({ idleMs: 100 });
  await pool.synthesize('a', opts, out('i1.mp3'));
  await new Promise(r => setTimeout(r, 250));
  assert.strictEqual(pool.status(), 'stopped');
  assert.strictEqual(await pool.synthesize('ab', opts, out('i2.mp3')), 2);
  pool.close();
});

test('missing python binary rejects instead of hanging', async () => {
  const pool = createChatterboxPool({ engine: 'turbo', size: 1, command: '/nonexistent/python', args: [], idleMs: 60000, log });
  await assert.rejects(Promise.race([pool.synthesize('a', opts, out('np.mp3')), new Promise((_, r) => setTimeout(() => r(new Error('HANG')), 2000))]), err => !/HANG/.test(err.message));
  pool.close();
});

test('a crash after ready still serves the waiting requests', async () => {
  const pool = make();
  const dying = pool.synthesize('die', opts, out('d1.mp3'));
  const queued = pool.synthesize('abcd', opts, out('d2.mp3'));
  await assert.rejects(dying, /exited/);
  const r = await Promise.race([queued, new Promise((_, rej) => setTimeout(() => rej(new Error('HANG')), 3000))]);
  assert.strictEqual(r, 4);
  pool.close();
});

test('a request racing the idle stop still succeeds', async () => {
  const pool = make({ idleMs: 40 });
  await pool.synthesize('a', opts, out('r0.mp3'));
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 40));
    assert.strictEqual(await pool.synthesize('ab', opts, out(`r${i + 1}.mp3`)), 2);
  }
  pool.close();
});

test('one worker failing to load does not block a healthy one', async () => {
  const marker = out('one-only.marker');
  const pool = make({ size: 2, env: { ...process.env, FAKE_ONE_ONLY: marker } });
  for (let round = 0; round < 3; round++) {
    const r = await Promise.all([pool.synthesize('slow1', opts, out(`h${round}a.mp3`)), pool.synthesize('slow22', opts, out(`h${round}b.mp3`))]);
    assert.deepStrictEqual(r, [5, 6]);
  }
  assert.notStrictEqual(pool.status(), 'error');
  pool.close();
});

test('cancelling stops the running request and drops the queued one', async () => {
  const pool = make();
  await pool.synthesize('warm', opts, out('c0.mp3'));
  const running = new AbortController(), queued = new AbortController();
  const a = pool.synthesize('slow-running', opts, out('c1.mp3'), running.signal);
  const b = pool.synthesize('slow-queued', opts, out('c2.mp3'), queued.signal);
  setTimeout(() => { running.abort(); queued.abort(); }, 30);
  await assert.rejects(a, { name: 'AbortError' });
  await assert.rejects(b, { name: 'AbortError' });
  assert.strictEqual(await pool.synthesize('after', opts, out('c3.mp3')), 5); // a fresh worker serves the next one
  await assert.rejects(pool.synthesize('x', opts, out('c4.mp3'), AbortSignal.abort()), { name: 'AbortError' });
  pool.close();
});
