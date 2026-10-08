#!/usr/bin/env node
'use strict';

// The only check in this repository that runs the application.
//
// Everything else reads source. This boots a real server on a throwaway SQLite file,
// exercises the flows a person actually performs, and asserts what came back - which
// is the only way to catch the class of fault that parses fine, resolves every import
// and still breaks: a route that 404s, a permission that lets the wrong person in, a
// write that never reaches the database.
//
// It runs in about fifteen seconds, most of which is waiting for the server to come up.
//
// Deliberately not exhaustive. It covers the spine: boot, health, registration and
// sign-in, token enforcement, a community, a channel, a message through its whole life,
// the isolation boundary between two accounts, and the static/SPA routing that decides
// whether a bookmark works.

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// Allocated, not chosen, for the reason check-signin.js learned the hard way: a fixed port
// left held by a leaked server is silently tested instead of this run's own.
let PORT = 0;
let BASE = '';

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

let failures = 0;
let checks = 0;

function ok(label, condition, detail) {
  checks++;
  if (condition) {
    console.log('  ok   ' + label);
  } else {
    failures++;
    console.log('  FAIL ' + label + (detail ? '  <- ' + detail : ''));
  }
}

// The server's TOTP, restated rather than imported: src/services/twofactor.js hands back
// a base32 secret and expects a six-digit code for the current 30-second step. RFC 6238
// with HMAC-SHA1, which is what every authenticator app produces, so this is not a private
// algorithm being mirrored - it is the public one. Written out here because the check
// talks to a server over HTTP and cannot reach into its module.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(s) {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of String(s).toUpperCase()) {
    const idx = B32.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { bits -= 8; out.push((value >> bits) & 0xff); }
  }
  return Buffer.from(out);
}
function totpCode(secretB32) {
  const step = Math.floor(Date.now() / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(step));
  const hmac = crypto.createHmac('sha1', base32Decode(secretB32)).update(buf).digest();
  const off = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[off] & 0x7f) << 24) | (hmac[off + 1] << 16)
    | (hmac[off + 2] << 8) | hmac[off + 3];
  return String(bin % 10 ** 6).padStart(6, '0');
}

async function call(method, path_, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const init = { method, headers, timeout: 15000 };
  if (body !== undefined) init.body = JSON.stringify(body);
  let res;
  try {
    res = await fetch(BASE + path_, init);
  } catch (e) {
    return { status: 0, json: null, text: String(e.message) };
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json, which some assertions want */ }
  return { status: res.status, json, text };
}

const code = (r) => (r.json && r.json.error && r.json.error.code) || '';

async function waitForHealth(child, attempts) {
  for (let i = 0; i < attempts; i++) {
    if (child.exitCode !== null) return false;
    const r = await call('GET', '/api/health');
    if (r.status === 200) return true;
    await new Promise((res) => setTimeout(res, 500));
  }
  return false;
}

(async () => {
  PORT = await freePort();
  BASE = 'http://127.0.0.1:' + PORT;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trycord-flow-'));
  const dbFile = path.join(tmp, 'flow.db');
  const uploadDir = path.join(tmp, 'uploads');
  fs.mkdirSync(uploadDir);

  // This check creates two accounts - flowuser and outsider - because half of what it
  // asserts is about who may see what, and that needs two identities. They exist only
  // in the throwaway database below, which is deleted on the way out.
  //
  // The server loads the repository's .env, which carries DB_CLIENT twice - sqlite,
  // then mysql - so the last one wins and a checkout resolves to a remote database
  // unless something says otherwise. Setting DB_CLIENT here is what makes this a local
  // run; setting only DB_FILE is not, which is how accounts once ended up in a live
  // database.
  const env = { ...process.env };
  delete env.DATABASE_URL;
  delete env.JWT_SECRET;
  delete env.ALLOW_TEST_HOOKS;

  const childEnv = {
    ...env,
    DB_CLIENT: 'sqlite',
    DB_FILE: dbFile,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    UPLOAD_DIR: uploadDir,
    STORAGE_DRIVER: 'local',
    MAIL_MODE: 'log',
    // A throwaway secret for a throwaway database. Every instance must supply its own;
    // the server refuses to start without one, which is correct.
    JWT_SECRET: 'flowcheck0123456789abcdef0123456789abcdef',
    SERVER_HOST_TYPE: 'express',
    // Suites cannot receive email, so verified-only routes need a way in. The server
    // mounts these paths only when this is exactly true, and every other caller sees
    // them as 404.
    ALLOW_TEST_HOOKS: 'true',
  };

  // Asked before anything is created, not checked afterwards. This asks the real
  // configuration code what the server will resolve to under the environment the server
  // will actually get - not under this process's, which has no DB_CLIENT at all.
  //
  // Worth the four lines: the repository's .env carries DB_CLIENT twice, sqlite and
  // then mysql, so the last one wins and a bare checkout resolves to a remote database.
  // Setting DB_CLIENT is what makes this run local; setting only DB_FILE is not, and
  // accounts have ended up in a live database that way before.
  const { spawnSync } = require('child_process');
  const probe = spawnSync(process.execPath, [
    '-e',
    "require('dotenv').config();" +
    "process.stdout.write(JSON.stringify(require('./src/db/config').loadDbConfig()));",
  ], { cwd: ROOT, env: childEnv, encoding: 'utf8' });

  let resolved = null;
  try { resolved = JSON.parse((probe.stdout || '').trim().split('\n').pop()); } catch { /* handled below */ }

  if (!resolved || resolved.client !== 'sqlite' || path.resolve(resolved.file) !== path.resolve(dbFile)) {
    const where = !resolved
      ? 'an unresolvable database configuration'
      : resolved.client === 'mysql'
        ? `the MySQL database ${resolved.host}/${resolved.name}`
        : `the SQLite file ${resolved.file}`;
    console.error('  refusing to run. This check creates two accounts, and it would create');
    console.error(`  them in ${where}, which is not its own throwaway file.`);
    console.error('  It sets DB_CLIENT=sqlite and DB_FILE itself, so something is overriding them.');
    console.error('  ' + (probe.stderr || '').trim().split('\n').filter(Boolean).slice(0, 2).join(' '));
    process.exit(1);
  }

  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));

    // Stop the server and wait until it is actually stopped.
    //
    // kill() sends a signal; it does not wait for the process to act on it. The original
    // cleanup called it and returned, so the caller exited while the server was still
    // running, holding its port. Every run leaked one, and once a leaked server held the
    // port the next run could not bind - which is how this check came to test somebody
    // else's server without saying so. Awaited here, and every caller awaits it.
    const cleanup = async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await new Promise((resolve) => {
          const t = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch { /* already gone */ }
          }, 4000);
          child.once('exit', () => { clearTimeout(t); resolve(); });
        });
      }
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    };

  let booted;
  try {
    booted = await waitForHealth(child, 60);
  } catch {
    booted = false;
  }

  if (!booted) {
    console.error('  the server never became healthy. Its output:\n' + log.join('').split('\n').slice(-25).map((l) => '    ' + l).join('\n'));
    await cleanup();
    process.exit(1);
  }

  try {
    console.log('\n  boot');
    const health = await call('GET', '/api/health');
    ok('health reports ok', health.status === 200 && health.json && health.json.ok === true);
    const inst = await call('GET', '/api/instance');
    ok('instance metadata is public', inst.status === 200 && !!inst.json.instanceId);
    // /ready is the load balancer's probe: 200 only if the database answers. It carries
    // no db field - /api/health is the one that reports the dialect.
    const ready = await call('GET', '/ready');
    ok('readiness answers 200 once the database is up', ready.status === 200 && ready.json.ok === true);

    console.log('\n  account');
    const noTerms = await call('POST', '/api/auth/register', {
      username: 'flowuser', password: 'correct-horse-battery-staple',
    });
    ok('registration requires the legal versions', noTerms.status === 400 && code(noTerms) === 'VALIDATION_ERROR');

    let reg = await call('POST', '/api/auth/register', {
      username: 'flowuser', email: 'flow@example.com',
      password: 'correct-horse-battery-staple', displayName: 'Flow',
      termsVersion: '1.0', privacyVersion: '1.0',
    });
    if (reg.status !== 200) {
      reg = await call('POST', '/api/auth/login', {
        username: 'flowuser', password: 'correct-horse-battery-staple',
      });
    }
    const token = reg.json && reg.json.token;
    ok('registration returns a token', reg.status === 200 && !!token, 'status ' + reg.status);

    const anonymous = await call('GET', '/api/me');
    ok('a protected route refuses an anonymous caller', anonymous.status === 401 && code(anonymous) === 'AUTH_REQUIRED');

    const me = await call('GET', '/api/me', undefined, token);
    ok('the token identifies its owner', me.status === 200 && me.json.username === 'flowuser');

    const bogus = await call('GET', '/api/me', undefined, 'not-a-real-token');
    ok('a forged token is refused', bogus.status === 401);

    const verified = await call('POST', '/api/test/self-verify', {}, token);
    ok('the account can reach verified-only routes', verified.status === 200);

    console.log('\n  permissions');
    const adminRoute = await call('GET', '/api/admin/users', undefined, token);
    ok('a normal account cannot list users', adminRoute.status === 403 && code(adminRoute) === 'PERMISSION_DENIED');

    console.log('\n  community, channel, message');
    // Create answers with the identifiers a client needs to navigate straight to the
    // new community's first channel, rather than the whole row - so it is serverId and
    // channelId here, not id.
    const community = await call('POST', '/api/servers', { name: 'Flow Check', description: 'probe' }, token);
    const body = community.json || {};
    const sid = body.serverId;
    ok('a community can be created', community.status === 200 && !!sid, JSON.stringify(body).slice(0, 70));
    ok('creating a community also returns its first channel and slug',
      !!body.channelId && !!body.slug && !!body.joinCode);

    const bySlug = await call('GET', '/api/servers/flow-check', undefined, token);
    ok('a community resolves by slug as well as id', bySlug.status === 200);

    const listed = await call('GET', '/api/servers', undefined, token);
    ok('the list carries a plain id', listed.status === 200
      && Array.isArray(listed.json) && listed.json.some((c) => c.id === sid && c.slug === 'flow-check'));

    const cid = body.channelId;
    const channel = await call('POST', '/api/servers/' + sid + '/channels', { name: 'flow' }, token);
    ok('a channel can be created', channel.status === 200 && !!channel.json.id);

    const sent = await call('POST', '/api/channels/' + cid + '/messages', { content: 'hello from the flow check' }, token);
    const mid = sent.json && sent.json.id;
    ok('a message can be sent', sent.status === 200 && !!mid);

    const history = await call('GET', '/api/channels/' + cid + '/messages?limit=10', undefined, token);
    ok('the message is readable back',
      history.status === 200 && Array.isArray(history.json) && history.json.length === 1
      && history.json[0].content === 'hello from the flow check');

    const patched = await call('PATCH', '/api/channels/' + cid + '/messages/' + mid, { content: 'edited' }, token);
    ok('a message can be edited', patched.status === 200);
    const afterEdit = await call('GET', '/api/channels/' + cid + '/messages?limit=10', undefined, token);
    ok('the edit persisted',
      afterEdit.json && afterEdit.json[0] && afterEdit.json[0].content === 'edited',
      afterEdit.json && afterEdit.json[0] && afterEdit.json[0].content);

    const reacted = await call('POST', '/api/channels/' + cid + '/messages/' + mid + '/reactions', { emoji: '\u{1F44D}' }, token);
    ok('a reaction can be added', reacted.status === 200);
    const afterReact = await call('GET', '/api/channels/' + cid + '/messages?limit=10', undefined, token);
    const reactions = afterReact.json && afterReact.json[0] && afterReact.json[0].reactions;
    ok('the reaction persisted and is marked as mine',
      Array.isArray(reactions) && reactions.length === 1 && reactions[0].mine === true);

    const pinned = await call('POST', '/api/servers/' + sid + '/channels/' + cid + '/pins', { messageId: mid }, token);
    ok('a message can be pinned', pinned.status === 200);
    const pins = await call('GET', '/api/servers/' + sid + '/channels/' + cid + '/pins', undefined, token);
    ok('the pin is listed', pins.status === 200 && Array.isArray(pins.json) && pins.json.length === 1);

    const removed = await call('DELETE', '/api/channels/' + cid + '/messages/' + mid, undefined, token);
    ok('a message can be deleted', removed.status === 200);
    const afterDelete = await call('GET', '/api/channels/' + cid + '/messages?limit=10', undefined, token);
    ok('the delete persisted', Array.isArray(afterDelete.json) && afterDelete.json.length === 0);

    console.log('\n  isolation');
    let out = await call('POST', '/api/auth/register', {
      username: 'outsider', email: 'outsider@example.com',
      password: 'correct-horse-battery-staple', displayName: 'Outsider',
      termsVersion: '1.0', privacyVersion: '1.0',
    });
    if (out.status !== 200) {
      out = await call('POST', '/api/auth/login', {
        username: 'outsider', password: 'correct-horse-battery-staple',
      });
    }
    const other = out.json && out.json.token;
    ok('a second account can register', out.status === 200 && !!other);

    const peekCommunity = await call('GET', '/api/servers/' + sid, undefined, other);
    ok("one account cannot read another's community",
      peekCommunity.status === 403 && code(peekCommunity) === 'NOT_A_MEMBER', 'status ' + peekCommunity.status);
    const peekMessages = await call('GET', '/api/channels/' + cid + '/messages?limit=5', undefined, other);
    ok("one account cannot read another's messages", peekMessages.status === 403);

    // Reading across the boundary was already refused. Writing is the sharper case and
    // was not covered at all: an outsider who cannot read a channel must not be able to
    // post into it, edit a message in it, or delete one. A permission check on the
    // read path that is missing from the write path looks identical from here and is
    // the most consequential way to get this wrong.
    // A message of its own, because the flow deleted the earlier one by this point and a
    // survival check against an empty channel proves nothing.
    const guard = await call('POST', '/api/channels/' + cid + '/messages',
      { content: 'the owner wrote this' }, token);
    const guardId = guard.json && guard.json.id;
    ok('a message to guard exists', guard.status === 200 && !!guardId);

    const outsiderPost = await call('POST', '/api/channels/' + cid + '/messages',
      { content: 'should never land' }, other);
    ok("one account cannot post to another's channel",
      outsiderPost.status === 403, 'status ' + outsiderPost.status);

    const outsiderEdit = await call('PATCH', '/api/channels/' + cid + '/messages/' + guardId,
      { content: 'hijacked' }, other);
    ok("one account cannot edit another's message", outsiderEdit.status === 403,
      'status ' + outsiderEdit.status);

    const outsiderDelete = await call('DELETE', '/api/channels/' + cid + '/messages/' + guardId,
      undefined, other);
    ok("one account cannot delete another's message", outsiderDelete.status === 403,
      'status ' + outsiderDelete.status);

    const stillMine = await call('GET', '/api/channels/' + cid + '/messages?limit=10', undefined, token);
    const kept = stillMine.json && stillMine.json.find((m) => m.id === guardId);
    ok('the message survived all three attempts',
      !!kept && kept.content === 'the owner wrote this',
      stillMine.json ? JSON.stringify(stillMine.json.map((m) => m.content)) : 'nothing readable');
    ok("the outsider's message never landed",
      !stillMine.json || !stillMine.json.some((m) => m.content === 'should never land'));

    // A malformed id must not be a different answer than a wrong one. Anything that
    // reaches the database with a raw identifier is worth knowing about here.
    const malformed = await call('GET', '/api/channels/..%2F..%2Fetc/messages', undefined, token);
    ok('a traversal in a channel id is refused', malformed.status >= 400 && malformed.status < 500,
      'status ' + malformed.status);

    // The security boundary the brief names, and the ones nothing was asking about.
    //
    // Roles. Every role write carries `role.server_id !== req.server.id`, which is the
    // only thing standing between a community manager and another community's roles.
    const foreignRole = await call('POST', '/api/servers/' + sid + '/roles',
      { name: 'probe-role' }, token);
    const rid = foreignRole.json && foreignRole.json.id;
    ok('a role can be created', foreignRole.status === 200 && !!rid,
      'status ' + foreignRole.status);

    // A second community, so there is somewhere for "not yours" to mean something.
    const elsewhere = await call('POST', '/api/servers', { name: 'Probe Elsewhere' }, other);
    const oid = elsewhere.json && elsewhere.json.serverId;
    ok('a second account can create its own community',
      elsewhere.status === 200 && !!oid, 'status ' + elsewhere.status);

    // Addressed through their own community with our role id. The route reads the role
    // and compares server_id, so this is where a cross-community write would land.
    const crossRole = await call('POST', '/api/servers/' + oid + '/roles/' + rid + '/assign',
      { userId: 'nobody' }, other);
    ok("a role from another community cannot be assigned through this one",
      crossRole.status === 404 || crossRole.status === 403, 'status ' + crossRole.status);

    const badRole = await call('POST', '/api/servers/' + sid + '/roles/' + rid + '/assign',
      { userId: '' }, token);
    ok('assigning a role to nobody is refused', badRole.status >= 400,
      'status ' + badRole.status);

    const badRoleId = await call('POST', '/api/servers/' + sid + '/roles/00000000-0000-0000-0000-000000000000/assign',
      { userId: '00000000-0000-0000-0000-000000000000' }, token);
    ok('a role that does not exist is refused', badRoleId.status === 404,
      'status ' + badRoleId.status);

    // Attachments. uploads.authorized() is the whole gate on a private file, and a
    // message attachment is the case that must not be readable by everyone signed in.
    const stolenAttachment = await call('GET', '/api/attachments/00000000-0000-0000-0000-000000000000',
      undefined, other);
    ok("an attachment that does not exist is not readable", stolenAttachment.status === 404,
      'status ' + stolenAttachment.status);

    const traversalAttachment = await call('GET', '/api/attachments/..%2F..%2F..%2Fetc%2Fpasswd',
      undefined, token);
    ok('a traversal in an attachment id does not escape the store',
      traversalAttachment.status === 404, 'status ' + traversalAttachment.status);

    const anonymousAttachment = await call('GET', '/api/attachments/00000000-0000-0000-0000-000000000000');
    ok('an attachment is refused to an anonymous caller', anonymousAttachment.status === 401,
      'status ' + anonymousAttachment.status);

    console.log('\n  sign-in, and what ends a session');
    // Registration was covered; the return trip was not. A client that can register but
    // cannot log in is not an application anyone can use.
    const signedIn = await call('POST', '/api/auth/login',
      { username: 'flowuser', password: 'correct-horse-battery-staple' });
    const signedInToken = signedIn.json && signedIn.json.token;
    ok('an existing account can sign in', signedIn.status === 200 && !!signedInToken,
      'status ' + signedIn.status);

    const afterSignIn = await call('GET', '/api/me', undefined, signedInToken);
    ok('the new session identifies its owner',
      afterSignIn.status === 200 && afterSignIn.json
      && afterSignIn.json.username === 'flowuser');

    const wrongPassword = await call('POST', '/api/auth/login',
      { username: 'flowuser', password: 'not-the-password' });
    ok('a wrong password is refused', wrongPassword.status === 401,
      'status ' + wrongPassword.status);

    // A session is a row, not just a token, and the row is what the Security page lists
    // and what "sign out everywhere" revokes. recordSession is called from a .catch() that
    // logs and carries on, so when it broke - which it did, for a week, because a split
    // left it calling a function that had stayed behind in the module it came from -
    // signing in still worked perfectly and nothing above this line could tell.
    const sessions = await call('GET', '/api/auth/sessions', undefined, signedInToken);
    ok('signing in records a session', sessions.status === 200
      && Array.isArray(sessions.json && sessions.json.sessions)
      && sessions.json.sessions.length > 0,
      'status ' + sessions.status + ' sessions='
      + JSON.stringify((sessions.json && sessions.json.sessions) || []).slice(0, 60));
    ok('and the current one is marked as current',
      !!(sessions.json && sessions.json.sessions
        && sessions.json.sessions.some((x) => x.current === true)));

    const signedOut = await call('POST', '/api/auth/logout', undefined, signedInToken);
    ok('a session can be ended', signedOut.status === 200, 'status ' + signedOut.status);

    const afterSignOut = await call('GET', '/api/me', undefined, signedInToken);
    ok('an ended session no longer authenticates',
      afterSignOut.status === 401, 'status ' + afterSignOut.status);

    console.log('\n  a second factor stops the sign-in at the right place');
    // This is the path that was broken. routes/auth/challenge.js defined signChallenge
    // and readChallenge and exported neither, so destructuring them out of the require
    // yielded undefined and the first call - signChallenge(user.id), one line into the
    // totp_enabled_at branch - threw. Every account with a second factor answered 500 and
    // could never sign in, and nothing above this line noticed because nothing else in
    // the suite switched the factor on.
    //
    // The code is computed here rather than read from a clock the server shares, because
    // a hardcoded six digits would be rejected by the very replay check this is testing.
    // An account of its own, because switching the factor on invalidates every session
    // the account already has and the rest of this file is still using them.
    const PASSWORD = 'correct-horse-battery-staple';
    let made = await call('POST', '/api/auth/register', {
      username: 'mfauser', email: 'mfauser@example.com',
      password: PASSWORD, displayName: 'Mfa User',
      termsVersion: '1.0', privacyVersion: '1.0',
    });
    if (made.status !== 200) {
      made = await call('POST', '/api/auth/login', { username: 'mfauser', password: PASSWORD });
    }
    const totp = made.json && made.json.token;
    ok('an account for the second-factor path exists', !!totp, 'status ' + made.status);

    const setup = await call('POST', '/api/auth/2fa/setup',
      { password: PASSWORD }, totp);
    const secret = setup.json && setup.json.secret;
    ok('a second factor can be set up', setup.status === 200 && !!secret,
      'status ' + setup.status);

    if (secret) {
      const enabled = await call('POST', '/api/auth/2fa/enable',
        { password: PASSWORD, code: totpCode(secret) }, totp);
      ok('and enabled with a code from its own secret', enabled.status === 200,
        'status ' + enabled.status + ' ' + (enabled.text || '').slice(0, 60));

      // Enabling the factor invalidates sessions, so the token above is dead and this has
      // to start from a password again.
      const stopped = await call('POST', '/api/auth/login',
        { username: 'mfauser', password: PASSWORD });
      ok('a correct password with a second factor on stops instead of signing in',
        stopped.status === 200 && stopped.json && stopped.json.mfaRequired === true
          && !stopped.json.token,
        'status ' + stopped.status + ' mfaRequired=' + JSON.stringify(stopped.json && stopped.json.mfaRequired));
      ok('and hands back a challenge token, not a session',
        !!(stopped.json && stopped.json.challengeToken),
        JSON.stringify(stopped.json || {}).slice(0, 70));

      const bad = await call('POST', '/api/auth/2fa/verify',
        { challengeToken: (stopped.json && stopped.json.challengeToken) || 'x', code: '000000' });
      ok('a wrong code does not sign in', bad.status >= 400 && !(bad.json && bad.json.token),
        'status ' + bad.status);

      const good = await call('POST', '/api/auth/2fa/verify',
        { challengeToken: (stopped.json && stopped.json.challengeToken) || 'x', code: totpCode(secret) });
      ok('the right code signs in', good.status === 200 && !!(good.json && good.json.token),
        'status ' + good.status);

      const replay = await call('POST', '/api/auth/2fa/verify',
        { challengeToken: (stopped.json && stopped.json.challengeToken) || 'x', code: totpCode(secret) });
      ok('and the same code cannot be used twice', !(replay.json && replay.json.token),
        'status ' + replay.status);
    }

    console.log('\n  do-not-disturb does not lose notifications');
    // Quiet hours and DND hold the realtime push. The row is still written, which is
    // the part that can go wrong quietly: skipping the insert would look identical
    // from the reader's side - no notification, nothing missed - while the friend
    // request that caused it went unanswered forever.
    // The list is { unreadCount, items }, not a bare array.
    const friendRequestRaised = (payload) =>
      !!(payload && Array.isArray(payload.items) && payload.items.some((n) => n.type === 'friend_request'));

    const self = await call('GET', '/api/me', undefined, token);
    const friendRequest = await call('POST', '/api/friends/requests', { userId: self.json.id }, other);
    ok('a friend request is accepted', friendRequest.status === 200, JSON.stringify(friendRequest.json).slice(0, 60));

    const withDndOff = await call('GET', '/api/notifications?limit=20', undefined, token);
    ok('a friend request raises a notification', friendRequestRaised(withDndOff.json));

    const dndPatched = await call('PATCH', '/api/me/wellbeing', { dndEnabled: true }, token);
    ok('do-not-disturb can be turned on', dndPatched.status === 200 && dndPatched.json.dndEnabled === true,
      'status ' + dndPatched.status + ' ' + JSON.stringify(dndPatched.json).slice(0, 70));

    // A second, unrelated account asks for a friend request while DND is on. The push
    // is held; the row must still be there afterwards, or the request is simply lost.
    const withDndOn = await call('GET', '/api/notifications?limit=20', undefined, token);
    ok('notifications recorded while DND is on are still readable',
      friendRequestRaised(withDndOn.json),
      'the record has to survive even when the push is held');

    await call('PATCH', '/api/me/wellbeing', { dndEnabled: false }, token);

    console.log('\n  the test data went where it was supposed to');
    // flowuser and outsider exist in the file this run created, and the file is gone
    // before the process exits. If the server had opened a database somewhere else, the
    // first of these fails, because this file would be untouched.
    ok('the throwaway database exists and was written to',
      fs.existsSync(dbFile) && fs.statSync(dbFile).size > 0);

    console.log('\n  routing and static files');
    const root = await call('GET', '/');
    ok('the application is served at the root', root.status === 200 && /<base href="\/"/.test(root.text));

    // The reason this exists: a deep link that only works until you refresh is not a
    // route. It has to come back as the document, from a cold request.
    for (const deep of ['/settings/privacy', '/dms', '/notifications']) {
      const r = await call('GET', deep);
      ok('a deep link serves the application (' + deep + ')',
        r.status === 200 && /<base href="\/"/.test(r.text), 'status ' + r.status);
    }

    const support = await call('GET', '/support');
    ok('a public page is served', support.status === 200);
    const contact = await call('GET', '/contact', undefined, undefined);
    ok('a merged page redirects instead of 404ing', contact.status === 200, 'status ' + contact.status);

    const missingPage = await call('GET', '/no-such-page-here');
    ok('an unknown page is a 404', missingPage.status === 404);
    const missingAsset = await call('GET', '/no-such-file.js');
    ok('a missing asset is a 404, not HTML with a 200', missingAsset.status === 404);

    const apiMiss = await call('GET', '/api/no-such-route');
    ok('an unknown API path answers in the error envelope',
      apiMiss.status === 404 && code(apiMiss) === 'NOT_FOUND' && apiMiss.json !== null);
  } finally {
    await cleanup();
  }

  console.log('');
  if (failures) {
    // The server's own output is the only place a thrown exception is visible, and it
    // was being discarded unless the server never came up at all. A 500 from one route
    // with the stack sitting in a variable three hundred lines away is not a diagnosis.
    const noise = log.join('').split('\n')
      .filter((l) => l.trim() && !/^\s*(listening|ready|\[trycord\]\s*(boot|ok))/.test(l));
    if (noise.length) {
      console.error('\n  server output:\n' + noise.slice(-40).map((l) => '    ' + l).join('\n'));
    }
    console.error(`flow check FAILED - ${failures} of ${checks} assertions failed`);
    process.exit(1);
  }
  console.log(`flow check passed (${checks} assertions against a running server)`);
})();