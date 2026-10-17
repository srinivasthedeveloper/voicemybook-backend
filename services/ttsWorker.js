// Child process run by ttsPool: owns one Kokoro model and synthesizes one chunk at a time
const { getTTS, synthesizeToMp3 } = require('./ttsService');
const log = require('./logger');

process.on('disconnect', () => process.exit(0));
getTTS().catch(err => log.error('tts-worker', 'Model load failed', { err }));

process.on('message', async ({ id, text, opts, mp3Path }) => {
  try {
    process.send({ id, durationSec: await synthesizeToMp3(text, opts, mp3Path) });
  } catch (err) {
    process.send({ id, error: err.message || String(err) });
  }
});
