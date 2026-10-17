const db = require('../db');

function toChapter(jobId, chapterIndex, row) {
  return {
    jobId,
    chapterIndex: Number(chapterIndex),
    state: row ? row.state : 'not_started',
    runId: row ? row.run_id : 0,
    hasAudio: row ? row.has_audio === 1 : false,
  };
}

function toChunk(row) {
  return {
    jobId: row.job_id,
    chapterIndex: row.chapter_index,
    runId: row.run_id,
    chunkIndex: row.chunk_index,
    text: row.text,
    voice: row.voice,
    speed: row.speed,
    durationSec: row.duration_sec,
    filePath: row.file_path,
  };
}

function getChapter(jobId, chapterIndex) {
  const row = db.prepare('SELECT * FROM chapter_runs WHERE job_id = ? AND chapter_index = ?')
    .get(jobId, Number(chapterIndex));
  return toChapter(jobId, chapterIndex, row);
}

function setChapter(jobId, chapterIndex, patch) {
  const next = { ...getChapter(jobId, chapterIndex), ...patch };
  db.prepare(`
    INSERT INTO chapter_runs (job_id, chapter_index, state, run_id, has_audio, updated_at)
    VALUES (@jobId, @chapterIndex, @state, @runId, @hasAudio, datetime('now'))
    ON CONFLICT(job_id, chapter_index) DO UPDATE SET
      state = excluded.state, run_id = excluded.run_id, has_audio = excluded.has_audio, updated_at = excluded.updated_at
  `).run({ jobId, chapterIndex: Number(chapterIndex), state: next.state, runId: next.runId, hasAudio: next.hasAudio ? 1 : 0 });
  return next;
}

function listChapters(jobId) {
  return db.prepare('SELECT * FROM chapter_runs WHERE job_id = ? ORDER BY chapter_index')
    .all(jobId)
    .map(row => toChapter(jobId, row.chapter_index, row));
}

function addChunk(c) {
  db.prepare(`
    INSERT OR REPLACE INTO chunks (job_id, chapter_index, run_id, chunk_index, text, voice, speed, duration_sec, file_path)
    VALUES (@jobId, @chapterIndex, @runId, @chunkIndex, @text, @voice, @speed, @durationSec, @filePath)
  `).run(c);
}

function listChunks(jobId, chapterIndex, runId) {
  return db.prepare('SELECT * FROM chunks WHERE job_id = ? AND chapter_index = ? AND run_id = ? ORDER BY chunk_index')
    .all(jobId, Number(chapterIndex), runId)
    .map(toChunk);
}

function deleteRunChunks(jobId, chapterIndex, runId) {
  db.prepare('DELETE FROM chunks WHERE job_id = ? AND chapter_index = ? AND run_id = ?')
    .run(jobId, Number(chapterIndex), runId);
}

function findInterrupted() {
  return db.prepare("SELECT job_id, chapter_index, run_id, has_audio FROM chapter_runs WHERE state IN ('generating', 'queued')")
    .all()
    .map(r => ({ jobId: r.job_id, chapterIndex: r.chapter_index, runId: r.run_id, hasAudio: r.has_audio === 1 }));
}

module.exports = { getChapter, setChapter, listChapters, addChunk, listChunks, deleteRunChunks, findInterrupted };
