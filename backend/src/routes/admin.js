// /api/admin/* — Trust & Safety administration.
//
// `adminGuard.any` opens the door to every platform role; each route then
// names the permission it needs. The request never supplies its own role.
// Every enforcement mutation is server-enforced here (session invalidation
// and live-socket disconnection), attached to a case, and written to the
// hash-chained audit trail.
const express = require('express');
const rateLimit = require('../middleware/ratelimit');
const adminGuard = require('../middleware/adminGuard');
const { fail, serviceError } = require('../errors');
const db = require('../db');
const enforcement = require('../services/enforcement');
const ts = require('../services/trustsafety');
const cases = require('../services/cases');
const audit = require('../services/audit');
const platformRoles = require('../services/platformRoles');
const deletion = require('../services/accountDeletion');
const { now, uuid } = require('../util');

let gateway = { disconnectUser: () => {} };
function setGateway(gw) {
  gateway = Object.assign(gateway, gw);
}

const router = express.Router();
router.use(adminGuard.any);
router.use(rateLimit({ windowMs: 60000, max: 300 }));

const can = (permission) => adminGuard.permission(permission);

// The request names the action `actionType`; older callers read `type`. Both
// are on the answer so neither contract silently loses its value.
function actionResponse(action) {
  if (!action || typeof action !== 'object') return action;
  if (!action.actionType && action.type) action.actionType = action.type;
  if (!action.type && action.actionType) action.type = action.actionType;
  return action;
}

function intParam(value, fallback, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(n, max);
}

// --- identity --------------------------------------------------------------

router.get('/me', async (req, res) => {
  res.json({
    userId: req.admin.userId,
    username: req.admin.username,
    displayName: req.admin.displayName,
    role: req.admin.role,
    roleLabel: req.admin.roleLabel,
    permissions: req.admin.permissions,
    catalogue: platformRoles.PERMISSIONS,
  });
});

// --- overview --------------------------------------------------------------

router.get('/overview', can('platform.overview'), async (req, res, next) => {
  try {
    const [users, servers, enforcedUsers, openReports, openCases, openAppeals,
      restrictions, recentAudit, bySeverity] = await Promise.all([
      db.get('SELECT COUNT(*) AS n FROM users'),
      db.get('SELECT COUNT(*) AS n FROM servers WHERE deleted_at IS NULL'),
      db.get("SELECT COUNT(*) AS n FROM users WHERE enforcement_state = 'banned' OR (enforcement_state = 'suspended' AND (enforcement_expires_at IS NULL OR enforcement_expires_at > ?))", [new Date().toISOString()]),
      db.get("SELECT COUNT(*) AS n FROM reports WHERE status IN ('OPEN', 'INVESTIGATING', 'UNDER_REVIEW', 'ASSIGNED', 'ESCALATED')"),
      db.get("SELECT COUNT(*) AS n FROM moderation_cases WHERE scope = 'platform' AND status IN ('OPEN', 'UNDER_REVIEW', 'ASSIGNED', 'ESCALATED')"),
      db.get("SELECT COUNT(*) AS n FROM appeals WHERE server_id IS NULL AND status IN ('OPEN', 'UNDER_REVIEW')"),
      db.get("SELECT COUNT(*) AS n FROM user_restrictions WHERE lifted_at IS NULL AND (expires_at IS NULL OR expires_at > ?)", [new Date().toISOString()]),
      db.all(
        `SELECT a.id, a.action, a.target_type AS targetType, a.target_id AS targetId,
                a.reason, a.case_id AS caseId, a.created_at AS createdAt,
                u.username AS actorName
         FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
         ORDER BY a.created_at DESC LIMIT 8`
      ),
      db.all(
        `SELECT severity, COUNT(*) AS n FROM reports
         WHERE status IN ('OPEN', 'INVESTIGATING', 'UNDER_REVIEW', 'ASSIGNED', 'ESCALATED')
         GROUP BY severity`
      ),
    ]);
    res.json({
      users: users.n,
      servers: servers.n,
      enforcedUsers: enforcedUsers.n,
      openReports: openReports.n,
      openCases: openCases.n,
      openAppeals: openAppeals.n,
      activeRestrictions: restrictions.n,
      bySeverity,
      recentAudit,
      role: req.admin.role,
    });
  } catch (e) { next(e); }
});

// --- platform roles --------------------------------------------------------

router.get('/roles', can('platform.admin'), async (req, res, next) => {
  try {
    res.json({
      roles: Object.entries(platformRoles.ROLES).map(([name, role]) => ({
        name, label: role.label, description: role.description, permissions: role.permissions,
      })),
      permissions: platformRoles.PERMISSIONS,
      admins: await platformRoles.list(),
    });
  } catch (e) { next(e); }
});

router.post('/roles', can('platform.admin'), async (req, res, next) => {
  try {
    const body = req.body || {};
    if (!body.userId) return fail(res, 'VALIDATION_ERROR', 'userId is required');
    const existing = await platformRoles.get(body.userId);
    const demotingLastAdmin = existing && existing.role === 'PLATFORM_ADMIN'
      && String(body.role || '').toUpperCase() !== 'PLATFORM_ADMIN'
      && (await platformRoles.countPlatformAdmins()) <= 1;
    if (demotingLastAdmin) return fail(res, 'CONFLICT', 'the last platform administrator cannot be demoted');
    res.json(await platformRoles.assign(body.userId, body.role, req.user.id));
  } catch (e) { serviceError(res, e); }
});

router.delete('/roles/:userId', can('platform.admin'), async (req, res, next) => {
  try {
    const existing = await platformRoles.get(req.params.userId);
    if (!existing) return fail(res, 'NOT_FOUND', 'platform role not found');
    if (existing.role === 'PLATFORM_ADMIN' && (await platformRoles.countPlatformAdmins()) <= 1) {
      return fail(res, 'CONFLICT', 'the last platform administrator cannot be removed');
    }
    res.json(await platformRoles.remove(req.params.userId, req.user.id));
  } catch (e) { serviceError(res, e); }
});

// --- users -----------------------------------------------------------------

router.get('/users', can('platform.users.view'), async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const state = String(req.query.state || '').toUpperCase();
    const limit = intParam(req.query.limit, 25, 100);
    const where = [];
    const params = [];
    if (q) {
      where.push('(u.username LIKE ? OR u.display_name LIKE ? OR u.id = ?)');
      params.push('%' + q + '%', '%' + q + '%', q);
    }
    if (state === 'BANNED') where.push("u.enforcement_state = 'banned'");
    else if (state === 'SUSPENDED') where.push("u.enforcement_state = 'suspended'");
    else if (state === 'CLEAR') where.push('u.enforcement_state IS NULL');
    else if (state === 'RESTRICTED') where.push(
      'EXISTS (SELECT 1 FROM user_restrictions r WHERE r.user_id = u.id AND r.lifted_at IS NULL AND (r.expires_at IS NULL OR r.expires_at > CURRENT_TIMESTAMP))'
    );
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const rows = await db.all(
      `SELECT u.id, u.username, u.display_name, u.created_at, u.enforcement_state,
              u.enforcement_expires_at,
              (SELECT COUNT(*) FROM moderation_actions m
                WHERE m.target_type = 'user' AND m.target_id = u.id) AS action_count,
              (SELECT COUNT(*) FROM user_restrictions r
                WHERE r.user_id = u.id AND r.lifted_at IS NULL
                  AND (r.expires_at IS NULL OR r.expires_at > ?)) AS restriction_count,
              (SELECT COUNT(*) FROM reports r
                WHERE r.target_type = 'user' AND r.target_id = u.id
                  AND r.status IN ('OPEN','INVESTIGATING','UNDER_REVIEW','ASSIGNED','ESCALATED')) AS open_report_count
       FROM users u ${clause}
       ORDER BY u.created_at DESC LIMIT ${limit}`,
      [new Date().toISOString(), ...params]
    );
    res.json(rows.map((r) => {
      const active = r.enforcement_state === 'banned'
        || (r.enforcement_state === 'suspended' && (!r.enforcement_expires_at || new Date(r.enforcement_expires_at).getTime() >= Date.now()));
      return {
        id: r.id,
        username: r.username,
        displayName: r.display_name,
        createdAt: r.created_at,
        enforced: !!active,
        enforcement: r.enforcement_state,
        enforcementExpiresAt: r.enforcement_expires_at,
        actionCount: Number(r.action_count || 0),
        restrictionCount: Number(r.restriction_count || 0),
        openReportCount: Number(r.open_report_count || 0),
        repeatOffender: Number(r.action_count || 0) >= 3,
      };
    }));
  } catch (e) { next(e); }
});

router.get('/users/:id', can('platform.users.view'), async (req, res, next) => {
  try {
    const user = await db.get(
      `SELECT id, username, display_name, email, created_at, approved_at, is_bot,
              bio, avatar_url, enforcement_state, enforcement_expires_at,
              enforcement_reason, enforcement_updated_at
       FROM users WHERE id = ?`,
      [req.params.id]
    );
    if (!user) return fail(res, 'NOT_FOUND', 'user not found');
    const [actions, restrictions, reports, casesRows, appeals, notes, role,
      owned, memberships, auditRows] = await Promise.all([
      db.all(
        `SELECT m.*, u.username AS actor_name, u.display_name AS actor_display
         FROM moderation_actions m LEFT JOIN users u ON u.id = m.actor_id
         WHERE m.target_type = 'user' AND m.target_id = ?
         ORDER BY m.created_at DESC LIMIT 100`,
        [user.id]
      ),
      db.all(
        `SELECT r.*, u.username AS actor_name
         FROM user_restrictions r LEFT JOIN users u ON u.id = r.actor_id
         WHERE r.user_id = ? ORDER BY r.created_at DESC LIMIT 100`,
        [user.id]
      ),
      db.all(
        `SELECT r.id, r.case_id AS caseId, r.target_type AS targetType, r.target_id AS targetId,
                r.server_id AS serverId, r.reason, r.category, r.severity, r.priority,
                r.status, r.created_at AS createdAt
         FROM reports r WHERE r.target_type = 'user' AND r.target_id = ?
         ORDER BY r.created_at DESC LIMIT 50`,
        [user.id]
      ),
      cases.list({ subjectId: user.id, limit: 50 }),
      db.all(
        `SELECT a.id, a.case_id AS caseId, a.status, a.decision, a.reason,
                a.created_at AS createdAt, a.updated_at AS updatedAt,
                m.action_type AS actionType, m.reason AS actionReason
         FROM appeals a JOIN moderation_actions m ON m.id = a.action_id
         WHERE a.user_id = ? ORDER BY a.created_at DESC LIMIT 50`,
        [user.id]
      ),
      db.all(
        `SELECT n.*, u.username AS author_name, u.display_name AS author_display
         FROM admin_user_notes n LEFT JOIN users u ON u.id = n.author_id
         WHERE n.user_id = ? ORDER BY n.created_at DESC`,
        [user.id]
      ),
      platformRoles.get(user.id),
      db.all(
        `SELECT id, name, member_count, enforcement_state FROM (
           SELECT s.id, s.name,
             (SELECT COUNT(*) FROM server_members m WHERE m.server_id = s.id) AS member_count,
             s.enforcement_state
           FROM servers s WHERE s.owner_id = ? AND s.deleted_at IS NULL
         ) owned ORDER BY name`,
        [user.id]
      ),
      db.all(
        `SELECT s.id, s.name, m.joined_at AS joinedAt
         FROM server_members m JOIN servers s ON s.id = m.server_id
         WHERE m.user_id = ? AND s.deleted_at IS NULL
         ORDER BY m.joined_at DESC LIMIT 50`,
        [user.id]
      ),
      db.all(
        `SELECT a.id, a.action, a.target_type AS targetType, a.target_id AS targetId,
                a.reason, a.case_id AS caseId, a.created_at AS createdAt,
                actor.username AS actorName
         FROM audit_logs a LEFT JOIN users actor ON actor.id = a.actor_id
         WHERE a.target_type = 'user' AND a.target_id = ?
         ORDER BY a.created_at DESC LIMIT 50`,
        [user.id]
      ),
    ]);
    const activeRestrictions = restrictions.filter((r) => !r.lifted_at
      && (!r.expires_at || new Date(r.expires_at).getTime() > Date.now()));
    const activeWarnings = actions.filter((a) => a.action_type === 'WARNING' && a.status === 'ACTIVE'
      && (!a.expires_at || new Date(a.expires_at).getTime() > Date.now()));
    const activeEnforcement = user.enforcement_state === 'banned'
      || (user.enforcement_state === 'suspended'
        && (!user.enforcement_expires_at || new Date(user.enforcement_expires_at).getTime() > Date.now()));
    res.json({
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        email: user.email,
        createdAt: user.created_at,
        approvedAt: user.approved_at,
        isBot: !!user.is_bot,
        bio: user.bio,
        avatarUrl: user.avatar_url,
        enforcement: activeEnforcement ? {
          state: user.enforcement_state,
          expiresAt: user.enforcement_expires_at,
          reason: user.enforcement_reason,
          updatedAt: user.enforcement_updated_at,
        } : null,
      },
      role,
      repeatOffender: {
        totalActions: actions.length,
        activeWarnings: activeWarnings.length,
        bans: actions.filter((a) => a.action_type === 'ACCOUNT_BAN').length,
        suspensions: actions.filter((a) => a.action_type === 'SUSPENSION').length,
        openReports: reports.filter((r) => ['OPEN', 'INVESTIGATING', 'UNDER_REVIEW', 'ASSIGNED', 'ESCALATED'].includes(r.status)).length,
        lastActionAt: actions[0] ? actions[0].created_at : null,
        flagged: actions.length >= 3 || reports.length >= 3,
      },
      actions,
      restrictions,
      activeRestrictions,
      reports,
      cases: casesRows,
      appeals,
      notes: notes.map((n) => ({
        id: n.id, body: n.body, authorId: n.author_id,
        authorName: n.author_name || null, authorDisplay: n.author_display || null,
        createdAt: n.created_at, updatedAt: n.updated_at,
      })),
      communities: { owned, memberships },
      audit: auditRows,
    });
  } catch (e) { next(e); }
});

router.get('/users/:id/actions', can('platform.users.view'), async (req, res, next) => {
  try {
    const target = await db.get('SELECT id FROM users WHERE id = ?', [req.params.id]);
    if (!target) return fail(res, 'NOT_FOUND', 'user not found');
    res.json(await db.all(
      `SELECT m.*, u.username AS actorName
       FROM moderation_actions m LEFT JOIN users u ON u.id = m.actor_id
       WHERE m.target_type = 'user' AND m.target_id = ?
       ORDER BY m.created_at DESC LIMIT 100`,
      [req.params.id]
    ));
  } catch (e) { next(e); }
});

router.post('/users/:id/notes', can('platform.users.notes'), async (req, res, next) => {
  try {
    const body = String((req.body || {}).body || '').trim();
    if (!body) return fail(res, 'VALIDATION_ERROR', 'a note is required');
    if (body.length > 4000) return fail(res, 'VALIDATION_ERROR', 'a note cannot exceed 4000 characters');
    const target = await db.get('SELECT id FROM users WHERE id = ?', [req.params.id]);
    if (!target) return fail(res, 'NOT_FOUND', 'user not found');
    const id = uuid();
    const timestamp = now();
    await db.run(
      'INSERT INTO admin_user_notes (id, user_id, author_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, target.id, req.user.id, body, timestamp, timestamp]
    );
    await enforcement.audit(req.user.id, 'USER_NOTE_ADDED', 'user', target.id, body);
    res.status(201).json({ id, userId: target.id, body, createdAt: timestamp, updatedAt: timestamp });
  } catch (e) { serviceError(res, e); }
});

router.post('/users/:id/enforce', can('platform.users.enforce'), async (req, res, next) => {
  try {
    const target = await db.get('SELECT id FROM users WHERE id = ?', [req.params.id]);
    if (!target) return fail(res, 'NOT_FOUND', 'user not found');
    const action = await enforcement.applyUserAction(req.user.id, target.id, req.body || {});
    if (['SUSPENSION', 'ACCOUNT_BAN'].includes(String((req.body || {}).actionType || '').toUpperCase())) {
      gateway.disconnectUser(target.id, 'this account is under a moderation action');
    }
    res.json(actionResponse(action));
  } catch (e) { serviceError(res, e); }
});

router.post('/users/:id/warn', can('platform.users.enforce'), async (req, res, next) => {
  try {
    const target = await db.get('SELECT id FROM users WHERE id = ?', [req.params.id]);
    if (!target) return fail(res, 'NOT_FOUND', 'user not found');
    const input = Object.assign({}, req.body || {}, { actionType: 'WARNING' });
    res.status(201).json(actionResponse(await enforcement.applyUserAction(req.user.id, target.id, input)));
  } catch (e) { serviceError(res, e); }
});

router.post('/users/:id/restrict', can('platform.users.enforce'), async (req, res, next) => {
  try {
    const target = await db.get('SELECT id FROM users WHERE id = ?', [req.params.id]);
    if (!target) return fail(res, 'NOT_FOUND', 'user not found');
    const input = Object.assign({}, req.body || {}, { actionType: 'RESTRICTION' });
    res.status(201).json(actionResponse(await enforcement.applyUserAction(req.user.id, target.id, input)));
  } catch (e) { serviceError(res, e); }
});

router.post('/users/:id/lift', can('platform.users.lift'), async (req, res, next) => {
  try {
    const target = await db.get('SELECT id FROM users WHERE id = ?', [req.params.id]);
    if (!target) return fail(res, 'NOT_FOUND', 'user not found');
    const action = await enforcement.liftUserEnforcement(req.user.id, target.id, (req.body || {}).reason);
    res.json(actionResponse(action));
  } catch (e) { serviceError(res, e); }
});

router.post('/users/:id/restrictions/:restrictionId/lift', can('platform.users.lift'), async (req, res, next) => {
  try {
    const row = await db.get('SELECT * FROM user_restrictions WHERE id = ? AND user_id = ?',
      [req.params.restrictionId, req.params.id]);
    if (!row) return fail(res, 'NOT_FOUND', 'restriction not found');
    res.json(await enforcement.liftRestriction(req.user.id, req.params.restrictionId, (req.body || {}).reason));
  } catch (e) { serviceError(res, e); }
});

router.post('/users/:id/bot', can('platform.accounts.manage'), async (req, res, next) => {
  try {
    const target = await db.get('SELECT id FROM users WHERE id = ?', [req.params.id]);
    if (!target) return fail(res, 'NOT_FOUND', 'user not found');
    const isBot = (req.body || {}).isBot;
    if (typeof isBot !== 'boolean') return fail(res, 'VALIDATION_ERROR', 'isBot must be a boolean');
    await db.run('UPDATE users SET is_bot = ? WHERE id = ?', [isBot ? 1 : 0, target.id]);
    await enforcement.audit(req.user.id, isBot ? 'BOT_FLAG_SET' : 'BOT_FLAG_CLEARED',
      'user', target.id, null);
    res.json({ id: target.id, isBot });
  } catch (e) { serviceError(res, e); }
});

router.post('/users/:id/two-factor/clear', can('platform.accounts.manage'), async (req, res, next) => {
  try {
    const target = await db.get(
      'SELECT id, username, totp_enabled_at FROM users WHERE id = ?', [req.params.id]
    );
    if (!target) return fail(res, 'NOT_FOUND', 'user not found');
    if (!target.totp_enabled_at) return fail(res, 'NOT_APPLICABLE', 'that account has no second factor');
    await db.transaction(async (t) => {
      await t.run('UPDATE users SET totp_secret = NULL, totp_enabled_at = NULL WHERE id = ?', [target.id]);
      await t.run('DELETE FROM totp_recovery_codes WHERE user_id = ?', [target.id]);
    });
    await enforcement.audit(req.user.id, 'TWO_FACTOR_CLEARED', 'user', target.id,
      String((req.body || {}).reason || 'the account holder lost the authenticator'));
    res.json({ id: target.id, cleared: true });
  } catch (e) { serviceError(res, e); }
});

// --- communities -----------------------------------------------------------

router.get('/servers', can('platform.communities.view'), async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const limit = intParam(req.query.limit, 25, 100);
    const where = [];
    const params = [];
    if (q) { where.push('(s.name LIKE ? OR s.id = ?)'); params.push('%' + q + '%', q); }
    if (String(req.query.state || '').toUpperCase() === 'ENFORCED') {
      where.push('s.enforcement_state IS NOT NULL');
    }
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    res.json(await db.all(
      `SELECT s.id, s.name, s.description, s.owner_id AS ownerId, s.created_at AS createdAt,
              s.enforcement_state AS enforcementState, s.enforcement_reason AS enforcementReason,
              s.enforcement_expires_at AS enforcementExpiresAt, s.deleted_at AS deletedAt,
              (SELECT username FROM users u WHERE u.id = s.owner_id) AS ownerName,
              (SELECT COUNT(*) FROM server_members m WHERE m.server_id = s.id) AS memberCount,
              (SELECT COUNT(*) FROM reports r WHERE r.server_id = s.id
                AND r.status IN ('OPEN','INVESTIGATING','UNDER_REVIEW','ASSIGNED','ESCALATED')) AS openReportCount
       FROM servers s ${clause} ORDER BY s.created_at DESC LIMIT ${limit}`,
      params
    ));
  } catch (e) { next(e); }
});

router.get('/servers/:id', can('platform.communities.view'), async (req, res, next) => {
  try {
    const server = await db.get(
      `SELECT s.*, u.username AS owner_name, u.display_name AS owner_display,
              (SELECT COUNT(*) FROM server_members m WHERE m.server_id = s.id) AS member_count,
              (SELECT COUNT(*) FROM channels c WHERE c.server_id = s.id) AS channel_count
       FROM servers s LEFT JOIN users u ON u.id = s.owner_id WHERE s.id = ?`,
      [req.params.id]
    );
    if (!server) return fail(res, 'NOT_FOUND', 'server not found');
    const [actions, reports, casesRows, appeals, auditRows] = await Promise.all([
      db.all(
        `SELECT m.*, u.username AS actor_name
         FROM moderation_actions m LEFT JOIN users u ON u.id = m.actor_id
         WHERE m.target_type = 'server' AND m.target_id = ?
         ORDER BY m.created_at DESC LIMIT 100`,
        [server.id]
      ),
      db.all(
        `SELECT id, case_id AS caseId, target_type AS targetType, target_id AS targetId,
                reason, category, severity, priority, status, created_at AS createdAt
         FROM reports WHERE server_id = ? ORDER BY created_at DESC LIMIT 100`,
        [server.id]
      ),
      cases.list({ serverId: server.id, limit: 100 }),
      ts.listAppeals({}, { serverId: server.id }),
      db.all(
        `SELECT a.id, a.action, a.target_type AS targetType, a.target_id AS targetId,
                a.reason, a.case_id AS caseId, a.created_at AS createdAt,
                actor.username AS actorName
         FROM audit_logs a LEFT JOIN users actor ON actor.id = a.actor_id
         WHERE a.server_id = ? OR (a.target_type = 'server' AND a.target_id = ?)
         ORDER BY a.created_at DESC LIMIT 100`,
        [server.id, server.id]
      ),
    ]);
    res.json({
      server: {
        ...server,
        memberCount: Number(server.member_count || 0),
        channelCount: Number(server.channel_count || 0),
        ownerName: server.owner_name || null,
        ownerDisplay: server.owner_display || null,
      },
      enforcement: server.enforcement_state ? {
        state: server.enforcement_state,
        reason: server.enforcement_reason,
        expiresAt: server.enforcement_expires_at || null,
        deletedAt: server.deleted_at || null,
      } : null,
      actions,
      reports,
      cases: casesRows,
      appeals,
      audit: auditRows,
    });
  } catch (e) { next(e); }
});

router.post('/servers/:id/suspend', can('platform.communities.enforce'), async (req, res, next) => {
  try {
    const target = await db.get('SELECT id FROM servers WHERE id = ?', [req.params.id]);
    if (!target) return fail(res, 'NOT_FOUND', 'server not found');
    const input = Object.assign({}, req.body || {}, { actionType: 'SERVER_SUSPENSION' });
    res.json(actionResponse(await enforcement.applyServerAction(req.user.id, target.id, input)));
  } catch (e) { serviceError(res, e); }
});

router.post('/servers/:id/lift', can('platform.communities.restore'), async (req, res, next) => {
  try {
    const target = await db.get('SELECT id FROM servers WHERE id = ?', [req.params.id]);
    if (!target) return fail(res, 'NOT_FOUND', 'server not found');
    res.json(actionResponse(await enforcement.liftServerEnforcement(
      req.user.id, target.id, (req.body || {}).reason
    )));
  } catch (e) { serviceError(res, e); }
});

router.post('/servers/:id/remove', can('platform.communities.enforce'), async (req, res, next) => {
  try {
    const target = await db.get('SELECT id FROM servers WHERE id = ?', [req.params.id]);
    if (!target) return fail(res, 'NOT_FOUND', 'server not found');
    res.json(actionResponse(await enforcement.removeServer(req.user.id, target.id, req.body || {})));
  } catch (e) { serviceError(res, e); }
});

router.post('/servers/:id/restore', can('platform.communities.restore'), async (req, res, next) => {
  try {
    const target = await db.get('SELECT id FROM servers WHERE id = ?', [req.params.id]);
    if (!target) return fail(res, 'NOT_FOUND', 'server not found');
    res.json(actionResponse(await enforcement.restoreServer(
      req.user.id, target.id, (req.body || {}).reason
    )));
  } catch (e) { serviceError(res, e); }
});

// --- registration approval -------------------------------------------------

router.get('/approvals', can('platform.approvals.manage'), async (req, res, next) => {
  try {
    if (!require('../features').current.registrationApproval) {
      return res.json({ enabled: false, pending: [] });
    }
    const rows = await db.all(
      'SELECT id, username, display_name, email, created_at FROM users '
      + "WHERE approved_at IS NULL AND enforcement_state IS NULL AND is_bot = 0 "
      + 'ORDER BY created_at LIMIT 200'
    );
    res.json({
      enabled: true,
      pending: rows.map((u) => ({
        id: u.id, username: u.username, displayName: u.display_name,
        email: u.email, createdAt: u.created_at,
      })),
    });
  } catch (e) { serviceError(res, e); }
});

router.post('/users/:id/approve', can('platform.approvals.manage'), async (req, res, next) => {
  try {
    const target = await db.get('SELECT id, approved_at FROM users WHERE id = ?', [req.params.id]);
    if (!target) return fail(res, 'NOT_FOUND', 'user not found');
    if (target.approved_at) return fail(res, 'CONFLICT', 'that account is already approved');
    const at = now();
    await db.run('UPDATE users SET approved_at = ? WHERE id = ?', [at, req.params.id]);
    await enforcement.audit(req.user.id, 'ACCOUNT_APPROVED', 'user', req.params.id,
      'approved by an administrator');
    res.json({ ok: true, approvedAt: at });
  } catch (e) { serviceError(res, e); }
});

// --- cases -----------------------------------------------------------------

router.get('/cases', can('platform.cases.view'), async (req, res, next) => {
  try {
    const query = Object.assign({}, req.query || {});
    if (!query.scope && !query.serverId) query.scope = 'platform';
    res.json(await cases.list(query));
  } catch (e) { serviceError(res, e); }
});

router.get('/cases/:id', can('platform.cases.view'), async (req, res, next) => {
  try {
    const row = await cases.get(req.params.id, {});
    if (!row) return fail(res, 'NOT_FOUND', 'case not found');
    res.json(row);
  } catch (e) { next(e); }
});

router.patch('/cases/:id', can('platform.cases.manage'), async (req, res, next) => {
  try {
    const updated = await cases.update(req.params.id, req.user.id, req.body || {}, {});
    await enforcement.audit(req.user.id, 'CASE_UPDATED', 'case', req.params.id,
      (req.body || {}).note || null, { caseId: req.params.id, serverId: updated.server_id || null });
    res.json(updated);
  } catch (e) { serviceError(res, e); }
});

router.post('/cases/:id/notes', can('platform.cases.manage'), async (req, res, next) => {
  try {
    const note = await cases.addNote(req.params.id, req.user.id, (req.body || {}).body || (req.body || {}).note, {});
    await enforcement.audit(req.user.id, 'CASE_NOTE_ADDED', 'case', req.params.id, note.body, { caseId: req.params.id });
    res.status(201).json(note);
  } catch (e) { serviceError(res, e); }
});

router.post('/cases/:id/evidence', can('platform.cases.manage'), async (req, res, next) => {
  try {
    const evidence = await cases.addEvidence(req.params.id, req.user.id, req.body || {}, {});
    await enforcement.audit(req.user.id, 'CASE_EVIDENCE_ADDED', 'case', req.params.id,
      (req.body || {}).note || (req.body || {}).kind || 'evidence', {
        caseId: req.params.id, metadata: { kind: evidence.kind, evidenceId: evidence.id },
      });
    res.status(201).json(evidence);
  } catch (e) { serviceError(res, e); }
});

// --- reports ---------------------------------------------------------------

router.get('/reports', can('platform.reports.view'), async (req, res, next) => {
  try {
    const filter = req.query.serverId
      ? { serverId: String(req.query.serverId) }
      : {};
    res.json(await ts.list(req.query || {}, filter));
  } catch (e) { serviceError(res, e); }
});

router.get('/reports/:id', can('platform.reports.view'), async (req, res, next) => {
  try {
    const filter = req.query.serverId ? { serverId: String(req.query.serverId) } : {};
    const row = await ts.getReport(req.params.id, filter);
    if (!row) return fail(res, 'NOT_FOUND', 'report not found');
    row.case = row.caseId ? await cases.get(row.caseId, filter) : null;
    if (row.targetType === 'user') {
      row.targetUser = await db.get(
        'SELECT id, username, display_name, enforcement_state, enforcement_expires_at FROM users WHERE id = ?',
        [row.targetId]
      );
    }
    res.json(row);
  } catch (e) { next(e); }
});

router.patch('/reports/:id', can('platform.reports.manage'), async (req, res, next) => {
  try {
    const filter = req.query.serverId ? { serverId: String(req.query.serverId) } : {};
    res.json(await ts.updateReport(req.user.id, req.params.id, req.body || {}, filter));
  } catch (e) { serviceError(res, e); }
});

router.post('/reports/:id/notes', can('platform.cases.manage'), async (req, res, next) => {
  try {
    const filter = req.query.serverId ? { serverId: String(req.query.serverId) } : {};
    res.status(201).json(await ts.addNote(req.user.id, req.params.id,
      (req.body || {}).body || (req.body || {}).note, filter));
  } catch (e) { serviceError(res, e); }
});

router.post('/reports/:id/evidence', can('platform.cases.manage'), async (req, res, next) => {
  try {
    const filter = req.query.serverId ? { serverId: String(req.query.serverId) } : {};
    res.status(201).json(await ts.addEvidence(req.user.id, req.params.id, req.body || {}, filter));
  } catch (e) { serviceError(res, e); }
});

// --- appeals ---------------------------------------------------------------

router.get('/appeals', can('platform.appeals.view'), async (req, res, next) => {
  try {
    const filter = req.query.serverId
      ? { serverId: String(req.query.serverId) }
      : { platformOnly: true };
    res.json(await ts.listAppeals(req.query || {}, filter));
  } catch (e) { serviceError(res, e); }
});

router.get('/appeals/:id', can('platform.appeals.view'), async (req, res, next) => {
  try {
    const filter = req.query.serverId
      ? { serverId: String(req.query.serverId) }
      : { platformOnly: true };
    const row = await ts.getAppeal(req.params.id, filter);
    if (!row) return fail(res, 'NOT_FOUND', 'appeal not found');
    res.json(row);
  } catch (e) { next(e); }
});

router.patch('/appeals/:id', can('platform.appeals.decide'), async (req, res, next) => {
  try {
    const body = req.body || {};
    const filter = req.query.serverId
      ? { serverId: String(req.query.serverId) }
      : { platformOnly: true };
    if (body.status && !body.decision) {
      return res.json(await ts.updateAppealStatus(req.user.id, req.params.id, body.status, filter));
    }
    res.json(await ts.decideAppeal(req.user.id, req.params.id, body, filter));
  } catch (e) { serviceError(res, e); }
});

router.post('/appeals/:id/notes', can('platform.cases.manage'), async (req, res, next) => {
  try {
    const filter = req.query.serverId
      ? { serverId: String(req.query.serverId) }
      : { platformOnly: true };
    const appeal = await ts.getAppeal(req.params.id, filter);
    if (!appeal) return fail(res, 'NOT_FOUND', 'appeal not found');
    const note = await cases.addNote(appeal.caseId, req.user.id,
      (req.body || {}).body || (req.body || {}).note, filter);
    await enforcement.audit(req.user.id, 'CASE_NOTE_ADDED', 'appeal', appeal.id, note.body, {
      caseId: appeal.caseId, serverId: appeal.serverId || null,
    });
    res.status(201).json(note);
  } catch (e) { serviceError(res, e); }
});

// --- GDPR erasure requests -------------------------------------------------

router.get('/gdpr/requests', can('platform.gdpr.manage'), async (req, res, next) => {
  try {
    const rows = await deletion.listRequests(req.query || {});
    res.json(rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      username: r.username,
      status: r.status,
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

router.post('/gdpr/requests/:id/review', can('platform.gdpr.manage'), async (req, res, next) => {
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

router.post('/gdpr/requests/:id/process', can('platform.gdpr.manage'), async (req, res, next) => {
  try {
    const body = req.body || {};
    if (body.confirm !== 'ERASE') return fail(res, 'VALIDATION_ERROR', 'type ERASE to confirm');
    await deletion.beginProcessing({ requestId: req.params.id, actorId: req.user.id });
    const row = await db.get('SELECT user_id FROM account_deletion_requests WHERE id = ?', [req.params.id]);
    try { gateway.disconnectUser(row.user_id); } catch { /* gateway not wired */ }
    const report = await deletion.eraseAccount({ userId: row.user_id, actorId: req.user.id });
    res.json({ ok: true, report });
  } catch (e) { serviceError(res, e); }
});

// --- audit -----------------------------------------------------------------

router.get('/audit', can('platform.audit.view'), async (req, res, next) => {
  try {
    const limit = intParam(req.query.limit, 50, 200);
    const where = [];
    const params = [];
    if (req.query.actorId) { where.push('a.actor_id = ?'); params.push(req.query.actorId); }
    if (req.query.action) { where.push('a.action = ?'); params.push(req.query.action); }
    if (req.query.targetId) { where.push('a.target_id = ?'); params.push(req.query.targetId); }
    if (req.query.caseId) { where.push('a.case_id = ?'); params.push(req.query.caseId); }
    if (req.query.serverId) { where.push('a.server_id = ?'); params.push(req.query.serverId); }
    const q = where.length ? 'WHERE ' + where.join(' AND ') : '';
    res.json(await db.all(
      `SELECT a.*, actor.username AS actor_name,
              target.username AS target_name,
              s.name AS server_name
       FROM audit_logs a
       LEFT JOIN users actor ON actor.id = a.actor_id
       LEFT JOIN users target ON target.id = a.target_id
       LEFT JOIN servers s ON s.id = a.server_id
       ${q} ORDER BY a.created_at DESC, a.id DESC LIMIT ${limit}`,
      params
    ));
  } catch (e) { next(e); }
});

router.get('/audit/verify', can('platform.audit.verify'), async (req, res, next) => {
  try {
    res.json(await audit.verify());
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.setGateway = setGateway;
