// Scoped API keys, measured against a running instance.
//
// The assertions are about what the server does: a secret that is shown once
// and cannot be recovered, a request that is refused because the credential
// does not hold the scope the route needs, a revoked key that stops working,
// a rotation that ends the old secret, a limit that is enforced, and a key
// that cannot reach another account's resources.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startInstance, apiClient, registerUser } = require('../helpers/instance');
const { ensureVersionedApi } = require('./helpers/developer');

test('scoped API keys', async (t) => {
  const instance = await startInstance();
  t.after(() => instance.stop());
  const base = await ensureVersionedApi(instance);

  const session = await registerUser(instance, 'ada');
  const sessionApi = apiClient(base, session.token);
  const other = await registerUser(instance, 'grace');
  const otherApi = apiClient(base, other.token);

  async function createKey(body, client) {
    const res = await (client || sessionApi).post('/keys', body);
    assert.equal(res.status, 201, 'the key should be created: ' + JSON.stringify(res.data));
    return res.data;
  }

  await t.test('a key is created with a secret that is returned once and never again', async () => {
    const created = await createKey({ name: 'reporting', scopes: ['keys:read'] });
    assert.ok(created.key.id, 'the key has an id');
    assert.equal(created.key.status, 'active');
    assert.deepEqual(created.key.scopes, ['keys:read']);
    assert.ok(typeof created.secret === 'string' && created.secret.length > 20, 'the secret is returned');
    assert.ok(created.secret.startsWith('tc_'), 'the secret is a developer key, not a session token');

    // The list answers with the key and never with the secret.
    const list = await sessionApi.get('/keys');
    assert.equal(list.status, 200);
    const found = list.data.keys.find((k) => k.id === created.key.id);
    assert.ok(found, 'the key is in the list');
    assert.equal(found.secret, undefined, 'the list carries no secret');
    assert.equal(found.secretHash, undefined, 'the list carries no hash');

    // And neither does the key itself.
    const one = await sessionApi.get('/keys/' + created.key.id);
    assert.equal(one.status, 200);
    assert.equal(one.data.key.secret, undefined, 'the key carries no secret');
    assert.equal(JSON.stringify(one.data).includes(created.secret), false, 'the secret is nowhere in the answer');
  });

  await t.test('a request with the scope it needs succeeds, and one without it is refused', async () => {
    const created = await createKey({ name: 'reader', scopes: ['keys:read'] });
    const keyApi = apiClient(base, created.secret);

    const allowed = await keyApi.get('/keys');
    assert.equal(allowed.status, 200, 'the key may read the keys');

    const refused = await keyApi.post('/keys', { name: 'escalation', scopes: ['keys:write'] });
    assert.equal(refused.status, 403, 'a key without keys:write may not create a key');
    assert.equal(refused.data.error.code, 'INSUFFICIENT_SCOPE');
    assert.deepEqual(refused.data.error.details.missing, ['keys:write']);
  });

  await t.test('a session token still works on the versioned API', async () => {
    const res = await sessionApi.get('/whoami');
    assert.equal(res.status, 200);
    assert.equal(res.data.kind, 'session');
  });

  await t.test('a key may only create a key whose scopes it already holds', async () => {
    const created = await createKey({ name: 'writer', scopes: ['keys:read', 'keys:write'] });
    const keyApi = apiClient(base, created.secret);
    const allowed = await keyApi.post('/keys', { name: 'narrower', scopes: ['keys:read'] });
    assert.equal(allowed.status, 201, 'a subset is allowed');
    const refused = await keyApi.post('/keys', { name: 'wider', scopes: ['keys:read', 'admin:read'] });
    assert.equal(refused.status, 403, 'a wider set is refused');
    assert.equal(refused.data.error.code, 'INSUFFICIENT_SCOPE');
  });

  await t.test('an unknown scope is refused when the key is created', async () => {
    const res = await sessionApi.post('/keys', { name: 'wrong', scopes: ['messages:everything'] });
    assert.equal(res.status, 400);
    assert.equal(res.data.error.code, 'VALIDATION_ERROR');
  });

  await t.test('a revoked key is refused', async () => {
    const created = await createKey({ name: 'temporary', scopes: ['keys:read'] });
    const keyApi = apiClient(base, created.secret);
    assert.equal((await keyApi.get('/keys')).status, 200, 'the key works to begin with');

    const revoked = await sessionApi.post('/keys/' + created.key.id + '/revoke', { reason: 'rotated away' });
    assert.equal(revoked.status, 200);
    assert.equal(revoked.data.key.status, 'revoked');
    assert.equal(revoked.data.key.revokedReason, 'rotated away');

    const after = await keyApi.get('/keys');
    assert.equal(after.status, 401, 'the revoked key is refused');
    assert.equal(after.data.error.code, 'API_KEY_REVOKED');
  });

  await t.test('a rotated key keeps its identity, and the old secret stops working', async () => {
    const created = await createKey({ name: 'rotating', scopes: ['keys:read'] });
    const oldApi = apiClient(base, created.secret);

    const rotated = await sessionApi.post('/keys/' + created.key.id + '/rotate', { overlapSeconds: 0 });
    assert.equal(rotated.status, 200);
    assert.equal(rotated.data.key.id, created.key.id, 'the key keeps its id');
    assert.equal(rotated.data.key.name, created.key.name, 'the key keeps its name');
    assert.deepEqual(rotated.data.key.scopes, created.key.scopes, 'the key keeps its scopes');
    assert.ok(rotated.data.secret, 'the new secret is returned');
    assert.notEqual(rotated.data.secret, created.secret, 'the new secret is a new one');

    const withOld = await oldApi.get('/keys');
    assert.equal(withOld.status, 401, 'the previous secret stops working');
    assert.equal(withOld.data.error.code, 'API_KEY_INVALID');

    const withNew = await apiClient(base, rotated.data.secret).get('/keys');
    assert.equal(withNew.status, 200, 'the new secret works');
  });

  await t.test('the previous secret keeps working inside the overlap window', async () => {
    const created = await createKey({ name: 'overlapping', scopes: ['keys:read'] });
    const rotated = await sessionApi.post('/keys/' + created.key.id + '/rotate', { overlapSeconds: 120 });
    assert.equal(rotated.status, 200);
    assert.ok(rotated.data.previousSecretExpiresAt, 'the window is reported');

    const withOld = await apiClient(base, created.secret).get('/keys');
    assert.equal(withOld.status, 200, 'the previous secret still works inside the window');
    const withNew = await apiClient(base, rotated.data.secret).get('/keys');
    assert.equal(withNew.status, 200, 'the new secret works too');
  });

  await t.test('the rate limit of a key is enforced', async () => {
    const created = await createKey({ name: 'limited', scopes: ['keys:read'], rateLimitPerMinute: 2 });
    const keyApi = apiClient(base, created.secret);

    assert.equal((await keyApi.get('/keys')).status, 200);
    assert.equal((await keyApi.get('/keys')).status, 200);
    const refused = await keyApi.get('/keys');
    assert.equal(refused.status, 429, 'the third request is over the limit');
    assert.equal(refused.data.error.code, 'RATE_LIMITED');
    assert.ok(refused.headers.get('retry-after'), 'the answer says when to try again');
  });

  await t.test('one account cannot act on another account\'s key', async () => {
    const mine = await createKey({ name: 'mine', scopes: ['keys:read'] });
    const theirs = await createKey({ name: 'theirs', scopes: ['keys:read'] }, otherApi);

    const res = await sessionApi.get('/keys/' + theirs.key.id);
    assert.equal(res.status, 404, 'another account\'s key is not found');
    assert.equal(res.data.error.code, 'NOT_FOUND');

    const mineRes = await otherApi.get('/keys/' + mine.key.id);
    assert.equal(mineRes.status, 404, 'and the other way round');

    // A key of one account cannot revoke the key of another either.
    const revoked = await sessionApi.post('/keys/' + theirs.key.id + '/revoke', {});
    assert.equal(revoked.status, 404);
  });

  await t.test('a key that does not exist is refused', async () => {
    const res = await apiClient(base, 'tc_not-a-real-handle.not-a-real-secret').get('/keys');
    assert.equal(res.status, 401);
    assert.equal(res.data.error.code, 'API_KEY_INVALID');
  });

  await t.test('the usage of a key is counted', async () => {
    const created = await createKey({ name: 'counted', scopes: ['keys:read'] });
    const keyApi = apiClient(base, created.secret);
    await keyApi.get('/keys');
    await keyApi.get('/keys');

    const usage = await sessionApi.get('/keys/' + created.key.id + '/usage');
    assert.equal(usage.status, 200);
    assert.ok(usage.data.totals.requests >= 2, 'the requests are counted: ' + JSON.stringify(usage.data.totals));
    assert.ok(usage.data.byRoute.length > 0, 'the requests are counted by route');
  });

  await t.test('the health of a key says what it is, without inventing a check', async () => {
    const created = await createKey({ name: 'reported', scopes: ['keys:read'] });
    const health = await sessionApi.get('/keys/' + created.key.id + '/health');
    assert.equal(health.status, 200);
    assert.equal(health.data.state, 'configured', 'a key that has never been used is configured');
    assert.equal(health.data.key.rateLimitPerMinute, 120, 'the limit is reported');

    await apiClient(base, created.secret).get('/keys');
    const after = await sessionApi.get('/keys/' + created.key.id + '/health');
    assert.equal(after.data.state, 'active', 'a key that has been used and has not failed is active');
  });
});
