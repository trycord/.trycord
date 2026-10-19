// The public event envelope: the shape a subscriber receives, and that it
// receives one.
//
// The envelope is a contract, so the test is about the contract: the fields
// the documentation names are the fields the body has, and a subscriber to a
// community's events gets a body with the documented version.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startInstance, apiClient, registerUser } = require('../helpers/instance');
const { ensureVersionedApi } = require('./helpers/developer');

// Wait for something that happens on its own schedule. A delivery is not
// awaited by the request that caused it, so the test waits rather than
// assuming.
async function waitFor(probe, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return null;
}

test('the public event envelope', async (t) => {
  const instance = await startInstance();
  t.after(() => instance.stop());
  const base = await ensureVersionedApi(instance);

  // Required after the instance has started: the server clears the module
  // registry before it boots, so a module loaded before the boot would hold
  // a database connection that was never opened.
  const db = require('../../src/db');
  const events = require('../../src/services/developer/events');

  await t.test('the envelope has the documented shape', () => {
    const envelope = events.buildEnvelope({
      type: 'message.created',
      id: 'delivery-1',
      instance: { id: 'local', name: 'Trycord Verification' },
      communityId: 'community-1',
      channelId: 'channel-1',
      actor: { id: 'user-1', type: 'user' },
      data: { message: { id: 'm1', authorId: 'user-1', content: 'hello' } },
    });

    assert.equal(envelope.v, events.ENVELOPE_VERSION, 'the envelope says which version it is');
    assert.equal(envelope.event, 'message.created', 'the envelope names the event');
    assert.equal(envelope.id, 'delivery-1', 'the envelope names the delivery');
    assert.ok(!Number.isNaN(new Date(envelope.at).getTime()), 'the envelope says when it happened');
    assert.deepEqual(envelope.instance, { id: 'local', name: 'Trycord Verification' });
    assert.equal(envelope.serverId, 'community-1', 'the envelope names the community');
    assert.equal(envelope.channelId, 'channel-1', 'the envelope names the channel');
    assert.deepEqual(envelope.actor, { id: 'user-1', type: 'user' });
    // The event's own fields stay where the older deliveries put them, so a
    // consumer written against those keeps reading them.
    assert.deepEqual(envelope.message, { id: 'm1', authorId: 'user-1', content: 'hello' });
  });

  await t.test('the documented fields are the fields the envelope has', async () => {
    const session = await registerUser(instance, 'reader');
    const res = await apiClient(base, session.token).get('/events');
    assert.equal(res.status, 200);
    assert.equal(res.data.envelope.version, events.ENVELOPE_VERSION);
    for (const field of Object.keys(res.data.envelope.fields)) {
      const envelope = events.buildEnvelope({
        type: 'message.created',
        id: 'delivery-2',
        instance: { id: 'local', name: 'Trycord Verification' },
        communityId: 'community-1',
        data: {},
      });
      assert.ok(field in envelope, 'the envelope has the field ' + field);
    }
    assert.ok(res.data.types.includes('message.created'), 'the vocabulary names the event');
  });

  await t.test('a subscriber receives the envelope', async () => {
    const session = await registerUser(instance, 'ada');
    const sessionApi = apiClient(base, session.token);

    const community = await apiClient(instance.baseUrl, session.token).post('/api/servers', { name: 'Events' });
    assert.equal(community.status, 200, 'the community is created: ' + JSON.stringify(community.data));
    const communityId = community.data.serverId;
    const channelId = community.data.channelId;

    // The endpoint. The API refuses a URL it cannot vouch for, so the row is
    // written here: what is under test is the delivery, not the URL check.
    const webhookId = 'hook_' + Date.now().toString(36);
    await db.run(
      'INSERT INTO webhooks (id, server_id, channel_id, name, url, secret_hash, created_by, active, created_at)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)',
      [webhookId, communityId, channelId, 'events', 'https://example.invalid/hook', 'test-secret-hash-events', session.user.id, new Date().toISOString()]
    );

    const subscribed = await sessionApi.post('/communities/' + communityId + '/subscriptions', {
      webhookId,
      events: ['message.created'],
    });
    assert.equal(subscribed.status, 201, 'the subscription is created: ' + JSON.stringify(subscribed.data));
    assert.deepEqual(subscribed.data.subscription.events, ['message.created']);

    // The application that posts the message.
    const application = await sessionApi.post('/communities/' + communityId + '/applications', {
      name: 'poster',
      scopes: ['communities:write', 'messages:write'],
    });
    assert.equal(application.status, 201, 'the application is created: ' + JSON.stringify(application.data));
    assert.ok(application.data.token, 'the application is given a token');
    assert.deepEqual(application.data.credential.scopes, ['communities:write', 'messages:write']);

    // What the endpoint receives.
    const received = [];
    events.setTransport(async ({ body, id, type }) => {
      received.push({ body: JSON.parse(body), id, type });
      return { status: 'delivered', statusCode: 200, error: null };
    });
    t.after(() => events.setTransport(null));

    const posted = await apiClient(base, application.data.token)
      .post('/communities/' + communityId + '/channels/' + channelId + '/messages', {
        content: 'hello from the application',
      });
    assert.equal(posted.status, 201, 'the message is posted: ' + JSON.stringify(posted.data));

    const delivery = await waitFor(() => received[0]);
    assert.ok(delivery, 'the subscriber received the event');
    assert.equal(delivery.type, 'message.created', 'the delivery names the event');
    assert.equal(delivery.body.v, events.ENVELOPE_VERSION, 'the body says which version it is');
    assert.equal(delivery.body.event, 'message.created');
    assert.equal(delivery.body.serverId, communityId, 'the body names the community');
    assert.equal(delivery.body.channelId, channelId, 'the body names the channel');
    assert.equal(delivery.body.message.content, 'hello from the application', 'the body carries the event');
    assert.deepEqual(delivery.body.actor, { id: application.data.application.id, type: 'application' });
    assert.equal(delivery.body.id, delivery.id, 'the body and the delivery header carry the same id');

    // The delivery is in the log the rest of the instance writes to.
    const log = await db.all(
      'SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC',
      [webhookId]
    );
    assert.equal(log.length, 1, 'the delivery was recorded');
    assert.equal(log[0].status, 'delivered');
    assert.equal(log[0].event_type, 'message.created');
  });

  await t.test('a subscription only receives the events it asked for', async () => {
    const session = await registerUser(instance, 'kay');
    const sessionApi = apiClient(base, session.token);
    const community = await apiClient(instance.baseUrl, session.token).post('/api/servers', { name: 'Quiet' });
    const communityId = community.data.serverId;

    const webhookId = 'hook_' + Date.now().toString(36);
    await db.run(
      'INSERT INTO webhooks (id, server_id, name, url, secret_hash, created_by, active, created_at)'
      + ' VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
      [webhookId, communityId, 'quiet', 'https://example.invalid/quiet', 'test-secret-hash-quiet', session.user.id, new Date().toISOString()]
    );
    await sessionApi.post('/communities/' + communityId + '/subscriptions', {
      webhookId,
      events: ['member.joined'],
    });

    const received = [];
    events.setTransport(async ({ body }) => {
      received.push(JSON.parse(body));
      return { status: 'delivered', statusCode: 200, error: null };
    });
    t.after(() => events.setTransport(null));

    await events.dispatch({
      communityId,
      type: 'message.created',
      instance: { id: 'local', name: 'Trycord Verification' },
      data: {},
    });
    assert.equal(received.length, 0, 'an event the subscription did not ask for is not delivered');

    await events.dispatch({
      communityId,
      type: 'member.joined',
      instance: { id: 'local', name: 'Trycord Verification' },
      data: {},
    });
    assert.equal(received.length, 1, 'the event it asked for is delivered');
    assert.equal(received[0].event, 'member.joined');
  });
});
