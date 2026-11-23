// The site's sign-in page, end to end on the server it is served from.
//
// The page itself is static. What makes it a door is the pair of facts this
// test holds together: the server mounts it at /login as the public site, and
// the session it obtains from /api/auth/login is the same bearer token the
// application uses. A page that renders and a token that works are two
// different promises, and a reader meets both.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startInstance, registerUser } = require('../helpers/instance');

test('the public sign-in page issues a session the app can use', async (t) => {
  const instance = await startInstance({ jobs: false });
  t.after(() => instance.stop());

  const page = await fetch(instance.baseUrl + '/login');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') || '', /text\/html/);
  const html = await page.text();
  assert.match(html, /data-login-form/, 'the public site does not serve the sign-in form');
  assert.match(html, /<meta name="trycord-api"/, 'the page does not say which API it signs in to');
  assert.equal(html.includes('<base href'), false, 'the site page is the app shell instead');

  // An account on this instance. The token registration returns is its first
  // session; signing in through the form's endpoint must mint another.
  await registerUser(instance, 'site_door');

  const login = await fetch(instance.baseUrl + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ username: 'site_door', password: 'correct-horse-battery' }),
  });
  assert.equal(login.status, 200);
  const answer = await login.json();
  assert.ok(answer.token, 'a successful sign-in returned no token');
  assert.equal(answer.user.username, 'site_door');

  const me = await fetch(instance.baseUrl + '/api/me', {
    headers: { authorization: 'Bearer ' + answer.token, accept: 'application/json' },
  });
  assert.equal(me.status, 200);
  const user = await me.json();
  assert.equal(user.username, 'site_door', 'the token does not belong to the signing-in account');

  // The token is a session, not a bare signature: the Security page can name
  // it and revoke it. That is what makes "every account has a token" a fact
  // about an account rather than a string that happens to verify.
  const sessions = await fetch(instance.baseUrl + '/api/auth/sessions', {
    headers: { authorization: 'Bearer ' + answer.token, accept: 'application/json' },
  });
  assert.equal(sessions.status, 200);
  const listed = await sessions.json();
  const rows = Array.isArray(listed) ? listed : (listed.sessions || []);
  assert.ok(rows.length >= 1, 'the new token is not listed as a session');
  assert.ok(rows.some((row) => row.current || row.isCurrent),
    'the token used for the request is not the current session');
});

test('the site door refuses a wrong password without minting a token', async (t) => {
  const instance = await startInstance({ jobs: false });
  t.after(() => instance.stop());

  await registerUser(instance, 'site_door_wrong');

  const login = await fetch(instance.baseUrl + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ username: 'site_door_wrong', password: 'not-the-password' }),
  });
  assert.equal(login.status, 401);
  const answer = await login.json();
  assert.equal(answer.token, undefined, 'a refused sign-in still returned a token');
  assert.ok(answer.error && answer.error.message,
    'a refused sign-in did not say what to do next');
});
