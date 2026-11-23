// The community enforcement the console promises, end to end.
//
// The administration console's Communities page offers four decisions -
// suspend, lift, remove, restore - and every one of them has to do what its
// button says on the server's side: the member loses and regains access for
// real, the refusals the server holds (a reason, an explicit removal
// confirmation, a lift with nothing standing) are the refusals the console
// shows, and the record lands in the audit chain.
//
// The field names the console reads off the list are asserted here too, so a
// rename on the server is noticed by a failing test instead of by an empty
// page.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startInstance, apiClient, registerUser } = require('../helpers/instance');

async function createCommunity(owner, name) {
  const res = await owner.post('/api/servers', { name, description: name + ' for enforcement tests' });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data;
}

async function invite(owner, communityId, user) {
  const inv = await owner.post('/api/servers/' + communityId + '/invites', { maxUses: 5 });
  assert.equal(inv.status, 200, JSON.stringify(inv.data));
  const joined = await user.post('/api/invites/' + inv.data.code + '/join', {});
  assert.equal(joined.status, 200, JSON.stringify(joined.data));
}

test('the console community decisions reach the community', async (t) => {
  const instance = await startInstance({ env: { ADMIN_USERNAMES: 'admin' } });
  t.after(() => instance.stop());

  const admin = await registerUser(instance, 'admin');
  const owner = await registerUser(instance, 'owner');
  const member = await registerUser(instance, 'member');

  const community = await createCommunity(owner, 'Enforcement Lab');
  const channelsPath = '/api/servers/' + community.serverId + '/channels';
  await invite(owner, community.serverId, member);

  await t.test('a member can read the community before anything is applied', async () => {
    const before = await member.get(channelsPath);
    assert.equal(before.status, 200, JSON.stringify(before.data));
  });

  let communityId = null;
  await t.test('the list names the fields the console reads', async () => {
    const rows = await admin.get('/api/admin/servers?limit=100');
    assert.equal(rows.status, 200, JSON.stringify(rows.data));
    const mine = (Array.isArray(rows.data) ? rows.data : [])
      .find((s) => s.id === community.serverId);
    assert.ok(mine, 'the community is in the console list');
    assert.equal(mine.enforcementState, null, 'an untouched community reads as untouched');
    assert.equal(mine.memberCount, 2, 'the list counts the members');
    assert.ok(mine.ownerName, 'the list names the owner');
    communityId = mine.id;
  });

  await t.test('a suspension without a reason is refused', async () => {
    const noReason = await admin.post('/api/admin/servers/' + communityId + '/suspend', {});
    assert.equal(noReason.status, 400, JSON.stringify(noReason.data));
  });

  await t.test('a removal without its confirmation is refused', async () => {
    const noConfirm = await admin.post('/api/admin/servers/' + communityId + '/remove', {
      reason: 'Trying to remove without saying so',
    });
    assert.equal(noConfirm.status, 400, JSON.stringify(noConfirm.data));
  });

  await t.test('a lift with nothing standing is refused', async () => {
    const nothing = await admin.post('/api/admin/servers/' + communityId + '/lift', {
      reason: 'Nothing is enforced here',
    });
    assert.equal(nothing.status, 400, JSON.stringify(nothing.data));
  });

  await t.test('a suspension takes the community out of the reach of members', async () => {
    const suspended = await admin.post('/api/admin/servers/' + communityId + '/suspend', {
      reason: 'A pause while the console is tested',
      expiresInHours: 24,
    });
    assert.equal(suspended.status, 200, JSON.stringify(suspended.data));

    const reach = await member.get(channelsPath);
    assert.equal(reach.status, 403, JSON.stringify(reach.data));
    assert.equal(reach.data.error.code, 'SERVER_SUSPENDED');

    const list = await admin.get('/api/admin/servers?state=ENFORCED&limit=100');
    assert.equal(list.status, 200, JSON.stringify(list.data));
    const enforced = (Array.isArray(list.data) ? list.data : []).find((s) => s.id === communityId);
    assert.ok(enforced, 'the enforced filter carries the suspended community');
    assert.equal(enforced.enforcementState, 'suspended');

    const detail = await admin.get('/api/admin/servers/' + communityId);
    assert.equal(detail.status, 200, JSON.stringify(detail.data));
    assert.equal(detail.data.enforcement.state, 'suspended');
    assert.equal(detail.data.enforcement.reason, 'A pause while the console is tested');
  });

  await t.test('a lift hands the community back to its members', async () => {
    const lifted = await admin.post('/api/admin/servers/' + communityId + '/lift', {
      reason: 'The pause is no longer needed.',
    });
    assert.equal(lifted.status, 200, JSON.stringify(lifted.data));

    const reachable = await member.get(channelsPath);
    assert.equal(reachable.status, 200, JSON.stringify(reachable.data));
    // The member's own place was never taken: a suspension closes the door,
    // it does not evict anybody.
    assert.ok(reachable.data && Array.isArray(reachable.data.channels),
      'the channels read back as the record the client reads');
  });

  await t.test('a removal is unreachable to members until it is restored', async () => {
    const removed = await admin.post('/api/admin/servers/' + communityId + '/remove', {
      reason: 'A removal the test will restore',
      confirm: true,
    });
    assert.equal(removed.status, 200, JSON.stringify(removed.data));

    const reach = await member.get(channelsPath);
    assert.equal(reach.status, 403, JSON.stringify(reach.data));
    assert.equal(reach.data.error.code, 'SERVER_REMOVED');

    const restored = await admin.post('/api/admin/servers/' + communityId + '/restore', {
      reason: 'The removal was a mistake of the test.',
    });
    assert.equal(restored.status, 200, JSON.stringify(restored.data));

    const back = await member.get(channelsPath);
    assert.equal(back.status, 200, JSON.stringify(back.data));
  });

  await t.test('the record of all of it verifies in the audit chain', async () => {
    const verify = await admin.get('/api/admin/audit/verify');
    assert.equal(verify.status, 200, JSON.stringify(verify.data));
    assert.equal(verify.data.valid, true, JSON.stringify(verify.data));

    const audit = await admin.get('/api/admin/audit?targetId=' + communityId + '&limit=100');
    assert.equal(audit.status, 200, JSON.stringify(audit.data));
    const actions = (Array.isArray(audit.data) ? audit.data : []).map((row) => row.action);
    assert.ok(actions.includes('MODERATION_SERVER_SUSPENSION'), 'the suspension is recorded');
    assert.ok(actions.includes('ENFORCEMENT_LIFTED'), 'the lift is recorded');
    assert.ok(actions.includes('MODERATION_SERVER_REMOVAL'), 'the removal is recorded');
    assert.ok(actions.includes('SERVER_RESTORED'), 'the restore is recorded');
  });
});

test('a lifted community ban hands the member their place back', async (t) => {
  // The rule the ban took away the member's place and the lift put it back:
  // an approved appeal that left the person outside would restore nothing
  // at all. The ban also takes the roles; the lift deliberately does not
  // hand those back - an operator grants roles again on purpose.
  const instance = await startInstance({ env: { ADMIN_USERNAMES: 'admin' } });
  t.after(() => instance.stop());

  const owner = await registerUser(instance, 'owner');
  const member = await registerUser(instance, 'member');

  const community = await createCommunity(owner, 'Appeal Lab');
  const channelsPath = '/api/servers/' + community.serverId + '/channels';
  await invite(owner, community.serverId, member);

  const before = await member.get(channelsPath);
  assert.equal(before.status, 200, JSON.stringify(before.data));

  const banned = await owner.post('/api/servers/' + community.serverId + '/ban', {
    userId: member.user.id, reason: 'A ban the appeal will overturn',
  });
  assert.equal(banned.status, 200, JSON.stringify(banned.data));

  const whileBanned = await member.get(channelsPath);
  assert.equal(whileBanned.status, 403, 'a banned member is out of the community');

  const eligible = await member.get('/api/appeals/eligible');
  assert.equal(eligible.status, 200, JSON.stringify(eligible.data));
  const item = (Array.isArray(eligible.data) ? eligible.data : []).find((e) => e.serverId === community.serverId);
  assert.ok(item, 'the ban is appealable');

  const submitted = await member.post('/api/appeals', {
    actionId: item.actionId, reason: 'The record does not support this ban.',
  });
  assert.equal(submitted.status, 201, JSON.stringify(submitted.data));

  const queue = await owner.get('/api/servers/' + community.serverId + '/moderation/appeals');
  assert.equal(queue.status, 200, JSON.stringify(queue.data));
  const appeal = (Array.isArray(queue.data) ? queue.data : []).find((a) => a.actionId === item.actionId);
  assert.ok(appeal, 'the appeal reached the community queue');

  const approved = await owner.patch(
    '/api/servers/' + community.serverId + '/moderation/appeals/' + appeal.id,
    { decision: 'APPROVED', note: 'The record does not support the ban.' }
  );
  assert.equal(approved.status, 200, JSON.stringify(approved.data));

  const back = await member.get(channelsPath);
  assert.equal(back.status, 200, JSON.stringify(back.data));
  assert.ok(back.data && Array.isArray(back.data.channels),
    'the member reads the community again without an invitation');
});
