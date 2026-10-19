const fs = require('fs');
const os = require('os');
const path = require('path');

// Must run before requiring db/config/services
function setupTmpEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmb-test-'));
  process.env.DB_PATH = path.join(dir, 'test.db');
  process.env.UPLOAD_DIR = path.join(dir, 'uploads');
  process.env.NODE_ENV = 'test';
  process.env.CLEANUP_AFTER_HOURS = '-1'; // '0' falls back to the 30-day default
  process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';
  return dir;
}

module.exports = { setupTmpEnv };
