'use strict';

// The separate dashboard service, measured against a running instance.
//
// The service is a process of its own, so it is started as one: a child
// process with its own environment, started directly and stopped directly.
// The instance it talks to is a real one, with a real database and real
// accounts, because a dashboard that cannot reach a real API proves nothing.
//
// Two things are asserted here that a label could not carry. The service
// holds no state of its own: it has no database, no job worker and no
// gateway, and it says so honestly when the API is down. And it can do the
// job it exists for: serve the console's document, and authenticate an
// administrator against the real API.

const test = require('node:test');
const assert = require('node:assert/strict');
const { startInstance, apiClient, freePort } = require('../helpers/instance');
const { startDashboardService, loadedModules, SERVICE } = require('./helpers');
const { loadConfig } = require('../../src/dashboard/separate');

test('the separate dashboard service refuses an unusable configuration', async (t) => {
  const base = {
    DASHBOARD_MODE: 'separate',
    DASHBOARD_API_URL: 'https://api.example.com',
    DASHBOARD_ORIGIN: 'https://dashboard.example.com',
  };

  const refused = async (env, variable) => {
    let thrown = null;
    try {
      loadConfig(env);
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown, 'the service must refuse to start');
    assert.ok(thrown.message.includes(variable),
      'the message names the variable: ' + (thrown && thrown.message));
    return thrown;
  };

  await t.test('it needs the API it talks to', async () => {
    const env = Object.assign({}, base);
    delete env.DASHBOARD_API_URL;
    await refused(env, 'DASHBOARD_API_URL');
  });

  await t.test('it needs the origins allowed to load it', async () => {
    const env = Object.assign({}, base);
    delete env.DASHBOARD_ORIGIN;
    await refused(env, 'DASHBOARD_ORIGIN');
    await refused(Object.assign({}, base, { DASHBOARD_ORIGIN: '*' }), 'DASHBOARD_ORIGIN');
  });

  await t.test('it refuses to run in the bundled mode', async () => {
    await refused(Object.assign({}, base, { DASHBOARD_MODE: 'bundled' }), 'DASHBOARD_MODE');
  });

  await t.test('it refuses an address that is not an origin', async () => {
    await refused(Object.assign({}, base, { DASHBOARD_API_URL: 'https://api.example.com/v1' }),
      'DASHBOARD_API_URL');
    await refused(Object.assign({}, base, { DASHBOARD_ORIGIN: 'https://dashboard.example.com/admin' }),
      'DASHBOARD_ORIGIN');
  });

  await t.test('it refuses a port that is not one', async () => {
    await refused(Object.assign({}, base, { DASHBOARD_PORT: 'not-a-port' }), 'DASHBOARD_PORT');
  });
});

test('the separate dashboard service', async (t) => {
  const dashboardPort = await freePort();
  const dashboardOrigin = 'http://127.0.0.1:' + dashboardPort;

  const instance = await startInstance({
    env: {
      DASHBOARD_MODE: 'separate',
      // The main instance has to know where the console lives, and has to
      // allow its origin, or the browser refuses every answer the API gives.
      DASHBOARD_URL: dashboardOrigin,
      CLIENT_ORIGIN: dashboardOrigin,
      ADMIN_USERNAMES: 'root',
    },
  });
  t.after(() => instance.stop());

  const service = await startDashboardService({
    apiUrl: instance.baseUrl,
    port: dashboardPort,
  });
  t.after(() => service.stop());

  await t.test('it starts on its own port and says what it is', () => {
    const output = service.output();
    assert.match(output, /dashboard mode: separate/);
    assert.match(output, /separate dashboard listening on http:\/\/127\.0\.0\.1:/);
    assert.ok(output.includes('dashboard talks to the API at ' + instance.baseUrl),
      'the service says which API it talks to: ' + output);
    assert.match(output, /holds no database, runs no background jobs and owns no websocket gateway/);
  });

  await t.test('it serves its own health endpoint, and the API\'s health beside it', async () => {
    const res = await fetch(service.url + '/health');
    assert.equal(res.status, 200, 'the dashboard and the API are both answering');
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.service.ok, true);
    assert.equal(body.service.mode, 'separate');
    assert.equal(body.service.apiUrl, instance.baseUrl);
    assert.equal(body.api.ok, true, 'the API is reported as healthy');
    assert.equal(body.api.url, instance.baseUrl);
    assert.equal(body.api.status, 200);
    assert.equal(body.api.db, 'ok', 'the API reports its own database');
    assert.equal(body.api.instanceId, 'verification');
    assert.equal(body.api.error, null);
  });

  await t.test('its own liveness is reported separately from the API', async () => {
    const res = await fetch(service.url + '/live');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.mode, 'separate');
  });

  await t.test('its origin policy refuses an origin it does not serve', async () => {
    const res = await fetch(service.url + '/health', {
      headers: { Origin: 'http://not-allowed.example' },
    });
    assert.equal(res.status, 403, 'a foreign origin is refused');
    const body = await res.json();
    assert.equal(body.error.code, 'ORIGIN_NOT_ALLOWED');
    assert.equal(res.headers.get('access-control-allow-origin'), null,
      'a refused origin gets no CORS header either');
  });

  await t.test('the origins it does serve are answered, with the CORS header', async () => {
    const res = await fetch(service.url + '/health', {
      headers: { Origin: dashboardOrigin },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), dashboardOrigin);
  });

  await t.test('it holds no database and runs no job worker', () => {
    // It was started with a database configuration that could not work: a
    // MySQL server on a closed port, and a SQLite file in a directory that
    // does not exist. It is answering, so it never used either.
    const env = require('node:fs').readFileSync(service.envFile, 'utf8');
    assert.match(env, /DB_CLIENT=mysql/);
    assert.match(env, /DB_PORT=1/);
    assert.match(env, /DB_FILE=.*never-created\.db/);
    assert.match(env, /JOBS_WORKERS=0/);

    // And it never loaded the modules that would give it one.
    const loaded = loadedModules(SERVICE);
    const marker = '/backend/src/';
    const src = loaded
      .filter((file) => file.includes(marker))
      .map((file) => file.slice(file.indexOf(marker) + marker.length));
    const forbidden = src.filter((file) =>
      file.startsWith('db/') || file === 'db.js'
      || file === 'ws.js'
      || file.startsWith('services/jobs')
      || file.startsWith('services/enforcement')
      || file.startsWith('services/settings'));
    assert.deepEqual(forbidden, [],
      'the dashboard service must not load the database, the job worker or the gateway');
    assert.ok(src.includes('dashboard/separate.js'),
      'the service is what was loaded: ' + src.join(', '));
  });

  await t.test('it can authenticate an administrator against the real API', async () => {
    const registered = await apiClient(instance.baseUrl).post('/api/auth/register', {
      username: 'root',
      displayName: 'The operator',
      password: 'correct-horse-battery',
      termsVersion: '1.0',
      privacyVersion: '1.0',
    });
    assert.equal(registered.status, 200, 'the account is created: ' + JSON.stringify(registered.data));
    const token = registered.data.token;

    // The dashboard is asked about the session. It presents the token to the
    // API the way the browser does, and reports what the API said.
    const res = await fetch(service.url + '/session', {
      headers: { Authorization: 'Bearer ' + token },
    });
    assert.equal(res.status, 200, 'the API accepted the session: ' + await res.clone().text());
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.user.username, 'root');
    assert.equal(body.user.isAdmin, true, 'the account is a platform administrator');
    assert.equal(body.api.status, 200);
  });

  await t.test('a session the API refuses is reported as refused', async () => {
    const res = await fetch(service.url + '/session', {
      headers: { Authorization: 'Bearer not-a-real-token' },
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error.code, 'SESSION_REFUSED');
    assert.equal(body.api.status, 401);
  });

  await t.test('a session check without a token is refused before the API is asked', async () => {
    const res = await fetch(service.url + '/session');
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.error.code, 'AUTH_REQUIRED');
  });

  await t.test('it serves the console document, and the client is pointed at the API', async () => {
    const res = await fetch(service.url + '/admin');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    assert.ok(html.includes('<div id="app"'), 'the console is the client shell');
    assert.match(html, /<base href="\/">/, 'the base points at the service\'s own origin');
    assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/,
      'the console cannot be framed');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');

    // The client asks for backend.json before it asks for anything else, and
    // it is the file that tells the client which API to talk to.
    const config = await fetch(service.url + '/backend.json');
    assert.equal(config.status, 200);
    const json = await config.json();
    assert.equal(json.backendUrl, instance.baseUrl,
      'the console must talk to the main API, not to the dashboard');
    assert.equal(json.fallbackUrls, undefined, 'the dashboard names no other API to fall back to');
  });

  await t.test('it serves the client the console runs on', async () => {
    const asset = await fetch(service.url + '/packages/api.js');
    assert.equal(asset.status, 200, 'the client tree is served beside the console');
    assert.match(asset.headers.get('content-type'), /javascript/);
  });

  await t.test('it serves the sign-in screens an operator needs there', async () => {
    // The session is kept per origin, so an operator signing in on the
    // dashboard's own origin has to be able to sign in there.
    const res = await fetch(service.url + '/login');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.ok((await res.text()).includes('<div id="app"'));
  });

  await t.test('it does not serve the phone module, whose configuration names another network', async () => {
    const res = await fetch(service.url + '/mobile/');
    assert.equal(res.status, 404);
  });

  await t.test('the admin API behind the console answers the administrator', async () => {
    const registered = await apiClient(instance.baseUrl).post('/api/auth/login', {
      username: 'root',
      password: 'correct-horse-battery',
    });
    assert.equal(registered.status, 200);
    const res = await apiClient(instance.baseUrl, registered.data.token).get('/api/admin/overview');
    assert.equal(res.status, 200);
    assert.equal(typeof res.data.users, 'number');
    assert.equal(res.data.users, 1, 'the console shows the real counts, not a placeholder');
  });

  await t.test('the main API allows the dashboard\'s origin and refuses others', async () => {
    const allowed = await fetch(instance.baseUrl + '/api/instance', {
      headers: { Origin: dashboardOrigin },
    });
    assert.equal(allowed.headers.get('access-control-allow-origin'), dashboardOrigin);

    const refused = await fetch(instance.baseUrl + '/api/instance', {
      headers: { Origin: 'http://not-allowed.example' },
    });
    assert.equal(refused.headers.get('access-control-allow-origin'), null);
  });
});

test('a dashboard whose API goes away says so', async (t) => {
  const port = await freePort();
  const instance = await startInstance({ env: { DASHBOARD_MODE: 'separate' } });
  const service = await startDashboardService({ apiUrl: instance.baseUrl, port });
  t.after(() => service.stop());

  const before = await (await fetch(service.url + '/health')).json();
  assert.equal(before.api.ok, true, 'the API is healthy to begin with');

  await instance.stop();

  const res = await fetch(service.url + '/health');
  assert.equal(res.status, 503, 'a dashboard in front of a dead API is not healthy');
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.service.ok, true, 'the dashboard itself is still running');
  assert.equal(body.api.ok, false, 'and it says the API is not');
  assert.ok(body.api.error, 'with the reason: ' + JSON.stringify(body.api));

  // The console's own pages are still served: the service is alive, and it
  // does not pretend the API answered.
  const document = await fetch(service.url + '/admin');
  assert.equal(document.status, 200);
});
