const test = require('node:test');
const assert = require('node:assert');
require('./helpers').setupTmpEnv();
const { createSynth } = require('../services/synth');

const fakePool = (name, status = 'stopped') => {
  const calls = [];
  return { calls, synthesize: async (text, opts) => { calls.push(opts.voice); return name.length; }, status: () => status };
};

test('routes by voice prefix', async () => {
  const kokoro = fakePool('kokoro'), turbo = fakePool('turbo'), chatterbox = fakePool('chatterbox');
  const s = createSynth({ kokoro, turbo, chatterbox });
  await s.synthesize('a', { voice: 'af_heart' }, '/x');
  await s.synthesize('a', { voice: 'turbo:a' }, '/x');
  await s.synthesize('a', { voice: 'cb:a' }, '/x');
  assert.deepStrictEqual([kokoro.calls, turbo.calls, chatterbox.calls], [['af_heart'], ['turbo:a'], ['cb:a']]);
});

test('kokoro never touches chatterbox pools', async () => {
  let created = 0;
  const lazy = () => { created++; return fakePool('x'); };
  const s = createSynth({ kokoro: fakePool('kokoro'), turbo: lazy, chatterbox: lazy });
  await s.synthesize('a', { voice: 'af_heart' }, '/x');
  assert.strictEqual(created, 0);
  assert.deepStrictEqual(s.engineStatus(), { turbo: 'stopped', chatterbox: 'stopped' });
});

test('engine status reflects started pools', async () => {
  const s = createSynth({ kokoro: fakePool('k'), turbo: fakePool('t', 'ready'), chatterbox: fakePool('c', 'starting') });
  assert.deepStrictEqual(s.engineStatus(), { turbo: 'ready', chatterbox: 'starting' });
});
