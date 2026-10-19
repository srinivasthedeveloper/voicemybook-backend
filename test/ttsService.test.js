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

const { turboSentences } = require('../services/ttsService');
const PLAIN = 'In his anger he seemed to fill the whole hut. The Dursleys cowered against the wall. ' +
  '"Do you mean ter tell me," he growled at the Dursleys, "that you told this boy - this boy - ' +
  'nothin\' abou\' - about ANYTHING?" "No," Harry said, shaking his head ruefully. "They didn\'t." ' +
  'Hagrid looked as if he was about to explode. "DURSLEY!" he boomed.';

test('turbo pieces match the spike', () => {
  assert.deepStrictEqual(turboSentences(PLAIN), [
    'In his anger he seemed to fill the whole hut.',
    'The Dursleys cowered against the wall.',
    '"Do you mean ter tell me," he growled at the Dursleys, "that you told this boy - this boy - nothin\' abou\' - about ANYTHING?"',
    '"No," Harry said, shaking his head ruefully.',
    '"They didn\'t." Hagrid looked as if he was about to explode.',
    '"DURSLEY!" he boomed.',
  ]);
});

test('short fragments merge into the next piece', () => {
  const pieces = turboSentences(PLAIN);
  assert.ok(pieces.slice(0, -1).every(p => p.split(/\s+/).length >= 4));
});

test('words are never changed', () => {
  assert.strictEqual(turboSentences(PLAIN).join(' ').replace(/\s+/g, ' '), PLAIN.replace(/\s+/g, ' '));
});

test('long sentence is cut under 200 chars at a comma', () => {
  const long = 'The rain kept falling on the old roof, ' + 'and the wind howled through the broken shutters of the house, '.repeat(5) + 'until morning came.';
  const pieces = turboSentences(long);
  assert.ok(pieces.length > 1 && pieces.every(p => p.length <= 200));
  assert.strictEqual(pieces.join(' ').replace(/\s+/g, ' '), long.replace(/\s+/g, ' '));
});

test('turbo chunks carry 0.3 s pad, announcement keeps 3 s', () => {
  const chunks = chapterChunks('Chapter 2', 'Chapter 2\n' + PLAIN, 'turbo');
  assert.strictEqual(chunks[0].pauseAfterSec, 3);
  assert.ok(chunks.slice(1).every(c => c.pauseAfterSec === 0.3));
  assert.deepStrictEqual(chunks.map(c => c.index), chunks.map((_, i) => i));
});

test('kokoro and chatterbox unchanged', () => {
  const t = 'Chapter 2\n' + PLAIN;
  assert.deepStrictEqual(chapterChunks('Chapter 2', t, 'kokoro'), chapterChunks('Chapter 2', t));
  assert.deepStrictEqual(chapterChunks('Chapter 2', t, 'chatterbox'), chapterChunks('Chapter 2', t));
});

test('a long piece without spaces is hard-cut, not looped forever', () => {
  const pieces = turboSentences('x'.repeat(250));
  assert.ok(pieces.length >= 2 && pieces.every(p => p.length > 0 && p.length <= 200));
  assert.strictEqual(pieces.join(''), 'x'.repeat(250));
});

test('a short last piece joins the previous one', () => {
  assert.deepStrictEqual(turboSentences('He walked into the old room slowly. No!'), ['He walked into the old room slowly. No!']);
});
