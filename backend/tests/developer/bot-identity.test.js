// A bot is not its developer.
//
// An application used to post under the account of the person who made it:
// the messages were attributed to a human, the bot was invisible in the
// channel, and everything it could do was measured against its owner's
// rights. These are the checks that it is a first-class identity of its own.
//
// What is asserted:
//
//   - the application is born with an account, and the account is a bot;
//   - the account belongs to the community the application was made in;
//   - a message the application posts is written by the bot, not by the
//     developer;
//   - the developer cannot post as the bot with their own session.
//
// The last one matters as much as the first: a bot that can be impersonated
// by its owner is not a separate identity.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startInstance, apiClient, registerUser } = require('../helpers/instance');
const { ensureVersionedApi } = require('./helpers/developer');

test('a bot has an account of its own', async (t) => {
  const instance = await startInstance();
  t.after(() => instance.stop());
  const base = await ensureVersionedApi(instance);

  const session = await registerUser(instance, 'ada');
  const sessionApi = apiClient(base, session.token);
  const community = await apiClient(instance.baseUrl, session.token).post('/api/servers', { name: 'Bots' });
  assert.equal(community.status, 200);
  const communityId = community.data.serverId;
  const channelId = community.data.channelId;

  const created = await sessionApi.post('/communities/' + communityId + '/applications', {
    name: 'helper',
    scopes: ['messages:write', 'messages:read'],
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const application = created.data.application;
  const token = created.data.token;

  await t.test('the application is born with an account', async () => {
    assert.ok(application.botUserId, 'the application names the account it posts as');
    const bot = await apiClient(instance.baseUrl, session.token)
      .get('/api/users/' + application.botUserId);
    assert.equal(bot.status, 200, JSON.stringify(bot.data));
    assert.equal(bot.data.isBot, true, 'the account is a bot');
    assert.ok(bot.data.username, 'the bot has a name of its own');
    assert.notEqual(bot.data.id, session.user.id, 'the bot is not the developer');
  });

  await t.test('the bot belongs to the community', async () => {
    const members = await apiClient(instance.baseUrl, session.token)
      .get('/api/servers/' + communityId + '/members');
    assert.equal(members.status, 200, JSON.stringify(members.data));
    const found = (members.data.items || []).find((m) => m.id === application.botUserId);
    assert.ok(found, 'the bot is in the member list');
    assert.equal(found.is_bot, true, 'the member list says it is a bot');
  });

  await t.test('a message the bot posts is written by the bot', async () => {
    const botApi = apiClient(instance.baseUrl, token);
    const posted = await botApi.post('/api/bot/channels/' + channelId + '/messages', { content: 'hello from the bot' });
    assert.equal(posted.status, 201, JSON.stringify(posted.data));
    assert.equal(posted.data.author_id, application.botUserId,
      'the message is written by the bot, not by the developer');

    const history = await apiClient(instance.baseUrl, session.token)
      .get('/api/channels/' + channelId + '/messages');
    assert.equal(history.status, 200, JSON.stringify(history.data));
    const rows = history.data.messages || history.data || [];
    const message = rows.find((m) => m.id === posted.data.id);
    assert.ok(message, 'the message is in the channel');
    assert.equal(message.author_id, application.botUserId, 'and it belongs to the bot');
  });

  await t.test('the versioned API posts as the bot as well', async () => {
    const botApi = apiClient(base, token);
    const posted = await botApi.post(
      '/communities/' + communityId + '/channels/' + channelId + '/messages',
      { content: 'hello from the versioned API' },
    );
    assert.equal(posted.status, 201, JSON.stringify(posted.data));
    assert.equal(posted.data.author_id, application.botUserId,
      'the message is written by the bot, not by the developer');
  });

  await t.test('a bot with the scope to post may post, and nothing more', async () => {
    // The credential that posts a message must not be able to change the
    // community's developer configuration: that is another scope, and the
    // route asks for it.
    const botApi = apiClient(base, token);
    const attempt = await botApi.post(
      '/communities/' + communityId + '/applications',
      { name: 'another one' },
    );
    assert.equal(attempt.status, 403,
      'the application cannot create applications: ' + JSON.stringify(attempt.data));
  });

  await t.test('an application can be switched off and on again', async () => {
    const off = await sessionApi.patch('/communities/' + communityId + '/applications/' + application.id, {
      status: 'disabled',
    });
    assert.equal(off.status, 200, JSON.stringify(off.data));
    assert.equal(off.data.application.status, 'disabled');

    // A disabled application is switched off, not merely quiet: the token
    // still matches, so the status is checked at the door.
    const refused = await apiClient(base, token).post(
      '/communities/' + communityId + '/channels/' + channelId + '/messages',
      { content: 'while it is off' },
    );
    assert.equal(refused.status, 403,
      'a disabled application may not post: ' + JSON.stringify(refused.data));

    const on = await sessionApi.patch('/communities/' + communityId + '/applications/' + application.id, {
      status: 'active',
    });
    assert.equal(on.status, 200, JSON.stringify(on.data));
    assert.equal(on.data.application.status, 'active');
  });

  await t.test('deleting the application takes the bot out of the community', async () => {
    const botApi = apiClient(base, token);
    const before = await apiClient(instance.baseUrl, session.token)
      .get('/api/servers/' + communityId + '/members');
    assert.ok((before.data.items || []).some((m) => m.id === application.botUserId),
      'the bot is a member while the application exists');

    const removed = await sessionApi.delete('/communities/' + communityId + '/applications/' + application.id);
    assert.equal(removed.status, 200, JSON.stringify(removed.data));

    const after = await apiClient(instance.baseUrl, session.token)
      .get('/api/servers/' + communityId + '/members');
    assert.ok(!(after.data.items || []).some((m) => m.id === application.botUserId),
      'the bot is not a member once the application is gone');

    // The token stops working with the application.
    const posted = await botApi.post(
      '/communities/' + communityId + '/channels/' + channelId + '/messages',
      { content: 'after the end' },
    );
    // The token is refused - the credential behind it was revoked with the
    // application - and the refusal says so.
    assert.ok(posted.status === 401 || posted.status === 404,
      'the token does not work after the application is deleted: ' + JSON.stringify(posted.data));
  });

  await t.test('the developer cannot speak as the bot with their own session', async () => {
    // The bot's account has no password, so there is nothing to sign in with.
    const attempt = await apiClient(instance.baseUrl, session.token)
      .post('/api/bot/channels/' + channelId + '/messages', { content: 'not the bot' });
    assert.equal(attempt.status, 404,
      'the bot API does not answer a human session: ' + JSON.stringify(attempt.data));
  });
});
