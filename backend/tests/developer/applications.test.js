// The bot application lifecycle, measured against a running instance.
//
// An application is a community resource with a token, a set of scopes, a
// limit and a health. What the assertions are about: the token is shown once
// and works, rotating it ends the old one, revoking it ends the token for
// good, and an application is a scoped credential rather than a human one.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startInstance, apiClient, registerUser } = require('../helpers/instance');
const { ensureVersionedApi } = require('./helpers/developer');

test('bot applications', async (t) => {
  const instance = await startInstance();
  t.after(() => instance.stop());
  const base = await ensureVersionedApi(instance);

  const session = await registerUser(instance, 'ada');
  const sessionApi = apiClient(base, session.token);
  const community = await apiClient(instance.baseUrl, session.token).post('/api/servers', { name: 'Applications' });
  assert.equal(community.status, 200);
  const communityId = community.data.serverId;
  const channelId = community.data.channelId;

  async function createApplication(scopes) {
    const res = await sessionApi.post('/communities/' + communityId + '/applications', {
      name: 'helper',
      scopes: scopes || ['messages:write'],
    });
    assert.equal(res.status, 201, 'the application is created: ' + JSON.stringify(res.data));
    return res.data;
  }

  await t.test('an application can ask what it is', async () => {
    const created = await createApplication(['messages:read']);
    const bot = apiClient(base, created.token);
    const self = await bot.get('/applications/self');
    assert.equal(self.status, 200, JSON.stringify(self.data));
    assert.equal(self.data.application.id, created.application.id,
      'the answer names the application the token belongs to');
    assert.equal(self.data.communityId, communityId, 'and the community it was made in');
    assert.ok(!('token' in self.data), 'the token is not in the answer');
  });

  await t.test('an application is created with a token and a credential', async () => {
    const created = await createApplication(['messages:write', 'messages:read']);
    assert.ok(created.application.id, 'the application has an id');
    assert.ok(created.token.startsWith('trcd_bot_'), 'the application has a token of its own');
    assert.deepEqual(created.credential.scopes, ['messages:read', 'messages:write']);
    assert.equal(created.credential.rateLimitPerMinute, 120, 'the application has a limit');

    const list = await sessionApi.get('/communities/' + communityId + '/applications');
    assert.equal(list.status, 200);
    const found = list.data.applications.find((a) => a.id === created.application.id);
    assert.ok(found, 'the application is in the list');
    assert.equal(found.token, undefined, 'the list carries no token');
    assert.deepEqual(found.credential.scopes, ['messages:read', 'messages:write']);
  });

  await t.test('the token posts a message in the application\'s name', async () => {
    const created = await createApplication(['communities:write', 'messages:write']);
    const res = await apiClient(base, created.token)
      .post('/communities/' + communityId + '/channels/' + channelId + '/messages', { content: 'from the application' });
    assert.equal(res.status, 201, 'the message is posted: ' + JSON.stringify(res.data));
    assert.equal(res.data.content, 'from the application');
    assert.equal(res.data.author_id, session.user.id, 'the message is attributed to the owner');
  });

  await t.test('a token without the scope may not post', async () => {
    const created = await createApplication(['messages:read']);
    const res = await apiClient(base, created.token)
      .post('/communities/' + communityId + '/channels/' + channelId + '/messages', { content: 'not allowed' });
    assert.equal(res.status, 403);
    assert.equal(res.data.error.code, 'INSUFFICIENT_SCOPE');
  });

  await t.test('an application may not administer credentials', async () => {
    const created = await createApplication(['messages:write']);
    const res = await apiClient(base, created.token).post('/keys', { name: 'from a bot', scopes: ['keys:read'] });
    assert.equal(res.status, 403);
    assert.equal(res.data.error.code, 'BOT_NOT_ALLOWED');
  });

  await t.test('rotating the token ends the previous one at once', async () => {
    const created = await createApplication(['profile:read']);
    const rotated = await sessionApi.post(
      '/communities/' + communityId + '/applications/' + created.application.id + '/rotate-token', {}
    );
    assert.equal(rotated.status, 200);
    assert.ok(rotated.data.token.startsWith('trcd_bot_'));
    assert.notEqual(rotated.data.token, created.token, 'the token is a new one');

    const withOld = await apiClient(base, created.token).get('/whoami');
    assert.equal(withOld.status, 401, 'the previous token stops working');

    const withNew = await apiClient(base, rotated.data.token).get('/whoami');
    assert.equal(withNew.status, 200, 'the new token works');
    assert.equal(withNew.data.kind, 'bot');
  });

  await t.test('revoking an application burns its token', async () => {
    const created = await createApplication(['messages:write']);
    const revoked = await sessionApi.post(
      '/communities/' + communityId + '/applications/' + created.application.id + '/revoke',
      { reason: 'decommissioned' }
    );
    assert.equal(revoked.status, 200);
    assert.equal(revoked.data.application.status, 'disabled');

    const after = await apiClient(base, created.token).get('/whoami');
    assert.equal(after.status, 401, 'the token no longer authenticates');
    assert.equal(after.data.error.code, 'API_KEY_INVALID');
  });

  await t.test('the commands of an application are registered, listed and removed', async () => {
    const created = await createApplication();
    const registered = await sessionApi.put(
      '/communities/' + communityId + '/applications/' + created.application.id + '/commands',
      { name: 'ping', response: 'pong', options: [{ name: 'loud', type: 'boolean' }] }
    );
    assert.equal(registered.status, 200, 'the command is registered: ' + JSON.stringify(registered.data));
    assert.equal(registered.data.command.name, 'ping');

    const list = await sessionApi.get('/communities/' + communityId + '/applications/' + created.application.id + '/commands');
    assert.equal(list.status, 200);
    assert.equal(list.data.commands.length, 1);
    assert.equal(list.data.commands[0].response, 'pong');

    const removed = await sessionApi.delete(
      '/communities/' + communityId + '/applications/' + created.application.id
      + '/commands/' + registered.data.command.id
    );
    assert.equal(removed.status, 200);

    const after = await sessionApi.get('/communities/' + communityId + '/applications/' + created.application.id + '/commands');
    assert.equal(after.data.commands.length, 0, 'the command is gone');
  });

  await t.test('the credential of an application can be changed', async () => {
    const created = await createApplication(['messages:read']);
    const updated = await sessionApi.put(
      '/communities/' + communityId + '/applications/' + created.application.id + '/credential',
      { scopes: ['messages:read', 'messages:write'], rateLimitPerMinute: 30 }
    );
    assert.equal(updated.status, 200);
    assert.deepEqual(updated.data.credential.scopes, ['messages:read', 'messages:write']);
    assert.equal(updated.data.credential.rateLimitPerMinute, 30);
  });

  await t.test('the health of an application says what it is', async () => {
    const created = await createApplication(['messages:write']);
    const health = await sessionApi.get(
      '/communities/' + communityId + '/applications/' + created.application.id + '/health'
    );
    assert.equal(health.status, 200);
    assert.equal(health.data.state, 'configured', 'an application that has not been used is configured');
    assert.equal(health.data.rateLimitPerMinute, 120);
    assert.equal(health.data.lastFailure, null, 'it has not failed');
  });

  await t.test('an application of one community is not reachable from another', async () => {
    const created = await createApplication();
    const other = await registerUser(instance, 'grace');
    const otherCommunity = await apiClient(instance.baseUrl, other.token).post('/api/servers', { name: 'Elsewhere' });
    const res = await apiClient(base, other.token)
      .get('/communities/' + otherCommunity.data.serverId + '/applications/' + created.application.id);
    assert.equal(res.status, 404, 'the application is not in that community');
  });
});
