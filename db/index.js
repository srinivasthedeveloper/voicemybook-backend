const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.resolve('./voicemybook.db');
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

const db = new Database(DB_PATH);

// Performance pragmas
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');

// Migration tracking table
db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, run_at TEXT)`);

// Run each migration file exactly once
const migrationFiles = fs.readdirSync(MIGRATIONS_DIR).sort();
for (const file of migrationFiles) {
  if (!file.endsWith('.sql')) continue;
  const already = db.prepare('SELECT name FROM _migrations WHERE name = ?').get(file);
  if (already) continue;
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
  db.exec(sql);
  db.prepare(`INSERT INTO _migrations (name, run_at) VALUES (?, datetime('now'))`).run(file);
}

module.exports = db;
