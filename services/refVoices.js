const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../config');

const PREFIX = { turbo: 'turbo:', chatterbox: 'cb:' };
const NOTE = { turbo: 'Expressive, about real time', chatterbox: 'Best quality, about 4× slower than real time' };
const HF_REPO = { turbo: 'models--ResembleAI--chatterbox-turbo', chatterbox: 'models--ResembleAI--chatterbox' };

function engineOf(voiceId) {
  if (voiceId?.startsWith(PREFIX.turbo)) return 'turbo';
  if (voiceId?.startsWith(PREFIX.chatterbox)) return 'chatterbox';
  return 'kokoro';
}

const venvReady = () => fs.existsSync(config.chatterboxPython);

function modelCached(engine) {
  const home = process.env.HF_HOME || path.join(os.homedir(), '.cache', 'huggingface');
  return fs.existsSync(path.join(home, 'hub', HF_REPO[engine]));
}

// Kokoro voices plus one Turbo and one original-Chatterbox voice per reference clip (read on every call)
function listVoices({ dir = config.voicesRefDir, venvReady: ready = venvReady() } = {}) {
  const voices = config.voices.map(v => ({ ...v, engine: 'kokoro' }));
  if (!ready || !fs.existsSync(dir)) return voices;
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'voices.json'), 'utf8')); } catch { /* labels are optional */ }
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.wav')).sort()) {
    const name = file.slice(0, -4);
    const { label = name, description } = meta[name] || {};
    for (const engine of ['turbo', 'chatterbox']) {
      voices.push({ id: PREFIX[engine] + name, label, engine, description: description ? `${description} · ${NOTE[engine]}` : NOTE[engine] });
    }
  }
  return voices;
}

const isValidVoice = (id, opts) => listVoices(opts).some(v => v.id === id);

module.exports = { engineOf, listVoices, isValidVoice, venvReady, modelCached };
