// Copying a channel.
//
// A community sets up a variant of a channel it already has: a second voice
// room, a channel that is like this one but for another subject. So the copy
// has to carry the settings over - the topic, the type, the category and the
// slow mode - and it must carry nothing else, because the messages stay
// where they were.
//
// And it has to be nameable: two channels called "general" would leave a
// reader unable to tell which is which.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startInstance, registerUser } = require('../helpers/instance');

test('a channel can be copied', async (t) => {
  const instance = await startInstance();
  t.after(() => instance.stop());

  const owner = await registerUser(instance, 'owner');
  const member = await registerUser(instance, 'member');

  const community = await owner.post('/api/servers', {
    name: 'The copies', description: 'A community with copies.',
  });
  const serverId = community.data.serverId;
  await member.post('/api/servers/join/' + community.data.joinCode, {});

  const category = await owner.post('/api/servers/' + serverId + '/categories', {
    name: 'Rooms',
  });
  const categoryId = category.data.id;

  const made = await owner.post('/api/servers/' + serverId + '/channels', {
    name: 'general', topic: 'The main room.', type: 'text', categoryId,
  });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  const channelId = made.data.id;

  await owner.patch('/api/servers/' + serverId + '/channels/' + channelId, { slowMode: 30 });

  // A message, so the copy can be shown not to have carried it over.
  await owner.post('/api/channels/' + channelId + '/messages', { content: 'the first message' });

  await t.test('the copy carries the settings over', async () => {
    const copied = await owner.post('/api/servers/' + serverId + '/channels/' + channelId + '/duplicate', {});
    assert.equal(copied.status, 201, JSON.stringify(copied.data));

    const copy = copied.data;
    assert.equal(copy.name, 'general copy', 'the copy is not nameable: ' + copy.name);
    assert.equal(copy.topic, 'The main room.');
    assert.equal(copy.type, 'text');
    assert.equal(copy.category_id, categoryId, 'the copy lost its category');
    assert.equal(copy.slow_mode, 30, 'the copy lost its slow mode');
    assert.notEqual(copy.id, channelId, 'the copy is the original');
  });

  await t.test('the copy carries no messages over', async () => {
    const copied = await owner.post('/api/servers/' + serverId + '/channels/' + channelId + '/duplicate', {});
    const messages = await owner.get('/api/channels/' + copied.data.id + '/messages');
    const rows = Array.isArray(messages.data) ? messages.data : (messages.data.messages || []);
    assert.equal(rows.length, 0,
      'the copy has messages in it: ' + JSON.stringify(messages.data));
  });

  await t.test('the copy is given a name of its own', async () => {
    const again = await owner.post('/api/servers/' + serverId + '/channels/' + channelId + '/duplicate', {});
    const first = await owner.post('/api/servers/' + serverId + '/channels/' + channelId + '/duplicate', {});
    assert.notEqual(again.data.name, first.data.name,
      'two copies have the same name: ' + again.data.name);
    assert.ok(/^general copy/.test(again.data.name),
      'the copy is not nameable: ' + again.data.name);
  });

  await t.test('a member who cannot manage channels cannot copy one', async () => {
    const copied = await member.post('/api/servers/' + serverId + '/channels/' + channelId + '/duplicate', {});
    assert.ok(copied.status === 403 || copied.status === 404,
      'a member copied a channel: ' + copied.status);
  });

  await t.test('a channel that is not here cannot be copied', async () => {
    const copied = await owner.post('/api/servers/' + serverId + '/channels/there-is-no-such-channel/duplicate', {});
    assert.ok(copied.status === 404 || copied.status === 400,
      'a channel that is not here was copied: ' + copied.status);
  });
});
