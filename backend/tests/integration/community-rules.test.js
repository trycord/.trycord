// What a community refuses.
//
// Two rules, both the community's own: slow mode, and the words that may
// not be used.
//
// Both are refused by the server, because a rule the client applies is a
// rule a reader can turn off. And both refuse with a sentence that says
// what happened, because "your message was not allowed" tells a person
// nothing they can act on.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startInstance, registerUser } = require('../helpers/instance');

test('what a community refuses', async (t) => {
  const instance = await startInstance();
  t.after(() => instance.stop());

  const owner = await registerUser(instance, 'owner');
  const member = await registerUser(instance, 'member');

  // A community with a channel to talk in.
  const community = await owner.post('/api/servers', {
    name: 'The rules', description: 'A community with rules.',
  });
  const serverId = community.data.serverId;
  const channel = await owner.post('/api/servers/' + serverId + '/channels', {
    name: 'general', type: 'text',
  });
  const channelId = channel.data.id;

  // The owner is a member of the community they made.
  const join = await member.post('/api/servers/join/' + community.data.joinCode, {});
  assert.ok(join.status < 400, 'the member could not join: ' + JSON.stringify(join.data));

  await t.test('a word can be refused', async () => {
    const added = await owner.post('/api/servers/' + serverId + '/blocked-terms', { term: 'Spamword' });
    assert.equal(added.status, 201, JSON.stringify(added.data));
    assert.deepEqual(added.data.terms, ['spamword'], 'the word is not in the list');

    const said = await member.post('/api/channels/' + channelId + '/messages', {
      content: 'this is Spamword here',
    });
    assert.equal(said.status, 400, 'the word was allowed: ' + JSON.stringify(said.data));
    assert.equal(said.data.error.code, 'BLOCKED_TERM');
    assert.match(said.data.error.message, /spamword/i,
      'the refusal does not name the word: ' + said.data.error.message);
  });

  await t.test('a word inside another word is not the word', async () => {
    const said = await member.post('/api/channels/' + channelId + '/messages', {
      content: 'this is Spamworthy and quite innocent',
    });
    assert.equal(said.status, 200, 'a word inside a word was refused: ' + JSON.stringify(said.data));
  });

  await t.test('the word is refused whatever its case', async () => {
    const said = await member.post('/api/channels/' + channelId + '/messages', {
      content: 'this is SPAMWORD here',
    });
    assert.equal(said.status, 400, 'a capital letter got around the rule');
  });

  await t.test('the word can be taken off the list', async () => {
    const removed = await owner.delete('/api/servers/' + serverId + '/blocked-terms/spamword');
    assert.equal(removed.status, 200, JSON.stringify(removed.data));
    assert.deepEqual(removed.data.terms, [], 'the word is still in the list');

    const said = await member.post('/api/channels/' + channelId + '/messages', {
      content: 'this is Spamword here',
    });
    assert.equal(said.status, 200, 'the word is still refused: ' + JSON.stringify(said.data));
  });

  await t.test('a member cannot change the list', async () => {
    const added = await member.post('/api/servers/' + serverId + '/blocked-terms', { term: 'another' });
    assert.ok(added.status === 403 || added.status === 404,
      'a member changed the list: ' + added.status);
  });

  await t.test('slow mode makes a person wait', async () => {
    const slowed = await owner.patch('/api/servers/' + serverId + '/channels/' + channelId, {
      slowMode: 30,
    });
    assert.equal(slowed.status, 200, JSON.stringify(slowed.data));
    assert.equal(slowed.data.slow_mode, 30, 'the slow mode was not saved');

    // A person who has not spoken yet, so the clock starts with them.
    const speaker = await registerUser(instance, 'speaker');
    await speaker.post('/api/servers/join/' + community.data.joinCode, {});

    const first = await speaker.post('/api/channels/' + channelId + '/messages', {
      content: 'the first message',
    });
    assert.equal(first.status, 200, 'the first message was refused: ' + JSON.stringify(first.data));

    const second = await speaker.post('/api/channels/' + channelId + '/messages', {
      content: 'and the second, too soon',
    });
    assert.equal(second.status, 429, 'slow mode did not hold: ' + JSON.stringify(second.data));
    assert.equal(second.data.error.code, 'SLOW_MODE');
    assert.ok(Number(second.data.error.details && second.data.error.details.waitSeconds) > 0,
      'the refusal does not say how long to wait: ' + JSON.stringify(second.data));
  });

  await t.test('slow mode does not stop somebody else', async () => {
    const other = await registerUser(instance, 'other');
    await other.post('/api/servers/join/' + community.data.joinCode, {});
    const said = await other.post('/api/channels/' + channelId + '/messages', {
      content: 'somebody else speaking',
    });
    assert.equal(said.status, 200, 'slow mode stopped somebody else: ' + JSON.stringify(said.data));
  });

  await t.test('slow mode does not stop a moderator', async () => {
    // A moderator keeps the conversation in order, and slow mode is there to
    // slow a conversation down, not the people who look after it.
    const said = await owner.post('/api/channels/' + channelId + '/messages', {
      content: 'a moderator speaking twice',
    });
    assert.equal(said.status, 200, 'slow mode stopped a moderator: ' + JSON.stringify(said.data));
    const again = await owner.post('/api/channels/' + channelId + '/messages', {
      content: 'and again, right away',
    });
    assert.equal(again.status, 200, 'slow mode stopped a moderator: ' + JSON.stringify(again.data));
  });

  await t.test('slow mode can be turned off', async () => {
    const back = await owner.patch('/api/servers/' + serverId + '/channels/' + channelId, {
      slowMode: 0,
    });
    assert.equal(back.status, 200, JSON.stringify(back.data));
    assert.equal(back.data.slow_mode, 0, 'the slow mode is still on');
  });
});
