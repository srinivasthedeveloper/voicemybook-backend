const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const tmp = require('./helpers').setupTmpEnv();
const { engineOf, listVoices, isValidVoice, modelCached } = require('../services/refVoices');

const dir = path.join(tmp, 'voices-ref');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'epilogue.wav'), 'x');
fs.writeFileSync(path.join(dir, 'voices.json'), JSON.stringify({ epilogue: { label: 'Epilogue narrator', description: 'British male (cloned)' } }));

test('engineOf', () => {
  assert.strictEqual(engineOf('turbo:x'), 'turbo');
  assert.strictEqual(engineOf('cb:x'), 'chatterbox');
  assert.strictEqual(engineOf('af_heart'), 'kokoro');
});

test('lists clips per engine when venv is ready', () => {
  const v = listVoices({ dir, venvReady: true });
  const ids = v.map(x => x.id);
  assert.ok(ids.includes('turbo:epilogue') && ids.includes('cb:epilogue') && ids.includes('af_heart'));
  const t = v.find(x => x.id === 'turbo:epilogue');
  assert.strictEqual(t.label, 'Epilogue narrator');
  assert.strictEqual(t.engine, 'turbo');
  assert.strictEqual(t.description, 'British male (cloned) · Expressive, about real time');
  assert.strictEqual(v.find(x => x.id === 'cb:epilogue').description, 'British male (cloned) · Best quality, about 4× slower than real time');
  assert.strictEqual(v.find(x => x.id === 'af_heart').engine, 'kokoro');
});

test('hides chatterbox voices without venv', () => {
  assert.ok(listVoices({ dir, venvReady: false }).every(x => !x.id.includes(':')));
});

test('isValidVoice rejects unknown clip', () => {
  assert.strictEqual(isValidVoice('turbo:nope', { dir, venvReady: true }), false);
  assert.strictEqual(isValidVoice('turbo:epilogue', { dir, venvReady: true }), true);
  assert.strictEqual(isValidVoice('af_heart', { dir, venvReady: false }), true);
});

test('modelCached follows HF_HOME', () => {
  process.env.HF_HOME = path.join(tmp, 'hf');
  assert.strictEqual(modelCached('turbo'), false);
  fs.mkdirSync(path.join(tmp, 'hf', 'hub', 'models--ResembleAI--chatterbox-turbo'), { recursive: true });
  assert.strictEqual(modelCached('turbo'), true);
  assert.strictEqual(modelCached('chatterbox'), false);
});
