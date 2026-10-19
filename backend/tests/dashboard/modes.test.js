'use strict';

// The two modes, side by side.
//
// The point of this file is that "separate" is a deployment and not a label.
// In bundled mode the main process serves the console's document. In separate
// mode the main process does not serve it and the dashboard service does -
// the same document, from the same client tree, over there.
//
// The mount is installed here exactly as the server installs it, so the
// difference measured is the difference the deployment makes.

const test = require('node:test');
const assert = require('node:assert/strict');
const { startInstance, freePort } = require('../helpers/instance');
const { startDashboardService } = require('./helpers');
const { mountDashboard } = require('../../src/dashboard/mount');

test('bundled: the main process serves the console', async (t) => {
  const instance = await startInstance({ env: { DASHBOARD_MODE: 'bundled' } });
  t.after(() => instance.stop());

  const info = mountDashboard(instance.app, {});
  assert.equal(info.mode, 'bundled');
  assert.equal(info.servedBy, 'main-process');

  const res = await fetch(instance.baseUrl + '/admin');
  assert.equal(res.status, 200, 'the main process serves the console document');
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.ok(html.includes('<div id="app"'));

  // And the API behind it is on the same origin.
  const api = await fetch(instance.baseUrl + '/api/admin/overview');
  assert.equal(api.status, 401);
});

test('separate: the dashboard service serves the console, and the main process does not', async (t) => {
  const port = await freePort();
  const dashboardOrigin = 'http://127.0.0.1:' + port;

  const instance = await startInstance({
    env: {
      DASHBOARD_MODE: 'separate',
      DASHBOARD_URL: dashboardOrigin,
      CLIENT_ORIGIN: dashboardOrigin,
    },
  });
  t.after(() => instance.stop());

  const service = await startDashboardService({
    apiUrl: instance.baseUrl,
    port,
  });
  t.after(() => service.stop());

  // The mount is installed the way the server installs it: the mode and the
  // dashboard's address come from the environment.
  const info = mountDashboard(instance.app, { appMount: '' });
  assert.equal(info.mode, 'separate');
  assert.equal(info.servedBy, 'separate-service');
  assert.equal(info.dashboardUrl, dashboardOrigin + '/admin');

  await t.test('the main process does not serve the console document', async () => {
    const res = await fetch(instance.baseUrl + '/admin', { redirect: 'manual' });
    assert.notEqual(res.status, 200, 'the main process must not serve the console document');
    assert.equal(res.status, 302, 'it points at the dashboard service instead');
    assert.equal(res.headers.get('location'), dashboardOrigin + '/admin');
    const body = await res.text();
    assert.ok(!body.includes('<div id="app"'), 'and the answer is not the console');
  });

  await t.test('the main process still serves the application itself', async () => {
    const res = await fetch(instance.baseUrl + '/home');
    assert.equal(res.status, 200, 'the application is not what moved');
    assert.match(res.headers.get('content-type'), /text\/html/);
  });

  await t.test('the main process still serves the admin API', async () => {
    const res = await fetch(instance.baseUrl + '/api/admin/overview');
    assert.equal(res.status, 401, 'the API stayed with the main instance');
  });

  await t.test('the dashboard service serves the console document', async () => {
    const res = await fetch(service.url + '/admin');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    assert.ok(html.includes('<div id="app"'), 'the console is the client shell');
  });

  await t.test('the two processes answer the same console with different documents', async () => {
    const fromMain = await fetch(instance.baseUrl + '/admin', { redirect: 'manual' });
    const fromService = await fetch(service.url + '/admin');
    assert.notEqual(fromMain.status, fromService.status,
      'the main process and the dashboard service are not the same answer');
  });
});
