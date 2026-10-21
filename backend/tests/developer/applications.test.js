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
    // The message is written by the bot, not by the person who made it. It
    // used to be attributed to the owner, which made a bot look like a human
    // in the channel and gave the bot the owner's rights.
    assert.equal(res.data.author_id, created.application.botUserId,
      'the message is attributed to the bot');
    assert.notEqual(res.data.author_id, session.user.id,
      'and not to the developer who made it');
  });

  await t.test('a bot reads community data as its own account with scoped pages', async () => {
    const created = await createApplication([
      'communities:read', 'members:read', 'channels:read', 'roles:read',
      'bots:read', 'commands:read',
    ]);
    const bot = apiClient(base, created.token);

    const communityInfo = await bot.get('/communities/' + communityId);
    assert.equal(communityInfo.status, 200, JSON.stringify(communityInfo.data));
    assert.equal(communityInfo.data.community.id, communityId);

    const firstPage = await bot.get('/communities/' + communityId + '/members?limit=1&offset=0');
    const secondPage = await bot.get('/communities/' + communityId + '/members?limit=1&offset=1');
    assert.equal(firstPage.status, 200, JSON.stringify(firstPage.data));
    assert.equal(firstPage.data.offset, 0);
    assert.equal(firstPage.data.limit, 1);
    assert.equal(firstPage.data.hasMore, true);
    assert.equal(secondPage.data.offset, 1);
    assert.notEqual(firstPage.data.members[0].userId, secondPage.data.members[0].userId,
      'the offset selects a different member');

    const complete = await bot.get('/communities/' + communityId + '/members?limit=200');
    assert.equal(complete.data.total, complete.data.members.length);
    const botMember = complete.data.members.find((member) => member.userId === created.application.botUserId);
    assert.ok(botMember, 'the application has its own community membership');
    assert.equal(botMember.isBot, true);
    assert.notEqual(botMember.userId, session.user.id, 'the bot does not act as its creator');

    const channelInfo = await bot.get('/communities/' + communityId + '/channels/' + channelId);
    assert.equal(channelInfo.status, 200, JSON.stringify(channelInfo.data));
    assert.equal(channelInfo.data.channel.id, channelId);

    const roleList = await bot.get('/communities/' + communityId + '/roles');
    assert.equal(roleList.status, 200, JSON.stringify(roleList.data));
    assert.ok(roleList.data.roles.some((role) => role.name === '@everyone'));

    const ownCommands = await bot.get('/communities/' + communityId + '/applications/'
      + created.application.id + '/commands');
    assert.equal(ownCommands.status, 200, JSON.stringify(ownCommands.data));
    const ownHealth = await bot.get('/communities/' + communityId + '/applications/'
      + created.application.id + '/health');
    assert.equal(ownHealth.status, 200, JSON.stringify(ownHealth.data));

    const other = await createApplication(['messages:write']);
    const otherHealth = await bot.get('/communities/' + communityId + '/applications/'
      + other.application.id + '/health');
    assert.equal(otherHealth.status, 403, 'a bot cannot inspect another application');
    assert.equal(otherHealth.data.error.code, 'PERMISSION_DENIED');

    const unscoped = await createApplication([]);
    const denied = await apiClient(base, unscoped.token).get('/communities/' + communityId);
    assert.equal(denied.status, 403);
    assert.equal(denied.data.error.code, 'INSUFFICIENT_SCOPE');

    const openapi = await sessionApi.get('/openapi.json');
    assert.equal(openapi.status, 200);
    assert.ok(openapi.data.paths['/communities/{serverId}/channels/{channelId}']
      .get, 'the channel read is described by the live contract');
    assert.ok(openapi.data.paths['/communities/{serverId}/roles'].get,
      'the role read is described by the live contract');
    assert.ok(openapi.data.paths['/communities/{serverId}/members'].get.parameters
      .some((parameter) => parameter.name === 'offset'), 'member pagination is in OpenAPI');
    assert.ok(openapi.data.paths['/communities/{serverId}/channels/{channelId}/messages'].get.parameters
      .some((parameter) => parameter.name === 'before'), 'message cursors are in OpenAPI');
  });

  await t.test('an older application gets a bot identity instead of borrowing its creator', async () => {
    const created = await createApplication(['communities:read', 'members:read', 'bots:read']);
    const oldBotId = created.application.botUserId;
    await instance.db.run('UPDATE bot_applications SET bot_user_id = NULL WHERE id = ?', [created.application.id]);

    const members = await apiClient(base, created.token)
      .get('/communities/' + communityId + '/members?limit=200');
    assert.equal(members.status, 200, JSON.stringify(members.data));

    const stored = await sessionApi.get(
      '/communities/' + communityId + '/applications/' + created.application.id
    );
    assert.equal(stored.status, 200, JSON.stringify(stored.data));
    const botUserId = stored.data.application.botUserId;
    assert.ok(botUserId);
    assert.notEqual(botUserId, session.user.id, 'the creator is never used as the bot');
    assert.notEqual(botUserId, oldBotId, 'a legacy account is not silently reused');
    assert.ok(members.data.members.some((member) => member.userId === botUserId && member.isBot));
    assert.equal('token_hash' in stored.data.application, false, 'the raw token hash is not returned');
    assert.ok(await instance.db.get('SELECT id FROM users WHERE id = ?', [oldBotId]),
      'the repair leaves the old account and its data intact');
  });

  await t.test('message history pages older messages with a sequence cursor', async () => {
    const channel = await apiClient(instance.baseUrl, session.token)
      .post('/api/servers/' + communityId + '/channels', { name: 'message-history' });
    assert.equal(channel.status, 200, JSON.stringify(channel.data));
    const created = await createApplication(['messages:read', 'messages:write']);
    const bot = apiClient(base, created.token);
    for (const content of ['page one', 'page two', 'page three']) {
      const sent = await bot.post('/communities/' + communityId + '/channels/' + channel.data.id + '/messages', { content });
      assert.equal(sent.status, 201, JSON.stringify(sent.data));
    }

    const recent = await bot.get('/communities/' + communityId + '/channels/' + channel.data.id
      + '/messages?limit=2');
    assert.equal(recent.status, 200, JSON.stringify(recent.data));
    assert.equal(recent.data.messages.length, 2);
    assert.equal(recent.data.hasMore, true);
    assert.ok(recent.data.nextBefore);

    const older = await bot.get('/communities/' + communityId + '/channels/' + channel.data.id
      + '/messages?limit=2&before=' + recent.data.nextBefore);
    assert.equal(older.status, 200, JSON.stringify(older.data));
    assert.equal(older.data.messages.length, 1);
    assert.equal(older.data.hasMore, false);
    assert.equal(older.data.messages[0].content, 'page one');
    assert.ok(older.data.messages[0].seq < recent.data.messages[0].seq);

    const invalid = await bot.get('/communities/' + communityId + '/channels/' + channel.data.id
      + '/messages?before=not-a-sequence');
    assert.equal(invalid.status, 400);
    assert.equal(invalid.data.error.code, 'VALIDATION_ERROR');
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
