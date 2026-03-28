const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('../config');

// Prefer system ffmpeg (Homebrew ARM-native) — the bundled binary crashes with
// SIGABRT on the float32 WAV format that Kokoro outputs on macOS.
function resolveFfmpegPath() {
  try {
    const p = execSync('which ffmpeg', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (p) {
      console.log(`[TTS] ffmpeg: system (${p})`);
      return p;
    }
  } catch {}
  console.log(`[TTS] ffmpeg: bundled (${ffmpegInstaller.path})`);
  return ffmpegInstaller.path;
}
ffmpeg.setFfmpegPath(resolveFfmpegPath());

const SENTENCE_BOUNDARY = /(?<=[.!?])\s+(?=[A-Z"'])/;

// ─── Singleton model loader ───────────────────────────────────────────────────

let _ttsInstance = null;
let _loadingPromise = null;

async function getTTS() {
  if (_ttsInstance) return _ttsInstance;
  if (_loadingPromise) return _loadingPromise;

  _loadingPromise = (async () => {
    console.log('[TTS] Loading Kokoro model (first run may take a moment)...');
    const { KokoroTTS } = await import('kokoro-js');
    const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
      dtype: 'q8',
    });
    console.log('[TTS] Kokoro model ready.');
    _ttsInstance = tts;
    return tts;
  })();

  return _loadingPromise;
}

// Warm up the model on startup (non-blocking)
getTTS().catch(err => console.error('[TTS] Model preload failed:', err.message));

// ─── Text chunking ────────────────────────────────────────────────────────────

function splitIntoChunks(text, chapters = [], maxChars = config.tts.chunkSize) {
  const sentences = text.split(SENTENCE_BOUNDARY).filter(s => s.trim());

  const chunks = [];
  let current = '';
  let currentChapterIdx = 0;
  let charPos = 0;

  for (const sentence of sentences) {
    for (let i = chapters.length - 1; i >= 0; i--) {
      if (charPos >= chapters[i].charOffset) {
        currentChapterIdx = i;
        break;
      }
    }

    if (current.length + sentence.length + 1 > maxChars && current.length > 0) {
      chunks.push({ index: chunks.length, text: current.trim(), chapterIndex: currentChapterIdx });
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }

    charPos += sentence.length + 1;
  }

  if (current.trim()) {
    chunks.push({ index: chunks.length, text: current.trim(), chapterIndex: currentChapterIdx });
  }

  return chunks;
}

// ─── Conversion ───────────────────────────────────────────────────────────────

async function convertChunks(chunks, voice, speed, jobChunksDir, onProgress) {
  fs.mkdirSync(jobChunksDir, { recursive: true });

  const tts = await getTTS();
  const concurrency = config.tts.concurrency;
  let done = 0;
  const queue = [...chunks];

  async function worker() {
    while (queue.length) {
      const chunk = queue.shift();
      if (!chunk) break;
      const mp3Path = path.join(jobChunksDir, `${String(chunk.index).padStart(4, '0')}.mp3`);

      let lastErr;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await generateChunk(tts, chunk.text, voice, speed, mp3Path);
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          console.warn(`[TTS] Chunk ${chunk.index} attempt ${attempt + 1} failed: ${err.message}`);
          console.warn(`[TTS] Chunk ${chunk.index} text preview: "${chunk.text.slice(0, 100)}"`);
          await sleep(1000 * (attempt + 1));
        }
      }

      if (lastErr) throw new Error(`Chunk ${chunk.index} failed: ${lastErr.message}`);

      onProgress(++done, chunks.length);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length || 1) }, worker));
}

// Strip ALL control characters (including \n, \r, \t) — raw PDF line breaks cause
// Kokoro to emit malformed WAV which crashes ffmpeg with SIGABRT
function sanitizeText(text) {
  return text
    .replace(/[\x00-\x1F\x7F]/g, ' ') // ALL control chars including newlines/tabs
    .replace(/\s+/g, ' ')
    .trim();
}

async function generateChunk(tts, text, voice, speed, mp3Path) {
  const cleanText = sanitizeText(text);

  if (!cleanText) {
    // Write a silent placeholder so stitching doesn't break
    await createSilentMp3(mp3Path);
    return;
  }

  // Generate WAV via Kokoro
  const audio = await tts.generate(cleanText, { voice, speed });

  // Save to a temp WAV, then convert to MP3
  const tmpWav = path.join(os.tmpdir(), `vmb_${Date.now()}_${Math.random().toString(36).slice(2)}.wav`);
  await audio.save(tmpWav);

  try {
    // Guard against empty/corrupt WAV (< 44 bytes = just header, no audio data)
    const stat = fs.statSync(tmpWav);
    if (stat.size < 44) {
      throw new Error(`Kokoro produced an empty WAV (${stat.size} bytes) for: "${cleanText.slice(0, 60)}"`);
    }
    await wavToMp3(tmpWav, mp3Path);
  } finally {
    try { fs.unlinkSync(tmpWav); } catch {}
  }
}

// Create a 1-second silent MP3 via ffmpeg
function createSilentMp3(mp3Path) {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input('anullsrc=r=24000:cl=mono')
      .inputOptions(['-f', 'lavfi'])
      .duration(1)
      .audioCodec('libmp3lame')
      .audioBitrate(64)
      .output(mp3Path)
      .on('end', resolve)
      .on('error', err => reject(new Error(`silent mp3: ${err.message}`)))
      .run();
  });
}

function wavToMp3(wavPath, mp3Path) {
  return new Promise((resolve, reject) => {
    ffmpeg(wavPath)
      .audioCodec('libmp3lame')
      .audioBitrate(64)
      // Resample to 22050 Hz mono s16 — prevents SIGABRT in bundled ffmpeg when
      // Kokoro outputs float32/24kHz WAV (libmp3lame crash on non-integer PCM input)
      .audioFrequency(22050)
      .audioChannels(1)
      .outputOptions(['-sample_fmt', 's16'])
      .output(mp3Path)
      .on('end', resolve)
      .on('error', err => reject(new Error(`ffmpeg: ${err.message}`)))
      .run();
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = { splitIntoChunks, convertChunks, getTTS, sanitizeText };
