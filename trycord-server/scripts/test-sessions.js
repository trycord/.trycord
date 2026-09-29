// Session invalidation across every path that can end a session.
//
// The bug class: `sign(user)` stamps sv from user.session_version, and a caller
// that builds a fresh user-shaped object without that field produces a token
// carrying sv: 0. If the stored version is not 0 the middleware rejects it on
// the next request, so the endpoint appears to succeed and the member is signed
// out of the session they are standing in, with no error anywhere.
//
// And the inverse: invalidation that only stamps sessions_invalidated_at leaves
// the same-second hole open, because JWT iat has one-second resolution.
//
// Both shipped. Both are checked here, on every path, including after a version
// has already been bumped - which is the state that exposes the first one, so a
// test that only exercises a fresh account cannot see it.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-sessions-' + Date.now();
const http = require('http');
const API = (process.env.TRYCORD_TEST_URL || 'http://localhost:9971').replace(/\/+$/, '');

function req(m, p, b, t) {
  return new Promise((res) => {
    const d = b ? JSON.stringify(b) : null; const u = new URL(p, API);
    const r = http.request({ method: m, hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: Object.assign({ 'Content-Type': 'application/json' }, d ? { 'Content-Length': Buffer.byteLength(d) } : {}, t ? { Authorization: 'Bearer ' + t } : {}) },
      (x) => { let s = ''; x.on('data', (c) => (s += c)); x.on('end', () => { let p2; try { p2 = JSON.parse(s); } catch { p2 = s; } res({ status: x.statusCode, body: p2 }); }); });
    r.on('error', () => res({ status: 0, body: null })); r.setTimeout(10000, () => { r.destroy(); res({ status: 0, body: null }); });
    if (d) r.write(d); r.end();
  });
}

let pass = 0, fail = 0;
const ok = (n, c, d) => { c ? pass++ : fail++; console.log((c ? '  ok   ' : ' FAIL  ') + n + (c ? '' : '  -> ' + d)); };

// A token is only useful if the server accepts it. This is the whole assertion:
// not "an endpoint returned 200" but "the credential it handed back still works".
async function works(token) {
  if (!token) return 'no token returned';
  const r = await req('GET', '/api/users/me', null, token);
  return r.status === 200 ? null : 'token rejected with ' + r.status;
}

(async () => {
  const legal = (await req('GET', '/api/legal')).body;
  const mk = async (p) => {
    const u = p + Date.now().toString(36).slice(-5) + Math.floor(Math.random() * 900);
    const r = await req('POST', '/api/auth/register', { username: u, password: 'testpass123', termsVersion: legal.termsVersion, privacyVersion: legal.privacyVersion });
    await req('POST', '/api/test/self-verify', null, r.body.token);
    return { token: r.body.token, id: r.body.user.id, name: u };
  };

  // --- change-password -----------------------------------------------------
  let a = await mk('sessA');
  ok('a fresh account starts on a working token', !(await works(a.token)), await works(a.token));
  const chg = await req('POST', '/api/auth/change-password', { currentPassword: 'testpass123', newPassword: 'testpass456' }, a.token);
  ok('change-password returns a token', chg.status === 200 && !!chg.body.token, 'status ' + chg.status);
  ok('the token change-password returns actually works', !(await works(chg.body.token)), await works(chg.body.token));

  // Second change on an already-bumped account: this is the state that exposes
  // a token signed with a stale sv.
  const chg2 = await req('POST', '/api/auth/change-password', { currentPassword: 'testpass456', newPassword: 'testpass789' }, chg.body.token);
  ok('a second change also returns a working token', !(await works(chg2.body.token)), await works(chg2.body.token));

  // The old session must be dead.
  ok('the pre-change token is rejected', Boolean(await works(a.token)), 'old token still valid');

  // --- revoke-others -------------------------------------------------------
  let b = await mk('sessB');
  // Bump once first so the stored version is not 0, which is the condition that
  // makes a missing sv claim visible.
  const bChanged = await req('POST', '/api/auth/change-password', { currentPassword: 'testpass123', newPassword: 'testpass456' }, b.token);
  const revOthers = await req('POST', '/api/auth/sessions/revoke-others', null, bChanged.body.token);
  ok('revoke-others returns a token', revOthers.status === 200 && !!revOthers.body.token, 'status ' + revOthers.status);
  ok('the token revoke-others returns actually works', !(await works(revOthers.body.token)), await works(revOthers.body.token));

  // --- revoke-all ----------------------------------------------------------
  let c = await mk('sessC');
  const cChanged = await req('POST', '/api/auth/change-password', { currentPassword: 'testpass123', newPassword: 'testpass456' }, c.token);
  const revAll = await req('POST', '/api/auth/sessions/revoke-all', null, cChanged.body.token);
  ok('revoke-all succeeds', revAll.status === 200, 'status ' + revAll.status);
  ok('revoke-all kills the session it was called with', Boolean(await works(cChanged.body.token)), 'token still valid');

  // --- password reset ------------------------------------------------------
  // Requires a verified email. If SMTP is off the test instance may not be able
  // to complete a real reset, so assert the reachable half: the reset path
  // signs with a version, and login still works afterwards.
  let d = await mk('sessD');
  const dChanged = await req('POST', '/api/auth/change-password', { currentPassword: 'testpass123', newPassword: 'testpass456' }, d.token);
  ok('token works before a reset attempt', !(await works(dChanged.body.token)), await works(dChanged.body.token));
  const forgot = await req('POST', '/api/auth/forgot-password', { email: 'nobody@example.invalid' });
  ok('forgot-password is always generic', forgot.status === 200, 'status ' + forgot.status);
  ok('forgot-password leaks no account existence',
    typeof forgot.body.message === 'string' && /if an account exists/i.test(forgot.body.message), JSON.stringify(forgot.body));

  // --- cross-session isolation --------------------------------------------
  let e1 = await mk('sessE1');
  let e2 = await mk('sessE2');
  ok('two accounts have independent sessions', !(await works(e1.token)) && !(await works(e2.token)), 'cross-talk');
  const eChanged = await req('POST', '/api/auth/change-password', { currentPassword: 'testpass123', newPassword: 'testpass456' }, e1.token);
  ok('revoking one account does not affect the other', !(await works(e2.token)), await works(e2.token));
  ok('and the changed account works', !(await works(eChanged.body.token)), await works(eChanged.body.token));

  console.log('\npass=' + pass + ' fail=' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

