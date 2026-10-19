// The workflow surface: creating workflows, running them, and reading what
// they did.
//
// A workflow is a trigger, some conditions and some steps. It runs with a
// capability grant set, it is bounded, and every run of it is recorded with
// what each step did.
//
// The permissions a workflow has are the operator's decision. A workflow
// somebody created may use the capabilities that let it act as its owner -
// reading and sending messages, which the owner can already do by hand -
// and nothing else until an administrator grants more. The grants an
// administrator gives are recorded on the workflow and are checked on every
// action it performs.

const store = require('./store');
const engine = require('./engine');
const actions = require('./actions');
const triggers = require('./triggers');
const packages = require('../extensions/packages');
const capabilities = require('../extensions/capabilities');
const audit = require('../extensions/audit');

function fail(message, code) {
  const e = new Error(message);
  e.code = code || 'VALIDATION_ERROR';
  throw e;
}

/**
 * Validate a workflow definition.
 *
 * The steps are checked against the action catalogue here, so a workflow
 * that names an action that does not exist is refused when it is saved
 * rather than halfway through a run.
 */
function validateDefinition(definition) {
  const name = String(definition.name || '').trim();
  if (!name || name.length > 128) fail('a workflow needs a name of 1 to 128 characters');

  const trigger = definition.trigger || { type: 'manual' };
  const type = String(trigger.type || 'manual').trim().toLowerCase();
  if (!['manual', 'event', 'schedule'].includes(type)) fail('unknown trigger type: ' + type);
  if (type === 'event') {
    const event = String(trigger.event || '').trim();
    if (!triggers.isKnown(event)) fail('"' + event + '" is not an event this instance publishes');
    trigger.event = triggers.normalise(event);
  }
  if (type === 'schedule') {
    const everyMs = Number(trigger.everyMs);
    if (!Number.isFinite(everyMs) || everyMs < 60000) fail('a schedule may not run more often than once a minute');
    trigger.everyMs = Math.floor(everyMs);
  }

  const steps = packages.normaliseSteps(definition.steps);
  for (const step of steps) {
    if (step.type === 'action' && !actions.isKnown(step.action)) {
      fail('there is no action called "' + step.action + '"');
    }
    if (step.type === 'code') {
      fail('a step that runs extension code may only be part of an extension');
    }
  }

  const limits = Object.assign({}, store.DEFAULT_LIMITS);
  for (const key of Object.keys(limits)) {
    const n = Number((definition.limits || {})[key]);
    if (Number.isFinite(n) && n > 0) limits[key] = Math.floor(n);
  }

  const onError = String(definition.onError || 'stop').trim().toLowerCase();
  if (!['stop', 'continue'].includes(onError)) fail('onError must be "stop" or "continue"');

  return {
    name,
    description: definition.description ? String(definition.description).slice(0, 2000) : null,
    trigger,
    conditions: packages.normaliseConditions(definition.conditions),
    steps,
    limits,
    onError,
  };
}

/**
 * The capabilities a workflow may use without an operator granting them.
 *
 * A workflow owned by an ordinary member runs as that member, so it may do
 * what the member could do by hand. Anything beyond that waits for an
 * administrator.
 */
function requestedGrants(definition) {
  const asked = Array.isArray(definition.grants) ? definition.grants : [];
  const granted = [];
  const refused = [];
  for (const raw of asked) {
    const id = String(raw || '').trim();
    if (!id) continue;
    if (!engine.SELF_SERVICE.includes(id)) {
      refused.push({ capability: id, reason: 'an administrator has to grant this capability' });
      continue;
    }
    granted.push(id);
  }
  return { granted: [...new Set(granted)], refused };
}

/**
 * Create a workflow.
 *
 * @param {object} definition
 * @param {string} ownerId
 * @param {object} [options]
 * @param {boolean} [options.asAdmin] an administrator may grant capabilities
 */
async function create(definition, ownerId, options = {}) {
  const validated = validateDefinition(definition);
  const grants = options.asAdmin
    ? { granted: (definition.grants || []).map(String), refused: [] }
    : requestedGrants(definition);

  const workflow = await store.insertWorkflow(Object.assign({}, validated, {
    ownerId,
    state: 'active',
    version: 1,
    grants: grants.granted,
    source: 'user',
    extensionId: null,
  }));

  await audit.record(
    ownerId,
    audit.ACTIONS.WORKFLOW_CREATED,
    'workflow',
    workflow.id,
    workflow.name + (grants.refused.length ? ' (waiting for an administrator to grant: ' + grants.refused.map((r) => r.capability).join(', ') + ')' : '')
  );
  return { workflow, grants };
}

/**
 * Change a workflow.
 *
 * The version goes up, and the definition that a run records is the one that
 * was in force when the run started, so the history stays readable after the
 * workflow has been changed.
 */
async function update(workflowId, definition, actorId, options = {}) {
  const existing = await store.getWorkflow(workflowId);
  if (!existing) fail('that workflow does not exist');
  const validated = validateDefinition(definition);

  const grants = options.asAdmin
    ? { granted: (definition.grants || []).map(String), refused: [] }
    : requestedGrants(definition);
  const kept = options.asAdmin ? grants.granted : (definition.grants === undefined ? existing.grants : grants.granted);

  const updated = await store.updateWorkflow(workflowId, Object.assign({}, validated, {
    grants: kept,
    version: (existing.version || 1) + 1,
    nextRunAt: null,
  }));
  await audit.record(actorId, audit.ACTIONS.WORKFLOW_UPDATED, 'workflow', workflowId, 'version ' + updated.version);
  return { workflow: updated, grants };
}

/** Pause a workflow. It stops being woken; its history stays. */
async function pause(workflowId, actorId) {
  const workflow = await store.getWorkflow(workflowId);
  if (!workflow) fail('that workflow does not exist');
  await store.setWorkflowState(workflowId, 'paused');
  await audit.record(actorId, audit.ACTIONS.WORKFLOW_PAUSED, 'workflow', workflowId, workflow.name);
  return store.getWorkflow(workflowId);
}

/** Let a workflow be woken again. */
async function resume(workflowId, actorId) {
  const workflow = await store.getWorkflow(workflowId);
  if (!workflow) fail('that workflow does not exist');
  await store.setWorkflowState(workflowId, 'active');
  await audit.record(actorId, audit.ACTIONS.WORKFLOW_RESUMED, 'workflow', workflowId, workflow.name);
  return store.getWorkflow(workflowId);
}

/**
 * Grant a capability to a workflow.
 *
 * An administrator's decision, recorded in the audit trail and in the
 * workflow's own grant list.
 */
async function grant(workflowId, capability, actorId, reason) {
  const workflow = await store.getWorkflow(workflowId);
  if (!workflow) fail('that workflow does not exist');
  const id = String(capability || '').trim();
  if (!capabilities.isKnown(id)) fail('"' + id + '" is not a capability this instance knows');
  const grants = new Set(workflow.grants || []);
  grants.add(id);
  await store.setWorkflowGrants(workflowId, [...grants]);
  await audit.record(actorId, audit.ACTIONS.CAPABILITY_GRANTED, 'workflow', workflowId, id + (reason ? ': ' + reason : ''));
  return store.getWorkflow(workflowId);
}

/** Take a capability back from a workflow. */
async function revoke(workflowId, capability, actorId, reason) {
  const workflow = await store.getWorkflow(workflowId);
  if (!workflow) fail('that workflow does not exist');
  const id = String(capability || '').trim();
  const grants = new Set(workflow.grants || []);
  if (!grants.delete(id)) fail('the workflow does not hold "' + id + '"');
  await store.setWorkflowGrants(workflowId, [...grants]);
  await audit.record(actorId, audit.ACTIONS.CAPABILITY_REVOKED, 'workflow', workflowId, id + (reason ? ': ' + reason : ''));
  return store.getWorkflow(workflowId);
}

/**
 * Run a workflow now.
 *
 * @param {object} options
 * @param {string} options.workflowId
 * @param {object} [options.payload]  the values the conditions and
 *                                     placeholders read
 * @param {boolean} [options.dryRun]
 * @param {string} [options.idempotencyKey]
 */
async function runNow(options) {
  const workflow = await store.getWorkflow(options.workflowId);
  if (!workflow) fail('that workflow does not exist');
  const result = await engine.run({
    workflow,
    trigger: { type: 'manual' },
    payload: options.payload || {},
    dryRun: !!options.dryRun,
    idempotencyKey: options.idempotencyKey || null,
  });
  await audit.record(
    options.actorId,
    audit.ACTIONS.WORKFLOW_RUN,
    'workflow',
    workflow.id,
    (options.dryRun ? 'dry run' : 'run') + ': ' + result.status + (result.reason ? ' (' + result.reason + ')' : '')
  );
  return result;
}

/**
 * Report what a run would do, without doing it.
 *
 * The conditions are evaluated and the steps are described, but nothing is
 * executed: no message is posted, no capability is spent.
 */
async function dryRun(options) {
  const workflow = await store.getWorkflow(options.workflowId);
  if (!workflow) fail('that workflow does not exist');
  const result = await engine.run({
    workflow,
    trigger: { type: 'manual' },
    payload: options.payload || {},
    dryRun: true,
    idempotencyKey: options.idempotencyKey || null,
  });
  const steps = await store.listSteps(result.id);
  return {
    run: result,
    plan: steps.map((step) => ({
      index: step.index,
      type: step.type,
      action: step.action,
      capability: step.capability,
      status: step.status,
      description: step.output && step.output.description ? step.output.description : null,
    })),
  };
}

/** The run history of a workflow, newest first. */
async function history(workflowId, limit) {
  const runs = await store.listRuns({ workflowId, limit });
  return runs;
}

/** One run, with its steps. */
async function runDetail(runId) {
  const run = await store.getRun(runId);
  if (!run) return null;
  const steps = await store.listSteps(runId);
  return { run, steps };
}

/** One workflow, with its definition in the shape the API reports. */
async function get(workflowId) {
  return store.getWorkflow(workflowId);
}

/** The workflows a person may see: their own, plus the ones an extension owns. */
async function listVisible(ownerId, isAdmin) {
  const own = await store.listWorkflows({ ownerId });
  if (isAdmin) return store.listWorkflows({});
  const extensionOwned = await store.listWorkflows({ source: 'extension' });
  const seen = new Set(own.map((w) => w.id));
  return own.concat(extensionOwned.filter((w) => !seen.has(w.id)));
}

/**
 * Whether a person may act on a workflow.
 *
 * The owner may, and so may an administrator. Everybody else may not.
 */
function mayManage(workflow, userId, isAdmin) {
  if (!workflow) return false;
  if (isAdmin) return true;
  return workflow.ownerId === userId;
}

module.exports = {
  get,
  create,
  update,
  pause,
  resume,
  grant,
  revoke,
  runNow,
  dryRun,
  history,
  runDetail,
  listVisible,
  mayManage,
  validateDefinition,
  requestedGrants,
  fail,
};
