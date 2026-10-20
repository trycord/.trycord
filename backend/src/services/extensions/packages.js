// The package document: what an extension is, and what may be done with one.
//
// A package arrives from the registry as a JSON document. This module turns
// that document into the shape the rest of the code works with, and refuses
// the ones that are malformed. Nothing is written to the database before it
// has been through here.
//
// The rules are deliberately strict. A package that names a capability this
// instance does not know is refused rather than installed with the unknown
// name dropped, because a package asking for something the operator cannot
// see is a package asking for something the operator cannot grant.

const capabilities = require('./capabilities');
const workflowTriggers = require('../workflows/triggers');
const { VERSION, EXTENSION_API_VERSION } = require('../../version');

// The extension API version this build implements.
//
// It is a contract of its own, written down in src/version.js and changed by
// hand when the extension surface changes - never derived from the
// application release. A package declares the surface it was built against,
// and a package built against an older surface of the same generation is
// still welcome here, because this build implements that surface too.
const EXTENSION_API = EXTENSION_API_VERSION;

const REVIEW_STATUSES = ['unreviewed', 'in-review', 'approved', 'rejected'];

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,127}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function invalid(message) {
  const e = new Error(message);
  e.code = 'VALIDATION_ERROR';
  throw e;
}

function text(value, max) {
  if (value === undefined || value === null) return null;
  const s = String(value);
  if (s.length > max) invalid('a text field is longer than ' + max + ' characters');
  return s;
}

function stringList(value, max, what) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) invalid(what + ' must be a list');
  if (value.length > max) invalid(what + ' has more than ' + max + ' entries');
  const out = [];
  for (const entry of value) {
    const s = String(entry === undefined || entry === null ? '' : entry).trim();
    if (!s) continue;
    if (s.length > 255) invalid(what + ' has an entry longer than 255 characters');
    out.push(s);
  }
  return out;
}

/** Parse "1.2.3" into [1, 2, 3]. Pre-release suffixes are ignored. */
function parseVersion(value) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(value || '').trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Compare two versions. -1, 0 or 1. */
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Whether a version satisfies a range.
 *
 * The supported forms are the ones a package author actually writes: an exact
 * version, a caret or tilde range, a comparison, a wildcard, and an "x"
 * placeholder. Anything else is refused rather than guessed at, because a
 * range this function does not understand would otherwise be treated as
 * satisfied.
 */
function satisfies(version, range) {
  const v = parseVersion(version);
  if (!v) return false;
  const spec = String(range || '*').trim();
  if (!spec || spec === '*' || spec === 'x' || spec === 'X') return true;

  const m = /^(\^|~|>=|<=|>|<|=)?\s*v?(\d+)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?$/.exec(spec);
  if (!m) return false;
  const op = m[1] || '=';
  const major = Number(m[2]);
  const minorWild = m[3] === undefined || m[3] === 'x' || m[3] === 'X' || m[3] === '*';
  const minor = minorWild ? 0 : Number(m[3]);
  const patchWild = m[4] === undefined || m[4] === 'x' || m[4] === 'X' || m[4] === '*';
  const patch = patchWild ? 0 : Number(m[4]);

  if (op === '=') {
    if (minorWild) return v[0] === major;
    if (patchWild) return v[0] === major && v[1] === minor;
    return compareVersions(version, major + '.' + minor + '.' + patch) === 0;
  }
  if (op === '>') return compareVersions(version, major + '.' + minor + '.' + patch) > 0;
  if (op === '>=') return compareVersions(version, major + '.' + minor + '.' + patch) >= 0;
  if (op === '<') return compareVersions(version, major + '.' + minor + '.' + patch) < 0;
  if (op === '<=') return compareVersions(version, major + '.' + minor + '.' + patch) <= 0;
  if (op === '^') {
    // The caret allows changes that do not modify the left-most non-zero part.
    if (major > 0) return v[0] === major;
    if (minor > 0) return v[0] === 0 && v[1] === minor;
    return v[0] === 0 && v[1] === 0 && v[2] === patch;
  }
  if (op === '~') {
    // The tilde allows patch-level changes within the minor version.
    return v[0] === major && v[1] === minor;
  }
  return false;
}

/**
 * Whether a package is compatible with this instance.
 *
 * The package names the extension API version it targets and the range of
 * application versions it runs on. A package built for another API generation
 * is refused rather than installed and left to fail at its first step.
 *
 * The extension API is a contract of its own, so it is compared as one: a
 * package built against an older surface of the **same** generation is
 * accepted, because this build implements that surface as well, and a package
 * built against a newer surface is refused, because this build cannot know
 * what that surface asks of it.
 *
 * The newest surface this instance's family has reached counts as a surface
 * it has. Before the extension API was given a version of its own, a package
 * declared the application version it was built for, so the packages that
 * installed on a 3.6 instance declared "3.6" - and refusing those would
 * have uninstalled the extensions people had. The rule is therefore never
 * narrower than the one it replaced: it accepts everything that used to be
 * accepted, and everything that used to be refused is still refused.
 */
function compatibilityReport(declared) {
  const compat = declared && typeof declared === 'object' ? declared : {};
  const api = String(compat.api || '').trim();
  const minInstance = compat.minInstance ? String(compat.minInstance).trim() : null;
  const maxInstance = compat.maxInstance ? String(compat.maxInstance).trim() : null;

  if (!api) return { ok: false, reason: 'the package does not declare which extension API version it targets' };
  if (!sameGeneration(api, EXTENSION_API)) {
    return {
      ok: false,
      reason: 'the package targets extension API ' + api + ' and this instance implements ' + EXTENSION_API,
    };
  }
  if (compareApiVersions(api, newestSurface()) > 0) {
    return {
      ok: false,
      reason: 'the package targets extension API ' + api + ', which is newer than the '
        + newestSurface() + ' this instance reaches',
    };
  }
  if (minInstance && compareVersions(VERSION, minInstance) < 0) {
    return { ok: false, reason: 'the package needs Trycord ' + minInstance + ' or newer, and this is ' + VERSION };
  }
  if (maxInstance && compareVersions(VERSION, maxInstance) > 0) {
    return { ok: false, reason: 'the package supports Trycord up to ' + maxInstance + ', and this is ' + VERSION };
  }
  return { ok: true, api, minInstance, maxInstance };
}

// The newest extension surface this instance's family has reached.
//
// The surface this build implements is one thing; the newest version of the
// application is another, and a package that declared the application
// version it was built for - which is what every package did, while the
// extension API version was the application version - is still a package of
// this generation.
//
// The answer is the later of the two: the surface, and the application
// version's own major and minor. It is never lower than the surface, so the
// rule can only ever accept more than it used to.
function newestSurface() {
  const surface = parseApiVersion(EXTENSION_API);
  const application = parseApiVersion(VERSION);
  if (!surface) return EXTENSION_API;
  if (!application) return EXTENSION_API;
  return compareApiVersions(VERSION, EXTENSION_API) > 0 ? VERSION.split('.').slice(0, 2).join('.') : EXTENSION_API;
}

// The extension API version is written the way a package author writes it -
// "3.0", sometimes "3.0.1" - so it is parsed on its own terms rather than
// through the strict semver parser the application versions use.
function parseApiVersion(value) {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(String(value || '').trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)];
}

/** Compare two extension API versions. -1, 0 or 1. */
function compareApiVersions(a, b) {
  const pa = parseApiVersion(a);
  const pb = parseApiVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

// Whether two versions belong to the same generation: the same major.
//
// A generation is a break in the extension surface. Within a generation the
// surface only grows, so an older package still fits.
function sameGeneration(a, b) {
  const pa = parseApiVersion(a);
  const pb = parseApiVersion(b);
  if (!pa || !pb) return false;
  return pa[0] === pb[0];
}

/**
 * Validate and normalise a package document.
 *
 * Whether a *trusted* package may be installed is a policy question and is
 * decided by the instance policy at install time, not here: a registry that
 * carries trusted packages must still be listable on an instance that refuses
 * to run them.
 *
 * @param {object} doc           the document as it arrived
 * @returns {object} the normalised package
 */
function normalise(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) invalid('a package must be a JSON object');

  const id = String(doc.id || '').trim();
  if (!ID_PATTERN.test(id)) {
    invalid('a package id must be lowercase letters, digits, dots, dashes or underscores');
  }
  const name = String(doc.name || '').trim();
  if (!name || name.length > 128) invalid('a package needs a name of 1 to 128 characters');
  const version = String(doc.version || '').trim();
  if (!VERSION_PATTERN.test(version)) invalid('a package version must look like 1.2.3');

  if (doc.capabilities !== undefined && doc.capabilities !== null && !Array.isArray(doc.capabilities)) {
    invalid('capabilities must be a list of capability names');
  }
  const { known, unknown } = capabilities.partition(doc.capabilities);
  if (unknown.length) {
    invalid('the package asks for capabilities this instance does not know: ' + unknown.join(', '));
  }
  const requested = known;

  const compat = compatibilityReport(doc.compatibility);

  const maintainers = stringList(doc.maintainers, 20, 'maintainers');
  const dependencies = {};
  if (doc.dependencies !== undefined && doc.dependencies !== null) {
    if (typeof doc.dependencies !== 'object' || Array.isArray(doc.dependencies)) {
      invalid('dependencies must be an object of package id to version range');
    }
    for (const [depId, range] of Object.entries(doc.dependencies)) {
      const key = String(depId || '').trim();
      if (!ID_PATTERN.test(key)) invalid('a dependency id is not a valid package id: ' + depId);
      const spec = String(range || '*').trim();
      if (!spec || spec.length > 64) invalid('a dependency range is too long');
      dependencies[key] = spec;
    }
  }

  const trusted = doc.trusted === true;
  const entry = doc.entry && typeof doc.entry === 'object' ? doc.entry : null;
  if (entry && !trusted) {
    invalid('only a package marked trusted may declare a server-side entry point');
  }
  const entrySource = entry ? text(entry.source, 200000) : null;
  if (entry && !entrySource) invalid('a server-side entry point must carry its source');

  const triggers = normaliseTriggers(doc.triggers);

  const reviewStatus = String(doc.reviewStatus || 'unreviewed').trim().toLowerCase();
  if (!REVIEW_STATUSES.includes(reviewStatus)) invalid('an unknown review status: ' + reviewStatus);

  return {
    id,
    name,
    version,
    description: text(doc.description, 2000),
    author: text(doc.author, 128),
    maintainers,
    homepage: text(doc.homepage, 512),
    entryPoint: text(doc.entryPoint || (entry && entry.file), 255),
    capabilities: requested,
    compatibility: {
      api: compat.api || String((doc.compatibility || {}).api || '').trim(),
      minInstance: compat.minInstance || null,
      maxInstance: compat.maxInstance || null,
    },
    dependencies,
    trusted,
    reviewStatus,
    triggers,
    entry: entry ? { file: text(entry.file, 255), source: entrySource } : null,
    signature: normaliseSignature(doc.signature),
  };
}

function normaliseSignature(value) {
  if (!value || typeof value !== 'object') return null;
  const keyId = String(value.keyId || '').trim();
  const algorithm = String(value.algorithm || '').trim().toLowerCase();
  const signature = String(value.value || '').trim();
  if (!keyId || !algorithm || !signature) return null;
  if (!['hmac-sha256', 'ed25519'].includes(algorithm)) return null;
  return { keyId: keyId.slice(0, 64), algorithm, value: signature.slice(0, 512) };
}

// A trigger is an event name, the conditions that must hold for it, and the
// steps that run when they do.
function normaliseTriggers(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) invalid('triggers must be a list');
  if (value.length > 10) invalid('a package may declare at most 10 triggers');
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object') invalid('trigger ' + index + ' is not an object');
    const named = String(entry.event || '').trim();
    // The event has to be one this instance publishes, or the trigger would
    // wait for something that never happens.
    const event = workflowTriggers.normalise(named);
    if (!event) invalid('trigger ' + index + ' names an event this instance does not publish: ' + named);
    return {
      event,
      conditions: normaliseConditions(entry.conditions),
      steps: normaliseSteps(entry.steps),
    };
  });
}

/**
 * Validate a condition list.
 *
 * Conditions are compared field by field. There is no expression language and
 * nothing is evaluated as code: a condition is a path, an operator and a
 * value, and the operator is one of a fixed list.
 */
function normaliseConditions(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) invalid('conditions must be a list');
  if (value.length > 20) invalid('a workflow may declare at most 20 conditions');
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object') invalid('condition ' + index + ' is not an object');
    const field = String(entry.field || '').trim();
    if (!field || field.length > 128) invalid('condition ' + index + ' needs a field path');
    const op = String(entry.op || 'eq').trim().toLowerCase();
    const OPERATORS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'notContains', 'in', 'exists'];
    if (!OPERATORS.includes(op)) invalid('condition ' + index + ' uses an unknown operator: ' + op);
    let compare = entry.value;
    if (op === 'in') {
      if (!Array.isArray(compare)) invalid('condition ' + index + ' uses "in" and needs a list of values');
      compare = compare.slice(0, 100).map((v) => (typeof v === 'number' || typeof v === 'boolean' ? v : String(v)));
    } else if (compare !== undefined && compare !== null && typeof compare !== 'number' && typeof compare !== 'boolean') {
      compare = String(compare);
    }
    if (compare !== undefined && compare !== null && String(compare).length > 2000) {
      invalid('condition ' + index + ' compares against a value longer than 2000 characters');
    }
    return { field, op, value: compare === undefined ? null : compare };
  });
}

/**
 * Validate a step list.
 *
 * A step either performs an action or asks for an approval. The action name
 * is checked against the action catalogue by the caller, because the
 * catalogue lives with the engine that runs the steps.
 */
function normaliseSteps(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) invalid('steps must be a list');
  if (value.length > 50) invalid('a workflow may declare at most 50 steps');
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object') invalid('step ' + index + ' is not an object');
    const type = String(entry.type || 'action').trim().toLowerCase();
    if (type === 'action') {
      const action = String(entry.action || '').trim();
      if (!action || action.length > 64) invalid('step ' + index + ' needs an action name');
      const params = entry.params === undefined || entry.params === null ? {} : entry.params;
      if (typeof params !== 'object' || Array.isArray(params)) invalid('step ' + index + ' has invalid parameters');
      return { type: 'action', action, params };
    }
    if (type === 'approval') {
      const approvers = stringList(entry.approvers, 20, 'approvers');
      return { type: 'approval', approvers, comment: text(entry.comment, 500) };
    }
    if (type === 'code') {
      // A step that runs the extension's own server-side code. Only a
      // trusted package can produce one, and the extension that owns the
      // workflow supplies the code.
      return { type: 'code', params: {} };
    }
    invalid('step ' + index + ' has an unknown type: ' + type);
    return null;
  });
}

module.exports = {
  EXTENSION_API,
  REVIEW_STATUSES,
  ID_PATTERN,
  normalise,
  normaliseTriggers,
  normaliseConditions,
  normaliseSteps,
  compatibilityReport,
  compareVersions,
  satisfies,
  parseVersion,
  invalid,
};
