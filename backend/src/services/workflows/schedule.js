// Scheduled workflows.
//
// A workflow with a schedule trigger is due at a time the instance keeps on
// the workflow row. The job system asks for the due ones every half minute,
// runs them, and asks again.
//
// The schedule is idempotent: the time the run was due is its run key, so a
// tick that is repeated - a restart, a worker that was slow - runs the
// workflow once.
//
// The job kind is registered by the instance at boot:
//
//   jobs.register('workflow.schedule', workflows.handleScheduleTick, { concurrency: 1 })
//   workflows.startScheduler()
//
// startScheduler() checks that the kind is registered before it enqueues
// anything, so an instance that has not wired it up does not fill its job
// queue with jobs that can only fail.

const db = require('../../db');
const { now } = require('../../util');
const jobs = require('../jobs');
const store = require('./store');
const engine = require('./engine');

const JOB_KIND = 'workflow.schedule';
const TICK_MS = 30000;

function isScheduled(workflow) {
  return workflow.trigger && workflow.trigger.type === 'schedule' && workflow.trigger.everyMs;
}

/** The workflows whose schedule is due. */
async function dueWorkflows() {
  const rows = await db.all(
    "SELECT * FROM workflows WHERE state = 'active' AND trigger LIKE '%\"type\":\"schedule\"%' " +
    'AND (next_run_at IS NULL OR next_run_at <= ?)',
    [now()]
  );
  return rows.map(store.workflowShape).filter(isScheduled);
}

/**
 * Run the schedules that are due.
 *
 * A workflow that has never run has no next run time yet: one is given to
 * it and it waits for the next tick. That way a workflow that was created
 * halfway through a minute does not run immediately.
 */
async function runDueSchedules() {
  const due = await dueWorkflows();
  const results = [];
  for (const workflow of due) {
    if (!workflow.nextRunAt) {
      await store.setNextRun(workflow.id, new Date(Date.now() + workflow.trigger.everyMs).toISOString());
      continue;
    }
    const dueAt = workflow.nextRunAt;
    await store.setNextRun(workflow.id, new Date(Date.now() + workflow.trigger.everyMs).toISOString());
    const result = await engine.run({
      workflow,
      trigger: { type: 'schedule', event: null },
      payload: { scheduledFor: dueAt },
      idempotencyKey: dueAt,
    });
    results.push({ workflowId: workflow.id, runId: result.id || null, status: result.status, reason: result.reason || null });
  }
  return results;
}

/** The job handler. It runs the due schedules and asks for the next tick. */
async function handleScheduleTick() {
  const results = await runDueSchedules();
  await jobs.enqueue(JOB_KIND, {}, { runAfterMs: TICK_MS, maxAttempts: 3 });
  return results;
}

/**
 * Start the scheduler.
 *
 * Does nothing when the job kind has not been registered: the instance has
 * not asked for scheduled workflows, and a queue of jobs that can only fail
 * helps nobody.
 */
async function startScheduler() {
  const stats = await jobs.stats();
  if (!stats.kinds.includes(JOB_KIND)) {
    console.warn('[workflows] the "' + JOB_KIND + '" job kind is not registered, so scheduled workflows will not run');
    return false;
  }
  await jobs.enqueue(JOB_KIND, {}, { runAfterMs: 1000, maxAttempts: 3 });
  return true;
}

module.exports = { JOB_KIND, TICK_MS, dueWorkflows, runDueSchedules, handleScheduleTick, startScheduler };
