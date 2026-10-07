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
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.SIGNIN_TEST_PORT || 9988);
const BASE = 'http://127.0.0.1:' + PORT;

const USER = 'signinprobe';
const PASS = 'signin-probe-password';

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
    try { child.kill('SIGTERM'); } catch { /* gone */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    process.exit(code);
  };

  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE + '/api/health')).ok) break; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 250));
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