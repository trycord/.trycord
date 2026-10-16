// Native background job system (services/jobs.js).
//
// A job is a durable row: claimed by exactly one worker, retried with
// backoff on failure, and never lost on restart or crash. This check exercises
// the full lifecycle against a throwaway SQLite database:
//
//   pending -> running -> done          (a well-behaved job)
//   pending -> running -> pending -> ... -> failed   (a job that keeps failing)
//
// It does not start a server - it imports the job module directly, so it runs
// fast and needs no network.

const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const DB_FILE = path.join(ROOT, 'tmp', 'check-jobs.db');

let failures = 0;
const ok = (label, cond, detail) => {
  if (cond) console.log('  ok   ' + label + (detail ? ': ' + detail : ''));
  else { failures++; console.log('  FAIL ' + label + (detail ? '  <- ' + detail : '')); }
};

(async () => {
  // A fresh throwaway database so this check never touches a real instance.
  try { fs.rmSync(DB_FILE, { force: true }); } catch { /* already gone */ }
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

  process.env.DB_CLIENT = 'sqlite';
  process.env.DB_FILE = DB_FILE;
  const db = require(path.join(ROOT, 'src', 'db'));
  const jobs = require(path.join(ROOT, 'src', 'services', 'jobs'));

  await db.connect();

  const processed = [];
  jobs.register('checkjob_ok', async (payload) => { processed.push(payload); });
  jobs.register('checkjob_bad', async () => { throw new Error('this job always fails'); });

  await jobs.start();

  const idOk = await jobs.enqueue('checkjob_ok', { n: 1 });
  const idBad = await jobs.enqueue('checkjob_bad', {}, { maxAttempts: 3, backoffMs: 40 });

  // Wait long enough for the good job to run and the bad one to exhaust its
  // attempts (3 attempts x ~40-120ms backoff, plus the 1s poll interval).
  await new Promise((r) => setTimeout(r, 7000));

  const s = await jobs.stats();
  console.log('  job stats:', JSON.stringify(s));

  const rOk = await db.get('SELECT status, attempts FROM jobs WHERE id = ?', [idOk]);
  const rBad = await db.get('SELECT status, attempts FROM jobs WHERE id = ?', [idBad]);

  ok('a well-behaved job reaches done', rOk.status === 'done',
    rOk ? rOk.status + ' / ' + rOk.attempts : 'no row');
  ok('the good job ran its handler', processed.length === 1 &&
    processed[0] && processed[0].n === 1,
    'ran ' + processed.length + ' time(s)');
  ok('a repeatedly-failing job reaches failed (dead letter)', rBad.status === 'failed',
    rBad ? rBad.status + ' / ' + rBad.attempts : 'no row');
  ok('the bad job tried its configured attempts', rBad && rBad.attempts >= 3,
    String(rBad && rBad.attempts));

  await jobs.stop();
  await db.close();

  console.log('\n  jobs check ' + (failures ? 'FAILED - ' + failures + ' problem(s)' : 'passed'));
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
