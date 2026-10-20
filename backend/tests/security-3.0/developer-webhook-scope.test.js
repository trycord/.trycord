// The health of a webhook, and whose business it is.
//
// A webhook belongs to a community. Its delivery log says what was
// delivered to the community's endpoint, what the endpoint answered, and
// what went wrong - which is the community's business and nobody else's.
//
// The delivery log route was scoped to the community the caller named; the
// health route was not, so a manager of one community could read the health
// of another community's webhook by naming its id.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startInstance, apiClient, registerUser } = require('../helpers/instance');
const { ensureVersionedApi } = require('../developer/helpers/developer');

test('a webhook\'s health belongs to its own community', async (t) => {
  const instance = await startInstance();
  t.after(() => instance.stop());
  const base = await ensureVersionedApi(instance);

  // Required after the instance has started: the server clears the module
  // registry before it boots, so a module loaded before the boot would hold
  // a database connection that was never opened.
  const db = require('../../src/db');

  const owner = await registerUser(instance, 'owner');
  const other = await registerUser(instance, 'other');
  const ownerApi = apiClient(instance.baseUrl, owner.token);
  const otherApi = apiClient(instance.baseUrl, other.token);

  const first = await ownerApi.post('/api/servers', { name: 'First community' });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  const second = await otherApi.post('/api/servers', { name: 'Second community' });
  assert.equal(second.status, 200, JSON.stringify(second.data));

  // The row is written here rather than through the API: the API refuses a
  // URL it cannot vouch for, and what is under test is the scope of the
  // report, not the URL check.
  const webhookId = 'hook_' + Date.now().toString(36);
  await db.run(
    'INSERT INTO webhooks (id, server_id, channel_id, name, url, secret_hash, created_by, active, created_at)'
    + ' VALUES (?, ?, NULL, ?, ?, ?, ?, 1, ?)',
    [webhookId, first.data.serverId, 'events', 'https://example.invalid/hook',
      'test-secret-hash', owner.user.id, new Date().toISOString()]
  );
  await db.run(
    'INSERT INTO webhook_deliveries (id, webhook_id, event_type, status, status_code, error, created_at)'
    + ' VALUES (?, ?, ?, ?, ?, ?, ?)',
    ['delivery_1', webhookId, 'message.created', 'failed', 500, 'the endpoint refused', new Date().toISOString()]
  );

  await t.test('the community that owns the webhook reads its health', async () => {
    const res = await apiClient(base, owner.token)
      .get('/communities/' + first.data.serverId + '/webhooks/' + webhookId + '/health');
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.webhookId, webhookId);
    assert.equal(res.data.deliveries.failed, 1);
    assert.equal(res.data.lastFailure.error, 'the endpoint refused');
  });

  await t.test('a manager of another community does not', async () => {
    const res = await apiClient(base, other.token)
      .get('/communities/' + second.data.serverId + '/webhooks/' + webhookId + '/health');
    assert.equal(res.status, 404, JSON.stringify(res.data));
    assert.equal(res.data.error.code, 'NOT_FOUND');
    assert.ok(!JSON.stringify(res.data).includes('the endpoint refused'),
      "another community's delivery log must not leak");
  });

  await t.test('the delivery log is scoped the same way', async () => {
    const res = await apiClient(base, other.token)
      .get('/communities/' + second.data.serverId + '/webhooks/' + webhookId + '/deliveries');
    assert.equal(res.status, 404, JSON.stringify(res.data));
  });
});
