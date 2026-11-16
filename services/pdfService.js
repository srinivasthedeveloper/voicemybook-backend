const pdfParse = require('pdf-parse');
const fs = require('fs');

const CHAPTER_PATTERN = /^(chapter\s+\d+|part\s+\d+|\d+\.\s+[A-Z]|prologue|epilogue|introduction|preface|appendix)/i;
const NUMBERED_HEADING = /^\d+\.\s+/;
const PAGE_NUMBER_PATTERN = /^\s*\d+\s*$/;

// Chapters that are front/back matter and should be skipped by default
const SKIPPABLE_PATTERN = /^(table\s+of\s+)?contents?$|^cover(\s+page)?$|^title\s+page$|^copyright(\s+page)?$|^about\s+the\s+authors?$|^index$|^bibliography$|^references?$|^glossary$|^(list\s+of\s+(figures?|tables?|illustrations?))$/i;

// TOC-like line: "Some Title ........ 42"
const DOT_LEADER_PATTERN = /\S.*\.{4,}\s*\d+\s*$/;

/**
 * Extract text and detect chapters from a PDF file.
 * @param {string} pdfPath
 * @returns {{ rawText: string, chapters: Array<{title, charOffset, isSkippable}>, pageCount: number }}
 */
async function extractText(pdfPath) {
  const dataBuffer = fs.readFileSync(pdfPath);

  const pageTexts = [];
  let outline = null;
  let pdfData;
  try {
    pdfData = await pdfParse(dataBuffer, {
      pagerender: async page => {
        const text = await renderPage(page);
        pageTexts[page.pageIndex] = text;
        if (!outline) outline = await readOutline(page.transport.pdfDocument);
        return text;
      },
    });
  } catch (err) {
    throw new Error(`Failed to parse PDF: ${err.message}`);
  }

  // Clean per page so each page's start offset in rawText is known
  const pageOffsets = [];
  const parts = [];
  let len = 0;
  for (let i = 0; i < pdfData.numpages; i++) {
    pageOffsets[i] = len ? len + 2 : 0;
    const t = cleanText(pageTexts[i] || '');
    if (!t) continue;
    if (len) len += 2;
    parts.push(t);
    len += t.length;
  }
  const rawText = parts.join('\n\n');

  const fromOutline = outlineChapters(outline || [], pageOffsets, rawText.length);
  const detected = fromOutline.filter(c => !c.isSkippable).length >= 2 ? fromOutline : detectChapters(rawText);
  const chapters = detected.map((ch, i) => ({
    ...ch,
    startPage: ch.startPage ?? pageOf(pageOffsets, ch.charOffset),
    endPage: pageOf(pageOffsets, Math.max(ch.charOffset, chapterEnd(detected, i, rawText.length) - 1)),
  }));

  return {
    rawText,
    chapters,
    pageOffsets,
    pageCount: pdfData.numpages,
  };
}

// 1-based page holding this offset (pages without text share the next page's offset)
function pageOf(pageOffsets, offset) {
  let page = 1;
  for (let i = 0; i < pageOffsets.length; i++) if (pageOffsets[i] <= offset) page = i + 1;
  return page;
}

// A chapter for 1-based pages start..end; null when out of range or too little text
function pageRangeChapter(pageOffsets, rawText, startPage, endPage) {
  if (!Number.isInteger(startPage) || !Number.isInteger(endPage)) return null;
  if (startPage < 1 || startPage > endPage || endPage > pageOffsets.length) return null;
  const charOffset = Math.min(pageOffsets[startPage - 1], rawText.length);
  const next = endPage < pageOffsets.length ? pageOffsets[endPage] - 2 : rawText.length;
  const endOffset = Math.min(rawText.length, Math.max(charOffset, next));
  if (rawText.slice(charOffset, endOffset).trim().length < 100) return null;
  return {
    title: startPage === endPage ? `Page ${startPage}` : `Pages ${startPage}–${endPage}`,
    charOffset,
    endOffset,
    isSkippable: false,
    isPageRange: true,
    startPage,
    endPage,
    charCount: endOffset - charOffset,
  };
}

// Same as pdf-parse's default page renderer
async function renderPage(page) {
  const { items } = await page.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false });
  let lastY, text = '';
  for (const item of items) {
    text += (lastY == item.transform[5] || !lastY) ? item.str : '\n' + item.str;
    lastY = item.transform[5];
  }
  return text;
}

// Top-level bookmarks as [{title, pageIndex}]; [] when missing or unreadable
async function readOutline(doc) {
  try {
    const items = (await doc.getOutline()) || [];
    const out = [];
    for (const it of items) {
      const dest = typeof it.dest === 'string' ? await doc.getDestination(it.dest) : it.dest;
      if (!Array.isArray(dest)) continue;
      out.push({ title: it.title.trim(), pageIndex: await doc.getPageIndex(dest[0]) });
    }
    return out;
  } catch {
    return [];
  }
}

// Outline entries → chapters; drops backward/out-of-range jumps, a later entry at the same offset wins
function outlineChapters(outline, pageOffsets, textLength) {
  const chapters = [];
  for (const o of outline) {
    const charOffset = pageOffsets[o.pageIndex];
    const last = chapters[chapters.length - 1];
    if (charOffset === undefined || charOffset >= textLength || (last && charOffset < last.charOffset)) continue;
    if (last && charOffset === last.charOffset) chapters.pop();
    chapters.push({
      title: o.title.length > 80 ? o.title.slice(0, 77) + '...' : o.title,
      charOffset,
      isSkippable: SKIPPABLE_PATTERN.test(o.title),
      startPage: o.pageIndex + 1,
    });
  }
  return chapters;
}

/**
 * Clean extracted text: remove page numbers, collapse extra whitespace.
 */
function cleanText(text) {
  return text
    .split('\n')
    .filter(line => !PAGE_NUMBER_PATTERN.test(line))   // remove lone page numbers
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')                         // max 2 consecutive newlines
    .replace(/[""]/g, '"')                              // normalize quotes
    .replace(/['']/g, "'")
    .replace(/[–—]/g, '-')                              // normalize dashes
    .trim();
}

/**
 * Check whether a block of text looks like a TOC page
 * (majority of non-empty lines are dot-leader lines).
 */
function isTocBlock(text) {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length < 3) return false;
  const dotLines = lines.filter(l => DOT_LEADER_PATTERN.test(l));
  return dotLines.length / lines.length >= 0.4;
}

// Numbered lines count only when they look like a heading, not a numbered sentence
function isHeadingLine(trimmed) {
  if (!CHAPTER_PATTERN.test(trimmed)) return false;
  if (!NUMBERED_HEADING.test(trimmed)) return true;
  return trimmed.length <= 60 && !/[.?!]$/.test(trimmed) && !trimmed.includes('?');
}

/**
 * Detect chapter boundaries in text.
 * Returns array sorted by charOffset with isSkippable flag.
 */
function detectChapters(text) {
  const chapters = [];
  const lines = text.split('\n');
  let charOffset = 0;

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    const trimmed = line.trim();
    if (trimmed && isHeadingLine(trimmed)) {
      // Avoid duplicate consecutive detections (e.g. "CHAPTER 1" + "Chapter One")
      const last = chapters[chapters.length - 1];
      if (!last || charOffset - last.charOffset > 200) {
        // Check a window of nearby lines to see if this is a TOC page
        const windowStart = Math.max(0, lineIdx - 3);
        const windowEnd = Math.min(lines.length, lineIdx + 15);
        const window = lines.slice(windowStart, windowEnd).join('\n');
        const isToc = SKIPPABLE_PATTERN.test(trimmed) || isTocBlock(window);

        chapters.push({
          title: trimmed.length > 80 ? trimmed.slice(0, 77) + '...' : trimmed,
          charOffset,
          isSkippable: isToc,
        });
      }
    }
    charOffset += line.length + 1; // +1 for the \n
  }

  // Fallback: if no chapters detected, treat whole book as one chapter
  if (chapters.length === 0) {
    chapters.push({ title: 'Full Text', charOffset: 0, isSkippable: false });
  }

  return chapters;
}

/**
 * Slice rawText by chapter charOffset boundaries.
 * Returns chapters array with added `text` and `charCount` fields.
 * @param {string} rawText
 * @param {Array<{title, charOffset, isSkippable}>} chapters
 * @returns {Array<{title, charOffset, isSkippable, text, charCount}>}
 */
function splitChapterTexts(rawText, chapters) {
  return chapters.map((ch, idx) => {
    const text = rawText.slice(ch.charOffset, chapterEnd(chapters, idx, rawText.length));
    return { ...ch, text, charCount: text.length };
  });
}

// Page-range chapters carry endOffset; detected ones end where the next detected one starts
function chapterEnd(chapters, idx, textLength) {
  if (chapters[idx].endOffset != null) return chapters[idx].endOffset;
  const next = chapters.slice(idx + 1).find(c => c.endOffset == null);
  return next ? next.charOffset : textLength;
}

module.exports = { extractText, splitChapterTexts, detectChapters, outlineChapters, pageRangeChapter };
