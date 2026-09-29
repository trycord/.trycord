// A community timeout must lock a member out of every write, not just posting.
//
// The gate being enforced: `timeout_expires_at` on a server_members row is the
// only thing that decides this, and it is checked server-side on each verb. The
// client hides the composer as a courtesy, which is exactly why the server
// cannot rely on it - a timed-out member with a stale tab, or anyone calling
// the API directly, would otherwise keep editing and deleting their own
// history. Moderators holding MANAGE_MESSAGES stay exempt, so moderation still
// works on a muted account.
//
// Also covers the per-account storage quota, the other unbounded write.
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
const code = (r) => (r.body && r.body.error && r.body.error.code) || r.status;

(async () => {
  const legal = (await req('GET', '/api/legal')).body;
  const mk = async (p) => {
    const u = p + Date.now().toString(36).slice(-5) + Math.floor(Math.random() * 900);
    const r = await req('POST', '/api/auth/register', { username: u, password: 'testpass123', termsVersion: legal.termsVersion, privacyVersion: legal.privacyVersion });
    if (r.status !== 200) throw new Error('register ' + r.status);
    await req('POST', '/api/test/self-verify', null, r.body.token);
    return { token: r.body.token, id: r.body.user.id, name: u };
  };

  const owner = await mk('toOwn');
  const member = await mk('toMem');
  const outsider = await mk('toOut');
  const srv = await req('POST', '/api/servers', { name: 'Timeout Gates' }, owner.token);
  if (srv.status !== 200) throw new Error('create server ' + srv.status);
  const sid = srv.body.serverId;
  const cid = srv.body.channelId;
  if (!cid) throw new Error('no default channel in create response: ' + JSON.stringify(srv.body));
  const msgs = '/api/channels/' + cid + '/messages';

  const joinCode = (await req('GET', '/api/servers/' + sid, null, owner.token)).body.join_code;
  const joinB = await req('POST', '/api/servers/join/' + joinCode, null, member.token);
  ok('a new member can join by code', joinB.status === 200, 'status ' + joinB.status);
  const posted = await req('POST', msgs, { content: 'before the timeout' }, member.token);
  ok('member can post before the timeout', posted.status === 200, 'status ' + posted.status);
  const mid = posted.body && posted.body.id;

  const ownerPost = await req('POST', msgs, { content: 'owner message' }, owner.token);
  const ownerMid = ownerPost.body.id;
  const ownReact = await req('POST', msgs + '/' + ownerMid + '/reactions', { emoji: '♡' }, owner.token);
  ok('a member can react to a message', ownReact.status === 200, 'status ' + ownReact.status);

  // The control case: an outsider cannot touch a channel they cannot see.
  const outReact = await req('POST', msgs + '/' + ownerMid + '/reactions', { emoji: '♡' }, outsider.token);
  ok('a non-member cannot react', outReact.status !== 200, 'status ' + outReact.status);

  const timed = await req('POST', '/api/servers/' + sid + '/timeout', { userId: member.id, minutes: 30 }, owner.token);
  ok('owner can apply a timeout', timed.status === 200, 'status ' + timed.status);

  const repost = await req('POST', msgs, { content: 'during' }, member.token);
  ok('timed-out member cannot post', repost.status === 403 && code(repost) === 'TIMED_OUT', 'status ' + repost.status + ' ' + code(repost));

  const edit = await req('PATCH', msgs + '/' + mid, { content: 'rewritten during timeout' }, member.token);
  ok('timed-out member cannot edit their own message',
    edit.status === 403 && code(edit) === 'TIMED_OUT', 'status ' + edit.status + ' ' + code(edit));

  const del = await req('DELETE', msgs + '/' + mid, null, member.token);
  ok('timed-out member cannot delete their own message',
    del.status === 403 && code(del) === 'TIMED_OUT', 'status ' + del.status + ' ' + code(del));

  const react = await req('POST', msgs + '/' + mid + '/reactions', { emoji: '♡' }, member.token);
  ok('timed-out member cannot add a reaction',
    react.status === 403 && code(react) === 'TIMED_OUT', 'status ' + react.status + ' ' + code(react));

  // Removing a reaction is the same write as adding one. It is asserted
  // separately because it is a separate handler and the easier one to miss.
  const unreact = await req('DELETE', msgs + '/' + ownerMid + '/reactions/' + encodeURIComponent('♡'), null, member.token);
  ok('timed-out member cannot remove a reaction',
    unreact.status === 403 && code(unreact) === 'TIMED_OUT', 'status ' + unreact.status + ' ' + code(unreact));

  // Moderation must not be collateral damage: a member who can manage messages
  // is still allowed to act, even while timed out.
  const mod = await mk('toMod');
  await req('POST', '/api/servers/join/' + joinCode, null, mod.token);
  const roleBody = (await req('GET', '/api/servers/' + sid + '/roles', null, owner.token)).body;
  const roleList = Array.isArray(roleBody) ? roleBody : (roleBody.roles || roleBody.items || []);
  const everyone = roleList.find((r) => r.isDefault) || roleList[0];
  if (!everyone) throw new Error('no baseline role: ' + JSON.stringify(roleBody));
  const grant = await req('PATCH', '/api/servers/' + sid + '/roles/' + everyone.id, { permissions: ['MANAGE_MESSAGES'] }, owner.token);
  ok('owner can grant MANAGE_MESSAGES to @everyone', grant.status === 200, 'status ' + grant.status);
  await req('POST', '/api/servers/' + sid + '/timeout', { userId: mod.id, minutes: 30 }, owner.token);
  const modDel = await req('DELETE', msgs + '/' + mid, null, mod.token);
  ok('a timed-out moderator with MANAGE_MESSAGES can still moderate',
    modDel.status === 200, 'status ' + modDel.status + ' ' + code(modDel));

  // Storage quota. The observable contract is that usage is reported and that a
  // refusal is a 413 rather than a validation error, so a client can tell a
  // full account apart from a rejected file.
  const q = await req('GET', '/api/attachments/quota', null, member.token);
  ok('quota endpoint reports usage and a positive limit',
    q.status === 200 && typeof q.body.used === 'number' && typeof q.body.limit === 'number' && q.body.limit > 0,
    'status ' + q.status + ' ' + JSON.stringify(q.body));
  ok('quota counts the caller\'s own attachments only', q.body && q.body.used === 0, 'used ' + (q.body && q.body.used));

  console.log('\npass=' + pass + ' fail=' + fail);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
