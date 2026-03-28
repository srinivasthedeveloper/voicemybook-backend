CREATE TABLE IF NOT EXISTS jobs (
  id              TEXT PRIMARY KEY,
  status          TEXT NOT NULL DEFAULT 'pending',
  stage           TEXT,
  progress        INTEGER DEFAULT 0,
  pdf_path        TEXT NOT NULL,
  pdf_filename    TEXT NOT NULL,
  pdf_size_bytes  INTEGER NOT NULL,
  page_count      INTEGER,
  voice           TEXT DEFAULT 'en-US-AriaNeural',
  speed           REAL DEFAULT 1.0,
  chunks_total    INTEGER DEFAULT 0,
  chunks_done     INTEGER DEFAULT 0,
  audio_path      TEXT,
  audio_url       TEXT,
  chapters_json   TEXT,
  error_message   TEXT,
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at);
