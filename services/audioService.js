const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const fs = require('fs');
const path = require('path');

// Use bundled ffmpeg if system ffmpeg not available
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

/**
 * Concatenate all chunk MP3s into one final MP3.
 * @param {string} jobChunksDir  - directory containing 0000.mp3, 0001.mp3, ...
 * @param {string} outputPath    - final output file path
 * @param {number} chunkCount
 */
async function stitchAudio(jobChunksDir, outputPath, chunkCount) {
  const paths = [];
  for (let i = 0; i < chunkCount; i++) {
    const chunkFile = path.join(jobChunksDir, `${String(i).padStart(4, '0')}.mp3`);
    if (!fs.existsSync(chunkFile)) {
      throw new Error(`Missing chunk file: ${chunkFile}`);
    }
    paths.push(chunkFile);
  }
  return stitchFiles(paths, outputPath);
}

/**
 * Concatenate the given MP3 files, in order, into outputPath.
 * @param {string[]} paths
 * @param {string} outputPath
 */
async function stitchFiles(paths, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const listPath = `${outputPath}.concat.txt`;
  fs.writeFileSync(listPath, paths.map(p => `file '${p}'`).join('\n'));

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(listPath)
      .inputOptions(['-f', 'concat', '-safe', '0'])
      .audioCodec('copy')
      .output(outputPath)
      .on('end', () => { fs.rmSync(listPath, { force: true }); resolve(outputPath); })
      .on('error', (err) => { fs.rmSync(listPath, { force: true }); reject(new Error(`ffmpeg stitch failed: ${err.message}`)); })
      .run();
  });
}

/**
 * Get duration of an audio file in seconds using ffprobe.
 * @param {string} filePath
 * @returns {Promise<number>}
 */
function getAudioDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata.format.duration || 0);
    });
  });
}

/**
 * Compute chapter start times (in seconds) from chunk durations.
 * @param {string} jobChunksDir
 * @param {number} chunkCount
 * @param {Array} chapters  - [{title, charOffset, chunkIndex}]
 */
async function computeChapterTimestamps(jobChunksDir, chunkCount, chapters) {
  // Get duration of each chunk
  const durations = [];
  for (let i = 0; i < chunkCount; i++) {
    const chunkFile = path.join(jobChunksDir, `${String(i).padStart(4, '0')}.mp3`);
    try {
      const dur = await getAudioDuration(chunkFile);
      durations.push(dur);
    } catch {
      durations.push(0);
    }
  }

  // Cumulative time at start of each chunk
  const chunkStartTimes = [];
  let acc = 0;
  for (const d of durations) {
    chunkStartTimes.push(acc);
    acc += d;
  }

  // Map chapters to their start time
  return chapters.map(ch => ({
    title: ch.title,
    startSec: ch.chunkIndex != null ? (chunkStartTimes[ch.chunkIndex] || 0) : 0,
  }));
}

/**
 * Compute per-chunk transcript timings for a chapter.
 * Returns an array of {startSec, endSec, text, chapterIndex} objects.
 * @param {string} jobChunksDir   - directory containing 0000.mp3, 0001.mp3, ...
 * @param {Array}  chunks         - [{index, text}] for this chapter
 * @param {number} chapterIndex
 */
async function computeChapterTranscript(jobChunksDir, chunks, chapterIndex) {
  const durations = [];
  for (const chunk of chunks) {
    const chunkFile = path.join(jobChunksDir, `${String(chunk.index).padStart(4, '0')}.mp3`);
    try {
      const dur = await getAudioDuration(chunkFile);
      durations.push(dur);
    } catch {
      durations.push(0);
    }
  }

  const transcript = [];
  let acc = 0;
  for (let i = 0; i < chunks.length; i++) {
    const startSec = acc;
    const endSec = acc + durations[i];
    transcript.push({ startSec, endSec, text: chunks[i].text, chapterIndex });
    acc = endSec;
  }
  return transcript;
}

/**
 * Delete a directory and all its contents.
 */
function cleanupDir(dirPath) {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch {
    // non-fatal
  }
}

module.exports = { stitchAudio, stitchFiles, getAudioDuration, computeChapterTimestamps, computeChapterTranscript, cleanupDir };
