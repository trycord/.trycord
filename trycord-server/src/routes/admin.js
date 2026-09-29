// /api/admin/* — Trust & Safety administration. Every route is behind
// auth + adminGuard; every mutation writes a moderation_action/audit row
// and is server-enforced (session invalidation + live-socket disconnect
// happen here, not in the client).
const express = require('express');
const rateLimit = require('../middleware/ratelimit');
const adminGuard = require('../middleware/adminGuard');
const { fail, serviceError } = require('../errors');
const db = require('../db');
const enforcement = require('../services/enforcement');
const ts = require('../services/trustsafety');
const deletion = require('../services/accountDeletion');

let gateway = { disconnectUser: () => {} };
function setGateway(gw) {
  gateway = Object.assign(gateway, gw);
}

const router = express.Router();
router.use(adminGuard);
router.use(rateLimit({ windowMs: 60000, max: 300 }));

// --- overview ---

router.get('/overview', async (req, res, next) => {
  try {
    const users = await db.get('SELECT COUNT(*) AS n FROM users');
    const servers = await db.get('SELECT COUNT(*) AS n FROM servers');
    const enforcedUsers = await db.get("SELECT COUNT(*) AS n FROM users WHERE enforcement_state = 'banned' OR (enforcement_state = 'suspended' AND (enforcement_expires_at IS NULL OR enforcement_expires_at > ?))", [new Date().toISOString()]);
    const reports = await db.all('SELECT status, COUNT(*) AS n FROM reports GROUP BY status');
    const appeals = await db.all('SELECT status, COUNT(*) AS n FROM appeals GROUP BY status');
    const openReports = (reports || []).reduce((a, r) => a + (r.status === 'OPEN' || r.status === 'INVESTIGATING' ? r.n : 0), 0);
    const openAppeals = (appeals || []).reduce((a, r) => a + (r.status === 'OPEN' || r.status === 'UNDER_REVIEW' ? r.n : 0), 0);
    const recentAudit = await db.all(
      'SELECT id, action, target_type AS targetType, target_id AS targetId, created_at AS createdAt FROM audit_logs ORDER BY created_at DESC LIMIT 8'
    );
    res.json({
      users: users.n,
      servers: servers.n,
      enforcedUsers: enforcedUsers.n,
      reports: reports || [],
      appeals: appeals || [],
      openReports,
      openAppeals,
      recentAudit,
    });
  } catch (e) { next(e); }
});

// --- users ---

router.get('/users', async (req, res, next) => {
  try {
    const q = String(req.query.q || '');
    const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);
    let rows;
    if (q) {
      rows = await db.all(
        `SELECT id, username, display_name, created_at, enforcement_state, enforcement_expires_at
         FROM users WHERE username LIKE ? OR display_name LIKE ?
         ORDER BY created_at DESC LIMIT ${limit}`,
        ['%' + q + '%', '%' + q + '%']
      );
    } else {
      rows = await db.all(
        `SELECT id, username, display_name, created_at, enforcement_state, enforcement_expires_at
         FROM users ORDER BY created_at DESC LIMIT ${limit}`
      );
    }
    res.json(rows.map((r) => ({
      id: r.id,
      username: r.username,
      displayName: r.display_name,
      createdAt: r.created_at,
      enforced: !!(r.enforcement_state && (r.enforcement_state !== 'suspended' || !r.enforcement_expires_at || new Date(r.enforcement_expires_at).getTime() >= Date.now())),
      enforcement: r.enforcement_state,
    })));
  } catch (e) { next(e); }
});

router.get('/users/:id/actions', async (req, res, next) => {
  try {
    const target = await db.get('SELECT id FROM users WHERE id = ?', [req.params.id]);
    if (!target) return fail(res, 'NOT_FOUND', 'user not found');
    res.json(await db.all(
      `SELECT id, action_type AS actionType, reason, expires_at AS expiresAt, report_id AS reportId, created_at AS createdAt,
              (SELECT username FROM users u WHERE u.id = m.actor_id) AS actor_name
       FROM moderation_actions m WHERE target_type = 'user' AND target_id = ?
       ORDER BY created_at DESC LIMIT 100`,
      [req.params.id]
    ));
  } catch (e) { next(e); }
});

router.post('/users/:id/enforce', async (req, res, next) => {
  try {
    const target = await db.get('SELECT id, enforcement_state FROM users WHERE id = ?', [req.params.id]);
    if (!target) return fail(res, 'NOT_FOUND', 'user not found');
    const action = await enforcement.applyUserAction(req.user.id, target.id, req.body || {});
    // Live sockets for a freshly enforced account are cut off now.
    gateway.disconnectUser(target.id, 'this account is under a moderation action');
    res.json(action);
  } catch (e) { serviceError(res, e); }
});

router.post('/users/:id/lift', async (req, res, next) => {
  try {
    const target = await db.get('SELECT id FROM users WHERE id = ?', [req.params.id]);
    if (!target) return fail(res, 'NOT_FOUND', 'user not found');
    res.json(await enforcement.liftUserEnforcement(req.user.id, target.id, (req.body || {}).reason));
  } catch (e) { serviceError(res, e); }
});

// Bot identity is server-controlled and persisted: only platform admins can
// flip it. The flag flows into member lists, search, and profiles so the
// client can answer "is this a bot?" from real data, never heuristics.
router.post('/users/:id/bot', async (req, res, next) => {
  try {
    const target = await db.get('SELECT id FROM users WHERE id = ?', [req.params.id]);
    if (!target) return fail(res, 'NOT_FOUND', 'user not found');
    const isBot = (req.body || {}).isBot;
    if (typeof isBot !== 'boolean') return fail(res, 'VALIDATION_ERROR', 'isBot must be a boolean');
    await db.run('UPDATE users SET is_bot = ? WHERE id = ?', [isBot ? 1 : 0, target.id]);
    try {
      const { uuid, now } = require('../util');
      await db.run(
        'INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [uuid(), req.user.id, isBot ? 'bot_flag_set' : 'bot_flag_cleared', 'user', target.id, null, now()]
      );
    } catch { /* audit is best-effort */ }
    res.json({ id: target.id, isBot });
  } catch (e) { serviceError(res, e); }
});

// --- servers ---

router.get('/servers', async (req, res, next) => {
  try {
    const q = String(req.query.q || '');
    const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);
    const where = q ? 'WHERE s.name LIKE ?' : '';
    const params = q ? ['%' + q + '%'] : [];
    res.json(await db.all(
      `SELECT s.id, s.name, s.description, s.owner_id, s.created_at AS createdAt,
              s.enforcement_state, s.enforcement_reason,
              (SELECT username FROM users u WHERE u.id = s.owner_id) AS owner_name
       FROM servers s ${where} ORDER BY s.created_at DESC LIMIT ${limit}`,
      params
    ));
  } catch (e) { next(e); }
});

router.post('/servers/:id/suspend', async (req, res, next) => {
  try {
    const target = await db.get('SELECT id FROM servers WHERE id = ?', [req.params.id]);
    if (!target) return fail(res, 'NOT_FOUND', 'server not found');
    const input = Object.assign({}, req.body || {}, { actionType: 'SERVER_SUSPENSION' });
    res.json(await enforcement.applyServerAction(req.user.id, target.id, input));
  } catch (e) { serviceError(res, e); }
});

router.post('/servers/:id/lift', async (req, res, next) => {
  try {
    const target = await db.get('SELECT id FROM servers WHERE id = ?', [req.params.id]);
    if (!target) return fail(res, 'NOT_FOUND', 'server not found');
    res.json(await enforcement.liftServerEnforcement(req.user.id, target.id, (req.body || {}).reason));
  } catch (e) { serviceError(res, e); }
});

router.post('/servers/:id/remove', async (req, res, next) => {
  try {
    const target = await db.get('SELECT id FROM servers WHERE id = ?', [req.params.id]);
    if (!target) return fail(res, 'NOT_FOUND', 'server not found');
    res.json(await enforcement.removeServer(req.user.id, target.id, req.body || {}));
  } catch (e) { serviceError(res, e); }
});

// --- reports ---

router.get('/reports', async (req, res, next) => {
  try { res.json(await ts.list(req.query || {})); } catch (e) { serviceError(res, e); }
});

router.get('/reports/:id', async (req, res, next) => {
  try {
    const row = await ts.get(req.params.id);
    if (!row) return fail(res, 'NOT_FOUND', 'report not found');
    res.json(Object.assign({}, row, { targetUser: await db.get('SELECT id, username, display_name FROM users WHERE id = ?', [row.target_id]) }));
  } catch (e) { next(e); }
});

router.patch('/reports/:id', async (req, res, next) => {
  try {
    res.json(await ts.updateStatus(req.user.id, req.params.id, req.body || {}));
  } catch (e) { serviceError(res, e); }
});

// --- appeals ---

router.get('/appeals', async (req, res, next) => {
  try { res.json(await ts.listAppeals(req.query || {})); } catch (e) { serviceError(res, e); }
});

router.get('/appeals/:id', async (req, res, next) => {
  try {
    const row = await db.get('SELECT * FROM appeals WHERE id = ?', [req.params.id]);
    if (!row) return fail(res, 'NOT_FOUND', 'appeal not found');
    res.json(row);
  } catch (e) { next(e); }
});

router.patch('/appeals/:id', async (req, res, next) => {
  try {
    const decision = String((req.body || {}).decision || '').toUpperCase();
    const lift = decision === 'APPROVED'
      ? (actionId) => liftForAction(actionId, req.user.id)
      : async () => {};
    res.json(await ts.decideAppeal(req.user.id, req.params.id, req.body || {}, lift));
  } catch (e) { serviceError(res, e); }
});

async function liftForAction(actionId, adminId) {
  const action = await ts.actionExists(actionId);
  if (!action) return;
  if (action.target_type === 'user') {
    await enforcement.liftUserEnforcement(adminId, action.target_id, 'appeal granted');
  } else {
    await enforcement.liftServerEnforcement(adminId, action.target_id, 'appeal granted');
  }
}

// --- GDPR erasure requests ---
//
// These are not moderation actions and cannot be created as one. request_type
// is written by the server when the user asks; nothing here accepts a type from
// a caller, so the queue cannot be relabelled as ordinary moderation work.

router.get('/gdpr/requests', async (req, res, next) => {
  try {
    const rows = await deletion.listRequests(req.query || {});
    res.json(rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      username: r.username,
      status: r.status,
      // The label the console shows next to every row in this queue.
      requestedBy: r.request_type === 'GDPR' ? 'GDPR' : null,
      requestType: r.request_type,
      reason: r.reason,
      requestedAt: r.requested_at,
      reviewedAt: r.reviewed_at,
      processedAt: r.processed_at,
      cancelledAt: r.cancelled_at,
      anonymisedAt: r.anonymised_at,
      accountCreatedAt: r.account_created_at,
    })));
  } catch (e) { serviceError(res, e); }
});

router.post('/gdpr/requests/:id/review', async (req, res, next) => {
  try {
    const decision = String((req.body || {}).decision || '').toUpperCase();
    const row = await deletion.reviewRequest({
      requestId: req.params.id,
      reviewerId: req.user.id,
      decision,
      note: (req.body || {}).note,
    });
    res.json({ id: row.id, status: row.status, requestedBy: 'GDPR' });
  } catch (e) { serviceError(res, e); }
});

router.post('/gdpr/requests/:id/process', async (req, res, next) => {
  try {
    const body = req.body || {};
    if (body.confirm !== 'ERASE') {
      return fail(res, 'VALIDATION_ERROR', 'type ERASE to confirm');
    }
    await deletion.beginProcessing({ requestId: req.params.id, actorId: req.user.id });
    const row = await db.get('SELECT user_id FROM account_deletion_requests WHERE id = ?', [req.params.id]);
    // The account is being erased, so any live socket for it has to go now
    // rather than when it next tries to use a session.
    try { gateway.disconnectUser(row.user_id); } catch { /* gateway not wired */ }
    const report = await deletion.eraseAccount({ userId: row.user_id, actorId: req.user.id });
    res.json({ ok: true, report });
  } catch (e) { serviceError(res, e); }
});

// --- audit ---

router.get('/audit', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const where = [];
    const params = [];
    if (req.query.actorId) { where.push('actor_id = ?'); params.push(req.query.actorId); }
    if (req.query.action) { where.push('action = ?'); params.push(req.query.action); }
    if (req.query.targetId) { where.push('target_id = ?'); params.push(req.query.targetId); }
    const q = where.length ? 'WHERE ' + where.join(' AND ') : '';
    res.json(await db.all(
      `SELECT a.*, (SELECT username FROM users u WHERE u.id = a.actor_id) AS actor_name,
              (SELECT username FROM users u WHERE u.id = a.target_id) AS target_name
       FROM audit_logs a ${q} ORDER BY a.created_at DESC LIMIT ${limit}`,
      params
    ));
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.setGateway = setGateway;