// What an application is, named.
//
// An application has an id it keeps for its whole life, and an account it
// posts as - a member of the community the rest of Trycord shows by its
// username, in the member list, in the messages, and in the moderation
// tools. This file checks that the developer console can see both: the id
// as it is, and the account by name - and that changing what the
// application is called or how it looks follows through to the account,
// because two surfaces disagreeing about who the bot is would be seen by
// everybody except the person who could fix it.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startInstance, apiClient, registerUser } = require('../helpers/instance');
const { ensureVersionedApi } = require('./helpers/developer');

test('an application names its id and the account it posts as', async (t) => {
  const instance = await startInstance();
  t.after(() => instance.stop());
  const base = await ensureVersionedApi(instance);

  const session = await registerUser(instance, 'ada');
  const sessionApi = apiClient(base, session.token);
  const community = await apiClient(instance.baseUrl, session.token)
    .post('/api/servers', { name: 'Identity' });
  const communityId = community.data.serverId;
  const channelId = community.data.channelId;

  const created = await sessionApi.post('/communities/' + communityId + '/applications', {
    name: 'Night owl',
    description: 'It keeps the hours.',
    scopes: ['messages:write'],
  });
  assert.equal(created.status, 201);
  const app = created.data.application;

  await t.test('the answer carries the stable id and the bot account', async () => {
    const res = await sessionApi.get('/communities/' + communityId + '/applications/' + app.id);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.application.id, app.id, 'the id is the one it was created with');
    assert.equal(res.data.application.name, 'Night owl');

    const account = res.data.account;
    assert.ok(account, 'the account is in the answer');
    assert.equal(account.id, app.botUserId, 'the account is the application\u2019s own account');
    assert.equal(account.isBot, true, 'the account is a bot');
    assert.ok(String(account.username).startsWith('bot_'),
      'the username follows the bot naming: ' + account.username);
    assert.equal(account.displayName, 'Night owl', 'the account is called by the application\u2019s name');
  });

  await t.test('a rename follows through to the account the bot posts as', async () => {
    const res = await sessionApi.patch('/communities/' + communityId + '/applications/' + app.id, {
      name: 'Day owl',
    });
    assert.equal(res.status, 200);

    const after = await sessionApi.get('/communities/' + communityId + '/applications/' + app.id);
    assert.equal(after.data.application.name, 'Day owl');
    assert.equal(after.data.account.displayName, 'Day owl',
      'the account is called what the application is called now');
    // The handle is the one value a rename must never move: every message
    // the bot wrote was signed with it, and an id that changed would leave
    // those messages pointing at a member nobody has.
    assert.equal(after.data.account.id, app.botUserId, 'the handle is untouched');
  });

  await t.test('a picture follows through to the account, and a removed one clears', async () => {
    const bare = await sessionApi.post('/communities/' + communityId + '/applications', {
      name: 'Few feathers',
      scopes: [],
    });
    assert.equal(bare.status, 201);
    const bareApp = bare.data.application;

    const before = await sessionApi.get('/communities/' + communityId + '/applications/' + bareApp.id);
    assert.equal(before.data.account.displayName, 'Few feathers');

    const withIcon = await sessionApi.patch(
      '/communities/' + communityId + '/applications/' + bareApp.id,
      // A literal public address, so the guard's answer does not depend on
      // the sandbox being able to resolve names: the check it makes is about
      // where a picture may come from, not whether this machine can read it.
      { iconUrl: 'https://93.184.216.34/static/owl.png' }
    );
    assert.equal(withIcon.status, 200);

    const row = await instance.db.get('SELECT avatar_url FROM users WHERE id = ?', [bareApp.botUserId]);
    assert.ok(String(row.avatar_url || '').includes('/owl.png'), 'the account wears the application\u2019s picture');

    const cleared = await sessionApi.patch(
      '/communities/' + communityId + '/applications/' + bareApp.id,
      { iconUrl: null }
    );
    assert.equal(cleared.status, 200);
    const after = await instance.db.get('SELECT avatar_url FROM users WHERE id = ?', [bareApp.botUserId]);
    assert.equal(after.avatar_url, null, 'a removed picture is removed from the account as well');
  });

  await t.test('the health of a working application lists what it spent its calls on', async () => {
    // A working application: make a request, then read the health answer.
    await apiClient(base, created.data.token)
      .post('/communities/' + communityId + '/channels/' + channelId + '/messages', { content: 'from the owl' });

    const res = await sessionApi.get(
      '/communities/' + communityId + '/applications/' + app.id + '/health'
    );
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.state, 'active', 'a working application is active');
    assert.ok(res.data.usage, 'the usage totals are in the answer');

    const routes = res.data.routes || [];
    assert.ok(routes.some((r) => String(r.route).includes('/messages') && r.requests > 0),
      'the route it called is listed: ' + JSON.stringify(routes));
    const listed = routes.find((r) => String(r.route).includes('/messages'));
    if (listed) {
      assert.equal(listed.succeeded + listed.clientErrors + listed.serverErrors, listed.requests,
        'the counts of one line add up to its requests');
    }
  });
});
