// The extension surface.
//
// One place that names what an extension is, what it may do, where it came
// from and what has happened to it. The parts are separate modules because
// they answer different questions:
//
//   capabilities  what a capability is, and whether a grant covers it
//   packages     what a package document is, and whether it validates
//   registry     where packages come from, and which of them may be installed
//   signature    whether a package's signature is good
//   sandbox      where a trusted package's code runs, and what stops it
//   lifecycle    installing, enabling, updating, rolling back and removing
//   store        the rows
//   audit        the record of what was done
//
// This module is the facade the routes talk to.

const capabilities = require('./capabilities');
const packages = require('./packages');
const registry = require('./registry');
const signature = require('./signature');
const sandbox = require('./sandbox');
const bridge = require('./bridge');
const store = require('./store');
const lifecycle = require('./lifecycle');
const audit = require('./audit');

/** The instance-wide policy: the registry, the allowlist, the signature rule. */
async function policy() {
  return store.readPolicy();
}

/**
 * Change the instance-wide policy.
 *
 * An administrator's decision, recorded in the audit trail.
 */
async function setPolicy(patch, actorId) {
  const before = await store.readPolicy();
  const next = Object.assign({}, before, patch || {});
  await store.ensurePolicyRow();
  const saved = await store.writePolicy(next, actorId);
  await audit.record(actorId, audit.ACTIONS.POLICY_UPDATED, 'policy', 'instance', describePolicyChange(before, saved));
  return saved;
}

function describePolicyChange(before, after) {
  const changes = [];
  for (const key of ['registryMode', 'registryUrl', 'allowUnreviewed', 'requireSignature', 'allowTrusted']) {
    const a = before[key] === undefined ? null : before[key];
    const b = after[key] === undefined ? null : after[key];
    if (JSON.stringify(a) !== JSON.stringify(b)) changes.push(key + ': ' + JSON.stringify(a) + ' -> ' + JSON.stringify(b));
  }
  if (JSON.stringify(before.allowlist || []) !== JSON.stringify(after.allowlist || [])) {
    changes.push('allowlist: ' + JSON.stringify(before.allowlist || []) + ' -> ' + JSON.stringify(after.allowlist || []));
  }
  return changes.join('; ') || 'no change';
}

/** The extensions this instance has installed. */
async function installed() {
  const rows = await store.listExtensions();
  const out = [];
  for (const extension of rows) {
    out.push(Object.assign({}, extension, {
      grants: [...(await store.grantSet(extension.id))],
      audit: await audit.forTarget('extension', extension.id, 20),
    }));
  }
  return out;
}

/** One installed extension, with its grants, its versions and its history. */
async function detail(extensionId) {
  const extension = await store.getExtension(extensionId);
  if (!extension) return null;
  return Object.assign({}, extension, {
    grants: await store.listGrants(extensionId),
    versions: await store.listVersions(extensionId),
    audit: await audit.forTarget('extension', extensionId, 50),
  });
}

module.exports = {
  capabilities,
  packages,
  registry,
  signature,
  sandbox,
  bridge,
  store,
  lifecycle,
  audit,
  policy,
  setPolicy,
  installed,
  detail,
};
