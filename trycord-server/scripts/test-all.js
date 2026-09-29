// Runs the whole E2E suite against a throwaway server and a throwaway database.
//
// The individual suites assume a clean instance: they register users with
// timestamped names, search by username prefix, and assert on absolute
// message ordering. Pointing them all at a long-lived development database
// makes them interfere with each other, and every script also shares one
// in-process rate-limit bucket per client address, so the registration limit
// is reached partway through a run.
//
// dm-reliability is the one suite that asserts a limit actually throttles, so
// it runs against a server without RATE_LIMIT_MAX. Everything else runs
// against a second server with the ceiling lifted.
//
// Usage: npm test
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SUITES = [
  'test-migration',
  'test-schema-parity',
  'test-storage',
  'test-storage-migrate',
  'test-client-dom',
  'test-dead-css',
  'test-cors-matcher',
];
const LIMITED_SUITE = 'test-dm-reliability';
const SERVER_SUITES = [
  'test-regression', 'test-f1f2', 'test-phase2', 'test-trustsafety',
  'test-gdpr-deletion',
  'test-page-editor',
  'test-overrides', 'test-engagement',
  'test-role-security', 'test-no-self-assign', 'test-notification-paging',
  'test-roster-aggregates', 'test-community-media', 'test-timeout-gates',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer(port, dbFile, env) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      DB_CLIENT: 'sqlite',
      DB_FILE: dbFile,
      JWT_SECRET: 'suite-only-secret-not-used-anywhere-else',
      SERVER_HOST_TYPE: 'express',
      HOST: '127.0.0.1',
      PORT: String(port),
      ALLOW_TEST_HOOKS: 'true',
      ADMIN_USERNAMES: 'tsadmin',
      MAIL_MODE: 'log',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  child.stderr.on('data', (b) => { err += b.toString(); });
  return { child, stderr: () => err };
}

async function waitForHealth(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  return false;
}

function runSuite(name, url) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join('scripts', name + '.js')], {
      cwd: ROOT,
      env: url ? { ...process.env, TRYCORD_TEST_URL: url } : process.env,
    });
    let out = '';
    child.stdout.on('data', (b) => { out += b.toString(); });
    child.stderr.on('data', (b) => { out += b.toString(); });
    child.on('close', (code) => resolve({ name, code, out }));
  });
}

function summarise(result) {
  const m = result.out.match(/(pass=\d+ fail=\d+|\d+ passed, \d+ failed|\d+ assertions|\d+ passed)/);
  return m ? m[0] : (result.out.trim().split('\n').pop() || '').slice(0, 70);
}

(async () => {
  const tmp = path.join(os.tmpdir(), 'trycord-suite');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });

  const results = [];

  // Suites that need no server, so they run before anything is booted.
  for (const name of SUITES) {
    results.push(await runSuite(name, null));
  }

  let server = startServer(19971, path.join(tmp, 'limited.db'), {});
  if (!(await waitForHealth(19971))) {
    console.error('server did not become healthy\n' + server.stderr());
    process.exit(1);
  }
  results.push(await runSuite(LIMITED_SUITE, 'http://127.0.0.1:19971'));
  server.child.kill();
  await sleep(1000);

  server = startServer(19972, path.join(tmp, 'suite.db'), { RATE_LIMIT_MAX: '1000000' });
  if (!(await waitForHealth(19972))) {
    console.error('server did not become healthy\n' + server.stderr());
    process.exit(1);
  }
  for (const name of SERVER_SUITES) {
    results.push(await runSuite(name, 'http://127.0.0.1:19972'));
  }
  server.child.kill();
  await sleep(500);
  fs.rmSync(tmp, { recursive: true, force: true });

  let failed = 0;
  for (const r of results) {
    if (r.code !== 0) {
      failed++;
      console.log(`FAIL  ${r.name}`);
      console.log(r.out.trim().split('\n').slice(-12).map((l) => '      ' + l).join('\n'));
    } else {
      console.log(`PASS  ${r.name.padEnd(26)} ${summarise(r)}`);
    }
  }
  console.log(`\n${results.length - failed}/${results.length} suites passed`);
  process.exit(failed ? 1 : 0);
})();
