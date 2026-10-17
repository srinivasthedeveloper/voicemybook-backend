// Stand-in for services/ttsWorker.js: same message protocol, no Kokoro
const fs = require('fs');
process.on('disconnect', () => process.exit(0));
process.on('message', ({ id, text, mp3Path }) => {
  if (text === 'crash') process.exit(1);
  setTimeout(() => {
    fs.writeFileSync(mp3Path, text);
    process.send({ id, durationSec: text.length, pid: process.pid });
  }, 150);
});
