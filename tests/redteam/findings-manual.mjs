// Hand re-attempts for REDTEAM-FINDINGS.md items the automated suite does not
// cover: §4 (CSP ?api= reflection + silent repoint), §13 (2FA guess lockout and
// the separate re-confirmation counter), §15 (durable unban audit trail) and §16
// (over-limit uploads refused at the live limit, not a fixed 100 MB, and the
// per-endpoint voice throttles).
//
// The §16 upload memory ceiling is not asserted here - this script does not know
// the server's pid - only the contract it enforces. The by-hand RSS measurement
// lives in REDTEAM-FINDINGS.md.
//
// Run it against a dedicated instance, not one the regression suite has just
// used: the /api/auth endpoints share one rate-limit bucket keyed by
// baseUrl|user|ip, so the suite's auth traffic will starve this script's 2FA
// calls and a correct lockout will read as a RATE_LIMITED response instead.
//
//   cd backend
//   rm -f /tmp/rt-manual.db
//   MAIL_MODE=disabled ALLOW_TEST_HOOKS=true JWT_SECRET=test-secret \
//     DB_CLIENT=sqlite DB_FILE=/tmp/rt-manual.db PORT=18999 \
//     HOST=127.0.0.1 SERVER_HOST_TYPE=express node src/server.js &
//   BASE=http://127.0.0.1:18999 BACKEND=$PWD DB_FILE=/tmp/rt-manual.db \
//     node ../tests/redteam/findings-manual.mjs
//
// §4 and §13 are also exercisable by hand with curl; §15 needs the SQLite file,
// which is why this script opens it read-only through the backend's own driver.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const BACKEND = process.env.BACKEND || '/home/ultim/trycord/.trycord/backend';
const BASE = process.env.BASE || 'http://127.0.0.1:18999';
const DB_FILE = process.env.DB_FILE;
const twofactor = require(BACKEND + '/src/services/twofactor');

let pass = 0, fail = 0;
const t = (n, c, d = '') => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? ' :: ' + d : '')); } };

async function api(method, path, token, body) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

async function reg(prefix) {
  const u = prefix + Math.floor(Math.random() * 1e6);
  const r = await api('POST', '/api/auth/register', null,
    { username: u, password: 'Passw0rd!23', displayName: u, termsVersion: '1.0', privacyVersion: '1.0' });
  if (r.status !== 200) throw new Error('register ' + u + ' -> ' + r.status + ' ' + r.text.slice(0, 150));
  await api('POST', '/api/test/self-verify', r.json.token, {});
  return Object.assign({ username: u }, r.json);
}

// ---- §4 -------------------------------------------------------------------
{
  const r = await api('GET', '/app/?api=https://attacker.example');
  const csp = r.headers.get('content-security-policy') || '';
  t('§4 CSP never reflects the ?api= origin', !csp.includes('attacker.example'), csp.slice(0, 140));
  t('§4 a strict CSP is still emitted', csp.includes("default-src 'self'"), csp.slice(0, 140));
}

// ---- §15 ------------------------------------------------------------------
if (DB_FILE) {
  const a = await reg('v15a_');
  const c = await reg('v15c_');
  const srv = await api('POST', '/api/servers', a.token, { name: 'v15-' + Date.now() });
  if (srv.status !== 200) throw new Error('server create -> ' + srv.status + ' ' + srv.text.slice(0, 150));
  const sid = srv.json.serverId;
  const ban = await api('POST', `/api/servers/${sid}/ban`, a.token, { userId: c.user.id, reason: 'probe ban' });
  t('§15 ban succeeds', ban.status === 200, ban.status + ' ' + ban.text.slice(0, 120));
  const unban = await api('POST', `/api/servers/${sid}/unban`, a.token, { userId: c.user.id, reason: 'probe appeal' });
  t('§15 unban succeeds', unban.status === 200, unban.status + ' ' + unban.text.slice(0, 120));

  const Database = require(BACKEND + '/node_modules/better-sqlite3');
  const db = new Database(DB_FILE, { readonly: true });
  const rows = db.prepare("SELECT action, actor_id, target_id, reason, server_id FROM audit_logs WHERE server_id = ? AND action IN ('member_ban','member_unban') ORDER BY created_at").all(sid);
  t('§15 ban + unban left two durable audit rows', rows.length === 2, JSON.stringify(rows));
  t('§15 the unban row names actor, target and community',
    rows.some((r) => r.action === 'member_unban' && r.actor_id === a.user.id && r.target_id === c.user.id && r.server_id === sid),
    JSON.stringify(rows));
  db.close();
}

// ---- §13 ------------------------------------------------------------------
{
  const c = await reg('v13_');
  const setup = await api('POST', '/api/auth/2fa/setup', c.token, { password: 'Passw0rd!23' });
  t('§13 2FA setup returns a secret', setup.status === 200 && setup.json && setup.json.secret, setup.status + ' ' + setup.text.slice(0, 120));
  const code = twofactor.codeAt(setup.json.secret, twofactor.stepFor());
  const en = await api('POST', '/api/auth/2fa/enable', c.token, { password: 'Passw0rd!23', code });
  t('§13 2FA enable', en.status === 200, en.status + ' ' + en.text.slice(0, 120));

  const login = await api('POST', '/api/auth/login', null, { username: c.username, password: 'Passw0rd!23' });
  t('§13 login stops at the second factor', login.status === 200 && login.json && login.json.mfaRequired && login.json.challengeToken,
    login.status + ' ' + login.text.slice(0, 140));

  const wrong = code === '000000' ? '111111' : '000000';
  let last = { status: 0, json: null };
  for (let i = 0; i < 5; i++) {
    last = await api('POST', '/api/auth/2fa/verify', null, { challengeToken: login.json.challengeToken, code: wrong });
  }
  t('§13 five wrong codes lock the account', last.status === 429 && last.json && last.json.error && last.json.error.code === 'ACCOUNT_LOCKED',
    last.status + ' ' + JSON.stringify(last.json));
  const login2 = await api('POST', '/api/auth/login', null, { username: c.username, password: 'Passw0rd!23' });
  t('§13 the lockout also covers the password step', login2.status === 429, login2.status + ' ' + login2.text.slice(0, 120));
}

// ---- §16 uploads + voice throttles ----------------------------------------
{
  const u = await reg('v16_');
  const srv = await api('POST', '/api/servers', u.token, { name: 'v16-' + Date.now() });
  if (srv.status !== 200) throw new Error('server create -> ' + srv.status + ' ' + srv.text.slice(0, 150));
  const ch = srv.json.channelId;

  // An over-limit upload is refused while it is still being parsed. The refusal
  // names the live setting; before §16 was closed the parser buffered up to a
  // fixed 100 MB before anything checked the live 8 MB.
  const fd = new FormData();
  fd.append('file', new Blob([new Uint8Array(9 * 1024 * 1024)]), 'big.bin');
  const up = await fetch(`${BASE}/api/channels/${ch}/attachments`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + u.token }, body: fd,
  });
  const upText = await up.text();
  t('§16 an over-limit upload is refused at the live limit (413)', up.status === 413, up.status + ' ' + upText.slice(0, 160));
  t('§16 the refusal names the live limit, not a busboy string', /up to \d+ KB/.test(upText), upText.slice(0, 160));

  // The voice probe reaches the provider on every call, so it must be throttled.
  // 30/minute: the 30th is served, the 31st is refused.
  let last = 0;
  for (let i = 0; i < 31; i++) {
    last = (await fetch(`${BASE}/api/voice/capabilities`, { headers: { Authorization: 'Bearer ' + u.token } })).status;
  }
  t('§16 the voice capabilities probe is throttled (31st -> 429)', last === 429, 'last ' + last);
}

console.log(`\nresult: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
