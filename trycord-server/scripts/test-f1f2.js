// F1/F2 community regression against a running server (default
// http://localhost:9971). Covers role colors + reorder + hierarchy,
// category rename/reorder, channel reorder/move/edit/delete, bans,
// timeouts, bot-flag gating, member payload shape, presence bulk, and
// WebSocket server-room eviction on kick. Uses throwaway probe users and
// deletes the created server.
//
// Run: node scripts/test-f1f2.js [baseUrl]
// Exit 0 = all assertions passed. Exit 1 = failures.
const API = (process.argv[2] || process.env.TRYCORD_TEST_URL || 'http://localhost:9971').replace(/\/+$/, '');
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; console.log('FAIL: ' + name + (extra ? ' :: ' + extra : '')); }
}
async function J(method, p, body, tok) {
  const h = { 'Content-Type': 'application/json' };
  if (tok) h.Authorization = 'Bearer ' + tok;
  const r = await fetch(API + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => null);
  return { status: r.status, json: j };
}
(async () => {
  const legal = (await J('GET', '/api/legal')).json;
  async function mkuser(pfx) {
    const u = pfx + Date.now().toString(36) + Math.floor(Math.random() * 1e4);
    const r = await J('POST', '/api/auth/register', { username: u, password: 'secret123', termsVersion: legal.termsVersion, privacyVersion: legal.privacyVersion });
    ok('mkuser-' + pfx, r.status === 200 && !!(r.json && r.json.token), 'status=' + r.status);
    if (r.status !== 200) throw new Error('register failed, aborting');
    const v = await J('POST', '/api/test/self-verify', null, r.json.token);
    if (v.status !== 200) throw new Error('self-verify failed — boot the server with ALLOW_TEST_HOOKS=true');
    return { name: u, token: r.json.token, id: r.json.user.id };
  }
  const A = await mkuser('f1A'); // owner
  const B = await mkuser('f1B'); // member
  const C = await mkuser('f1C'); // low-priv member

  const srv = await J('POST', '/api/servers', { name: 'f1-server', isPublic: false }, A.token);
  ok('createServer', srv.status === 200 && !!srv.json.serverId);
  const sid = srv.json.serverId, cid = srv.json.channelId;

  // B + C join via code
  const code = (await J('GET', '/api/servers/' + sid, null, A.token)).json.join_code;
  ok('joinB', (await J('POST', '/api/servers/join/' + code, null, B.token)).status === 200);
  ok('joinC', (await J('POST', '/api/servers/join/' + code, null, C.token)).status === 200);

  // ---- roles: color, reorder, hierarchy ----
  const rc = await J('POST', '/api/servers/' + sid + '/roles', { name: 'Tint', permissions: ['SEND_MESSAGES'], color: '#ff0000' }, A.token);
  ok('roleColorCreate', rc.status === 200 && rc.json.color === '#ff0000', JSON.stringify(rc.json).slice(0, 100));
  const badColor = await J('POST', '/api/servers/' + sid + '/roles', { name: 'Bad', color: 'red' }, A.token);
  ok('roleColorRejected', badColor.status === 400, 'status=' + badColor.status);
  const ru = await J('PATCH', '/api/servers/' + sid + '/roles/' + rc.json.id, { color: '#00FF00', name: 'Tint2' }, A.token);
  ok('roleColorUpdate', ru.status === 200 && ru.json.color === '#00ff00' && ru.json.name === 'Tint2', JSON.stringify(ru.json).slice(0, 100));
  const roles0 = (await J('GET', '/api/servers/' + sid + '/roles', null, A.token)).json;
  const reversed = roles0.map((r) => r.id).reverse();
  const ro = await J('POST', '/api/servers/' + sid + '/roles/reorder', { orderedIds: reversed }, A.token);
  // list() orders position DESC, so the reversed input comes back flipped.
  const expectOrder = [...reversed].reverse();
  ok('roleReorder', ro.status === 200 && JSON.stringify(ro.json.map((r) => r.id)) === JSON.stringify(expectOrder),
    'status=' + ro.status + ' ' + JSON.stringify((ro.json || []).map((r) => r.id)).slice(0, 80));
  const badOrder = await J('POST', '/api/servers/' + sid + '/roles/reorder', { orderedIds: ['nope'] }, A.token);
  ok('roleReorderValidated', badOrder.status === 400, 'status=' + badOrder.status);
  // hierarchy: C (plain member) must not grant the Admin role to B
  const adminRole = roles0.find((r) => r.name === 'Admin');
  const hijack = await J('POST', '/api/servers/' + sid + '/roles/' + adminRole.id + '/assign', { userId: B.id }, C.token);
  ok('assignHierarchyDenied', hijack.status === 403, 'status=' + hijack.status);
  // owner can assign
  ok('assignByOwner', (await J('POST', '/api/servers/' + sid + '/roles/' + rc.json.id + '/assign', { userId: B.id }, A.token)).status === 200);
  ok('unassignByOwner', (await J('DELETE', '/api/servers/' + sid + '/roles/' + rc.json.id + '/assign/' + B.id, null, A.token)).status === 200);

  // ---- categories: rename + reorder ----
  const cats = (await J('GET', '/api/servers/' + sid + '/categories', null, A.token)).json;
  ok('categoriesSeeded', Array.isArray(cats) && cats.length >= 1);
  const cat2 = await J('POST', '/api/servers/' + sid + '/categories', { name: 'Second' }, A.token);
  ok('categoryCreate', cat2.status === 200 && !!cat2.json.id);
  const rn = await J('PATCH', '/api/servers/' + sid + '/categories/' + cat2.json.id, { name: 'Second2' }, A.token);
  ok('categoryRename', rn.status === 200 && rn.json.name === 'Second2', JSON.stringify(rn.json).slice(0, 80));
  const cro = await J('POST', '/api/servers/' + sid + '/categories/reorder', { orderedIds: [cat2.json.id, cats[0].id] }, A.token);
  ok('categoryReorder', cro.status === 200 && cro.json.categories[0].id === cat2.json.id, 'status=' + cro.status);

  // ---- channels: move + reorder + edit + delete ----
  const mv = await J('PATCH', '/api/servers/' + sid + '/channels/' + cid, { name: 'general2', categoryId: cat2.json.id }, A.token);
  ok('channelMoveRename', mv.status === 200 && mv.json.name === 'general2' && mv.json.category_id === cat2.json.id, JSON.stringify(mv.json).slice(0, 120));
  const ch2 = await J('POST', '/api/servers/' + sid + '/channels', { name: 'extra' }, A.token);
  const cho = await J('POST', '/api/servers/' + sid + '/channels/reorder', { orderedIds: [ch2.json.id, cid] }, A.token);
  ok('channelReorder', cho.status === 200 && cho.json.channels[0].id === ch2.json.id, 'status=' + cho.status);
  ok('channelDelete', (await J('DELETE', '/api/servers/' + sid + '/channels/' + ch2.json.id, null, A.token)).status === 200);

  // ---- member payload shape ----
  const mems = await J('GET', '/api/servers/' + sid + '/members', null, A.token);
  const mb = mems.json.find((m) => m.id === B.id);
  ok('memberPayload', mems.status === 200 && mb && 'is_bot' in mb && 'joined_at' in mb && Array.isArray(mb.roles) && 'status_text' in mb,
    JSON.stringify(mb).slice(0, 160));
  const pres = await J('GET', '/api/users/presence?ids=' + A.id + ',' + B.id, null, A.token);
  ok('presenceBulk', pres.status === 200 && pres.json[A.id] && pres.json[B.id], JSON.stringify(pres.json).slice(0, 80));
  const det = await J('GET', '/api/servers/' + sid, null, A.token);
  ok('detailRoleCount', det.status === 200 && typeof det.json.role_count === 'number', JSON.stringify(det.json).slice(0, 120));

  // ---- timeout: cannot post, then can after clear ----
  ok('timeoutSet', (await J('POST', '/api/servers/' + sid + '/timeout', { userId: B.id, minutes: 10 }, A.token)).status === 200);
  const tpost = await J('POST', '/api/channels/' + cid + '/messages', { content: 'muted?' }, B.token);
  ok('timeoutBlocksPost', tpost.status === 403, 'status=' + tpost.status);
  ok('timeoutClear', (await J('POST', '/api/servers/' + sid + '/timeout', { userId: B.id, minutes: 0 }, A.token)).status === 200);
  ok('postAfterClear', (await J('POST', '/api/channels/' + cid + '/messages', { content: 'back' }, B.token)).status === 200);
  const selfTimeout = await J('POST', '/api/servers/' + sid + '/timeout', { userId: A.id, minutes: 5 }, A.token);
  ok('timeoutSelfDenied', selfTimeout.status === 400, 'status=' + selfTimeout.status);

  // ---- bans: block rejoin, list, unban ----
  const banB = await J('POST', '/api/servers/' + sid + '/ban', { userId: B.id, reason: 'test' }, A.token);
  ok('ban', banB.status === 200, 'status=' + banB.status);
  const rejoin = await J('POST', '/api/servers/join/' + code, null, B.token);
  ok('banBlocksJoin', rejoin.status === 403, 'status=' + rejoin.status + ' ' + JSON.stringify(rejoin.json).slice(0, 80));
  const bans = await J('GET', '/api/servers/' + sid + '/bans', null, A.token);
  ok('banList', bans.status === 200 && bans.json.some((b) => b.userId === B.id && b.reason === 'test'), JSON.stringify(bans.json).slice(0, 120));
  const bansDenied = await J('GET', '/api/servers/' + sid + '/bans', null, C.token);
  ok('banListGated', bansDenied.status === 403, 'status=' + bansDenied.status);
  ok('unban', (await J('POST', '/api/servers/' + sid + '/unban', { userId: B.id }, A.token)).status === 200);
  ok('joinAfterUnban', (await J('POST', '/api/servers/join/' + code, null, B.token)).status === 200);
  const banOwner = await J('POST', '/api/servers/' + sid + '/ban', { userId: A.id }, A.token);
  ok('banOwnerDenied', banOwner.status === 400, 'status=' + banOwner.status);

  // ---- bot flag: admin-only ----
  const botDenied = await J('POST', '/api/admin/users/' + B.id + '/bot', { isBot: true }, B.token);
  ok('botFlagGated', botDenied.status === 401 || botDenied.status === 403, 'status=' + botDenied.status);

  // ---- WS server-room eviction: kicked socket stops receiving ----
  const WebSocket = require('ws');
  async function memberSocket(user) {
    const t = await J('POST', '/api/auth/ws/ticket', null, user.token);
    if (t.status !== 200 || !t.json.ticket) throw new Error('no ticket');
    const ws = new WebSocket(API.replace(/^http/, 'ws') + '/?ticket=' + t.json.ticket);
    await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
    return ws;
  }
  const wsB = await memberSocket(B);
  const seen = [];
  wsB.on('message', (d) => { try { seen.push(JSON.parse(String(d))); } catch { /* ignore */ } });
  wsB.send(JSON.stringify({ type: 'join-server', serverId: sid }));
  wsB.send(JSON.stringify({ type: 'join', channelId: cid }));
  await new Promise((r) => setTimeout(r, 800));
  ok('kickForEvict', (await J('POST', '/api/servers/' + sid + '/kick', { userId: B.id }, A.token)).status === 200);
  await J('POST', '/api/channels/' + cid + '/messages', { content: 'after-kick' }, A.token);
  await new Promise((r) => setTimeout(r, 800));
  ok('evictedSocketSilent', !seen.some((m) => m.type === 'message' && m.content === 'after-kick'),
    'got=' + JSON.stringify(seen.map((m) => m.type)).slice(0, 120));
  try { wsB.close(); } catch { /* ignore */ }

  // cleanup
  ok('deleteServer', (await J('DELETE', '/api/servers/' + sid, null, A.token)).status === 200);
  console.log('F1F2 pass=' + pass + ' fail=' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FATAL: ' + (e && e.stack ? e.stack : e)); process.exit(1); });
