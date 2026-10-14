// Ids, timestamps, and the signing secret.
//
// These were in util.js, which put every module that stamps a row one require
// away from the module that signs a token. That produced a cycle: services/
// settings.js needs a timestamp, util.js needs the settings store to read a
// session lifetime, and one of the two was going to get a half-built exports
// object depending on which file Node happened to reach first. It happened to
// work because server.js loads settings before util, which is not a thing to
// leave to load order.
//
// secret() moved here for the same reason from the other side. It reads the
// signing secret, needs no database, and takes no part in any cycle, so every
// module that needs it can have it.
//
// Why the secret is not a setting
// -------------------------------
// Every other deployment knob now lives in the configuration store. This one
// cannot: it is the key that the store's own encrypted values are derived from.
// A database password encrypted under it, a mail provider's API key, a TOTP
// secret - all of them are unreadable without it, so asking the store for it
// would be asking the store to decrypt itself.
//
// It is also the one value an operator should not have to invent. So:
//
//   JWT_SECRET, when the deployment sets one         - used, as before
//   otherwise, instance/secret.key next to the DB    - generated on first use
//
// The generated file is 0600 inside the same 0700 directory as the database
// bootstrap file. Deployments that pack the instance directory into a container
// image, or point the process at a volume that is not durable, should set
// JWT_SECRET instead: a secret that disappears with the process takes every
// value encrypted under it with it.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const now = () => new Date().toISOString();

const uuid = () => crypto.randomUUID();

// Where the generated secret lives. The environment can move it, which is how a
// test suite keeps a run from writing into a checkout.
function secretFilePath() {
  const override = String(process.env.TRYCOD_SECRET_FILE || '').trim();
  return override || path.join(__dirname, '..', 'instance', 'secret.key');
}

let cached = null;

function readSecretFile() {
  try {
    const text = fs.readFileSync(secretFilePath(), 'utf8').trim();
    return text || null;
  } catch {
    return null;
  }
}

/**
 * The signing secret.
 *
 * JWT_SECRET when the environment provides one, otherwise the contents of
 * instance/secret.key, creating it if it is not there yet. The file is created
 * exclusively so two processes starting together cannot disagree about it: the
 * loser of the race reads what the winner wrote.
 */
function secret() {
  const fromEnv = process.env.JWT_SECRET;
  if (fromEnv) return fromEnv;
  if (cached) return cached;

  const existing = readSecretFile();
  if (existing) {
    cached = existing;
    return cached;
  }

  const generated = crypto.randomBytes(48).toString('base64url');
  const file = secretFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(file, generated + '\n', { mode: 0o600, flag: 'wx' });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    // Somebody else got there first. Their secret is the installation's.
    const theirs = readSecretFile();
    if (!theirs) throw e;
    cached = theirs;
    return cached;
  }
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  cached = generated;
  return cached;
}

// Whether the running process took its secret from the environment or the file.
// Boot says which, so an operator is never guessing why a secret survived a
// restart or did not.
function secretOrigin() {
  if (process.env.JWT_SECRET) return 'environment';
  return fs.existsSync(secretFilePath()) ? 'file' : 'generated';
}

module.exports = { now, uuid, secret, secretOrigin, secretFilePath };
