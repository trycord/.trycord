// Account deletion end to end: the user asks, an administrator reviews, the
// account is erased, and the evidence survives.
//
// The points that matter and are easy to get wrong:
//   - the request type is GDPR and cannot be set by a caller
//   - the password is required to request, and again implied by confirming
//   - identity is anonymised, not hard-deleted, so audit history outlives it
//   - stored objects are actually removed through the storage service
//   - an owned community is handed on, not deleted
//   - the account cannot sign in afterwards
const API = (process.argv[2] || process.env.TRYCORD_TEST_URL || 'http://localhost:9971').replace(/\/+$/, '');

let pass = 0;
let fail = 0;
function ok(label, cond) {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label); }
}

async function call(method, path, token, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, json };
}

(async () => {
  const legal = (await call('GET', '/api/legal')).json;

  async function mkuser(prefix) {
    const u = prefix + Date.now().toString(36).slice(-6) + Math.floor(Math.random() * 900);
    const r = await call('POST', '/api/auth/register', null, {
      username: u, password: 'secret123', displayName: 'D',
      termsVersion: legal.termsVersion, privacyVersion: legal.privacyVersion,
    });
    if (r.status !== 200) throw new Error('register failed: ' + r.status + ' ' + JSON.stringify(r.json));
    await call('POST', '/api/test/self-verify', r.json.token);
    return { name: u, token: r.json.token, id: r.json.user.id };
  }

  // The admin is bootstrapped by the trust & safety suite; create it if needed.
  let adm = await call('POST', '/api/auth/login', null, { username: 'tsadmin', password: 'secret123' });
  if (adm.status !== 200) {
    await call('POST', '/api/auth/register', null, {
      username: 'tsadmin', password: 'secret123',
      termsVersion: legal.termsVersion, privacyVersion: legal.privacyVersion,
    });
    adm = await call('POST', '/api/auth/login', null, { username: 'tsadmin', password: 'secret123' });
  }
  ok('platform admin available', adm.status === 200);
  const admin = adm.json.token;

  const victim = await mkuser('gdprV');
  const heir = await mkuser('gdprH');

  // A community with the victim as owner and the heir as a member.
  const srv = await call('POST', '/api/servers', victim.token, { name: 'GDPR Community', description: 'x' });
  ok('community created', srv.status === 200);
  const sid = srv.json.serverId;
  await call('POST', `/api/servers/${sid}/invites`, victim.token, {});
  const inv = await call('GET', `/api/servers/${sid}/invites`, victim.token);
  const code = inv.json && inv.json[0] && inv.json[0].code;
  ok('invite created', !!code);
  if (code) {
    const join = await call('POST', `/api/invites/${code}/join`, heir.token);
    ok('heir joined the community', join.status === 200);
  }

  console.log('requesting deletion');
  let r = await call('GET', '/api/account/deletion', victim.token);
  ok('no request exists yet', r.status === 200 && r.json.request === null);

  r = await call('POST', '/api/account/deletion', victim.token, { confirm: 'DELETE' });
  ok('a password is required', r.status === 400);

  r = await call('POST', '/api/account/deletion', victim.token, { confirm: 'nope', password: 'secret123' });
  ok('the confirm phrase is required', r.status === 400);

  r = await call('POST', '/api/account/deletion', victim.token, { confirm: 'DELETE', password: 'wrong' });
  ok('a wrong password is rejected', r.status === 401 || r.status === 400);

  r = await call('POST', '/api/account/deletion', victim.token, { confirm: 'DELETE', password: 'secret123' });
  ok('a valid request is accepted', r.status === 201);
  ok('the request starts in DELETION_REQUESTED', r.json.request.status === 'DELETION_REQUESTED');
  ok('it is labelled REQUESTED BY GDPR', r.json.request.requestedBy === 'GDPR');

  r = await call('POST', '/api/account/deletion', victim.token, { confirm: 'DELETE', password: 'secret123' });
  ok('a second request is refused', r.status === 409);

  console.log('the request type cannot be chosen by a caller');
  r = await call('POST', '/api/account/deletion', victim.token, {
    confirm: 'DELETE', password: 'secret123', requestType: 'MODERATION', request_type: 'MODERATION',
  });
  ok('a second attempt is still refused', r.status === 409);
  r = await call('GET', '/api/account/deletion', victim.token);
  ok('the stored type is still GDPR', r.json.request.requestType === 'GDPR');

  console.log('cancelling');
  r = await call('POST', '/api/account/deletion/cancel', victim.token);
  ok('the user can withdraw', r.status === 200 && r.json.request.status === 'CANCELLED');
  r = await call('POST', '/api/account/deletion', victim.token, { confirm: 'DELETE', password: 'secret123' });
  ok('a cancelled request does not block a new one', r.status === 201);
  const requestId = (await call('GET', '/api/account/deletion', victim.token)).json.request.id;

  console.log('the administrator queue');
  r = await call('GET', '/api/admin/gdpr/requests', heir.token);
  ok('a non-admin is refused', r.status === 401 || r.status === 403);

  r = await call('GET', '/api/admin/gdpr/requests', admin);
  ok('an admin can list requests', r.status === 200);
  const queue = r.json;
  ok('the request appears in the queue', queue.some((x) => x.id === requestId));
  const entry = queue.find((x) => x.id === requestId);
  ok('every queue row is labelled REQUESTED BY GDPR', queue.every((x) => x.requestedBy === 'GDPR'));

  console.log('review and processing');
  r = await call('POST', `/api/admin/gdpr/requests/${requestId}/review`, admin, { decision: 'MAYBE' });
  ok('an unknown decision is refused', r.status === 400);
  r = await call('POST', `/api/admin/gdpr/requests/${requestId}/review`, admin, { decision: 'APPROVE' });
  ok('approve moves it to UNDER_REVIEW', r.status === 200 && r.json.status === 'UNDER_REVIEW');
  r = await call('POST', `/api/admin/gdpr/requests/${requestId}/review`, admin, { decision: 'APPROVE' });
  ok('reviewing twice is refused', r.status === 409);

  r = await call('POST', `/api/admin/gdpr/requests/${requestId}/process`, admin, {});
  ok('processing requires the ERASE confirmation', r.status === 400);

  r = await call('POST', `/api/admin/gdpr/requests/${requestId}/process`, heir.token, { confirm: 'ERASE' });
  ok('a non-admin cannot process', r.status === 401 || r.status === 403);

  r = await call('POST', `/api/admin/gdpr/requests/${requestId}/process`, admin, { confirm: 'ERASE' });
  ok('processing succeeds', r.status === 200);
  const report = r.json.report;
  ok('the report names the erased account', report && report.userId === victim.id);
  ok('the report counts owned objects', report && typeof report.objects === 'number');
  ok('every owned object was removed', report && report.objectFailures.length === 0);
  ok('owned communities were handed on', report && report.communitiesTransferred === 1);
  ok('no community was orphaned', report && report.orphanCommunities.length === 0);

  console.log('after the erase');
  r = await call('POST', '/api/auth/login', null, { username: victim.name, password: 'secret123' });
  ok('the account can no longer sign in', r.status !== 200);

  r = await call('GET', '/api/users/' + victim.id, heir.token);
  ok('the profile resolves but is anonymised', r.status === 200);
  ok('the username is a tombstone', /^deleted-/.test((r.json || {}).username || ''));
  ok('the display name is gone', (r.json || {}).displayName === null || (r.json || {}).displayName === undefined);
  ok('the bio is gone', !(r.json || {}).bio);

  r = await call('GET', '/api/admin/gdpr/requests?status=DELETED', admin);
  ok('the request is now DELETED', r.json.some((x) => x.id === requestId && x.status === 'DELETED'));
  ok('anonymisation is timestamped', !!r.json.find((x) => x.id === requestId).anonymisedAt);

  r = await call('GET', '/api/admin/audit?action=GDPR_ACCOUNT_DELETION_REQUESTED', admin);
  ok('the request is audited', r.status === 200 && r.json.length >= 1);
  r = await call('GET', '/api/admin/audit?action=GDPR_ACCOUNT_DELETION_PROCESSED', admin);
  ok('the processing is audited', r.status === 200 && r.json.length >= 1);
  ok('the audit row survives the erase', r.json.some((x) => x.target_id === victim.id));

  console.log('the community survived with a new owner');
  r = await call('GET', '/api/servers/' + sid, heir.token);
  ok('the heir can still open the community', r.status === 200);
  // detail() returns the server row at the top level, snake_cased, with
  // computed access fields alongside it.
  ok('the heir is the owner', r.status === 200 && r.json.is_owner === true);
  ok('the owner name is the heir, not the tombstone', r.status === 200 && r.json.owner_name === heir.name);

  r = await call('GET', `/api/servers/${sid}/members`, heir.token);
  // The roster is a paged envelope, not a bare array.
  const roster = (r.json && (r.json.items || r.json.members)) || [];
  ok('the roster is readable', r.status === 200);
  ok('the erased account is no longer a member', !roster.some((m) => m.id === victim.id));
  ok('the heir is still a member', roster.some((m) => m.id === heir.id));

  console.log(`\ngdpr-deletion: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
