// The community list, and the section the federated communities are in.
//
// A community that lives on another instance is a reference, not a copy. It
// is listed apart from the communities of this instance, because a reader
// looking for one of them in particular is helped by being able to tell them
// apart - and because the two are different things: one is here, and the
// other one lives on an instance that stays the only authority over it.

import test from 'node:test';
import assert from 'node:assert/strict';

import { installDomStub } from './helpers/dom-stub.js';

installDomStub();

const { State } = await import('../packages/store.js');
const {
  federatedRoute, federatedName, federatedOrigin, federatedIsJoined, partitionFederated,
} = await import('../packages/places.js');

const COMMUNITY = {
  originInstanceId: 'peer-1',
  originCommunityId: 'c-remote',
  name: 'General',
  description: 'A community somewhere else.',
  iconUrl: null,
  originName: 'The Other Instance',
  relationship: 'joined',
  channels: [{ id: 'ch-1', name: 'general', type: 'text', topic: '', canPost: true }],
};

const DISCOVERED = {
  ...COMMUNITY,
  originCommunityId: 'c-other',
  name: 'Watercooler',
  originName: 'A Third Instance',
  relationship: 'discovered',
};

test('the places a person is', async (t) => {
  await t.test('a federated community has an address of its own', () => {
    // It is not a row in `servers`, so it has no local id to open it with.
    assert.equal(federatedRoute(COMMUNITY), '/federated/peer-1/c-remote');
    assert.equal(federatedRoute(null), '');
  });

  await t.test('the name and where it lives are told apart', () => {
    // "General" on another instance is not the same "General", so the reader
    // is always told which instance it is on.
    assert.equal(federatedName(COMMUNITY), 'General');
    assert.equal(federatedOrigin(COMMUNITY), 'on The Other Instance');
  });

  await t.test('a community with no name still says something', () => {
    assert.equal(federatedName({}), 'A community on another instance');
    assert.equal(federatedOrigin({}), 'on another instance');
  });

  await t.test("following is the reader's own", () => {
    assert.equal(federatedIsJoined(COMMUNITY), true);
    assert.equal(federatedIsJoined(DISCOVERED), false);
    assert.equal(federatedIsJoined(null), false);
  });

  await t.test('the ones the reader follows are told apart from the ones they do not', () => {
    const { joined, discovered } = partitionFederated([COMMUNITY, DISCOVERED]);
    assert.equal(joined.length, 1);
    assert.equal(joined[0].name, 'General');
    assert.equal(discovered.length, 1);
    assert.equal(discovered[0].name, 'Watercooler');
  });

  await t.test('the community list keeps them apart', () => {
    // The store holds the communities of this instance and the communities of
    // other instances in two places, because they are two things.
    State.servers = [{ id: 's1', name: 'The Community' }];
    State.federated = [COMMUNITY];
    assert.equal(State.servers.length, 1);
    assert.equal(State.federated.length, 1);
    assert.ok(!State.servers.some((entry) => entry.originInstanceId),
      'a federated community is in the list of the ones that live here');
  });
});
