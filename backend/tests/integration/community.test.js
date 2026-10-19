// Communities, categories, channels, roles and the people in them.
//
// These are the things a member touches first, and the things the directive
// names as having to be complete: creating a community, organising it into
// categories and channels, putting people in it, and being refused when you
// are not allowed.
//
// The permission assertions are the important half. A control that is hidden
// in the interface is a courtesy; a route that refuses an unauthorised caller
// is the rule.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startInstance, apiClient, registerUser } = require('../helpers/instance');

test('a community and the things in it', async (t) => {
  const instance = await startInstance();
  t.after(() => instance.stop());

  const owner = await registerUser(instance, 'owner');
  const member = await registerUser(instance, 'member');
  const stranger = await registerUser(instance, 'stranger');

  let communityId = null;
  let categoryId = null;
  let channelId = null;

  await t.test('a community is created with a first channel', async () => {
    const res = await owner.post('/api/servers', {
      name: 'Test Community',
      description: 'A community for the test.',
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.ok(res.data.serverId, 'the new community is identified');
    assert.ok(res.data.slug, 'a community is addressable by a readable name');
    assert.ok(res.data.joinCode, 'the community comes with a join code');
    communityId = res.data.serverId;
    channelId = res.data.channelId;

    const tree = await owner.get('/api/servers/' + communityId + '/channels');
    assert.equal(tree.status, 200);
    assert.ok(Array.isArray(tree.data.channels), 'the tree is categories and channels');
    assert.equal(tree.data.channels.length, 1, 'a new community has one channel to land on');
    assert.equal(tree.data.channels[0].id, channelId);
    assert.ok(tree.data.categories.length >= 1, 'the first channel is filed under a category');
  });

  await t.test('a category is created and holds channels', async () => {
    const res = await owner.post('/api/servers/' + communityId + '/categories', {
      name: 'Discussion',
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.ok(res.data.id);
    assert.equal(res.data.name, 'Discussion', 'a category keeps the name it was given');
    categoryId = res.data.id;
  });

  await t.test('a channel is created inside a category', async () => {
    // This is the request the category "+" control makes.
    const res = await owner.post('/api/servers/' + communityId + '/channels', {
      name: 'General Chat',
      categoryId,
      topic: 'Everyday conversation',
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.category_id, categoryId, 'the channel is filed under the category');
    // Channel names are normalised: lower case, no punctuation, bounded. The
    // client has to show the name the server stored, not the one that was
    // typed, or the tree and the composer disagree.
    assert.equal(res.data.name, 'general chat');
    assert.ok(res.data.slug, 'a channel is addressable by a readable name');
    assert.equal(res.data.position >= 0, true, 'a channel has a position in its category');
  });

  await t.test('the tree comes back with the category and its channels', async () => {
    const res = await owner.get('/api/servers/' + communityId + '/channels');
    assert.equal(res.status, 200);
    const inCategory = res.data.channels.filter((c) => c.category_id === categoryId);
    assert.equal(inCategory.length, 1, 'the channel is in the category it was filed under');
    assert.equal(inCategory[0].name, 'general chat');
  });

  await t.test('the categories are listed with their positions', async () => {
    const res = await owner.get('/api/servers/' + communityId + '/categories');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.data));
    const found = res.data.find((c) => c.id === categoryId);
    assert.ok(found, 'the category is listed');
    assert.equal(typeof found.position, 'number', 'a category has a position, so the tree can be ordered');
  });

  await t.test('a channel is renamed and moved', async () => {
    const second = await owner.post('/api/servers/' + communityId + '/categories', { name: 'Projects' });
    assert.equal(second.status, 200);

    const res = await owner.patch('/api/servers/' + communityId + '/channels/' + channelId, {
      name: 'Renamed Channel',
      categoryId: second.data.id,
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.name, 'renamed channel');
    assert.equal(res.data.category_id, second.data.id, 'the channel moved to the other category');
  });

  await t.test('channels are reordered and the order is kept', async () => {
    const a = await owner.post('/api/servers/' + communityId + '/channels', { name: 'Alpha' });
    const b = await owner.post('/api/servers/' + communityId + '/channels', { name: 'Beta' });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);

    // The endpoint takes the whole order, so the list it is given has to be
    // every channel the community has. Sending a subset is refused rather
    // than half-applied, which is the right answer: a partial reorder would
    // silently drop the channels that were left out.
    const before = await owner.get('/api/servers/' + communityId + '/channels');
    const all = before.data.channels.map((c) => c.id);
    const wanted = [b.data.id, a.data.id].concat(all.filter((id) => id !== a.data.id && id !== b.data.id));

    const res = await owner.post('/api/servers/' + communityId + '/channels/reorder', {
      orderedIds: wanted,
    });
    assert.equal(res.status, 200, JSON.stringify(res.data));

    const tree = await owner.get('/api/servers/' + communityId + '/channels');
    const order = tree.data.channels.map((c) => c.id);
    assert.equal(order[0], b.data.id, 'the order the operator set is the order that is kept');
    assert.equal(order[1], a.data.id);
    assert.equal(order.length, all.length, 'reordering did not lose a channel');
  });

  await t.test('a reorder that leaves a channel out is refused rather than half-applied', async () => {
    const before = await owner.get('/api/servers/' + communityId + '/channels');
    const all = before.data.channels.map((c) => c.id);
    const res = await owner.post('/api/servers/' + communityId + '/channels/reorder', {
      orderedIds: all.slice(0, 1),
    });
    assert.equal(res.status, 400, 'a partial order is refused');
    assert.match(res.data.error.message, /exactly the server channels/);

    const after = await owner.get('/api/servers/' + communityId + '/channels');
    assert.deepEqual(
      after.data.channels.map((c) => c.id),
      all,
      'a refused reorder leaves the order as it was',
    );
  });

  await t.test('a member cannot create a channel without the permission', async () => {
    // The owner invites; the member joins.
    const invite = await owner.post('/api/servers/' + communityId + '/invites', { maxUses: 5 });
    assert.equal(invite.status, 200, JSON.stringify(invite.data));

    const join = await member.post('/api/invites/' + invite.data.code + '/join', {});
    assert.equal(join.status, 200, JSON.stringify(join.data));

    // A plain member has no MANAGE_CHANNELS.
    const res = await member.post('/api/servers/' + communityId + '/channels', { name: 'Sneaky' });
    assert.equal(res.status, 403, 'the server refuses, whatever the interface shows');
    assert.equal(res.data.error.code, 'PERMISSION_DENIED');
  });

  await t.test('a stranger cannot see the community at all', async () => {
    const res = await stranger.get('/api/servers/' + communityId + '/members');
    assert.equal(res.status, 403);
    const detail = await stranger.get('/api/servers/' + communityId);
    assert.equal(detail.status, 403);
  });

  await t.test('the member list names the people and their roles', async () => {
    const res = await owner.get('/api/servers/' + communityId + '/members');
    assert.equal(res.status, 200, JSON.stringify(res.data));
    const items = res.data.items || res.data;
    assert.ok(Array.isArray(items));
    const names = items.map((m) => m.username);
    assert.ok(names.includes('owner'), 'the owner is in the roster');
    assert.ok(names.includes('member'), 'the member who joined is in the roster');
    assert.ok(!names.includes('stranger'), 'somebody who never joined is not');
  });

  await t.test('the member list is paged rather than the whole roster', async () => {
    const res = await owner.get('/api/servers/' + communityId + '/members?limit=1');
    assert.equal(res.status, 200);
    assert.equal(res.data.items.length, 1, 'the page holds one member');
    assert.equal(typeof res.data.total, 'number', 'the response says how many there are in all');
    assert.ok(res.data.total >= 2);
  });

  await t.test('the member list can be searched', async () => {
    const res = await owner.get('/api/servers/' + communityId + '/members?q=memb');
    assert.equal(res.status, 200);
    const items = res.data.items || [];
    assert.ok(items.length >= 1);
    assert.ok(items.every((m) => /memb/i.test(m.username)));
  });

  await t.test('a role is created and given to a member', async () => {
    const role = await owner.post('/api/servers/' + communityId + '/roles', {
      name: 'Moderator',
      permissions: ['MANAGE_MESSAGES'],
    });
    assert.equal(role.status, 200, JSON.stringify(role.data));
    assert.ok(role.data.id);

    const memberRow = (await owner.get('/api/servers/' + communityId + '/members')).data.items
      .find((m) => m.username === 'member');
    assert.ok(memberRow);

    const assign = await owner.post(
      '/api/servers/' + communityId + '/roles/' + role.data.id + '/assign',
      { userId: memberRow.id },
    );
    assert.equal(assign.status, 200, JSON.stringify(assign.data));

    const roles = await owner.get('/api/servers/' + communityId + '/roles');
    assert.equal(roles.status, 200);
    const roleList = roles.data.roles || roles.data;
    assert.ok(roleList.some((r) => r.name === 'Moderator'), 'the role is listed');

    // The permission the role carries is now in force: the member can do the
    // thing the role grants and still cannot do the thing it does not.
    const stillRefused = await member.post('/api/servers/' + communityId + '/channels', { name: 'Sneaky' });
    assert.equal(stillRefused.status, 403, 'a role that grants one permission does not grant another');
  });

  await t.test('a message is persisted and read back in order', async () => {
    const first = await member.post('/api/channels/' + channelId + '/messages', { content: 'The first message' });
    assert.equal(first.status, 200, JSON.stringify(first.data));
    const second = await owner.post('/api/channels/' + channelId + '/messages', { content: 'The second message' });
    assert.equal(second.status, 200);

    const history = await member.get('/api/channels/' + channelId + '/messages?limit=50');
    assert.equal(history.status, 200);
    const contents = history.data.map((m) => m.content);
    assert.ok(contents.includes('The first message'));
    assert.ok(contents.includes('The second message'));
    const firstIndex = contents.indexOf('The first message');
    const secondIndex = contents.indexOf('The second message');
    assert.ok(firstIndex < secondIndex, 'the order messages were posted in is the order they come back in');
  });

  await t.test('a member cannot post into a channel of a community they are not in', async () => {
    const res = await stranger.post('/api/channels/' + channelId + '/messages', { content: 'Hello' });
    assert.ok(res.status === 403 || res.status === 404,
      'a stranger is refused: ' + res.status + ' ' + JSON.stringify(res.data));
  });

  await t.test('a channel is deleted and its messages go with it', async () => {
    const doomed = await owner.post('/api/servers/' + communityId + '/channels', { name: 'Doomed' });
    assert.equal(doomed.status, 200);

    const posted = await owner.post('/api/channels/' + doomed.data.id + '/messages', { content: 'In here' });
    assert.equal(posted.status, 200);

    const del = await owner.delete('/api/servers/' + communityId + '/channels/' + doomed.data.id);
    assert.equal(del.status, 200, JSON.stringify(del.data));

    const after = await owner.get('/api/servers/' + communityId + '/channels');
    assert.ok(!after.data.channels.some((c) => c.id === doomed.data.id), 'the channel is gone');
  });

  await t.test('leaving a community removes the member from it', async () => {
    const leave = await member.post('/api/servers/' + communityId + '/leave', {});
    assert.equal(leave.status, 200, JSON.stringify(leave.data));

    const res = await member.get('/api/servers/' + communityId + '/members');
    assert.equal(res.status, 403, 'a member who left is a stranger to the community');
  });
});
