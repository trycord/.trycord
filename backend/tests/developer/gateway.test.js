// The application gateway.
//
// An application that can post and cannot hear anything is a mail-merge,
// not a bot. The gateway is what an application holds open to receive the
// events of its community.
//
// The checks are the ones that matter:
//
//   - a ticket is issued to the application and to nobody else;
//   - the ticket is spent once, and a spent ticket opens nothing;
//   - an application hears the events it asked for, and only those;
//   - an application hears the events of its own community, and no other;
//   - a disabled application is not connected, and cannot connect;
//   - the envelope a bot is handed is the envelope a webhook is handed.
//
// The last one matters most: two receivers of the same event must not be
// able to see different events, because a bot that disagrees with a webhook
// about what happened is worse than no bot at all.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startInstance, registerUser, apiClient } = require('../helpers/instance');

test('the application gateway', async (t) => {
  const instance = await startInstance();
  t.after(() => instance.stop());

  const owner = await registerUser(instance, 'owner');
  const other = await registerUser(instance, 'other');

  // A community with an application in it.
  const community = await owner.post('/api/servers', {
    name: 'Gateway community', description: 'A community with a bot.',
  });
  const serverId = community.data.serverId;

  // The application, and its token.
  const application = await owner.post('/api/v1/communities/' + serverId + '/applications', {
    name: 'The bot', description: 'A bot that listens.', scopes: [],
  });
  assert.equal(application.status, 201, JSON.stringify(application.data));
  const token = application.data.token;
  const applicationId = application.data.application.id;
  assert.ok(token, 'no token was issued');

  // A client that presents the application's own token.
  //
  // The helper's client puts its own token in the Authorization header and
  // overwrites any the caller supplies, so a machine credential needs a
  // client of its own.
  const botApi = apiClient(instance.baseUrl, token);
  const asBot = (method, path, body) => {
    if (method === 'GET') return botApi.get(path);
    if (method === 'POST') return botApi.post(path, body);
    if (method === 'PATCH') return botApi.patch(path, body);
    if (method === 'PUT') return botApi.put(path, body);
    return botApi.del(path, body);
  };

  await t.test('a ticket is issued to the application', async () => {
    const res = await asBot('POST', '/api/v1/applications/' + applicationId + '/gateway-ticket');
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.ok(res.data.ticket, 'no ticket was issued');
    assert.ok(res.data.expiresInMs > 0, 'the ticket does not say how long it lives');
  });

  await t.test('a session cannot ask for a ticket for an application', async () => {
    const res = await owner.post('/api/v1/applications/' + applicationId + '/gateway-ticket');
    assert.equal(res.status, 404,
      'a signed-in reader asked for a ticket for an application: ' + JSON.stringify(res.data));
  });

  await t.test('an application cannot ask for a ticket for another application', async () => {
    const otherApplication = await owner.post('/api/v1/communities/' + serverId + '/applications', {
      name: 'Another bot', scopes: [],
    });
    const res = await botApi.post(
      '/api/v1/applications/' + otherApplication.data.application.id + '/gateway-ticket',
    );
    assert.equal(res.status, 403,
      'an application asked for a ticket for another application: ' + JSON.stringify(res.data));
  });

  await t.test('a ticket is spent once', async () => {
    const gateway = require('../../src/services/developer/gateway');
    const ticket = gateway.issueTicket(applicationId, serverId);
    const first = gateway.consumeTicket(ticket);
    assert.ok(first, 'a fresh ticket was refused');
    const second = gateway.consumeTicket(ticket);
    assert.equal(second, null, 'a spent ticket was accepted a second time');
  });

  await t.test('a ticket for an application that has been disabled opens nothing', async () => {
    const gateway = require('../../src/services/developer/gateway');
    const disabled = await owner.post('/api/v1/communities/' + serverId + '/applications', {
      name: 'A disabled bot', scopes: [],
    });
    const disabledId = disabled.data.application.id;
    await owner.post('/api/v1/communities/' + serverId + '/applications/' + disabledId + '/revoke', {
      reason: 'the test',
    });
    const ticket = gateway.issueTicket(disabledId, serverId);
    const application = await gateway.applicationFor(ticket);
    assert.equal(application, null, 'a disabled application was let in');
  });

  await t.test('an application hears the events it asked for, and only those', async () => {
    const gateway = require('../../src/services/developer/gateway');
    const events = require('../../src/services/developer/events');

    // A socket that stands in for the bot's.
    const received = [];
    const socket = {
      send: (body) => { received.push(JSON.parse(body)); },
      close: () => { /* the test closes it */ },
    };
    const application = { applicationId, communityId: serverId, name: 'The bot' };
    const connection = gateway.register(application, socket);
    t.after(() => gateway.unregister(connection));

    // It asked for one event.
    const accepted = gateway.subscribe(connection, ['message.created', 'not.a.real.event', 'message.created']);
    assert.deepEqual(accepted, ['message.created'], 'the acknowledgement lists only unique supported events');

    const envelope = await events.dispatch({
      communityId: serverId,
      type: 'message.created',
      data: { message: { id: 'm1' } },
    });
    assert.ok(envelope.length, 'the dispatch reported nothing at all');
    assert.equal(received.length, 1, 'the application did not receive the event it asked for');
    // The envelope's own name for the event, and the community it happened
    // in.
    assert.equal(received[0].event, 'message.created');
    assert.equal(received[0].serverId, serverId);

    // An event it did not ask for.
    received.length = 0;
    await events.dispatch({
      communityId: serverId,
      type: 'channel.created',
      data: { channel: { id: 'c1' } },
    });
    assert.equal(received.length, 0, 'the application received an event it did not ask for');
  });

  await t.test('an application hears nothing of another community', async () => {
    const gateway = require('../../src/services/developer/gateway');
    const events = require('../../src/services/developer/events');

    const received = [];
    const socket = {
      send: (body) => { received.push(JSON.parse(body)); },
      close: () => { /* the test closes it */ },
    };
    const connection = gateway.register(
      { applicationId, communityId: serverId, name: 'The bot' }, socket,
    );
    t.after(() => gateway.unregister(connection));
    gateway.subscribe(connection, ['message.created']);

    await events.dispatch({
      communityId: 'some-other-community',
      type: 'message.created',
      data: { message: { id: 'm2' } },
    });
    assert.equal(received.length, 0, 'the application heard an event of another community');
  });

  await t.test('the envelope a bot is handed is the envelope a webhook is handed', async () => {
    const gateway = require('../../src/services/developer/gateway');
    const events = require('../../src/services/developer/events');

    const received = [];
    const socket = {
      send: (body) => { received.push(JSON.parse(body)); },
      close: () => { /* the test closes it */ },
    };
    const connection = gateway.register(
      { applicationId, communityId: serverId, name: 'The bot' }, socket,
    );
    t.after(() => gateway.unregister(connection));
    gateway.subscribe(connection, ['message.created']);

    // A webhook that is subscribed to the same event, so the two receivers
    // can be compared.
    const hooked = [];
    events.setTransport(async ({ body }) => {
      hooked.push(JSON.parse(body));
      return { status: 'delivered', statusCode: 200 };
    });
    t.after(() => events.setTransport(null));

    // The webhook and its subscription, so the dispatch has one to deliver to.
    const webhook = await owner.post('/api/v1/communities/' + serverId + '/webhooks', {
      name: 'The hook',
      url: 'https://example.org/hook',
      events: ['message.created'],
    });
    assert.equal(webhook.status, 201, JSON.stringify(webhook.data));

    const before = Date.now();
    await events.dispatch({
      communityId: serverId,
      type: 'message.created',
      data: { message: { id: 'm3' } },
    });

    assert.equal(hooked.length, 1, 'the webhook was not handed the event');
    assert.equal(received.length, 1, 'the bot was not handed the event');
    assert.deepEqual(received[0], hooked[0],
      'the bot and the webhook were handed different events');
    assert.ok(received[0].id, 'the envelope carries no id');
    assert.ok(received[0].at, 'the envelope carries no time');
    assert.ok(received[0].v, 'the envelope carries no version');
  });

  await t.test('the gateway state says who is connected', async () => {
    const res = await asBot('GET', '/api/v1/applications/' + applicationId + '/gateway');
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.ok(res.data.application, 'the state does not say about the application');
    assert.equal(res.data.application.id, applicationId);
  });
});
