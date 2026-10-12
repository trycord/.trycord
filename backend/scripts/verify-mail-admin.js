// Verify the mail admin endpoints a real administrator would use.
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 0;
process.env.JWT_SECRET = 'verify-mail-admin-secret-value-0123456789';

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

(async () => {
  const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'verify-mail-')), 'v.db');
  const port = await freePort();
  const env = {
    ...process.env,
    DB_CLIENT: 'sqlite', DB_FILE: dbFile,
    PORT: String(port), HOST: '127.0.0.1',
    UPLOAD_DIR: path.dirname(dbFile),
    STORAGE_DRIVER: 'local',
    JWT_SECRET: 'verify-mail-admin-secret-value-0123456789',
    SERVER_HOST_TYPE: 'express',
    ALLOW_TEST_HOOKS: 'true',
    ADMIN_USERNAMES: 'mailadmin',
    MAIL_MODE: 'api',
    MAIL_API_ENDPOINT: 'http://127.0.0.1:9/nope',
    MAIL_API_KEY: '',
  };

  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));

  const BASE = 'http://127.0.0.1:' + port;
  let up = false;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) { up = true; break; } } catch { /* not yet */ }
  }
  if (!up) {
    console.error('server never came up. log:\n' + log.join(''));
    child.kill();
    process.exit(1);
  }

  const api = async (method, p, body) => {
    const res = await fetch(BASE + p, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(globalThis.__token ? { Authorization: 'Bearer ' + globalThis.__token } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  let pass = 0, fail = 0;
  const ok = (label, cond, detail) => {
    if (cond) { pass++; console.log('  ok   ' + label + (detail ? ': ' + detail : '')); }
    else { fail++; console.log('  FAIL ' + label + (detail ? '  <- ' + detail : '')); }
  };

  // Register an admin.
  const reg = await api('POST', '/api/auth/register', {
    username: 'mailadmin', email: 'mailadmin@example.com',
    password: 'correct-horse-battery-staple',
    termsVersion: '1.0', privacyVersion: '1.0',
  });
  ok('an administrator can register', reg.status === 200, JSON.stringify(reg.body).slice(0, 120));
  globalThis.__token = reg.body && reg.body.token;
  ok('a token came back', !!globalThis.__token);

  const anon = await fetch(BASE + '/api/admin/mail').then((r) => r.status);
  ok('the mail console refuses an anonymous caller', anon === 401, 'status ' + anon);

  const list = await api('GET', '/api/admin/mail');
  ok('the configured catalogue is served', list.status === 200 && list.body.modes.length === 3,
    JSON.stringify(list.body.modes));
  ok('the current mode is reported', list.body.current === 'api', list.body.current);
  ok('three providers are offered', list.body.providers.length === 3,
    list.body.providers.map((p) => p.mode).join(','));
  ok('the catalogue names no vendor',
    !/deomail|sendgrid|mailgun/i.test(JSON.stringify(list.body.providers)));
  ok('the api provider declares which credential it needs',
    list.body.providers.find((p) => p.mode === 'api').secrets.includes('mail.apiKey'));
  ok('the status reports whether it is ready', typeof list.body.status.ready === 'boolean');

  const validate = await api('POST', '/api/admin/mail/validate');
  ok('validation runs over HTTP', validate.status === 200 && validate.body.ok === false,
    JSON.stringify(validate.body.problems || validate.body).slice(0, 140));

  // Storing a credential, then reading it back as presence only.
  const put = await api('PUT', '/api/admin/mail/secrets/apiKey', { value: 'a-real-looking-key' });
  ok('a credential can be stored', put.status === 200, JSON.stringify(put.body).slice(0, 140));
  ok('the response says only that it is set', put.body.set === true
    && !JSON.stringify(put.body).includes('a-real-looking-key'));
  ok('it is readable, meaning it decrypts', put.body.readable === true);

  const after = await api('GET', '/api/admin/mail');
  const json = JSON.stringify(after.body);
  ok('the catalogue still never carries the credential', !json.includes('a-real-looking-key'));
  ok('the secret now reports as set', json.includes('"set":true'));

  const putBad = await api('PUT', '/api/admin/mail/secrets/nope', { value: 'x' });
  ok('an unknown credential is refused', putBad.status === 404, 'status ' + putBad.status);

  const testSend = await api('POST', '/api/admin/mail/test', { to: 'someone@example.com' });
  ok('a test send reports a failure rather than claiming success', testSend.status === 400,
    JSON.stringify(testSend.body).slice(0, 140));
  const why = String((testSend.body && testSend.body.error && testSend.body.error.message)
    || (testSend.body && testSend.body.error) || '');
  ok('the failure names what went wrong', /could not be reached|answered/i.test(why), why);

  const badAddr = await api('POST', '/api/admin/mail/test', { to: 'not-an-address' });
  ok('a malformed address is refused before anything is sent', badAddr.status === 400);

  const del = await api('DELETE', '/api/admin/mail/secrets/apiKey');
  ok('a credential can be removed', del.status === 200 && del.body.set === false, JSON.stringify(del.body));

  // A second, non-admin account must not reach any of this.
  const reg2 = await api('POST', '/api/auth/register', {
    username: 'ordinary', email: 'ordinary@example.com',
    password: 'correct-horse-battery-staple', termsVersion: '1.0', privacyVersion: '1.0',
  });
  const member = reg2.body && reg2.body.token;
  const memberList = await fetch(BASE + '/api/admin/mail', {
    headers: { Authorization: 'Bearer ' + member },
  }).then((r) => r.status);
  ok('an ordinary member is refused', memberList === 403 || memberList === 404, 'status ' + memberList);

  child.kill();
  console.log('\n  ' + (fail ? 'FAILED - ' + fail + ' of ' + (pass + fail) : 'passed - ' + pass)
    + ' assertion(s)\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
