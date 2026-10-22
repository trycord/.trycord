// The deployment roles a split deployment runs on.
//
// A Trycord instance has always been one process doing all of it. The split
// deployment says the client and the API can live on different servers, and
// the two facts that make that true are: the API server stops serving
// documents (TRYCORD_DEPLOYMENT_ROLE=backend), and a second process serves
// the client and the site and points browsers at the API
// (npm run start:frontend).
//
// This file checks both ends, plus the things a mistake would quietly break:
// that the default boot is exactly what it always was, that the backend role
// serves nothing that looks like HTML, that the frontend server has an API
// address before it starts anything, and that every wrong configuration is
// caught at start-up with the words an operator needs.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { startInstance, freePort, ROOT } = require('./helpers/instance');

// A run that fails before an instance exists still has to leave the machine
// exactly as it found it: every variable set along the way is taken back,
// because a role or a leftover dotenv pointer in the process environment
// would quietly change what the next run in this file measured.
function cleanupEnv() {
  delete process.env.TRYCORD_DEPLOYMENT_ROLE;
  delete process.env.DOTENV_CONFIG_PATH;
}

// Starting the frontend server the way an operator does, in the run's own
// environment. Same shape as startInstance, minus everything a process with
// no database does not have: no signing secret, no upload directory, no
// database file. The roles the two helpers share are the same ones a real
// split deployment states separately on each server.
async function startFrontendInstance(extraEnv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trycord-frontend-'));
  const env = Object.assign({
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: '0',
    TRYCORD_API_URL: 'https://chat-api.example.com',
    TRYCORD_PUBLIC_URL: '',
    API_URL: '',
    API_BACKUP_URL: '',
    GLOBAL_TRYCORD_URL: '',
    TRYCORD_INSTANCE_ID: '',
    TRYCORD_APP_MOUNT: '',
    TRYCORD_CLIENT_DIR: '',
  }, extraEnv || {});
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, Object.entries(env).map(([k, v]) => k + '=' + String(v)).join('\n') + '\n');

  const saved = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    process.env[key] = String(value);
  }
  process.env.DOTENV_CONFIG_PATH = envFile;

  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(path.join(ROOT, 'src'))) delete require.cache[key];
  }

  const { boot } = require(path.join(ROOT, 'src', 'serve-frontend.js'));
  const port = await freePort();
  const instance = await boot({ port, host: '127.0.0.1' });

  return {
    ...instance,
    dir,
    baseUrl: 'http://127.0.0.1:' + instance.port,
    restoreEnv() {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      delete process.env.DOTENV_CONFIG_PATH;
    },
    async stop() {
      await instance.close();
      this.restoreEnv();
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}

// The role names are exact words. A half-typed one must not be accepted and
// quietly default to a deployment the operator did not ask for.
test('an unknown deployment role stops the boot with the accepted names', async () => {
  try {
    await startInstance({ jobs: false, env: { TRYCORD_DEPLOYMENT_ROLE: 'backends' } });
    assert.fail('the boot succeeded with an invalid role');
  } catch (err) {
    assert.match(String(err.message), /TRYCORD_DEPLOYMENT_ROLE/);
    assert.match(String(err.message), /unified, backend, frontend/);
  } finally {
    cleanupEnv();
  }
});

// The API process holds a database and a gateway; a static-only role on it
// is the wrong entry point for what the operator wants, and is told which
// one to use instead of being degraded into something that half works. The
// check fires in the first lines of boot(), before anything is opened, so
// the process stops without touching the database or binding a port.
test('the frontend role does not run on the process that holds the database', async () => {
  cleanupEnv();
  // A throwaway signing secret, so the boot reaches its first lines with
  // nothing to read from this machine and nothing to leave behind.
  const savedSecret = process.env.JWT_SECRET;
  try {
    process.env.JWT_SECRET = require('crypto').randomBytes(32).toString('hex');
    process.env.TRYCORD_DEPLOYMENT_ROLE = 'frontend';
    await assert.rejects(
      () => require('../src/server').boot(),
      /npm run start:frontend/
    );
  } finally {
    process.env.TRYCORD_DEPLOYMENT_ROLE = undefined;
    delete process.env.TRYCORD_DEPLOYMENT_ROLE;
    if (savedSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = savedSecret;
  }
});

test('the backend role serves the API and no documents', async (t) => {
  const instance = await startInstance({
    jobs: false,
    env: { TRYCORD_DEPLOYMENT_ROLE: 'backend' },
  });
  t.after(() => instance.stop());

  const res = await fetch(instance.baseUrl + '/health');
  assert.equal(res.status, 200);
  assert.ok((await res.json()).ok, 'the instance answers /health');

  const apiHealth = await fetch(instance.baseUrl + '/api/health');
  assert.equal(apiHealth.status, 200);
  const healthBody = await apiHealth.json();
  assert.equal(healthBody.db, 'ok', 'the database still answers on the API server');

  // The origin root is not a document any more — and it is not a dead JSON
  // wall either. A browser that lands here gets an honest maintenance page:
  // it says what this origin is, that the client lives elsewhere in a split
  // deployment, and where the server's real state can be read. The status is
  // 503 because "nothing behind this path" is a service answer, and a proxy
  // in front of this origin can then answer a reader with something true
  // instead of a bare 502 while it waits for the frontend to come up.
  const root = await fetch(instance.baseUrl + '/', {
    headers: { accept: 'text/html' },
  });
  assert.equal(root.status, 503);
  const rootText = String(await root.text());
  assert.ok(rootText.includes('<html'), 'the root answers a browser with a page');
  assert.match(rootText, /api/i, 'the page says what this origin is');
  assert.match(rootText, /start:frontend/, 'the page explains where the client lives');
  assert.equal(root.headers.get('retry-after'), '60',
    'the page tells a caller when it may be worth looking again');

  // Application routes answer the same way: same page, same status.
  const app = await fetch(instance.baseUrl + '/home', {
    headers: { accept: 'text/html' },
  });
  assert.equal(app.status, 503);
  assert.ok(String(await app.text()).includes('<html'), '/home answers a browser with the same page');

  // A caller that asked for JSON is not a browser. It keeps the envelope all
  // the API paths use - the page is for the reader who followed a link, not
  // for a client that parsed an address.
  const jsonCaller = await fetch(instance.baseUrl + '/');
  assert.equal(jsonCaller.status, 404);
  const callerBody = await jsonCaller.json();
  assert.equal(callerBody.error.code, 'NOT_FOUND');

  // Unmatched API paths keep their envelope, unchanged.
  const missing = await fetch(instance.baseUrl + '/api/no-such-route');
  assert.equal(missing.status, 404);
  const body = await missing.json();
  assert.equal(body.error.code, 'NOT_FOUND');
});

test('the unified default is unchanged: client and site are served when nothing is said', async (t) => {
  const instance = await startInstance({ jobs: false });
  t.after(() => instance.stop());

  const home = await fetch(instance.baseUrl + '/home');
  assert.equal(home.status, 200);
  assert.ok(String(await home.text()).includes('<base href'),
    'the app shell is served from the root');

  // With no API origin named anywhere, backend.json still points at the
  // serving origin: the ship-and-repoint rule never depended on the split
  // work, and the site's copy (which answers here) follows the same rule.
  const json = await fetch(instance.baseUrl + '/backend.json');
  assert.equal(json.status, 200);
  const body = JSON.parse(await json.text());
  assert.equal(body.backendUrl, instance.baseUrl);
});

test('a named API origin outranks the serving origin in the client\u2019s backend.json', async (t) => {
  // No public site, so the answer comes from the client's own file, which is
  // the one that carries the failover origins.
  const instance = await startInstance({
    jobs: false,
    publicSite: false,
    env: { TRYCORD_API_URL: 'https://chat-api.example.com', API_BACKUP_URL: 'https://chat-backup.example.com' },
  });
  t.after(() => instance.stop());

  const json = await fetch(instance.baseUrl + '/backend.json');
  assert.equal(json.status, 200);
  const body = JSON.parse(await json.text());
  assert.equal(body.backendUrl, 'https://chat-api.example.com',
    'the deployment\u2019s name for the API is the one the client is given');
  assert.deepEqual(body.fallbackUrls, ['https://chat-backup.example.com'],
    'the named failover origin is passed on');
});

test('the frontend server serves the client and the site and points them at the API', async (t) => {
  const instance = await startFrontendInstance();
  t.after(() => instance.stop());

  // The public site owns the origin root when it is present, and its pages
  // name the API origin they were given, not the one they came from.
  const root = await fetch(instance.baseUrl + '/');
  assert.equal(root.status, 200);
  assert.ok(String(await root.text()).includes('chat-api.example.com'),
    'the site page names the API origin in its meta tag');

  // The app shell is served from its application route, with the base
  // rewritten like any other deployment of the same tree.
  const app = await fetch(instance.baseUrl + '/home');
  assert.equal(app.status, 200);
  assert.ok(String(await app.text()).includes('<base href'), '/home is the app shell');

  const json = await fetch(instance.baseUrl + '/backend.json');
  assert.equal(json.status, 200);
  const body = JSON.parse(await json.text());
  assert.equal(body.backendUrl, 'https://chat-api.example.com',
    'the client served here is sent to the API server, not back to this one');

  const runtime = await fetch(instance.baseUrl + '/runtime-config.js');
  assert.equal(runtime.status, 200);
  assert.ok(String(await runtime.text()).includes('"API_URL":"https://chat-api.example.com"'),
    'runtime-config names the API');

  // The frontend health endpoint says what the server is, and says it
  // without a database check, because there is no database to check.
  const health = await fetch(instance.baseUrl + '/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).role, 'frontend');

  // An API request that lands here by mistake is answered with the envelope,
  // worded honestly about who owns the API.
  const api = await fetch(instance.baseUrl + '/api/users/me');
  assert.equal(api.status, 404);
  const apiBody = await api.json();
  assert.equal(apiBody.error.code, 'NOT_FOUND');
  assert.match(apiBody.error.message, /chat-api\.example\.com/,
    'the 404 says where the API actually lives');
});

// The frontend server without its one required fact cannot do its job: it
// would hand the client its own address as the API, and every request would
// come back to a server that has no API, presenting as an instance where
// sign-in never succeeds. So it refuses to start rather than half start.
test('a missing API address stops the frontend at start-up', async () => {
  cleanupEnv();
  try {
    process.env.TRYCORD_API_URL = '';
    process.env.API_URL = '';
    await assert.rejects(
      () => require('../src/serve-frontend').boot(),
      /TRYCORD_API_URL is not set/
    );
  } finally {
    delete process.env.TRYCORD_API_URL;
    delete process.env.API_URL;
  }
});

// A role naming a process that cannot carry it is a finding at start-up.
// The frontend entry point is the frontend by definition; the word
// "backend" on it means the operator started the wrong command, and the
// error says which one to run.
test('a frontend server told it is the backend stops with the right entry point', async () => {
  cleanupEnv();
  try {
    process.env.TRYCORD_DEPLOYMENT_ROLE = 'backend';
    await assert.rejects(
      () => require('../src/serve-frontend').boot(),
      /npm start/
    );
  } finally {
    delete process.env.TRYCORD_DEPLOYMENT_ROLE;
  }
});
