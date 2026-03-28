require('dotenv').config();
const path = require('path');

module.exports = {
  port: parseInt(process.env.PORT) || 3001,
  nodeEnv: process.env.NODE_ENV || 'development',

  uploadDir: path.resolve(process.env.UPLOAD_DIR || './uploads'),
  maxFileSizeMB: parseInt(process.env.MAX_FILE_SIZE_MB) || 50,

  tts: {
    concurrency: parseInt(process.env.TTS_CONCURRENCY) || 3,
    chunkSize: parseInt(process.env.TTS_CHUNK_SIZE) || 1000,
    defaultVoice: process.env.TTS_VOICE || 'af_heart',
  },

  cleanupAfterHours: parseInt(process.env.CLEANUP_AFTER_HOURS) || 24,

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
  ],
};
