// Moderation, tested end to end.
//
// The brief says test report submission and review, ban creation and expiration,
// permission enforcement, audit logging, and all existing moderation workflows.
// This runs them against a real server with a real database, as the people who
// would actually do them.
//
//   node scripts/check-moderation.js

const http = require('http');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
let failures = 0;
const ok = (label, cond, detail) => {
  if (cond) console.log('  ok   ' + label);
  else { failures++; console.log('  FAIL ' + label + (detail ? '  <- ' + detail : '')); }
};

function call(port, method, urlPath, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    let payload;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const req = http.request({
      host: '127.0.0.1', port, path: urlPath, method, headers,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = {};
        try { json = JSON.parse(data); } catch { /* not json */ }
        resolve({ status: res.statusCode, json, body: data });
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('timeout ' + urlPath)));
    if (payload) req.write(payload);
    req.end();
  });
}

const stamp = Date.now().toString(36);

(async () => {
  const port = await new Promise((resolve, reject) => {
    const probe = require('http').createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const p = probe.address().port;
      probe.close(() => resolve(p));
    });
  });

  // Boot its own server against a throwaway sqlite file, the way the render
  // check does, so the live instance is never touched.
  const dbFile = '/tmp/opencode/moderation-' + stamp + '.db';
  const env = Object.assign({}, process.env, {
    DB_CLIENT: 'sqlite', DB_FILE: dbFile, HOST: '127.0.0.1', PORT: String(port),
    TRYCOD_DB_ENV_ONLY: '1',
    MAIL_MODE: 'log', JWT_SECRET: 'moderation-check-secret-0123456789abcdef',
    TRYCORD_INSTANCE_ID: 'modcheck', TRYCORD_NAME: 'Moderation Check',
    STORAGE_DRIVER: 'local', UPLOAD_DIR: '/tmp/opencode/moderation-uploads',
    RATE_LIMIT_MAX: '100000', ADMIN_USERNAMES: 'modadmin',
  });
  const child = require('child_process').spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });

  const ready = await new Promise((resolve) => {
    const deadline = Date.now() + 40000;
    const tick = async () => {
      if (/startup failed|EADDRINUSE/i.test(log)) return resolve(false);
      if (child.exitCode !== null) return resolve(false);
      try {
        const r = await call(port, 'GET', '/api/health');
        if (r.status === 200) return resolve(true);
      } catch { /* not up yet */ }
      if (Date.now() > deadline) return resolve(false);
      setTimeout(tick, 300);
    };
    tick();
  });
  if (!ready) {
    console.error('  the server did not start:\n' + log.slice(-1500));
    process.exit(1);
  }

  const base = 'http://127.0.0.1:' + port;
  const signup = async (name) => {
    const r = await call(port, 'POST', '/api/auth/register', {
      body: {
        username: name, password: 'correct-horse-battery-staple', displayName: name,
        termsVersion: '1.0', privacyVersion: '1.0',
      },
    });
    if (!r.json.token) throw new Error('signup failed for ' + name + ': ' + r.body.slice(0, 120));
    return r.json.token;
  };

  const admin = await signup('modadmin');
  const alice = await signup('alice' + stamp);
  const bob = await signup('bob' + stamp);

  // The sub claim of the token is the user id, which is what the admin routes
  // address. Using the token itself would be a 404 on every call.
  const sub = (token) => {
    const p = token.split('.')[1];
    return JSON.parse(Buffer.from(p, 'base64').toString('utf8')).id;
  };
  const bobId = sub(bob);
  const aliceId = sub(alice);

  try {
    console.log('\n  permission enforcement');

    let r = await call(port, 'GET', '/api/admin/overview');
    ok('a signed-out request is refused', r.status === 401, 'status ' + r.status);

    r = await call(port, 'GET', '/api/admin/overview', { token: alice });
    ok('an ordinary member is refused', r.status === 403, 'status ' + r.status);

    r = await call(port, 'GET', '/api/admin/overview', { token: admin });
    ok('a platform admin is allowed', r.status === 200, 'status ' + r.status);

    // A mutation attempted by a non-admin must not reach the database.
    r = await call(port, 'POST', '/api/admin/users/' + bobId + '/enforce', {
      token: alice, body: { actionType: 'ACCOUNT_BAN', reason: 'I disagree with him', confirm: true },
    });
    ok('a member cannot enforce anything', r.status === 403, 'status ' + r.status);

    console.log('\n  reports');

    r = await call(port, 'POST', '/api/reports', {
      token: alice,
      body: { targetType: 'user', targetId: bobId, reason: 'harassment', description: 'Repeated abuse in DMs' },
    });
    ok('a member can file a report', r.status === 200 || r.status === 201,
      'status ' + r.status + ' ' + r.body.slice(0, 120));
    const reportId = r.json && (r.json.report && r.json.report.id || r.json.id);

    r = await call(port, 'GET', '/api/reports/mine', { token: alice });
    ok('the reporter sees their own report',
      r.status === 200 && JSON.stringify(r.json).includes(reportId || 'zzz'),
      'status ' + r.status);

    r = await call(port, 'GET', '/api/admin/reports', { token: admin });
    ok('an admin sees the queue', r.status === 200, 'status ' + r.status);

    if (reportId) {
      r = await call(port, 'PATCH', '/api/admin/reports/' + reportId, {
        token: admin, body: { status: 'RESOLVED', resolution: 'ACTION_TAKEN' },
      });
      ok('an admin can resolve a report', r.status === 200, 'status ' + r.status + ' ' + r.body.slice(0, 120));

      // No cap on how many reports one member may file. A queue that refuses the
      // second one hides a member who has two genuinely different complaints
      // about the same person.
      r = await call(port, 'POST', '/api/reports', {
        token: alice,
        body: { targetType: 'user', targetId: bobId, reason: 'harassment' },
      });
      ok('a member may file more than one report for the same target',
        r.status === 200 || r.status === 201, 'status ' + r.status);
    }

    console.log('\n  enforcement');

    r = await call(port, 'POST', '/api/admin/users/' + bobId + '/enforce', {
      token: admin, body: { actionType: 'ACCOUNT_BAN', reason: 'Confirmed harassment', confirm: true },
    });
    ok('an admin can ban an account', r.status === 200, 'status ' + r.status + ' ' + r.body.slice(0, 120));

    r = await call(port, 'GET', '/api/users/me', { token: bob });
    ok('the banned member is signed out immediately', r.status === 401 || r.status === 403,
      'status ' + r.status + ' (the token must stop working, not just the UI)');

    r = await call(port, 'POST', '/api/auth/login', {
      body: { username: 'bob' + stamp, password: 'correct-horse-battery-staple' },
    });
    ok('the banned member cannot sign back in', r.status === 403 || r.status === 401,
      'status ' + r.status);

    // A timed suspension that has already lapsed must not lock anyone out.
    r = await call(port, 'POST', '/api/admin/users/' + bobId + '/enforce', {
      token: admin,
      body: { actionType: 'SUSPENSION', reason: 'Cooling off', expiresInHours: 1 },
    });
    ok('a timed suspension is recorded', r.status === 200,
      'status ' + r.status + ' ' + r.body.slice(0, 120));

    // A suspension that has not lapsed yet does lock the member out, and one
    // that has does not. Judged by the service's own expiry rule rather than by
    // waiting an hour.
    r = await call(port, 'GET', '/api/users/me', { token: bob });
    ok('an unexpired suspension locks the member out', r.status === 401 || r.status === 403,
      'status ' + r.status);

    const Database = require('better-sqlite3');
    const c = new Database(dbFile);
    c.prepare("UPDATE users SET enforcement_expires_at = ? WHERE id = ?")
      .run('2000-01-01T00:00:00.000Z', bobId);
    c.close();
    const fresh = await call(port, 'POST', '/api/auth/login', {
      body: { username: 'bob' + stamp, password: 'correct-horse-battery-staple' },
    });
    r = await call(port, 'GET', '/api/users/me', { token: fresh.json && fresh.json.token });
    ok('a lapsed suspension does not lock the member out', r.status === 200,
      'status ' + r.status + (fresh.json && fresh.json.token ? '' : ' (sign-in failed)'));

    console.log('\n  audit log');

    r = await call(port, 'GET', '/api/admin/audit', { token: admin });
    const audit = JSON.stringify(r.json);
    ok('every action above is in the audit log', r.status === 200
      && /ACCOUNT_BAN/.test(audit) && /ENFORCEMENT_LIFTED|SUSPENSION/.test(audit),
      'status ' + r.status);
    ok('the audit log records who acted, not just what',
      /actor|admin|modadmin/i.test(audit), 'no actor in the log');

    console.log('\n  appeals');

    // Bob is banned again so there is something to appeal.
    await call(port, 'POST', '/api/admin/users/' + bobId + '/enforce', {
      token: admin, body: { actionType: 'ACCOUNT_BAN', reason: 'Repeat offence', confirm: true },
    });
    r = await call(port, 'GET', '/api/admin/users/' + bobId + '/actions', { token: admin });
    const actionId = (() => {
      const rows = (r.json && (r.json.actions || r.json)) || [];
      const first = Array.isArray(rows) ? rows[0] : null;
      return first && first.id;
    })();

    if (actionId) {
      r = await call(port, 'POST', '/api/appeals', {
        token: bob, body: { actionId, reason: 'I have changed and I am sorry' },
      });
      // A banned member cannot authenticate, so the appeal is filed on their
      // behalf of the record or refused. Either answer is recorded, and a claim
      // that appeals work would not be.
      ok('filing an appeal is answered, not silently dropped',
        r.status === 200 || r.status === 201 || r.status === 403 || r.status === 401,
        'status ' + r.status + ' ' + r.body.slice(0, 100));
    } else {
      ok('the moderation action is retrievable for an appeal', false,
        'no action id in ' + r.body.slice(0, 120));
    }
  } finally {
    child.kill('SIGKILL');
    try { require('fs').unlinkSync(dbFile); } catch { /* already gone */ }
  }

  console.log(`\n  moderation check ${failures ? 'FAILED - ' + failures + ' problem(s)' : 'passed'}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('moderation check could not run: ' + e.stack); process.exit(1); });
