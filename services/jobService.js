const db = require('../db');

// SSE client registry: jobId → Set<Response>
const sseClients = new Map();

// ─── DB helpers ──────────────────────────────────────────────────────────────

function createJob(data) {
  const stmt = db.prepare(`
    INSERT INTO jobs (id, status, pdf_path, pdf_filename, pdf_size_bytes, page_count, voice, speed)
    VALUES (@id, 'pending', @pdf_path, @pdf_filename, @pdf_size_bytes, @page_count, @voice, @speed)
  `);
  stmt.run(data);
  return getJob(data.id);
}

function getJob(id) {
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  if (!row) return null;
  return {
    ...row,
    chapters: row.chapters_json ? JSON.parse(row.chapters_json) : null,
    chapter_audios: row.chapter_audios_json ? JSON.parse(row.chapter_audios_json) : null,
    transcript: row.transcript_json ? JSON.parse(row.transcript_json) : null,
  };
}

function updateJob(id, fields) {
  const allowed = [
    'status', 'stage', 'progress', 'page_count', 'voice', 'speed',
    'chunks_total', 'chunks_done', 'audio_path', 'audio_url',
    'chapters_json', 'chapter_audios_json', 'transcript_json', 'error_message',
  ];
  const updates = Object.keys(fields).filter(k => allowed.includes(k));
  if (updates.length === 0) return;

  const set = updates.map(k => `${k} = @${k}`).join(', ');
  const params = { id };
  for (const k of updates) params[k] = fields[k];

  db.prepare(`UPDATE jobs SET ${set}, updated_at = datetime('now') WHERE id = @id`).run(params);
}

function deleteJob(id) {
  db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
}

function getOldJobs(olderThanHours) {
  return db
    .prepare(`SELECT * FROM jobs WHERE created_at < datetime('now', '-${olderThanHours} hours')`)
    .all();
}

// ─── SSE helpers ─────────────────────────────────────────────────────────────

function registerSSEClient(jobId, res) {
  if (!sseClients.has(jobId)) sseClients.set(jobId, new Set());
  sseClients.get(jobId).add(res);
}

function unregisterSSEClient(jobId, res) {
  const clients = sseClients.get(jobId);
  if (clients) {
    clients.delete(res);
    if (clients.size === 0) sseClients.delete(jobId);
  }
}

function emitProgress(jobId, data) {
  // Persist to DB
  const dbFields = {};
  if (data.stage)         dbFields.stage         = data.stage;
  if (data.progress != null) dbFields.progress   = data.progress;
  if (data.status)        dbFields.status        = data.status;
  if (data.chunksTotal != null) dbFields.chunks_total = data.chunksTotal;
  if (data.chunksDone  != null) dbFields.chunks_done  = data.chunksDone;
  if (data.audioPath)     dbFields.audio_path    = data.audioPath;
  if (data.audioUrl)      dbFields.audio_url     = data.audioUrl;
  if (data.chaptersJson)      dbFields.chapters_json       = data.chaptersJson;
  if (data.chapterAudiosJson) dbFields.chapter_audios_json = data.chapterAudiosJson;
  if (data.transcriptJson)    dbFields.transcript_json     = data.transcriptJson;
  if (data.errorMessage)      dbFields.error_message       = data.errorMessage;
  if (Object.keys(dbFields).length) updateJob(jobId, dbFields);

  // Push to SSE clients
  const clients = sseClients.get(jobId) || new Set();
  const payload = JSON.stringify(data);
  for (const res of clients) {
    res.write(`event: status\ndata: ${payload}\n\n`);
  }

  // Close SSE connections on terminal states
  if (data.stage === 'complete' || data.stage === 'error') {
    for (const res of clients) {
      res.write(`event: close\ndata: {}\n\n`);
      res.end();
    }
    sseClients.delete(jobId);
  }
}

module.exports = {
  createJob,
  getJob,
  updateJob,
  deleteJob,
  getOldJobs,
  registerSSEClient,
  unregisterSSEClient,
  emitProgress,
};
