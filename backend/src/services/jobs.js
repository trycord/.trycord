// Native background job system.
//
// Jobs are durable rows: a job is claimed by exactly one worker, runs to
// completion or failure, and is retried with backoff until it succeeds or
// exhausts its attempts. A restarted or crashed worker never silently loses
// durable work, and two workers never process the same job.
//
// Concurrency is bounded: a fixed pool of workers claims jobs from the
// database, never one worker per request. The pool size is CPU-aware by
// default (half the logical CPUs, floored to at least one, capped at eight)
// and can be overridden with JOBS_WORKERS for small self-hosted boxes.
//
// Lifecycle of one job:
//
//   pending -> running -> done
//   pending -> running -> pending (retry, run_after pushed into the future)
//   pending -> running -> failed (exhausted attempts: dead letter)
//
// A failed job that still has attempts left is reset to pending with its
// backoff doubled (plus jitter), so a transient outage self-heals instead of
// hammering a failing target.

const db = require('../db');
const { now, uuid } = require('../util');

const POLL_MS = 1000;
const MAX_BACKOFF_MS = 60 * 60 * 1000; // cap exponential backoff at an hour

// Job type -> handler. Registered at boot by the services that own each kind.
// A handler receives the parsed payload and must not throw for a job that is
// merely invalid - it returns normally and lets the job be marked done, or
// throws to trigger the retry path.
const handlers = new Map();
// Concurrency limit per kind, so one expensive job type cannot starve the rest.
const kindLimits = new Map();
const kindRunning = new Map();

// One claimed job at a time per worker slot.
let workers = [];
let stopping = false;
let started = false;

// CPU-aware default: half the logical CPUs, at least one, at most eight.
// Container limits are not visible to Node here. The operator can pin the pool
// with JOBS_WORKERS, or save cpu.worker_count in the configuration centre; the
// saved value wins, the environment seeds it, and the CPU-aware default is the
// floor. Applied when the process next starts.
function defaultWorkerCount() {
  try {
    const settings = require('./services/settings');
    if (settings.isLoaded()) {
      const saved = settings.get('cpu.worker_count');
      if (Number.isFinite(saved) && saved > 0) return Math.floor(saved);
    }
  } catch { /* store not loaded yet */ }
  const fromEnv = Number(process.env.JOBS_WORKERS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv);
  const cpus = require('os').cpus().length || 1;
  return Math.min(8, Math.max(1, Math.floor(cpus / 2)));
}

function isoPlusMs(ms) {
  return new Date(Date.now() + ms).toISOString();
}

// Default concurrency per job kind: how many jobs of the same type run at once.
// Read from the configuration centre (cpu.concurrent_jobs), falling back to 4.
// Applied when the process next starts.
//
// The environment variable is JOBS_CONCURRENT_JOBS, beside JOBS_WORKERS. The
// older name, TRYCORD_CONCURRENT_JOBS, is still read so a deployment that
// set it keeps the value it set; it is the second choice, not the first.
function defaultConcurrency() {
  try {
    const settings = require('./services/settings');
    if (settings.isLoaded()) {
      const saved = settings.get('cpu.concurrent_jobs');
      if (Number.isFinite(saved) && saved > 0) return Math.floor(saved);
    }
  } catch { /* store not loaded yet */ }
  const fromEnv = Number(process.env.JOBS_CONCURRENT_JOBS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv);
  const legacy = Number(process.env.TRYCORD_CONCURRENT_JOBS);
  if (Number.isFinite(legacy) && legacy > 0) return Math.floor(legacy);
  return 4;
}

// Claim the next due job, atomically. Returns null when nothing is due.
// The UPDATE re-checks status, so two workers racing on the same row leave
// exactly one claimant; the other abandons and tries again.
// `attempts` is not touched here: it is counted when the job finishes, so the
// number the handler sees is the number of *finished* attempts so far.
async function claimJob() {
  const nowIso = now();
  const row = await db.transaction(async (conn) => {
    const candidate = await conn.get(
      'SELECT id, kind, payload, attempts, max_attempts, backoff_ms FROM jobs ' +
      'WHERE status = ? AND run_after <= ? ORDER BY run_after ASC, id ASC LIMIT 1',
      ['pending', nowIso]
    );
    if (!candidate) return null;
    const res = await conn.run(
      'UPDATE jobs SET status = ?, updated_at = ? WHERE id = ? AND status = ?',
      ['running', nowIso, candidate.id, 'pending']
    );
    if (res.changes !== 1) return null;
    return candidate;
  });
  return row;
}

async function markDone(id, job) {
  await db.run(
    'UPDATE jobs SET status = ?, attempts = ?, error = NULL, updated_at = ? WHERE id = ?',
    ['done', job.attempts + 1, now(), id]
  );
}

async function markFailed(id, job, message) {
  const used = job.attempts + 1;
  const maxAttempts = job.max_attempts;
  if (used < maxAttempts) {
    let backoff = job.backoff_ms * 2;
    if (backoff > MAX_BACKOFF_MS) backoff = MAX_BACKOFF_MS;
    const jitter = Math.floor(Math.random() * backoff / 2);
    await db.run(
      'UPDATE jobs SET status = ?, attempts = ?, backoff_ms = ?, run_after = ?, updated_at = ? WHERE id = ?',
      ['pending', used, backoff, isoPlusMs(backoff + jitter), now(), id]
    );
  } else {
    await db.run(
      'UPDATE jobs SET status = ?, attempts = ?, error = ?, updated_at = ? WHERE id = ?',
      ['failed', used, String(message || 'job failed').slice(0, 2000), now(), id]
    );
  }
}

async function worker(slot) {
  while (!stopping) {
    let job;
    try { job = await claimJob(); } catch (e) {
      // A database hiccup should not take the whole pool down.
      console.warn('[jobs] claim failed: ' + (e && e.message));
      await sleep(POLL_MS);
      continue;
    }
    if (!job) { await sleep(POLL_MS); continue; }

    const handler = handlers.get(job.kind);
    try {
      if (!handler) throw new Error('no handler registered for job kind "' + job.kind + '"');

      // Kind concurrency limit: one expensive job type cannot starve the rest.
      // If this kind is at its cap, put the job back and wait for a slot.
      const limit = kindLimits.get(job.kind) || 1;
      const running = kindRunning.get(job.kind) || 0;
      if (running >= limit) {
        await db.run(
          'UPDATE jobs SET status = ?, updated_at = ? WHERE id = ? AND status = ?',
          ['pending', now(), job.id, 'running']
        );
        await sleep(POLL_MS);
        continue;
      }
      kindRunning.set(job.kind, running + 1);
      try {
        await handler(JSON.parse(job.payload || '{}'));
        await markDone(job.id, job);
      } catch (e) {
        await markFailed(job.id, job, e && e.message);
      } finally {
        kindRunning.set(job.kind, Math.max(0, (kindRunning.get(job.kind) || 1) - 1));
      }
    } catch (e) {
      // A handler that throws after the kind slot was taken still needs the
      // slot released; the finally above already did that, so mark failed and
      // continue rather than crashing the worker.
      await markFailed(job.id, job, e && e.message);
    }
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Register a job type. opts.concurrency caps how many of this kind run at once
// across the whole pool; opts.maxAttempts and opts.backoffMs shape retries.
function register(kind, handler, opts = {}) {
  if (handlers.has(kind)) throw new Error('job kind already registered: ' + kind);
  handlers.set(kind, handler);
  kindLimits.set(kind, Math.max(1, Number(opts.concurrency || defaultConcurrency())));
  kindRunning.set(kind, 0);
}

// Insert a job and return its id. runAfterMs delays the first attempt.
async function enqueue(kind, payload, opts = {}) {
  const id = opts.id || uuid();
  const runAfter = opts.runAfterMs != null
    ? isoPlusMs(opts.runAfterMs)
    : now();
  await db.run(
    'INSERT INTO jobs (id, kind, payload, status, attempts, max_attempts, backoff_ms, run_after, created_at, updated_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      id, kind, JSON.stringify(payload || {}), 'pending',
      0, opts.maxAttempts || 5, opts.backoffMs || 1000,
      runAfter, now(), now()
    ]
  );
  return id;
}

// Stats for the admin dashboard and health checks.
async function stats() {
  const rows = await db.all(
    'SELECT status, COUNT(*) AS n FROM jobs GROUP BY status'
  );
  const out = {};
  for (const r of rows) out[r.status] = r.n;
  return { workers: workers.length, byStatus: out, kinds: [...handlers.keys()] };
}

function startedFlag() { return started; }

async function start() {
  if (started) return;
  started = true;
  const count = defaultWorkerCount();
  workers = [];
  for (let i = 0; i < count; i++) {
    const p = (async () => { await worker(i); })();
    workers.push(p);
  }
  console.log('[info] job system started: ' + count + ' worker(s)');
}

async function stop() {
  if (!started) return;
  stopping = true;
  const timeout = setTimeout(() => {
    console.warn('[jobs] shutdown timeout: stopping workers mid-flight');
    stopping = false; // let the waits return
  }, 15000);
  await Promise.all(workers);
  clearTimeout(timeout);
  workers = [];
  started = false;
  stopping = false;
}

module.exports = {
  register,
  enqueue,
  start,
  stop,
  stats,
  started: startedFlag,
  POLL_MS,
};
