// Spaces: what a space holds, and who may see it.
//
// A space is a group of references. The two rules under test are that a
// private space is invisible to the members who do not hold its role, and
// that a space never widens access: a channel a member may not take part in
// is not listed for them, even when the space itself is public.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  startWorkspace, createCommunity, addMember, createRole, assignRole, channelsOf, registerUser,
} = require('./helpers');

test('spaces', async (t) => {
  const ws = await startWorkspace();
  t.after(() => ws.stop());

  const owner = await registerUser(ws, 'ada');
  const serverId = await createCommunity(ws, owner, 'Spaces');
  const member = await addMember(ws, owner, serverId, 'bob');

  await t.test('a space holds references to channels, documents and links', async () => {
    const created = await owner.post(`/api/servers/${serverId}/spaces`, {
      name: 'Project',
      description: 'Everything about the project',
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const spaceId = created.data.id;
    assert.equal(created.data.name, 'Project');
    assert.equal(created.data.isPrivate, false);

    const channels = await channelsOf(owner, serverId);
    const channelId = channels[0].id;

    const document = await owner.post(`/api/servers/${serverId}/documents`, {
      title: 'The plan',
      body: [{ type: 'paragraph', text: 'Ship it.' }],
    });
    assert.equal(document.status, 201, JSON.stringify(document.data));

    const channelItem = await owner.post(`/api/servers/${serverId}/spaces/${spaceId}/items`, {
      kind: 'channel',
      targetId: channelId,
    });
    assert.equal(channelItem.status, 201, JSON.stringify(channelItem.data));
    assert.equal(channelItem.data.title, channels[0].name, 'the item takes the name of what it points at');

    const documentItem = await owner.post(`/api/servers/${serverId}/spaces/${spaceId}/items`, {
      kind: 'document',
      targetId: document.data.id,
    });
    assert.equal(documentItem.status, 201, JSON.stringify(documentItem.data));

    const resourceItem = await owner.post(`/api/servers/${serverId}/spaces/${spaceId}/items`, {
      kind: 'resource',
      url: 'https://example.org/handbook',
      title: 'Handbook',
    });
    assert.equal(resourceItem.status, 201, JSON.stringify(resourceItem.data));

    const read = await owner.get(`/api/servers/${serverId}/spaces/${spaceId}`);
    assert.equal(read.status, 200);
    assert.equal(read.data.items.length, 3);
    assert.deepEqual(
      read.data.items.map((i) => i.kind).sort(),
      ['channel', 'document', 'resource']
    );

    // The member sees the space too: it is public.
    const asMember = await member.get(`/api/servers/${serverId}/spaces`);
    assert.equal(asMember.status, 200);
    assert.ok(asMember.data.some((s) => s.id === spaceId));
  });

  await t.test('a reference to something outside the community is refused', async () => {
    const spaces = await owner.get(`/api/servers/${serverId}/spaces`);
    const spaceId = spaces.data[0].id;
    const other = await createCommunity(ws, owner, 'Elsewhere');
    const otherChannels = await channelsOf(owner, other);
    const res = await owner.post(`/api/servers/${serverId}/spaces/${spaceId}/items`, {
      kind: 'channel',
      targetId: otherChannels[0].id,
    });
    assert.equal(res.status, 404);
    assert.equal(res.data.error.code, 'NOT_FOUND');
  });

  await t.test('a private space is not visible to a member without the role', async () => {
    const role = await createRole(owner, serverId, 'Leads');

    const priv = await owner.post(`/api/servers/${serverId}/spaces`, {
      name: 'Leads only',
      isPrivate: true,
      requiredRoleId: role.id,
    });
    assert.equal(priv.status, 201, JSON.stringify(priv.data));
    assert.equal(priv.data.isPrivate, true);

    const list = await member.get(`/api/servers/${serverId}/spaces`);
    assert.equal(list.status, 200);
    assert.ok(
      !list.data.some((s) => s.id === priv.data.id),
      'a member without the role does not see the private space'
    );

    const one = await member.get(`/api/servers/${serverId}/spaces/${priv.data.id}`);
    assert.equal(one.status, 404, 'the private space is not addressable either');

    // With the role, the member sees it.
    await assignRole(owner, serverId, role.id, member.user.id);
    const after = await member.get(`/api/servers/${serverId}/spaces`);
    assert.ok(after.data.some((s) => s.id === priv.data.id), 'the role opens the space');
  });

  await t.test('a space does not expose a channel a member may not take part in', async () => {
    const created = await owner.post(`/api/servers/${serverId}/channels`, { name: 'restricted' });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    const restricted = created.data.id;

    // The repository's own way of narrowing a channel: an override on the
    // channel itself. Members keep the community permission, and the channel
    // takes it away from them inside that channel.
    const override = await owner.put(
      `/api/servers/${serverId}/channels/${restricted}/overrides/SEND_MESSAGES`,
      { effect: 'deny' }
    );
    assert.equal(override.status, 200, JSON.stringify(override.data));

    const space = await owner.post(`/api/servers/${serverId}/spaces`, { name: 'With a restricted channel' });
    const spaceId = space.data.id;
    const item = await owner.post(`/api/servers/${serverId}/spaces/${spaceId}/items`, {
      kind: 'channel',
      targetId: restricted,
    });
    assert.equal(item.status, 201, JSON.stringify(item.data));

    const asOwner = await owner.get(`/api/servers/${serverId}/spaces/${spaceId}`);
    assert.ok(
      asOwner.data.items.some((i) => i.targetId === restricted),
      'the owner, who holds every permission, sees the channel'
    );

    const asMember = await member.get(`/api/servers/${serverId}/spaces/${spaceId}`);
    assert.equal(asMember.status, 200);
    assert.ok(
      !asMember.data.items.some((i) => i.targetId === restricted),
      'a member who may not take part in the channel does not see it in the space'
    );
  });

  await t.test('the items of a space can be put in order', async () => {
    const space = await owner.post(`/api/servers/${serverId}/spaces`, { name: 'Ordered' });
    const spaceId = space.data.id;
    const channels = await channelsOf(owner, serverId);
    const first = await owner.post(`/api/servers/${serverId}/spaces/${spaceId}/items`, {
      kind: 'channel',
      targetId: channels[0].id,
    });
    const second = await owner.post(`/api/servers/${serverId}/spaces/${spaceId}/items`, {
      kind: 'resource',
      url: 'https://example.org/handbook',
    });
    const reordered = await owner.post(`/api/servers/${serverId}/spaces/${spaceId}/reorder`, {
      orderedIds: [second.data.id, first.data.id],
    });
    assert.equal(reordered.status, 200, JSON.stringify(reordered.data));
    assert.deepEqual(reordered.data.items.map((i) => i.id), [second.data.id, first.data.id]);

    // A list that does not name exactly the items of the space is refused.
    const wrong = await owner.post(`/api/servers/${serverId}/spaces/${spaceId}/reorder`, {
      orderedIds: [second.data.id],
    });
    assert.equal(wrong.status, 400);
  });

  await t.test('a member of another community is refused', async () => {
    const outsider = await registerUser(ws, 'mallory');
    const list = await outsider.get(`/api/servers/${serverId}/spaces`);
    assert.equal(list.status, 403);
    assert.equal(list.data.error.code, 'NOT_A_MEMBER');
  });
});
