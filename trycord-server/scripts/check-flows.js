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
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.FLOW_TEST_PORT || 9989);
const BASE = 'http://127.0.0.1:' + PORT;

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trycord-flow-'));
  const dbFile = path.join(tmp, 'flow.db');
  const uploadDir = path.join(tmp, 'uploads');
  fs.mkdirSync(uploadDir);

  // This check creates two accounts - flowuser and outsider - because half of what it
  // asserts is about who may see what, and that needs two identities. They exist only
  // in the throwaway database below, which is deleted on the way out.
  //
  // The server loads the repository's .env, which sets DB_FILE=./dev.db. dotenv does
  // not overwrite a variable that is already set, so the DB_FILE passed below wins -
  // but that is a property of dotenv rather than of this script, so it is checked
  // afterwards instead of assumed. A check that quietly wrote accounts into a
  // developer's real database would be worse than no check at all.
  const env = { ...process.env };
  delete env.DATABASE_URL;
  delete env.JWT_SECRET;
  delete env.ALLOW_TEST_HOOKS;

  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env: {
      ...env,
      DB_CLIENT: 'sqlite',
      DB_FILE: dbFile,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      UPLOAD_DIR: uploadDir,
      STORAGE_DRIVER: 'local',
      MAIL_MODE: 'log',
      // A throwaway secret for a throwaway database. Every instance must supply its
      // own; the server refuses to start without one, which is correct.
      JWT_SECRET: 'flowcheck0123456789abcdef0123456789abcdef',
      SERVER_HOST_TYPE: 'express',
      // Suites cannot receive email, so verified-only routes need a way in. The server
      // mounts these paths only when this is exactly true, and every other caller
      // sees them as 404.
      ALLOW_TEST_HOOKS: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));

  const cleanup = () => {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
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
    cleanup();
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
    cleanup();
  }

  console.log('');
  if (failures) {
    console.error(`flow check FAILED - ${failures} of ${checks} assertions failed`);
    process.exit(1);
  }
  console.log(`flow check passed (${checks} assertions against a running server)`);
})();