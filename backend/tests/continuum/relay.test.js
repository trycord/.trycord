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

  await t.test('an event from a peer that was removed is refused', async () => {
    const envelope = capture.envelopeOfKind('message.posted');
    const before = await relayed();

    const removed = await adminB.delete('/api/continuum/instances/instance-a');
    assert.equal(removed.status, 200, JSON.stringify(removed.data));

    const res = await apiClient(b.baseUrl).post('/api/continuum/inbox', envelope);
    assert.equal(res.status, 400, 'an event from an instance that is no longer known is refused');

    const after = await relayed();
    assert.equal(after.length, before.length, 'an event from an unknown instance changes nothing');
  });
});
