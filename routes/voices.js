const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('../config');

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const router = express.Router();

const PREVIEW_DIR = path.join(config.uploadDir, 'previews');
fs.mkdirSync(PREVIEW_DIR, { recursive: true });

const generating = new Map();
const VALID_VOICE_IDS = new Set(config.voices.map(v => v.id));

const SAMPLE_TEXT =
  "Hello! This is a sample of my voice. I'll be narrating your audiobook with clarity and expression.";

// GET /api/voices
router.get('/', (req, res) => {
  res.json({ voices: config.voices });
});

// GET /api/voices/preview?voice=af_heart
router.get('/preview', async (req, res) => {
  const { voice } = req.query;

  if (!voice || !VALID_VOICE_IDS.has(voice)) {
    return res.status(400).json({ error: 'Invalid or missing voice parameter' });
  }

  const mp3Path = path.join(PREVIEW_DIR, `${voice}.mp3`);

  try {
    if (!fs.existsSync(mp3Path)) {
      if (!generating.has(voice)) {
        const promise = generatePreview(voice, mp3Path).finally(() => generating.delete(voice));
        generating.set(voice, promise);
      }
      await generating.get(voice);
    }

    const stat = fs.statSync(mp3Path);
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Content-Length': stat.size,
      'Cache-Control': 'public, max-age=86400',
    });
    fs.createReadStream(mp3Path).pipe(res);

  } catch (err) {
    console.error(`[VoicePreview] Failed for "${voice}":`, err.message);
    console.error(err);
    res.status(500).json({ error: 'Failed to generate voice preview' });
  }
});

async function generatePreview(voice, mp3Path) {
  // Reuse the singleton loaded by ttsService
  const { getTTS } = require('../services/ttsService');
  const tts = await getTTS();

  const audio = await tts.generate(SAMPLE_TEXT, { voice, speed: 1.0 });

  const tmpWav = path.join(os.tmpdir(), `vmb_preview_${voice}_${Date.now()}.wav`);
  await audio.save(tmpWav);

  await new Promise((resolve, reject) => {
    ffmpeg(tmpWav)
      .audioCodec('libmp3lame')
      .audioBitrate(64)
      .output(mp3Path)
      .on('end', resolve)
      .on('error', e => reject(new Error(e.message)))
      .run();
  });

  try { fs.unlinkSync(tmpWav); } catch {}
}

module.exports = router;
