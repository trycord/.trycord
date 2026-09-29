// There is no self-assignable role system. This asserts that from the outside:
// the column is gone, the route is gone, and a member cannot reach a role by
// any request shape - including guesses at paths the router does not expose.
//
// A deleted feature that is only disabled still exists. These are the checks
// that would catch it creeping back.
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

(async () => {
  const legal = (await req('GET', '/api/legal')).body;
  const mk = async (p) => {
    const u = p + Date.now().toString(36).slice(-5) + Math.floor(Math.random() * 900);
    const r = await req('POST', '/api/auth/register', { username: u, password: 'testpass123', termsVersion: legal.termsVersion, privacyVersion: legal.privacyVersion });
    if (r.status !== 200) throw new Error('register ' + r.status);
    await req('POST', '/api/test/self-verify', null, r.body.token);
    return { token: r.body.token, id: r.body.user.id, name: u };
  };

  const owner = await mk('noself');
  const member = await mk('noselfM');
  const srv = await req('POST', '/api/servers', { name: 'No Self', description: 'self-assign must not exist' }, owner.token);
  const sid = srv.body.serverId;
  const R = '/api/servers/' + sid + '/roles';
  const code = (await req('GET', '/api/servers/' + sid, null, owner.token)).body.join_code;
  await req('POST', '/api/servers/join/' + code, null, member.token);

  const role = (await req('POST', R, { name: 'Helper', permissions: [] }, owner.token)).body;

  // --- the role resource must not carry the concept ------------------------
  const list = (await req('GET', R, null, owner.token)).body;
  ok('no role exposes a self_assign field', list.every((r) => !('self_assign' in r)),
    JSON.stringify(list.map((r) => Object.keys(r).filter((k) => /self/i.test(k)))));
  ok('no role exposes a selfBlocked field', list.every((r) => !('selfBlocked' in r)),
    JSON.stringify(list.map((r) => Object.keys(r).filter((k) => /self/i.test(k)))));
  ok('the created role has no self_assign', !('self_assign' in role), JSON.stringify(Object.keys(role)));

  // --- creating a role cannot smuggle the flag back in ---------------------
  const smuggled = await req('POST', R, { name: 'Smuggle', permissions: [], selfAssign: true, self_assign: 1 }, owner.token);
  ok('a create that asks for self-assign is simply ignored', smuggled.status === 200 && !('self_assign' in smuggled.body),
    String(smuggled.status) + ' ' + JSON.stringify(smuggled.body).slice(0, 140));
  const patched = await req('PATCH', R + '/' + role.id, { selfAssign: true }, owner.token);
  // 400 "nothing to update" is the correct outcome: the field is not read, so
  // the request carries no changes at all. What matters is that it is not
  // applied - a 200 with self_assign set would be the failure.
  const patchApplied = patched.status === 200 && 'self_assign' in (patched.body || {});
  ok('a patch that asks for self-assign cannot set it', !patchApplied,
    String(patched.status) + ' ' + JSON.stringify(patched.body).slice(0, 140));

  // --- there is no self endpoint, for anybody --------------------------------
  for (const [who, tok] of [['member', member.token], ['owner', owner.token]]) {
    const hit = await req('POST', R + '/' + role.id + '/self', { on: true }, tok);
    ok('the /self route does not exist for the ' + who, hit.status === 404, String(hit.status) + ' ' + JSON.stringify(hit.body).slice(0, 100));
  }
  const toggle = await req('POST', R + '/' + role.id + '/self', null, member.token);
  ok('nor as a bare toggle', toggle.status === 404, String(toggle.status));

  // --- a plain member cannot grant themselves anything ---------------------
  // Assign takes userId in the body, not the path.
  const selfAssignAttempt = await req('POST', R + '/' + role.id + '/assign', { userId: member.id }, member.token);
  ok('a member cannot assign a role to themselves', selfAssignAttempt.status === 403, String(selfAssignAttempt.status));
  const otherVictim = await req('POST', R + '/' + role.id + '/assign', { userId: owner.id }, member.token);
  ok('a member cannot assign a role to anyone else', otherVictim.status === 403, String(otherVictim.status));
  const reorderAttempt = await req('POST', R + '/reorder', { orderedIds: [role.id] }, member.token);
  ok('a member cannot reorder the hierarchy', reorderAttempt.status === 403, String(reorderAttempt.status));
  const createAttempt = await req('POST', R, { name: 'Sneaky', permissions: ['MANAGE_ROLES'] }, member.token);
  ok('a member cannot create a role', createAttempt.status === 403, String(createAttempt.status));
  const stripAttempt = await req('DELETE', R + '/' + role.id + '/assign/' + member.id, null, member.token);
  ok('a member cannot strip a role', stripAttempt.status === 403, String(stripAttempt.status));

  // ...and none of that actually landed.
  const meRow = ((await req('GET', '/api/servers/' + sid + '/members?limit=50', null, owner.token)).body.items || [])
    .find((m) => String(m.user_id || m.id) === String(member.id));
  ok('the member holds only the default role', (meRow.roles || []).length === 1,
    JSON.stringify((meRow.roles || []).map((r) => r.name)));

  // --- staff assignment still works, so this is a removal and not a wipe ----
  const byStaff = await req('POST', R + '/' + role.id + '/assign', { userId: member.id }, owner.token);
  ok('an owner can still assign a role to a member', byStaff.status === 200, String(byStaff.status) + ' ' + JSON.stringify(byStaff.body).slice(0, 100));
  const after = ((await req('GET', '/api/servers/' + sid + '/members?limit=50', null, owner.token)).body.items || [])
    .find((m) => String(m.user_id || m.id) === String(member.id));
  ok('and the member now holds it', (after.roles || []).some((r) => String(r.id) === String(role.id)),
    JSON.stringify((after.roles || []).map((r) => r.name)));
  const removed = await req('DELETE', R + '/' + role.id + '/assign/' + member.id, null, owner.token);
  ok('and staff can take it back off', removed.status === 200, String(removed.status));

  console.log('\nno-self-assign: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
