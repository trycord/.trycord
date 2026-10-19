// The audit trail for the extension and workflow surface.
//
// One writer for both halves of the feature: an install, a grant, a rollback
// and a workflow run are the same kind of record, and two writers would mean
// two slightly different ideas of what a row in audit_logs means.
//
// The table is the repository's own (see ../db/tables/moderation): an append
// only record of who did what to which target, with a free-text reason. There
// is no edit path and no delete path, which is the property that makes it
// worth writing to.

const db = require('../../db');
const { now, uuid } = require('../../util');

// The actions this surface writes. Named here rather than spelled at the call
// sites so a reader can see the whole vocabulary in one place, and so a typo
// in an action name is a missing constant rather than a new row shape.
const ACTIONS = {
  POLICY_UPDATED: 'EXTENSION_POLICY_UPDATED',
  INSTALLED: 'EXTENSION_INSTALLED',
  ENABLED: 'EXTENSION_ENABLED',
  DISABLED: 'EXTENSION_DISABLED',
  UPDATED: 'EXTENSION_UPDATED',
  ROLLED_BACK: 'EXTENSION_ROLLED_BACK',
  REMOVED: 'EXTENSION_REMOVED',
  CAPABILITY_GRANTED: 'EXTENSION_CAPABILITY_GRANTED',
  CAPABILITY_REVOKED: 'EXTENSION_CAPABILITY_REVOKED',
  WORKFLOW_CREATED: 'WORKFLOW_CREATED',
  WORKFLOW_UPDATED: 'WORKFLOW_UPDATED',
  WORKFLOW_PAUSED: 'WORKFLOW_PAUSED',
  WORKFLOW_RESUMED: 'WORKFLOW_RESUMED',
  WORKFLOW_RUN: 'WORKFLOW_RUN',
  WORKFLOW_APPROVED: 'WORKFLOW_APPROVED',
  WORKFLOW_REJECTED: 'WORKFLOW_REJECTED',
};

/**
 * Append one audit row.
 *
 * @param {string} actorId  the account that did it
 * @param {string} action   one of ACTIONS
 * @param {string} targetType 'extension' | 'workflow' | 'policy'
 * @param {string} targetId
 * @param {string} [reason] what was asked for, in words
 */
async function record(actorId, action, targetType, targetId, reason) {
  await db.run(
    'INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, reason, created_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?)',
    [uuid(), actorId, action, targetType || null, targetId || null, reason || null, now()]
  );
}

// The audit trail for one target, newest first. Bounded: the list an
// operator reads is a recent history, not the whole table.
async function forTarget(targetType, targetId, limit = 50) {
  const cap = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const rows = await db.all(
    'SELECT id, actor_id AS actorId, action, target_type AS targetType, target_id AS targetId, ' +
    'reason, created_at AS createdAt FROM audit_logs WHERE target_type = ? AND target_id = ? ' +
    'ORDER BY created_at DESC, id DESC LIMIT ' + cap,
    [targetType, targetId]
  );
  return rows;
}

module.exports = { ACTIONS, record, forTarget };
