const { engineOf } = require('./refVoices');

// Routes each request to the engine its voice belongs to; pools may be factories, created on first use
function createSynth({ kokoro, turbo, chatterbox }) {
  const sources = { kokoro, turbo, chatterbox };
  const pools = {};
  const pool = engine => (pools[engine] ??= typeof sources[engine] === 'function' ? sources[engine]() : sources[engine]);

  return {
    synthesize: (text, opts, mp3Path, signal) => pool(engineOf(opts.voice)).synthesize(text, opts, mp3Path, signal),
    engineStatus: () => ({
      turbo: pools.turbo || typeof turbo !== 'function' ? pool('turbo').status() : 'stopped',
      chatterbox: pools.chatterbox || typeof chatterbox !== 'function' ? pool('chatterbox').status() : 'stopped',
    }),
  };
}

let _synth = null;
function getSynth() {
  if (_synth) return _synth;
  const config = require('../config');
  const log = require('./logger');
  const { getPool } = require('./ttsPool');
  const { createChatterboxPool } = require('./chatterboxPool');
  const idleMs = config.tts.chatterboxIdleMin * 60000;
  _synth = createSynth({
    kokoro: getPool(),
    turbo: () => createChatterboxPool({ engine: 'turbo', size: config.tts.turboWorkers, idleMs, log }),
    chatterbox: () => createChatterboxPool({ engine: 'chatterbox', size: config.tts.cbWorkers, idleMs, log }),
  });
  return _synth;
}

module.exports = { createSynth, getSynth };
