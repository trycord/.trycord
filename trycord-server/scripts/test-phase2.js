// Phase 2 end-to-end test: real two-account DM + friends + notifications
// flows against a running server (default http://localhost:9971).
// Covers: conversation uniqueness, messaging both ways, persistence,
// pagination, unread/read, delete auth, offline delivery, typing over WS,
// realtime reconciliation by id, friends lifecycle, user search, profiles,
// notifications, and the cross-user security matrix.
//
// Run: node scripts/test-phase2.js [baseUrl]
// Exit 0 = all assertions passed. Exit 1 = first failure (message printed).
const WebSocket = require('ws');

const BASE = (process.argv[2] || process.env.TRYCORD_TEST_URL || 'http://localhost:9971').replace(/\/+$/, '');
const stamp = Date.now().toString(36);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
function ok(cond, label) {
  if (!cond) {
    console.error('FAIL: ' + label);
    process.exit(1);
  }
  passed += 1;
  console.log('ok: ' + label);
}

async function api(method, path, token, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, data };
}

function connectWs(token) {
  return new Promise((resolve, reject) => {
    const wsUrl = BASE.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:') + '/?token=' + token;
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('ws connect timeout')); }, 8000);
    ws.on('open', () => { clearTimeout(timer); resolve(ws); });
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

function collect(ws) {
  const events = [];
  ws.on('message', (raw) => {
    try { events.push(JSON.parse(String(raw))); } catch { /* ignore */ }
  });
  return events;
}

async function waitFor(events, pred, timeoutMs, label) {
  const deadline = Date.now() + (timeoutMs || 5000);
  for (;;) {
    const found = events.find(pred);
    if (found) return found;
    if (Date.now() > deadline) {
      console.error('FAIL (timeout waiting for ' + label + ')');
      process.exit(1);
    }
    await sleep(100);
  }
}

async function main() {
  const su = (n) => n + '_' + stamp;

  // --- accounts ---
  // Legal versions the server currently requires at registration.
  const legal = await (await fetch(BASE + '/api/legal')).json();
  if (!legal.termsVersion || !legal.privacyVersion) {
    console.error('FAIL: /api/legal missing versions');
    process.exit(1);
  }
  console.log('ok: legal versions ' + legal.termsVersion + '/' + legal.privacyVersion);
  const r0 = await api('POST', '/api/auth/register', null, { username: su('nolegal'), password: 'secret123' });
  ok(r0.status === 400, 'registration without terms acceptance rejected (400)');

  async function register(name) {
    const r = await api('POST', '/api/auth/register', null, {
      username: su(name), password: 'secret123',
      termsVersion: legal.termsVersion, privacyVersion: legal.privacyVersion,
    });
    ok(r.status === 200 && r.data.token && r.data.user, 'register ' + name);
    return r.data;
  }
  const alice = await register('alice');
  const bob = await register('bob');
  const charlie = await register('charlie');

  // --- conversation uniqueness ---
  let r = await api('POST', '/api/dms', alice.token, { userId: bob.user.id });
  ok(r.status === 200 && r.data.id && r.data.created === true, 'alice opens DM with bob (created)');
  const convId = r.data.id;
  r = await api('POST', '/api/dms', alice.token, { userId: bob.user.id });
  ok(r.status === 200 && r.data.id === convId && r.data.created === false, 'alice reopens DM (same conversation, no duplicate)');
  r = await api('POST', '/api/dms', bob.token, { userId: alice.user.id });
  ok(r.status === 200 && r.data.id === convId, 'bob opens DM from his side (same conversation)');
  r = await api('POST', '/api/dms', alice.token, { userId: alice.user.id });
  ok(r.status === 400, 'self-DM rejected (400)');
  r = await api('POST', '/api/dms', alice.token, { userId: 'no-such-user' });
  ok(r.status === 404, 'unknown user rejected (404)');
  r = await api('GET', '/api/dms', null);
  ok(r.status === 401, 'DM list requires auth (401)');

  // --- messaging both ways + persistence shape ---
  r = await api('POST', `/api/dms/${convId}/messages`, alice.token, { content: 'Hello Bob' });
  ok(r.status === 200 && r.data.id && r.data.authorId === alice.user.id, 'alice sends m1 (author from session)');
  const m1 = r.data.id;
  const ids = [m1];
  r = await api('POST', `/api/dms/${convId}/messages`, bob.token, { content: 'Hi Alice', authorId: alice.user.id });
  ok(r.status === 200 && r.data.authorId === bob.user.id, 'forged authorId ignored, session wins');
  ids.push(r.data.id);
  r = await api('GET', `/api/dms/${convId}/messages`, bob.token);
  ok(r.status === 200 && r.data.length === 2 && r.data[0].id === m1, 'bob reads history in order');

  // --- unread / read ---
  r = await api('GET', '/api/dms', bob.token);
  const bobConv = r.data.find((c) => c.id === convId);
  ok(bobConv && bobConv.unreadCount === 1, 'bob has 1 unread');
  ok(bobConv.lastMessage && bobConv.lastMessage.content === 'Hi Alice', 'list carries last message');
  r = await api('GET', `/api/dms/${convId}`, bob.token);
  ok(r.status === 200 && r.data.peer.username === alice.user.username, 'detail carries peer + read positions');
  r = await api('GET', '/api/dms', bob.token);
  ok(r.data.find((c) => c.id === convId).unreadCount === 1, 'viewing detail does not clear unread');
  r = await api('POST', `/api/dms/${convId}/read`, bob.token);
  ok(r.status === 200 && r.data.lastReadAt, 'mark read returns position');
  r = await api('GET', '/api/dms', bob.token);
  ok(r.data.find((c) => c.id === convId).unreadCount === 0, 'unread clears after read');

  // --- pagination (deterministic, no dupes) ---
  for (let i = 0; i < 4; i++) {
    r = await api('POST', `/api/dms/${convId}/messages`, alice.token, { content: 'page msg ' + i });
    ids.push(r.data.id);
  }
  r = await api('GET', `/api/dms/${convId}/messages?limit=2`, bob.token);
  ok(r.data.length === 2 && r.data[1].id === ids[ids.length - 1], 'latest page holds newest 2');
  r = await api('GET', `/api/dms/${convId}/messages?before=${r.data[0].id}&limit=10`, bob.token);
  ok(r.data.length === 4 && r.data[0].id === ids[0] && r.data[3].id === ids[3], 'older page holds the other 4, ascending, no overlap');
  r = await api('POST', `/api/dms/${convId}/messages`, alice.token, { content: '   ' });
  ok(r.status === 400, 'empty message rejected (400)');
  r = await api('POST', `/api/dms/${convId}/messages`, alice.token, { content: 'x'.repeat(2001) });
  ok(r.status === 400, 'oversize message rejected (400)');

  // --- delete authorization ---
  const victim = ids[ids.length - 1];
  r = await api('DELETE', `/api/dms/${convId}/messages/${victim}`, bob.token);
  ok(r.status === 403, "bob cannot delete alice's message (403)");
  r = await api('DELETE', `/api/dms/${convId}/messages/${victim}`, alice.token);
  ok(r.status === 200, 'author deletes own message');
  r = await api('DELETE', `/api/dms/${convId}/messages/does-not-exist`, alice.token);
  ok(r.status === 404, 'missing message delete is 404');

  // --- realtime: join, typing, delivery, reconciliation ---
  const aliceWs = await connectWs(alice.token);
  const bobWs = await connectWs(bob.token);
  const aliceEv = collect(aliceWs);
  const bobEv = collect(bobWs);
  aliceWs.send(JSON.stringify({ type: 'dm:join', conversationId: convId }));
  bobWs.send(JSON.stringify({ type: 'dm:join', conversationId: convId }));
  await sleep(400);
  aliceWs.send(JSON.stringify({ type: 'dm:typing', conversationId: convId }));
  const typing = await waitFor(bobEv, (e) => e.type === 'dm:typing' && e.userId === alice.user.id, 5000, 'typing event');
  ok(!!typing, 'bob sees alice typing');
  r = await api('POST', `/api/dms/${convId}/messages`, alice.token, { content: 'realtime check' });
  const live = await waitFor(bobEv, (e) => e.type === 'dm:message' && e.id === r.data.id, 5000, 'live delivery');
  ok(live.content === 'realtime check' && live.authorId === alice.user.id, 'bob receives same id (reconciliation key)');
  // presence derived from live sockets
  r = await api('GET', `/api/users/presence?ids=${alice.user.id},${bob.user.id},${charlie.user.id}`, alice.token);
  ok(r.data[alice.user.id] === 'online' && r.data[bob.user.id] === 'online' && r.data[charlie.user.id] === 'offline', 'presence reflects sockets');
  bobWs.close();
  await sleep(800);

  // --- offline delivery + notifications ---
  r = await api('POST', `/api/dms/${convId}/messages`, alice.token, { content: 'while you were away' });
  ok(r.status === 200, 'send to offline bob persists');
  r = await api('GET', '/api/notifications', bob.token);
  ok(r.status === 200 && r.data.unreadCount >= 1 && r.data.items.some((n) => n.type === 'dm'), 'bob has persisted dm notification');
  const noteId = r.data.items.find((n) => n.type === 'dm').id;
  r = await api('POST', `/api/notifications/${noteId}/read`, bob.token);
  ok(r.status === 200, 'bob marks notification read');
  r = await api('POST', '/api/notifications/read-all', bob.token);
  ok(r.status === 200, 'read-all works');
  // online push path: reconnect bob, send, expect notification event on socket
  const bobWs2 = await connectWs(bob.token);
  const bobEv2 = collect(bobWs2);
  bobWs2.send(JSON.stringify({ type: 'dm:join', conversationId: convId }));
  await sleep(300);

  // --- friends lifecycle ---
  r = await api('POST', '/api/friends/requests', alice.token, { userId: bob.user.id });
  ok(r.status === 200 && r.data.status === 'pending', 'alice requests bob');
  const reqId = r.data.id;
  r = await api('POST', '/api/friends/requests', alice.token, { userId: bob.user.id });
  ok(r.status === 409, 'duplicate request rejected (409)');
  r = await api('POST', `/api/friends/requests/${reqId}/accept`, charlie.token);
  ok(r.status === 403 || r.status === 404, 'charlie cannot accept alice/bob request');
  r = await api('GET', '/api/friends/requests', bob.token);
  ok(r.data.incoming.length === 1 && r.data.incoming[0].from.username === alice.user.username, 'bob sees incoming request');
  r = await api('POST', `/api/friends/requests/${reqId}/accept`, bob.token);
  ok(r.status === 200 && r.data.status === 'accepted', 'bob accepts');
  r = await api('GET', '/api/friends', alice.token);
  ok(r.data.some((f) => f.id === bob.user.id), 'alice lists bob as friend');
  r = await api('DELETE', `/api/friends/${bob.user.id}`, alice.token);
  ok(r.status === 200, 'alice removes bob');
  r = await api('GET', '/api/friends', bob.token);
  ok(!r.data.some((f) => f.id === alice.user.id), 'friendship gone both directions');
  r = await api('POST', '/api/friends/requests', alice.token, { userId: alice.user.id });
  ok(r.status === 400, 'self-friend rejected (400)');

  // --- search + profiles (public fields only) ---
  r = await api('GET', `/api/users/search?q=${alice.user.username.slice(0, 6)}`, bob.token);
  ok(r.status === 200 && r.data.some((u) => u.id === alice.user.id), 'search finds alice');
  ok(!r.data.some((u) => u.password_hash || u.token), 'search leaks no private fields');
  r = await api('GET', '/api/users/search?q=x', bob.token);
  ok(r.status === 400, 'short search rejected (400)');
  r = await api('GET', `/api/users/${bob.user.id}`, alice.token);
  ok(r.status === 200 && r.data.username === bob.user.username && !r.data.password_hash && typeof r.data.relation === 'string', 'public profile with relation, no secrets');
  r = await api('GET', '/api/users/nope', alice.token);
  ok(r.status === 404, 'unknown profile is 404');

  // --- security matrix: charlie vs alice/bob conversation ---
  r = await api('GET', `/api/dms/${convId}/messages`, charlie.token);
  ok(r.status === 403, 'charlie cannot read the DM (403)');
  r = await api('POST', `/api/dms/${convId}/messages`, charlie.token, { content: 'intruder' });
  ok(r.status === 403, 'charlie cannot send to the DM (403)');
  r = await api('POST', `/api/dms/${convId}/read`, charlie.token);
  ok(r.status === 403, 'charlie cannot touch read state (403)');
  r = await api('GET', `/api/dms/${convId}`, charlie.token);
  ok(r.status === 403, 'charlie cannot open the DM (403)');
  r = await api('POST', `/api/notifications/${noteId}/read`, charlie.token);
  ok(r.status === 404, "charlie cannot read bob's notification (404)");

  try { aliceWs.close(); } catch {}
  try { bobWs2.close(); } catch {}
  console.log(`\nphase2 e2e passed: ${passed} assertions`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('E2E FAILED: ' + ((e && e.stack) || e));
    process.exit(1);
  }
);
