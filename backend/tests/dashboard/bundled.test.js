'use strict';

// The bundled deployment, measured against a running instance.
//
// Bundled means what it has always meant: one process carries the whole
// application. The client serves the admin console's pages and the same
// process serves the admin API behind them, with the same session and the
// same admin guard. The assertions are about the server, not about the
// interface: a console that renders is not evidence that the API behind it
// refuses an unauthenticated caller.

const test = require('node:test');
const assert = require('node:assert/strict');
const { startInstance, apiClient } = require('../helpers/instance');
const { mountDashboard } = require('../../src/dashboard/mount');

test('the bundled dashboard deployment', async (t) => {
  const instance = await startInstance({ env: { DASHBOARD_MODE: 'bundled' } });
  t.after(() => instance.stop());

  await t.test('the mode in force is reported as bundled', () => {
    const info = mountDashboard(instance.app, {});
    assert.equal(info.mode, 'bundled');
    assert.equal(info.servedBy, 'main-process');
    assert.equal(info.dashboardPath, '/admin');
    assert.equal(info.adminApiPath, '/api/admin');
  });

  await t.test('the admin API answers under /api/admin and refuses a caller with no session', async () => {
    const res = await fetch(instance.baseUrl + '/api/admin/overview');
    assert.equal(res.status, 401, 'the admin API must not answer an unauthenticated caller');
    const body = await res.json();
    assert.equal(body.error.code, 'AUTH_REQUIRED');
  });

  await t.test('the admin API refuses a session that is not an administrator', async () => {
    const registered = await apiClient(instance.baseUrl).post('/api/auth/register', {
      username: 'reader',
      displayName: 'A reader',
      password: 'correct-horse-battery',
      termsVersion: '1.0',
      privacyVersion: '1.0',
    });
    assert.equal(registered.status, 200);
    const res = await apiClient(instance.baseUrl, registered.data.token).get('/api/admin/overview');
    assert.equal(res.status, 403, 'a valid session that is not an administrator is refused');
    assert.equal(res.data.error.code, 'PERMISSION_DENIED');
  });

  await t.test('the client document for the admin route is served by this process', async () => {
    const res = await fetch(instance.baseUrl + '/admin');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    assert.ok(html.includes('<div id="app"'), 'the console is the client shell');
    assert.match(html, /<base href="\/">/, 'the base points at the mount this instance serves from');
  });

  await t.test('a deep link into the console is served too', async () => {
    const res = await fetch(instance.baseUrl + '/admin/users');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
  });
});
