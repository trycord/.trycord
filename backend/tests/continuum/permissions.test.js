// The relay rules, covered against the services.
//
// The rules are the security boundary of the protocol, so they are tested
// where they live: the publisher decides what may leave, and these are the
// answers it gives.
//
//   - a private community produces no events
//   - a restricted channel produces no events
//   - a sender who may not post produces no event
//   - a peer that is not trusted is not a delivery target

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startInstance, registerUser } = require('../helpers/instance');
const { FEDERATION_ENV } = require('./helpers');

test('the relay rules', async (t) => {
  // No job system: these tests call the publisher directly and read the
  // outbox, so nothing has to be delivered for them to mean something.
  const instance = await startInstance({
    jobs: false,
    env: Object.assign({}, FEDERATION_ENV, {
      TRYCORD_INSTANCE_ID: 'instance-a',
      ADMIN_USERNAMES: 'operator',
    }),
  });
  t.after(() => instance.stop());

  // This instance's own modules, captured before anything else can replace
  // them in the module cache.
  const db = require('../../src/db');
  const continuum = require('../../src/services/continuum');
  const permissions = require('../../src/services/permissions');

  const admin = await registerUser(instance, 'operator');
  const member = await registerUser(instance, 'member');

  const outbox = async () => db.all('SELECT id, kind, payload FROM continuum_events');

  await t.test('a private community produces no events', async () => {
    const priv = await admin.post('/api/servers', { name: 'Private Community' });
    assert.equal(priv.status, 200, JSON.stringify(priv.data));
    const posted = await admin.post('/api/channels/' + priv.data.channelId + '/messages', {
      content: 'words that stay here',
    });
    assert.equal(posted.status, 200, JSON.stringify(posted.data));

    const result = await continuum.publishEvent('message.posted', {
      serverId: priv.data.serverId,
      channelId: priv.data.channelId,
      messageId: posted.data.id,
      authorId: posted.data.author_id,
      content: 'words that stay here',
    }, { actorId: posted.data.author_id });

    assert.equal(result.ok, false, 'a private community is not federated');
    assert.match(result.reason, /private/);
    assert.deepEqual(await outbox(), [], 'nothing was written to the outbox');
  });

  await t.test('a restricted channel produces no events', async () => {
    const community = await admin.post('/api/servers', { name: 'Open Community', isPublic: true });
    assert.equal(community.status, 200, JSON.stringify(community.data));
    const channel = await admin.post('/api/servers/' + community.data.serverId + '/channels', {
      name: 'staff only',
    });
    assert.equal(channel.status, 200, JSON.stringify(channel.data));

    // The members of the community may not post in this channel.
    await permissions.setOverride(
      'channel_permission_overrides', channel.data.id, 'SEND_MESSAGES', 'deny'
    );

    const posted = await admin.post('/api/channels/' + channel.data.id + '/messages', {
      content: 'for the staff',
    });
    assert.equal(posted.status, 200, JSON.stringify(posted.data));

    const result = await continuum.publishEvent('message.posted', {
      serverId: community.data.serverId,
      channelId: channel.data.id,
      messageId: posted.data.id,
      authorId: posted.data.author_id,
      content: 'for the staff',
    }, { actorId: posted.data.author_id });

    assert.equal(result.ok, false, 'a restricted channel is not federated');
    assert.match(result.reason, /cannot post in this channel/);
    assert.deepEqual(await outbox(), [], 'nothing was written to the outbox');

    // The community itself is still federated: the rule is per channel.
    const communityEvent = await continuum.publishEvent('community.published', {
      serverId: community.data.serverId,
    }, { actorId: admin.user.id });
    assert.equal(communityEvent.ok, true, communityEvent.reason);
    assert.equal((await outbox()).length, 1);
  });

  await t.test('a sender who may not post produces no event', async () => {
    // The message is written in a private community, so the relay has never
    // seen it: what is tested is the decision to publish it now.
    const community = await admin.post('/api/servers', { name: 'Member Community' });
    assert.equal(community.status, 200, JSON.stringify(community.data));
    const invite = await admin.post('/api/servers/' + community.data.serverId + '/invites', { maxUses: 5 });
    const joined = await member.post('/api/invites/' + invite.data.code + '/join', {});
    assert.equal(joined.status, 200, JSON.stringify(joined.data));

    const posted = await member.post('/api/channels/' + community.data.channelId + '/messages', {
      content: 'a member may post this',
    });
    assert.equal(posted.status, 200, JSON.stringify(posted.data));

    // The community becomes public, and the member's permission is taken
    // away afterwards. The message was written while it was theirs; whether
    // it may still leave is decided now, and the answer is the same one the
    // send path would give.
    const opened = await admin.patch('/api/servers/' + community.data.serverId, { isPublic: true });
    assert.equal(opened.status, 200, JSON.stringify(opened.data));
    await db.run('DELETE FROM member_roles WHERE server_id = ? AND user_id = ?', [
      community.data.serverId, member.user.id,
    ]);

    const result = await continuum.publishEvent('message.posted', {
      serverId: community.data.serverId,
      channelId: community.data.channelId,
      messageId: posted.data.id,
      authorId: posted.data.author_id,
      content: 'a member may post this',
    }, { actorId: posted.data.author_id });

    assert.equal(result.ok, false, 'a sender who may not post produces no event');
    assert.match(result.reason, /author cannot post/);

    const rows = await outbox();
    assert.equal(
      rows.filter((row) => JSON.parse(row.payload).origin.message_origin_id === posted.data.id).length,
      0,
      'the message is not in the outbox'
    );
  });

  await t.test('encrypted content is never federated', async () => {
    const result = await continuum.publishEvent('message.posted', {
      serverId: 'any',
      channelId: 'any',
      messageId: 'any',
      encrypted: true,
    }, {});
    assert.equal(result.ok, false, 'encrypted content does not leave');
    assert.match(result.reason, /encrypted/);
  });

  await t.test('a peer that is not trusted is not a delivery target', async () => {
    const { publicKey } = require('crypto').generateKeyPairSync('ed25519');
    const key = publicKey.export({ type: 'spki', format: 'pem' });
    const peers = [['trusted-peer', 'trusted'], ['pending-peer', 'pending'], ['blocked-peer', 'blocked']];
    for (let i = 0; i < peers.length; i++) {
      const [id, status] = peers[i];
      const added = await admin.post('/api/continuum/instances', {
        id, name: id, origin: 'http://127.0.0.1:' + (9000 + i), public_key: key,
      });
      assert.equal(added.status, 201, JSON.stringify(added.data));
      await admin.patch('/api/continuum/instances/' + id + '/trust', { trust_status: status });
    }

    const targets = await continuum.deliveryTargets({ id: 'an-event', payload: '{}' });
    assert.deepEqual(
      targets.map((target) => target.id),
      ['trusted-peer'],
      'only a trusted peer is a delivery target'
    );
  });
});

// The same rules, asked of the other direction.
//
// The relay carries content two ways: what an instance publishes about a
// community it owns, and what a member of that community wrote elsewhere and
// sent to it. The rules are the same rules, asked the other way round, and
// they live in the same module - so they are proved here, in both
// directions, against the same functions.
test('the relay rules, in the direction a member writes in', async (t) => {
  const instance = await startInstance({
    jobs: false,
    env: Object.assign({}, FEDERATION_ENV, {
      TRYCORD_INSTANCE_ID: 'instance-a',
      ADMIN_USERNAMES: 'operator',
    }),
  });
  t.after(() => instance.stop());

  const db = require('../../src/db');
  const continuum = require('../../src/services/continuum');
  const permissions = require('../../src/services/permissions');
  const rules = require('../../src/services/continuum/rules');
  const store = require('../../src/services/continuum/store');

  const admin = await registerUser(instance, 'operator');
  const member = await registerUser(instance, 'member');

  // A community of this instance, and a member of it who lives elsewhere.
  const community = await admin.post('/api/servers', { name: 'Return Rules', isPublic: true });
  assert.equal(community.status, 200, JSON.stringify(community.data));
  const communityId = community.data.serverId;
  const channelId = community.data.channelId;

  await store.upsertRelayMembership({
    originInstanceId: 'instance-b',
    originCommunityId: communityId,
    originUserId: 'a-remote-member',
    username: 'a-remote-member',
    displayName: 'A Remote Member',
    state: 'joined',
  });

  // The writing side of the same story: a community that lives on another
  // instance, and a peer to write to.
  await db.run(
    'INSERT INTO continuum_instances (id, name, origin, public_key, trust_status, created_at) '
    + 'VALUES (?, ?, ?, ?, ?, ?)',
    ['instance-b', 'instance b', 'http://127.0.0.1:9101', 'a-key', 'trusted', new Date().toISOString()]
  );
  await store.upsertCommunity({
    originInstanceId: 'instance-b',
    originCommunityId: 'a-remote-community',
    name: 'A Remote Community',
    channels: [{ id: 'a-remote-channel', name: 'general', type: 'text', topic: null, is_public: true }],
  });
  await store.upsertMembership({
    userId: member.user.id,
    originInstanceId: 'instance-b',
    originCommunityId: 'a-remote-community',
    state: 'joined',
  });

  await t.test('what a member wrote elsewhere is accepted when the rules allow it', async () => {
    const gate = await rules.mayAcceptRemoteMessage({
      serverId: communityId,
      channelId,
      originInstanceId: 'instance-b',
      originUserId: 'a-remote-member',
    });
    assert.equal(gate.ok, true, gate.reason);
  });

  await t.test('a private community refuses what a member wrote elsewhere', async () => {
    const closed = await admin.patch('/api/servers/' + communityId, { isPublic: false });
    assert.equal(closed.status, 200, JSON.stringify(closed.data));

    const gate = await rules.mayAcceptRemoteMessage({
      serverId: communityId,
      channelId,
      originInstanceId: 'instance-b',
      originUserId: 'a-remote-member',
    });
    assert.equal(gate.ok, false, 'a private community is not federated');
    assert.match(gate.reason, /private/);

    await admin.patch('/api/servers/' + communityId, { isPublic: true });
  });

  await t.test('a channel the members may not post in refuses what a member wrote elsewhere', async () => {
    await permissions.setOverride(
      'channel_permission_overrides', channelId, 'SEND_MESSAGES', 'deny'
    );

    const gate = await rules.mayAcceptRemoteMessage({
      serverId: communityId,
      channelId,
      originInstanceId: 'instance-b',
      originUserId: 'a-remote-member',
    });
    assert.equal(gate.ok, false, 'a restricted channel is not federated');
    assert.match(gate.reason, /cannot post in this channel/);

    await permissions.setOverride(
      'channel_permission_overrides', channelId, 'SEND_MESSAGES', 'inherit'
    );
  });

  await t.test('a member who may not post is refused', async () => {
    // The owner has muted them.
    await store.setRelayMembershipState('instance-b', communityId, 'a-remote-member', 'muted');
    const muted = await rules.mayAcceptRemoteMessage({
      serverId: communityId,
      channelId,
      originInstanceId: 'instance-b',
      originUserId: 'a-remote-member',
    });
    assert.equal(muted.ok, false, 'a muted member may not write');
    assert.match(muted.reason, /muted/);

    // And the owner has removed them.
    await store.setRelayMembershipState('instance-b', communityId, 'a-remote-member', 'removed');
    const removed = await rules.mayAcceptRemoteMessage({
      serverId: communityId,
      channelId,
      originInstanceId: 'instance-b',
      originUserId: 'a-remote-member',
    });
    assert.equal(removed.ok, false, 'a member who was removed may not write');
    assert.match(removed.reason, /removed/);

    await store.setRelayMembershipState('instance-b', communityId, 'a-remote-member', 'joined');
  });

  await t.test('somebody who is not a member is refused', async () => {
    const gate = await rules.mayAcceptRemoteMessage({
      serverId: communityId,
      channelId,
      originInstanceId: 'instance-b',
      originUserId: 'a-stranger',
    });
    assert.equal(gate.ok, false, 'a stranger may not write in the community');
    assert.match(gate.reason, /not a member/);
  });

  await t.test('a peer that is not trusted is not a target', async () => {
    // The writing side: nothing is federated to a peer that is not trusted.
    await db.run("UPDATE continuum_instances SET trust_status = 'pending' WHERE id = ?", ['instance-b']);
    const gate = await rules.mayPublishRemoteMessage({
      originInstanceId: 'instance-b',
      originCommunityId: 'a-remote-community',
      originChannelId: 'a-remote-channel',
      userId: member.user.id,
    });
    assert.equal(gate.ok, false, 'a pending peer is not a target');
    assert.match(gate.reason, /not trusted/);
    await db.run("UPDATE continuum_instances SET trust_status = 'trusted' WHERE id = ?", ['instance-b']);
  });

  await t.test('a channel the community does not expose is not a target', async () => {
    const gate = await rules.mayPublishRemoteMessage({
      originInstanceId: 'instance-b',
      originCommunityId: 'a-remote-community',
      originChannelId: 'a-channel-nobody-exposed',
      userId: member.user.id,
    });
    assert.equal(gate.ok, false, 'a channel the owner does not expose is not a target');
    assert.match(gate.reason, /does not expose/);
  });

  await t.test('a writer who has not joined may not write', async () => {
    const gate = await rules.mayPublishRemoteMessage({
      originInstanceId: 'instance-b',
      originCommunityId: 'a-remote-community',
      originChannelId: 'a-remote-channel',
      userId: admin.user.id,
    });
    assert.equal(gate.ok, false, 'writing needs a membership');
    assert.match(gate.reason, /have not joined/);
  });

  await t.test('encrypted content is never federated, in either direction', async () => {
    const result = await continuum.publishEvent('message.posted', {
      sourceKind: 'outgoing',
      outgoingId: 'an-outgoing-message',
      serverId: 'a-remote-community',
      channelId: 'a-remote-channel',
      encrypted: true,
    }, { destination: 'instance-b' });
    assert.equal(result.ok, false, 'encrypted content does not leave');
    assert.match(result.reason, /encrypted/);
  });

  await t.test('what was not federable when it was written is not federated later', async () => {
    // The peer is not trusted when the message is written, so the message
    // is withheld - and it stays withheld when the peer is trusted after.
    await db.run("UPDATE continuum_instances SET trust_status = 'pending' WHERE id = ?", ['instance-b']);
    const outgoingId = await store.createOutgoing({
      originInstanceId: 'instance-b',
      originCommunityId: 'a-remote-community',
      originChannelId: 'a-remote-channel',
      authorId: member.user.id,
      username: member.user.username,
      content: 'written when the peer was not trusted',
      createdAt: new Date().toISOString(),
    });

    const first = await continuum.publishEvent('message.posted', {
      sourceKind: 'outgoing',
      outgoingId,
      originInstanceId: 'instance-b',
      serverId: 'a-remote-community',
      channelId: 'a-remote-channel',
      messageId: outgoingId,
      authorId: member.user.id,
      username: member.user.username,
      destination: 'instance-b',
    }, { destination: 'instance-b' });
    assert.equal(first.ok, false, 'it does not leave while the peer is not trusted');

    await db.run("UPDATE continuum_instances SET trust_status = 'trusted' WHERE id = ?", ['instance-b']);
    const second = await continuum.publishEvent('message.posted', {
      sourceKind: 'outgoing',
      outgoingId,
      originInstanceId: 'instance-b',
      serverId: 'a-remote-community',
      channelId: 'a-remote-channel',
      messageId: outgoingId,
      authorId: member.user.id,
      username: member.user.username,
      destination: 'instance-b',
    }, { destination: 'instance-b' });
    assert.equal(second.ok, false, 'it does not leave later either');
    assert.match(second.reason, /not federable when it was written/);
  });
});
