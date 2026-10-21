// Group conversations.
//
// A conversation of two people is identified by its pair key. A conversation
// of more than two is a group: it has a name, its readers are its members,
// and anybody in it may add somebody or take somebody out.
//
// The table could always hold a group and nothing could create one. This is
// that, and this is what it must not do:
//
//   - a group cannot be used to reach somebody who has said no to a
//     conversation, because the same gate a one-to-one conversation goes
//     through applies to every person in it;
//   - a conversation of two people cannot lose one of them, because it would
//     not be a conversation any more;
//   - a group is shown by its name, and a group with no name is shown by the
//     people in it, because that is the only thing that says which
//     conversation it is.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startInstance, registerUser } = require('../helpers/instance');

test('a group conversation', async (t) => {
  const instance = await startInstance();
  t.after(() => instance.stop());

  const ada = await registerUser(instance, 'ada');
  const grace = await registerUser(instance, 'grace');
  const alan = await registerUser(instance, 'alan');

  await t.test('a group is created with a name and its people', async () => {
    const res = await ada.post('/api/dms/groups', {
      name: 'The work',
      userIds: [grace.user.id, alan.user.id],
    });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    assert.equal(res.data.name, 'The work');
    assert.equal(res.data.isGroup, true);
    assert.equal(res.data.members.length, 3);
  });

  await t.test('a conversation carries the faces of the people in it', async () => {
    // A conversation list draws a face beside every conversation. The
    // faces come from the server, and a list that shows a name and no face
    // is a list of strangers.
    const created = await ada.post('/api/dms/groups', {
      name: 'The faces',
      userIds: [grace.user.id, alan.user.id],
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));

    const list = await ada.get('/api/dms');
    assert.equal(list.status, 200, JSON.stringify(list.data));
    const conversation = (list.data || []).find((entry) => entry.id === created.data.id);
    assert.ok(conversation, 'the conversation is in the list');
    assert.equal(conversation.isGroup, true);
    for (const member of conversation.members || []) {
      assert.ok('avatarUrl' in member, 'every member carries a picture field');
    }
  });

  await t.test('a group needs a name and somebody else', async () => {
    const nameless = await ada.post('/api/dms/groups', { userIds: [grace.user.id] });
    assert.equal(nameless.status, 400, JSON.stringify(nameless.data));

    const alone = await ada.post('/api/dms/groups', { name: 'Nobody' });
    assert.equal(alone.status, 400, JSON.stringify(alone.data));
  });

  await t.test('the list shows the group by its name', async () => {
    const res = await ada.get('/api/dms');
    assert.equal(res.status, 200, JSON.stringify(res.data));
    const group = res.data.find((entry) => entry.name === 'The work');
    assert.ok(group, 'the group is not in the list: ' + JSON.stringify(res.data));
    assert.equal(group.isGroup, true);
    assert.equal(group.memberCount, 3);
    // A group has no single peer: naming one of its members as "the person
    // you are talking to" would be a lie about a group of three.
    assert.equal(group.peer, null, 'the group has a peer');
  });

  await t.test('a one-to-one conversation still has its peer', async () => {
    await ada.post('/api/dms', { userId: grace.user.id });
    const res = await ada.get('/api/dms');
    const one = res.data.find((entry) => entry.peer && entry.peer.id === grace.user.id);
    assert.ok(one, 'the conversation with one person is not in the list');
    assert.equal(one.isGroup, false);
    assert.equal(one.peer.displayName, 'grace');
  });

  await t.test('the conversation opens with its people', async () => {
    const list = await ada.get('/api/dms');
    const group = list.data.find((entry) => entry.name === 'The work');
    const res = await ada.get('/api/dms/' + group.id);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.isGroup, true);
    assert.equal(res.data.displayName, 'The work');
    assert.equal(res.data.people.length, 3);
    assert.equal(res.data.peer, null);
  });

  await t.test('somebody who is not in it cannot open it', async () => {
    const list = await ada.get('/api/dms');
    const group = list.data.find((entry) => entry.name === 'The work');
    const res = await alan.get('/api/dms/' + group.id);
    // Alan is in this group, so he can. Somebody else cannot.
    assert.equal(res.status, 200);

    const other = await registerUser(instance, 'other');
    const denied = await other.get('/api/dms/' + group.id);
    assert.ok(denied.status === 403 || denied.status === 404,
      'somebody outside the group opened it: ' + denied.status);
  });

  await t.test('somebody joins, and somebody leaves', async () => {
    const list = await ada.get('/api/dms');
    const group = list.data.find((entry) => entry.name === 'The work');
    const newcomer = await registerUser(instance, 'newcomer');

    const added = await ada.post('/api/dms/' + group.id + '/members', { userId: newcomer.user.id });
    assert.equal(added.status, 200, JSON.stringify(added.data));
    assert.equal(added.data.memberCount, 4, 'the person was not added');

    // Somebody who is already in it cannot be added again.
    const again = await ada.post('/api/dms/' + group.id + '/members', { userId: newcomer.user.id });
    assert.equal(again.status, 409, JSON.stringify(again.data));

    const removed = await ada.delete('/api/dms/' + group.id + '/members/' + newcomer.user.id);
    assert.equal(removed.status, 200, JSON.stringify(removed.data));

    // Leaving is a different thing from being taken out, and it has its own
    // address: the member who leaves is the one asking.
    const leaver = await registerUser(instance, 'leaver');
    await ada.post('/api/dms/' + group.id + '/members', { userId: leaver.user.id });
    const left = await leaver.delete('/api/dms/' + group.id + '/members');
    assert.equal(left.status, 200, JSON.stringify(left.data));
  });

  await t.test('a group cannot be used to reach somebody who has said no', async () => {
    const closed = await registerUser(instance, 'closed');
    // This account does not accept conversations from strangers.
    const privacy = await closed.patch('/api/me/privacy', { dms: 'nobody' });
    assert.ok(privacy.status < 400, 'the privacy could not be set: ' + JSON.stringify(privacy.data));

    const res = await ada.post('/api/dms/groups', {
      name: 'Not allowed',
      userIds: [closed.user.id],
    });
    assert.equal(res.status, 403, 'the group was created anyway: ' + JSON.stringify(res.data));
  });

  await t.test('a group is renamed by somebody in it', async () => {
    const list = await ada.get('/api/dms');
    const db = require('../../src/db');
    console.log('THE MEMBERS', JSON.stringify(await db.all('SELECT conversation_id, user_id FROM dm_members')));
    const rows = await db.all(
      "SELECT m.*, c.name AS conv_name, (SELECT COUNT(*) FROM dm_members cm WHERE cm.conversation_id = m.conversation_id) AS member_count "
      + "FROM dm_members m JOIN dm_conversations c ON c.id = m.conversation_id WHERE m.user_id = ?",
      [[ada.user.id]]
    );
    console.log('COUNT', JSON.stringify(await db.all('SELECT COUNT(*) AS n FROM dm_members')));

    const group = list.data.find((entry) => entry.name === 'The work');
    const res = await ada.patch('/api/dms/' + group.id, { name: 'The real work' });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.name, 'The real work');
  });

  await t.test('somebody outside the group cannot rename it', async () => {
    const list = await ada.get('/api/dms');
    const group = list.data.find((entry) => entry.name === 'The real work');
    const other = await registerUser(instance, 'bystander');
    const res = await other.patch('/api/dms/' + group.id, { name: 'Mine now' });
    assert.ok(res.status === 403 || res.status === 404,
      'somebody outside renamed it: ' + JSON.stringify(res.data));
  });

  await t.test('a conversation of two people cannot lose one of them', async () => {
    const res = await ada.post('/api/dms', { userId: grace.user.id });
    const conversationId = res.data.id;
    const left = await ada.delete('/api/dms/' + conversationId + '/members');
    assert.equal(left.status, 400, 'a conversation of two lost one: ' + JSON.stringify(left.data));
  });
});
