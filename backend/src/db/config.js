// Database configuration: how the connection is chosen, and where the choice
// lives.
//
// Precedence:
//
//   1. a configuration an administrator saved, explicitly
//   2. the environment the process was started with
//   3. nothing - there is no default database
//
// The saved value wins over the environment, the same way every other instance
// setting works: the environment seeds an installation and stops deciding once
// somebody saves a value. A database connection is not an exception to that.
//
// There is deliberately no default database. Without an explicit configuration
// the server refuses to start rather than silently creating a local file, which
// is how an instance ends up writing to a database nobody chose.
//
// ---- the bootstrap problem --------------------------------------------------
//
// The obvious place to store this is the settings table. It cannot be: the
// settings table is inside the database, and the database is what is being
// configured. So the saved configuration lives in its own file,
// `backend/instance/database.json`, which is read before any connection opens.
//
// That file is the one thing the process trusts without being able to ask the
// database about it, so it is written mode 0600 inside a 0700 directory, its
// writes go through a temp file and a rename so a crash cannot leave half an
// entry, and any password in it is encrypted under a key derived from
// JWT_SECRET. A copy of the file without the signing secret is not a credential.
//
// The file also remembers the configuration that was in force before it, which is
// what makes rollback possible: a saved value that cannot be reached at the next
// boot falls back to that previous one instead of leaving the instance with
// nothing.

'use strict';

const fs = require('fs');
const path = require('path');
const secrets = require('../services/secrets');

const ROOT = path.join(__dirname, '..', '..');
const DEFAULT_FILE = path.join(ROOT, 'instance', 'database.json');
const CONFIG_VERSION = 1;
const PASSWORD_PURPOSE = 'database-password';

// Where the bootstrap file lives. The environment can move it, which is how the
// test suite keeps a saved override in a developer's checkout from changing what
// a check is measuring.
function configFilePath() {
  const override = String(process.env.TRYCOD_DB_CONFIG_FILE || '').trim();
  return override || DEFAULT_FILE;
}

// Set by the test suite and by any script that pins its own connection. It means
// "use the environment I was handed; ignore anything an administrator saved" - a
// check that connects to a production database because somebody saved an override
// on that machine is measuring the wrong system.
function envOnly() {
  return String(process.env.TRYCOD_DB_ENV_ONLY || '') === '1';
}

const isLoopback = (host) => /^(localhost|127\.\d+\.\d+\.\d+|::1|\[::1\])$/i.test(String(host || ''));

function intOr(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) ? n : fallback;
}

// Whether two configurations would connect the same way. Passwords count.
function same(a, b) {
  if (a === b) return true;
  if (!a || !b || a.client !== b.client) return false;
  if (a.client === 'sqlite') return a.file === b.file;
  return a.host === b.host && a.port === b.port && a.name === b.name
    && a.user === b.user && a.password === b.password && !!a.ssl === !!b.ssl;
}

/**
 * Normalise and validate a candidate configuration.
 *
 * Takes the loose shape a form or a batch of environment variables produces and
 * returns either a usable configuration or the reasons it is not one. Nothing
 * here touches the network or the filesystem.
 */
function validate(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const client = String(input.client || '').trim().toLowerCase();

  if (client === 'sqlite') {
    const file = String(input.file || '').trim();
    if (!file) return { ok: false, problems: ['A database file is required.'] };
    return { ok: true, config: { client: 'sqlite', file } };
  }

  if (client === 'mysql') {
    const problems = [];
    const host = String(input.host || '').trim();
    const name = String(input.name || '').trim();
    const user = String(input.user || '').trim();
    const port = intOr(input.port, 3306);
    const connectionLimit = intOr(input.connectionLimit, 10);
    if (!host) problems.push('A host is required.');
    if (!name) problems.push('A database name is required.');
    if (!user) problems.push('A user is required.');
    if (port < 1 || port > 65535) problems.push('The port must be between 1 and 65535.');
    if (connectionLimit < 1 || connectionLimit > 200) problems.push('The connection limit must be between 1 and 200.');
    if (problems.length) return { ok: false, problems };
    return {
      ok: true,
      config: {
        client: 'mysql',
        host,
        port,
        name,
        user,
        password: input.password == null ? '' : String(input.password),
        ssl: input.ssl === true || input.ssl === 'true' || input.ssl === 'on',
        connectionLimit,
      },
    };
  }

  return { ok: false, problems: ['Choose a database type: SQLite or MySQL.'] };
}

/**
 * The configuration the environment describes, if it describes one.
 *
 * Returns `null` when the environment says nothing about the database,
 * `{ ok: false, error }` when it is present but wrong or unsafe (worth reporting
 * verbatim at boot), and `{ ok: true, config }` when it is usable.
 */
function fromEnvironment() {
  const client = String(process.env.DB_CLIENT || '').trim().toLowerCase();
  if (!client) return null;

  if (client !== 'sqlite' && client !== 'mysql') {
    return { ok: false, error: 'DB_CLIENT must be "sqlite" or "mysql", not "' + client + '".' };
  }

  const raw = { client };
  if (client === 'sqlite') {
    raw.file = process.env.DB_FILE;
  } else {
    raw.host = process.env.DB_HOST;
    raw.port = process.env.DB_PORT;
    raw.name = process.env.DB_NAME;
    raw.user = process.env.DB_USER;
    raw.password = process.env.DB_PASSWORD;
    raw.ssl = String(process.env.DB_SSL || '').toLowerCase() === 'true';
    raw.connectionLimit = process.env.DB_POOL;
  }

  const check = validate(raw);
  if (!check.ok) {
    return { ok: false, error: 'the database environment settings are incomplete: ' + check.problems.join(' ') };
  }

  // A MySQL host that is not loopback is treated as production unless the
  // deployment says otherwise. This is the guard that stops a stray local script
  // inheriting live credentials and writing to a real database; it was added
  // after exactly that happened.
  if (check.config.client === 'mysql' && !isLoopback(check.config.host)
      && String(process.env.ALLOW_REMOTE_DB || '').toLowerCase() !== 'true') {
    return {
      ok: false,
      error: 'refusing the remote database host ' + check.config.host
        + '. Set ALLOW_REMOTE_DB=true to allow it, or use a loopback host.',
    };
  }

  return { ok: true, config: check.config };
}

function environmentProblem() {
  const env = fromEnvironment();
  return env && env.ok === false ? env.error : null;
}

// ---- the bootstrap file -----------------------------------------------------

function toDisk(config) {
  if (config.client === 'sqlite') return { client: 'sqlite', file: config.file };
  return {
    client: 'mysql',
    host: config.host,
    port: config.port,
    name: config.name,
    user: config.user,
    ssl: !!config.ssl,
    connectionLimit: config.connectionLimit,
    password: config.password ? secrets.encrypt(PASSWORD_PURPOSE, config.password) : '',
  };
}

// A password that cannot be decrypted - because JWT_SECRET was rotated since it
// was written - is reported rather than silently turned into an empty password,
// which would surface later as an authentication failure with no cause.
function fromDisk(stored) {
  if (!stored || typeof stored !== 'object') return { ok: false, error: 'the entry is not an object' };
  const shaped = Object.assign({}, stored);
  if (shaped.client === 'mysql' && shaped.password) {
    try {
      shaped.password = secrets.decrypt(PASSWORD_PURPOSE, shaped.password);
    } catch {
      return { ok: false, error: 'the saved password cannot be decrypted. JWT_SECRET has changed since it was saved.' };
    }
  }
  const check = validate(shaped);
  if (!check.ok) return { ok: false, error: check.problems.join(' ') };
  return { ok: true, config: check.config };
}

function readRaw() {
  const file = configFilePath();
  if (!fs.existsSync(file)) return null;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { __problem: 'The saved database configuration could not be read: ' + e.message };
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return { __problem: 'The saved database configuration is not an object.' };
    return parsed;
  } catch {
    return { __problem: 'The saved database configuration is not valid JSON.' };
  }
}

/**
 * What the bootstrap file holds right now.
 *
 * `present` says whether a file exists at all. `config` is the saved override
 * (null when a file exists but cannot be used). `previous` is the configuration
 * it replaced. `problem` explains a rejected override.
 */
function loadSaved() {
  const raw = readRaw();
  if (!raw) return { present: false, config: null, previous: null, problem: null };
  if (raw.__problem) return { present: false, config: null, previous: null, problem: raw.__problem };

  const current = fromDisk(raw.config);
  const before = raw.previous ? fromDisk(raw.previous) : null;
  return {
    present: true,
    config: current.ok ? current.config : null,
    problem: current.ok ? null : current.error,
    previous: before && before.ok ? before.config : null,
    savedAt: raw.savedAt || null,
    savedBy: raw.savedBy || null,
  };
}

function writeRaw(payload) {
  const file = configFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
}

/**
 * Persist an administrator's choice.
 *
 * The configuration in force at the moment becomes the rollback target, unless
 * the new value is the same one again. Nothing is written until the caller has
 * already proved the new configuration can be reached.
 */
function saveSaved(config, meta) {
  const check = validate(config);
  if (!check.ok) throw new Error(check.problems.join(' '));
  const before = loadSaved();
  const raw = readRaw();
  const payload = {
    version: CONFIG_VERSION,
    savedAt: new Date().toISOString(),
    savedBy: (meta && meta.savedBy) || null,
    config: toDisk(check.config),
  };
  if (before.config && !same(before.config, check.config)) {
    payload.previous = toDisk(before.config);
  } else if (raw && raw.previous) {
    payload.previous = raw.previous;
  }
  writeRaw(payload);
  return check.config;
}

// Put the previous configuration back in charge.
function rollbackSaved() {
  const raw = readRaw();
  if (!raw || !raw.previous) return { ok: false, error: 'There is no earlier configuration to return to.' };
  const before = fromDisk(raw.previous);
  if (!before.ok) return { ok: false, error: before.error };
  const current = fromDisk(raw.config);
  writeRaw({
    version: CONFIG_VERSION,
    savedAt: new Date().toISOString(),
    savedBy: raw.savedBy || null,
    config: toDisk(before.config),
    // The configuration being replaced becomes the new rollback target, so the
    // action is reversible.
    previous: current.ok ? toDisk(current.config) : raw.previous,
  });
  return { ok: true, config: before.config };
}

// Forget the saved override entirely. The environment decides again.
function clearSaved() {
  const file = configFilePath();
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

/**
 * Every configuration to try, in order of precedence.
 *
 * The saved override, then the one it replaced, then the environment. Boot walks
 * this list and stops at the first configuration that connects, which is what
 * turns a saved value that does not work into a fallback rather than an outage.
 */
function candidates() {
  const out = [];
  if (!envOnly()) {
    const saved = loadSaved();
    if (saved.config) out.push({ source: 'instance', config: saved.config });
    if (saved.previous && !same(saved.previous, saved.config)) {
      out.push({ source: 'previous', config: saved.previous });
    }
  }
  const env = fromEnvironment();
  if (env && env.ok && out.every((c) => !same(c.config, env.config))) {
    out.push({ source: 'environment', config: env.config });
  }
  return out;
}

/**
 * Open a connection to a candidate configuration without changing anything.
 *
 * One connection and one query. No schema is applied, so testing a configuration
 * cannot migrate a database as a side effect.
 */
async function probe(config) {
  const check = validate(config);
  if (!check.ok) return { ok: false, error: check.problems.join(' ') };
  let conn = null;
  try {
    conn = check.config.client === 'sqlite'
      ? await require('./sqlite').connect(check.config.file)
      : await require('./mysql').connect(check.config);
    await conn.get('SELECT 1 AS ok');
    return { ok: true, dialect: conn.dialect };
  } catch (e) {
    return { ok: false, error: friendlyError(e) };
  } finally {
    if (conn) { try { await conn.close(); } catch { /* nothing left to close */ } }
  }
}

// Strip driver noise off a failure. An administrator needs to know which part
// refused, not which line of mysql2 raised it.
function friendlyError(e) {
  const message = String((e && e.message) || e || 'unknown error');
  if (/ECONNREFUSED/.test(message)) return 'Nothing is listening there. Check the host and port.';
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/.test(message)) return 'That host name could not be resolved.';
  if (/ETIMEDOUT|timeout/i.test(message)) return 'The connection timed out.';
  if (/Access denied/.test(message)) return 'The server refused those credentials.';
  if (/Unknown database/.test(message)) return 'The server has no database by that name.';
  if (/ENOENT|EACCES|SQLITE_CANTOPEN/.test(message)) return 'That file cannot be opened for writing.';
  return message.split('\n')[0];
}

// What the interface is allowed to see. A password is never a value, only
// whether one is set.
function mask(config) {
  if (!config) return null;
  if (config.client === 'sqlite') return { client: 'sqlite', file: config.file };
  return {
    client: 'mysql',
    host: config.host,
    port: config.port,
    name: config.name,
    user: config.user,
    ssl: !!config.ssl,
    connectionLimit: config.connectionLimit,
    passwordSet: !!config.password,
  };
}

module.exports = {
  validate,
  fromEnvironment,
  environmentProblem,
  candidates,
  loadSaved,
  saveSaved,
  rollbackSaved,
  clearSaved,
  probe,
  mask,
  same,
  configFilePath,
  envOnly,
};
