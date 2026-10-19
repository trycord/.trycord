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
