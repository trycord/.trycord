// What the auth refusals say.
//
// The messages that reach a person from the sign-in, registration and
// recovery endpoints are part of the product, not an afterthought: a
// sentence that names the next step is the difference between a refusal and
// a wall. These tests hold the sentences against a running instance, so a
// copy change that regressed into boilerplate ('invalid credentials',
// 'username taken') is noticed by the battery rather than by whoever was
// stuck staring at it.
//
// One deliberate property is asserted less loosely than the rest: the
// unknown-username refusal says exactly what the wrong-password refusal
// says. If those ever differ, the endpoint has begun to confirm which
// usernames exist, and the answer must not whisper that.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startInstance, apiClient, registerUser } = require('../helpers/instance');

test('the auth refusals speak in sentences with a next step', async (t) => {
  const instance = await startInstance();
  t.after(() => instance.stop());
  const api = apiClient(instance.baseUrl);

  await registerUser(instance, 'copycase', { password: 'copycase-passphrase' });

  await t.test('the unknown-username refusal is the wrong-password refusal, word for word', async () => {
    const unknown = await api.post('/api/auth/login', { username: 'nobody-here', password: 'not-the-password' });
    const wrongPw = await api.post('/api/auth/login', { username: 'copycase', password: 'not-the-password' });
    assert.equal(unknown.status, 401);
    assert.equal(wrongPw.status, 401);
    assert.equal(unknown.data.error.code, 'AUTH_REQUIRED');
    assert.equal(unknown.data.error.message, wrongPw.data.error.message,
      'the login refused a name it could not find differently than one it found');
    assert.match(unknown.data.error.message, /could not sign you in/i);
  });

  await t.test('the forgot-password answer is generic and says so, whoever it is about', async () => {
    const one = await api.post('/api/auth/forgot-password', { email: 'nobody@nowhere.example' });
    assert.equal(one.status, 200);
    assert.match(one.data.message, /If an account exists/i);
  });

  await t.test('a username that breaks the shape is refused with its shape', async () => {
    const res = await api.post('/api/auth/register', {
      username: 'bad name!', password: 'a-good-passphrase', termsVersion: '1.0', privacyVersion: '1.0',
    });
    assert.equal(res.status, 400);
    assert.match(res.data.error.message, /2 to 32 characters/i);
  });

  await t.test('a short password says how many characters', async () => {
    const res = await api.post('/api/auth/register', {
      username: 'shortpw', password: 'short', termsVersion: '1.0', privacyVersion: '1.0',
    });
    assert.equal(res.status, 400);
    assert.match(res.data.error.message, /at least 8 characters/i);
  });

  await t.test('a password over the storage ceiling is refused in words, not only in bytes', async () => {
    const res = await api.post('/api/auth/register', {
      username: 'longpw', password: 'x'.repeat(80), termsVersion: '1.0', privacyVersion: '1.0',
    });
    assert.equal(res.status, 400);
    assert.match(res.data.error.message, /72 bytes/i);
  });

  await t.test('a taken username offers the way back that exists', async () => {
    const res = await api.post('/api/auth/register', {
      username: 'copycase', password: 'another-passphrase', termsVersion: '1.0', privacyVersion: '1.0',
    });
    assert.equal(res.status, 409);
    assert.equal(res.data.error.code, 'CONFLICT');
    assert.match(res.data.error.message, /already taken/i);
    assert.match(res.data.error.message, /sign in/i);
  });

  await t.test('a stale second-factor challenge is its own code, not a wrong-code accusation', async () => {
    const res = await api.post('/api/auth/2fa/verify', { challengeToken: 'not-a-token', code: '123456' });
    assert.equal(res.status, 401);
    assert.equal(res.data.error.code, 'CHALLENGE_EXPIRED');
    assert.match(res.data.error.message, /again/i);
  });

  await t.test('a password change refused on the current password says what happened and that the account is untouched', async () => {
    const auth = apiClient(instance.baseUrl, await tokenFor());
    const res = await auth.post('/api/auth/change-password', {
      currentPassword: 'wrong-passphrase', newPassword: 'a-new-passphrase',
    });
    assert.equal(res.status, 400);
    assert.equal(res.data.error.code, 'BAD_PASSWORD');
    assert.match(res.data.error.message, /not right/i);
    assert.match(res.data.error.message, /Nothing has been changed/);
  });

  // The session token for the password-change check, after the account above
  // signed in clean.
  async function tokenFor() {
    const res = await api.post('/api/auth/login', { username: 'copycase', password: 'copycase-passphrase' });
    assert.equal(res.status, 200, 'the fixture account signs in');
    return res.data.token;
  }
});
