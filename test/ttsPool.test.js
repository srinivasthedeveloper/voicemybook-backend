const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const dir = require('./helpers').setupTmpEnv();
const { createPool } = require('../services/ttsPool');

const fake = path.join(__dirname, 'fixtures', 'fakeTtsWorker.js');
const out = name => path.join(dir, name);

test('pool runs jobs on separate processes in parallel', async () => {
  const pool = createPool(2, fake);
  const t0 = Date.now();
  const [a, b] = await Promise.all([pool.synthesize('aaa', {}, out('a.mp3')), pool.synthesize('bbbb', {}, out('b.mp3'))]);
  assert.deepStrictEqual([a, b], [3, 4]);
  assert.ok(Date.now() - t0 < 280, 'both jobs should overlap');
  assert.strictEqual(fs.readFileSync(out('b.mp3'), 'utf8'), 'bbbb');
  pool.close();
});

test('pool queues jobs beyond its size', async () => {
  const pool = createPool(1, fake);
  const t0 = Date.now();
  await Promise.all([pool.synthesize('x', {}, out('x1.mp3')), pool.synthesize('y', {}, out('y1.mp3'))]);
  assert.ok(Date.now() - t0 >= 290, 'second job waits for the only worker');
  pool.close();
});

test('a crashed worker rejects its job and is replaced', async () => {
  const pool = createPool(1, fake);
  await assert.rejects(pool.synthesize('crash', {}, out('c.mp3')), /exited/);
  assert.strictEqual(await pool.synthesize('ok', {}, out('ok.mp3')), 2);
  pool.close();
});
