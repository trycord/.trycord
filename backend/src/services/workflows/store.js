// Database access for the workflow surface.
//
// The same shape as the extension store: the rows are described here and the
// rest of the code works with objects.
//
// A workflow's definition is stored as JSON in three columns (the trigger,
// the conditions and the steps) plus two more (the grants and the limits).
// It is read as a whole and written as a whole, and it is versioned as a
// whole, so splitting it into columns would mean a migration every time a
// step type is added.

const db = require('../../db');
const { now, uuid } = require('../../util');
const store = require('../extensions/store');

const DEFAULT_LIMITS = {
  maxRunsPerWindow: 30,
  windowMinutes: 60,
  maxDurationMs: 30000,
  maxFanout: 5,
  maxDepth: 3,
  maxSteps: 50,
};

function parseJson(value, fallback) {
  return store.parseJson(value, fallback);
}

function limitsShape(value) {
  const parsed = parseJson(value, {});
  const limits = Object.assign({}, DEFAULT_LIMITS);
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    const n = Number(parsed[key]);
    if (Number.isFinite(n) && n > 0) limits[key] = Math.floor(n);
  }
  return limits;
}

function workflowShape(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description || null,
    ownerId: row.owner_id,
    state: row.state,
    version: Number(row.version || 1),
    trigger: parseJson(row.trigger, { type: 'manual' }),
    conditions: parseJson(row.conditions, []),
    steps: parseJson(row.steps, []),
    grants: parseJson(row.grants, []),
    limits: limitsShape(row.limits),
    onError: row.on_error,
    source: row.source,
    extensionId: row.extension_id || null,
    nextRunAt: row.next_run_at || null,
    lastRunAt: row.last_run_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getWorkflow(id) {
  const row = await db.get('SELECT * FROM workflows WHERE id = ?', [id]);
  return workflowShape(row);
}

async function listWorkflows(filter = {}) {
  const clauses = [];
  const params = [];
  if (filter.ownerId) {
    clauses.push('owner_id = ?');
    params.push(filter.ownerId);
  }
  if (filter.extensionId) {
    clauses.push('extension_id = ?');
    params.push(filter.extensionId);
  }
  if (filter.state) {
    clauses.push('state = ?');
    params.push(filter.state);
  }
  if (filter.event) {
    clauses.push('`trigger` LIKE ?');
    params.push('%"event":"' + filter.event + '"%');
  }
  const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
  const rows = await db.all('SELECT * FROM workflows' + where + ' ORDER BY created_at DESC', params);
  return rows.map(workflowShape);
}

// The workflows a given event wakes. The trigger column holds the event
// name, and the match is done on the column rather than by reading every
// workflow and parsing it, because the set of workflows is small but the
// event rate is not.
async function listEventWorkflows(eventName) {
  const rows = await db.all(
    "SELECT * FROM workflows WHERE state = 'active' AND `trigger` LIKE ?",
    ['%"event":"' + eventName + '"%']
  );
  return rows.map(workflowShape).filter((w) => w.trigger && w.trigger.type === 'event' && w.trigger.event === eventName);
}

async function insertWorkflow(definition) {
  const id = definition.id || uuid();
  const ts = now();
  await db.run(
    'INSERT INTO workflows (id, name, description, owner_id, state, version, `trigger`, conditions, steps, ' +
    'grants, limits, on_error, source, extension_id, next_run_at, last_run_at, created_at, updated_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      id, definition.name, definition.description || null, definition.ownerId, definition.state || 'active',
      definition.version || 1, JSON.stringify(definition.trigger || { type: 'manual' }),
      JSON.stringify(definition.conditions || []), JSON.stringify(definition.steps || []),
      JSON.stringify(definition.grants || []), JSON.stringify(definition.limits || DEFAULT_LIMITS),
      definition.onError || 'stop', definition.source || 'user', definition.extensionId || null,
      definition.nextRunAt || null, null, ts, ts,
    ]
  );
  return getWorkflow(id);
}

async function updateWorkflow(id, definition) {
  await db.run(
    'UPDATE workflows SET name = ?, description = ?, `trigger` = ?, conditions = ?, steps = ?, grants = ?, ' +
    'limits = ?, on_error = ?, version = ?, next_run_at = ?, updated_at = ? WHERE id = ?',
    [
      definition.name, definition.description || null, JSON.stringify(definition.trigger || { type: 'manual' }),
      JSON.stringify(definition.conditions || []), JSON.stringify(definition.steps || []),
      JSON.stringify(definition.grants || []), JSON.stringify(definition.limits || DEFAULT_LIMITS),
      definition.onError || 'stop', definition.version, definition.nextRunAt || null, now(), id,
    ]
  );
  return getWorkflow(id);
}

async function setWorkflowState(id, state) {
  await db.run('UPDATE workflows SET state = ?, updated_at = ? WHERE id = ?', [state, now(), id]);
}

async function setWorkflowGrants(id, grants) {
  await db.run('UPDATE workflows SET grants = ?, updated_at = ? WHERE id = ?', [JSON.stringify(grants), now(), id]);
}

async function markWorkflowRun(id, at) {
  await db.run('UPDATE workflows SET last_run_at = ?, updated_at = ? WHERE id = ?', [at, now(), id]);
}

async function setNextRun(id, at) {
  await db.run('UPDATE workflows SET next_run_at = ?, updated_at = ? WHERE id = ?', [at, now(), id]);
}

// ---- runs -----------------------------------------------------------------

function runShape(row) {
  if (!row) return null;
  return {
    id: row.id,
    workflowId: row.workflow_id,
    runKey: row.run_key,
    version: Number(row.version || 1),
    triggerType: row.trigger_type,
    triggerEvent: row.trigger_event || null,
    payload: parseJson(row.payload, null),
    definition: parseJson(row.definition, null),
    status: row.status,
    reason: row.reason || null,
    depth: Number(row.depth || 0),
    originWorkflowId: row.origin_workflow_id || null,
    originRunId: row.origin_run_id || null,
    dryRun: !!row.dry_run,
    startedAt: row.started_at,
    finishedAt: row.finished_at || null,
    durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms),
    createdAt: row.created_at,
  };
}

async function getRun(id) {
  const row = await db.get('SELECT * FROM workflow_runs WHERE id = ?', [id]);
  return runShape(row);
}

async function findRunByKey(workflowId, runKey) {
  const row = await db.get('SELECT * FROM workflow_runs WHERE workflow_id = ? AND run_key = ?', [workflowId, runKey]);
  return runShape(row);
}

async function insertRun(run) {
  await db.run(
    'INSERT INTO workflow_runs (id, workflow_id, run_key, version, trigger_type, trigger_event, payload, ' +
    'definition, status, reason, depth, origin_workflow_id, origin_run_id, dry_run, started_at, created_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      run.id, run.workflowId, run.runKey, run.version, run.triggerType, run.triggerEvent || null,
      run.payload === null || run.payload === undefined ? null : JSON.stringify(run.payload),
      JSON.stringify(run.definition || {}), run.status, run.reason || null, run.depth || 0,
      run.originWorkflowId || null, run.originRunId || null, run.dryRun ? 1 : 0, run.startedAt, now(),
    ]
  );
  return getRun(run.id);
}

async function finishRun(id, status, reason, durationMs) {
  await db.run(
    'UPDATE workflow_runs SET status = ?, reason = ?, finished_at = ?, duration_ms = ? WHERE id = ?',
    [status, reason || null, now(), durationMs === undefined ? null : durationMs, id]
  );
}

async function listRuns(filter = {}) {
  const clauses = [];
  const params = [];
  if (filter.workflowId) {
    clauses.push('workflow_id = ?');
    params.push(filter.workflowId);
  }
  if (filter.status) {
    clauses.push('status = ?');
    params.push(filter.status);
  }
  const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
  const limit = Math.min(Math.max(Number(filter.limit) || 50, 1), 200);
  const rows = await db.all(
    'SELECT * FROM workflow_runs' + where + ' ORDER BY created_at DESC, id DESC LIMIT ' + limit,
    params
  );
  return rows.map(runShape);
}

// How many runs this workflow has had since a point in time. Used for the
// run budget. Skipped runs are not counted: a run that was refused is not
// work the workflow did.
async function countRunsSince(workflowId, since) {
  const row = await db.get(
    "SELECT COUNT(*) AS n FROM workflow_runs WHERE workflow_id = ? AND created_at >= ? AND status != 'skipped'",
    [workflowId, since]
  );
  return row ? Number(row.n) : 0;
}

// ---- steps ----------------------------------------------------------------

function stepShape(row) {
  if (!row) return null;
  return {
    id: row.id,
    runId: row.run_id,
    index: Number(row.step_index),
    type: row.type,
    action: row.action || null,
    params: parseJson(row.params, {}),
    capability: row.capability || null,
    status: row.status,
    output: parseJson(row.output, null),
    error: row.error || null,
    startedAt: row.started_at || null,
    finishedAt: row.finished_at || null,
    durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms),
    createdAt: row.created_at,
  };
}

async function insertStep(step) {
  await db.run(
    'INSERT INTO workflow_run_steps (id, run_id, step_index, type, action, params, capability, status, ' +
    'output, error, started_at, finished_at, duration_ms, created_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      step.id, step.runId, step.index, step.type, step.action || null,
      step.params === undefined ? null : JSON.stringify(step.params), step.capability || null,
      step.status, step.output === undefined ? null : JSON.stringify(step.output), step.error || null,
      step.startedAt || null, step.finishedAt || null,
      step.durationMs === undefined ? null : step.durationMs, now(),
    ]
  );
  return step;
}

async function updateStep(id, patch) {
  const sets = [];
  const values = [];
  if (patch.status !== undefined) {
    sets.push('status = ?');
    values.push(patch.status);
  }
  if (patch.output !== undefined) {
    sets.push('output = ?');
    values.push(JSON.stringify(patch.output));
  }
  if (patch.error !== undefined) {
    sets.push('error = ?');
    values.push(patch.error);
  }
  if (patch.finishedAt !== undefined) {
    sets.push('finished_at = ?');
    values.push(patch.finishedAt);
  }
  if (patch.durationMs !== undefined) {
    sets.push('duration_ms = ?');
    values.push(patch.durationMs);
  }
  if (patch.capability !== undefined) {
    sets.push('capability = ?');
    values.push(patch.capability);
  }
  if (!sets.length) return;
  await db.run('UPDATE workflow_run_steps SET ' + sets.join(', ') + ' WHERE id = ?', values.concat([id]));
}

async function listSteps(runId) {
  const rows = await db.all(
    'SELECT * FROM workflow_run_steps WHERE run_id = ? ORDER BY step_index ASC, created_at ASC',
    [runId]
  );
  return rows.map(stepShape);
}

module.exports = {
  DEFAULT_LIMITS,
  getWorkflow,
  listWorkflows,
  listEventWorkflows,
  insertWorkflow,
  updateWorkflow,
  setWorkflowState,
  setWorkflowGrants,
  markWorkflowRun,
  setNextRun,
  getRun,
  findRunByKey,
  insertRun,
  finishRun,
  listRuns,
  countRunsSince,
  insertStep,
  updateStep,
  listSteps,
  workflowShape,
  runShape,
  stepShape,
};
