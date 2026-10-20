// The federation flag of a community.
//
// A community is federated unless it says otherwise, and a community that
// has withdrawn from federation produces no outbound event of any kind and
// is not offered to other instances.
//
// The migration rule is the first thing this proves: a community that
// existed before the flag was added is federated, so an operator gains a
// control without having to change anything.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { apiClient, registerUser } = require('../helpers/instance');
const {
  startFederatedInstance, startCapturePeer, waitFor, sleep, eventsAboutMessage, discoveryOf,
} = require('../continuum/helpers');

test('a community is federated until it says otherwise', async (t) => {
  const instance = await startFederatedInstance('instance-settings');
  t.after(async () => { await instance.stop(); });

  const owner = await registerUser(instance, 'operator');
  const created = await owner.post('/api/servers', { name: 'A Community', isPublic: true });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const serverId = created.data.serverId;

  // The flag round-trips.
  const detail = await owner.get('/api/servers/' + serverId);
  assert.equal(detail.status, 200, JSON.stringify(detail.data));
  assert.equal(detail.data.federated, true,
    'a community is not federated until it says otherwise');

  const list = await owner.get('/api/servers');
  assert.equal(list.status, 200, JSON.stringify(list.data));
  const listed = (list.data || []).find((row) => row.id === serverId);
  assert.ok(listed, 'the community is not in the list of communities');
  assert.equal(listed.federated, true, 'the list does not say whether the community is federated');

  // And it can be turned off and on again.
  const off = await owner.patch('/api/servers/' + serverId, { federated: false });
  assert.equal(off.status, 200, JSON.stringify(off.data));
  assert.equal(off.data.federated, false, 'the community did not stop being federated');

  const back = await owner.get('/api/servers/' + serverId);
  assert.equal(back.data.federated, false, 'the flag did not round-trip');

  const on = await owner.patch('/api/servers/' + serverId, { federated: true });
  assert.equal(on.status, 200, JSON.stringify(on.data));
  assert.equal(on.data.federated, true, 'the community did not start being federated again');
});

test('a community that exists today is federated, so nothing changes for it', async (t) => {
  const instance = await startFederatedInstance('instance-migration');
  t.after(async () => { await instance.stop(); });

  const owner = await registerUser(instance, 'operator');
  const created = await owner.post('/api/servers', { name: 'An Existing Community' });
  assert.equal(created.status, 200, JSON.stringify(created.data));

  // The column's default is what an existing community gets: the migration
  // adds the column with a default of one, so every row that was there
  // before is federated.
  const row = await instance.db.get(
    'SELECT federated FROM servers WHERE id = ?', [created.data.serverId]);
  assert.equal(row.federated, 1, 'a community that existed before the flag is not federated');
});

test('a community that has withdrawn from federation is not offered and relays nothing', async (t) => {
  const instance = await startFederatedInstance('instance-withdrawn');
  const capture = await startCapturePeer('capture-peer');
  t.after(async () => {
    await capture.stop();
    await instance.stop();
  });

  const owner = await registerUser(instance, 'operator');
  const created = await owner.post('/api/servers', { name: 'Withdrawn Community', isPublic: true });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const serverId = created.data.serverId;
  const channelId = created.data.channelId;

  // While it is federated, it is offered to other instances.
  const before = await discoveryOf(instance);
  assert.ok(before.communities.some((community) => community.id === serverId),
    'a federated community is not in the discovery document');

  const off = await owner.patch('/api/servers/' + serverId, { federated: false });
  assert.equal(off.status, 200, JSON.stringify(off.data));

  // The discovery document does not mention it any more.
  const after = await discoveryOf(instance);
  assert.ok(!after.communities.some((community) => community.id === serverId),
    'a community that has withdrawn from federation is still offered to other instances');

  // And nothing is relayed from it.
  const posted = await owner.post('/api/channels/' + channelId + '/messages', {
    content: 'words that stay here',
  });
  assert.equal(posted.status, 200, JSON.stringify(posted.data));
  await sleep(1200);
  const events = await eventsAboutMessage(owner, posted.data.id);
  assert.equal(events.length, 0, 'a community that has withdrawn from federation relayed a message');
  assert.equal(capture.envelopes().length, 0,
    'a community that has withdrawn from federation reached another instance');
});

test('turning federation back on brings the community back', async (t) => {
  const instance = await startFederatedInstance('instance-returning');
  t.after(async () => { await instance.stop(); });

  const owner = await registerUser(instance, 'operator');
  const created = await owner.post('/api/servers', { name: 'Returning Community', isPublic: true });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const serverId = created.data.serverId;

  await owner.patch('/api/servers/' + serverId, { federated: false });
  const withdrawn = await discoveryOf(instance);
  assert.ok(!withdrawn.communities.some((community) => community.id === serverId),
    'the community did not leave the discovery document');

  await owner.patch('/api/servers/' + serverId, { federated: true });
  const returned = await discoveryOf(instance);
  assert.ok(returned.communities.some((community) => community.id === serverId),
    'the community did not come back to the discovery document');
});

test('the rules refuse a community that has withdrawn, whatever the route', async (t) => {
  const instance = await startFederatedInstance('instance-rules');
  t.after(async () => { await instance.stop(); });

  const owner = await registerUser(instance, 'operator');
  const created = await owner.post('/api/servers', { name: 'A Quiet Community', isPublic: true });
  const serverId = created.data.serverId;
  await owner.patch('/api/servers/' + serverId, { federated: false });

  const rules = require('../../src/services/continuum/rules');
  const answer = await rules.communityMayFederate(serverId);
  assert.equal(answer.ok, false, 'the rules let a withdrawn community federate');
  assert.match(answer.reason, /withdrawn/i, 'the rules did not say why');

  const channels = await rules.federableChannels(serverId);
  assert.equal(channels.length, 0, 'a withdrawn community still exposes its channels');
});

test('the flag is not something anybody else may set', async (t) => {
  const instance = await startFederatedInstance('instance-gate');
  t.after(async () => { await instance.stop(); });

  const owner = await registerUser(instance, 'operator');
  const created = await owner.post('/api/servers', { name: 'A Gated Community' });
  const serverId = created.data.serverId;

  // A member who cannot manage the community may not change it.
  const invite = await owner.post('/api/servers/' + serverId + '/invites', {});
  assert.equal(invite.status, 200, JSON.stringify(invite.data));
  const member = await registerUser(instance, 'ada');
  const joined = await member.post('/api/invites/' + invite.data.code + '/join', {});
  assert.equal(joined.status, 200, JSON.stringify(joined.data));

  const refused = await member.patch('/api/servers/' + serverId, { federated: false });
  assert.equal(refused.status, 403, JSON.stringify(refused.data));

  const still = await owner.get('/api/servers/' + serverId);
  assert.equal(still.data.federated, true, 'a member turned federation off');
});
