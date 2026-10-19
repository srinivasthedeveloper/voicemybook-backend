const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');

const START_FAIL_WINDOW_MS = 60000;

// Python Chatterbox workers (Turbo or original): started on first use, stopped when idle
function createChatterboxPool({ engine, size = 1, command, args, idleMs, log, env = process.env }) {
  const scope = `tts-${engine}`;
  const workers = [];   // { proc, ready, job }
  const waiting = [];   // [{ text, opts, mp3Path, resolve, reject }]
  let nextId = 0;
  let state = 'stopped';
  let lastErr = null;
  let failedStarts = [];
  let idleTimer = null;
  let closed = false;

  if (!command) {
    const config = require('../config');
    command = config.chatterboxPython;
    args = [path.join(__dirname, '..', 'tts-python', 'chatterbox_worker.py'), '--engine', engine,
      '--voices-dir', config.voicesRefDir, '--ffmpeg', require('@ffmpeg-installer/ffmpeg').path];
  }

  const failingFast = () => failedStarts.filter(t => Date.now() - t < START_FAIL_WINDOW_MS).length >= 2;
  const anyReady = () => workers.some(w => w.ready);

  function spawnWorker() {
    const w = { proc: spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env }), ready: false, job: null };
    let lastLine = '';
    state = 'starting';
    readline.createInterface({ input: w.proc.stderr }).on('line', line => {
      lastLine = line;
      log.info(scope, line);
    });
    readline.createInterface({ input: w.proc.stdout }).on('line', line => {
      let msg;
      try { msg = JSON.parse(line); } catch { return log.warn(scope, `ignored non-protocol output: ${line}`); }
      if (msg.ready) {
        w.ready = true;
        state = 'ready';
        return dispatch();
      }
      const job = w.job;
      if (!job || msg.id !== job.id) return;
      w.job = null;
      if (msg.error) job.reject(new Error(msg.error));
      else job.resolve(msg.durationSec);
      dispatch();
    });
    w.proc.stdin.on('error', () => {}); // a dying worker must not crash Node with EPIPE
    let gone = false;
    const onGone = (code, reason) => {
      if (gone) return;
      gone = true;
      if (workers.includes(w)) workers.splice(workers.indexOf(w), 1);
      const err = new Error(`Chatterbox ${engine} worker exited (code ${code})${reason || lastLine ? `: ${reason || lastLine}` : ''}`);
      if (w.job) w.job.reject(err);
      if (!w.ready && !w.stopping && !closed) {
        failedStarts.push(Date.now());
        lastErr = err;
        // Nothing can serve right now: fail what's waiting instead of respawning in a loop
        if (workers.length === 0) for (const job of waiting.splice(0)) job.reject(err);
      }
      if (workers.length === 0) state = failingFast() ? 'error' : 'stopped';
      if (!closed && waiting.length && (anyReady() || !failingFast())) dispatch();
    };
    // A binary that can't run emits only 'error', never 'exit'
    w.proc.on('error', err => onGone(null, err.message));
    w.proc.on('exit', code => onGone(code));
    workers.push(w);
  }

  function dispatch() {
    const wanted = Math.min(size, waiting.length + workers.filter(w => w.job).length);
    while (workers.length < wanted && !failingFast()) spawnWorker();
    for (const w of workers) {
      if (!w.ready || w.job || waiting.length === 0) continue;
      const job = waiting.shift();
      job.id = ++nextId;
      w.job = job;
      w.proc.stdin.write(JSON.stringify({ id: job.id, text: job.text, opts: job.opts, mp3Path: job.mp3Path }) + '\n');
    }
    armIdle();
  }

  function armIdle() {
    clearTimeout(idleTimer);
    if (waiting.length || workers.some(w => w.job) || workers.length === 0) return;
    idleTimer = setTimeout(() => {
      log.info(scope, `idle for ${Math.round(idleMs / 1000)}s, stopping worker`);
      // Take them out of service first, so a request arriving now starts a fresh worker
      for (const w of workers.splice(0)) {
        w.stopping = true;
        w.proc.kill();
      }
      state = 'stopped';
    }, idleMs);
    idleTimer.unref?.();
  }

  function synthesize(text, opts, mp3Path, signal) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (failingFast() && !anyReady()) return Promise.reject(lastErr);
    return new Promise((resolve, reject) => {
      const job = { text, opts, mp3Path, resolve, reject };
      waiting.push(job);
      // Stop: drop it from the queue, or kill the worker mid-generation (a fresh one serves the rest)
      signal?.addEventListener('abort', () => {
        const w = workers.find(x => x.job === job);
        if (w) {
          workers.splice(workers.indexOf(w), 1);
          w.job = null;
          w.stopping = true;
          w.proc.kill();
        } else if (waiting.includes(job)) waiting.splice(waiting.indexOf(job), 1);
        else return;
        reject(signal.reason);
      }, { once: true });
      dispatch();
    });
  }

  function close() {
    closed = true;
    clearTimeout(idleTimer);
    for (const w of workers) w.proc.kill();
  }

  return { synthesize, status: () => state, lastError: () => (lastErr ? lastErr.message : null), close };
}

module.exports = { createChatterboxPool };
