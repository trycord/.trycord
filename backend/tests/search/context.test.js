// The conversation a search hit came from.
//
// A search answer is a list of lines, and a line on its own is often
// cryptic: "no" means nothing until the line before it is read. So each hit
// carries the messages immediately around it - two before and one after - so
// the reader can see the exchange the hit was part of.
//
// And the neighbours come from the same channel as the hit, so they are
// exactly as visible as the hit: the context adds the lines around a message
// the reader may already see, and never a message they may not.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  startRouted, apiClient, registerUser,
  createCommunity, addMember, createChannel, postMessage,
} = require('../support/harness');

// The index follows a message asynchronously, so a test waits for the row
// rather than guessing how long that takes.
async function waitForIndex(ws, messageId) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const row = await ws.db.get(
      'SELECT COUNT(*) AS n FROM message_search_words WHERE message_id = ?',
      [messageId]
    );
    if (row && row.n) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('the message was never indexed');
}

test('the conversation a search hit came from', async (t) => {
  const ws = await startRouted();
  t.after(() => ws.stop());

  const ada = await registerUser(ws, 'ada');
  const community = await createCommunity(ws, ada, 'Context');
  const bob = await addMember(ws, ada, community.serverId, 'bob');
  const { serverId, channelId } = community;

  // A short exchange, so the hit has neighbours on both sides.
  const before = await postMessage(ada, channelId, 'are we still on for tomorrow');
  await waitForIndex(ws, before.id);
  const beforeTwo = await postMessage(bob, channelId, 'I am bringing the notes');
  await waitForIndex(ws, beforeTwo.id);
  const hit = await postMessage(ada, channelId, 'the venue is booked');
  await waitForIndex(ws, hit.id);
  const after = await postMessage(bob, channelId, 'that is good news');
  await waitForIndex(ws, after.id);

  await t.test('the hit carries the lines around it', async () => {
    const res = await ada.get('/api/search?q=venue');
    assert.equal(res.status, 200, JSON.stringify(res.data));
    const row = res.data.find((entry) => entry.id === hit.id);
    assert.ok(row, 'the hit is not in the answer: ' + JSON.stringify(res.data));

    const context = row.context;
    assert.ok(Array.isArray(context) && context.length,
      'the hit carries no context: ' + JSON.stringify(row));
    const texts = context.map((line) => line.content);
    assert.ok(texts.includes('I am bringing the notes'),
      'the line before is missing: ' + JSON.stringify(texts));
    assert.ok(texts.includes('that is good news'),
      'the line after is missing: ' + JSON.stringify(texts));
  });

  await t.test('the context says who said it', async () => {
    const res = await ada.get('/api/search?q=venue');
    const row = res.data.find((entry) => entry.id === hit.id);
    const names = row.context.map((line) => line.authorName);
    assert.ok(names.every((name) => name && name.length),
      'a line in the context has no author: ' + JSON.stringify(row.context));
  });

  await t.test('the context does not reach past the channel', async () => {
    // A message in another channel is not a neighbour of this one.
    const other = await createChannel(ada, serverId, 'Elsewhere');
    const far = await postMessage(ada, other.id, 'the venue is a different one');
    await waitForIndex(ws, far.id);

    const res = await ada.get('/api/search?q=venue');
    const row = res.data.find((entry) => entry.id === hit.id);
    const texts = (row.context || []).map((line) => line.content);
    assert.ok(!texts.includes('the venue is a different one'),
      'the context reached into another channel: ' + JSON.stringify(texts));
  });

  await t.test('a document carries no context', async () => {
    // A document is not part of a conversation, so there is nothing around it.
    const res = await ada.get('/api/search?q=venue');
    for (const entry of res.data) {
      if (entry.kind === 'document') {
        assert.equal(entry.context, undefined,
          'a document carries a context: ' + JSON.stringify(entry));
      }
    }
  });
});
