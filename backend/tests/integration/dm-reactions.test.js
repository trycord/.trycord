// Feelings on direct messages.
//
// A conversation's messages carry the same feelings a channel's do, on the
// same terms: a member of the conversation reacts, only their own feeling
// may be taken off, and a stranger is told nothing — not even that the
// conversation exists.
//
// The rows cannot live in the channel reactions table (its foreign key
// reaches `messages`), so `dm_reactions` holds them, and the history read
// carries the summary beside everything else the row keeps.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startInstance, registerUser } = require('../helpers/instance');

test('reactions on direct messages', async (t) => {
  const instance = await startInstance();
  t.after(() => instance.stop());

  const ada = await registerUser(instance, 'ada');
  const grace = await registerUser(instance, 'grace');
  const alan = await registerUser(instance, 'alan');

  const opened = await ada.post('/api/dms', { userId: grace.user.id });
  assert.equal(opened.status, 200, JSON.stringify(opened.data));
  const conversationId = opened.data.id;

  const sent = await ada.post('/api/dms/' + conversationId + '/messages', { content: 'The work begins' });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  const messageId = sent.data.id;

  await t.test('a member adds a feeling, and the summary answers', async () => {
    const res = await ada.post('/api/dms/' + conversationId + '/messages/' + messageId + '/reactions', { emoji: '👍' });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.deepEqual(res.data, {
      ok: true,
      emoji: '👍',
      reactions: [{ emoji: '👍', count: 1, mine: true, users: [String(ada.user.id)] }],
    });
  });

  await t.test('the same feeling twice is one feeling', async () => {
    const res = await ada.post('/api/dms/' + conversationId + '/messages/' + messageId + '/reactions', { emoji: '👍' });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.reactions[0].count, 1, 'the feeling did not double');
  });

  await t.test('the history read carries the summary', async () => {
    const res = await grace.get('/api/dms/' + conversationId + '/messages');
    assert.equal(res.status, 200, JSON.stringify(res.data));
    const row = (res.data || []).find((m) => m.id === messageId);
    assert.ok(row, 'the message is in the history');
    assert.equal(row.reactions.length, 1, 'the feeling is missing from the history');
    assert.equal(row.reactions[0].count, 1);
    assert.equal(row.reactions[0].mine, false, 'a reader who did not react is told so');
  });

  await t.test('a second member adds their own, and one may be taken off', async () => {
    const added = await grace.post('/api/dms/' + conversationId + '/messages/' + messageId + '/reactions', { emoji: '👍' });
    assert.equal(added.status, 200, JSON.stringify(added.data));
    assert.equal(added.data.reactions[0].count, 2);

    const removed = await grace.delete('/api/dms/' + conversationId + '/messages/' + messageId + '/reactions/' + encodeURIComponent('👍'));
    assert.equal(removed.status, 200, JSON.stringify(removed.data));
    assert.equal(removed.data.reactions[0].count, 1, 'only the caller feeling came off');
  });

  await t.test('only the caller feeling is removed by their delete', async () => {
    // Grace is back in, so the table holds two feelings and Ada's delete can
    // only take the one she owns.
    const back = await grace.post('/api/dms/' + conversationId + '/messages/' + messageId + '/reactions', { emoji: '👍' });
    assert.equal(back.status, 200, JSON.stringify(back.data));
    assert.equal(back.data.reactions[0].count, 2);

    const removed = await ada.delete('/api/dms/' + conversationId + '/messages/' + messageId + '/reactions/' + encodeURIComponent('👍'));
    assert.equal(removed.status, 200, JSON.stringify(removed.data));
    assert.deepEqual(removed.data.reactions, [{
      emoji: '👍', count: 1, mine: false, users: [String(grace.user.id)],
    }]);
  });

  await t.test('a stranger is told nothing', async () => {
    const added = await alan.post('/api/dms/' + conversationId + '/messages/' + messageId + '/reactions', { emoji: '👍' });
    assert.equal(added.status, 404, JSON.stringify(added.data));
    const removed = await alan.delete('/api/dms/' + conversationId + '/messages/' + messageId + '/reactions/' + encodeURIComponent('👍'));
    assert.equal(removed.status, 404, JSON.stringify(removed.data));
  });

  await t.test('a message from another conversation is not reachable', async () => {
    const other = await ada.post('/api/dms', { userId: alan.user.id });
    assert.equal(other.status, 200, JSON.stringify(other.data));

    const res = await alan.post('/api/dms/' + other.data.id + '/messages/' + messageId + '/reactions', { emoji: '👍' });
    assert.equal(res.status, 404, JSON.stringify(res.data));
  });

  await t.test('a feeling that is not a feeling is refused', async () => {
    const res = await ada.post('/api/dms/' + conversationId + '/messages/' + messageId + '/reactions', { emoji: 'not a feeling at all, and long' });
    assert.equal(res.status, 400, JSON.stringify(res.data));
  });

  await t.test('a message that does not exist is a not-found', async () => {
    const res = await ada.post('/api/dms/' + conversationId + '/messages/no-such-message/reactions', { emoji: '👍' });
    assert.equal(res.status, 404, JSON.stringify(res.data));
  });
});
