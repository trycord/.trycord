// A report about another instance, and who may read it.
//
// A report is the reporter's own. The reporter's account id crosses with it,
// the reason the reporter typed crosses with it, and nothing about the
// reporter crosses - but the report is still theirs, and an id that names
// somebody else's report is not found.
//
// The check was on the direction alone: any signed-in account that learned or
// guessed the id of an outbound report could read it. This file proves the
// refusal.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  startRouted, registerUser,
  createCommunity, postMessage,
} = require('../support/harness');

/** A peer instance this one federates with. */
async function addPeer(ws, id, origin, publicKey) {
  await ws.db.run(
    'INSERT INTO continuum_instances (id, name, origin, public_key, trust_status, created_at)'
    + ' VALUES (?, ?, ?, ?, ?, ?)',
    [id, 'Peer', origin, publicKey, 'trusted', new Date().toISOString()]
  );
}

test('a report is the reporter\'s own', async (t) => {
  const ws = await startRouted();
  t.after(() => ws.stop());

  const ada = await registerUser(ws, 'ada');
  const bob = await registerUser(ws, 'bob');

  const community = await createCommunity(ws, ada, 'Federated');
  await ws.db.run('UPDATE servers SET is_public = 1 WHERE id = ?', [community.serverId]);
  const message = await postMessage(ada, community.channelId, 'the sentence that is reported');
  await addPeer(ws, 'peer', 'https://peer.example', 'not-a-real-key');

  const filed = await ada.post('/api/federation-reports', {
    targetInstanceId: 'peer',
    communityId: community.serverId,
    channelId: community.channelId,
    contentId: message.id,
    contentType: 'message',
    reason: 'a reason only the reporter knows',
  });
  assert.equal(filed.status, 201, JSON.stringify(filed.data));
  const reportId = filed.data.id;

  await t.test('the reporter reads their own report', async () => {
    const res = await ada.get('/api/federation-reports/mine/' + reportId);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.id, reportId);
    assert.equal(res.data.reason, 'a reason only the reporter knows');
  });

  await t.test('another account does not', async () => {
    const res = await bob.get('/api/federation-reports/mine/' + reportId);
    assert.equal(res.status, 404, JSON.stringify(res.data));
    assert.equal(res.data.error.code, 'NOT_FOUND');
    assert.ok(!JSON.stringify(res.data).includes('a reason only the reporter knows'),
      'the report must not leak to another account');
  });

  await t.test('the list is the reporter\'s too', async () => {
    const mine = await bob.get('/api/federation-reports/mine');
    assert.equal(mine.status, 200, JSON.stringify(mine.data));
    assert.equal(mine.data.length, 0, 'another account sees none of the reporter\'s reports');
    const theirs = await ada.get('/api/federation-reports/mine');
    assert.equal(theirs.status, 200);
    assert.equal(theirs.data.length, 1);
    assert.equal(theirs.data[0].id, reportId);
  });

  await t.test('an inbound report is not reachable through the reporter route', async () => {
    const inbound = await ws.db.get(
      'SELECT id FROM cross_instance_reports WHERE direction = ? LIMIT 1', ['inbound']
    );
    if (!inbound) return;
    const res = await ada.get('/api/federation-reports/mine/' + inbound.id);
    assert.equal(res.status, 404, JSON.stringify(res.data));
  });
});
