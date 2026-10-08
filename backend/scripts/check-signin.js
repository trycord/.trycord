#!/usr/bin/env node
'use strict';

// Boot a throwaway server and sign in, printing whatever comes back.
//
// A 500 on the correct-password path but not the wrong-password path is not something a
// log tail tells you about: the answer is the body's error code, and that is one request
// away. Also asserts on the way, so it stands up on its own in CI.
//
// node scripts/check-signin.js

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// A port of its own for every run, allocated rather than chosen.
//
// The fixed port this used was 9988, and that is how it came to test somebody else's server.
// A previous run's server was still listening there - this file leaked one per run, and five
// were still alive - so the spawn below could not bind, nothing said so, and every request
// went to the leftover process and its older database. That is what turned "registration
// succeeds" into "409 that email is already in use", which read like a bug in registration
// and was a bug in the check.
let PORT = 0;
let BASE = '';

// Distinct per run, so a second run against the same database is not a conflict.
const USER = 'signinprobe' + process.pid;
const PASS = 'signin-probe-password';

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

async function call(method, p, body, token) {
  const res = await fetch(BASE + p, {
    method,
    headers: Object.assign(
      { 'content-type': 'application/json' },
      token ? { authorization: 'Bearer ' + token } : {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* not json */ }
  return { status: res.status, json };
}

async function main() {
  PORT = await freePort();
  BASE = 'http://127.0.0.1:' + PORT;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trycord-signin-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), HOST: '127.0.0.1', DB_CLIENT: 'sqlite',
      DB_FILE: path.join(tmp, 'signin.sqlite'), MAIL_MODE: 'log',
      ALLOW_TEST_HOOKS: '', JWT_SECRET: 'signin-probe-secret-0123456789',
      BCRYPT_COST: '4', RATE_LIMIT_MAX: '1000',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));

  const done = (code) => {
    // SIGTERM and then wait for it. kill() returns as soon as the signal is sent, and
    // exiting then left the process alive - which is how five of these accumulated, each
    // holding a port, each able to be mistaken for a server under test.
    try { child.kill('SIGTERM'); } catch { /* gone */ }
    const wait = setInterval(() => {
      if (child.exitCode !== null || child.signalCode !== null) {
        clearInterval(wait);
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
        process.exit(code);
      }
    }, 50);
    setTimeout(() => {
      // It ignored SIGTERM. Say so rather than leaving it behind in silence.
      try { child.kill('SIGKILL'); } catch { /* gone */ }
    }, 4000).unref();
  };

  let up = false;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE + '/api/health')).ok) { up = true; break; } } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) {
    console.error('  the server this check started never answered. Log:\n'
      + log.join('').split('\n').slice(-8).map((l) => '    ' + l).join('\n'));
    done(1);
    return;
  }
  // If the process we started died and something else is answering, every assertion below is
  // about the wrong server. Ask the one we own.
  if (child.exitCode !== null) {
    console.error('  the server this check started exited with code ' + child.exitCode
      + ' while something else is answering on ' + PORT + '. Refusing to test it.');
    done(1);
    return;
  }

  let failures = 0;
  const ok = (label, cond, detail) => {
    console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail && !cond ? '  <- ' + detail : ''}`);
    if (!cond) failures++;
  };

  const reg = await call('POST', '/api/auth/register', {
    username: USER, password: PASS, email: USER + '@example.invalid',
    termsVersion: '1.0', privacyVersion: '1.0',
  });
  ok('registration succeeds', reg.status === 200, 'status ' + reg.status
    + ' ' + JSON.stringify(reg.json));

  // The wrong password first: it reaches the same route and must not be a 500, so a 500
  // on the next line is about what happens after the comparison and not about the request.
  const wrong = await call('POST', '/api/auth/login', { username: USER, password: 'nope' });
  ok('a wrong password is 401, not 500', wrong.status === 401, 'status ' + wrong.status);

  const good = await call('POST', '/api/auth/login', { username: USER, password: PASS });
  ok('the right password returns a token',
    good.status === 200 && !!(good.json && good.json.token),
    'status ' + good.status + ' body ' + JSON.stringify(good.json));

  if (good.status !== 200) {
    console.error('\n  server said:\n    ' + log.join('').split('\n')
      .filter((l) => /error|Error|throw|at /.test(l)).slice(-12).map((l) => '    ' + l).join('\n'));
  }

  console.log(failures ? `\n  signin probe FAILED - ${failures} assertion(s)\n`
                       : '\n  signin probe passed\n');
  done(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });