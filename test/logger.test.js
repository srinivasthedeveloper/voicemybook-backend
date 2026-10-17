const test = require('node:test');
const assert = require('node:assert');

function load(level) {
  process.env.LOG_LEVEL = level;
  delete require.cache[require.resolve('../services/logger')];
  return require('../services/logger');
}

test('debug message fn not called when level is info', () => {
  const log = load('info');
  let called = false;
  log.debug('t', () => { called = true; return 'x'; });
  assert.strictEqual(called, false);
  assert.strictEqual(log.enabled('debug'), false);
  assert.strictEqual(log.enabled('info'), true);
});

test('debug enabled at debug level', () => {
  const log = load('debug');
  assert.strictEqual(log.enabled('debug'), true);
});

test('unknown level falls back to info', () => {
  const log = load('nope');
  assert.strictEqual(log.enabled('info'), true);
  assert.strictEqual(log.enabled('debug'), false);
});
