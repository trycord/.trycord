// Community moderation: reports, cases, warnings, appeals and history.
//
// Mounted under /api/servers/:serverId/moderation with mergeParams. Every
// scope is the community in the URL; no report, case or appeal id can widen a
// moderator's reach beyond it. The access chain resolves the community once,
// then each route declares the moderation family it needs.
const express = require('express');
const auth = require('../middleware/auth');
const { resolveServer, requireAnyPerm, requirePerm } = require('../middleware/serverAccess');
const rateLimit = require('../middleware/ratelimit');
const { fail, serviceError } = require('../errors');
const db = require('../db');
const ts = require('../services/trustsafety');
const cases = require('../services/cases');
const memberships = require('../services/memberships');
const enforcement = require('../services/enforcement');
const audit = require('../services/audit');

const router = express.Router({ mergeParams: true });
router.use(auth, resolveServer);
router.use(rateLimit({ windowMs: 60000, max: 300 }));

// Who may work the moderation queue. MANAGE_REPORTS is the dedicated grant;
// the older moderation permissions are included so existing communities do not
// lose access to a queue they already run.
const MODERATION = ['MANAGE_REPORTS', 'KICK_MEMBERS', 'BAN_MEMBERS', 'MANAGE_MESSAGES', 'MANAGE_SERVER'];
const REPORTS = ['MANAGE_REPORTS', 'BAN_MEMBERS', 'KICK_MEMBERS', 'MANAGE_SERVER'];

const mod = requireAnyPerm(MODERATION);
const reports = requireAnyPerm(REPORTS);

function scoped(id) {
  return { scope: 'community', serverId: id };
}

// --- overview --------------------------------------------------------------

router.get('/overview', mod, async (req, res, next) => {
  try {
    const serverId = req.server.id;
    const [openReports, openCases, openAppeals, activeWarnings, activeBans, activeTimeouts, settings] = await Promise.all([
      db.get("SELECT COUNT(*) AS n FROM reports WHERE server_id = ? AND status IN ('OPEN','INVESTIGATING','UNDER_REVIEW','ASSIGNED','ESCALATED')", [serverId]),
      db.get("SELECT COUNT(*) AS n FROM moderation_cases WHERE server_id = ? AND scope = 'community' AND status IN ('OPEN','UNDER_REVIEW','ASSIGNED','ESCALATED')", [serverId]),
      db.get("SELECT COUNT(*) AS n FROM appeals WHERE server_id = ? AND status IN ('OPEN','UNDER_REVIEW')", [serverId]),
      db.get("SELECT COUNT(*) AS n FROM moderation_actions WHERE server_id = ? AND action_type = 'COMMUNITY_WARNING' AND status = 'ACTIVE' AND (expires_at IS NULL OR expires_at > ?)", [serverId, new Date().toISOString()]),
      db.get("SELECT COUNT(*) AS n FROM server_bans WHERE server_id = ? AND (expires_at IS NULL OR expires_at > ?)", [serverId, new Date().toISOString()]),
      db.get("SELECT COUNT(*) AS n FROM server_members WHERE server_id = ? AND timeout_expires_at IS NOT NULL AND timeout_expires_at > ?", [serverId, new Date().toISOString()]),
      memberships.getModerationSettings(serverId),
    ]);
    res.json({
      openReports: openReports.n,
      openCases: openCases.n,
      openAppeals: openAppeals.n,
      activeWarnings: activeWarnings.n,
      activeBans: activeBans.n,
      activeTimeouts: activeTimeouts.n,
      settings,
    });
  } catch (e) { next(e); }
});

// --- settings --------------------------------------------------------------

router.get('/settings', mod, async (req, res, next) => {
  try {
    res.json(await memberships.getModerationSettings(req.server.id));
  } catch (e) { next(e); }
});

router.patch('/settings', requirePerm('MANAGE_SERVER'), async (req, res, next) => {
  try {
    const settings = await memberships.setModerationSettings(req.server.id, req.body || {}, req.user.id);
    res.json(settings);
  } catch (e) { serviceError(res, e); }
});

// --- reports ---------------------------------------------------------------

router.get('/reports', reports, async (req, res, next) => {
  try {
    res.json(await ts.list(req.query || {}, { serverId: req.server.id }));
  } catch (e) { serviceError(res, e); }
});

router.get('/reports/:id', reports, async (req, res, next) => {
  try {
    const row = await ts.getReport(req.params.id, { serverId: req.server.id });
    if (!row) return fail(res, 'NOT_FOUND', 'report not found');
    row.case = row.caseId ? await cases.get(row.caseId, scoped(req.server.id)) : null;
    if (row.targetType === 'user') {
      row.targetUser = await db.get(
        `SELECT u.id, u.username, u.display_name, m.timeout_expires_at,
                (SELECT COUNT(*) FROM server_bans b WHERE b.server_id = ? AND b.user_id = u.id
                  AND (b.expires_at IS NULL OR b.expires_at > ?)) AS banned
         FROM users u LEFT JOIN server_members m ON m.user_id = u.id AND m.server_id = ?
         WHERE u.id = ?`,
        [req.server.id, new Date().toISOString(), req.server.id, row.targetId]
      );
    }
    res.json(row);
  } catch (e) { next(e); }
});

router.patch('/reports/:id', reports, async (req, res, next) => {
  try {
    const assigneeId = (req.body || {}).assignedAdminId;
    if (assigneeId) {
      const member = await memberships.get(req.server.id, assigneeId);
      if (!member) return fail(res, 'VALIDATION_ERROR', 'an assignee must be a member of this community');
    }
    res.json(await ts.updateReport(req.user.id, req.params.id, req.body || {},
      { serverId: req.server.id }));
  } catch (e) { serviceError(res, e); }
});

router.post('/reports/:id/notes', reports, async (req, res, next) => {
  try {
    const note = await ts.addNote(req.user.id, req.params.id,
      (req.body || {}).body || (req.body || {}).note,
      { serverId: req.server.id });
    res.status(201).json(note);
  } catch (e) { serviceError(res, e); }
});

router.post('/reports/:id/evidence', reports, async (req, res, next) => {
  try {
    res.status(201).json(await ts.addEvidence(req.user.id, req.params.id, req.body || {},
      { serverId: req.server.id }));
  } catch (e) { serviceError(res, e); }
});

// --- cases -----------------------------------------------------------------

router.get('/cases', reports, async (req, res, next) => {
  try {
    res.json(await cases.list(Object.assign({}, req.query || {}, { serverId: req.server.id })));
  } catch (e) { serviceError(res, e); }
});

router.get('/cases/:id', reports, async (req, res, next) => {
  try {
    const row = await cases.get(req.params.id, scoped(req.server.id));
    if (!row) return fail(res, 'NOT_FOUND', 'case not found');
    res.json(row);
  } catch (e) { next(e); }
});

router.patch('/cases/:id', reports, async (req, res, next) => {
  try {
    const updated = await cases.update(req.params.id, req.user.id, req.body || {},
      scoped(req.server.id));
    await enforcement.audit(req.user.id, 'COMMUNITY_CASE_UPDATED', 'case', req.params.id,
      (req.body || {}).note || null, {
        caseId: req.params.id, serverId: req.server.id,
      });
    res.json(updated);
  } catch (e) { serviceError(res, e); }
});

router.post('/cases/:id/notes', reports, async (req, res, next) => {
  try {
    const note = await cases.addNote(req.params.id, req.user.id,
      (req.body || {}).body || (req.body || {}).note, scoped(req.server.id));
    await enforcement.audit(req.user.id, 'CASE_NOTE_ADDED', 'case', req.params.id, note.body, {
      caseId: req.params.id, serverId: req.server.id,
    });
    res.status(201).json(note);
  } catch (e) { serviceError(res, e); }
});

router.post('/cases/:id/evidence', reports, async (req, res, next) => {
  try {
    const evidence = await cases.addEvidence(req.params.id, req.user.id, req.body || {},
      scoped(req.server.id));
    await enforcement.audit(req.user.id, 'CASE_EVIDENCE_ADDED', 'case', req.params.id,
      (req.body || {}).note || (req.body || {}).kind || 'evidence', {
        caseId: req.params.id, serverId: req.server.id,
        metadata: { kind: evidence.kind, evidenceId: evidence.id },
      });
    res.status(201).json(evidence);
  } catch (e) { serviceError(res, e); }
});

// --- warnings --------------------------------------------------------------

router.get('/warnings', mod, async (req, res, next) => {
  try {
    const active = String(req.query.active || '') === '1';
    const where = ["m.server_id = ?", "m.action_type = 'COMMUNITY_WARNING'"];
    const params = [req.server.id];
    if (active) {
      where.push("m.status = 'ACTIVE'");
      where.push('(m.expires_at IS NULL OR m.expires_at > ?)');
      params.push(new Date().toISOString());
    }
    if (req.query.targetId) { where.push('m.target_id = ?'); params.push(req.query.targetId); }
    const rows = await db.all(
      `SELECT m.*, u.username AS target_name, u.display_name AS target_display,
              a.username AS actor_name
       FROM moderation_actions m
       JOIN users u ON u.id = m.target_id
       LEFT JOIN users a ON a.id = m.actor_id
       WHERE ${where.join(' AND ')}
       ORDER BY m.created_at DESC LIMIT 200`,
      params
    );
    res.json(rows);
  } catch (e) { next(e); }
});

router.post('/warnings', mod, async (req, res, next) => {
  try {
    const body = req.body || {};
    if (!body.userId) return fail(res, 'VALIDATION_ERROR', 'userId is required');
    const out = await memberships.warn(req.server.id, req.user.id, body.userId, {
      reason: body.reason,
      expiresInDays: body.expiresInDays,
      minutes: body.minutes,
      reportId: body.reportId,
      category: body.category,
      severity: body.severity,
    });
    res.status(201).json(out);
  } catch (e) { serviceError(res, e); }
});

router.post('/warnings/:actionId/lift', mod, async (req, res, next) => {
  try {
    res.json(await memberships.liftWarning(req.server.id, req.user.id, req.params.actionId,
      (req.body || {}).reason));
  } catch (e) { serviceError(res, e); }
});

// --- appeals ---------------------------------------------------------------

router.get('/appeals', mod, async (req, res, next) => {
  try {
    res.json(await ts.listAppeals(req.query || {}, { serverId: req.server.id }));
  } catch (e) { serviceError(res, e); }
});

router.get('/appeals/:id', mod, async (req, res, next) => {
  try {
    const row = await ts.getAppeal(req.params.id, { serverId: req.server.id });
    if (!row) return fail(res, 'NOT_FOUND', 'appeal not found');
    res.json(row);
  } catch (e) { next(e); }
});

router.patch('/appeals/:id', mod, async (req, res, next) => {
  try {
    const body = req.body || {};
    if (body.status && !body.decision) {
      return res.json(await ts.updateAppealStatus(req.user.id, req.params.id, body.status,
        { serverId: req.server.id }));
    }
    res.json(await ts.decideAppeal(req.user.id, req.params.id, body,
      { serverId: req.server.id }));
  } catch (e) { serviceError(res, e); }
});

router.post('/appeals/:id/notes', mod, async (req, res, next) => {
  try {
    const appeal = await ts.getAppeal(req.params.id, { serverId: req.server.id });
    if (!appeal) return fail(res, 'NOT_FOUND', 'appeal not found');
    const note = await cases.addNote(appeal.caseId, req.user.id,
      (req.body || {}).body || (req.body || {}).note, scoped(req.server.id));
    await enforcement.audit(req.user.id, 'CASE_NOTE_ADDED', 'appeal', appeal.id, note.body, {
      caseId: appeal.caseId, serverId: req.server.id,
    });
    res.status(201).json(note);
  } catch (e) { serviceError(res, e); }
});

// --- one member's moderation record ----------------------------------------

router.get('/members/:userId', mod, async (req, res, next) => {
  try {
    const target = await db.get(
      'SELECT id, username, display_name, avatar_url, created_at FROM users WHERE id = ?',
      [req.params.userId]
    );
    if (!target) return fail(res, 'NOT_FOUND', 'user not found');
    const [member, roles, ban, notes, actions, reports, memberCases, appeals] = await Promise.all([
      db.get('SELECT * FROM server_members WHERE server_id = ? AND user_id = ?',
        [req.server.id, target.id]),
      db.all(
        `SELECT r.id, r.name, r.color, r.position FROM member_roles mr
         JOIN roles r ON r.id = mr.role_id
         WHERE mr.server_id = ? AND mr.user_id = ? ORDER BY r.position DESC`,
        [req.server.id, target.id]
      ),
      db.get(
        `SELECT b.*, a.username AS actor_name FROM server_bans b
         LEFT JOIN users a ON a.id = b.actor_id
         WHERE b.server_id = ? AND b.user_id = ?`,
        [req.server.id, target.id]
      ),
      db.get('SELECT body, updated_at, created_at FROM member_notes WHERE server_id = ? AND user_id = ?',
        [req.server.id, target.id]),
      db.all(
        `SELECT m.*, a.username AS actor_name FROM moderation_actions m
         LEFT JOIN users a ON a.id = m.actor_id
         WHERE m.server_id = ? AND m.target_type = 'user' AND m.target_id = ?
         ORDER BY m.created_at DESC LIMIT 200`,
        [req.server.id, target.id]
      ),
      db.all(
        `SELECT r.id, r.case_id AS caseId, r.target_type AS targetType, r.target_id AS targetId,
                r.reason, r.category, r.severity, r.priority, r.status,
                r.created_at AS createdAt
         FROM reports r WHERE r.server_id = ? AND r.target_type = 'user' AND r.target_id = ?
         ORDER BY r.created_at DESC LIMIT 100`,
        [req.server.id, target.id]
      ),
      cases.list({ serverId: req.server.id, subjectId: target.id, limit: 100 }),
      db.all(
        `SELECT a.id, a.status, a.decision, a.decision_note AS decisionNote,
                a.created_at AS createdAt, a.reviewed_at AS reviewedAt,
                m.action_type AS actionType
         FROM appeals a JOIN moderation_actions m ON m.id = a.action_id
         WHERE a.server_id = ? AND a.user_id = ?
         ORDER BY a.created_at DESC LIMIT 100`,
        [req.server.id, target.id]
      ),
    ]);
    res.json({
      user: target,
      member: member ? {
        joinedAt: member.joined_at,
        nickname: member.nickname,
        timeoutExpiresAt: member.timeout_expires_at,
        timedOut: !!(member.timeout_expires_at && new Date(member.timeout_expires_at).getTime() > Date.now()),
        roles,
      } : null,
      activeBan: ban && (!ban.expires_at || new Date(ban.expires_at).getTime() > Date.now()) ? {
        reason: ban.reason, expiresAt: ban.expires_at, createdAt: ban.created_at,
        actorName: ban.actor_name || null,
      } : null,
      note: notes ? { body: notes.body, createdAt: notes.created_at, updatedAt: notes.updated_at } : null,
      actions,
      activeWarnings: actions.filter((a) => a.action_type === 'COMMUNITY_WARNING'
        && a.status === 'ACTIVE'
        && (!a.expires_at || new Date(a.expires_at).getTime() > Date.now())),
      reports,
      cases: memberCases,
      appeals,
    });
  } catch (e) { next(e); }
});

// --- history and audit -----------------------------------------------------

router.get('/history', mod, async (req, res, next) => {
  try {
    const [actions, bans, resolvedReports, appeals, auditRows] = await Promise.all([
      db.all(
        `SELECT m.*, target.username AS target_name, target.display_name AS target_display,
                actor.username AS actor_name, actor.display_name AS actor_display
         FROM moderation_actions m
         LEFT JOIN users target ON target.id = m.target_id
         LEFT JOIN users actor ON actor.id = m.actor_id
         WHERE m.server_id = ?
         ORDER BY m.created_at DESC LIMIT 200`,
        [req.server.id]
      ),
      memberships.listBans(req.server.id),
      db.all(
        `SELECT id, case_id AS caseId, target_type AS targetType, target_id AS targetId,
                reason, status, resolution_note AS resolutionNote, created_at AS createdAt,
                resolved_at AS resolvedAt
         FROM reports WHERE server_id = ? AND status IN ('RESOLVED','DISMISSED')
         ORDER BY updated_at DESC LIMIT 100`,
        [req.server.id]
      ),
      ts.listAppeals({}, { serverId: req.server.id }),
      db.all(
        `SELECT a.id, a.action, a.target_type AS targetType, a.target_id AS targetId,
                a.reason, a.case_id AS caseId, a.created_at AS createdAt,
                actor.username AS actorName
         FROM audit_logs a LEFT JOIN users actor ON actor.id = a.actor_id
         WHERE a.server_id = ? ORDER BY a.created_at DESC LIMIT 200`,
        [req.server.id]
      ),
    ]);
    res.json({ actions, bans, resolvedReports, appeals, audit: auditRows });
  } catch (e) { next(e); }
});

router.get('/audit', mod, async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 200);
    const where = ['a.server_id = ?'];
    const params = [req.server.id];
    if (req.query.action) { where.push('a.action = ?'); params.push(req.query.action); }
    if (req.query.caseId) { where.push('a.case_id = ?'); params.push(req.query.caseId); }
    res.json(await db.all(
      `SELECT a.*, actor.username AS actor_name, target.username AS target_name
       FROM audit_logs a
       LEFT JOIN users actor ON actor.id = a.actor_id
       LEFT JOIN users target ON target.id = a.target_id
       WHERE ${where.join(' AND ')}
       ORDER BY a.created_at DESC, a.id DESC LIMIT ${limit}`,
      params
    ));
  } catch (e) { next(e); }
});

module.exports = router;
