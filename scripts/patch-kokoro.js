#!/usr/bin/env node
// Patches kokoro-js dist/kokoro.js to fix Node <21.2 compatibility
// (import.meta.dirname is only available from Node 21.2+)
const fs = require('fs');
const path = require('path');

const target = path.join(__dirname, '../node_modules/kokoro-js/dist/kokoro.js');
if (!fs.existsSync(target)) {
  console.log('[patch-kokoro] kokoro.js not found, skipping.');
  process.exit(0);
}

const content = fs.readFileSync(target, 'utf8');
const old = 't=s.resolve(a,`../voices/${e}.bin`)';
const patched = 't=s.resolve(a??process.cwd(),`../voices/${e}.bin`)'; // TODO (move the bin assest inside the backend folder [if it's fetching outside of the backend folder ie root directory or VoiceMyBook folder]) 

if (content.includes(patched)) {
  console.log('[patch-kokoro] Already patched.');
  process.exit(0);
}
if (!content.includes(old)) {
  console.log('[patch-kokoro] Target string not found — kokoro-js may have been updated. Skipping.');
  process.exit(0);
}

fs.writeFileSync(target, content.replace(old, patched));
console.log('[patch-kokoro] Patched kokoro.js for Node <21.2 compatibility.');
