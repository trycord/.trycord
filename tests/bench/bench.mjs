// Measures Trycord under a workload that is actually a chat workload.
//
// The rules this follows, because the numbers are easy to make meaningless:
//
//   - Real flows. Registering, creating a community, joining a channel and posting
//     messages. /health is measured too, but only as a baseline for how much of the
//     request path is real work: it is one indexed row read and nothing else, so a
//     good number there says nothing about the server.
//   - Real fanout. Every client is connected over a real WebSocket, subscribed to the
//     same channel, and the reported figure is from one client posting to every other
//     client having received it. Nothing is simulated inside the process.
//   - Event-loop delay is measured with perf_hooks rather than inferred. This is the
//     number that says whether concurrency work is needed at all.
//   - Percentiles, not averages. A mean hides the tail, and the tail is what a user
//     feels.
//
//   node tests/bench/bench.mjs [origin] [clients] [rounds]
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// ws is the server's dependency, not the repository root's, and this script is
// deliberately outside the server package so it never becomes part of it. Resolve
// the one module it needs from where it actually is rather than adding a second copy
// to install and keep in step.
const here = dirname(fileURLToPath(import.meta.url));
const serverRequire = createRequire(resolve(here, '../../backend/package.json'));
const WebSocket = serverRequire('ws');
const legal = serverRequire('./src/legal.js');

const ORIGIN = process.argv[2] || 'http://127.0.0.1:9981';
const CLIENTS = Math.max(2, parseInt(process.argv[3] || '12', 10));
const ROUNDS = Math.max(1, parseInt(process.argv[4] || '40', 10));
const API = ORIGIN + '/api';

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0);
const ms = (v) => (Math.round(v * 100) / 100).toFixed(2) + 'ms';

function summarise(label, samples) {
  const s = [...samples].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  console.log(
    '  ' + label.padEnd(34)
    + ' n=' + String(s.length).padStart(4)
    + '  mean=' + ms(Math.round(sum / (s.length || 1))).padStart(8)
    + '  p50=' + ms(pct(s, 0.5)).padStart(8)
    + '  p95=' + ms(pct(s, 0.95)).padStart(8)
    + '  p99=' + ms(pct(s, 0.99)).padStart(8)
    + '  max=' + ms(s[s.length - 1] || 0).padStart(8));
}

async function call(path, { method = 'GET', body, token } = {}) {
  // hrtime rather than performance.now(): monotonic, and not subject to the
  // clock adjustments that make a wall-clock delta a poor thing to average.
  const t0 = process.hrtime.bigint();
  const r = await fetch(API + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  const dt = Number(process.hrtime.bigint() - t0) / 1e6;
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text, dt };
}

async function setup() {
  console.log('  target ' + ORIGIN + '  clients=' + CLIENTS + '  rounds=' + ROUNDS);

  const uniq = Math.random().toString(36).slice(2, 8);
  const owner = await call('/auth/register', {
    method: 'POST',
    body: {
      username: 'bench_' + uniq,
      password: 'correcthorse1',
      termsVersion: legal.TERMS_VERSION,
      privacyVersion: legal.PRIVACY_VERSION,
    },
  });
  if (owner.status >= 300) throw new Error('owner register: ' + owner.status + ' ' + owner.text.slice(0, 200));
  const token = owner.json.token;

  const created = await call('/servers', {
    method: 'POST', token,
    body: { name: 'Bench ' + uniq, description: 'load' },
  });
  if (created.status >= 300) throw new Error('create server: ' + created.status + ' ' + created.text.slice(0, 200));
  const serverId = created.json.serverId;

  const layout = await call('/servers/' + serverId + '/channels', { token });
  const channelId = (layout.json.channels || [])[0].channelId || (layout.json.channels || [])[0].id;
  if (!channelId) throw new Error('no channel in the new community');

  // Members join by invite, which is the only route into a community the product
  // has. /discover/servers/:id/join answers 403 for one you were not invited to,
  // so a benchmark that used it was measuring a refusal.
  const invite = await call('/servers/' + serverId + '/invites', { method: 'POST', token, body: {} });
  if (invite.status >= 300) throw new Error('create invite: ' + invite.status + ' ' + invite.text.slice(0, 160));
  const code = invite.json.code || (invite.json.invite && invite.json.invite.code);
  if (!code) throw new Error('invite has no code: ' + invite.text.slice(0, 200));

  const tokens = [token];
  for (let i = 1; i < CLIENTS; i++) {
    const u = 'bench_' + uniq + '_' + i;
    const r = await call('/auth/register', {
      method: 'POST',
      body: {
        username: u,
        password: 'correcthorse1',
        termsVersion: legal.TERMS_VERSION,
        privacyVersion: legal.PRIVACY_VERSION,
      },
    });
    if (r.status >= 300) throw new Error('member register: ' + r.status + ' ' + r.text.slice(0, 160));
    const join = await call('/invites/' + encodeURIComponent(code) + '/join', { method: 'POST', token: r.json.token });
    if (join.status >= 300) console.log('    (member ' + i + ' could not join: ' + join.status + ')');
    tokens.push(r.json.token);
  }
  return { serverId, channelId, tokens, uniq };
}

async function connect(token, serverId, channelId, onMessage) {
  const ticket = await call('/auth/ws/ticket', { method: 'POST', token });
  if (ticket.status >= 300) throw new Error('ws ticket: ' + ticket.status + ' ' + ticket.text.slice(0, 160));
  const url = ORIGIN.replace(/^http/, 'ws') + '/ws?ticket=' + encodeURIComponent(ticket.json.ticket);
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('ws open timeout')), 15000);
    ws.once('open', () => { clearTimeout(t); resolve(); });
    ws.once('error', (e) => { clearTimeout(t); reject(e); });
  });
  ws.on('message', (raw) => {
    let m = null;
    try { m = JSON.parse(String(raw)); } catch { return; }
    onMessage(m);
  });
  ws.send(JSON.stringify({ type: 'join', channelId }));
  return ws;
}

async function main() {
  const el = monitorEventLoopDelay({ resolution: 10 });
  el.enable();

  const t = await setup();
  console.log('  community ' + t.serverId + ' channel ' + t.channelId);

  const rss0 = process.memoryUsage().rss;
  console.log('\n  HTTP, one request at a time');
  const health = [];
  for (let i = 0; i < 120; i++) health.push((await call('/health')).dt);
  summarise('GET /api/health', health);

  const layoutReads = [];
  for (let i = 0; i < 120; i++) layoutReads.push((await call('/servers/' + t.serverId + '/channels', { token: t.tokens[0] })).dt);
  summarise('GET channels (authed)', layoutReads);

  console.log('\n  HTTP, all clients at once');
  const conc = [];
  for (let round = 0; round < ROUNDS; round++) {
    const batch = await Promise.all(t.tokens.map((tok) => call('/servers/' + t.serverId + '/channels', { token: tok })));
    for (const r of batch) conc.push(r.dt);
  }
  summarise('GET channels x' + CLIENTS + ' concurrent', conc);

  console.log('\n  realtime fanout to ' + CLIENTS + ' sockets in one channel');
  const received = new Map();
  const frames = [];
  const sockets = [];
  for (let i = 0; i < CLIENTS; i++) {
    sockets.push(await connect(t.tokens[i], t.serverId, t.channelId, (m) => {
      if (frames.length < 40) frames.push(m);
      // The broadcast is the message row spread onto the frame, so the column
      // names come through as-is: channel_id, not channelId.
      if (m && m.type === 'message' && m.channel_id === t.channelId) {
        received.set(m.content, Date.now());
      }
    }));
  }
  await new Promise((r) => setTimeout(r, 1500));
  console.log('  ' + CLIENTS + ' sockets open');

  // Which of the two delivery paths is at fault? A message posted over the socket
  // goes through the gateway's own broadcast; one posted over HTTP goes through the
  // wiring in server.js. If the socket post arrives and the HTTP post does not, the
  // room is fine and the wiring is not.
  const probeSeen = await new Promise((resolve) => {
    const tag = 'probe-' + t.uniq;
    const timer = setTimeout(() => resolve('nothing in 3s'), 3000);
    const check = (m) => {
      if (m && m.type === 'message' && String(m.content || '').indexOf(tag) === 0) {
        clearTimeout(timer); sockets[0].off('message', check); resolve('delivered');
      }
    };
    sockets[0].on('message', check);
    sockets[0].send(JSON.stringify({ type: 'msg', channelId: t.channelId, content: tag }));
    sockets[1].on('message', check);
  });
  console.log('  post over the websocket, to another socket: ' + probeSeen);
  const probeBack = await call('/channels/' + t.channelId + '/messages', { token: t.tokens[0] });
  const probeRows = Array.isArray(probeBack.json) ? probeBack.json : [];
  const probeStored = probeRows.filter((r) => String(r.content || '').indexOf('probe-' + t.uniq) === 0).length;
  console.log('  the websocket post was stored: ' + (probeStored ? 'yes (' + probeStored + ')' + ' -> the op ran, the room did not fill'
    : 'no -> the op never ran')); 
  if (frames.length) {
    const kinds = {};
    for (const f of frames) kinds[f.type || '(no type)'] = (kinds[f.type || '(no type)'] || 0) + 1;
    console.log('  frames so far: ' + JSON.stringify(kinds));
    console.log('  first frame: ' + JSON.stringify(frames[0]).slice(0, 220));
  } else {
    console.log('  no frames arrived on any socket');
  }

  // Recorded as the server's broadcast minus when it was seen here, so a positive
  // number means every subscriber already had it.
  const fanout = [];
  const posts = [];
  let firstRefusal = null;
  for (let i = 0; i < ROUNDS; i++) {
    const content = 'fan-' + t.uniq + '-' + i + '-' + i;
    const sentAt = Date.now();
    const p = call('/channels/' + t.channelId + '/messages', {
      method: 'POST', token: t.tokens[0], body: { content },
    });
    const posted = await p;
    posts.push(posted.dt);
    if (posted.status >= 300 && !firstRefusal) {
      firstRefusal = posted.status + ' ' + posted.text.slice(0, 200);
      console.log('  post refused: ' + firstRefusal);
    }
    // Wait until every other socket has it, or give up after a second.
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      if (received.get(content)) break;
      await new Promise((r) => setTimeout(r, 2));
    }
    const at = received.get(content);
    fanout.push(at ? sentAt - at : -1);
  }
  // Did the message exist at all? A post that was never stored and a post that was
  // stored but never broadcast are different faults, and only one of them is the
  // gateway's.
  const back = await call('/channels/' + t.channelId + '/messages', { token: t.tokens[0] });
  // The channel history route answers with a bare array, not an envelope.
  const rows = Array.isArray(back.json) ? back.json : ((back.json && back.json.messages) || (back.json && back.json.data) || []);
  const mine = rows.filter((r) => String(r.content || '').indexOf('fan-' + t.uniq) === 0);
  console.log('  rows for this channel: ' + rows.length + ', of which ours: ' + mine.length);
  if (mine.length) console.log('  stored content sample: ' + JSON.stringify(String(mine[0].content).slice(0, 60)));
  else console.log('  nothing we posted was stored, so the fault is upstream of the gateway');

  const missed = fanout.filter((x) => x < 0).length;
  const good = fanout.filter((x) => x >= 0);
  summarise('POST message (author waits)', posts);
  summarise('fanout to last subscriber', good);
  console.log('  rounds with no delivery: ' + missed + ' of ' + fanout.length);

  for (const s of sockets) { try { s.close(); } catch { /* already gone */ } }

  await new Promise((r) => setTimeout(r, 1200));
  el.disable();
  const h = el.percentiles || {};
  const ev = (v) => (Number.isFinite(v) ? (v / 1e6).toFixed(2) + 'ms' : 'n/a');
  console.log('\n  event loop delay (this process, which is only the load generator)');
  console.log('    mean=' + ev(h.mean) + '  p95=' + ev(h.p95) + '  p99=' + ev(h.p99) + '  max=' + ev(h.max));

  console.log('\n  load generator rss ' + Math.round(rss0 / 1048576) + 'MB -> '
    + Math.round(process.memoryUsage().rss / 1048576) + 'MB');
  console.log('\n  server-side figures come from the server log, not from here:');
  console.log('    grep the run for its own rss and event-loop numbers.');
}

main().catch((e) => { console.error('  bench failed: ' + e.message); process.exit(1); });