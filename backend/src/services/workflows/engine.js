// The workflow engine.
//
// A run is: create the record, check the conditions, walk the steps, record
// what each one did. The rules that make it safe to let a workflow act on an
// instance are enforced here rather than in the steps:
//
//   * A run holds a capability grant set, and every action is checked against
//     it before the action runs.
//   * A workflow is never woken by its own output. The origin marker that
//     travels with an event says which run produced it, and a workflow whose
//     id matches is skipped. The hop budget is the second line of defence
//     for a cycle that goes through several workflows.
//   * A run has a key derived from its trigger, so a retried trigger resolves
//     to the run that already happened instead of doing the work twice.
//   * A run is bounded: a deadline, a number of runs per window, a number of
//     child runs, and a number of steps.
//   * A step that fails is recorded as failed, with the reason. A run that
//     had a failing step is never reported as succeeded.

const crypto = require('crypto');
const db = require('../../db');
const { now, uuid } = require('../../util');
const store = require('./store');
const conditions = require('./conditions');
const actions = require('./actions');
const triggers = require('./triggers');
const extensionStore = require('../extensions/store');
const signature = require('../extensions/signature');
const sandbox = require('../extensions/sandbox');
const bridge = require('../extensions/bridge');

// How many workflows one event may wake. A broadcast that wakes two hundred
// workflows is a broadcast nobody asked for.
const MAX_DISPATCH = 20;

// The capabilities a workflow may use without an operator granting them.
// A workflow owned by an ordinary member runs as that member: it can do what
// the member could do by hand, and nothing else. Every other capability has
// to be granted by the operator.
const SELF_SERVICE = ['messages.read', 'messages.write'];

function budgetError(limit) {
  const e = new Error('the run used its whole budget of ' + limit + ' calls');
  e.code = 'BUDGET_EXCEEDED';
  return e;
}

/**
 * The capabilities a workflow may use.
 *
 * A workflow that belongs to an extension runs with the extension's grants,
 * read live: revoking a capability from the extension takes effect on the
 * next call. A workflow owned by a person runs with the grants recorded on
 * it, which the operator can amend.
 */
async function effectiveGrants(workflow) {
  if (workflow.extensionId) {
    const extension = await extensionStore.getExtension(workflow.extensionId);
    if (!extension || extension.state === 'removed') return new Set();
    return extensionStore.grantSet(workflow.extensionId);
  }
  return new Set(workflow.grants || []);
}

/** The key that makes a run idempotent. */
function runKey(workflowId, triggerType, triggerEvent, idempotencyKey) {
  return crypto.createHash('sha256')
    .update([workflowId, triggerType || '', triggerEvent || '', idempotencyKey || ''].join('|'))
    .digest('hex')
    .slice(0, 32);
}

/**
 * The key that identifies an event.
 *
 * An event that carries an id is identified by it. An event without one is
 * identified by what it contains, which means the same event published twice
 * is the same event - the run happens once. Two genuinely different
 * occurrences of the same thing need different ids.
 */
function eventKey(payload) {
  if (payload && typeof payload.id === 'string' && payload.id.trim()) return payload.id.trim().slice(0, 64);
  const canonical = JSON.stringify(signature.canonicalise(payload || {}));
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

function makeBudget(limit) {
  return {
    limit,
    used: 0,
    consume() {
      if (this.used >= this.limit) throw budgetError(this.limit);
      this.used += 1;
      return this.used;
    },
  };
}

// ---- running --------------------------------------------------------------

/**
 * Walk the steps of a run.
 *
 * @param {object} workflow
 * @param {object} run       the run record
 * @param {object} values    the values the conditions and placeholders read
 * @param {number} startIndex the step to start at (a resumed run starts after
 *                            the approval that was given)
 */
async function executeSteps(workflow, run, values, startIndex) {
  const grants = await effectiveGrants(workflow);
  const budget = makeBudget(workflow.limits.maxSteps * 4);
  const deadline = Date.now() + workflow.limits.maxDurationMs;
  const childRuns = { count: 0, limit: workflow.limits.maxFanout };
  let failed = false;

  const ctx = {
    grants,
    budget,
    dryRun: !!run.dryRun,
    runKey: run.runKey,
    ownerId: workflow.ownerId,
    workflowId: workflow.id,
    workflowName: workflow.name,
    extensionId: workflow.extensionId,
    values,
    deadline,
    holderName: 'the workflow',
    // A step that produces an event carries the origin marker with it, so
    // the workflow that produced it is not woken by its own output. The
    // dispatch is not waited for: a workflow must not be able to make its
    // own step wait on the workflow it just woke.
    publish: (type, payload) => {
      const promise = publish(type, payload, {
        origin: { workflowId: workflow.id, runId: run.id, depth: run.depth },
        await: false,
      });
      promise.catch((e) => {
        console.warn('[workflows] a published event could not be dispatched: ' + String((e && e.message) || e));
      });
      return promise;
    },
    startChild: async (childWorkflowId, childPayload) => {
      if (childRuns.count >= childRuns.limit) {
        throw new Error('the run reached its limit of ' + childRuns.limit + ' child runs');
      }
      childRuns.count += 1;
      return startChildRun(workflow, run, childWorkflowId, childPayload, grants, childRuns.count);
    },
  };

  for (let index = startIndex; index < workflow.steps.length; index++) {
    if (Date.now() > deadline) {
      await store.finishRun(run.id, 'failed', 'the run exceeded its ' + workflow.limits.maxDurationMs + 'ms limit',
        Date.now() - new Date(run.startedAt).getTime());
      return { status: 'failed', reason: 'the run exceeded its time limit' };
    }

    const step = workflow.steps[index];

    if (step.type === 'approval') {
      const record = await store.insertStep({
        id: uuid(),
        runId: run.id,
        index,
        type: 'approval',
        params: step,
        status: 'awaiting_approval',
        startedAt: now(),
      });
      await store.finishRun(run.id, 'awaiting_approval', 'waiting for an approval', null);
      return {
        status: 'awaiting_approval',
        reason: 'waiting for an approval',
        stepId: record.id,
        stepIndex: index,
      };
    }

    if (step.type === 'code') {
      const outcome = await runCodeStep(workflow, run, step, index, ctx);
      if (outcome.failed) {
        failed = true;
        if (workflow.onError !== 'continue') {
          await store.finishRun(run.id, 'failed', outcome.reason, Date.now() - new Date(run.startedAt).getTime());
          return { status: 'failed', reason: outcome.reason };
        }
      }
      continue;
    }

    const params = conditions.resolveParams(step.params || {}, values);
    const action = actions.ACTIONS[step.action];
    const capability = action ? action.capability : null;
    const record = await store.insertStep({
      id: uuid(),
      runId: run.id,
      index,
      type: 'action',
      action: step.action,
      params,
      capability,
      status: run.dryRun ? 'planned' : 'running',
      startedAt: now(),
    });

    if (run.dryRun) {
      // A dry run reports what would happen and does nothing. The action is
      // not executed, so the outcome recorded is the plan, not a result.
      const plan = { dryRun: true, action: step.action, capability, description: action ? action.description : null };
      await store.updateStep(record.id, { status: 'planned', output: plan, finishedAt: now(), durationMs: 0 });
      values.steps[index] = { output: plan };
      continue;
    }

    const startedAt = Date.now();
    try {
      const output = await actions.execute(step.action, params, Object.assign({}, ctx, { stepIndex: index }));
      await store.updateStep(record.id, {
        status: 'succeeded',
        output,
        finishedAt: now(),
        durationMs: Date.now() - startedAt,
      });
      values.steps[index] = { output };
    } catch (e) {
      const reason = String((e && e.message) || e);
      await store.updateStep(record.id, {
        status: 'failed',
        error: reason,
        finishedAt: now(),
        durationMs: Date.now() - startedAt,
      });
      values.steps[index] = { error: reason };
      failed = true;
      if (workflow.onError !== 'continue') {
        await store.finishRun(run.id, 'failed', reason, Date.now() - new Date(run.startedAt).getTime());
        return { status: 'failed', reason };
      }
    }
  }

  const duration = Date.now() - new Date(run.startedAt).getTime();
  if (failed) {
    // A run that had a failing step and was told to carry on is not a
    // success. It is reported as partial, which is a different thing.
    await store.finishRun(run.id, 'partial', 'one or more steps failed', duration);
    return { status: 'partial', reason: 'one or more steps failed' };
  }
  await store.finishRun(run.id, 'succeeded', null, duration);
  return { status: 'succeeded', reason: null };
}

/**
 * Run a trusted extension's own code as a step.
 *
 * The code runs in the sandbox, and every call it makes is checked against
 * the extension's grants on the way in.
 */
async function runCodeStep(workflow, run, step, index, ctx) {
  const startedAt = Date.now();
  if (!workflow.extensionId) {
    const reason = 'this step runs extension code, and the workflow does not belong to an extension';
    await store.insertStep({
      id: uuid(), runId: run.id, index, type: 'code', params: step, status: 'failed',
      error: reason, startedAt: now(), finishedAt: now(), durationMs: 0,
    });
    return { failed: true, reason };
  }
  const extension = await extensionStore.getExtension(workflow.extensionId);
  const version = extension ? await extensionStore.getVersion(workflow.extensionId, extension.version) : null;
  const code = version ? version.entryCode : null;
  if (!code) {
    const reason = 'the extension does not carry server-side code';
    await store.insertStep({
      id: uuid(), runId: run.id, index, type: 'code', params: step, status: 'failed',
      error: reason, startedAt: now(), finishedAt: now(), durationMs: 0,
    });
    return { failed: true, reason };
  }

  const record = await store.insertStep({
    id: uuid(), runId: run.id, index, type: 'code', params: step, status: 'running', startedAt: now(),
  });
  const host = bridge.createHost({
    grants: ctx.grants,
    budget: ctx.budget,
    ctx: Object.assign({}, ctx, { stepIndex: index }),
  });
  const result = await sandbox.run({
    code,
    host,
    limits: {
      timeoutMs: Math.min(workflow.limits.maxDurationMs, 10000),
      callBudget: ctx.budget.limit,
    },
  });
  if (!result.ok) {
    const reason = result.error || 'the extension code failed';
    await store.updateStep(record.id, {
      status: 'failed', error: reason, finishedAt: now(), durationMs: Date.now() - startedAt,
    });
    return { failed: true, reason };
  }
  await store.updateStep(record.id, {
    status: 'succeeded', output: result.output, finishedAt: now(), durationMs: Date.now() - startedAt,
  });
  return { failed: false, reason: null };
}

/**
 * Prepare a run: the checks that have to happen before anything is written,
 * and the run record itself.
 *
 * Split from the execution so a dispatcher can start a run and carry on
 * without waiting for it, and so the run's identity exists before the first
 * step runs.
 */
async function prepareRun(options) {
  const workflow = options.workflow;
  const trigger = options.trigger || { type: 'manual' };
  const payload = options.payload || {};
  const dryRun = !!options.dryRun;
  const origin = options.origin || null;
  const depth = origin ? Number(origin.depth || 0) + 1 : 0;

  if (!workflow) return { refused: { status: 'missing', reason: 'the workflow does not exist' } };
  if (workflow.state !== 'active') {
    return { refused: { status: 'skipped', reason: 'the workflow is ' + workflow.state } };
  }

  // The run budget. A workflow that is being triggered far too often is
  // stopped before it does anything, and the refusal is reported to the
  // caller rather than recorded as a run: nothing happened, so there is
  // nothing to record.
  const windowStart = new Date(Date.now() - workflow.limits.windowMinutes * 60 * 1000).toISOString();
  const used = await store.countRunsSince(workflow.id, windowStart);
  if (used >= workflow.limits.maxRunsPerWindow) {
    return {
      refused: {
        status: 'refused',
        reason: 'the workflow reached its limit of ' + workflow.limits.maxRunsPerWindow +
          ' runs in ' + workflow.limits.windowMinutes + ' minutes',
      },
    };
  }

  const idempotencyKey = options.idempotencyKey !== undefined && options.idempotencyKey !== null
    ? String(options.idempotencyKey)
    : (trigger.type === 'event' ? eventKey(payload) : uuid());
  const key = runKey(workflow.id, trigger.type, trigger.event, idempotencyKey);

  const existing = await store.findRunByKey(workflow.id, key);
  if (existing) {
    // The same trigger, already handled. The run that happened is the
    // answer; doing it again would post twice.
    return { duplicate: true, run: Object.assign({}, existing, { duplicate: true }) };
  }

  let record;
  try {
    record = await store.insertRun({
      id: uuid(),
      workflowId: workflow.id,
      runKey: key,
      version: workflow.version,
      triggerType: trigger.type,
      triggerEvent: trigger.event || null,
      payload,
      definition: {
        name: workflow.name,
        trigger: workflow.trigger,
        conditions: workflow.conditions,
        steps: workflow.steps,
        grants: workflow.grants,
        limits: workflow.limits,
        onError: workflow.onError,
      },
      status: 'running',
      depth,
      originWorkflowId: origin ? origin.workflowId : null,
      originRunId: origin ? origin.runId : null,
      dryRun,
      startedAt: now(),
    });
  } catch (e) {
    // A concurrent run with the same key won the race.
    if (!/unique/i.test(String((e && e.message) || e))) throw e;
    const again = await store.findRunByKey(workflow.id, key);
    if (!again) throw e;
    return { duplicate: true, run: Object.assign({}, again, { duplicate: true }) };
  }

  return { run: record, workflow, trigger, payload, dryRun, origin, depth };
}

/** Execute a prepared run: the conditions, then the steps. */
async function executePrepared(prepared) {
  const { run, workflow, trigger, payload } = prepared;
  const values = buildValues(workflow, run, payload, trigger);
  const conditionResult = conditions.evaluate(workflow.conditions, values);
  if (!conditionResult.ok) {
    await store.finishRun(run.id, 'skipped', conditionResult.reason, 0);
    await store.markWorkflowRun(workflow.id, now());
    return Object.assign({}, await store.getRun(run.id), { skipped: true });
  }

  await store.markWorkflowRun(workflow.id, now());
  const outcome = await executeSteps(workflow, run, values, 0);
  return Object.assign({}, await store.getRun(run.id), { outcome });
}

/**
 * Start a workflow and wait for it.
 *
 * @param {object} options
 * @param {object} options.workflow        the workflow
 * @param {object} options.trigger         { type, event }
 * @param {object} [options.payload]       the event payload
 * @param {object} [options.origin]        { workflowId, runId, depth }
 * @param {boolean} [options.dryRun]
 * @param {string} [options.idempotencyKey]
 * @returns {Promise<object>} the finished run
 */
async function run(options) {
  const prepared = await prepareRun(options);
  if (prepared.duplicate) return prepared.run;
  if (prepared.refused) return prepared.refused;
  return executePrepared(prepared);
}

function buildValues(workflow, runRecord, payload, trigger) {
  return {
    ...payload,
    event: payload,
    trigger,
    workflow: { id: workflow.id, name: workflow.name, version: workflow.version },
    run: { id: runRecord.id, key: runRecord.runKey, depth: runRecord.depth },
    steps: [],
  };
}

/**
 * Start a run without necessarily waiting for it.
 *
 * The event dispatcher uses this: a workflow that is woken by an event must
 * not hold up whatever produced the event. The run record exists before the
 * first step runs, so the caller has its id either way.
 */
async function startRun(options) {
  const prepared = await prepareRun(options);
  if (prepared.duplicate) {
    return { record: prepared.run, promise: Promise.resolve(prepared.run) };
  }
  if (prepared.refused) {
    return { record: Object.assign({ id: null }, prepared.refused), promise: Promise.resolve(prepared.refused) };
  }
  const promise = executePrepared(prepared).catch((e) => {
    console.error('[workflows] a run failed: ' + String((e && e.stack) || e));
    return { status: 'failed', reason: String((e && e.message) || e) };
  });
  if (options.await === false) return { record: prepared.run, promise };
  const finished = await promise;
  return { record: finished, promise: Promise.resolve(finished) };
}

// ---- dispatching ----------------------------------------------------------

/**
 * Publish an event into the engine.
 *
 * @param {string} type    the event name, in either vocabulary
 * @param {object} payload the event payload
 * @param {object} [options]
 * @param {object} [options.origin] { workflowId, runId, depth }
 * @param {boolean} [options.await] wait for the runs to finish
 */
async function publish(type, payload, options = {}) {
  const name = triggers.normalise(type);
  if (!name) return { event: null, dispatched: [], ignored: 'unknown event: ' + type };

  const candidates = await store.listEventWorkflows(name);
  const origin = options.origin || null;
  const dispatched = [];

  for (const workflow of candidates) {
    if (dispatched.length >= MAX_DISPATCH) {
      dispatched.push({ workflowId: null, status: 'skipped', reason: 'the event woke too many workflows' });
      break;
    }

    // Loop prevention, first line: a workflow is never woken by its own
    // output.
    if (origin && origin.workflowId === workflow.id) {
      const reason = 'the workflow is not woken by its own output';
      await recordSkipped(workflow, name, payload, origin, reason);
      dispatched.push({ workflowId: workflow.id, status: 'skipped', reason });
      continue;
    }

    // Loop prevention, second line: a chain of workflows may not be longer
    // than the hop budget.
    const depth = origin ? Number(origin.depth || 0) + 1 : 0;
    if (origin && depth > workflow.limits.maxDepth) {
      const reason = 'the hop budget of ' + workflow.limits.maxDepth + ' was exhausted';
      await recordSkipped(workflow, name, payload, origin, reason);
      dispatched.push({ workflowId: workflow.id, status: 'skipped', reason });
      continue;
    }

    const started = await startRun({
      workflow,
      trigger: { type: 'event', event: name },
      payload,
      origin,
      idempotencyKey: eventKey(payload),
      await: options.await !== false,
    });
    dispatched.push({
      workflowId: workflow.id,
      runId: started.record ? started.record.id : null,
      status: started.record ? started.record.status : 'unknown',
      reason: started.record ? started.record.reason || null : null,
    });
  }

  if (options.await !== false) {
    for (const entry of dispatched) {
      if (entry.runId) {
        const finished = await store.getRun(entry.runId);
        if (finished) {
          entry.status = finished.status;
          entry.reason = finished.reason || null;
        }
      }
    }
  }

  return { event: name, dispatched };
}

// A dispatch that was refused is recorded, so the history shows that the
// engine saw the event and decided not to act on it.
async function recordSkipped(workflow, eventName, payload, origin, reason) {
  const key = runKey(workflow.id, 'event', eventName, eventKey(payload));
  const existing = await store.findRunByKey(workflow.id, key);
  if (existing) return existing;
  const record = await store.insertRun({
    id: uuid(),
    workflowId: workflow.id,
    runKey: key,
    version: workflow.version,
    triggerType: 'event',
    triggerEvent: eventName,
    payload,
    definition: { name: workflow.name, steps: workflow.steps },
    status: 'skipped',
    reason,
    depth: origin ? Number(origin.depth || 0) + 1 : 0,
    originWorkflowId: origin ? origin.workflowId : null,
    originRunId: origin ? origin.runId : null,
    dryRun: false,
    startedAt: now(),
  }).catch(() => null);
  return record;
}

// ---- child runs -----------------------------------------------------------

/**
 * Start another workflow from inside a run.
 *
 * The child may not have more capabilities than its parent: a workflow that
 * can start another workflow must not be able to lend it a capability the
 * parent does not have.
 */
async function startChildRun(parentWorkflow, parentRun, childWorkflowId, payload, parentGrants, index) {
  const child = await store.getWorkflow(childWorkflowId);
  if (!child) throw new Error('there is no workflow called ' + childWorkflowId);
  if (child.state !== 'active') throw new Error('the workflow ' + childWorkflowId + ' is ' + child.state);

  const childGrants = await effectiveGrants(child);
  for (const capability of childGrants) {
    if (!parentGrants.has(capability)) {
      throw new Error(
        'the workflow ' + childWorkflowId + ' needs the capability "' + capability +
        '", which the run that started it does not have'
      );
    }
  }

  const childKey = runKey(child.id, 'child', null, parentRun.runKey + ':' + index);
  const existing = await store.findRunByKey(child.id, childKey);
  if (existing) return { runId: existing.id, status: existing.status };

  const result = await run({
    workflow: child,
    trigger: { type: 'child', event: parentWorkflow.id },
    payload: payload || {},
    origin: { workflowId: parentWorkflow.id, runId: parentRun.id, depth: parentRun.depth },
    idempotencyKey: parentRun.runKey + ':' + index,
  });
  return { runId: result.id, status: result.status };
}

// ---- approvals ------------------------------------------------------------

/**
 * Give or refuse an approval a run is waiting for.
 *
 * @param {string} runId
 * @param {object} decision { approved: boolean, comment: string }
 * @param {string} actorId
 * @param {function} isAdmin  (userId) => Promise<boolean>
 */
async function decideApproval(runId, decision, actorId, isAdmin) {
  const run = await store.getRun(runId);
  if (!run) return { ok: false, reason: 'the run does not exist' };
  if (run.status !== 'awaiting_approval') {
    return { ok: false, reason: 'the run is not waiting for an approval' };
  }
  const steps = await store.listSteps(runId);
  const waiting = steps.find((s) => s.status === 'awaiting_approval');
  if (!waiting) return { ok: false, reason: 'the run is not waiting for an approval' };

  const definition = run.definition || {};
  const stepDefinition = (definition.steps || [])[waiting.index] || {};
  const approvers = stepDefinition.approvers || [];
  if (approvers.length && !approvers.includes('admin')) {
    if (!approvers.includes(actorId)) {
      return { ok: false, reason: 'this approval belongs to somebody else' };
    }
  } else if (!(await isAdmin(actorId))) {
    return { ok: false, reason: 'this approval needs an administrator' };
  }

  const workflow = await store.getWorkflow(run.workflowId);
  if (!workflow) return { ok: false, reason: 'the workflow does not exist' };

  if (!decision.approved) {
    await store.updateStep(waiting.id, {
      status: 'rejected',
      error: decision.comment || 'the approval was refused',
      finishedAt: now(),
      durationMs: 0,
    });
    await store.finishRun(runId, 'cancelled', decision.comment || 'the approval was refused', null);
    return { ok: true, status: 'cancelled' };
  }

  await store.updateStep(waiting.id, {
    status: 'succeeded',
    output: { approvedBy: actorId, comment: decision.comment || null },
    finishedAt: now(),
    durationMs: 0,
  });

  // Carry on from the step after the approval, with the outputs of the steps
  // that already ran.
  const values = buildValues(workflow, run, run.payload || {}, { type: run.triggerType, event: run.triggerEvent });
  for (const step of steps) {
    if (step.index >= waiting.index) continue;
    values.steps[step.index] = { output: step.output, error: step.error };
  }
  const outcome = await executeSteps(workflow, run, values, waiting.index + 1);
  return { ok: true, status: outcome.status };
}

module.exports = {
  SELF_SERVICE,
  MAX_DISPATCH,
  run,
  startRun,
  publish,
  executeSteps,
  effectiveGrants,
  runKey,
  eventKey,
  decideApproval,
  buildValues,
};
