const test = require('node:test');
const assert = require('node:assert');
require('./helpers').setupTmpEnv();
const { chapterChunks } = require('../services/ttsService');

test('chapter heading becomes its own chunk with a 3s pause after', () => {
  const chunks = chapterChunks('Chapter 2', 'Chapter 2\n"Well, there you are, boy," Uncle Vernon said. He left.');
  assert.deepStrictEqual(chunks[0], { index: 0, text: 'Chapter 2', pauseAfterSec: 3 });
  assert.ok(chunks[1].text.startsWith('"Well, there you are'));
  assert.ok(!chunks.slice(1).some(c => c.pauseAfterSec));
  assert.deepStrictEqual(chunks.map(c => c.index), chunks.map((_, i) => i));
});

test('text without the heading gets no announcement pause', () => {
  const chunks = chapterChunks('Full Text', 'It was a dark night. Rain fell.');
  assert.ok(chunks.every(c => !c.pauseAfterSec));
  assert.ok(chunks[0].text.startsWith('It was a dark night.'));
});

test('heading-only chapter is just the announcement', () => {
  assert.deepStrictEqual(chapterChunks('Chapter 9', 'Chapter 9\n  '), [{ index: 0, text: 'Chapter 9', pauseAfterSec: 3 }]);
});
