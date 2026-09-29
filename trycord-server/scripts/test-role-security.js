// Role security, tested against the API directly.
//
// The model being enforced:
//   1. A new community has exactly ONE seeded role, @everyone - the baseline
//      every member holds. No "Admin" and no "Moderator" are seeded, because
//      the owner inherits every permission from ownership alone.
//   2. @everyone is the floor: it always exists, cannot be deleted or renamed,
//      stays at the bottom of the hierarchy, and its permissions stay editable
//      because it IS the community's baseline configuration.
//   3. Permission delegation is bounded. You cannot mint a role carrying a
//      permission you do not hold, which is the escalation that turns a limited
//      management grant into full control.
//
// Also re-checks the hierarchy on every mutating verb.
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
const rowsOf = (b) => (Array.isArray(b) ? b : (b.items || b.members || []));

(async () => {
  const legal = (await req('GET', '/api/legal')).body;
  const mk = async (p) => {
    const u = p + Date.now().toString(36).slice(-5) + Math.floor(Math.random() * 900);
    const r = await req('POST', '/api/auth/register', { username: u, password: 'testpass123', termsVersion: legal.termsVersion, privacyVersion: legal.privacyVersion });
    if (r.status !== 200) throw new Error('register ' + r.status);
    await req('POST', '/api/test/self-verify', null, r.body.token);
    return { token: r.body.token, id: r.body.user.id, name: u };
  };

  const owner = await mk('secOwn');
  const mod = await mk('secMod');
  const srv = await req('POST', '/api/servers', { name: 'Role Security', description: 'hierarchy + delegation' }, owner.token);
  const sid = srv.body.serverId;
  const R = '/api/servers/' + sid + '/roles';
  const code = (await req('GET', '/api/servers/' + sid, null, owner.token)).body.join_code;
  await req('POST', '/api/servers/join/' + code, null, mod.token);

  // A moderator role the second user will hold: grants MANAGE_ROLES but not the
  // destructive moderation permissions, so it can be used to prove that
  // delegation is bounded.
  const roles = async (t) => (await req('GET', R, null, t || owner.token)).body;

  // Seeding is asserted BEFORE this test creates anything, or it would be
  // measuring its own fixtures.
  const seeded = await roles();
  console.log('--- seeding: only the baseline, no convenience roles ---');
  ok('a new community is seeded with exactly one role', seeded.length === 1,
    JSON.stringify(seeded.map((r) => r.name)));
  ok('and that role is @everyone', seeded[0] && seeded[0].name === '@everyone',
    JSON.stringify(seeded.map((r) => r.name)));
  ok('no Admin role is seeded', !seeded.some((r) => r.name === 'Admin'),
    JSON.stringify(seeded.map((r) => r.name)));
  ok('no Moderator role is seeded', !seeded.some((r) => r.name === 'Moderator'),
    JSON.stringify(seeded.map((r) => r.name)));
  ok('no seeded role carries every permission', !seeded.some((r) => (r.permissions || []).includes('*')),
    JSON.stringify(seeded.map((r) => r.name + ':' + (r.permissions || []).join(','))));
  ok('@everyone starts with SEND_MESSAGES',
    seeded[0] && (seeded[0].permissions || []).includes('SEND_MESSAGES'),
    JSON.stringify(seeded[0] && seeded[0].permissions));

  const everyone = seeded.find((r) => r.is_default);

  // The owner is not given a role at all: ownership grants every permission.
  const ownerRow0 = rowsOf((await req('GET', '/api/servers/' + sid + '/members?limit=50', null, owner.token)).body)
    .find((m) => String(m.user_id || m.id) === owner.id);
  ok('the owner holds no role, inheriting all permissions from ownership',
    ownerRow0 && (ownerRow0.roles || []).length === 0,
    JSON.stringify((ownerRow0 && ownerRow0.roles || []).map((r) => r.name)));

  const modRole = (await req('POST', R, { name: 'Mod', permissions: ['MANAGE_ROLES', 'KICK_MEMBERS'] }, owner.token)).body;
  await req('POST', R + '/' + modRole.id + '/assign', { userId: mod.id }, owner.token);

  console.log('\n--- @everyone protection ---');
  ok('the community still has an @everyone role', !!everyone, JSON.stringify(seeded.map((r) => r.name)));

  if (everyone) {
    const del = await req('DELETE', R + '/' + everyone.id, null, owner.token);
    ok('@everyone cannot be deleted, not even by the owner', del.status === 400 || del.status === 403,
      String(del.status) + ' ' + JSON.stringify(del.body).slice(0, 120));

    const renamed = await req('PATCH', R + '/' + everyone.id, { name: 'Renamed' }, owner.token);
    ok('@everyone cannot be renamed out of existence',
      !(renamed.status === 200 && renamed.body && renamed.body.name === 'Renamed'),
      String(renamed.status) + ' ' + JSON.stringify(renamed.body).slice(0, 120));

    // It must stay at the bottom: below every other role.
    const all = await roles();
    const lowest = all.slice().sort((a, b) => Number(a.position) - Number(b.position))[0];
    ok('@everyone is the lowest role in the hierarchy', lowest && String(lowest.id) === String(everyone.id),
      JSON.stringify(all.map((r) => r.name + ':' + r.position).sort()));

    // ...but it is the community baseline, so its permissions are configurable.
    const configured = await req('PATCH', R + '/' + everyone.id,
      { permissions: ['SEND_MESSAGES', 'MANAGE_INVITES'] }, owner.token);
    ok('@everyone permissions ARE editable - it is the community baseline',
      configured.status === 200 && (configured.body.permissions || []).includes('MANAGE_INVITES'),
      String(configured.status) + ' ' + JSON.stringify(configured.body).slice(0, 140));

    // Regression: the role editor posts the whole object, so saving ANY change
    // to the baseline arrives with its name attached. That must not be read as
    // a rename - otherwise the baseline can never be configured at all, which
    // is the one thing it exists for.
    const withName = await req('PATCH', R + '/' + everyone.id,
      { name: '@everyone', permissions: ['SEND_MESSAGES', 'MANAGE_INVITES', 'MANAGE_MESSAGES'] }, owner.token);
    ok('saving the baseline with its own name attached still works',
      withName.status === 200 && (withName.body.permissions || []).includes('MANAGE_MESSAGES'),
      String(withName.status) + ' ' + JSON.stringify(withName.body).slice(0, 160));

    const stillNamed = await req('PATCH', R + '/' + everyone.id, { name: 'Renamed' }, owner.token);
    ok('but an actual rename is still refused', stillNamed.status === 400 || stillNamed.status === 403,
      String(stillNamed.status));

    // Put it back so later assertions describe a plain baseline.
    await req('PATCH', R + '/' + everyone.id, { permissions: ['SEND_MESSAGES'] }, owner.token);
  }

  console.log('\n--- permission delegation ---');
  const escalate = await req('POST', R, { name: 'Sneaky', permissions: ['BAN_MEMBERS'] }, mod.token);
  ok('a moderator cannot mint a role granting a permission they lack',
    escalate.status === 403, String(escalate.status) + ' ' + JSON.stringify(escalate.body).slice(0, 140));

  const wildcard = await req('POST', R, { name: 'Wildcard', permissions: ['*'] }, mod.token);
  ok('a moderator cannot mint a role granting *', wildcard.status === 403,
    String(wildcard.status) + ' ' + JSON.stringify(wildcard.body).slice(0, 140));

  // Editing an existing role into an escalation must fail too.
  const own = (await req('POST', R, { name: 'Mine', permissions: [] }, mod.token)).body;
  const widen = await req('PATCH', R + '/' + own.id, { permissions: ['BAN_MEMBERS', 'MANAGE_SERVER'] }, mod.token);
  ok('a moderator cannot widen their own role into new permissions',
    widen.status === 403, String(widen.status) + ' ' + JSON.stringify(widen.body).slice(0, 140));

  const harmless = await req('POST', R, { name: 'Fine', permissions: ['KICK_MEMBERS'] }, mod.token);
  ok('a moderator CAN still mint a role from permissions they hold',
    harmless.status === 200, String(harmless.status) + ' ' + JSON.stringify(harmless.body).slice(0, 120));

  console.log('\n--- hierarchy on every verb ---');
  // A role strictly above the moderator, created explicitly: nothing is seeded
  // above @everyone any more.
  const senior = (await req('POST', R, { name: 'Senior', permissions: ['MANAGE_ROLES', 'BAN_MEMBERS'] }, owner.token)).body;
  const ownerRole = senior || (await roles()).find((r) => (r.permissions || []).includes('*'));
  if (ownerRole) {
    const edit = await req('PATCH', R + '/' + ownerRole.id, { name: 'Hijacked' }, mod.token);
    ok('cannot edit a role at or above own rank', edit.status === 403, String(edit.status));
    const del = await req('DELETE', R + '/' + ownerRole.id, null, mod.token);
    ok('cannot delete a role at or above own rank', del.status === 403, String(del.status));
    const assign = await req('POST', R + '/' + ownerRole.id + '/assign', { userId: mod.id }, mod.token);
    ok('cannot assign a role at or above own rank', assign.status === 403, String(assign.status));
    const strip = await req('DELETE', R + '/' + ownerRole.id + '/assign/' + owner.id, null, mod.token);
    ok('cannot strip a role at or above own rank', strip.status === 403, String(strip.status));
  } else {
    console.log('  (no elevated role found to test against)');
  }

  console.log('\n--- the @everyone role is the baseline every member holds ---');
  const plain = await mk('secPlain');
  await req('POST', '/api/servers/join/' + code, null, plain.token);
  const row = rowsOf((await req('GET', '/api/servers/' + sid + '/members?limit=50', null, owner.token)).body)
    .find((m) => String(m.user_id || m.id) === plain.id);
  // The members endpoint does not echo is_default, so match on the name the
  // community baseline is seeded with.
  ok('a new member is auto-assigned @everyone and nothing else',
    !!(row && (row.roles || []).length === 1 && row.roles[0].name === '@everyone'),
    JSON.stringify((row && row.roles || []).map((r) => r.name)));

  console.log('\nrole-security: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
