// The extension registry: where packages come from.
//
// The registry is optional and mirrorable, and nothing in the instance depends
// on it being reachable. A self-hosted instance with no registry configured
// still serves messages, and a registry that is down costs the operator a
// package list rather than the instance.
//
// Three sources, chosen by the instance policy:
//
//   builtin   the first-party directory shipped with the instance
//   mirror    the operator's own registry: an HTTP(S) URL or a local directory
//   disabled  no registry at all
//
// The last known copy is kept in the registry cache table. When a fetch fails,
// the cached copy is still served and the failure is reported next to it, so
// an operator looking at a list during an outage sees what they saw before
// and knows why it might be old.

const fs = require('fs');
const path = require('path');
const store = require('./store');
const packages = require('./packages');
const signatures = require('./signature');

const BUILTIN_DIR = path.join(__dirname, 'builtin');
const FETCH_TIMEOUT_MS = 8000;
const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
const CACHE_TTL_MS = 60 * 1000;

const MODES = ['disabled', 'builtin', 'mirror'];

// The last fetch, so a burst of list requests does not become a burst of
// outbound requests.
let lastFetch = null;

// ---- sources --------------------------------------------------------------

function isRemote(url) {
  return /^https?:\/\//i.test(String(url || ''));
}

function localPath(url) {
  const raw = String(url || '').trim();
  if (!raw) return null;
  if (raw.startsWith('file://')) {
    try {
      return require('url').fileURLToPath(raw);
    } catch {
      return null;
    }
  }
  if (isRemote(raw)) return null;
  return path.resolve(raw);
}

// Read a registry document from a directory: either one registry.json holding
// a list, or one file per package.
function readLocalDirectory(dir) {
  const documents = [];
  const index = path.join(dir, 'registry.json');
  if (fs.existsSync(index)) {
    const parsed = JSON.parse(fs.readFileSync(index, 'utf8'));
    const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.extensions) ? parsed.extensions : []);
    for (const doc of list) documents.push(doc);
    return documents;
  }
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error('the registry directory does not exist: ' + dir);
  }
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    if (Array.isArray(parsed)) documents.push(...parsed);
    else if (parsed && typeof parsed === 'object') documents.push(parsed);
  }
  return documents;
}

async function readRemote(url) {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept: 'application/json', 'user-agent': 'Trycord-Registry/1.0' },
  });
  if (!response.ok) throw new Error('the registry answered ' + response.status);
  const text = await response.text();
  if (text.length > MAX_DOCUMENT_BYTES) throw new Error('the registry document is too large');
  const parsed = JSON.parse(text);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.extensions)) return parsed.extensions;
  throw new Error('the registry document is not a list of packages');
}

// ---- normalisation --------------------------------------------------------

/**
 * Turn a raw registry document into an entry.
 *
 * A document that does not validate is reported rather than dropped: an
 * operator has to be able to see that a package exists and that this
 * instance will not take it.
 */
function toEntry(doc, policy, source) {
  const reference = doc && typeof doc === 'object' && typeof doc.reference === 'string'
    ? doc.reference.slice(0, 512)
    : null;
  try {
    const pkg = packages.normalise(doc);
    const signature = signatures.verify(doc, pkg.signature, policy.signingKeys);
    return {
      id: pkg.id,
      version: pkg.version,
      name: pkg.name,
      description: pkg.description,
      author: pkg.author,
      maintainers: pkg.maintainers,
      homepage: pkg.homepage,
      entryPoint: pkg.entryPoint,
      requestedCapabilities: pkg.capabilities,
      trusted: pkg.trusted,
      compatibility: pkg.compatibility,
      dependencies: pkg.dependencies,
      reviewStatus: pkg.reviewStatus,
      signature: { keyId: signature.keyId, value: pkg.signature ? pkg.signature.value : null, status: signature.status },
      signatureReason: signature.reason,
      source,
      reference,
      manifest: Object.assign({}, doc, { signature: pkg.signature }),
      invalid: null,
    };
  } catch (e) {
    return {
      id: String((doc && doc.id) || '').slice(0, 128),
      version: String((doc && doc.version) || '').slice(0, 64),
      name: String((doc && doc.name) || (doc && doc.id) || 'unnamed package').slice(0, 128),
      description: (doc && doc.description) || null,
      author: null,
      maintainers: [],
      homepage: null,
      entryPoint: null,
      requestedCapabilities: [],
      trusted: false,
      compatibility: {},
      dependencies: {},
      reviewStatus: 'rejected',
      signature: { status: 'unsigned' },
      signatureReason: null,
      source,
      reference,
      manifest: doc && typeof doc === 'object' ? doc : {},
      invalid: String((e && e.message) || e),
    };
  }
}

// ---- fetching -------------------------------------------------------------

async function fetchEntries(policy) {
  if (policy.registryMode === 'disabled') return { documents: [], source: 'disabled' };
  if (policy.registryMode === 'builtin') {
    return { documents: readLocalDirectory(BUILTIN_DIR), source: 'builtin' };
  }
  const url = String(policy.registryUrl || '').trim();
  if (!url) throw new Error('the registry is set to a mirror but no address is configured');
  const dir = localPath(url);
  if (dir) return { documents: readLocalDirectory(dir), source: 'mirror' };
  return { documents: await readRemote(url), source: 'mirror' };
}

/**
 * Fetch the registry and refresh the cache.
 *
 * Never throws: a failure is reported in the result and the previous cache
 * is left alone. The caller decides what to do about it.
 */
async function refresh() {
  const policy = await store.readPolicy();
  if (policy.registryMode === 'disabled') {
    lastFetch = { at: Date.now(), ok: true, error: null };
    await store.replaceCache([], 'disabled');
    return { available: false, source: 'disabled', error: 'the registry is disabled on this instance', entries: [] };
  }
  let fetched;
  try {
    fetched = await fetchEntries(policy);
  } catch (e) {
    const error = String((e && e.message) || e);
    lastFetch = { at: Date.now(), ok: false, error };
    const cached = await store.listCache();
    return { available: false, source: policy.registryMode, error, entries: cached, stale: true };
  }
  const entries = fetched.documents.map((doc) => toEntry(doc, policy, fetched.source));
  const installable = entries.filter((e) => !e.invalid);
  try {
    await store.replaceCache(installable, fetched.source);
  } catch (e) {
    // A cache that cannot be written is not a reason to lose the list.
    console.warn('[extensions] could not write the registry cache: ' + String((e && e.message) || e));
  }
  lastFetch = { at: Date.now(), ok: true, error: null };
  return {
    available: true,
    source: fetched.source,
    error: null,
    entries,
    invalid: entries.filter((e) => e.invalid),
  };
}

/**
 * The registry as this instance currently sees it.
 *
 * With `refresh` the source is fetched again. Without it, the cached copy is
 * served unless it is older than the cache lifetime, in which case the source
 * is fetched once and the result cached.
 */
async function list(options = {}) {
  const policy = await store.readPolicy();
  if (policy.registryMode === 'disabled') {
    return { source: 'disabled', available: false, error: 'the registry is disabled on this instance', entries: [] };
  }
  const cached = await store.listCache();
  const fresh = lastFetch && Date.now() - lastFetch.at < CACHE_TTL_MS;
  if (!options.refresh && fresh) {
    return { source: policy.registryMode, available: true, error: null, entries: cached };
  }
  if (!options.refresh && cached.length && lastFetch && !lastFetch.ok) {
    // The last fetch failed and the cache is all there is.
    return { source: policy.registryMode, available: false, error: lastFetch.error, entries: cached, stale: true };
  }
  const result = await refresh();
  return {
    source: result.source,
    available: result.available,
    error: result.error,
    entries: result.entries,
    invalid: result.invalid || [],
    stale: !!result.stale,
  };
}

/**
 * One package from the registry, or null.
 *
 * The package is looked up in the registry rather than in the cache, so an
 * install always uses what the registry currently serves.
 */
async function get(id, options = {}) {
  const result = await list(options);
  const entry = (result.entries || []).find((e) => e.id === id);
  if (!entry) return null;
  return Object.assign({}, entry, { source: result.source, available: result.available });
}

/**
 * Whether the policy allows this package to be installed.
 *
 * Three gates, in the order an operator would expect them: the allowlist,
 * the review status, and the signature.
 */
function installability(entry, policy) {
  const allowlist = policy.allowlist || [];
  if (allowlist.length && !allowlist.includes(entry.id)) {
    return { allowed: false, reason: 'the instance only installs extensions on its allowlist, and "' + entry.id + '" is not on it' };
  }
  if (entry.reviewStatus === 'rejected') {
    return { allowed: false, reason: 'the package has been rejected by review' };
  }
  if (entry.reviewStatus !== 'approved' && !policy.allowUnreviewed) {
    return {
      allowed: false,
      reason: 'the package is ' + entry.reviewStatus + ', and this instance only installs approved packages',
    };
  }
  if (policy.requireSignature && (!entry.signature || entry.signature.status !== 'verified')) {
    const why = entry.signature && entry.signature.status
      ? 'its signature is ' + entry.signature.status
      : 'it carries no signature';
    return { allowed: false, reason: 'this instance requires a verified signature, and ' + why };
  }
  if (entry.trusted && !policy.allowTrusted) {
    return {
      allowed: false,
      reason: 'the package runs code on the server, and this instance does not allow that',
    };
  }
  if (entry.invalid) {
    return { allowed: false, reason: 'the package does not validate: ' + entry.invalid };
  }
  return { allowed: true, reason: null };
}

module.exports = {
  MODES,
  BUILTIN_DIR,
  CACHE_TTL_MS,
  list,
  refresh,
  get,
  installability,
  toEntry,
  fetchEntries,
  readLocalDirectory,
};
