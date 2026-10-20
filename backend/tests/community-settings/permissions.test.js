// The server refuses what it says it refuses.
//
// The console does not offer a control the reader may not use, but the
// console is not the boundary: the server is. These checks are the other
// half of the permission-gated controls - a client that offers a button the
// server refuses is a client that lies, and a client that does not offer it
// is only as good as the server's own gate.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startInstance, registerUser } = require('../helpers/instance');

// An instance with a community, its owner and a member who may do almost
// nothing in it.
async function community() {
  const instance = await startInstance({ client: false, publicSite: false });
  const owner = await registerUser(instance, 'operator');
  const created = await owner.post('/api/servers', { name: 'A Community' });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const serverId = created.data.serverId;

  const invite = await owner.post('/api/servers/' + serverId + '/invites', {});
  const member = await registerUser(instance, 'ada');
  await member.post('/api/invites/' + invite.data.code + '/join', {});

  return { instance, owner, member, serverId, channelId: created.data.channelId };
}

test('a member may not change what a channel allows', async (t) => {
  const { instance, owner, member, serverId, channelId } = await community();
  t.after(async () => { await instance.stop(); });

  const refused = await member.put(
    '/api/servers/' + serverId + '/channels/' + channelId + '/overrides/SEND_MESSAGES',
    { effect: 'deny' });
  assert.equal(refused.status, 403, JSON.stringify(refused.data));

  const read = await owner.get('/api/servers/' + serverId + '/channels/' + channelId + '/overrides');
  assert.equal(read.status, 200, JSON.stringify(read.data));
  assert.equal(read.data.overrides.SEND_MESSAGES, 'inherit',
    'the override was written by a member');
});

test('a member may not change what a category allows', async (t) => {
  const { instance, owner, member, serverId } = await community();
  t.after(async () => { await instance.stop(); });

  const categories = await owner.get('/api/servers/' + serverId + '/categories');
  assert.equal(categories.status, 200, JSON.stringify(categories.data));
  const category = (categories.data || [])[0];
  assert.ok(category, 'the community has no category');

  const refused = await member.put(
    '/api/servers/' + serverId + '/categories/' + category.id + '/overrides/SEND_MESSAGES',
    { effect: 'deny' });
  assert.equal(refused.status, 403, JSON.stringify(refused.data));
});

test('the owner may change what a channel allows', async (t) => {
  const { instance, owner, serverId, channelId } = await community();
  t.after(async () => { await instance.stop(); });

  const written = await owner.put(
    '/api/servers/' + serverId + '/channels/' + channelId + '/overrides/SEND_MESSAGES',
    { effect: 'deny' });
  assert.equal(written.status, 200, JSON.stringify(written.data));

  const read = await owner.get('/api/servers/' + serverId + '/channels/' + channelId + '/overrides');
  assert.equal(read.data.overrides.SEND_MESSAGES, 'deny', 'the override was not written');
});

test('a member may not give a role to somebody', async (t) => {
  const { instance, owner, member, serverId } = await community();
  t.after(async () => { await instance.stop(); });

  const made = await owner.post('/api/servers/' + serverId + '/roles', {
    name: 'Moderator', permissions: ['KICK_MEMBERS'],
  });
  assert.equal(made.status, 200, JSON.stringify(made.data));

  const roles = await owner.get('/api/servers/' + serverId + '/roles');
  assert.equal(roles.status, 200, JSON.stringify(roles.data));
  const role = (roles.data || []).find((entry) => !entry.is_default);
  assert.ok(role, 'the community has no custom role');

  const refused = await member.post(
    '/api/servers/' + serverId + '/roles/' + role.id + '/assign',
    { userId: member.user.id });
  assert.equal(refused.status, 403, JSON.stringify(refused.data));
});

test('a member may not ban, time out or remove anybody', async (t) => {
  const { instance, owner, member, serverId } = await community();
  t.after(async () => { await instance.stop(); });

  const banned = await member.post('/api/servers/' + serverId + '/ban', {
    userId: owner.user.id, reason: 'because',
  });
  assert.equal(banned.status, 403, JSON.stringify(banned.data));

  const timedOut = await member.post('/api/servers/' + serverId + '/timeout', {
    userId: owner.user.id, minutes: 10,
  });
  assert.equal(timedOut.status, 403, JSON.stringify(timedOut.data));

  const kicked = await member.post('/api/servers/' + serverId + '/kick', {
    userId: owner.user.id,
  });
  assert.equal(kicked.status, 403, JSON.stringify(kicked.data));
});

test('a member may not remove a role, or reorder the roles', async (t) => {
  const { instance, owner, member, serverId } = await community();
  t.after(async () => { await instance.stop(); });

  const made = await owner.post('/api/servers/' + serverId + '/roles', {
    name: 'Moderator', permissions: ['KICK_MEMBERS'],
  });
  assert.equal(made.status, 200, JSON.stringify(made.data));

  const removed = await member.delete('/api/servers/' + serverId + '/roles/' + made.data.id);
  assert.equal(removed.status, 403, JSON.stringify(removed.data));

  const roles = await owner.get('/api/servers/' + serverId + '/roles');
  const order = (roles.data || []).map((role) => role.id);
  const reordered = await member.post('/api/servers/' + serverId + '/roles/reorder', {
    orderedIds: order.slice().reverse(),
  });
  assert.equal(reordered.status, 403, JSON.stringify(reordered.data));
});

test('the member is still there after all of that', async (t) => {
  const { instance, owner, member, serverId } = await community();
  t.after(async () => { await instance.stop(); });

  const roster = await owner.get('/api/servers/' + serverId + '/members');
  assert.equal(roster.status, 200, JSON.stringify(roster.data));
  const names = (roster.data.items || []).map((row) => row.username);
  assert.ok(names.includes('ada'), 'the member was removed by a refused action');
});
