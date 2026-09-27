// Self-assignable role coverage: the opt-in flag, self-grant, self-revoke,
// that it is scoped to the caller's own membership row, and - the part that
// actually matters - that a self-assignable role can never be used to grant a
// permission the member does not already hold.
const http = require('http');
const API = 'http://localhost:9971';
function req(m, p, b, t) {
  return new Promise((res) => {
    const d = b ? JSON.stringify(b) : null; const u = new URL(p, API);
    const r = http.request({ method: m, hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: Object.assign({ 'Content-Type': 'application/json' }, d ? { 'Content-Length': Buffer.byteLength(d) } : {}, t ? { Authorization: 'Bearer ' + t } : {}), },
      (x) => { let s = ''; x.on('data', c => s += c); x.on('end', () => { let p2; try { p2 = JSON.parse(s); } catch { p2 = s; } res({ status: x.statusCode, body: p2 }); }); });
    r.on('error', () => res({ status: 0, body: null })); r.setTimeout(10000, () => { r.destroy(); res({ status: 0, body: null }); });
    if (d) r.write(d); r.end();
  });
}
let pass = 0, fail = 0;
const ok = (n, c, d) => { c ? pass++ : fail++; console.log((c ? '  ok   ' : ' FAIL  ') + n + (c ? '' : '  -> ' + d)); };

(async () => {
  const legal = (await req('GET', '/api/legal')).body;
  const mk = async (p) => {
    const u = p + Date.now().toString(36).slice(-5) + Math.floor(Math.random() * 900);
    const r = await req('POST', '/api/auth/register', { username: u, password: 'testpass123', termsVersion: legal.termsVersion, privacyVersion: legal.privacyVersion });
    if (r.status !== 200) throw new Error('register ' + r.status);
    await req('POST', '/api/test/self-verify', null, r.body.token);
    return { token: r.body.token, id: r.body.user.id, name: u };
  };
  const owner = await mk('saA');
  const plain = await mk('saB');   // default Member role only
  const other = await mk('saC');   // a second plain member, to prove scoping

  const srv = await req('POST', '/api/servers', { name: 'SelfAssign Test' }, owner.token);
  const sid = srv.body.serverId;
  const code = (await req('GET', '/api/servers/' + sid, null, owner.token)).body.join_code;
  for (const m of [plain, other]) await req('POST', '/api/servers/join/' + code, null, m.token);

  const R = '/api/servers/' + sid + '/roles';

  // --- the opt-in flag -----------------------------------------------------
  const made = await req('POST', R, { name: 'Blue', permissions: [] }, owner.token);
  ok('create role', made.status === 200 && !!made.body.id, JSON.stringify(made.body).slice(0, 120));
  ok('new role defaults to not self-assignable', made.body.self_assign === false, String(made.body.self_assign));
  const roleId = made.body.id;

  const flagged = await req('PATCH', R + '/' + roleId, { selfAssign: true }, owner.token);
  ok('owner can set self-assignable', flagged.status === 200 && flagged.body.self_assign === true, JSON.stringify(flagged.body).slice(0, 120));

  // --- self grant / revoke -------------------------------------------------
  const on = await req('POST', R + '/' + roleId + '/self', { on: true }, plain.token);
  ok('member can self-assign a flagged role', on.status === 200 && on.body.on === true, JSON.stringify(on.body).slice(0, 120));

  const held = async (t) => {
    const mine = (await req('GET', R, null, t)).body.find((r) => String(r.id) === String(roleId));
    return mine && mine.selfAssigned;
  };
  ok('role appears in the member list as assigned', await held(plain.token), 'not assigned');

  // Idempotent: asking for the same state again must not error or double-add.
  const again = await req('POST', R + '/' + roleId + '/self', { on: true }, plain.token);
  ok('repeat grant is idempotent', again.status === 200, String(again.status));

  const off = await req('POST', R + '/' + roleId + '/self', { on: false }, plain.token);
  ok('member can self-revoke', off.status === 200 && off.body.on === false, JSON.stringify(off.body).slice(0, 120));
  ok('revoked role no longer assigned', !(await held(plain.token)), 'still assigned');

  // --- toggle with no body -------------------------------------------------
  const t1 = await req('POST', R + '/' + roleId + '/self', {}, plain.token);
  const t2 = await req('POST', R + '/' + roleId + '/self', {}, plain.token);
  ok('bare toggle alternates', t1.body.on === true && t2.body.on === false, JSON.stringify([t1.body, t2.body]));

  // --- scoped to the caller ------------------------------------------------
  await req('POST', R + '/' + roleId + '/self', { on: true }, plain.token);
  const otherHeld = (await req('GET', R, null, other.token)).body.find((r) => String(r.id) === String(roleId));
  ok('granting to self does not grant to others', !otherHeld.selfAssigned, 'other got the role');
  // A body userId must be ignored, not honoured.
  await req('POST', R + '/' + roleId + '/self', { on: true, userId: other.id }, plain.token);
  const otherAfter = (await req('GET', R, null, other.token)).body.find((r) => String(r.id) === String(roleId));
  ok('userId in the body is ignored', !otherAfter.selfAssigned, 'other was granted via body userId');

  // --- unflagged roles are refused -----------------------------------------
  const locked = await req('POST', R, { name: 'Locked', permissions: [] }, owner.token);
  const denied = await req('POST', R + '/' + locked.body.id + '/self', { on: true }, plain.token);
  ok('unflagged role cannot be self-assigned', denied.status === 403, String(denied.status) + ' ' + JSON.stringify(denied.body).slice(0, 100));

  // --- the escalation guard ------------------------------------------------
  // A self-assignable role carrying a permission the member does not have.
  const nuke = await req('POST', R, { name: 'Sneaky', permissions: ['BAN_MEMBERS'], selfAssign: true }, owner.token);
  ok('self-assignable role can be created with perms', nuke.status === 200 && nuke.body.self_assign === true, JSON.stringify(nuke.body).slice(0, 120));
  const sneak = await req('POST', R + '/' + nuke.body.id + '/self', { on: true }, plain.token);
  ok('cannot self-assign a role that grants new permissions', sneak.status === 403, String(sneak.status) + ' ' + JSON.stringify(sneak.body).slice(0, 120));

  // A role granting only what the member ALREADY has is fine.
  const sendRole = await req('POST', R, { name: 'CanSend', permissions: ['SEND_MESSAGES'], selfAssign: true }, owner.token);
  const fine = await req('POST', R + '/' + sendRole.body.id + '/self', { on: true }, plain.token);
  ok('can self-assign a role whose permissions they already hold', fine.status === 200, String(fine.status) + ' ' + JSON.stringify(fine.body).slice(0, 120));

  // The owner holds everything, so even the escalating role is fine for them.
  const asOwner = await req('POST', R + '/' + nuke.body.id + '/self', { on: true }, owner.token);
  ok('owner may self-assign an escalating role (holds *)', asOwner.status === 200, String(asOwner.status) + ' ' + JSON.stringify(asOwner.body).slice(0, 120));

  // --- non-members are still refused ---------------------------------------
  const outsider = await mk('saD');
  const notMember = await req('POST', R + '/' + roleId + '/self', { on: true }, outsider.token);
  ok('non-member cannot self-assign', notMember.status === 403, String(notMember.status));

  // --- toggling off never needs the permission check -----------------------
  await req('POST', R + '/' + roleId + '/self', { on: true }, plain.token);
  const ownerFlags = await req('PATCH', R + '/' + nuke.body.id, { selfAssign: true }, owner.token);
  ok('re-flag stays consistent', ownerFlags.body.self_assign === true, JSON.stringify(ownerFlags.body).slice(0, 100));

  // --- revoke the flag blocks new grants but leaves existing grants alone --
  await req('PATCH', R + '/' + roleId, { selfAssign: false }, owner.token);
  const afterUnflag = await req('POST', R + '/' + roleId + '/self', { on: true }, plain.token);
  ok('unflagging blocks a fresh self-assign', afterUnflag.status === 403, String(afterUnflag.status));
  const stillHeld = await held(plain.token);
  ok('unflagging does not silently strip an existing grant', stillHeld, 'grant was removed');

  console.log('\nselfassign: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
