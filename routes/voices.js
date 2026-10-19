const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('../config');
const log = require('../services/logger');
const { getSynth } = require('../services/synth');
const { listVoices, isValidVoice, engineOf } = require('../services/refVoices');

const router = express.Router();

const PREVIEW_DIR = path.join(config.uploadDir, 'previews');
fs.mkdirSync(PREVIEW_DIR, { recursive: true });

const generating = new Map();
const previews = new Map(); // preview id -> { status: { done, total, etaSec }, parts: [Buffer], listeners: Set }

const L3_KBPS = { 1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], 2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] };
const SAMPLE_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

// Parts are concatenated into one MP3 stream: drop each part's ID3 tag (a click mid-stream) and
// LAME "Info"/"Xing" frame (it states that part's length, so the browser stops playing there)
function stripTags(buf) {
  if (buf.length >= 10 && buf.toString('latin1', 0, 3) === 'ID3') {
    buf = buf.subarray(10 + ((buf[6] << 21) | (buf[7] << 14) | (buf[8] << 7) | buf[9]) + (buf[5] & 0x10 ? 10 : 0));
  }
  if (buf.length < 4 || buf[0] !== 0xff || (buf[1] & 0xe0) !== 0xe0) return buf;
  const version = (buf[1] >> 3) & 3; // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
  const kbps = L3_KBPS[version === 3 ? 1 : 2][buf[2] >> 4];
  const rate = SAMPLE_RATES[version]?.[(buf[2] >> 2) & 3];
  if (!kbps || !rate) return buf;
  const frameLen = Math.floor(((version === 3 ? 144 : 72) * kbps * 1000) / rate) + ((buf[2] >> 1) & 1);
  const head = buf.toString('latin1', 4, 40);
  return head.includes('Info') || head.includes('Xing') ? buf.subarray(frameLen) : buf;
}
const synthOf = req => req.app.locals.synth || getSynth();

const SAMPLE_TEXT =
  "Hello! This is a sample of my voice. I'll be narrating your audiobook with clarity and expression.";

// GET /api/voices
router.get('/', (req, res) => {
  res.json({ voices: listVoices(), engineStatus: synthOf(req).engineStatus() });
});

// GET /api/voices/preview?voice=af_heart&speed=0.9
router.get('/preview', async (req, res) => {
  const { voice } = req.query;
  const speed = req.query.speed == null ? 1.0 : Number(req.query.speed);

  if (!voice || !isValidVoice(voice)) {
    return res.status(400).json({ error: 'Invalid or missing voice parameter' });
  }
  if (!(speed >= 0.5 && speed <= 2.0)) {
    return res.status(400).json({ error: 'speed must be between 0.5 and 2.0' });
  }

  const key = `${voice.replace(':', '_')}_${speed.toFixed(2)}`;
  const mp3Path = path.join(PREVIEW_DIR, `${key}.mp3`);

  try {
    if (!fs.existsSync(mp3Path)) {
      if (!generating.has(key)) {
        const promise = synthOf(req).synthesize(SAMPLE_TEXT, { voice, speed }, mp3Path).finally(() => generating.delete(key));
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

// GET /api/voices/preview/progress/:id — parts done and time left for a running custom preview
router.get('/preview/progress/:id', (req, res) => {
  const p = previews.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'No preview running with that id' });
  res.json(p.status);
});

// GET /api/voices/preview/stream/:id — the running custom preview as one MP3, each part sent as it finishes
router.get('/preview/stream/:id', async (req, res) => {
  // The browser opens this alongside the POST, so give the POST a moment to register the id
  for (let i = 0; i < 30 && !previews.has(req.params.id); i++) await new Promise(r => setTimeout(r, 100));
  const p = previews.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'No preview running with that id' });
  res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' });
  for (const buf of p.parts) res.write(buf);
  const listener = buf => (buf ? res.write(buf) : res.end());
  p.listeners.add(listener);
  res.on('close', () => p.listeners.delete(listener));
});

// POST /api/voices/preview { id?, voice, speed, text } — custom text, not cached
router.post('/preview', async (req, res, next) => {
  const { voice, text } = req.body;
  const id = typeof req.body.id === 'string' && req.body.id.length <= 64 ? req.body.id : null;
  const speed = req.body.speed ?? 1.0;
  if (!isValidVoice(voice)) return res.status(400).json({ error: 'Invalid or missing voice' });
  if (typeof speed !== 'number' || !(speed >= 0.5 && speed <= 2.0)) {
    return res.status(400).json({ error: 'speed must be a number between 0.5 and 2.0' });
  }

  const { chapterChunks } = require('../services/ttsService');
  const { stitchFiles } = require('../services/audioService');
  const body = (typeof text === 'string' && text.trim() ? text : SAMPLE_TEXT).slice(0, 2000);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vmb-preview-'));
  const t0 = Date.now();
  const stop = new AbortController();
  res.on('close', () => { if (!res.writableFinished) stop.abort(); }); // browser hit Stop
  try {
    const parts = [];
    // Same chunking as a chapter of this engine, so the test box sounds like the book will
    const chunks = chapterChunks('', body, engineOf(voice));
    const totalChars = chunks.reduce((n, c) => n + c.text.length, 0);
    let doneChars = 0;
    const entry = { status: { done: 0, total: chunks.length, etaSec: null }, parts: [], listeners: new Set() };
    if (id) previews.set(id, entry);
    for (const [i, c] of chunks.entries()) {
      if (stop.signal.aborted) {
        log.info('preview', `cancelled after ${i} parts voice=${voice}`, { ms: Date.now() - t0 });
        return fs.rmSync(tmp, { recursive: true, force: true });
      }
      const p = path.join(tmp, `${String(i).padStart(4, '0')}.mp3`);
      await synthOf(req).synthesize(c.text, { voice, speed, padSec: c.pauseAfterSec }, p, stop.signal);
      parts.push(p);
      doneChars += c.text.length;
      entry.status = { done: i + 1, total: chunks.length, etaSec: Math.round(((Date.now() - t0) / doneChars) * (totalChars - doneChars) / 1000) };
      if (id) {
        const buf = stripTags(fs.readFileSync(p));
        entry.parts.push(buf);
        for (const l of entry.listeners) l(buf);
      }
    }
    const out = parts.length === 1 ? parts[0] : path.join(tmp, 'preview.mp3');
    if (parts.length > 1) await stitchFiles(parts, out);
    log.info('preview', `custom text ${body.length} chars voice=${voice} speed=${speed}`, { ms: Date.now() - t0 });
    res.setHeader('Content-Type', 'audio/mpeg');
    res.on('close', () => fs.rmSync(tmp, { recursive: true, force: true }));
    fs.createReadStream(out).pipe(res);
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (stop.signal.aborted) return log.info('preview', `cancelled mid-part voice=${voice}`, { ms: Date.now() - t0 });
    next(err);
  } finally {
    if (id && previews.get(id)) {
      for (const l of previews.get(id).listeners) l(null); // end any open stream
      previews.delete(id);
    }
  }
});

module.exports = router;
