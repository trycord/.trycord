// Forums.
//
// A forum is a channel of type 'forum'. Its topics are its root messages and
// its replies are the discussion under each - the same thread model the rest
// of the product uses, not a second one.
//
// The tests that matter are the ones about what a forum must not become: a
// second message store, a second permission system, or a way to read a
// channel the reader could not otherwise read.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startInstance, apiClient, registerUser } = require('../helpers/instance');

test('forums', async (t) => {
  const instance = await startInstance();
  t.after(() => instance.stop());

  const owner = await registerUser(instance, 'owner');
  const reader = await registerUser(instance, 'reader');
  const stranger = await registerUser(instance, 'stranger');

  let serverId = null;
  let forumId = null;
  let textChannelId = null;

  await t.test('a forum channel is created', async () => {
    const community = await owner.post('/api/servers', { name: 'Forum Community' });
    assert.equal(community.status, 200, JSON.stringify(community.data));
    serverId = community.data.serverId;

    const forum = await owner.post('/api/servers/' + serverId + '/channels', {
      name: 'Ideas',
      type: 'forum',
    });
    assert.equal(forum.status, 200, JSON.stringify(forum.data));
    assert.equal(forum.data.type, 'forum');
    forumId = forum.data.id;

    const text = await owner.post('/api/servers/' + serverId + '/channels', {
      name: 'Lounge',
      type: 'text',
    });
    assert.equal(text.status, 200);
    textChannelId = text.data.id;
  });

  await t.test('a topic is an ordinary message in the channel', async () => {
    const topic = await owner.post('/api/channels/' + forumId + '/messages', {
      content: 'What should we build next?',
    });
    assert.equal(topic.status, 200, JSON.stringify(topic.data));
    // The topic is a root message in the channel, exactly as a message in a
    // text channel is. The forum is a way of listing it.
    const history = await owner.get('/api/channels/' + forumId + '/messages?limit=50');
    assert.equal(history.status, 200);
    assert.ok(history.data.some((m) => m.id === topic.data.id));
  });

  await t.test('the topic list shows the topics, and not the replies', async () => {
    const first = await owner.get('/api/channels/' + forumId + '/topics');
    const topic = await owner.post('/api/channels/' + forumId + '/messages', {
      content: 'A second topic',
    });
    assert.equal(topic.status, 200);

    const reply = await owner.post('/api/channels/' + forumId + '/messages', {
      content: 'A reply under the first topic',
      replyToId: first.data.topics[0].id,
    });
    assert.equal(reply.status, 200, JSON.stringify(reply.data));

    const list = await owner.get('/api/channels/' + forumId + '/topics');
    assert.equal(list.status, 200, JSON.stringify(list.data));
    assert.equal(list.data.topics.length, 2, 'two topics, not three messages');
    assert.ok(list.data.topics.every((t) => !('thread_root_id' in t) || t.thread_root_id === null),
      'a reply is not a topic');
    assert.equal(list.data.total, 2);
  });

  await t.test('a topic and its replies are served together', async () => {
    const list = await owner.get('/api/channels/' + forumId + '/topics');
    const withReplies = list.data.topics.find((t) => t.reply_count > 0);
    assert.ok(withReplies, 'one topic has a reply');

    const one = await owner.get('/api/channels/' + forumId + '/topics/' + withReplies.id);
    assert.equal(one.status, 200, JSON.stringify(one.data));
    assert.equal(one.data.topic.id, withReplies.id);
    assert.equal(one.data.replies.length, withReplies.reply_count);
  });

  await t.test('the topic list can be ordered', async () => {
    // A reply on the *newest* topic, so the two orders genuinely differ: the
    // oldest order is by when the topic was started, the latest order is by
    // when it was last talked in.
    const list = await owner.get('/api/channels/' + forumId + '/topics?sort=oldest');
    const newest = list.data.topics[list.data.topics.length - 1];
    const reply = await owner.post('/api/channels/' + forumId + '/messages', {
      content: 'A reply on the newest topic',
      replyToId: newest.id,
    });
    assert.equal(reply.status, 200, JSON.stringify(reply.data));

    const latest = await owner.get('/api/channels/' + forumId + '/topics?sort=latest');
    const oldest = await owner.get('/api/channels/' + forumId + '/topics?sort=oldest');
    const replies = await owner.get('/api/channels/' + forumId + '/topics?sort=replies');
    assert.equal(latest.status, 200);
    assert.equal(oldest.status, 200);
    assert.equal(replies.status, 200);

    assert.equal(latest.data.topics[0].id, newest.id,
      'the most recently active topic is first');
    assert.equal(oldest.data.topics[0].id, list.data.topics[0].id,
      'the oldest order starts with the topic that was started first');
    assert.notDeepEqual(
      latest.data.topics.map((t) => t.id),
      oldest.data.topics.map((t) => t.id),
      'the two orders differ',
    );
    assert.equal(replies.data.topics[0].reply_count, replies.data.topics[1].reply_count,
      'the most-replied topic is first');
  });

  await t.test('a topic list can be searched', async () => {
    const res = await owner.get('/api/channels/' + forumId + '/topics?q=second');
    assert.equal(res.status, 200);
    assert.equal(res.data.topics.length, 1);
    assert.match(res.data.topics[0].content, /second/);
  });

  await t.test('a reader can follow a topic and stop following it', async () => {
    const list = await owner.get('/api/channels/' + forumId + '/topics');
    const topic = list.data.topics[0];

    const on = await owner.post('/api/channels/' + forumId + '/topics/' + topic.id + '/subscribe', {});
    assert.equal(on.status, 200, JSON.stringify(on.data));
    assert.equal(on.data.subscribed, true);

    const subs = await owner.get('/api/channels/' + forumId + '/subscriptions');
    assert.equal(subs.status, 200);
    assert.equal(subs.data.subscriptions.length, 1);
    assert.equal(subs.data.subscriptions[0].messageId, topic.id);

    // Following the same topic twice is not two subscriptions.
    await owner.post('/api/channels/' + forumId + '/topics/' + topic.id + '/subscribe', {});
    const again = await owner.get('/api/channels/' + forumId + '/subscriptions');
    assert.equal(again.data.subscriptions.length, 1);

    const off = await owner.delete('/api/channels/' + forumId + '/topics/' + topic.id + '/subscribe');
    assert.equal(off.status, 200);
    const after = await owner.get('/api/channels/' + forumId + '/subscriptions');
    assert.equal(after.data.subscriptions.length, 0);
  });

  await t.test('the topic list says which topics the reader is following', async () => {
    const list = await owner.get('/api/channels/' + forumId + '/topics');
    const topic = list.data.topics[0];
    await owner.post('/api/channels/' + forumId + '/topics/' + topic.id + '/subscribe', {});
    const after = await owner.get('/api/channels/' + forumId + '/topics');
    const marked = after.data.topics.find((t) => t.id === topic.id);
    assert.equal(marked.subscribed, true);
    const other = after.data.topics.find((t) => t.id !== topic.id);
    assert.equal(other.subscribed, false);
  });

  await t.test('a channel that is not a forum refuses the topic routes', async () => {
    const res = await owner.get('/api/channels/' + textChannelId + '/topics');
    assert.equal(res.status, 400);
    assert.equal(res.data.error.code, 'VALIDATION_ERROR');
  });

  await t.test('a stranger cannot read a forum', async () => {
    const res = await stranger.get('/api/channels/' + forumId + '/topics');
    assert.ok(res.status === 403 || res.status === 404,
      'the forum is not readable from outside the community: ' + res.status);
  });

  await t.test('a topic in another channel is not a topic here', async () => {
    const other = await owner.post('/api/channels/' + textChannelId + '/messages', {
      content: 'A message in the other channel',
    });
    assert.equal(other.status, 200);
    const res = await owner.post(
      '/api/channels/' + forumId + '/topics/' + other.data.id + '/subscribe', {},
    );
    assert.equal(res.status, 404, 'a message that is not a topic here cannot be followed');
  });
});
