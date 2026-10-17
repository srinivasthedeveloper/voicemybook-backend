const path = require('path');
const { fork } = require('child_process');
const log = require('./logger');

// Kokoro blocks its thread and isn't safe across worker_threads, so each worker is its own process
function createPool(size, workerPath = path.join(__dirname, 'ttsWorker.js')) {
  const workers = [];
  const waiting = [];   // [{ text, opts, mp3Path, resolve, reject }]
  let nextId = 0;
  let closed = false;

  function spawn() {
    const w = { proc: fork(workerPath, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] }), job: null };
    w.proc.on('message', msg => {
      const job = w.job;
      if (!job || msg.id !== job.id) return;
      w.job = null;
      if (msg.error) job.reject(new Error(msg.error));
      else job.resolve(msg.durationSec);
      dispatch();
    });
    w.proc.on('exit', code => {
      workers.splice(workers.indexOf(w), 1);
      if (w.job) w.job.reject(new Error(`TTS worker exited (code ${code})`));
      if (closed) return;
      log.warn('tts-pool', `worker ${w.proc.pid} exited (code ${code}), respawning`);
      workers.push(spawn());
      dispatch();
    });
    return w;
  }

  function start() {
    while (!closed && workers.length < size) workers.push(spawn());
  }

  function dispatch() {
    start();
    for (const w of workers) {
      if (w.job || waiting.length === 0) continue;
      const job = waiting.shift();
      job.id = ++nextId;
      w.job = job;
      w.proc.send({ id: job.id, text: job.text, opts: job.opts, mp3Path: job.mp3Path });
    }
  }

  function synthesize(text, opts, mp3Path) {
    return new Promise((resolve, reject) => {
      waiting.push({ text, opts, mp3Path, resolve, reject });
      dispatch();
    });
  }

  function close() {
    closed = true;
    for (const w of workers) w.proc.kill();
  }

  return { size, start, synthesize, close };
}

let _pool = null;
function getPool() {
  if (!_pool) _pool = createPool(require('../config').tts.workers);
  return _pool;
}

module.exports = { createPool, getPool };
