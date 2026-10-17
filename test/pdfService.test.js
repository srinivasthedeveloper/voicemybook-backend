const test = require('node:test');
const assert = require('node:assert');
const { detectChapters } = require('../services/pdfService');

const pad = '\n' + 'filler text line.\n'.repeat(20);

test('numbered quiz lines are not chapters', () => {
  const t = 'Chapter 1' + pad +
    "1. What is Gilderoy Lockhart's favorite color? Famous (formerly, Hot Magenta)." + pad +
    "2. What is Gilderoy Lockhart's secret ambition? To be able to take credit for every dangerous magical creature that's defeated anywhere in Europe." + pad;
  assert.deepStrictEqual(detectChapters(t).map(c => c.title), ['Chapter 1']);
});

test('short numbered heading still a chapter', () => {
  const t = '1. The Boy Who Lived' + pad + '2. The Vanishing Glass' + pad;
  assert.deepStrictEqual(detectChapters(t).map(c => c.title), ['1. The Boy Who Lived', '2. The Vanishing Glass']);
});

test('chapter N headings unchanged', () => {
  assert.strictEqual(detectChapters('CHAPTER 12' + pad).length, 1);
});
