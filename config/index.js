require('dotenv').config();
const path = require('path');

module.exports = {
  port: parseInt(process.env.PORT) || 3001,
  nodeEnv: process.env.NODE_ENV || 'development',

  uploadDir: path.resolve(process.env.UPLOAD_DIR || './uploads'),
  voicesRefDir: path.resolve(process.env.VOICES_REF_DIR || './voices-ref'),
  chatterboxPython: process.env.CHATTERBOX_PYTHON || path.resolve(__dirname, '..', 'tts-python', '.venv', 'bin', 'python'),
  maxFileSizeMB: parseInt(process.env.MAX_FILE_SIZE_MB) || 50,

  tts: {
    concurrency: parseInt(process.env.TTS_CONCURRENCY) || 3,
    chunkSize: parseInt(process.env.TTS_CHUNK_SIZE) || 400,
    workers: parseInt(process.env.TTS_WORKERS) || 2, // Kokoro processes = chapters generated in parallel
    turboWorkers: parseInt(process.env.TURBO_WORKERS) || 1,
    cbWorkers: parseInt(process.env.CB_WORKERS) || 1,
    chatterboxIdleMin: parseInt(process.env.CHATTERBOX_IDLE_MIN) || 10,
    defaultVoice: process.env.TTS_VOICE || 'af_heart',
  },

  cleanupAfterHours: parseInt(process.env.CLEANUP_AFTER_HOURS) || 720, // 30 days; negative disables

  // Kokoro neural voices (grade A/B only)
  voices: [
    { id: 'af_heart',   label: 'Heart',    description: 'US Female ❤️'    },
    { id: 'af_bella',   label: 'Bella',    description: 'US Female 🔥'    },
    { id: 'af_nicole',  label: 'Nicole',   description: 'US Female 🎧'    },
    { id: 'am_fenrir',  label: 'Fenrir',   description: 'US Male'         },
    { id: 'am_michael', label: 'Michael',  description: 'US Male'         },
    { id: 'am_puck',    label: 'Puck',     description: 'US Male'         },
    { id: 'bf_emma',    label: 'Emma',     description: 'British Female'  },
    { id: 'bm_george',  label: 'George',   description: 'British Male'    },
    { id: "bm_lewis", label: "Lewis", description: "British Male" },
    { id: "bf_isabella", label: "Isabella", description: "British Female" },
    { id: "af_sarah", label: "Sarah", description: "US Female" },
    { id: "af_sky", label: "Sky", description: "US Female" },
    { id: "am_adam", label: "Adam", description: "US Male" },
    {id: "bm_fable", label: "Fable", description: "British Male" },
  ],
};
