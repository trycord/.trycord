// The federated communities, and the section they are listed in.
//
// A community that lives on another instance is a reference, not a copy. It
// is not a row in `servers`, it grants no role and no permission here, and
// the instance it lives on stays the only authority over it.
//
// So the list of communities is two lists: the ones that live here, and the
// ones that live elsewhere. They are shown in sections of their own, because
// a community of this instance is here and a community of another one is a
// reference, and a reader looking for one of them in particular is helped by
// being able to tell them apart.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startInstance, registerUser } = require('../helpers/instance');

const ROOT = require('node:path').join(__dirname, '..', '..');

test('the federated communities', async (t) => {
  // Federation on: a community that lives on another instance only exists
  // when this instance federates.
  const instance = await startInstance({
    env: { ADMIN_USERNAMES: 'owner', CONTINUUM_ENABLED: 'on' },
  });
  t.after(() => instance.stop());

  const owner = await registerUser(instance, 'owner');
  const member = await registerUser(instance, 'member');

  // A peer, and a community that lives on it.
  const continuum = require(ROOT + '/src/services/continuum');
  const store = require(ROOT + '/src/services/continuum/store');

  await t.test('a reader is told which communities live elsewhere', async () => {
    // Nothing is federated yet, and the answer is an empty list rather than
    // an error: federation is off, not broken.
    const res = await member.get('/api/continuum/federated');
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.deepEqual(res.data, [], 'the answer is not empty');
  });

  await t.test('a remote community is mirrored, with where it lives', async () => {
    // The peer is recorded the way an operator records one.
    // Required after the instance has booted: booting clears the module
    // cache for src/, so anything required before this is a second copy of
    // the database facade with no connection.
    const db = require(ROOT + '/src/db');
    await db.run(
      'INSERT INTO continuum_instances (id, name, origin, public_key, trust_status, created_at) '
      + 'VALUES (?, ?, ?, ?, ?, ?)',
      ['peer-1', 'The Other Instance', 'https://peer.example', 'a-key', 'trusted', '2026-01-01T00:00:00.000Z']
    );
    await store.upsertCommunity({
      originInstanceId: 'peer-1',
      originCommunityId: 'c-remote',
      name: 'General',
      description: 'A community somewhere else.',
      iconUrl: null,
      channels: [
        { id: 'ch-1', name: 'general', type: 'text', topic: 'The one channel', is_public: true },
      ],
    });

    const res = await member.get('/api/continuum/federated');
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.length, 1, 'the community was not mirrored');

    const community = res.data[0];
    assert.equal(community.name, 'General');
    assert.equal(community.originInstanceId, 'peer-1');
    assert.equal(community.originCommunityId, 'c-remote');
    // The reader is told where it lives: "General" on another instance is
    // not the same "General".
    assert.equal(community.originName, 'The Other Instance');
    // And it is a reference, not a copy: the reader follows nothing yet.
    assert.equal(community.relationship, 'discovered');
    assert.equal(community.channels.length, 1);
    assert.equal(community.channels[0].name, 'general');
    assert.equal(community.channels[0].canPost, true);
  });

  await t.test("the relationship is the reader's own", async () => {
    // Somebody who follows it sees that; somebody who does not does not.
    const follower = await registerUser(instance, 'follower');
    const join = await follower.post(
      '/api/continuum/communities/peer-1/c-remote/join', {});
    assert.ok(join.status < 400, JSON.stringify(join.data));

    const theirs = await follower.get('/api/continuum/federated');
    const mine = await member.get('/api/continuum/federated');
    const theirCommunity = theirs.data[0];
    const myCommunity = mine.data[0];
    assert.equal(theirCommunity.relationship, 'joined',
      'the follower does not see that they follow it');
    assert.notEqual(myCommunity.relationship, 'joined',
      'somebody else sees that they follow it');
  });

  await t.test("the operator's view is still the whole of it", async () => {
    // The route the administration console uses answers with every
    // community of every peer, whatever the reader follows.
    const res = await owner.get('/api/continuum/communities');
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.length, 1);
    assert.ok(res.data[0].relationship, "the operator's view has no relationship");
  });
});
