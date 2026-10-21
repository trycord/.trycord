// Starting an instance to measure.
//
// A verification run needs an instance that belongs to the run: its own
// database file, its own port, its own uploads directory, its own signing
// secret. It must not touch the instance the machine is serving, and it must
// not leave a process behind.
//
// The environment is written to a file and pointed at with DOTENV_CONFIG_PATH
// rather than assigned to process.env, so nothing the host's own `.env` says
// can leak into a run: a leaked DB_HOST would point the run at a live
// database, and a leaked MAIL_MODE would make the run send mail.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');

// The environment every run starts from. Deliberately explicit: a value that is
// not listed here is not in force, rather than being inherited from whatever
// the machine happens to have.
function baseEnv(dir) {
  return {
    NODE_ENV: 'test',
    // A secret of this instance's own. Two instances must not be able to
    // accept each other's tokens, and they cannot if they share a signing
    // key - so each run gets a fresh one, exactly as a real deployment does.
    // The architecture is explicit that the secret is never shared between
    // instances, and a run that shared one would not be testing that.
    JWT_SECRET: crypto.randomBytes(32).toString('hex'),
    SERVER_HOST_TYPE: 'express',
    HOST: '127.0.0.1',
    PORT: '0',
    // The database is a file in the run's own directory. SQLite keeps a run
    // cheap and self-contained; the MySQL path is exercised by the operator's
    // own deployment, not by every run on every commit.
    DB_CLIENT: 'sqlite',
    DB_FILE: path.join(dir, 'instance.db'),
    // The saved-configuration file is redirected too, so an operator's saved
    // database override cannot take over a run.
    TRYCORD_DB_CONFIG_FILE: path.join(dir, 'database.json'),
    TRYCORD_DB_ENV_ONLY: '1',
    // No mail. A run that needs to prove a mail message was sent uses the
    // mail service's own log mode, not an SMTP server.
    MAIL_MODE: 'disabled',
    MAIL_FROM: 'Trycord Verification <verify@localhost>',
    UPLOAD_DIR: path.join(dir, 'uploads'),
    STORAGE_DRIVER: 'local',
    // The instance is reached on its own origin, and it says so.
    TRYCORD_PUBLIC_URL: '',
    CLIENT_ORIGIN: '',
    API_URL: '',
    PUBLIC_URL: '',
    GLOBAL_TRYCORD_URL: '',
    TRYCORD_APP_MOUNT: '',
    TRYCORD_INSTANCE_ID: 'verification',
    TRYCORD_NAME: 'Trycord Verification',
    ADMIN_USERNAMES: '',
    // The test-only routes are mounted, and only here.
    ALLOW_TEST_HOOKS: 'true',
    // Nothing that could reach outside: no federation, no push, no link
    // previews that fetch a third party.
    COMMUNITY_DISCOVERY_ENABLED: 'off',
    REGISTRATION_ENABLED: 'on',
    EMAIL_VERIFICATION_REQUIRED: 'off',
    VOICE_VIDEO_ENABLED: 'off',
    PUSH_NOTIFICATIONS_ENABLED: 'off',
    BCRYPT_COST: '10',
    JOBS_WORKERS: '1',
    // The run serves the real client tree, because a verification of the
    // client is a verification of the shipped client.
    TRYCORD_CLIENT_DIR: path.join(ROOT, '..', 'frontend'),
  };
}

/** A port nothing is listening on right now. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Start an instance.
 *
 * @param {object}  [options]
 * @param {object}  [options.env]       extra environment, overriding the base
 * @param {boolean} [options.jobs]      run the background job system (default false)
 * @param {boolean} [options.client]    serve the web client (default true)
 * @param {boolean} [options.publicSite] serve the public website (default true)
 * @param {string}  [options.dir]        where to put this run's files
 * @returns {Promise<object>} the running instance
 */
async function startInstance(options = {}) {
  const dir = options.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'trycord-run-'));
  // A run that is interrupted - a failure before the cleanup is registered, or
  // a killed process - leaves its directory behind, and a hundred of those
  // fill the disk the tests are run on. So they are taken away when the
  // process goes, whatever happened to it.
  rememberDirectory(dir);
  fs.mkdirSync(dir, { recursive: true });

  const env = Object.assign(baseEnv(dir), options.env || {});
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(envFile, Object.entries(env)
    .map(([k, v]) => k + '=' + String(v))
    .join('\n') + '\n');

  // The process environment is set here, because the modules that read it are
  // module-level singletons: the settings store, the feature flags and the
  // database configuration all read process.env once, when they are first
  // required. The file above is what the server loads; these are what the
  // modules this process already holds see.
  const saved = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    process.env[key] = String(value);
  }
  process.env.DOTENV_CONFIG_PATH = envFile;

  // A fresh module registry for this run: the singletons above must see this
  // run's environment, not the previous one's.
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(path.join(ROOT, 'src'))) delete require.cache[key];
  }

  const { boot } = require(path.join(ROOT, 'src', 'server.js'));
  const port = options.port || await freePort();
  const instance = await boot({
    port,
    host: '127.0.0.1',
    jobs: options.jobs === true,
    client: options.client !== false,
    publicSite: options.publicSite !== false,
  });

  // The database module this instance is actually using.
  //
  // The module cache was cleared before the server was required, so a test
  // that requires it again would get a second, unconnected copy. Handing out
  // the one the server holds is the only way for a test to look at the same
  // rows the instance is serving.
  const db = require(path.join(ROOT, 'src', 'db'));

  const baseUrl = 'http://127.0.0.1:' + instance.port;

  return {
    ...instance,
    db,
    dir,
    baseUrl,
    envFile,
    /** Put the process environment back the way it was. */
    restoreEnv() {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      delete process.env.DOTENV_CONFIG_PATH;
    },
    /** Stop the instance and remove its files. */
    async stop() {
      await instance.close();
      this.restoreEnv();
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
      usedDirectories.delete(dir);
    },
  };
}
// The directories the instances of this process have used.
//
// They are removed when the instance stops, and again when the process goes:
// a test that fails before its cleanup is registered, or a run that is
// interrupted, would otherwise leave a database behind every time.
const usedDirectories = new Set();
let cleanupOnExit = false;

function rememberDirectory(dir) {
  usedDirectories.add(dir);
  if (cleanupOnExit) return;
  cleanupOnExit = true;
  const forget = () => {
    for (const one of usedDirectories) {
      try { fs.rmSync(one, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    usedDirectories.clear();
  };
  process.on('exit', forget);
}

/**
 * A small HTTP client bound to one instance.
 *
 * It speaks the API the way the client does: a bearer token, the JSON error
 * envelope, and no hidden retries. A test that passes because a request was
 * quietly repeated has proved nothing.
 */
function apiClient(baseUrl, token) {
  async function request(method, path, body, extraHeaders) {
    const headers = Object.assign({ Accept: 'application/json' }, extraHeaders || {});
    if (token) headers.Authorization = 'Bearer ' + token;
    let payload;
    if (body !== undefined && body !== null) {
      if (body instanceof FormData) {
        payload = body;
      } else {
        headers['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
      }
    }
    const res = await fetch(baseUrl + path, { method, headers, body: payload });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, ok: res.ok, data, headers: res.headers };
  }
  return {
    baseUrl,
    get token() { return token; },
    setToken(next) { token = next; },
    get: (p, h) => request('GET', p, undefined, h),
    post: (p, b, h) => request('POST', p, b, h),
    put: (p, b, h) => request('PUT', p, b, h),
    patch: (p, b, h) => request('PATCH', p, b, h),
    // `delete` is a reserved word, so it cannot be a shorthand property. It is
    // still a legal property name, and it is the name a caller reaches for.
    delete: (p, b, h) => request('DELETE', p, b, h),
    del: (p, b, h) => request('DELETE', p, b, h),
  };
}

/** Register an account and return the client that is signed in as it. */
async function registerUser(instance, username, extra) {
  const api = apiClient(instance.baseUrl);
  const body = Object.assign({
    username,
    password: 'correct-horse-battery',
    displayName: username,
    termsVersion: '1.0',
    privacyVersion: '1.0',
  }, extra || {});
  const res = await api.post('/api/auth/register', body);
  if (!res.ok) {
    const message = res.data && res.data.error ? res.data.error.message : JSON.stringify(res.data);
    throw new Error('register ' + username + ' failed: ' + res.status + ' ' + message);
  }
  const signed = apiClient(instance.baseUrl, res.data.token);
  signed.user = res.data.user;
  return signed;
}

module.exports = { startInstance, apiClient, registerUser, freePort, ROOT };
