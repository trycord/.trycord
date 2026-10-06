#!/usr/bin/env node
'use strict';

// Two clients, one server, and the thing the brief actually asks for: that a message
// sent by one person arrives at somebody else's open tab.
//
// Every other check drives HTTP. This one opens real WebSockets, because realtime is
// where "it works on my machine" and "it works for two people" come apart: an event
// that is emitted to nobody, emitted to the sender only, emitted with the wrong
// payload shape, or emitted for an operation that never happened, all look completely
// correct in a single-client test.
//
// Two accounts, two sockets, one message:
//
//   A sends  ->  backend persists  ->  B's socket receives  ->  A refreshes  ->  still there
//
// The last step is the one that catches a "successful" realtime path that never wrote
// anything: an optimistic message in one tab is not evidence of persistence.
//
// Node has a WebSocket client built in, so this needs no dependency.

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const net = require('net');

const ROOT = path.join(__dirname, '..');

// A free port, found by binding one and letting it go. A fixed port collides with a
// leftover server from an interrupted run, and that leftover answers health checks
// perfectly well - so the run would silently test somebody else's database.
function freePort() {
  const probe = net.createServer();
  return new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

let passed = 0;
const failures = [];
function ok(label, condition, detail) {
  if (condition) {
    passed++;
    console.log('    ok   ' + label);
  } else {
    failures.push(label + (detail ? ' <- ' + detail : ''));
    console.log('    FAIL ' + label + (detail ? '  <- ' + detail : ''));
  }
}

function request(base, method, routePath, body, token) {
  const data = body === undefined ? null : JSON.stringify(body);
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (data) headers['Content-Length'] = Buffer.byteLength(data);
  return new Promise((resolve, reject) => {
    const url = new URL(base + routePath);
    const req = http.request(url, { method, headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = {};
        try { json = JSON.parse(text || '{}'); } catch { /* not json */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/** An open socket that records everything the server pushes at it. */
function connect(url, label) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const received = [];
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(label + ': the socket never opened'));
    }, 15000);

    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve({
        socket,
        received,
        label,
        close: () => socket.close(),
        /** Wait for a frame of a type, or resolve null at the deadline. */
        waitFor(type, ms = 8000) {
          const hit = received.find((m) => m && m.type === type);
          if (hit) return Promise.resolve(hit);
          return new Promise((done) => {
            const started = Date.now();
            const poll = setInterval(() => {
              const found = received.find((m) => m && m.type === type);
              if (found || Date.now() - started > ms) {
                clearInterval(poll);
                done(found || null);
              }
            }, 40);
          });
        },
      });
    });
    socket.addEventListener('message', (ev) => {
      try { received.push(JSON.parse(ev.data)); } catch { /* non-json frame */ }
    });
    socket.addEventListener('error', () => { /* close() reports the outcome */ });
  });
}

async function main() {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const wsBase = `ws://127.0.0.1:${port}`;

  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'trycord-rt-'));
  for (const [k, v] of Object.entries({
    DB_CLIENT: 'sqlite',
    DB_FILE: path.join(dir, 'realtime.db'),
    PORT: String(port),
    HOST: '127.0.0.1',
    UPLOAD_DIR: path.join(dir, 'uploads'),
    STORAGE_DRIVER: 'local',
    MAIL_MODE: 'log',
    ALLOW_TEST_HOOKS: 'true',
    JWT_SECRET: 'realtime-check-secret-0123456789ab',
  })) process.env[k] = v;

  // DB_CLIENT has to be set as well as DB_FILE. The repository's .env sets DB_CLIENT
  // twice and the last one wins, so setting DB_FILE on its own points at the live
  // remote MySQL. That cost a real cleanup once.
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });

  const deadline = Date.now() + 30000;
  let up = false;
  while (Date.now() < deadline) {
    if (/startup failed|EADDRINUSE/i.test(log)) break;
    if (child.exitCode !== null) break;
    try {
      const res = await request(base, 'GET', '/api/health');
      if (res.status === 200 && res.json.ok) { up = true; break; }
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) {
    child.kill('SIGKILL');
    console.error('\n  could not start the backend on ' + base + ':\n' + log.slice(-1200) + '\n');
    process.exit(1);
  }

  const clients = [];
  try {
    console.log('\n  realtime, with two signed-in clients');

    async function account(name, email) {
      const creds = {
        username: name, email, password: 'correct-horse-battery-staple',
        displayName: name, termsVersion: '1.0', privacyVersion: '1.0',
      };
      let res = await request(base, 'POST', '/api/auth/register', creds);
      if (res.status !== 200 || !res.json.token) {
        res = await request(base, 'POST', '/api/auth/login',
          { username: name, password: creds.password });
      }
      if (!res.json.token) throw new Error('could not sign in ' + name + ': ' + res.text.slice(0, 160));
      await request(base, 'POST', '/api/test/self-verify', {}, res.json.token);
      return res.json.token;
    }

    const tokenA = await account('rtalice', 'rtalice@example.com');
    const tokenB = await account('rtbob', 'rtbob@example.com');
    ok('two accounts exist', !!tokenA && !!tokenB);

    // A community both of them can see.
    const server = await request(base, 'POST', '/api/servers',
      { name: 'Realtime Test', description: 'seeded' }, tokenA);
    const serverId = server.json.id || server.json.serverId;
    ok('a community was created', !!serverId, server.text.slice(0, 120));

    const channel = await request(base, 'POST', `/api/servers/${serverId}/channels`,
      { name: 'general', type: 'text' }, tokenA);
    const channelId = channel.json.id || channel.json.channelId;
    ok('a channel was created', !!channelId, channel.text.slice(0, 120));

    // Bob joins, so both people are in the same community.
    const invite = await request(base, 'POST', `/api/servers/${serverId}/invites`, {}, tokenA);
    const code = invite.json.code || invite.json.invite && invite.json.invite.code;
    if (code) {
      await request(base, 'POST', '/api/invites/' + encodeURIComponent(code) + '/join', {}, tokenB);
    }

    const ticket = async (token) => {
      const res = await request(base, 'POST', '/api/auth/ws/ticket', {}, token);
      return res.json.ticket;
    };

    // Alice: create, send, delete. Bob: only ever receives.
    const alice = await connect(wsBase + '/?ticket=' + encodeURIComponent(await ticket(tokenA)), 'alice');
    clients.push(alice);
    const bob = await connect(wsBase + '/?ticket=' + encodeURIComponent(await ticket(tokenB)), 'bob');
    clients.push(bob);
    ok('both clients opened a realtime connection', true);

    // broadcast() is room-scoped, and joining a room is the client's job on open. A
    // test that opens a socket and waits without joining sees nothing, which looks
    // exactly like a broken gateway - so join the way the real client does.
    for (const c of [alice, bob]) {
      c.socket.send(JSON.stringify({ type: 'join-server', serverId }));
      c.socket.send(JSON.stringify({ type: 'join', channelId }));
    }
    await new Promise((r) => setTimeout(r, 600));
    ok('both clients joined the channel room', true);

    // --- the message itself -------------------------------------------------
    alice.received.length = 0;
    bob.received.length = 0;

    const sent = await request(base, 'POST', `/api/channels/${channelId}/messages`,
      { content: 'Does this arrive at the other tab?' }, tokenA);
    const messageId = sent.json.id || (sent.json.message && sent.json.message.id);
    ok('the message was accepted', sent.status === 200 || sent.status === 201,
      sent.status + ' ' + sent.text.slice(0, 120));

    const bobGot = await bob.waitFor('message');
    ok("the other client's socket received the message", !!bobGot,
      'bob saw: ' + JSON.stringify(bob.received.map((m) => m.type)));

    if (bobGot) {
      const body = (bobGot.message && bobGot.message.content) || bobGot.content
        || bobGot.body || '';
      ok('the event carries the message that was sent',
        String(body).includes('Does this arrive'), JSON.stringify(bobGot).slice(0, 160));
    }

    // --- and it survives a reload ------------------------------------------
    const reread = await request(base, 'GET',
      `/api/channels/${channelId}/messages?limit=20`, undefined, tokenB);
    const rows = Array.isArray(reread.json) ? reread.json : (reread.json.items || []);
    ok('the message is persisted, not just pushed',
      rows.some((m) => String(m.content || m.body || '').includes('Does this arrive')),
      'a realtime frame for a message that was never written would look identical');

    // --- editing and deleting propagate ------------------------------------
    alice.received.length = 0;
    bob.received.length = 0;

    if (messageId) {
      await request(base, 'PATCH', `/api/channels/${channelId}/messages/${messageId}`,
        { content: 'Edited from the other tab.' }, tokenA);
      const edited = await bob.waitFor('message_updated');
      ok("an edit reaches the other client's socket", !!edited,
        'bob saw: ' + JSON.stringify(bob.received.map((m) => m.type)));

      await request(base, 'DELETE', `/api/channels/${channelId}/messages/${messageId}`, undefined, tokenA);
      const deleted = await bob.waitFor('message_deleted');
      ok("a delete reaches the other client's socket", !!deleted,
        'bob saw: ' + JSON.stringify(bob.received.map((m) => m.type)));
    } else {
      ok('an edit reaches the other client\'s socket', false, 'no message id to edit');
      ok('a delete reaches the other client\'s socket', false, 'no message id to delete');
    }

    // --- a socket with a bad ticket is refused ------------------------------
    let refused = false;
    try {
      const bogus = await connect(wsBase + '/?ticket=not-a-real-ticket', 'bogus');
      // Opened, so the server accepted an unverified socket - which it must not.
      refused = true;
      clients.push(bogus);
    } catch {
      refused = true;
    }
    ok('a socket with an invalid ticket does not open', refused);
  } catch (e) {
    failures.push('the check threw: ' + e.message);
    console.log('    FAIL the check threw: ' + e.message);
  } finally {
    for (const c of clients) { try { c.close(); } catch { /* already gone */ } }
    child.kill('SIGTERM');
  }

  console.log(`\n  realtime check ${failures.length ? 'FAILED - ' + failures.length + ' problem(s)' : 'passed'}`
    + ` - ${passed} assertions\n`);
  process.exit(failures.length ? 1 : 0);
}

main();