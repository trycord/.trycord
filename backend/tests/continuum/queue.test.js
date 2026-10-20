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

// The change feed.
//
// The feed publishes from the instance's own state, not from a hook in every
// write path. What that buys is that a change cannot be published twice and
// cannot be missed by accident; what it costs is latency, and the latency
// has to be bounded and visible.
//
// This instance runs without the background jobs, so the feed is driven from
// the test: what is in the outbox is what the feed published, and nothing
// else was.
test('the change feed publishes once, and says how far behind it is', async (t) => {
  const instance = await startFederatedInstance('instance-a', {
    CONTINUUM_FEED_INTERVAL_MS: '200',
  }, { jobs: false });
  t.after(() => instance.stop());

  const admin = await registerUser(instance, 'operator');
  const created = await admin.post('/api/servers', { name: 'Feed Community', isPublic: true });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const channelId = created.data.channelId;

  const feedPass = () => instance.modules.feed.run(instance.modules.continuum.publishEvent);

  await t.test('the feed does not publish a change twice', async () => {
    const posted = await admin.post('/api/channels/' + channelId + '/messages', {
      content: 'a message the feed will find',
    });
    assert.equal(posted.status, 200, JSON.stringify(posted.data));

    await feedPass();
    const first = await eventsAboutMessage(admin, posted.data.id);
    assert.equal(first.length, 1, 'the message is published once');
    assert.equal(first[0].kind, 'message.posted');

    // The ledger is the record: a second pass over the same row publishes
    // nothing.
    await feedPass();
    await feedPass();
    const second = await eventsAboutMessage(admin, posted.data.id);
    assert.equal(second.length, 1, 'the message is not published again');
    assert.equal(second[0].id, first[0].id, 'it is the same event');
  });

  await t.test('a message edited twice quickly is published as one change, not three', async () => {
    const posted = await admin.post('/api/channels/' + channelId + '/messages', {
      content: 'the first version',
    });
    assert.equal(posted.status, 200, JSON.stringify(posted.data));
    await feedPass();

    // Two edits, one after the other. The feed publishes the state the
    // message is in, not every state it was in.
    const edited = await admin.patch(
      '/api/channels/' + channelId + '/messages/' + posted.data.id,
      { content: 'the second version' }
    );
    assert.equal(edited.status, 200, JSON.stringify(edited.data));
    const editedAgain = await admin.patch(
      '/api/channels/' + channelId + '/messages/' + posted.data.id,
      { content: 'the third version' }
    );
    assert.equal(editedAgain.status, 200, JSON.stringify(editedAgain.data));

    // The change has not settled yet: the words may be edited again.
    await feedPass();
    const whileMoving = await eventsAboutMessage(admin, posted.data.id);
    assert.equal(whileMoving.length, 1, 'a change that has not settled is not published');

    // And once it has, it is published once, carrying the last version.
    await sleep(300);
    await feedPass();
    const settled = await eventsAboutMessage(admin, posted.data.id);
    assert.equal(settled.length, 2, 'the message is published once and edited once');
    const edit = settled.find((event) => event.kind === 'message.edited');
    assert.ok(edit, 'the edit is published');
    assert.equal(edit.payload.message.content, 'the third version', 'it carries the last version');
  });

  await t.test('the lag is observable', async () => {
    const status = await admin.get('/api/continuum/feed');
    assert.ok(status.ok, JSON.stringify(status.data));
    assert.equal(status.data.interval_ms, 200, 'the feed says how often it runs');
    assert.equal(status.data.bound_ms, 400, 'and the bound on a change being noticed');
    assert.ok(status.data.last_pass_at, 'the feed says when it last ran');
    assert.ok(status.data.lag_ms >= 0, 'and how long ago that was');
    assert.equal(status.data.behind, false, 'it is not behind');

    // Nothing runs the feed in this instance, so the lag grows - and the
    // operator is told rather than left to guess.
    await sleep(700);
    const behind = await admin.get('/api/continuum/feed');
    assert.equal(behind.data.behind, true, 'a feed that falls behind is visible');
    assert.ok(behind.data.lag_ms >= 700, 'the lag is the time since the last pass');
    assert.ok(behind.data.published >= 1, 'and it says what it published');
  });
});
