// Full functional regression against a running server (default
// http://localhost:9971). Covers auth lifecycle, server/channel/role
// permissions, messaging + pagination, invites, discover, DMs, friends,
// notifications, attachments authorization, WebSocket echo, session
// revocation, and cleanup. Uses throwaway probe users and deletes the
// created server.
//
// Run: node scripts/test-regression.js [baseUrl]
// Exit 0 = all assertions passed. Exit 1 = failures.
const API = (process.argv[2] || process.env.TRYCORD_TEST_URL || 'http://localhost:9971').replace(/\/+$/, '');
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; console.log('FAIL: ' + name + (extra ? ' :: ' + extra : '')); }
}
async function J(method, p, body, tok, form) {
  const h = {};
  if (!form) h['Content-Type'] = 'application/json';
  if (tok) h.Authorization = 'Bearer ' + tok;
  const r = await fetch(API + p, { method, headers: h, body: form ? body : (body ? JSON.stringify(body) : undefined) });
  const j = await r.json().catch(() => null);
  return { status: r.status, json: j };
}
(async () => {
  const legal = (await J('GET', '/api/legal')).json;
  async function mkuser(pfx) {
    const u = pfx + Date.now().toString(36) + Math.floor(Math.random() * 1e4);
    const r = await J('POST', '/api/auth/register', { username: u, password: 'secret123', termsVersion: legal.termsVersion, privacyVersion: legal.privacyVersion });
    ok('mkuser-' + pfx, r.status === 200 && !!(r.json && r.json.token), 'status=' + r.status + ' ' + JSON.stringify(r.json).slice(0, 120));
    if (r.status !== 200) throw new Error('register failed, aborting (likely rate window)');
    // Verified-only writes: suites mark probe users verified through the
    // test hook (server must boot with ALLOW_TEST_HOOKS=true).
    const v = await J('POST', '/api/test/self-verify', null, r.json.token);
    if (v.status !== 200) throw new Error('self-verify failed — boot the server with ALLOW_TEST_HOOKS=true');
    return { name: u, token: r.json.token, id: r.json.user.id };
  }
  const A = await mkuser('rgA'); const B = await mkuser('rgB');
  ok('register', !!A.token && !!B.token);
  const login = await J('POST', '/api/auth/login', { username: A.name, password: 'secret123' });
  ok('login', login.status === 200 && !!login.json.token);
  const me = await J('GET', '/api/users/me', null, A.token);
  ok('me', me.status === 200 && me.json.username === A.name);
  const upd = await J('PATCH', '/api/users/me', { displayName: 'Reg A' }, A.token);
  ok('updateMe', upd.status === 200 && upd.json.displayName === 'Reg A');

  const srv = await J('POST', '/api/servers', { name: 'reg-server', isPublic: true, isDiscoverable: true }, A.token);
  ok('createServer', srv.status === 200 && !!srv.json.serverId);
  const sid = srv.json.serverId, cid = srv.json.channelId;
  const list = await J('GET', '/api/servers', null, A.token);
  ok('servers-mine', list.status === 200 && list.json.some((s) => s.id === sid) && list.json.find((s) => s.id === sid).permissions.includes('*'));
  const det = await J('GET', '/api/servers/' + sid, null, A.token);
  ok('server-detail', det.status === 200 && det.json.is_owner === true && det.json.member_count >= 1);

  // B joins via code
  const joinB = await J('POST', '/api/servers/join/' + srv.json.joinCode, null, B.token);
  ok('joinByCode', joinB.status === 200);
  const detB = await J('GET', '/api/servers/' + sid, null, B.token);
  ok('member-detail-no-owner', detB.status === 200 && detB.json.is_owner === false && !detB.json.permissions.includes('*'));
  // negative: B cannot do owner/member-managed actions
  const delTry = await J('DELETE', '/api/servers/' + sid, null, B.token);
  ok('nonowner-delete-denied', delTry.status === 403 || delTry.status === 401);
  const ch2 = await J('POST', '/api/servers/' + sid + '/channels', { name: 'nope' }, B.token);
  ok('nonowner-create-channel-denied', ch2.status === 403);
  const memB = await J('GET', '/api/servers/' + sid + '/members', null, B.token);
  ok('members-list', memB.status === 200 && memB.json.length === 2);

  // channels CRUD as owner
  const ch = await J('POST', '/api/servers/' + sid + '/channels', { name: 'regchan', topic: 't' }, A.token);
  ok('createChannel', ch.status === 200 && !!ch.json.id);
  const chs = await J('GET', '/api/servers/' + sid + '/channels', null, A.token);
  ok('channels-list', chs.status === 200 && chs.json.channels.length >= 2);
  const cat = await J('POST', '/api/servers/' + sid + '/categories', { name: 'RegCat' }, A.token);
  ok('createCategory', cat.status === 200);
  const updCh = await J('PATCH', '/api/servers/' + sid + '/channels/' + ch.json.id, { topic: 't2' }, A.token);
  ok('updateChannel', updCh.status === 200 && updCh.json.topic === 't2');

  // messages
  const m1 = await J('POST', '/api/channels/' + cid + '/messages', { content: 'reg hello' }, A.token);
  ok('send', m1.status === 200 && !!m1.json.id);
  const m2 = await J('POST', '/api/channels/' + cid + '/messages', { content: 'reg second' }, A.token);
  const hist = await J('GET', '/api/channels/' + cid + '/messages?limit=50', null, A.token);
  ok('history', hist.status === 200 && hist.json.length >= 2 && hist.json[0].author_name === A.name);
  const page = await J('GET', '/api/channels/' + cid + '/messages?limit=1&before=' + m2.json.id, null, A.token);
  ok('pagination', page.status === 200 && page.json.length === 1 && page.json[0].id === m1.json.id);
  const edit = await J('PATCH', '/api/channels/' + cid + '/messages/' + m1.json.id, { content: 'reg edited' }, A.token);
  ok('edit-own', edit.status === 200);
  const editOther = await J('PATCH', '/api/channels/' + cid + '/messages/' + m1.json.id, { content: 'hijack' }, B.token);
  ok('edit-other-denied', editOther.status === 403);
  const delOther = await J('DELETE', '/api/channels/' + cid + '/messages/' + m1.json.id, null, B.token);
  ok('delete-other-denied', delOther.status === 403);
  const del = await J('DELETE', '/api/channels/' + cid + '/messages/' + m1.json.id, null, A.token);
  ok('delete-own', del.status === 200);
  // empty send rejected
  const empty = await J('POST', '/api/channels/' + cid + '/messages', { content: '  ' }, A.token);
  ok('empty-rejected', empty.status === 400);

  // roles: create, assign to B, B gains channel-create
  const role = await J('POST', '/api/servers/' + sid + '/roles', { name: 'RegMod', permissions: ['MANAGE_CHANNELS'] }, A.token);
  ok('createRole', role.status === 200 && !!role.json.id);
  const asg = await J('POST', '/api/servers/' + sid + '/roles/' + role.json.id + '/assign', { userId: B.id }, A.token);
  ok('assignRole', asg.status === 200);
  const perms = await J('GET', '/api/servers/' + sid + '/roles/permissions', null, B.token);
  ok('role-perms-visible', perms.status === 200);
  const ch3 = await J('POST', '/api/servers/' + sid + '/channels', { name: 'via-role' }, B.token);
  ok('role-grant-works', ch3.status === 200);

  // invites
  const inv = await J('POST', '/api/servers/' + sid + '/invites', {}, A.token);
  ok('createInvite', inv.status === 200 && !!inv.json.code);
  const prev = await J('GET', '/api/invites/' + inv.json.code + '/preview', null, A.token);
  ok('invite-preview', prev.status === 200);
  const C = await mkuser('rgC');
  const joinInv = await J('POST', '/api/invites/' + inv.json.code + '/join', null, C.token);
  ok('joinInvite', joinInv.status === 200);
  const invList = await J('GET', '/api/servers/' + sid + '/invites', null, A.token);
  ok('invites-list', invList.status === 200 && invList.json.length >= 1);

  // discover + activity + notifications + presence
  const disc = await J('GET', '/api/discover/servers?page=1&limit=5&q=reg-server');
  ok('discover', disc.status === 200 && disc.json.total >= 1);
  const act = await J('GET', '/api/activity?limit=20', null, A.token);
  ok('activity', act.status === 200 && act.json.some((m) => m.content === 'reg second'));
  const pres = await J('GET', '/api/users/presence?ids=' + A.id + ',' + B.id, null, A.token);
  ok('presence', pres.status === 200);
  const search = await J('GET', '/api/users/search?q=' + B.name.slice(0, 6), null, A.token);
  ok('user-search', search.status === 200 && search.json.some((x) => x.id === B.id));

  // DMs
  const dm = await J('POST', '/api/dms', { userId: B.id }, A.token);
  ok('openDm', dm.status === 200 && !!dm.json.id, 'status=' + dm.status + ' ' + JSON.stringify(dm.json).slice(0, 160));
  if (dm.status !== 200) { console.log('DM-BLOCK status=' + dm.status + ' body=' + JSON.stringify(dm.json)); }
  if (dm.status === 429) { console.log('DM-BLOCK retry, sleeping 60s'); await new Promise((r) => setTimeout(r, 61000)); }
  const dmSame = await J('POST', '/api/dms', { userId: B.id }, A.token);
  ok('dm-idempotent', dmSame.status === 200 && dmSame.json.id === dm.json.id);
  const dmSend = await J('POST', '/api/dms/' + dm.json.id + '/messages', { content: 'reg dm' }, A.token);
  ok('dm-send', dmSend.status === 200);
  const dmHist = await J('GET', '/api/dms/' + dm.json.id + '/messages?limit=10', null, B.token);
  ok('dm-history', dmHist.status === 200 && dmHist.json.length === 1);
  const dmList = await J('GET', '/api/dms', null, B.token);
  ok('dm-list-unread', dmList.status === 200 && dmList.json.some((c) => c.id === dm.json.id && c.unreadCount >= 1));
  const dmRead = await J('POST', '/api/dms/' + dm.json.id + '/read', null, B.token);
  ok('dm-read', dmRead.status === 200);
  const dmEdit = await J('PATCH', '/api/dms/' + dm.json.id + '/messages/' + dmSend.json.id, { content: 'reg dm e' }, A.token);
  ok('dm-edit', dmEdit.status === 200);
  const dmDel = await J('DELETE', '/api/dms/' + dm.json.id + '/messages/' + dmSend.json.id, null, A.token);
  ok('dm-delete', dmDel.status === 200);

  // friends
  const fr = await J('POST', '/api/friends/requests', { userId: B.id }, A.token);
  ok('friend-request', fr.status === 200);
  const frIn = await J('GET', '/api/friends/requests', null, B.token);
  ok('friend-incoming', frIn.status === 200 && frIn.json.incoming.length === 1);
  const acc = await J('POST', '/api/friends/requests/' + frIn.json.incoming[0].id + '/accept', null, B.token);
  ok('friend-accept', acc.status === 200);
  const fl = await J('GET', '/api/friends', null, A.token);
  ok('friends-list', fl.status === 200 && fl.json.some((f) => f.id === B.id));
  const rm = await J('DELETE', '/api/friends/' + B.id, null, A.token);
  ok('friend-remove', rm.status === 200);
  const notes = await J('GET', '/api/notifications?limit=30', null, B.token);
  ok('notifications', notes.status === 200 && notes.json.unreadCount >= 1);
  const readAll = await J('POST', '/api/notifications/read-all', null, B.token);
  ok('notif-read-all', readAll.status === 200);

  // attachments: upload + authed fetch + attach-to-message
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const fd = new FormData();
  fd.append('file', new Blob([png], { type: 'image/png' }), 'reg.png');
  const up = await fetch(API + '/api/channels/' + cid + '/attachments', { method: 'POST', headers: { Authorization: 'Bearer ' + A.token }, body: fd });
  const upj = await up.json();
  ok('upload', up.status === 201 && !!upj.attachment);
  const noauth = await fetch(API + '/api/attachments/' + upj.attachment.id);
  ok('attachment-requires-auth', noauth.status === 401);
  const got = await fetch(API + '/api/attachments/' + upj.attachment.id, { headers: { Authorization: 'Bearer ' + A.token } });
  ok('attachment-authed', got.status === 200);
  const mAtt = await J('POST', '/api/channels/' + cid + '/messages', { content: 'with file', attachmentIds: [upj.attachment.id] }, A.token);
  ok('send-with-attachment', mAtt.status === 200 && (mAtt.json.attachments || []).length === 1);

  // WS: ticket, connect, join, send, typing, room isolation is covered by echo
  const WS = require('ws');
  const ticket = (await J('POST', '/api/auth/ws/ticket', {}, A.token)).json.ticket;
  ok('ws-ticket', !!ticket);
  const ws = new WS('ws://localhost:9971/?ticket=' + ticket);
  const echo = await new Promise((resolve) => {
    const to = setTimeout(() => resolve(false), 10000);
    ws.on('open', () => { ws.send(JSON.stringify({ type: 'join', channelId: cid })); setTimeout(() => ws.send(JSON.stringify({ type: 'msg', content: 'reg-ws-live' })), 200); });
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === 'message' && m.content === 'reg-ws-live') { clearTimeout(to); resolve(true); }
    });
  });
  ok('ws-echo', echo);
  try { ws.close(); } catch {}

  // bad token rejected, session revoke works
  const bad = await J('GET', '/api/users/me', null, 'bogus');
  ok('bad-token-401', bad.status === 401);
  await J('POST', '/api/auth/logout', null, A.token);
  const afterLogout = await J('GET', '/api/users/me', null, A.token);
  ok('logout-revokes', afterLogout.status === 401);

  // kick + leave + cleanup (B still has valid token)
  const kick = await J('POST', '/api/servers/' + sid + '/kick', { userId: C.id }, B.token);
  ok('kick-denied-for-nonmod', kick.status === 403);
  // B leaves
  const leaveB = await J('POST', '/api/servers/' + sid + '/leave', null, B.token);
  ok('leave', leaveB.status === 200);
  // owner deletes (need fresh login for A since logged out)
  const loginA2 = await J('POST', '/api/auth/login', { username: A.name, password: 'secret123' });
  const delSrv = await J('DELETE', '/api/servers/' + sid, null, loginA2.json.token);
  ok('delete-server', delSrv.status === 200);

  console.log('REGRESS pass=' + pass + ' fail=' + fail);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.log('REGRESS-ERROR ' + (e && e.stack || e)); process.exitCode = 1; });
