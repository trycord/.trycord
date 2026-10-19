// Database access for the extension surface.
//
// Every query the extension and workflow code makes lives here, so the table
// shapes are described in one place and the callers work with objects.
//
// The rows are stored the way the schema declares them and read back through
// the small shape functions at the top: a row with a JSON column in it is
// not something the rest of the code should have to know about.

const db = require('../../db');
const { now, uuid } = require('../../util');

const POLICY_ID = 'default';

const DEFAULT_POLICY = {
  registryMode: 'builtin',
  registryUrl: null,
  allowlist: [],
  allowUnreviewed: false,
  requireSignature: false,
  allowTrusted: false,
  signingKeys: {},
};

function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function stringList(value) {
  const parsed = parseJson(value, []);
  return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
}

// ---- policy ---------------------------------------------------------------

function policyShape(row) {
  if (!row) return Object.assign({}, DEFAULT_POLICY);
  return {
    registryMode: row.registry_mode,
    registryUrl: row.registry_url || null,
    allowlist: stringList(row.allowlist),
    allowUnreviewed: !!row.allow_unreviewed,
    requireSignature: !!row.require_signature,
    allowTrusted: !!row.allow_trusted,
    signingKeys: parseJson(row.signing_keys, {}),
    updatedBy: row.updated_by || null,
    updatedAt: row.updated_at,
  };
}

async function readPolicy() {
  const row = await db.get('SELECT * FROM extension_policy WHERE id = ?', [POLICY_ID]);
  return policyShape(row);
}

async function writePolicy(patch, actorId) {
  const current = await readPolicy();
  const next = Object.assign({}, current, patch || {});
  await db.run(
    'UPDATE extension_policy SET registry_mode = ?, registry_url = ?, allowlist = ?, ' +
    'allow_unreviewed = ?, require_signature = ?, allow_trusted = ?, signing_keys = ?, ' +
    'updated_by = ?, updated_at = ? WHERE id = ?',
    [
      next.registryMode, next.registryUrl || null, JSON.stringify(next.allowlist || []),
      next.allowUnreviewed ? 1 : 0, next.requireSignature ? 1 : 0, next.allowTrusted ? 1 : 0,
      JSON.stringify(next.signingKeys || {}), actorId || null, now(), POLICY_ID,
    ]
  );
  return readPolicy();
}

// The policy row exists from the first write; a deployment that has never
// touched it still needs somewhere to put the first value.
async function ensurePolicyRow() {
  const row = await db.get('SELECT id FROM extension_policy WHERE id = ?', [POLICY_ID]);
  if (row) return;
  await db.run(
    'INSERT INTO extension_policy (id, registry_mode, registry_url, allowlist, allow_unreviewed, ' +
    'require_signature, allow_trusted, signing_keys, updated_by, updated_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      POLICY_ID, DEFAULT_POLICY.registryMode, null, JSON.stringify([]),
      0, 0, 0, JSON.stringify({}), null, now(),
    ]
  );
}

// ---- extensions -----------------------------------------------------------

function extensionShape(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    description: row.description || null,
    author: row.author || null,
    maintainers: stringList(row.maintainers),
    homepage: row.homepage || null,
    entryPoint: row.entry_point || null,
    requestedCapabilities: stringList(row.requested_capabilities),
    trusted: !!row.trusted,
    compatibility: parseJson(row.compatibility, {}),
    dependencies: parseJson(row.dependencies, {}),
    reviewStatus: row.review_status,
    signature: row.signature_key
      ? { keyId: row.signature_key, value: row.signature_value, status: row.signature_status }
      : { status: row.signature_status },
    source: row.source,
    state: row.state,
    installedBy: row.installed_by || null,
    installedAt: row.installed_at,
    updatedAt: row.updated_at,
    lastError: row.last_error || null,
  };
}

async function listExtensions() {
  const rows = await db.all('SELECT * FROM extensions ORDER BY name, id');
  return rows.map(extensionShape);
}

async function getExtension(id) {
  const row = await db.get('SELECT * FROM extensions WHERE id = ?', [id]);
  return extensionShape(row);
}

async function insertExtension(pkg, { source, actorId, signature }) {
  await db.run(
    'INSERT INTO extensions (id, name, version, description, author, maintainers, homepage, ' +
    'entry_point, requested_capabilities, trusted, compatibility, dependencies, review_status, ' +
    'signature_key, signature_value, signature_status, source, state, installed_by, installed_at, updated_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      pkg.id, pkg.name, pkg.version, pkg.description, pkg.author, JSON.stringify(pkg.maintainers),
      pkg.homepage, pkg.entryPoint, JSON.stringify(pkg.capabilities), pkg.trusted ? 1 : 0,
      JSON.stringify(pkg.compatibility), JSON.stringify(pkg.dependencies), pkg.reviewStatus,
      signature ? signature.keyId : null, signature ? signature.value : null,
      signature ? signature.status : 'unsigned', source, 'installed', actorId || null, now(), now(),
    ]
  );
}

async function updateExtensionMeta(pkg, { source, signature }) {
  await db.run(
    'UPDATE extensions SET name = ?, version = ?, description = ?, author = ?, maintainers = ?, ' +
    'homepage = ?, entry_point = ?, requested_capabilities = ?, trusted = ?, compatibility = ?, ' +
    'dependencies = ?, review_status = ?, signature_key = ?, signature_value = ?, signature_status = ?, ' +
    'source = ?, updated_at = ? WHERE id = ?',
    [
      pkg.name, pkg.version, pkg.description, pkg.author, JSON.stringify(pkg.maintainers),
      pkg.homepage, pkg.entryPoint, JSON.stringify(pkg.capabilities), pkg.trusted ? 1 : 0,
      JSON.stringify(pkg.compatibility), JSON.stringify(pkg.dependencies), pkg.reviewStatus,
      signature ? signature.keyId : null, signature ? signature.value : null,
      signature ? signature.status : 'unsigned', source, now(), pkg.id,
    ]
  );
}

async function setExtensionState(id, state, extra) {
  const patch = extra || {};
  await db.run(
    'UPDATE extensions SET state = ?, updated_at = ?, last_error = ? WHERE id = ?',
    [state, now(), patch.error === undefined ? null : patch.error, id]
  );
}

// ---- versions -------------------------------------------------------------

function versionShape(row) {
  if (!row) return null;
  return {
    id: row.id,
    extensionId: row.extension_id,
    version: row.version,
    manifest: parseJson(row.manifest, {}),
    entryCode: row.entry_code || null,
    source: row.source,
    reviewStatus: row.review_status,
    signature: row.signature_key
      ? { keyId: row.signature_key, value: row.signature_value, status: row.signature_status }
      : { status: row.signature_status },
    installedAt: row.installed_at,
  };
}

async function insertVersion(pkg, { source, signature, manifest, entryCode }) {
  const id = uuid();
  await db.run(
    'INSERT INTO extension_versions (id, extension_id, version, manifest, entry_code, source, ' +
    'review_status, signature_key, signature_value, signature_status, installed_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      id, pkg.id, pkg.version, JSON.stringify(manifest || pkg), entryCode || null, source,
      pkg.reviewStatus, signature ? signature.keyId : null, signature ? signature.value : null,
      signature ? signature.status : 'unsigned', now(),
    ]
  );
  return id;
}

async function listVersions(extensionId) {
  const rows = await db.all(
    'SELECT * FROM extension_versions WHERE extension_id = ? ORDER BY installed_at DESC, version DESC',
    [extensionId]
  );
  return rows.map(versionShape);
}

async function getVersion(extensionId, version) {
  const row = await db.get(
    'SELECT * FROM extension_versions WHERE extension_id = ? AND version = ?',
    [extensionId, version]
  );
  return versionShape(row);
}

// ---- grants ---------------------------------------------------------------

function grantShape(row) {
  return {
    id: row.id,
    extensionId: row.extension_id,
    capability: row.capability,
    grantedBy: row.granted_by || null,
    grantedAt: row.granted_at,
    revokedBy: row.revoked_by || null,
    revokedAt: row.revoked_at || null,
    reason: row.reason || null,
    active: !row.revoked_at,
  };
}

// The capabilities an extension currently holds. This set is what every call
// the extension makes is checked against.
async function grantSet(extensionId) {
  const rows = await db.all(
    'SELECT capability FROM extension_grants WHERE extension_id = ? AND revoked_at IS NULL',
    [extensionId]
  );
  return new Set(rows.map((r) => r.capability));
}

async function listGrants(extensionId) {
  const rows = await db.all(
    'SELECT * FROM extension_grants WHERE extension_id = ? ORDER BY granted_at DESC',
    [extensionId]
  );
  return rows.map(grantShape);
}

// Granting is idempotent: a capability that is already granted is left
// alone rather than given a second row, so the set stays a set.
async function grant(extensionId, capability, actorId, reason) {
  const existing = await db.get(
    'SELECT * FROM extension_grants WHERE extension_id = ? AND capability = ? AND revoked_at IS NULL',
    [extensionId, capability]
  );
  if (existing) return grantShape(existing);
  await db.run(
    'INSERT INTO extension_grants (id, extension_id, capability, granted_by, granted_at, reason) ' +
    'VALUES (?, ?, ?, ?, ?, ?)',
    [uuid(), extensionId, capability, actorId || null, now(), reason || null]
  );
  const row = await db.get(
    'SELECT * FROM extension_grants WHERE extension_id = ? AND capability = ? AND revoked_at IS NULL',
    [extensionId, capability]
  );
  return grantShape(row);
}

async function revoke(extensionId, capability, actorId, reason) {
  const existing = await db.get(
    'SELECT * FROM extension_grants WHERE extension_id = ? AND capability = ? AND revoked_at IS NULL',
    [extensionId, capability]
  );
  if (!existing) return null;
  await db.run(
    'UPDATE extension_grants SET revoked_at = ?, revoked_by = ?, reason = ? WHERE id = ?',
    [now(), actorId || null, reason || null, existing.id]
  );
  return grantShape(await db.get('SELECT * FROM extension_grants WHERE id = ?', [existing.id]));
}

// ---- registry cache -------------------------------------------------------

function cacheShape(row) {
  if (!row) return null;
  return {
    id: row.id,
    version: row.version,
    name: row.name,
    description: row.description || null,
    author: row.author || null,
    maintainers: stringList(row.maintainers),
    homepage: row.homepage || null,
    entryPoint: row.entry_point || null,
    requestedCapabilities: stringList(row.requested_capabilities),
    trusted: !!row.trusted,
    compatibility: parseJson(row.compatibility, {}),
    dependencies: parseJson(row.dependencies, {}),
    reviewStatus: row.review_status,
    signature: row.signature_key
      ? { keyId: row.signature_key, value: row.signature_value, status: row.signature_status }
      : { status: row.signature_status },
    source: row.source,
    reference: row.reference || null,
    manifest: parseJson(row.manifest, {}),
    state: row.state,
    fetchedAt: row.fetched_at,
  };
}

async function listCache() {
  const rows = await db.all('SELECT * FROM extension_registry_cache ORDER BY name, id');
  return rows.map(cacheShape);
}

async function getCacheEntry(id) {
  const row = await db.get('SELECT * FROM extension_registry_cache WHERE id = ?', [id]);
  return cacheShape(row);
}

// Replace the cached registry with a fresh copy. The whole set is rewritten
// rather than merged, because a package that has left the registry must leave
// the cache too.
async function replaceCache(entries, source) {
  await db.run('DELETE FROM extension_registry_cache');
  const ts = now();
  for (const entry of entries) {
    await db.run(
      'INSERT INTO extension_registry_cache (id, version, name, description, author, maintainers, ' +
      'homepage, entry_point, requested_capabilities, trusted, compatibility, dependencies, review_status, ' +
      'signature_key, signature_value, signature_status, source, reference, manifest, state, fetched_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        entry.id, entry.version, entry.name, entry.description || null, entry.author || null,
        JSON.stringify(entry.maintainers || []), entry.homepage || null, entry.entryPoint || null,
        JSON.stringify(entry.requestedCapabilities || []), entry.trusted ? 1 : 0,
        JSON.stringify(entry.compatibility || {}), JSON.stringify(entry.dependencies || {}),
        entry.reviewStatus, entry.signature ? entry.signature.keyId : null,
        entry.signature ? entry.signature.value : null, entry.signature ? entry.signature.status : 'unsigned',
        source, entry.reference || null, JSON.stringify(entry.manifest || {}), 'available', ts,
      ]
    );
  }
}

// ---- extension storage ----------------------------------------------------

async function putStorage(extensionId, key, value) {
  // Written through the shared upsert because the two engines disagree about
  // how a conflicting row is updated, and the expression that names the new
  // value is spelled differently in each of them.
  await db.upsert(
    'extension_storage',
    ['extension_id', 'key', 'value', 'updated_at'],
    [extensionId, key, value, now()],
    ['extension_id', 'key'],
    { value: db.newRef('value'), updated_at: db.newRef('updated_at') }
  );
}

async function getStorage(extensionId, key) {
  const row = await db.get(
    'SELECT value FROM extension_storage WHERE extension_id = ? AND key = ?',
    [extensionId, key]
  );
  return row ? row.value : null;
}

module.exports = {
  POLICY_ID,
  DEFAULT_POLICY,
  readPolicy,
  writePolicy,
  ensurePolicyRow,
  listExtensions,
  getExtension,
  insertExtension,
  updateExtensionMeta,
  setExtensionState,
  listVersions,
  getVersion,
  insertVersion,
  grantSet,
  listGrants,
  grant,
  revoke,
  listCache,
  getCacheEntry,
  replaceCache,
  putStorage,
  getStorage,
  parseJson,
};
