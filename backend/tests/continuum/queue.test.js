// The outbox.
//
// What an operator sees when a peer cannot be reached: the event stays
// pending while it is retried, it is retried a bounded number of times, and
// then it is a reported failure with a reason - not something that is tried
// forever in the background.
//
// What an operator sees when a peer can be reached: the event is delivered,
// the destination is recorded, and the attempt count is there to be read.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerUser } = require('../helpers/instance');
const {
  startFederatedInstance,
  startCapturePeer,
  closedPort,
  waitFor,
  sleep,
  eventsAboutMessage,
} = require('./helpers');

test('the outbox reports what was delivered and what failed', async (t) => {
  // Three attempts and a short wait, so a failure is watched rather than
  // waited out.
  const instance = await startFederatedInstance('instance-a', {
    CONTINUUM_MAX_ATTEMPTS: '3',
    CONTINUUM_RETRY_BASE_MS: '50',
  });
  const capture = await startCapturePeer('capture-peer');
  t.after(async () => {
    await capture.stop();
    await instance.stop();
  });

  const admin = await registerUser(instance, 'operator');

  // A peer at an address nothing is listening on: the delivery fails for
  // real, with a real connection error.
  const deadPort = await closedPort();
  const dead = await admin.post('/api/continuum/instances', {
    id: 'dead-peer',
    name: 'a peer that is not there',
    origin: 'http://127.0.0.1:' + deadPort,
    public_key: capture.publicKey,
  });
  assert.equal(dead.status, 201, JSON.stringify(dead.data));
  await admin.patch('/api/continuum/instances/dead-peer/trust', { trust_status: 'trusted' });

  // And a peer that is there.
  const live = await admin.post('/api/continuum/instances', {
    id: capture.instanceId,
    name: 'capture',
    origin: capture.origin,
    public_key: capture.publicKey,
  });
  assert.equal(live.status, 201, JSON.stringify(live.data));
  await admin.patch('/api/continuum/instances/' + capture.instanceId + '/trust', { trust_status: 'trusted' });

  const created = await admin.post('/api/servers', { name: 'Queue Community', isPublic: true });
  assert.equal(created.status, 200, JSON.stringify(created.data));

  await t.test('an event to a peer that cannot be reached ends in a reported failure', async () => {
    const posted = await admin.post('/api/channels/' + created.data.channelId + '/messages', {
      content: 'a message nobody is listening for',
    });
    assert.equal(posted.status, 200, JSON.stringify(posted.data));

    const event = await waitFor(async () => {
      const events = await eventsAboutMessage(admin, posted.data.id);
      return events.find((e) => e.status === 'failed') || null;
    }, { timeout: 30000, message: 'the event to fail after its attempts are spent' });

    assert.equal(event.status, 'failed', 'a spent event is a terminal state');
    assert.equal(event.attempts, event.max_attempts, 'the attempts are counted');
    assert.ok(event.error, 'the failure says why: ' + JSON.stringify(event.error));

    const deliveries = await admin.get('/api/continuum/deliveries?event_id=' + event.id);
    assert.ok(deliveries.ok, JSON.stringify(deliveries.data));
    const dead_ = deliveries.data.find((d) => d.instance_id === 'dead-peer');
    assert.ok(dead_, 'the unreachable peer is reported');
    assert.equal(dead_.status, 'failed');
    assert.equal(dead_.attempts, event.max_attempts, 'every attempt is counted');
    assert.ok(dead_.error, 'the reason is kept');

    // And it is not retried forever.
    await sleep(1500);
    const after = await admin.get('/api/continuum/deliveries?event_id=' + event.id);
    const deadAfter = after.data.find((d) => d.instance_id === 'dead-peer');
    assert.equal(deadAfter.attempts, event.max_attempts, 'a failed delivery is not retried again');
  });

  await t.test('a delivery that works is recorded as delivered with its attempts', async () => {
    const posted = await admin.post('/api/channels/' + created.data.channelId + '/messages', {
      content: 'a message for the peer that is there',
    });
    assert.equal(posted.status, 200, JSON.stringify(posted.data));

    const event = await waitFor(async () => {
      const events = await eventsAboutMessage(admin, posted.data.id);
      return events.find((e) => e.kind === 'message.posted') || null;
    }, { message: 'the event to be written to the outbox' });

    const deliveries = await waitFor(async () => {
      const res = await admin.get('/api/continuum/deliveries?event_id=' + event.id);
      const live_ = res.data.find((d) => d.instance_id === capture.instanceId);
      return live_ && live_.status === 'delivered' ? live_ : null;
    }, { message: 'the delivery to be recorded' });

    assert.equal(deliveries.status, 'delivered');
    assert.equal(deliveries.attempts, 1, 'a delivery that works is one attempt');

    // The peer really did receive it: the envelope arrived over HTTP.
    const received = await waitFor(async () => {
      const envelopes = capture.envelopes().filter((e) => e.id === event.id);
      return envelopes[0] || null;
    }, { message: 'the peer to receive the envelope' });
    assert.equal(received.kind, 'message.posted');
    assert.equal(received.key_id, 'instance-a');
  });
});
