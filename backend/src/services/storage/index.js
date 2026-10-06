// Storage service. Application code never touches the filesystem or an object
// store directly; it calls this, which delegates to a driver chosen by
// STORAGE_DRIVER.
//
//   STORAGE_DRIVER=local   files under UPLOAD_DIR (default, no dependencies)
//   STORAGE_DRIVER=s3      any S3-compatible endpoint: Amazon S3, Cloudflare
//                          R2, MinIO, Backblaze, and so on
//
// Object keys are generated here and never derived from an uploaded filename.
// A key is a path built from ids the server already knows are valid, so no user
// input can influence it.
//
// A driver implements:
//   put(key, buffer, contentType) -> { size, etag }
//   get(key) -> Buffer
//   createReadStream(key) -> Readable
//   delete(key) -> void          (must not throw when the key is absent)
//   exists(key) -> boolean
//   list(prefix) -> [{ key, size }]   (optional; local supports it)
//   signedUrl(key, expiresInSeconds) -> string | null   (optional; S3 supports it)
const path = require('path');

const DRIVERS = { local: () => require('./local'), s3: () => require('./s3') };

let driver = null;

function config() {
  const kind = String(process.env.STORAGE_DRIVER || 'local').trim().toLowerCase();
  if (!DRIVERS[kind]) {
    throw new Error(
      'STORAGE_DRIVER must be one of: ' + Object.keys(DRIVERS).join(', ') + ' (got "' + kind + '")'
    );
  }
  return { kind };
}

function get() {
  if (!driver) {
    const { kind } = config();
    driver = DRIVERS[kind]();
    driver.init(kind === 'local' ? { root: localRoot() } : s3Config());
  }
  return driver;
}

// Files live under UPLOAD_DIR. The default sits next to the server package so a
// checkout works with no configuration at all.
function localRoot() {
  if (process.env.UPLOAD_DIR) return path.resolve(process.env.UPLOAD_DIR);
  return path.join(__dirname, '..', '..', '..', 'uploads');
}

function s3Config() {
  const required = ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error('STORAGE_DRIVER=s3 requires: ' + missing.join(', '));
  }
  return {
    bucket: process.env.S3_BUCKET,
    endpoint: (process.env.S3_ENDPOINT || 'https://s3.amazonaws.com').replace(/\/+$/, ''),
    region: process.env.S3_REGION || 'us-east-1',
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    // Path-style addressing is the default because R2 and MinIO require it;
    // virtual-host style is needed only when a bucket name is not DNS-safe.
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
  };
}

// --- object keys ---------------------------------------------------------
//
// Keys encode who owns an object and what it is, which is what makes
// cross-tenant access a query question rather than a string-prefix guess.
// Ids are validated before they reach a key, so traversal is impossible
// regardless of driver.

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function assertId(value, label) {
  const s = String(value || '');
  if (!ID.test(s)) throw new Error('invalid ' + label + ' for object key');
  return s;
}

function objectKey(owner, ownerId, kind, objectId) {
  return [
    assertId(owner, 'owner'),
    assertId(ownerId, 'owner id'),
    assertId(kind, 'kind'),
    assertId(objectId, 'object id'),
  ].join('/');
}

const key = {
  userMedia: (userId, kind, objectId) => objectKey('user', userId, kind, objectId),
  communityMedia: (serverId, kind, objectId) => objectKey('community', serverId, kind, objectId),
  // Scoped by channel rather than message: an attachment is uploaded before the
  // message exists, and re-keying it on attach would mean a failed attach loses
  // the object. The channel is stable for the life of the attachment.
  messageMedia: (channelId, objectId) => objectKey('channel', channelId, 'attachment', objectId),
};

// --- driver surface ------------------------------------------------------

async function put(k, buffer, contentType) {
  return get().put(k, buffer, contentType);
}

async function get_(k) {
  return get().get(k);
}

function createReadStream(k) {
  return get().createReadStream(k);
}

async function remove(k) {
  return get().delete(k);
}

async function exists(k) {
  return get().exists(k);
}

async function list(prefix) {
  const d = get();
  if (typeof d.list !== 'function') return null;
  return d.list(prefix);
}

function signedUrl(k, expiresInSeconds) {
  const d = get();
  if (typeof d.signedUrl !== 'function') return null;
  return d.signedUrl(k, expiresInSeconds);
}

// True when a key is inside the tree this driver is responsible for. Used by
// the storage migration tool to refuse to copy a key onto itself.
function isLocalRoot(k) {
  const root = localRoot();
  const abs = path.resolve(root, k);
  return abs === root || abs.startsWith(root + path.sep);
}

// Resolve the driver eagerly so a misconfigured STORAGE_DRIVER or a missing
// S3 credential fails at boot, not on the first upload. Call once at startup.
function init() {
  return get();
}

function reset() {
  driver = null;
}

module.exports = {
  put,
  get: get_,
  createReadStream,
  delete: remove,
  exists,
  list,
  signedUrl,
  key,
  localRoot,
  isLocalRoot,
  driverName: () => config().kind,
  init,
  reset,
};
