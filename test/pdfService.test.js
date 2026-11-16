const test = require('node:test');
const assert = require('node:assert');
const { detectChapters, outlineChapters, splitChapterTexts, pageRangeChapter } = require('../services/pdfService');

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

test('outline chapters: page offsets, same-offset entries collapse to the later one', () => {
  const outline = [
    { title: 'COVER PAGE', pageIndex: 0 },
    { title: 'CONTENTS', pageIndex: 1 },
    { title: 'THE FIRST NIGHT', pageIndex: 2 },
    { title: 'AFTERWORD', pageIndex: 4 },
  ];
  // page 0 and page 2 have no text, so they share an offset with the next page
  assert.deepStrictEqual(outlineChapters(outline, [0, 0, 50, 50, 900], 1000), [
    { title: 'CONTENTS', charOffset: 0, isSkippable: true, startPage: 2 },
    { title: 'THE FIRST NIGHT', charOffset: 50, isSkippable: false, startPage: 3 },
    { title: 'AFTERWORD', charOffset: 900, isSkippable: false, startPage: 5 },
  ]);
});

test('outline chapters: bookmark jumping backwards is dropped', () => {
  const outline = [{ title: 'Preface', pageIndex: 0 }, { title: 'Chapter 1', pageIndex: 1 }, { title: 'Afterword', pageIndex: 0 }];
  assert.deepStrictEqual(outlineChapters(outline, [0, 100], 500).map(c => c.title), ['Preface', 'Chapter 1']);
});

test('page range chapter: own endOffset, does not cut the detected chapter before it', () => {
  const page = 'word '.repeat(40).trim();
  const rawText = [page, page, page].join('\n\n');
  const offsets = [0, page.length + 2, 2 * (page.length + 2)];
  const range = pageRangeChapter(offsets, rawText, 2, 2);
  assert.strictEqual(rawText.slice(range.charOffset, range.endOffset), page);
  const parts = splitChapterTexts(rawText, [{ title: 'A', charOffset: 0 }, range]);
  assert.strictEqual(parts[0].text, rawText);
  assert.strictEqual(parts[1].text, page);
  assert.strictEqual(pageRangeChapter(offsets, rawText, 0, 2), null);
  assert.strictEqual(pageRangeChapter(offsets, rawText, 2, 4), null);
});
