const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('../config');
const log = require('../services/logger');
const { getPool } = require('../services/ttsPool');

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

// GET /api/voices/preview?voice=af_heart&speed=0.9
router.get('/preview', async (req, res) => {
  const { voice } = req.query;
  const speed = req.query.speed == null ? 1.0 : Number(req.query.speed);

  if (!voice || !VALID_VOICE_IDS.has(voice)) {
    return res.status(400).json({ error: 'Invalid or missing voice parameter' });
  }
  if (!(speed >= 0.5 && speed <= 2.0)) {
    return res.status(400).json({ error: 'speed must be between 0.5 and 2.0' });
  }

  const key = `${voice}_${speed.toFixed(2)}`;
  const mp3Path = path.join(PREVIEW_DIR, `${key}.mp3`);

  try {
    if (!fs.existsSync(mp3Path)) {
      if (!generating.has(key)) {
        const promise = generatePreview(voice, speed, mp3Path).finally(() => generating.delete(key));
        generating.set(key, promise);
      }
      await generating.get(key);
    }

    const stat = fs.statSync(mp3Path);
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Content-Length': stat.size,
      'Cache-Control': 'public, max-age=86400',
    });
    fs.createReadStream(mp3Path).pipe(res);

  } catch (err) {
    log.error('preview', `Failed for "${voice}"`, { err });
    res.status(500).json({ error: 'Failed to generate voice preview' });
  }
});

// POST /api/voices/preview { voice, speed, text } — custom text, not cached
router.post('/preview', async (req, res, next) => {
  const { voice, text } = req.body;
  const speed = req.body.speed ?? 1.0;
  if (!VALID_VOICE_IDS.has(voice)) return res.status(400).json({ error: 'Invalid or missing voice' });
  if (typeof speed !== 'number' || !(speed >= 0.5 && speed <= 2.0)) {
    return res.status(400).json({ error: 'speed must be a number between 0.5 and 2.0' });
  }

  const { splitIntoChunks } = require('../services/ttsService');
  const { stitchFiles } = require('../services/audioService');
  const body = (typeof text === 'string' && text.trim() ? text : SAMPLE_TEXT).slice(0, 2000);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vmb-preview-'));
  const t0 = Date.now();
  try {
    const parts = [];
    for (const [i, c] of splitIntoChunks(body).entries()) {
      const p = path.join(tmp, `${String(i).padStart(4, '0')}.mp3`);
      await getPool().synthesize(c.text, { voice, speed }, p);
      parts.push(p);
    }
    const out = path.join(tmp, 'preview.mp3');
    await stitchFiles(parts, out);
    log.info('preview', `custom text ${body.length} chars voice=${voice} speed=${speed}`, { ms: Date.now() - t0 });
    res.setHeader('Content-Type', 'audio/mpeg');
    res.on('close', () => fs.rmSync(tmp, { recursive: true, force: true }));
    fs.createReadStream(out).pipe(res);
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    next(err);
  }
});

// Runs on the TTS process pool like chapter chunks
function generatePreview(voice, speed, mp3Path) {
  return getPool().synthesize(SAMPLE_TEXT, { voice, speed }, mp3Path);
}

module.exports = router;
