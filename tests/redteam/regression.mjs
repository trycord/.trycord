// Trycord red-team regression suite.
// Proves the SECURE behavior for each confirmed finding. A failing test =
// the vulnerability is present (or has regressed). Run against an ISOLATED
// test instance only (fresh sqlite file), never production:
//
//   JWT_SECRET=test-secret DB_CLIENT=sqlite DB_FILE=/tmp/rt-reg.db \
//     PORT=18999 HOST=127.0.0.1 SERVER_HOST_TYPE=express node src/server.js &
//   BASE=http://127.0.0.1:18999 BACKEND=/home/ultim/trycord/.trycord/backend \
//     node tests/redteam/regression.mjs
//
// Exit 0 = all secure. Exit 1 = failures listed.
import { createRequire } from 'module';
const BASE = process.env.BASE || 'http://127.0.0.1:18999';
const BACKEND = process.env.BACKEND || '/home/ultim/trycord/.trycord/backend';
const require = createRequire(import.meta.url);
const fs = await import('fs');

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, detail = '') {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; failures.push(name); console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}
async function api(method, path, token, body) {
  const h = {};
  if (token) h['Authorization'] = 'Bearer ' + token;
  const o = { method, headers: h };
  if (body !== undefined) { h['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
  const r = await fetch(BASE + path, o);
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text, headers: r.headers };
}
async function reg(u) {
  const r = await api('POST', '/api/auth/register', null,
    { username: u, password: 'RegressPass123!', displayName: u, termsVersion: '1.0', privacyVersion: '1.0' });
  if (r.status !== 200) throw new Error('register failed: ' + r.status + ' ' + r.text.slice(0, 200));
  return r.json;
}

// RT-13 recovery wiring alive (forgot/reset must not 500). Runs early: the
// forgot-password limiter is 5/min per IP, shared with any other testing.
{
  const f = await api('POST', '/api/auth/forgot-password', null, { email: 'nobody@example.com' });
  t('RT-13 forgot-password never 500', f.status !== 500, 'got ' + f.status + ' (200, or 429 if the 5/min limiter is hot)');
  const rp = await api('POST', '/api/auth/reset-password', null, { token: 'bogus', newPassword: 'SomeNewPass123!' });
  t('RT-13 reset-password never 500', rp.status !== 500, 'got ' + rp.status + ' (400/401, or 429 if limited)');
}

console.log('== live API tests against ' + BASE + ' ==');
const ts = Date.now() % 1000000;
const A = await reg('rg_own_' + ts), B = await reg('rg_jr_' + ts), C = await reg('rg_out_' + ts);
const E = await reg('rg_jr2_' + ts); // dedicated junior for RT-01 (stays a member)
const s1 = await api('POST', '/api/servers', A.token, { name: 'rg-' + ts });
const S = s1.json.serverId, JC = s1.json.joinCode, CH = s1.json.channelId;
await api('POST', '/api/servers/join/' + JC, B.token, {});
await api('POST', '/api/servers/join/' + JC, E.token, {});

// RT-01 unban hierarchy
{
  const jr = (await api('POST', `/api/servers/${S}/roles`, A.token, { name: 'ban', permissions: ['BAN_MEMBERS'] })).json;
  await api('POST', `/api/servers/${S}/roles/${jr.id}/assign`, A.token, { userId: E.user.id });
  // fresh senior D
  const D = await reg('rg_snr_' + ts);
  await api('POST', '/api/servers/join/' + JC, D.token, {});
  await api('POST', `/api/servers/${S}/ban`, A.token, { userId: D.user.id, reason: 'rg' });
  const un = await api('POST', `/api/servers/${S}/unban`, E.token, { userId: D.user.id });
  t('RT-01 junior cannot unban senior', un.status === 403 || un.status === 404, 'got ' + un.status);
}

// RT-02 pins honor channel overrides
{
  const m = await api('POST', `/api/channels/${CH}/messages`, A.token, { content: 'rg pin' });
  await api('PUT', `/api/servers/${S}/channels/${CH}/overrides/MANAGE_MESSAGES`, A.token, { effect: 'deny' });
  const jr2 = (await api('POST', `/api/servers/${S}/roles`, A.token, { name: 'pin', permissions: ['MANAGE_MESSAGES'] })).json;
  await api('POST', `/api/servers/${S}/roles/${jr2.id}/assign`, A.token, { userId: B.user.id });
  const pin = await api('POST', `/api/servers/${S}/channels/${CH}/pins`, B.token, { messageId: m.json.id });
  t('RT-02 channel deny blocks pin', pin.status === 403, 'got ' + pin.status);
  await api('PUT', `/api/servers/${S}/channels/${CH}/overrides/MANAGE_MESSAGES`, A.token, { effect: 'inherit' });
}

// RT-03 speak-requests require membership
{
  const r = await api('GET', `/api/voice/channels/${CH}/speak-requests`, C.token);
  t('RT-03 outsider cannot list speak requests', r.status === 403 || r.status === 404, 'got ' + r.status);
}

// RT-04 cross-server bot commands
{
  const s2 = await api('POST', '/api/servers', A.token, { name: 'rg2-' + ts });
  const app = await api('POST', `/api/servers/${s2.json.serverId}/apps`, A.token, { name: 'victim' });
  const x = await api('PUT', `/api/servers/${S}/apps/${app.json.app.id}/commands`, B.token, { name: 'x', response: 'x' });
  // B has no MANAGE_SERVER here; use owner of S1 against S2 app for the real test:
  const x2 = await api('PUT', `/api/servers/${S}/apps/${app.json.app.id}/commands`, A.token, { name: 'x', response: 'x' });
  t('RT-04 cross-server setCommand rejected', x2.status === 404, 'got ' + x2.status);
  if (x2.status === 200) await api('DELETE', `/api/servers/${s2.json.serverId}/apps/${app.json.app.id}`, A.token);
}

// RT-05 webhook channel must belong to same server
{
  const s2 = await api('POST', '/api/servers', A.token, { name: 'rg3-' + ts });
  const wh = await api('POST', `/api/servers/${S}/webhooks`, A.token, { name: 'h', url: 'https://example.com/h', channelId: CH });
  const up = await api('PATCH', `/api/servers/${S}/webhooks/${wh.json.webhook.id}`, A.token, { channelId: s2.json.channelId });
  t('RT-05 webhook rejects foreign channel', up.status !== 200 || up.json.webhook.channelId !== s2.json.channelId, 'got ' + up.status);
}

// RT-06 presence privacy (needs online user; best-effort: assert search hides, bulk/profile must match)
{
  await api('PATCH', '/api/me/privacy', B.token, { presence: 'nobody' });
  const tk = await api('POST', '/api/auth/ws/ticket', B.token);
  let online = false;
  try {
    const WS = require(BACKEND + '/node_modules/ws');
    const ws = new WS('ws://' + new URL(BASE).host + '/?ticket=' + tk.json.ticket);
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); setTimeout(() => rej(new Error('timeout')), 4000); });
    await new Promise((r) => setTimeout(r, 800));
    online = true;
    const bulk = await api('GET', '/api/users/presence?ids=' + B.user.id, A.token);
    const prof = await api('GET', '/api/users/' + B.user.id, A.token);
    t('RT-06 bulk presence hidden', bulk.json[B.user.id] !== 'online', JSON.stringify(bulk.json));
    t('RT-06 profile presence hidden', prof.json.presence !== 'online', String(prof.json.presence));
    ws.terminate();
  } catch (e) { t('RT-06 presence (ws unavailable: ' + e.message + ')', false); }
  await api('PATCH', '/api/me/privacy', B.token, { presence: 'everyone' });
}

// RT-07 role assign target hierarchy (with distinct positions via reorder)
{
  const mk = async (n, p) => (await api('POST', `/api/servers/${S}/roles`, A.token, { name: n, permissions: p })).json;
  const lo = await mk('rg_lo' + ts, ['SEND_MESSAGES']);
  const mi = await mk('rg_mi' + ts, ['MANAGE_ROLES', 'SEND_MESSAGES']);
  const hi = await mk('rg_hi' + ts, ['SEND_MESSAGES']);
  const all = (await api('GET', `/api/servers/${S}/roles`, A.token)).json;
  const defs = all.map((r) => r.id).filter((id) => ![lo.id, mi.id, hi.id].includes(id));
  await api('POST', `/api/servers/${S}/roles/reorder`, A.token, { orderedIds: [hi.id, mi.id, lo.id].concat(defs) });
  const D2 = await reg('rg_s2_' + ts);
  await api('POST', '/api/servers/join/' + JC, D2.token, {});
  await api('POST', `/api/servers/${S}/roles/${mi.id}/assign`, A.token, { userId: B.user.id });
  await api('POST', `/api/servers/${S}/roles/${hi.id}/assign`, A.token, { userId: D2.user.id });
  const asg = await api('POST', `/api/servers/${S}/roles/${lo.id}/assign`, B.token, { userId: D2.user.id });
  t('RT-07 junior cannot grant role to outranking member', asg.status === 403, 'got ' + asg.status);
}

// RT-13b covered by the early pre-registration block (rate-limit safe).

// RT-14 nonce scoped per author
{
  const N = 'RG' + ts;
  const m1 = await api('POST', `/api/channels/${CH}/messages`, A.token, { content: 'v', clientNonce: N });
  const m2 = await api('POST', `/api/channels/${CH}/messages`, B.token, { content: 'a', clientNonce: N });
  t('RT-14 cross-author nonce creates own message', m2.json.deduped !== true && m2.json.author_id === B.user.id, 'got deduped=' + m2.json.deduped);
}

console.log('\n== in-process unit tests ==');
// RT-10 gateway export is live binding
{
  const src = fs.readFileSync(BACKEND + '/src/auth/gateway.js', 'utf8');
  const gw = require(BACKEND + '/src/auth/gateway.js');
  gw.setGateway({ disconnectUser: () => 'LIVE' });
  let live = false;
  try { live = gw.disconnectUser('x') === 'LIVE'; } catch {}
  t('RT-10 disconnectUser export is live binding', live, 'still snapshot no-op');
}
// RT-11 voice authorizeVoice
{
  const svcPath = BACKEND + '/src/services/voice.js';
  const src = fs.readFileSync(svcPath, 'utf8');
  t('RT-11 no undefined perms reference', !/permissions:\s*perms\b/.test(src), 'line 177 pattern present');
  t('RT-11 stream gate is per-need', !/if\s*\(!canConnect\s*&&\s*!canNeed\)/.test(src), '&& pattern present');
}

console.log(`\nresult: ${pass} passed, ${fail} failed`);
if (fail) { console.log('failures: ' + failures.join(', ')); process.exit(1); }
