// Reports and appeals. The reader-facing half is in ../routes/reports.js; this is the
// service both halves share, and the platform-admin surface.

const db = require('../db');
const { now, uuid } = require('../util');

const OPEN = 'open';
const RESOLVED = 'resolved';

// The reasons a reader may choose from. Kept here rather than in the client so the list
// is the same one the database stores and a report is never filed with a free-text reason
// the reviewer cannot group by.
const REASONS = [
  'spam',
  'harassment',
  'hate_speech',
  'violence_or_threats',
  'self_harm',
  'explicit_content',
  'impersonation',
  'illegal_content',
  'other',
];

async function file({ reporterId, targetType, targetId, reason, description }) {
  const id = uuid();
  await db.run(
    `INSERT INTO reports (id, reporter_id, target_type, target_id, reason, description, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, reporterId, targetType, targetId, reason, description, OPEN, now(), now()]
  );
  return { id, status: OPEN };
}

async function sameOpen(reporterId, targetType, targetId) {
  const row = await db.get(
    `SELECT id FROM reports
      WHERE reporter_id = ? AND target_type = ? AND target_id = ? AND status != ?`,
    [reporterId, targetType, targetId, RESOLVED]
  );
  return !!row;
}

async function list({ status, limit = 50, offset = 0 } = {}) {
  const where = status ? 'WHERE r.status = ?' : '';
  const params = status ? [status] : [];
  const rows = await db.all(
    `SELECT r.*, reporter.username AS reporter_username, reporter.display_name AS reporter_display,
       admin.username AS admin_username, admin.display_name AS admin_display
     FROM reports r
       LEFT JOIN users reporter ON reporter.id = r.reporter_id
       LEFT JOIN users admin ON admin.id = r.assigned_admin_id
     ${where}
     ORDER BY r.created_at DESC LIMIT ? OFFSET ?`,
    [...params, Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200), Math.max(parseInt(offset, 10) || 0, 0)]
  );
  return rows.map(shape);
}

function shape(r) {
  return {
    id: r.id,
    reporter: {
      id: r.reporter_id,
      username: r.reporter_username,
      displayName: r.reporter_display,
    },
    targetType: r.target_type,
    targetId: r.target_id,
    reason: r.reason,
    description: r.description || '',
    status: r.status,
    assignedTo: r.assigned_admin_id ? {
      id: r.assigned_admin_id,
      username: r.admin_username,
      displayName: r.admin_display,
    } : null,
    resolution: r.resolution || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    resolvedAt: r.resolved_at || null,
  };
}

async function assign(reportId, adminId) {
  await db.run('UPDATE reports SET assigned_admin_id = ?, updated_at = ? WHERE id = ?', [adminId, now(), reportId]);
  return { ok: true };
}

// Resolving is a decision, and it is recorded: a report that disappears without a
// resolution is an audit hole.
async function resolve(reportId, adminId, { resolution } = {}) {
  const clean = ['action_taken', 'no_action', 'duplicate', 'not_applicable']
    .indexOf(resolution) === -1 ? 'no_action' : resolution;
  await db.run(
    `UPDATE reports SET status = ?, resolution = ?, assigned_admin_id = ?, updated_at = ?, resolved_at = ?
      WHERE id = ?`,
    [RESOLVED, clean, adminId, now(), now(), reportId]
  );
  return { ok: true };
}

// Appeals are filed against a moderation action, so the row that carried the decision has
// to be named.
async function fileAppeal(userId, { actionId, reason }) {
  if (!actionId) throw { code: 'VALIDATION_ERROR', message: 'an appeal needs the action it is about' };
  if (!reason || !String(reason).trim()) {
    throw { code: 'VALIDATION_ERROR', message: 'an appeal needs a reason' };
  }

  const action = await db.get('SELECT * FROM moderation_actions WHERE id = ?', [actionId]);
  if (!action) throw { code: 'NOT_FOUND', message: 'that moderation action does not exist' };
  if (action.target_type !== 'user' || action.target_id !== userId) {
    throw { code: 'PERMISSION_DENIED', message: 'that action is not yours to appeal' };
  }

  const existing = await db.get(
    'SELECT id FROM appeals WHERE user_id = ? AND action_id = ? AND status = ?',
    [userId, actionId, 'OPEN']
  );
  if (existing) throw { code: 'ALREADY_EXISTS', message: 'there is already an open appeal for this' };

  const id = uuid();
  await db.run(
    `INSERT INTO appeals (id, user_id, action_id, reason, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, userId, actionId, String(reason).slice(0, 4000), 'OPEN', now(), now()]
  );
  return { id, status: 'OPEN' };
}

async function listAppeals({ status, limit = 50, offset = 0 } = {}) {
  const where = status ? 'WHERE a.status = ?' : '';
  const params = status ? [status] : [];
  const rows = await db.all(
    `SELECT a.*, u.username, u.display_name,
       ra.username AS reviewer_username, ra.display_name AS reviewer_display,
       m.action_type, m.reason AS action_reason
     FROM appeals a
       JOIN users u ON u.id = a.user_id
       LEFT JOIN users ra ON ra.id = a.reviewer_id
       LEFT JOIN moderation_actions m ON m.id = a.action_id
     ${where}
     ORDER BY a.created_at DESC LIMIT ? OFFSET ?`,
    [...params, Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200), Math.max(parseInt(offset, 10) || 0, 0)]
  );
  return rows.map((r) => ({
    id: r.id,
    user: { id: r.user_id, username: r.username, displayName: r.display_name },
    actionId: r.action_id,
    actionType: r.action_type,
    actionReason: r.action_reason || '',
    reason: r.reason,
    status: r.status,
    reviewer: r.reviewer_id ? {
      id: r.reviewer_id, username: r.reviewer_username, displayName: r.reviewer_display,
    } : null,
    decision: r.decision || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

async function decideAppeal(appealId, reviewerId, { decision }) {
  const clean = ['approved', 'denied', 'more_info'].indexOf(decision) === -1 ? 'denied' : decision;
  await db.run(
    `UPDATE appeals SET status = ?, decision = ?, reviewer_id = ?, updated_at = ? WHERE id = ?`,
    [clean === 'approved' ? 'APPROVED' : 'CLOSED', clean, reviewerId, now(), appealId]
  );
  return { ok: true };
}

module.exports = {
  REASONS, file, sameOpen, list, assign, resolve,
  fileAppeal, listAppeals, decideAppeal, shape,
};
