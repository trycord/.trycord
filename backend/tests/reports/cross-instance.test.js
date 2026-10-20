// A report about activity on another instance.
//
// The report crosses, and it crosses carrying as little as it has to: the
// identifier of the content and the reason for the report, and nothing else.
// The content itself does not cross, and nothing personal about the reporter
// does either.
//
// A report about a private community or a restricted channel is refused the
// way the relay refuses to federate them.

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

test('a report about another instance', async (t) => {
  const ws = await startRouted();
  t.after(() => ws.stop());

  const ada = await registerUser(ws, 'ada');
  const community = await createCommunity(ws, ada, 'Federated');
  // A community that federates is a public one: the relay rules are what
  // decide, and a report crosses under the same rules.
  await ws.db.run('UPDATE servers SET is_public = 1 WHERE id = ?', [community.serverId]);
  const message = await postMessage(ada, community.channelId, 'the sentence that is reported');

  await addPeer(ws, 'peer', 'https://peer.example', 'not-a-real-key');

  await t.test('the report carries the identifier and the reason, and not the content', async () => {
    const res = await ada.post('/api/federation-reports', {
      targetInstanceId: 'peer',
      communityId: community.serverId,
      channelId: community.channelId,
      contentId: message.id,
      contentType: 'message',
      reason: 'this message breaks the rules',
    });
    assert.equal(res.status, 201, JSON.stringify(res.data));

    const payload = res.data.payload;
    assert.equal(payload.content_id, message.id, 'the identifier of the content crossed');
    assert.equal(payload.reason, 'this message breaks the rules');
    assert.equal(payload.origin_instance_id, 'verification', 'the origin instance says who it is');
    assert.equal(payload.reporter_origin_id, ada.user.id, 'the reporter\'s account on the origin');

    const crossed = JSON.stringify(payload);
    assert.ok(!crossed.includes('the sentence that is reported'), 'the content did not cross');
    assert.ok(!crossed.includes(ada.user.username), 'the reporter\'s name did not cross');
    assert.ok(!crossed.toLowerCase().includes('password'), 'nothing personal about the reporter crossed');
    assert.deepEqual(Object.keys(payload).sort(), [
      'content_id', 'content_type', 'origin_channel_id', 'origin_community_id',
      'origin_instance_id', 'reason', 'reporter_origin_id',
    ]);
  });

  await t.test('the reporter is told what was shared and what was not', async () => {
    const res = await ada.post('/api/federation-reports', {
      targetInstanceId: 'peer',
      communityId: community.serverId,
      channelId: community.channelId,
      contentId: message.id,
      contentType: 'message',
      reason: 'another reason',
    });
    assert.equal(res.status, 201, JSON.stringify(res.data));
    assert.ok(Array.isArray(res.data.disclosure.shared));
    assert.ok(res.data.disclosure.shared.length > 0);
    assert.ok(res.data.disclosure.notShared.length > 0);
    const shared = res.data.disclosure.shared.join(' ').toLowerCase();
    const notShared = res.data.disclosure.notShared.join(' ').toLowerCase();
    assert.match(shared, /identifier of the reported content/);
    assert.match(shared, /reason for the report/);
    assert.match(notShared, /content itself/);
    assert.match(notShared, /about you/);
  });

  await t.test('a report about a private community is refused', async () => {
    const privateCommunity = await createCommunity(ws, ada, 'Private');
    await ws.db.run('UPDATE servers SET is_public = 0 WHERE id = ?', [privateCommunity.serverId]);

    const res = await ada.post('/api/federation-reports', {
      targetInstanceId: 'peer',
      communityId: privateCommunity.serverId,
      channelId: privateCommunity.channelId,
      contentId: message.id,
      contentType: 'message',
      reason: 'a report about something private',
    });
    assert.equal(res.status, 403);
    assert.match(res.data.error.message, /private/);
  });

  await t.test('a report about an instance this one does not federate with is refused', async () => {
    const res = await ada.post('/api/federation-reports', {
      targetInstanceId: 'stranger',
      communityId: community.serverId,
      channelId: community.channelId,
      contentId: message.id,
      contentType: 'message',
      reason: 'a report to nowhere',
    });
    assert.equal(res.status, 404);
  });
});

test('a report arriving from another instance', async (t) => {
  const ws = await startRouted({ env: { CONTINUUM_ENABLED: 'on' } });
  t.after(() => ws.stop());

  const admin = await registerUser(ws, 'operator');
  await ws.db.run(
    'INSERT INTO admins (user_id, created_at) VALUES (?, ?)',
    [admin.user.id, new Date().toISOString()]
  );

  // The signing key this instance uses, so a report from a peer can be
  // signed the way a peer would sign it.
  const continuum = require('../../src/services/continuum');
  const { publicKey } = continuum.prepareKeys();
  await addPeer(ws, 'peer', 'https://peer.example', publicKey);

  const payload = {
    origin_instance_id: 'peer',
    origin_community_id: 'remote-community',
    origin_channel_id: 'remote-channel',
    content_id: 'remote-message',
    content_type: 'message',
    reason: 'something that breaks the rules',
    reporter_origin_id: 'reporter-on-the-peer',
  };

  await t.test('a signed report is accepted', async () => {
    const envelope = {
      id: 'envelope-1',
      kind: 'report.filed',
      actor: null,
      target: 'remote-message',
      timestamp: new Date().toISOString(),
      payload,
      key_id: 'peer',
    };
    envelope.signature = continuum.signEvent(envelope);

    const res = await admin.post('/api/federation-reports/inbound', envelope);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.accepted, true);
    assert.equal(res.data.actionable, false, 'this instance holds nothing it could act on');
  });

  await t.test('the report is stored as a reference, not as the content', async () => {
    const rows = await ws.db.all(
      'SELECT * FROM cross_instance_reports WHERE direction = ?', ['inbound']
    );
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.content_id, 'remote-message');
    assert.equal(row.reason, 'something that breaks the rules');
    assert.equal(row.reporter_origin_id, 'reporter-on-the-peer');
    assert.ok(!String(row.reason + row.content_id).includes('breaks the rules and here is'), 'no content');
  });

  await t.test('the same report twice is not stored twice', async () => {
    const envelope = {
      id: 'envelope-1',
      kind: 'report.filed',
      actor: null,
      target: 'remote-message',
      timestamp: new Date().toISOString(),
      payload,
      key_id: 'peer',
    };
    envelope.signature = continuum.signEvent(envelope);

    const res = await admin.post('/api/federation-reports/inbound', envelope);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.duplicate, true);

    const rows = await ws.db.all(
      'SELECT COUNT(*) AS n FROM cross_instance_reports WHERE direction = ?', ['inbound']
    );
    assert.equal(rows[0].n, 1);
  });

  await t.test('a report that is not signed by the peer is refused', async () => {
    const envelope = {
      id: 'envelope-2',
      kind: 'report.filed',
      actor: null,
      target: 'remote-message',
      timestamp: new Date().toISOString(),
      payload: Object.assign({}, payload, { content_id: 'remote-message-2' }),
      key_id: 'peer',
      signature: Buffer.from('not a signature').toString('base64'),
    };

    const res = await admin.post('/api/federation-reports/inbound', envelope);
    assert.equal(res.status, 403);
    assert.match(res.data.error.message, /signature does not verify/);
  });

  await t.test('a report from an instance this one does not know is refused', async () => {
    const envelope = {
      id: 'envelope-3',
      kind: 'report.filed',
      actor: null,
      target: 'remote-message',
      timestamp: new Date().toISOString(),
      payload,
      key_id: 'stranger',
    };
    envelope.signature = continuum.signEvent(envelope);

    const res = await admin.post('/api/federation-reports/inbound', envelope);
    assert.equal(res.status, 403);
    assert.match(res.data.error.message, /not known here/);
  });
});
