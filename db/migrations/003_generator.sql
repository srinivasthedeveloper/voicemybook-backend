ALTER TABLE jobs ADD COLUMN pdf_sha256 TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_sha256 ON jobs(pdf_sha256) WHERE pdf_sha256 IS NOT NULL;

CREATE TABLE IF NOT EXISTS chapter_runs (
  job_id        TEXT NOT NULL,
  chapter_index INTEGER NOT NULL,
  state         TEXT NOT NULL DEFAULT 'not_started',
  run_id        INTEGER NOT NULL DEFAULT 0,
  has_audio     INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (job_id, chapter_index)
);

CREATE TABLE IF NOT EXISTS chunks (
  job_id        TEXT NOT NULL,
  chapter_index INTEGER NOT NULL,
  run_id        INTEGER NOT NULL,
  chunk_index   INTEGER NOT NULL,
  text          TEXT NOT NULL,
  voice         TEXT NOT NULL,
  speed         REAL NOT NULL,
  duration_sec  REAL NOT NULL,
  file_path     TEXT NOT NULL,
  PRIMARY KEY (job_id, chapter_index, run_id, chunk_index)
);
