// The extension lifecycle.
//
// install, enable, disable, update, roll back, remove. Every one of them is
// an explicit act by an operator, every one of them is audited, and every
// one of them can be undone: a rollback puts back the manifest and the code
// of an earlier version exactly as they were approved, and a revoked
// capability stops the extension on its next call.
//
// An extension is a set of workflows. Installing one creates its workflows,
// enabling it activates them, disabling it pauses them, and removing it
// revokes its capabilities and pauses them for good. The extension's grants
// are the workflows' grants, read live, so a capability that is taken back
// is gone on the next call rather than at the next restart.

const store = require('./store');
const registry = require('./registry');
const packages = require('./packages');
const capabilities = require('./capabilities');
const audit = require('./audit');
const workflowStore = require('../workflows/store');

function fail(message, code) {
  const e = new Error(message);
  e.code = code || 'VALIDATION_ERROR';
  throw e;
}

/**
 * Whether the installed extensions already depend on a package.
 *
 * Walks the dependency graph of the installed extensions. Used to refuse an
 * install that would close a loop: A needs B, B needs A, and installing the
 * second one would leave neither installable.
 */
async function dependsOn(fromId, targetId, seen) {
  const visited = seen || new Set();
  if (visited.has(fromId)) return false;
  visited.add(fromId);
  const row = await store.getExtension(fromId);
  if (!row || row.state === 'removed') return false;
  const dependencies = row.dependencies || {};
  for (const dependency of Object.keys(dependencies)) {
    if (dependency === targetId) return true;
    if (await dependsOn(dependency, targetId, visited)) return true;
  }
  return false;
}

/**
 * Check the packages a package needs.
 *
 * A dependency that is not installed, is installed at the wrong version, or
 * is installed but not enabled is a refusal with a reason that says which of
 * those it is. The caller is not left guessing.
 */
async function checkDependencies(pkg) {
  for (const [dependencyId, range] of Object.entries(pkg.dependencies || {})) {
    const dependency = await store.getExtension(dependencyId);
    if (!dependency || dependency.state === 'removed') {
      fail('the package needs "' + dependencyId + '", which is not installed');
    }
    if (!packages.satisfies(dependency.version, range)) {
      fail('the package needs "' + dependencyId + '" ' + range + ', and version ' + dependency.version + ' is installed');
    }
    if (dependency.state !== 'enabled') {
      fail('the package needs "' + dependencyId + '", which is installed but ' + dependency.state);
    }
    if (await dependsOn(dependencyId, pkg.id)) {
      fail('installing this would create a dependency cycle: "' + dependencyId + '" already needs "' + pkg.id + '"');
    }
  }
}

/**
 * The capabilities an operator is granting, and the ones that were refused.
 *
 * A grant for a capability the package did not ask for is refused: the
 * operator is answering a consent screen, and the answer to a question that
 * was not asked is a mistake.
 */
function resolveGrants(pkg, requested) {
  const asked = new Set(pkg.capabilities);
  const granted = [];
  const refused = [];
  for (const capability of requested || []) {
    const id = String(capability || '').trim();
    if (!id) continue;
    if (!asked.has(id)) {
      refused.push({ capability: id, reason: 'the package does not ask for it' });
      continue;
    }
    granted.push(id);
  }
  return { granted: [...new Set(granted)], refused };
}

/**
 * The workflows a package's triggers describe.
 *
 * One workflow per trigger. A trigger that has no steps is still a
 * workflow: it runs, it records that it did, and it does nothing.
 */
function workflowsFor(pkg, actorId, state) {
  return pkg.triggers.map((trigger, index) => ({
    name: pkg.name + (pkg.triggers.length > 1 ? ' (' + trigger.event + ')' : ''),
    description: pkg.description,
    ownerId: actorId,
    state,
    version: 1,
    trigger: { type: 'event', event: trigger.event },
    conditions: trigger.conditions,
    steps: trigger.steps,
    grants: [],
    limits: workflowStore.DEFAULT_LIMITS,
    onError: 'stop',
    source: 'extension',
    extensionId: pkg.id,
  }));
}

/**
 * Bring the extension's workflows in line with its manifest.
 *
 * Workflows are matched by the event they answer, not by their position, so
 * a package that changes the order of its triggers does not shuffle the run
 * history around. A trigger that has gone leaves its workflow disabled rather
 * than deleted: the runs it made are part of the instance's history.
 */
async function syncWorkflows(pkg, actorId, state) {
  const wanted = workflowsFor(pkg, actorId, state);
  const existing = await workflowStore.listWorkflows({ extensionId: pkg.id });

  for (const workflow of existing) {
    const trigger = wanted.find((w) => w.trigger.event === workflow.trigger.event);
    if (!trigger) {
      await workflowStore.setWorkflowState(workflow.id, 'disabled');
      continue;
    }
    await workflowStore.updateWorkflow(workflow.id, {
      name: trigger.name,
      description: trigger.description,
      trigger: trigger.trigger,
      conditions: trigger.conditions,
      steps: trigger.steps,
      grants: trigger.grants,
      limits: trigger.limits,
      onError: trigger.onError,
      version: (workflow.version || 1) + 1,
      nextRunAt: null,
    });
  }

  for (const trigger of wanted) {
    const known = existing.find((w) => w.trigger.event === trigger.trigger.event);
    if (known) continue;
    await workflowStore.insertWorkflow(trigger);
  }
}

/**
 * Install a package.
 *
 * @param {object} options
 * @param {string} options.packageId  the id in the registry
 * @param {string} [options.version]  the version to install
 * @param {string[]} options.grants   the capabilities the operator grants
 * @param {string} options.actorId
 */
async function install(options) {
  const packageId = String(options.packageId || '').trim();
  if (!packageId) fail('a package id is required');

  const entry = await registry.get(packageId, { refresh: true });
  if (!entry) fail('the registry does not offer a package called "' + packageId + '"');

  const policy = await store.readPolicy();
  const decision = registry.installability(entry, policy);
  if (!decision.allowed) fail(decision.reason, 'PERMISSION_DENIED');

  const existing = await store.getExtension(packageId);
  if (existing && existing.state !== 'removed') {
    fail('"' + packageId + '" is already installed', 'CONFLICT');
  }

  const compatibility = packages.compatibilityReport(entry.compatibility);
  if (!compatibility.ok) fail(compatibility.reason);

  const pkg = packages.normalise(entry.manifest);
  if (options.version && options.version !== pkg.version) {
    fail('the registry offers version ' + pkg.version + ', not ' + options.version);
  }
  await checkDependencies(pkg);

  const { granted, refused } = resolveGrants(pkg, options.grants);
  const signature = {
    keyId: entry.signature ? entry.signature.keyId : null,
    value: entry.signature ? entry.signature.value : null,
    status: entry.signature ? entry.signature.status : 'unsigned',
  };

  if (existing) {
    // A package that was removed and is installed again starts over.
    await store.updateExtensionMeta(pkg, { source: entry.source, signature });
    await store.setExtensionState(pkg.id, 'installed');
  } else {
    await store.insertExtension(pkg, { source: entry.source, actorId: options.actorId, signature });
  }

  await store.insertVersion(pkg, {
    source: entry.source,
    signature,
    manifest: entry.manifest,
    entryCode: pkg.entry ? pkg.entry.source : null,
  });

  for (const capability of granted) {
    await store.grant(pkg.id, capability, options.actorId, 'granted at install');
  }

  await syncWorkflows(pkg, options.actorId, 'paused');

  await audit.record(
    options.actorId,
    audit.ACTIONS.INSTALLED,
    'extension',
    pkg.id,
    'version ' + pkg.version + ', granted: ' + (granted.join(', ') || 'nothing')
  );

  return {
    extension: await store.getExtension(pkg.id),
    requested: pkg.capabilities,
    granted,
    refused,
    signature,
  };
}

/** Turn an installed extension on. */
async function enable(extensionId, actorId) {
  const extension = await store.getExtension(extensionId);
  if (!extension || extension.state === 'removed') fail('that extension is not installed');
  if (extension.state === 'enabled') return { extension };

  await store.setExtensionState(extensionId, 'enabled');
  for (const workflow of await workflowStore.listWorkflows({ extensionId })) {
    await workflowStore.setWorkflowState(workflow.id, 'active');
  }
  await audit.record(actorId, audit.ACTIONS.ENABLED, 'extension', extensionId, 'enabled version ' + extension.version);
  return { extension: await store.getExtension(extensionId) };
}

/** Turn an extension off. Its capabilities are not revoked, only unused. */
async function disable(extensionId, actorId) {
  const extension = await store.getExtension(extensionId);
  if (!extension || extension.state === 'removed') fail('that extension is not installed');
  if (extension.state === 'disabled') return { extension };

  await store.setExtensionState(extensionId, 'disabled');
  for (const workflow of await workflowStore.listWorkflows({ extensionId })) {
    await workflowStore.setWorkflowState(workflow.id, 'paused');
  }
  await audit.record(actorId, audit.ACTIONS.DISABLED, 'extension', extensionId, 'disabled version ' + extension.version);
  return { extension: await store.getExtension(extensionId) };
}

/**
 * Install a newer version of a package.
 *
 * The new version is validated exactly as an install is: the registry's
 * rules, the compatibility declaration and the dependencies all apply. The
 * previous version stays on disk, so a rollback has something to go back to.
 */
async function update(extensionId, version, actorId) {
  const extension = await store.getExtension(extensionId);
  if (!extension || extension.state === 'removed') fail('that extension is not installed');

  const entry = await registry.get(extensionId, { refresh: true });
  if (!entry) fail('the registry does not offer a package called "' + extensionId + '"');
  if (version && entry.version !== version) {
    fail('the registry offers version ' + entry.version + ', not ' + version);
  }

  const policy = await store.readPolicy();
  const decision = registry.installability(entry, policy);
  if (!decision.allowed) fail(decision.reason, 'PERMISSION_DENIED');

  const compatibility = packages.compatibilityReport(entry.compatibility);
  if (!compatibility.ok) fail(compatibility.reason);

  const pkg = packages.normalise(entry.manifest);
  await checkDependencies(pkg);

  const signature = {
    keyId: entry.signature ? entry.signature.keyId : null,
    value: entry.signature ? entry.signature.value : null,
    status: entry.signature ? entry.signature.status : 'unsigned',
  };
  await store.insertVersion(pkg, {
    source: entry.source,
    signature,
    manifest: entry.manifest,
    entryCode: pkg.entry ? pkg.entry.source : null,
  });
  await store.updateExtensionMeta(pkg, { source: entry.source, signature });
  await syncWorkflows(pkg, extension.installedBy || actorId, extension.state === 'enabled' ? 'active' : 'paused');

  await audit.record(
    actorId,
    audit.ACTIONS.UPDATED,
    'extension',
    extensionId,
    'updated to version ' + pkg.version
  );
  return { extension: await store.getExtension(extensionId) };
}

/**
 * Go back to a version that was installed before.
 *
 * The manifest and the code of that version are restored exactly as they
 * were: the version row is the record of what was approved, and it is what
 * is put back.
 */
async function rollback(extensionId, version, actorId) {
  const extension = await store.getExtension(extensionId);
  if (!extension || extension.state === 'removed') fail('that extension is not installed');

  const target = await store.getVersion(extensionId, String(version || ''));
  if (!target) fail('version ' + version + ' of "' + extensionId + '" was never installed');

  const pkg = packages.normalise(target.manifest);
  const signature = {
    keyId: target.signature ? target.signature.keyId : null,
    value: target.signature ? target.signature.value : null,
    status: target.signature ? target.signature.status : 'unsigned',
  };
  await store.updateExtensionMeta(pkg, { source: target.source, signature });
  await syncWorkflows(pkg, extension.installedBy || actorId, extension.state === 'enabled' ? 'active' : 'paused');

  await audit.record(
    actorId,
    audit.ACTIONS.ROLLED_BACK,
    'extension',
    extensionId,
    'rolled back to version ' + pkg.version
  );
  return { extension: await store.getExtension(extensionId) };
}

/**
 * Remove an extension.
 *
 * Its capabilities are revoked, its workflows are paused, and the record is
 * kept: the audit trail and the run history still refer to it, and a reader
 * has to be able to see that it existed.
 */
async function remove(extensionId, actorId, reason) {
  const extension = await store.getExtension(extensionId);
  if (!extension || extension.state === 'removed') fail('that extension is not installed');

  for (const grant of await store.listGrants(extensionId)) {
    if (grant.active) await store.revoke(extensionId, grant.capability, actorId, reason || 'the extension was removed');
  }
  for (const workflow of await workflowStore.listWorkflows({ extensionId })) {
    await workflowStore.setWorkflowState(workflow.id, 'paused');
  }
  await store.setExtensionState(extensionId, 'removed');
  await audit.record(actorId, audit.ACTIONS.REMOVED, 'extension', extensionId, reason || 'removed');
  return { extension: await store.getExtension(extensionId) };
}

/** Grant a capability to an extension. */
async function grant(extensionId, capability, actorId, reason) {
  const extension = await store.getExtension(extensionId);
  if (!extension || extension.state === 'removed') fail('that extension is not installed');
  const id = String(capability || '').trim();
  if (!capabilities.isKnown(id)) fail('"' + id + '" is not a capability this instance knows');
  if (!extension.requestedCapabilities.includes(id)) {
    fail('the extension does not ask for "' + id + '"');
  }
  const result = await store.grant(extensionId, id, actorId, reason || null);
  await audit.record(actorId, audit.ACTIONS.CAPABILITY_GRANTED, 'extension', extensionId, id);
  return result;
}

/** Take a capability back from an extension. */
async function revoke(extensionId, capability, actorId, reason) {
  const extension = await store.getExtension(extensionId);
  if (!extension || extension.state === 'removed') fail('that extension is not installed');
  const id = String(capability || '').trim();
  const result = await store.revoke(extensionId, id, actorId, reason || null);
  if (!result) fail('the extension does not hold "' + id + '"');
  await audit.record(actorId, audit.ACTIONS.CAPABILITY_REVOKED, 'extension', extensionId, id);
  return result;
}

module.exports = {
  install,
  enable,
  disable,
  update,
  rollback,
  remove,
  grant,
  revoke,
  checkDependencies,
  dependsOn,
  resolveGrants,
  syncWorkflows,
  fail,
};
