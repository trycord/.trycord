// What a member can actually do in a community.
//
// A member's permissions are the sum of the roles they hold, and then the
// overrides on the categories and channels they can see. So the preview has
// to say three things: which roles they hold, what those roles give, and
// where an override makes the answer different - because that is where the
// community has decided to be different from the default.
//
// A person who may post everywhere except in the quiet channel is not a
// person who may post everywhere, and only the override tells the
// difference. So the preview is checked on exactly that case.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startInstance, registerUser } = require('../helpers/instance');

test('what a member can actually do here', async (t) => {
  const instance = await startInstance();
  t.after(() => instance.stop());

  const owner = await registerUser(instance, 'owner');
  const member = await registerUser(instance, 'member');
  const other = await registerUser(instance, 'other');

  const community = await owner.post('/api/servers', {
    name: 'The preview', description: 'A community with a preview.',
  });
  const serverId = community.data.serverId;
  await member.post('/api/servers/join/' + community.data.joinCode, {});
  await other.post('/api/servers/join/' + community.data.joinCode, {});

  // A role that lets somebody post.
  const role = await owner.post('/api/servers/' + serverId + '/roles', {
    name: 'Speakers', permissions: ['SEND_MESSAGES'],
  });
  const roleId = role.data.id;

  // A quiet channel, where speaking is not allowed.
  const quiet = await owner.post('/api/servers/' + serverId + '/channels', {
    name: 'quiet', type: 'text',
  });
  const quietId = quiet.data.id;

  await t.test('the roles a member holds are named', async () => {
    const preview = await owner.get(
      '/api/servers/' + serverId + '/members/' + member.user.id + '/permissions');
    assert.equal(preview.status, 200, JSON.stringify(preview.data));
    assert.equal(preview.data.userId, member.user.id);
    assert.equal(preview.data.isOwner, false);
    // Everybody holds the community's default role, so the roles are named
    // rather than assumed.
    assert.ok(preview.data.roles.length >= 1, 'no roles are shown at all');
    assert.ok(preview.data.roles.every((role) => role.name),
      'a role has no name: ' + JSON.stringify(preview.data.roles));
  });

  await t.test('a role the member holds is shown', async () => {
    const given = await owner.post(
      '/api/servers/' + serverId + '/roles/' + roleId + '/assign',
      { userId: member.user.id });
    assert.ok(given.status < 400, JSON.stringify(given.data));

    const preview = await owner.get(
      '/api/servers/' + serverId + '/members/' + member.user.id + '/permissions');
    assert.ok(preview.data.roles.some((role) => role.name === 'Speakers'),
      'the role is not shown: ' + JSON.stringify(preview.data.roles));
    assert.ok(preview.data.permissions.includes('SEND_MESSAGES'),
      'the role does not give what it says: ' + JSON.stringify(preview.data.permissions));
  });

  await t.test('an override that changes the answer is shown', async () => {
    const denied = await owner.put(
      '/api/servers/' + serverId + '/channels/' + quietId + '/overrides/SEND_MESSAGES',
      { effect: 'deny' });
    assert.ok(denied.status < 400, JSON.stringify(denied.data));

    const preview = await owner.get(
      '/api/servers/' + serverId + '/members/' + member.user.id + '/permissions');
    const quietRow = preview.data.overrides.find((row) => row.channelId === quietId);
    assert.ok(quietRow, 'the override is not shown: ' + JSON.stringify(preview.data.overrides));
    assert.equal(quietRow.channelName, 'quiet');
    const change = quietRow.changed.find((c) => c.permission === 'SEND_MESSAGES');
    assert.ok(change, 'the override does not name the permission: ' + JSON.stringify(quietRow));
    assert.equal(change.effect, 'deny', 'the override says the wrong thing');
  });

  await t.test('a channel with no override is not in the list', async () => {
    const preview = await owner.get(
      '/api/servers/' + serverId + '/members/' + member.user.id + '/permissions');
    const elsewhere = preview.data.overrides.find((row) => row.channelId !== quietId);
    assert.equal(elsewhere, undefined,
      'a channel with no override is in the list: ' + JSON.stringify(preview.data.overrides));
  });

  await t.test('the owner holds everything and is said so plainly', async () => {
    const preview = await owner.get(
      '/api/servers/' + serverId + '/members/' + owner.user.id + '/permissions');
    assert.equal(preview.status, 200, JSON.stringify(preview.data));
    assert.equal(preview.data.isOwner, true);
    assert.deepEqual(preview.data.permissions, ['*'],
      'the owner is not shown as holding everything');
  });

  await t.test('a member who cannot moderate cannot look', async () => {
    const preview = await member.get(
      '/api/servers/' + serverId + '/members/' + other.user.id + '/permissions');
    assert.ok(preview.status === 403 || preview.status === 404,
      'an ordinary member read the preview: ' + preview.status);
  });

  await t.test('somebody who is not in the community has no preview', async () => {
    const outsider = await registerUser(instance, 'outsider');
    const preview = await owner.get(
      '/api/servers/' + serverId + '/members/' + outsider.user.id + '/permissions');
    assert.ok(preview.status === 403 || preview.status === 404,
      'a preview was written for somebody who is not here: ' + preview.status);
  });
});
