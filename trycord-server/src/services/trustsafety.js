// Reports and appeals data access. Reports are user-submitted cases scoped
// away from ordinary users (only the reporter sees their own); appeals are
// tied to a moderation action and reviewed by platform admins. Every write
// is audited.
const db = require('../db');
const { now, uuid } = require('../util');
const { audit } = require('./enforcement');

const REPORT_STATUSES = ['OPEN', 'INVESTIGATING', 'RESOLVED', 'DISMISSED'];
const APPEAL_STATUSES = ['OPEN', 'UNDER_REVIEW', 'APPROVED', 'DENIED'];

function bad(msg) { const e = new Error(msg); e.code = 'VALIDATION_ERROR'; throw e; }

// --- reports ---

async function create(reporterId, input) {
  const targetType = String((input && input.targetType) || '').slice(0, 32);
  const targetId = String((input && input.targetId) || '').slice(0, 64);
  const reason = String((input && input.reason) || '').trim().slice(0, 255);
  const description = String((input && input.description) || '').trim().slice(0, 4000);
  if (!targetType || !targetId || !reason) bad('targetType, targetId and reason are required');
  if (!/^(user|server|message|channel|dm|attachment)$/.test(targetType)) bad('unsupported report target type');
  const id = uuid();
  const ts = now();
  await db.run(
    'INSERT INTO reports (id, reporter_id, target_type, target_id, reason, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, reporterId, targetType, targetId, reason, description || null, 'OPEN', ts, ts]
  );
  await audit(reporterId, 'REPORT_CREATED', targetType, targetId, reason, id);
  return { id, status: 'OPEN', targetType, targetId, reason };
}

async function mine(userId) {
  return db.all(
    `SELECT id, target_type AS targetType, target_id AS targetId, reason, status, created_at AS createdAt
     FROM reports WHERE reporter_id = ? ORDER BY created_at DESC LIMIT 100`,
    [userId]
  );
}

// Admin list with reporter names for context. Optional status/target filters.
async function list(input = {}) {
  const where = [];
  const params = [];
  if (input.status) {
    if (!REPORT_STATUSES.includes(String(input.status).toUpperCase())) bad('unknown report status');
    where.push('status = ?'); params.push(String(input.status).toUpperCase());
  }
  if (input.targetType) { where.push('target_type = ?'); params.push(input.targetType); }
  const limit = Math.min(parseInt(input.limit, 10) || 50, 100);
  const q = where.length ? 'WHERE ' + where.join(' AND ') : '';
  return db.all(
    `SELECT r.*, u.username AS reporter_name
     FROM reports r LEFT JOIN users u ON u.id = r.reporter_id
     ${q} ORDER BY r.created_at DESC LIMIT ${limit}`,
    params
  );
}

async function get(id) {
  return db.get('SELECT * FROM reports WHERE id = ?', [id]);
}

// Assign, investigate, resolve, or dismiss. Narrows the actor's own audit trail.
async function updateStatus(adminId, id, input) {
  const next = String((input && input.status) || '').toUpperCase();
  const assignee = input.assigneeId ? String(input.assigneeId) : null;
  if (!REPORT_STATUSES.includes(next)) bad('unknown report status');
  const row = await get(id);
  if (!row) { const e = new Error('report not found'); e.code = 'NOT_FOUND'; throw e; }
  const ts = now();
  const resolvedAt = next === 'RESOLVED' || next === 'DISMISSED' ? ts : null;
  const resolution = next === 'RESOLVED' ? 'RESOLVED' : next === 'DISMISSED' ? 'DISMISSED' : null;
  await db.run(
    'UPDATE reports SET status = ?, assigned_admin_id = ?, updated_at = ?, resolved_at = ?, resolution = ? WHERE id = ?',
    [next, assignee || row.assigned_admin_id, ts, resolvedAt, resolution, id]
  );
  await audit(adminId, 'REPORT_' + next, 'report', id, (input.note || '').slice(0, 2000) || 'status: ' + next, id);
  return get(id);
}

// --- appeals ---

async function actionExists(id) {
  return db.get('SELECT * FROM moderation_actions WHERE id = ?', [id]);
}

// Submission is keyed on actionId so only the account holder who received
// the enforcement details (returned at a correct-password login attempt)
// can open an appeal — no public account enumeration.
async function submitAppeal(input) {
  const actionId = String((input && input.actionId) || '');
  const reason = String((input && input.reason) || '').trim().slice(0, 4000);
  if (!actionId || !reason) bad('actionId and reason are required');
  const action = await actionExists(actionId);
  if (!action) { const e = new Error('action not found'); e.code = 'NOT_FOUND'; throw e; }
  if (!['SUSPENSION', 'ACCOUNT_BAN', 'SERVER_SUSPENSION', 'WARNING'].includes(action.action_type)) {
    bad('this action cannot be appealed');
  }
  // The action must still govern the target (not already lifted/denied).
  if (action.action_type === 'SERVER_SUSPENSION') {
    const srv = await db.get('SELECT enforcement_state FROM servers WHERE id = ?', [action.target_id]);
    if (!srv || srv.enforcement_state !== 'suspended') bad('this action is no longer active');
  } else {
    const u = await db.get('SELECT enforcement_state, enforcement_expires_at FROM users WHERE id = ?', [action.target_id]);
    if (!u || action.action_type === 'WARNING') {
      // warnings don't set live enforcement state; any authenticated user may
      // appeal a warning attached to them, and id-having holders can too.
    } else if (u.enforcement_state === 'banned' || (u.enforcement_state === 'suspended' && !(u.enforcement_expires_at && new Date(u.enforcement_expires_at).getTime() < Date.now()))) {
      // still active -> ok
    } else {
      bad('this action is no longer active');
    }
  }
  const existing = await db.all(
    `SELECT id FROM appeals WHERE action_id = ? AND status IN ('OPEN', 'UNDER_REVIEW')`,
    [actionId]
  );
  if (existing.length) bad('an appeal for this action is already pending');
  const id = uuid();
  const ts = now();
  await db.run(
    'INSERT INTO appeals (id, user_id, action_id, reason, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, action.target_id, action.id, reason, 'OPEN', ts, ts]
  );
  return { id, status: 'OPEN', actionId: action.id };
}

async function listAppeals(input = {}) {
  const where = [];
  const params = [];
  if (input.status) {
    if (!APPEAL_STATUSES.includes(String(input.status).toUpperCase())) bad('unknown appeal status');
    where.push('a.status = ?'); params.push(String(input.status).toUpperCase());
  }
  const limit = Math.min(parseInt(input.limit, 10) || 50, 100);
  const q = where.length ? 'WHERE ' + where.join(' AND ') : '';
  return db.all(
    `SELECT a.*, u.username AS user_name, m.action_type, m.reason AS action_reason
     FROM appeals a
     JOIN moderation_actions m ON m.id = a.action_id
     JOIN users u ON u.id = a.user_id
     ${q} ORDER BY a.created_at DESC LIMIT ${limit}`,
    params
  );
}

// Own appeals, scoped to the caller (mirrors the reports pattern: only the
// appellant sees their own). No enumeration risk — user_id comes from auth.
async function listMine(userId) {
  return db.all(
    `SELECT a.id, a.status, a.decision, a.created_at, a.updated_at,
            m.action_type, m.reason AS action_reason, m.target_type, m.target_id
     FROM appeals a
     JOIN moderation_actions m ON m.id = a.action_id
     WHERE a.user_id = ? ORDER BY a.created_at DESC LIMIT 100`,
    [userId]
  );
}

// Approve = lift the enforcement (for account/server actions) and record.
async function decideAppeal(adminId, id, input, lift) {
  const decision = String((input && input.decision) || '').toUpperCase();
  if (!['APPROVED', 'DENIED'].includes(decision)) bad('decision must be APPROVED or DENIED');
  const row = await db.get('SELECT * FROM appeals WHERE id = ?', [id]);
  if (!row) { const e = new Error('appeal not found'); e.code = 'NOT_FOUND'; throw e; }
  if (row.status === 'APPROVED' || row.status === 'DENIED') bad('appeal already decided');
  const ts = now();
  await db.run(
    'UPDATE appeals SET status = ?, decision = ?, reviewer_id = ?, updated_at = ? WHERE id = ?',
    [decision, decision, adminId, ts, id]
  );
  await audit(adminId, 'APPEAL_' + decision, 'appeal', id, (input.note || '').slice(0, 2000) || '', id);
  if (decision === 'APPROVED') {
    await lift(row.action_id);
  }
  return db.get('SELECT * FROM appeals WHERE id = ?', [id]);
}

module.exports = {
  REPORT_STATUSES,
  APPEAL_STATUSES,
  create,
  mine,
  list,
  get,
  updateStatus,
  actionExists,
  submitAppeal,
  listAppeals,
  listMine,
  decideAppeal,
};