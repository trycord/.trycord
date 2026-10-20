// The relay, proved between two instances.
//
// Two instances run side by side: separate databases, separate signing keys,
// separate ports, separate administrative authority. One of them creates a
// community, posts in it, edits, reacts, replies and deletes. The other one
// sees all of it arrive over HTTP as signed events, and keeps it as relayed
// content - never as its own.
//
// The refusals are part of the same exercise. A private community produces
// nothing. A channel the members cannot post in produces nothing. A peer that
// is not trusted receives nothing. A replayed event changes nothing. An event
// signed with the wrong key changes nothing.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { apiClient, registerUser } = require('../helpers/instance');
const {
  startFederatedInstance,
  peerInstances,
  startCapturePeer,
  waitFor,
  sleep,
  eventsAboutMessage,
  discoveryOf,
} = require('./helpers');

// The canonical envelope, as the service signs it: every field except the
// signature and the key id, in a stable order.
function canonical(envelope) {
  const { signature, key_id, ...rest } = envelope;
  return JSON.stringify(rest, Object.keys(rest).sort());
}

// A payload of the shape the protocol expects, for an event a test signs
// itself.
function relayPayload(communityId, channelId, seq) {
  const stamp = new Date().toISOString();
  return {
    origin: {
      instance_id: 'capture-peer',
      actor_id: 'an-actor',
      author_username: 'an-actor',
      author_display_name: 'An Actor',
      community_origin_id: communityId,
      channel_origin_id: channelId,
      message_origin_id: 'a-crafted-message',
      thread_root_origin_id: null,
      occurred_at: stamp,
      seq: seq === undefined ? 1 : seq,
    },
    community: { id: communityId, name: 'Relay Community' },
    channel: { id: channelId, name: 'general', type: 'text' },
    message: {
      id: 'a-crafted-message', content: 'a crafted message',
      created_at: stamp, edited_at: null, deleted_at: null,
    },
  };
}

test('a community relays between two instances', async (t) => {
  const a = await startFederatedInstance('instance-a');
  const b = await startFederatedInstance('instance-b');
  const capture = await startCapturePeer('capture-peer');
  t.after(async () => {
    await capture.stop();
    await a.stop();
    await b.stop();
  });

  const adminA = await registerUser(a, 'operator');
  const adminB = await registerUser(b, 'operator');
  const memberA = await registerUser(a, 'alice');
  await peerInstances(a, b, adminA, adminB);

  // A peer that records what it is sent, so a test can look at the raw
  // envelope and replay one.
  const added = await adminA.post('/api/continuum/instances', {
    id: capture.instanceId, name: 'capture', origin: capture.origin, public_key: capture.publicKey,
  });
  assert.equal(added.status, 201, JSON.stringify(added.data));
  await adminA.patch('/api/continuum/instances/' + capture.instanceId + '/trust', { trust_status: 'trusted' });

  let communityId = null;
  let channelId = null;
  let firstMessageId = null;

  // The relayed messages of the federated community, as the receiving
  // instance holds them.
  const relayed = async () => {
    const res = await adminB.get('/api/continuum/communities/instance-a/' + communityId + '/messages');
    assert.ok(res.ok, 'the relayed messages could not be read: ' + JSON.stringify(res.data));
    return res.data;
  };

  await t.test('a public community is federated and the peer records it', async () => {
    const created = await adminA.post('/api/servers', {
      name: 'Relay Community',
      description: 'A community that lives on instance A.',
      isPublic: true,
    });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    communityId = created.data.serverId;
    channelId = created.data.channelId;

    const remote = await waitFor(async () => {
      const res = await adminB.get('/api/continuum/communities');
      if (!res.ok) return null;
      return res.data.find((c) => c.origin_community_id === communityId) || null;
    }, { message: 'the peer to record the remote community' });

    assert.equal(remote.origin_instance_id, 'instance-a', 'the community says where it lives');
    assert.equal(remote.name, 'Relay Community');
    assert.equal(remote.relationship, 'discovered', 'it is a reference, not a membership');
    assert.ok(
      remote.channels.some((c) => c.id === channelId),
      'the channel the community exposes is listed'
    );

    // The peer's own view of this instance's discovery document agrees.
    const probe = await adminB.get('/api/continuum/probe?origin=' + encodeURIComponent(a.baseUrl));
    assert.ok(probe.ok, JSON.stringify(probe.data));
    const listed = probe.data.discovery.communities.find((c) => c.id === communityId);
    assert.ok(listed, 'the discovery document lists the community this instance federates');
    assert.ok(listed.channels.some((c) => c.id === channelId));

    // A member of the community, so that what is posted is posted by
    // somebody who is allowed to post it.
    const invite = await adminA.post('/api/servers/' + communityId + '/invites', { maxUses: 5 });
    assert.equal(invite.status, 200, JSON.stringify(invite.data));
    const joined = await memberA.post('/api/invites/' + invite.data.code + '/join', {});
    assert.equal(joined.status, 200, JSON.stringify(joined.data));

    // And it is not a community of this instance: a remote community never
    // becomes a local one.
    const mine = await adminB.get('/api/servers');
    assert.ok(
      !mine.data.some((s) => s.id === communityId),
      'the remote community is not a community of the receiving instance'
    );
  });

  await t.test('a message arrives as a relayed message', async () => {
    const posted = await memberA.post('/api/channels/' + channelId + '/messages', {
      content: 'the first relayed message',
    });
    assert.equal(posted.status, 200, JSON.stringify(posted.data));
    firstMessageId = posted.data.id;

    const message = await waitFor(async () => {
      const list = await relayed();
      return list.find((m) => m.origin_message_id === firstMessageId) || null;
    }, { message: 'the message to arrive at the peer' });

    assert.equal(message.content, 'the first relayed message');
    assert.equal(message.relayed, true, 'it is presented as a relayed message');
    assert.equal(message.origin_instance_id, 'instance-a', 'it says where it came from');
    assert.equal(message.origin_channel_id, channelId);
    assert.equal(message.author_username, 'alice', 'the author is the one who wrote it');
    assert.equal(message.author_display_name, 'alice');
    assert.equal(message.created_at, posted.data.created_at, 'the original timestamp is kept');
  });

  await t.test('an edit is relayed', async () => {
    const edited = await memberA.patch('/api/channels/' + channelId + '/messages/' + firstMessageId, {
      content: 'the edited message',
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.data));

    const message = await waitFor(async () => {
      const list = await relayed();
      const found = list.find((m) => m.origin_message_id === firstMessageId);
      return found && found.content === 'the edited message' ? found : null;
    }, { message: 'the edit to arrive at the peer' });

    assert.ok(message.edited_at, 'the relayed copy records that it was an edit');
  });

  await t.test('a reaction is relayed', async () => {
    const reacted = await memberA.post(
      '/api/channels/' + channelId + '/messages/' + firstMessageId + '/reactions',
      { emoji: '👍' }
    );
    assert.equal(reacted.status, 200, JSON.stringify(reacted.data));

    const message = await waitFor(async () => {
      const list = await relayed();
      const found = list.find((m) => m.origin_message_id === firstMessageId);
      return found && found.reactions.length ? found : null;
    }, { message: 'the reaction to arrive at the peer' });

    assert.equal(message.reactions.length, 1);
    assert.equal(message.reactions[0].emoji, '👍');
    assert.equal(message.reactions[0].username, 'alice');
  });

  await t.test('a reply is relayed with the thread it belongs to', async () => {
    const reply = await memberA.post('/api/channels/' + channelId + '/messages', {
      content: 'a reply to the first message',
      replyToId: firstMessageId,
    });
    assert.equal(reply.status, 200, JSON.stringify(reply.data));

    const relayedReply = await waitFor(async () => {
      const list = await relayed();
      return list.find((m) => m.origin_message_id === reply.data.id) || null;
    }, { message: 'the reply to arrive at the peer' });

    assert.equal(relayedReply.thread_root_id, firstMessageId, 'the thread root is the message it hangs from');
    assert.equal(relayedReply.content, 'a reply to the first message');
  });

  await t.test('a deletion is relayed', async () => {
    const removed = await memberA.delete('/api/channels/' + channelId + '/messages/' + firstMessageId);
    assert.equal(removed.status, 200, JSON.stringify(removed.data));

    const message = await waitFor(async () => {
      const list = await relayed();
      const found = list.find((m) => m.origin_message_id === firstMessageId);
      return found && found.deleted ? found : null;
    }, { message: 'the deletion to arrive at the peer' });

    assert.ok(message.deleted_at, 'the relayed copy records the deletion');
    assert.equal(message.content, null, 'the deleted message does not outlive it');
  });

  await t.test('a local member joins a federated community', async () => {
    const bob = await registerUser(b, 'bob');
    const joined = await bob.post('/api/continuum/communities/instance-a/' + communityId + '/join');
    assert.equal(joined.status, 200, JSON.stringify(joined.data));

    const member = await waitFor(async () => {
      const res = await adminA.get('/api/continuum/relay/memberships?community_id=' + communityId);
      if (!res.ok) return null;
      return res.data.find((m) => m.origin_user_id === bob.user.id) || null;
    }, { message: 'the origin to record the remote member' });

    assert.equal(member.state, 'joined');
    assert.equal(member.username, 'bob');
    assert.equal(member.origin_instance_id, 'instance-b');

    // Joining grants no authority over the remote community: the member is
    // not a member of it here, and the origin decides what a member may do.
    const mine = await adminB.get('/api/servers');
    assert.ok(
      !mine.data.some((s) => s.id === communityId),
      'the community the member joined is still not a community of this instance'
    );
    const membership = await bob.get('/api/continuum/memberships');
    assert.equal(membership.status, 200);
    assert.equal(membership.data.length, 1);
    assert.equal(membership.data[0].state, 'joined');
  });

  await t.test('a private community produces no outbound event', async () => {
    const priv = await adminA.post('/api/servers', { name: 'Private Community' });
    assert.equal(priv.status, 200, JSON.stringify(priv.data));
    const posted = await adminA.post('/api/channels/' + priv.data.channelId + '/messages', {
      content: 'words that stay here',
    });
    assert.equal(posted.status, 200, JSON.stringify(posted.data));

    // Give the feed time to notice, and prove it published nothing.
    await sleep(1200);
    const events = await eventsAboutMessage(adminA, posted.data.id);
    assert.equal(events.length, 0, 'a private community produces no outbound event');

    const document = await discoveryOf(a);
    assert.ok(
      !document.communities.some((c) => c.id === priv.data.serverId),
      'a private community is not listed in the discovery document'
    );

    const remote = await adminB.get('/api/continuum/communities');
    assert.ok(
      !remote.data.some((c) => c.origin_community_id === priv.data.serverId),
      'the peer never hears of a private community'
    );
  });

  await t.test('a channel the members cannot post in produces no outbound event', async () => {
    const restricted = await adminA.post('/api/servers/' + communityId + '/channels', {
      name: 'staff only',
    });
    assert.equal(restricted.status, 200, JSON.stringify(restricted.data));

    const denied = await a.modules.permissions.setOverride(
      'channel_permission_overrides', restricted.data.id, 'SEND_MESSAGES', 'deny'
    );
    assert.equal(denied.effect, 'deny');

    // The owner may still post there - ownership grants every permission -
    // and the message still may not leave: the channel is not one the
    // community's members may post in.
    const posted = await adminA.post('/api/channels/' + restricted.data.id + '/messages', {
      content: 'for the staff',
    });
    assert.equal(posted.status, 200, JSON.stringify(posted.data));

    await sleep(1200);
    const events = await eventsAboutMessage(adminA, posted.data.id);
    assert.equal(events.length, 0, 'a restricted channel produces no outbound event');

    const list = await relayed();
    assert.ok(
      !list.some((m) => m.origin_channel_id === restricted.data.id),
      'nothing from a restricted channel arrives at the peer'
    );
  });

  await t.test('an untrusted peer receives nothing', async () => {
    // The peer is set to pending before the message is written, so there is
    // no moment in which it could have been delivered.
    await adminA.patch('/api/continuum/instances/instance-b/trust', { trust_status: 'pending' });
    const posted = await memberA.post('/api/channels/' + channelId + '/messages', {
      content: 'sent to a peer that is not trusted',
    });
    assert.equal(posted.status, 200);
    await sleep(1500);

    const list = await relayed();
    assert.ok(
      !list.some((m) => m.origin_message_id === posted.data.id),
      'a pending peer receives nothing'
    );

    // The outbox does not keep trying: the peer is not a destination.
    const forMessage = await eventsAboutMessage(adminA, posted.data.id);
    assert.equal(forMessage.length, 1, 'the event exists in the outbox');
    const deliveries = await adminA.get('/api/continuum/deliveries?event_id=' + forMessage[0].id);
    assert.ok(deliveries.ok);
    assert.ok(
      !deliveries.data.some((d) => d.instance_id === 'instance-b'),
      'a pending peer is not tried at all'
    );

    await adminA.patch('/api/continuum/instances/instance-b/trust', { trust_status: 'blocked' });
    const blocked = await memberA.post('/api/channels/' + channelId + '/messages', {
      content: 'sent to a peer that is blocked',
    });
    assert.equal(blocked.status, 200);
    await sleep(1500);

    const afterBlock = await relayed();
    assert.ok(
      !afterBlock.some((m) => m.origin_message_id === blocked.data.id),
      'a blocked peer receives nothing'
    );

    const forBlocked = await eventsAboutMessage(adminA, blocked.data.id);
    const blockedDeliveries = await adminA.get('/api/continuum/deliveries?event_id=' + forBlocked[0].id);
    assert.ok(
      !blockedDeliveries.data.some((d) => d.instance_id === 'instance-b'),
      'a blocked peer is not tried at all'
    );

    await adminA.patch('/api/continuum/instances/instance-b/trust', { trust_status: 'trusted' });
  });

  await t.test('a peer that blocks the sender refuses its events', async () => {
    // The peer refuses the sender first, so the event is refused rather than
    // delivered a moment before the block.
    await adminB.patch('/api/continuum/instances/instance-a/trust', { trust_status: 'blocked' });
    const before = await relayed();
    const posted = await memberA.post('/api/channels/' + channelId + '/messages', {
      content: 'sent to a peer that blocked us',
    });
    assert.equal(posted.status, 200);
    await sleep(1500);

    const after = await relayed();
    assert.equal(after.length, before.length, 'a blocked sender changes nothing here');

    await adminB.patch('/api/continuum/instances/instance-a/trust', { trust_status: 'trusted' });
  });

  await t.test('a replayed event is refused and changes nothing', async () => {
    const envelope = await waitFor(async () => capture.envelopeOfKind('message.posted'), {
      message: 'the capture peer to receive a message event',
    });
    const before = await relayed();

    const replayed = await apiClient(b.baseUrl).post('/api/continuum/inbox', envelope);
    assert.equal(replayed.status, 202, JSON.stringify(replayed.data));
    assert.equal(replayed.data.duplicate, true, 'the receiver recognises the replay');

    const after = await relayed();
    assert.equal(after.length, before.length, 'a replayed event produces no second relayed message');
    assert.deepEqual(
      after.map((m) => m.id),
      before.map((m) => m.id),
      'the relayed state is exactly what it was'
    );
  });

  await t.test('a duplicate delivery produces one relayed message', async () => {
    const envelope = capture.envelopeOfKind('message.posted');
    const messageId = envelope.payload.origin.message_origin_id;

    const delivered = await apiClient(b.baseUrl).post('/api/continuum/inbox', envelope);
    assert.equal(delivered.status, 202);
    const again = await apiClient(b.baseUrl).post('/api/continuum/inbox', envelope);
    assert.equal(again.status, 202);

    const list = await relayed();
    const copies = list.filter((m) => m.origin_message_id === messageId);
    assert.equal(copies.length, 1, 'the same event delivered twice is one relayed message');
  });

  await t.test('an event signed with the wrong key is refused', async () => {
    const envelope = capture.envelopeOfKind('message.posted');
    const before = await relayed();

    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    const forged = Object.assign({}, envelope, { id: 'forged-' + Date.now() });
    forged.signature = crypto
      .sign(null, Buffer.from(canonical(forged), 'utf8'), privateKey)
      .toString('base64');

    const res = await apiClient(b.baseUrl).post('/api/continuum/inbox', forged);
    assert.equal(res.status, 400, 'an event signed with the wrong key is refused');
    assert.match(res.data.error.message, /signature/i);

    const after = await relayed();
    assert.equal(after.length, before.length, 'a forged event changes nothing');
  });

  await t.test('an event whose timestamp is outside the accepted window is refused', async () => {
    // The capture peer is a peer of the receiving instance too, so the test
    // can sign an envelope of its own and see what the receiver makes of it.
    const added = await adminB.post('/api/continuum/instances', {
      id: capture.instanceId, name: 'capture', origin: capture.origin, public_key: capture.publicKey,
    });
    assert.equal(added.status, 201, JSON.stringify(added.data));
    await adminB.patch('/api/continuum/instances/' + capture.instanceId + '/trust', { trust_status: 'trusted' });

    const stale = capture.sign({
      id: 'stale-' + Date.now(),
      kind: 'message.posted',
      actor: 'an-actor',
      target: null,
      timestamp: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
      payload: relayPayload(communityId, channelId),
    });
    const res = await apiClient(b.baseUrl).post('/api/continuum/inbox', stale);
    assert.equal(res.status, 400, 'an event from three hours ago is refused');
    assert.match(res.data.error.message, /timestamp/i);
  });

  await t.test('an event whose sequence is not newer than the last one is refused', async () => {
    const first = capture.sign({
      id: 'sequenced-1-' + Date.now(),
      kind: 'message.posted',
      actor: 'an-actor',
      target: null,
      timestamp: new Date().toISOString(),
      payload: relayPayload(communityId, channelId, 7),
    });
    const accepted = await apiClient(b.baseUrl).post('/api/continuum/inbox', first);
    assert.equal(accepted.status, 202, JSON.stringify(accepted.data));

    const older = capture.sign({
      id: 'sequenced-2-' + Date.now(),
      kind: 'message.posted',
      actor: 'an-actor',
      target: null,
      timestamp: new Date().toISOString(),
      payload: relayPayload(communityId, channelId, 6),
    });
    const refused = await apiClient(b.baseUrl).post('/api/continuum/inbox', older);
    assert.equal(refused.status, 400, 'an event that is not newer than the last one is refused');
    assert.match(refused.data.error.message, /sequence/i);
  });

  await t.test('a deletion for a message the peer never saw is a no-op', async () => {
    const applied = await b.modules.inbound.apply({
      instance_id: 'instance-a',
      kind: 'message.deleted',
      event_id: 'an-event',
      payload: {
        origin: {
          instance_id: 'instance-a',
          actor_id: 'somebody',
          author_username: 'somebody',
          author_display_name: 'Somebody',
          community_origin_id: communityId,
          channel_origin_id: channelId,
          message_origin_id: 'never-seen-here',
          thread_root_origin_id: null,
          occurred_at: new Date().toISOString(),
          seq: 900,
        },
        community: { id: communityId, name: 'Relay Community' },
        channel: { id: channelId, name: 'general', type: 'text' },
        message: {
          id: 'never-seen-here', content: null,
          created_at: new Date().toISOString(), edited_at: null, deleted_at: new Date().toISOString(),
        },
      },
    });
    assert.equal(applied.applied, false, 'a deletion for an unknown message changes nothing');
    assert.match(applied.reason, /no such message/);

    const list = await relayed();
    assert.ok(
      !list.some((m) => m.origin_message_id === 'never-seen-here'),
      'no relayed message is created for it'
    );
  });

  await t.test('an event from a peer that was removed is refused', async () => {
    const envelope = capture.envelopeOfKind('message.posted');
    const before = await relayed();

    const removed = await adminB.delete('/api/continuum/instances/instance-a');
    assert.equal(removed.status, 200, JSON.stringify(removed.data));

    const res = await apiClient(b.baseUrl).post('/api/continuum/inbox', envelope);
    assert.equal(res.status, 400, 'an event from an instance that is no longer known is refused');

    const after = await relayed();
    assert.equal(after.length, before.length, 'an event from an unknown instance changes nothing');

    const remote = await adminB.get('/api/continuum/communities');
    const community = remote.data.find((c) => c.origin_community_id === communityId);
    assert.ok(community, 'the community is still on record');
    assert.equal(community.relationship, 'revoked', 'the relationship is over');
  });
});

// The return direction.
//
// A member of a federated community reads it here. This is the other half:
// a member writes in it from here, and the message travels to the instance
// that owns the community.
//
// The owner is the authority. It applies its own rules to what arrives, it
// can refuse, and the refusal reaches the writer. And it can act on what
// was accepted: take the message back, mute the member, remove the member.
test('a member writes in a federated community, and the owner sees it and can act on it', async (t) => {
  const a = await startFederatedInstance('instance-a');
  const b = await startFederatedInstance('instance-b');
  t.after(async () => {
    await a.stop();
    await b.stop();
  });

  const adminA = await registerUser(a, 'operator');
  const adminB = await registerUser(b, 'operator');
  const bob = await registerUser(b, 'bob');
  await peerInstances(a, b, adminA, adminB);

  // The community, on the instance that owns it.
  const created = await adminA.post('/api/servers', {
    name: 'Return Community',
    description: 'A community that lives on instance A.',
    isPublic: true,
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const communityId = created.data.serverId;
  const channelId = created.data.channelId;

  // The other instance learns of it, and one of our accounts joins it.
  await waitFor(async () => {
    const res = await adminB.get('/api/continuum/communities');
    if (!res.ok) return null;
    return res.data.find((c) => c.origin_community_id === communityId) || null;
  }, { message: 'the community to reach the other instance' });

  const joined = await bob.post('/api/continuum/communities/instance-a/' + communityId + '/join');
  assert.equal(joined.status, 200, JSON.stringify(joined.data));

  // The owner records the member, and the member's standing is what decides
  // what the owner accepts from them.
  await waitFor(async () => {
    const res = await adminA.get('/api/continuum/relay/memberships?community_id=' + communityId);
    if (!res.ok) return null;
    return res.data.find((m) => m.origin_user_id === bob.user.id) || null;
  }, { message: 'the owner to record the remote member' });

  // The write. The route is the only way in: a member of a federated
  // community writes in it from the instance they are on.
  const write = async (content) => {
    const res = await bob.post(
      '/api/continuum/communities/instance-a/' + communityId + '/channels/' + channelId + '/messages',
      { content }
    );
    assert.equal(res.status, 201, JSON.stringify(res.data));
    return res.data;
  };

  // The first message a member wrote, kept for the checks that follow.
  let firstMessageId = null;

  // What the writer sees of a message they wrote.
  const outgoing = async (id) => {
    const res = await bob.get('/api/continuum/outgoing');
    assert.ok(res.ok, JSON.stringify(res.data));
    return res.data.find((m) => m.id === id) || null;
  };

  // What the owner sees: the messages members wrote in this community.
  const moderation = async () => {
    const res = await adminA.get('/api/continuum/moderation/messages?community_id=' + communityId);
    assert.ok(res.ok, JSON.stringify(res.data));
    return res.data;
  };

  await t.test('a message written on the other instance reaches the owner', async () => {
    const written = await write('a word from the other side');
    firstMessageId = written.id;

    const relayed = await waitFor(async () => {
      const list = await moderation();
      return list.find((m) => m.origin_message_id === written.id) || null;
    }, { message: 'the message to reach the owner' });

    assert.equal(relayed.content, 'a word from the other side');
    assert.equal(relayed.relayed, true, 'it is presented as a relayed message');
    assert.equal(relayed.origin_instance_id, 'instance-b', 'it says where it came from');
    assert.equal(relayed.origin_community_id, communityId, 'it belongs to the community it was written in');
    assert.equal(relayed.origin_channel_id, channelId);
    assert.equal(relayed.author_username, 'bob', 'the author is the one who wrote it');
    assert.equal(relayed.author_display_name, 'bob');
    assert.equal(relayed.created_at, written.created_at, 'the original timestamp is kept');

    // The owner answers, and the writer is told.
    const answered = await waitFor(async () => {
      const row = await outgoing(written.id);
      return row && row.state === 'accepted' ? row : null;
    }, { message: 'the owner to answer the writer' });
    assert.equal(answered.state, 'accepted');
    assert.equal(answered.reason, null);
  });

  await t.test('writing grants no authority on either instance', async () => {
    // The member is nobody here. The owner records them; it does not make
    // them one of its own.
    const members = await a.modules.db.all(
      'SELECT * FROM server_members WHERE server_id = ? AND user_id = ?', [communityId, bob.user.id]
    );
    assert.equal(members.length, 0, 'the remote member is not a member of the community here');
    const roles = await a.modules.db.all(
      'SELECT * FROM member_roles WHERE server_id = ? AND user_id = ?', [communityId, bob.user.id]
    );
    assert.equal(roles.length, 0, 'the remote member holds no role here');

    // And the message is not a local message: it grants nothing and it is
    // nobody's.
    const local = await a.modules.db.all(
      'SELECT * FROM messages WHERE content = ?', ['a word from the other side']
    );
    assert.equal(local.length, 0, 'the relayed message is not a message of this community');

    // The other way round: the community is not a community of the instance
    // that wrote in it.
    const mine = await bob.get('/api/servers');
    assert.ok(
      !mine.data.some((s) => s.id === communityId),
      'the community is still not a community of the instance that wrote in it'
    );

    // The member cannot moderate the community they are in: they have no
    // account on the owner at all, so the owner's moderation surface is not
    // theirs to use.
    const asRemote = await apiClient(a.baseUrl, bob.token).delete(
      '/api/continuum/moderation/messages/instance-b/' + firstMessageId
    );
    assert.equal(asRemote.status, 401, 'a remote member has no account on the origin');

    // And the surface is not open to the community's ordinary members
    // either: it belongs to the people who moderate the community.
    const plain = await registerUser(a, 'plain');
    const invite = await adminA.post('/api/servers/' + communityId + '/invites', { maxUses: 5 });
    const accepted = await plain.post('/api/invites/' + invite.data.code + '/join', {});
    assert.equal(accepted.status, 200, JSON.stringify(accepted.data));

    const asMember = await plain.delete(
      '/api/continuum/moderation/messages/instance-b/' + firstMessageId
    );
    assert.equal(asMember.status, 403, 'an ordinary member may not moderate');
    assert.match(asMember.data.error.message, /may not moderate/);
  });

  await t.test('the owner removes the message, and the removal reaches the writer', async () => {
    const written = await write('a word the owner will take back');
    await waitFor(async () => {
      const list = await moderation();
      return list.find((m) => m.origin_message_id === written.id) || null;
    }, { message: 'the message to reach the owner' });

    const removed = await adminA.delete(
      '/api/continuum/moderation/messages/instance-b/' + written.id,
      { reason: 'not wanted here' }
    );
    assert.equal(removed.status, 200, JSON.stringify(removed.data));
    assert.equal(removed.data.removed, true);
    assert.equal(removed.data.relayed, true, 'the removal was published to the instance that wrote it');

    // The owner no longer holds it.
    const list = await moderation();
    const held = list.find((m) => m.origin_message_id === written.id);
    assert.ok(held.deleted, 'the owner has taken the message back');
    assert.equal(held.content, null, 'the message does not outlive the taking back');

    // And the instance that wrote it is told.
    const row = await waitFor(async () => {
      const found = await outgoing(written.id);
      return found && found.state === 'deleted' ? found : null;
    }, { message: 'the removal to reach the writer' });
    assert.equal(row.deleted, true);
    assert.ok(row.deleted_at, 'the removal is recorded on the message the writer wrote');

    // The trail says who did it.
    const trail = await a.modules.db.all(
      'SELECT * FROM audit_logs WHERE action = ? ORDER BY created_at DESC LIMIT 1',
      ['relay_message_remove']
    );
    assert.equal(trail.length, 1, 'the removal is in the audit trail');
    assert.equal(trail[0].actor_id, adminA.user.id, 'the trail says who did it');
    assert.equal(trail[0].server_id, communityId);
  });

  await t.test('a channel the members may not post in refuses the message', async () => {
    // The owner closes the channel to its own members. A member who may not
    // post there does not post there by writing to a federated copy of it.
    await a.modules.permissions.setOverride(
      'channel_permission_overrides', channelId, 'SEND_MESSAGES', 'deny'
    );

    const written = await write('into a channel the members cannot use');
    const refused = await waitFor(async () => {
      const row = await outgoing(written.id);
      return row && row.state === 'refused' ? row : null;
    }, { message: 'the refusal to reach the writer' });

    assert.match(refused.reason, /cannot post in this channel/);
    assert.ok(refused.decided_at, 'the answer is dated');

    // And nothing was kept at the owner.
    const list = await moderation();
    assert.ok(
      !list.some((m) => m.origin_message_id === written.id),
      'a refused message is not kept at the owner'
    );

    // The channel is open again for the next case.
    await a.modules.permissions.setOverride(
      'channel_permission_overrides', channelId, 'SEND_MESSAGES', 'inherit'
    );
  });

  await t.test('the owner mutes the member, and the member is refused', async () => {
    const muted = await adminA.post(
      '/api/continuum/moderation/members/instance-b/' + bob.user.id,
      { action: 'mute', community_id: communityId, reason: 'too loud' }
    );
    assert.equal(muted.status, 200, JSON.stringify(muted.data));
    assert.equal(muted.data.state, 'muted');

    // The owner's record says so.
    const members = await adminA.get('/api/continuum/moderation/members?community_id=' + communityId);
    const member = members.data.find((m) => m.origin_user_id === bob.user.id);
    assert.equal(member.state, 'muted', 'the owner has muted the member');

    // The member's own instance is told, so the member stops writing here.
    const standing = await waitFor(async () => {
      const res = await bob.get('/api/continuum/memberships');
      if (!res.ok) return null;
      const row = res.data.find((m) => m.origin_community_id === communityId);
      return row && row.state === 'muted' ? row : null;
    }, { message: 'the mute to reach the member' });
    assert.equal(standing.state, 'muted', 'the member cannot write there any more');

    const refused = await bob.post(
      '/api/continuum/communities/instance-a/' + communityId + '/channels/' + channelId + '/messages',
      { content: 'still here' }
    );
    assert.equal(refused.status, 403, 'a muted member may not write');
    assert.match(refused.data.error.message, /muted/);

    // The trail says who did it.
    const trail = await a.modules.db.all(
      'SELECT * FROM audit_logs WHERE action = ? ORDER BY created_at DESC LIMIT 1',
      ['relay_member_mute']
    );
    assert.equal(trail.length, 1, 'the mute is in the audit trail');
    assert.equal(trail[0].actor_id, adminA.user.id);
  });

  await t.test('a community the owner has made private refuses the message', async () => {
    // The member is restored first: a muted member would be refused for
    // being muted, and this case is about the community being closed.
    const restored = await adminA.post(
      '/api/continuum/moderation/members/instance-b/' + bob.user.id,
      { action: 'restore', community_id: communityId }
    );
    assert.equal(restored.status, 200, JSON.stringify(restored.data));
    await waitFor(async () => {
      const res = await bob.get('/api/continuum/memberships');
      const row = res.data.find((m) => m.origin_community_id === communityId);
      return row && row.state === 'joined' ? row : null;
    }, { message: 'the member to be restored' });
    const closed = await adminA.patch('/api/servers/' + communityId, { isPublic: false });
    assert.equal(closed.status, 200, JSON.stringify(closed.data));

    const written = await write('into a community that is closed');
    const refused = await waitFor(async () => {
      const row = await outgoing(written.id);
      return row && row.state === 'refused' ? row : null;
    }, { message: 'the refusal to reach the writer' });

    assert.match(refused.reason, /private/);
  });
});
