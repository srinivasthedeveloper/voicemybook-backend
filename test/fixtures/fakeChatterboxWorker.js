// Stand-in for tts-python/chatterbox_worker.py: same JSON-lines protocol, no model
const fs = require('fs');
const readline = require('readline');
const mode = process.env.FAKE_MODE || 'ok';
if (mode === 'crash-on-start') { process.stderr.write('boom: model load failed\n'); process.exit(1); }
// Only the first worker may start; later ones crash while loading (a shared marker file decides)
if (process.env.FAKE_ONE_ONLY) {
  try { fs.closeSync(fs.openSync(process.env.FAKE_ONE_ONLY, 'wx')); } catch { process.stderr.write('second worker failed to load\n'); process.exit(1); }
}
process.stderr.write('fake worker log line\n');
setTimeout(() => process.stdout.write(JSON.stringify({ ready: true }) + '\n'), 50);
readline.createInterface({ input: process.stdin }).on('line', line => {
  const { id, text, mp3Path } = JSON.parse(line);
  if (text === 'die') process.exit(3);
  if (mode === 'missing-clip' || text === 'missing') {
    process.stdout.write(JSON.stringify({ id, error: 'Voice clip x.wav is missing' }) + '\n');
    return;
  }
  fs.writeFileSync(mp3Path, text);
  const delay = text.startsWith('slow') ? 150 : 0;
  setTimeout(() => process.stdout.write(JSON.stringify({ id, durationSec: text.length, retries: 0 }) + '\n'), delay);
});
