// Every message that reaches a client has to describe its author.
//
// A row is drawn the moment it arrives, over the socket, and the renderer
// reads the author's name and avatar off the event payload. The history
// reads alias the profile columns; if a live event or a DM row leaves them
// out, the reader sees initials and "Someone" until the next reload - the
// reported "profile pictures not rendering in chat" defect. The channel
// create event carried no author fields at all, the edit event carried no
// face, and the DM history mapper dropped the avatar its own SELECT had
// fetched.
//
// These tests hold every path that produces a message row to the same rule:
// the row names its author, and the avatar field is present - present and
// null (no face chosen) is legitimate, absent is not.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startInstance, registerUser } = require('../helpers/instance');

test('a channel message names its author, with a face', async (t) => {
  const instance = await startInstance();
  t.after(() => instance.stop());

  const owner = await registerUser(instance, 'owner');
  const member = await registerUser(instance, 'member');

  const community = await owner.post('/api/servers', { name: 'Faces' });
  const serverId = community.data.serverId;
  await member.post('/api/servers/join/' + community.data.joinCode, {});

  const category = await owner.post('/api/servers/' + serverId + '/categories', { name: 'Rooms' });
  const made = await owner.post('/api/servers/' + serverId + '/channels', {
    name: 'general', topic: 'The main room.', type: 'text', categoryId: category.data.id,
  });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const channelId = made.data.id;

  await t.test('the create response carries the author block', async () => {
    const res = await member.post('/api/channels/' + channelId + '/messages', { content: 'hello' });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.author_name, member.user.username);
    assert.ok(res.data.author_display, 'a display name is on the row');
    assert.ok('author_avatar' in res.data, 'author_avatar present (null is legitimate, absent is not)');
    assert.ok('author_is_bot' in res.data);
  });

  await t.test('history carries the same block', async () => {
    const res = await member.get('/api/channels/' + channelId + '/messages');
    const rows = Array.isArray(res.data) ? res.data : (res.data.messages || []);
    assert.ok(rows.length >= 1, 'the message is in history');
    const last = rows[rows.length - 1];
    assert.equal(last.author_name, member.user.username);
    assert.ok('author_avatar' in last);
  });

  await t.test('the edit response still carries the author block', async () => {
    const posted = await member.post('/api/channels/' + channelId + '/messages', { content: 'draft' });
    const res = await member.patch(
      '/api/channels/' + channelId + '/messages/' + posted.data.id,
      { content: 'edited' }
    );
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.author_name, member.user.username);
    assert.ok('author_avatar' in res.data, 'an edit must not strip the face the row already has');
  });
});

test('a direct message names its author, with a face', async (t) => {
  const instance = await startInstance();
  t.after(() => instance.stop());

  const alice = await registerUser(instance, 'alice');
  const bob = await registerUser(instance, 'bob');

  const made = await alice.post('/api/dms', { userId: bob.user.id });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const conversationId = made.data.id || made.data.conversationId;

  await t.test('the send response carries the author block', async () => {
    const res = await alice.post('/api/dms/' + conversationId + '/messages', { content: 'hi' });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.authorName, alice.user.username);
    assert.ok('authorAvatar' in res.data, 'authorAvatar present (null is legitimate, absent is not)');
    assert.ok('authorIsBot' in res.data);
  });

  await t.test('dm history carries the same block', async () => {
    const res = await bob.get('/api/dms/' + conversationId + '/messages');
    const rows = Array.isArray(res.data) ? res.data : (res.data.messages || []);
    assert.ok(rows.length >= 1, 'the message is in history');
    const last = rows[rows.length - 1];
    assert.ok('authorAvatar' in last, 'the history mapper must not drop the avatar its query fetched');
    assert.equal(last.authorName, alice.user.username);
  });

  await t.test('the dm edit response still carries the author block', async () => {
    const sent = await alice.post('/api/dms/' + conversationId + '/messages', { content: 'draft' });
    const res = await alice.patch(
      '/api/dms/' + conversationId + '/messages/' + sent.data.id,
      { content: 'edited' }
    );
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.ok('authorAvatar' in res.data);
    assert.equal(res.data.authorName, alice.user.username);
  });
});
