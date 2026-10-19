// The account lifecycle, measured against a running instance.
//
// These are the journeys a person actually takes: sign up, sign in, look at
// where you are signed in, end a session, change a password. The assertions
// are about what the server does, not about what the interface shows - a
// session that is revoked in the interface but still accepted by the API is
// not revoked.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startInstance, apiClient, registerUser } = require('../helpers/instance');

test('the account lifecycle', async (t) => {
  const instance = await startInstance();
  t.after(() => instance.stop());

  await t.test('registration creates an account and returns a usable session', async () => {
    const api = apiClient(instance.baseUrl);
    const res = await api.post('/api/auth/register', {
      username: 'ada',
      displayName: 'Ada Lovelace',
      password: 'analytical-engine',
      termsVersion: '1.0',
      privacyVersion: '1.0',
    });
    assert.equal(res.status, 200, 'registration should succeed: ' + JSON.stringify(res.data));
    assert.ok(res.data.token, 'registration returns a session token');
    assert.equal(res.data.user.username, 'ada');

    // The token is a real session: the API accepts it.
    const me = await apiClient(instance.baseUrl, res.data.token).get('/api/users/me');
    assert.equal(me.status, 200);
    assert.equal(me.data.username, 'ada');
  });

  await t.test('registration refuses a client that has not accepted the current documents', async () => {
    const api = apiClient(instance.baseUrl);
    const res = await api.post('/api/auth/register', {
      username: 'grace',
      password: 'analytical-engine',
    });
    assert.equal(res.status, 400);
    assert.equal(res.data.error.code, 'VALIDATION_ERROR');
  });

  await t.test('registration refuses a password shorter than the policy allows', async () => {
    const api = apiClient(instance.baseUrl);
    const res = await api.post('/api/auth/register', {
      username: 'short',
      password: 'abc',
      termsVersion: '1.0',
      privacyVersion: '1.0',
    });
    assert.equal(res.status, 400);
  });

  await t.test('a wrong password is refused and does not create a session', async () => {
    const api = apiClient(instance.baseUrl);
    const res = await api.post('/api/auth/login', { username: 'ada', password: 'wrong' });
    assert.equal(res.status, 401);
    assert.ok(!res.data.token, 'a failed sign-in returns no session');
  });

  await t.test('the right password returns a session', async () => {
    const api = apiClient(instance.baseUrl);
    const res = await api.post('/api/auth/login', { username: 'ada', password: 'analytical-engine' });
    assert.equal(res.status, 200);
    assert.ok(res.data.token);
  });

  await t.test('the sessions list names the devices a reader is signed in on', async () => {
    const api = await registerUser(instance, 'linus');
    const res = await api.get('/api/auth/sessions');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.data.sessions));
    assert.equal(res.data.sessions.length, 1);
    assert.ok(res.data.sessions[0].jti, 'a session is identified by its jti');
  });

  await t.test('revoking a session invalidates it on the server, not only in the interface', async () => {
    const api = await registerUser(instance, 'ken');
    const second = apiClient(instance.baseUrl);
    const other = await second.post('/api/auth/login', { username: 'ken', password: 'correct-horse-battery' });

    // Both tokens work to begin with.
    assert.equal((await api.get('/api/users/me')).status, 200);
    assert.equal((await apiClient(instance.baseUrl, other.data.token).get('/api/users/me')).status, 200);

    const sessions = await api.get('/api/auth/sessions');
    // The list marks the caller's own session. The one to revoke is the other.
    const target = sessions.data.sessions.find((s) => !s.current);
    assert.ok(target, 'a second session exists to revoke');

    const revoke = await api.post('/api/auth/sessions/revoke', { jti: target.jti });
    assert.equal(revoke.status, 200);

    // The revoked token is refused by the API. This is the assertion that
    // matters: a revocation that only removes a row in the interface's list
    // leaves a working credential behind.
    const after = await apiClient(instance.baseUrl, other.data.token).get('/api/users/me');
    assert.equal(after.status, 401, 'the revoked session must be refused by the API');
  });

  await t.test('revoking all other sessions leaves the caller with a working session', async () => {
    const api = await registerUser(instance, 'margaret');
    await apiClient(instance.baseUrl).post('/api/auth/login', {
      username: 'margaret', password: 'correct-horse-battery',
    });
    const res = await api.post('/api/auth/sessions/revoke-others', {});
    assert.equal(res.status, 200);
    assert.ok(res.data.token, 'the caller receives a fresh token');
    // The old token is dead: revoking other sessions bumps the account's
    // session version, and the token the caller was holding carries the old
    // one. The caller has to adopt the new token, and the interface does.
    assert.equal((await api.get('/api/users/me')).status, 401,
      'the token the call was made with is stale after the version bump');
    api.setToken(res.data.token);
    assert.equal((await api.get('/api/users/me')).status, 200,
      'the fresh token the call returns works');
  });

  await t.test('changing a password ends the sessions that were signed in with the old one', async () => {
    const api = await registerUser(instance, 'edsger');
    const change = await api.post('/api/auth/change-password', {
      currentPassword: 'correct-horse-battery',
      newPassword: 'correct-horse-battery-staple',
    });
    assert.equal(change.status, 200);

    // The token the change was made with is no longer accepted.
    const after = await api.get('/api/users/me');
    assert.equal(after.status, 401, 'a password change ends the sessions it was made with');

    // The new password works.
    const signIn = await apiClient(instance.baseUrl).post('/api/auth/login', {
      username: 'edsger', password: 'correct-horse-battery-staple',
    });
    assert.equal(signIn.status, 200);
  });

  await t.test('a password cannot be changed without the current one', async () => {
    const api = await registerUser(instance, 'alan');
    const res = await api.post('/api/auth/change-password', {
      currentPassword: 'not-the-password',
      newPassword: 'correct-horse-battery-staple',
    });
    assert.equal(res.status, 400);
    assert.equal(res.data.error.code, 'BAD_PASSWORD');
  });

  await t.test('signing out invalidates the session on the server', async () => {
    const api = await registerUser(instance, 'barbara');
    const out = await api.post('/api/auth/logout', {});
    assert.equal(out.status, 200);
    assert.equal((await api.get('/api/users/me')).status, 401);
  });

  await t.test('a session belonging to another instance is refused', async () => {
    // Two instances, separate databases, separate signing secrets. A token from
    // one must not be accepted by the other: the instances are not one account
    // system with two doors.
    const traveler = await registerUser(instance, 'traveller');

    const other = await startInstance();
    try {
      const same = await apiClient(other.baseUrl).post('/api/auth/register', {
        username: 'ada',
        password: 'analytical-engine',
        termsVersion: '1.0',
        privacyVersion: '1.0',
      });
      assert.equal(same.status, 200, 'the second instance has its own account');

      const cross = await apiClient(other.baseUrl, traveler.token).get('/api/users/me');
      assert.equal(cross.status, 401, 'a token from another instance must be refused');
    } finally {
      await other.stop();
    }
  });
});
