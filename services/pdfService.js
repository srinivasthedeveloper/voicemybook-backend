const pdfParse = require('pdf-parse');
const fs = require('fs');

const CHAPTER_PATTERN = /^(chapter\s+\d+|part\s+\d+|\d+\.\s+[A-Z]|prologue|epilogue|introduction|preface|appendix)/i;
const PAGE_NUMBER_PATTERN = /^\s*\d+\s*$/;

// Chapters that are front/back matter and should be skipped by default
const SKIPPABLE_PATTERN = /^(table\s+of\s+)?contents?$|^index$|^bibliography$|^references?$|^glossary$|^(list\s+of\s+(figures?|tables?|illustrations?))$/i;

// TOC-like line: "Some Title ........ 42"
const DOT_LEADER_PATTERN = /\S.*\.{4,}\s*\d+\s*$/;

/**
 * Extract text and detect chapters from a PDF file.
 * @param {string} pdfPath
 * @returns {{ rawText: string, chapters: Array<{title, charOffset, isSkippable}>, pageCount: number }}
 */
async function extractText(pdfPath) {
  const dataBuffer = fs.readFileSync(pdfPath);

  let pdfData;
  try {
    pdfData = await pdfParse(dataBuffer);
  } catch (err) {
    throw new Error(`Failed to parse PDF: ${err.message}`);
  }

  const rawText = cleanText(pdfData.text);
  const chapters = detectChapters(rawText);

  return {
    rawText,
    chapters,
    pageCount: pdfData.numpages,
  };
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
    if (trimmed && CHAPTER_PATTERN.test(trimmed)) {
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
    const start = ch.charOffset;
    const end = chapters[idx + 1] ? chapters[idx + 1].charOffset : rawText.length;
    const text = rawText.slice(start, end);
    return { ...ch, text, charCount: text.length };
  });
}

module.exports = { extractText, splitChapterTexts };
