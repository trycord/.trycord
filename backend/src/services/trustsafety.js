// Reports, cases and appeals.
//
// The report is what a member filed; the case is what Trust & Safety owns.
// They are created together, but only the case carries the internal notes,
// evidence, assignments and linked actions. Community surfaces see the same
// records through a server_id filter - never through a client-supplied scope.
const db = require('../db');
const { now, uuid, isMember } = require('../util');
const cases = require('./cases');
const audit = require('./audit');
const notifications = require('./notifications');

const REPORT_STATUSES = ['OPEN', 'UNDER_REVIEW', 'ASSIGNED', 'ESCALATED', 'RESOLVED', 'DISMISSED'];
const APPEAL_STATUSES = ['OPEN', 'UNDER_REVIEW', 'APPROVED', 'DENIED'];
const APPEALABLE_ACTIONS = [
  'WARNING', 'SUSPENSION', 'ACCOUNT_BAN', 'SERVER_SUSPENSION', 'SERVER_REMOVAL',
  'COMMUNITY_WARNING', 'COMMUNITY_BAN', 'COMMUNITY_TIMEOUT',
];

function bad(message) {
  const e = new Error(message);
  e.code = 'VALIDATION_ERROR';
  throw e;
}

function notFound(message) {
  const e = new Error(message || 'not found');
  e.code = 'NOT_FOUND';
  throw e;
}

function conflict(message) {
  const e = new Error(message);
  e.code = 'CONFLICT';
  throw e;
}

function normalizeReportStatus(value) {
  const status = String(value || '').toUpperCase();
  return status === 'INVESTIGATING' ? 'UNDER_REVIEW' : status;
}

function upper(value, allowed, fallback, label) {
  if (value == null || value === '') return fallback;
  const v = String(value).toUpperCase();
  if (!allowed.includes(v)) bad('unknown ' + label);
  return v;
}

function json(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function shapeReport(row) {
  if (!row) return null;
  return {
    id: row.id,
    caseId: row.case_id,
    reporterId: row.reporter_id,
    reporterName: row.reporter_name || null,
    reporterDisplay: row.reporter_display || null,
    targetType: row.target_type,
    targetId: row.target_id,
    serverId: row.server_id,
    serverName: row.server_name || null,
    reason: row.reason,
    category: row.category || 'OTHER',
    severity: row.severity || 'MEDIUM',
    priority: row.priority || 'NORMAL',
    description: row.description,
    targetSnapshot: json(row.target_snapshot),
    status: normalizeReportStatus(row.status),
    assignedAdminId: row.assigned_admin_id,
    assigneeName: row.assignee_name || null,
    assigneeDisplay: row.assignee_display || null,
    resolution: row.resolution,
    resolutionNote: row.resolution_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
    lastActivityAt: row.last_activity_at || row.updated_at,
  };
}

function shapeAppeal(row) {
  if (!row) return null;
  return {
    id: row.id,
    caseId: row.case_id,
    serverId: row.server_id,
    serverName: row.server_name || null,
    userId: row.user_id,
    userName: row.user_name || null,
    userDisplay: row.user_display || null,
    actionId: row.action_id,
    actionType: row.action_type,
    actionReason: row.action_reason,
    actionTargetType: row.action_target_type,
    actionTargetId: row.action_target_id,
    reason: row.reason,
    status: row.status,
    decision: row.decision,
    decisionNote: row.decision_note,
    reviewerId: row.reviewer_id,
    reviewerName: row.reviewer_name || null,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// --- target snapshots ------------------------------------------------------

// Freeze what was reported. The original may be edited or deleted; the case
// must still show what the reporter saw at the moment they reported it.
async function snapshotTarget(targetType, targetId, reporterId, suppliedServerId) {
  if (targetType === 'message') {
    const row = await db.get(
      `SELECT m.id, m.content, m.created_at, m.author_id, m.channel_id,
              c.name AS channel_name, c.server_id, s.name AS server_name,
              u.username AS author_name, u.display_name AS author_display
       FROM messages m JOIN channels c ON c.id = m.channel_id
       JOIN servers s ON s.id = c.server_id JOIN users u ON u.id = m.author_id
       WHERE m.id = ?`,
      [targetId]
    );
    if (!row) notFound('message not found');
    if (!(await isMember(reporterId, row.server_id))) {
      const e = new Error('you are not a member of that community');
      e.code = 'NOT_A_MEMBER'; throw e;
    }
    const attachments = await db.all(
      'SELECT id, filename, mime, size, url FROM attachments WHERE message_id = ?', [targetId]
    );
    return {
      serverId: row.server_id,
      subjectType: 'message',
      subjectId: row.id,
      title: 'Message in #' + row.channel_name + ' — ' + row.server_name,
      snapshot: {
        id: row.id, content: String(row.content || '').slice(0, 4000),
        authorId: row.author_id, authorName: row.author_name,
        authorDisplay: row.author_display || null,
        channelId: row.channel_id, channelName: row.channel_name,
        serverId: row.server_id, serverName: row.server_name,
        createdAt: row.created_at, attachments,
      },
    };
  }
  if (targetType === 'channel') {
    const row = await db.get(
      `SELECT c.id, c.name, c.topic, c.type, c.server_id, s.name AS server_name
       FROM channels c JOIN servers s ON s.id = c.server_id WHERE c.id = ?`,
      [targetId]
    );
    if (!row) notFound('channel not found');
    if (!(await isMember(reporterId, row.server_id))) {
      const e = new Error('you are not a member of that community');
      e.code = 'NOT_A_MEMBER'; throw e;
    }
    return {
      serverId: row.server_id,
      subjectType: 'channel',
      subjectId: row.id,
      title: 'Channel #' + row.name + ' — ' + row.server_name,
      snapshot: { ...row },
    };
  }
  if (targetType === 'attachment') {
    const row = await db.get(
      `SELECT a.id, a.filename, a.mime, a.size, a.url, a.message_id,
              m.channel_id, m.server_id, m.author_id
       FROM attachments a JOIN messages m ON m.id = a.message_id
       JOIN channels c ON c.id = m.channel_id LEFT JOIN servers s ON s.id = c.server_id
       WHERE a.id = ?`,
      [targetId]
    );
    if (!row) notFound('attachment not found');
    if (row.server_id && !(await isMember(reporterId, row.server_id))) {
      const e = new Error('you are not a member of that community');
      e.code = 'NOT_A_MEMBER'; throw e;
    }
    return {
      serverId: row.server_id || null,
      subjectType: 'attachment',
      subjectId: row.id,
      title: 'Attachment ' + row.filename,
      snapshot: { ...row },
    };
  }
  if (targetType === 'dm') {
    const row = await db.get(
      `SELECT m.id, m.content, m.created_at, m.author_id, m.conversation_id,
              u.username AS author_name, u.display_name AS author_display
       FROM dm_messages m JOIN users u ON u.id = m.author_id WHERE m.id = ?`,
      [targetId]
    );
    if (!row) notFound('direct message not found');
    const member = await db.get(
      'SELECT 1 AS yes FROM dm_members WHERE conversation_id = ? AND user_id = ?',
      [row.conversation_id, reporterId]
    );
    if (!member) {
      const e = new Error('you are not part of that conversation');
      e.code = 'NOT_A_MEMBER'; throw e;
    }
    return {
      serverId: null,
      subjectType: 'dm',
      subjectId: row.id,
      title: 'Direct message',
      snapshot: {
        id: row.id, content: String(row.content || '').slice(0, 4000),
        authorId: row.author_id, authorName: row.author_name,
        authorDisplay: row.author_display || null,
        conversationId: row.conversation_id, createdAt: row.created_at,
      },
    };
  }
  if (targetType === 'user') {
    const row = await db.get(
      `SELECT id, username, display_name, created_at, enforcement_state,
              enforcement_expires_at, bio, avatar_url
       FROM users WHERE id = ?`, [targetId]
    );
    if (!row) notFound('user not found');
    let serverId = suppliedServerId || null;
    if (serverId && !(await isMember(reporterId, serverId))) {
      const e = new Error('you are not a member of that community');
      e.code = 'NOT_A_MEMBER'; throw e;
    }
    return {
      serverId,
      subjectType: 'user',
      subjectId: row.id,
      title: 'Account @' + row.username,
      snapshot: { ...row, bio: row.bio ? String(row.bio).slice(0, 2000) : null },
    };
  }
  if (targetType === 'server') {
    const row = await db.get(
      `SELECT s.id, s.name, s.description, s.owner_id, s.created_at, s.enforcement_state,
              s.enforcement_reason, u.username AS owner_name
       FROM servers s JOIN users u ON u.id = s.owner_id WHERE s.id = ?`, [targetId]
    );
    if (!row) notFound('server not found');
    return {
      serverId: row.id,
      subjectType: 'server',
      subjectId: row.id,
      title: 'Community ' + row.name,
      snapshot: { ...row },
    };
  }
  bad('unsupported report target type');
}

// --- reports ---------------------------------------------------------------

async function create(reporterId, input) {
  const targetType = String((input && input.targetType) || '').toLowerCase().slice(0, 32);
  const targetId = String((input && input.targetId) || '').slice(0, 64);
  const reason = String((input && input.reason) || '').trim().slice(0, 255);
  const description = String((input && input.description) || '').trim().slice(0, 4000);
  if (!targetType || !targetId || !reason) bad('targetType, targetId and reason are required');
  if (!/^(user|server|message|channel|dm|attachment)$/.test(targetType)) bad('unsupported report target type');
  const category = upper(input.category, cases.CATEGORIES, 'OTHER', 'report category');
  const severity = upper(input.severity, cases.SEVERITIES, 'MEDIUM', 'severity');
  const priority = upper(input.priority, cases.PRIORITIES,
    severity === 'CRITICAL' ? 'URGENT' : severity === 'HIGH' ? 'HIGH' : 'NORMAL', 'priority');

  const snapshot = await snapshotTarget(targetType, targetId, reporterId, input.serverId);
  const serverId = snapshot.serverId || null;
  const scope = serverId ? 'community' : 'platform';
  const ts = now();
  const caseRow = await cases.create({
    scope,
    serverId,
    subjectType: snapshot.subjectType,
    subjectId: snapshot.subjectId,
    title: snapshot.title,
    category,
    severity,
    priority,
    status: 'OPEN',
    reporterId,
    summary: description || reason,
    actorId: reporterId,
  });

  const id = uuid();
  await db.run(
    `INSERT INTO reports
       (id, case_id, reporter_id, target_type, target_id, server_id, reason, category,
        severity, priority, description, target_snapshot, status, created_at, updated_at,
        last_activity_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?)`,
    [id, caseRow.id, reporterId, targetType, targetId, serverId, reason, category,
      severity, priority, description || null, JSON.stringify(snapshot.snapshot), ts, ts, ts]
  );
  await cases.linkReport(caseRow.id, id);
  await cases.addEvidence(caseRow.id, reporterId, {
    kind: 'TARGET_SNAPSHOT',
    referenceId: targetId,
    content: JSON.stringify(snapshot.snapshot, null, 2),
    metadata: { targetType, capturedAt: ts },
    note: 'Snapshot captured when the report was filed',
  });
  if (description) {
    await cases.addEvidence(caseRow.id, reporterId, {
      kind: 'REPORTER_STATEMENT', content: description,
      metadata: { reason },
    });
  }
  await cases.addEvent(caseRow.id, reporterId, 'REPORT_FILED', reason,
    { reportId: id, category, severity, priority });
  await audit.record(reporterId, 'REPORT_CREATED', targetType, targetId, reason, {
    reportId: id, caseId: caseRow.id, serverId,
    metadata: { category, severity, priority },
  });
  try {
    await notifications.create(reporterId, 'report_update', null, id, {
      detail: 'Your report was received and added to the moderation queue.',
      dedupeKey: 'report:received:' + id,
    });
  } catch { /* the report is already durable */ }

  return {
    id, caseId: caseRow.id, status: 'OPEN', targetType, targetId,
    serverId, reason, category, severity, priority,
  };
}

async function mine(userId) {
  const rows = await db.all(
    `SELECT r.id, r.case_id AS caseId, r.target_type AS targetType, r.target_id AS targetId,
            r.reason, r.category, r.severity, r.priority, r.status,
            r.resolution, r.resolution_note AS resolutionNote,
            r.created_at AS createdAt, r.updated_at AS updatedAt
     FROM reports r WHERE r.reporter_id = ?
     ORDER BY r.created_at DESC LIMIT 100`,
    [userId]
  );
  return rows.map((r) => ({ ...r, status: normalizeReportStatus(r.status) }));
}

async function list(input = {}, filter = {}) {
  const where = [];
  const params = [];
  if (filter.serverId) {
    where.push('r.server_id = ?');
    params.push(String(filter.serverId));
  } else if (filter.platformOnly) {
    where.push('r.server_id IS NULL');
  }
  if (input.status) {
    const status = normalizeReportStatus(input.status);
    if (!REPORT_STATUSES.includes(status)) bad('unknown report status');
    if (status === 'UNDER_REVIEW') where.push("r.status IN ('UNDER_REVIEW', 'INVESTIGATING')");
    else { where.push('r.status = ?'); params.push(status); }
  }
  if (input.category) { where.push('r.category = ?'); params.push(upper(input.category, cases.CATEGORIES, 'OTHER', 'report category')); }
  if (input.severity) { where.push('r.severity = ?'); params.push(upper(input.severity, cases.SEVERITIES, 'MEDIUM', 'severity')); }
  if (input.priority) { where.push('r.priority = ?'); params.push(upper(input.priority, cases.PRIORITIES, 'NORMAL', 'priority')); }
  if (input.assigneeId) { where.push('r.assigned_admin_id = ?'); params.push(String(input.assigneeId)); }
  if (input.targetType) { where.push('r.target_type = ?'); params.push(String(input.targetType)); }
  if (input.q) {
    where.push('(r.reason LIKE ? OR r.description LIKE ? OR r.id LIKE ? OR u.username LIKE ?)');
    const q = '%' + String(input.q).slice(0, 100) + '%';
    params.push(q, q, q, q);
  }
  const limit = Math.min(Math.max(parseInt(input.limit, 10) || 50, 1), 100);
  const offset = Math.max(parseInt(input.offset, 10) || 0, 0);
  const q = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = await db.all(
    `SELECT r.*, u.username AS reporter_name, u.display_name AS reporter_display,
            a.username AS assignee_name, a.display_name AS assignee_display,
            s.name AS server_name
     FROM reports r LEFT JOIN users u ON u.id = r.reporter_id
     LEFT JOIN users a ON a.id = r.assigned_admin_id
     LEFT JOIN servers s ON s.id = r.server_id
     ${q} ORDER BY
       CASE r.priority WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 ELSE 2 END,
       r.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
    params
  );
  return rows.map(shapeReport);
}

async function getReport(id, filter = {}) {
  const where = ['r.id = ?'];
  const params = [id];
  if (filter.serverId) { where.push('r.server_id = ?'); params.push(filter.serverId); }
  if (filter.platformOnly) where.push('r.server_id IS NULL');
  const row = await db.get(
    `SELECT r.*, u.username AS reporter_name, u.display_name AS reporter_display,
            a.username AS assignee_name, a.display_name AS assignee_display,
            s.name AS server_name
     FROM reports r LEFT JOIN users u ON u.id = r.reporter_id
     LEFT JOIN users a ON a.id = r.assigned_admin_id
     LEFT JOIN servers s ON s.id = r.server_id
     WHERE ${where.join(' AND ')}`,
    params
  );
  return shapeReport(row);
}

async function updateReport(actorId, id, input, filter = {}) {
  const row = await getReport(id, filter);
  if (!row) notFound('report not found');
  const next = input.status === undefined ? row.status : normalizeReportStatus(input.status);
  if (!REPORT_STATUSES.includes(next)) bad('unknown report status');
  if (input.assigneeId) {
    const assignee = await db.get('SELECT id FROM users WHERE id = ?', [input.assigneeId]);
    if (!assignee) bad('assignee does not exist');
  }
  const category = input.category === undefined ? row.category : upper(input.category, cases.CATEGORIES, row.category, 'report category');
  const severity = input.severity === undefined ? row.severity : upper(input.severity, cases.SEVERITIES, row.severity, 'severity');
  const priority = input.priority === undefined ? row.priority : upper(input.priority, cases.PRIORITIES, row.priority, 'priority');
  const assignee = input.assigneeId === undefined ? row.assignedAdminId : (input.assigneeId || null);
  const note = String(input.note || input.resolutionNote || '').trim();
  const ts = now();
  const closed = next === 'RESOLVED' || next === 'DISMISSED';
  const resolution = closed ? next : null;
  await db.run(
    `UPDATE reports SET status = ?, assigned_admin_id = ?, category = ?, severity = ?,
       priority = ?, resolution = ?, resolution_note = COALESCE(?, resolution_note),
       updated_at = ?, last_activity_at = ?, resolved_at = ? WHERE id = ?`,
    [next, assignee, category, severity, priority, resolution,
      note || null, ts, ts, closed ? (row.resolvedAt || ts) : null, id]
  );
  await cases.update(row.caseId, actorId, {
    status: next,
    category,
    severity,
    priority,
    assigneeId: assignee,
    resolution: closed ? (note || resolution) : undefined,
    note: note || undefined,
  }, filter.serverId ? { scope: 'community', serverId: filter.serverId } : {});
  await cases.addEvent(row.caseId, actorId, 'REPORT_' + next, note || null, {
    reportId: id, from: row.status, to: next,
  });
  await audit.record(actorId, 'REPORT_' + next, 'report', id, note || ('status: ' + next), {
    reportId: id,
    caseId: row.caseId,
    serverId: row.serverId,
    metadata: { from: row.status, to: next, assignedAdminId: assignee, category, severity, priority },
  });
  if (next !== row.status) {
    try {
      await notifications.create(row.reporterId, 'report_update', actorId, id, {
        detail: 'Your report is now ' + next.replace(/_/g, ' ').toLowerCase() + '.',
        dedupeKey: 'report:' + id + ':status:' + next,
      });
    } catch { /* the report is already updated */ }
  }
  return getReport(id, filter);
}

async function addNote(actorId, id, body, filter = {}) {
  const row = await getReport(id, filter);
  if (!row) notFound('report not found');
  const note = await cases.addNote(row.caseId, actorId, body, filter.serverId
    ? { scope: 'community', serverId: filter.serverId } : {});
  await audit.record(actorId, 'CASE_NOTE_ADDED', 'report', id, body, {
    reportId: id, caseId: row.caseId, serverId: row.serverId,
  });
  return note;
}

async function addEvidence(actorId, id, input, filter = {}) {
  const row = await getReport(id, filter);
  if (!row) notFound('report not found');
  const evidence = await cases.addEvidence(row.caseId, actorId, input, filter.serverId
    ? { scope: 'community', serverId: filter.serverId } : {});
  await audit.record(actorId, 'CASE_EVIDENCE_ADDED', 'report', id,
    input.note || input.kind || 'evidence', {
      reportId: id, caseId: row.caseId, serverId: row.serverId,
      metadata: { kind: evidence.kind, evidenceId: evidence.id },
    });
  return evidence;
}

// --- appeals ---------------------------------------------------------------

async function actionLiveState(action) {
  if (!action) return { live: false, reason: 'the action no longer exists' };
  if (!APPEALABLE_ACTIONS.includes(action.action_type)) {
    return { live: false, reason: 'this action cannot be appealed' };
  }
  if (action.status && action.status !== 'ACTIVE') {
    return { live: false, reason: 'this action is no longer active' };
  }
  const ts = Date.now();
  if (action.action_type === 'ACCOUNT_BAN' || action.action_type === 'SUSPENSION') {
    const user = await db.get('SELECT enforcement_state, enforcement_expires_at FROM users WHERE id = ?', [action.target_id]);
    if (!user) return { live: false, reason: 'the account no longer exists' };
    if (action.action_type === 'ACCOUNT_BAN' && user.enforcement_state !== 'banned') {
      return { live: false, reason: 'the ban is no longer active' };
    }
    if (action.action_type === 'SUSPENSION') {
      if (user.enforcement_state !== 'suspended') return { live: false, reason: 'the suspension is no longer active' };
      if (user.enforcement_expires_at && new Date(user.enforcement_expires_at).getTime() <= ts) {
        return { live: false, reason: 'the suspension has expired' };
      }
      return { live: true, until: user.enforcement_expires_at || null };
    }
    return { live: true };
  }
  if (action.action_type === 'WARNING') {
    if (action.expires_at && new Date(action.expires_at).getTime() <= ts) {
      return { live: false, reason: 'the warning has expired' };
    }
    return { live: true };
  }
  if (action.action_type === 'SERVER_SUSPENSION' || action.action_type === 'SERVER_REMOVAL') {
    const server = await db.get('SELECT enforcement_state, enforcement_expires_at, deleted_at FROM servers WHERE id = ?', [action.target_id]);
    if (!server) return { live: false, reason: 'the community no longer exists' };
    const expected = action.action_type === 'SERVER_REMOVAL' ? 'removed' : 'suspended';
    if (server.enforcement_state !== expected) return { live: false, reason: 'that community action is no longer active' };
    if (expected === 'suspended' && server.enforcement_expires_at
      && new Date(server.enforcement_expires_at).getTime() <= ts) {
      return { live: false, reason: 'the community suspension has expired' };
    }
    return { live: true, until: server.enforcement_expires_at || null, serverId: server.id };
  }
  if (action.action_type === 'COMMUNITY_BAN') {
    const ban = await db.get('SELECT * FROM server_bans WHERE server_id = ? AND user_id = ?',
      [action.server_id, action.target_id]);
    if (!ban) return { live: false, reason: 'the community ban is no longer active' };
    if (ban.expires_at && new Date(ban.expires_at).getTime() <= ts) {
      return { live: false, reason: 'the community ban has expired' };
    }
    return { live: true, until: ban.expires_at || null, serverId: action.server_id };
  }
  if (action.action_type === 'COMMUNITY_TIMEOUT') {
    const member = await db.get('SELECT timeout_expires_at FROM server_members WHERE server_id = ? AND user_id = ?',
      [action.server_id, action.target_id]);
    if (!member || !member.timeout_expires_at || new Date(member.timeout_expires_at).getTime() <= ts) {
      return { live: false, reason: 'the timeout has expired' };
    }
    return { live: true, until: member.timeout_expires_at, serverId: action.server_id };
  }
  if (action.action_type === 'COMMUNITY_WARNING') {
    if (action.expires_at && new Date(action.expires_at).getTime() <= ts) {
      return { live: false, reason: 'the warning has expired' };
    }
    return { live: true, serverId: action.server_id };
  }
  return { live: false, reason: 'this action cannot be appealed' };
}

async function appellantFor(action) {
  if (action.target_type === 'user') return action.target_id;
  if (action.target_type === 'server') {
    const server = await db.get('SELECT owner_id FROM servers WHERE id = ?', [action.target_id]);
    return server ? server.owner_id : null;
  }
  return null;
}

async function submitAppeal(input) {
  const actionId = String((input && input.actionId) || '');
  const reason = String((input && input.reason) || '').trim().slice(0, 4000);
  if (!actionId || !reason) bad('actionId and reason are required');
  const action = await db.get('SELECT * FROM moderation_actions WHERE id = ?', [actionId]);
  if (!action) notFound('action not found');
  const live = await actionLiveState(action);
  if (!live.live) bad(live.reason || 'this action is no longer active');
  const appellantId = await appellantFor(action);
  if (!appellantId) bad('this action has no accountable account');
  const existing = await db.get(
    `SELECT id, status FROM appeals WHERE action_id = ? AND status IN ('OPEN', 'UNDER_REVIEW')`,
    [actionId]
  );
  if (existing) conflict('an appeal for this action is already pending');
  const decided = await db.get(
    `SELECT id FROM appeals WHERE action_id = ? AND status = 'APPROVED'`, [actionId]
  );
  if (decided) conflict('this action has already been overturned');

  let caseId = action.case_id;
  if (!caseId) {
    const caseRow = await cases.forAction(action.id);
    caseId = caseRow ? caseRow.id : null;
  }
  if (!caseId) {
    const created = await cases.create({
      scope: action.server_id ? 'community' : 'platform',
      serverId: action.server_id || null,
      subjectType: action.target_type,
      subjectId: action.target_id,
      title: String(action.action_type).replace(/_/g, ' ').toLowerCase(),
      category: 'OTHER', severity: 'MEDIUM', priority: 'NORMAL', status: 'RESOLVED',
      summary: action.reason, actionId: action.id, actorId: action.actor_id,
    });
    caseId = created.id;
    await cases.linkAction(caseId, action.id);
  }
  const id = uuid();
  const ts = now();
  await db.run(
    `INSERT INTO appeals
       (id, case_id, server_id, user_id, action_id, reason, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'OPEN', ?, ?)`,
    [id, caseId, action.server_id || null, appellantId, action.id, reason, ts, ts]
  );
  await cases.linkAppeal(caseId, id);
  await cases.addEvent(caseId, appellantId, 'APPEAL_SUBMITTED', reason, { appealId: id, actionId });
  await audit.record(appellantId, 'APPEAL_SUBMITTED', 'appeal', id, reason, {
    reportId: action.report_id || null,
    caseId,
    serverId: action.server_id || null,
    metadata: { actionId, actionType: action.action_type },
  });
  try {
    await notifications.create(appellantId, 'appeal_update', null, id, {
      detail: 'Your appeal was received. You can track its status in Safety.',
      dedupeKey: 'appeal:received:' + id,
    });
  } catch { /* the appeal is already durable */ }
  return { id, status: 'OPEN', actionId: action.id, caseId };
}

async function listAppeals(input = {}, filter = {}) {
  const where = [];
  const params = [];
  if (filter.serverId) {
    where.push('a.server_id = ?'); params.push(String(filter.serverId));
  } else if (filter.platformOnly) {
    where.push('a.server_id IS NULL');
  }
  if (input.status) {
    const status = String(input.status).toUpperCase();
    if (!APPEAL_STATUSES.includes(status)) bad('unknown appeal status');
    where.push('a.status = ?'); params.push(status);
  }
  if (input.assigneeId) { where.push('a.reviewer_id = ?'); params.push(String(input.assigneeId)); }
  const limit = Math.min(Math.max(parseInt(input.limit, 10) || 50, 1), 100);
  const q = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = await db.all(
    `SELECT a.*, u.username AS user_name, u.display_name AS user_display,
            m.action_type, m.reason AS action_reason, m.target_type AS action_target_type,
            m.target_id AS action_target_id,
            r.username AS reviewer_name, s.name AS server_name
     FROM appeals a
     JOIN moderation_actions m ON m.id = a.action_id
     JOIN users u ON u.id = a.user_id
     LEFT JOIN users r ON r.id = a.reviewer_id
     LEFT JOIN servers s ON s.id = a.server_id
     ${q} ORDER BY a.created_at DESC LIMIT ${limit}`,
    params
  );
  return rows.map(shapeAppeal);
}

async function getAppeal(id, filter = {}) {
  const where = ['a.id = ?'];
  const params = [id];
  if (filter.serverId) { where.push('a.server_id = ?'); params.push(filter.serverId); }
  if (filter.platformOnly) where.push('a.server_id IS NULL');
  const row = await db.get(
    `SELECT a.*, u.username AS user_name, u.display_name AS user_display,
            m.action_type, m.reason AS action_reason, m.target_type AS action_target_type,
            m.target_id AS action_target_id,
            r.username AS reviewer_name, s.name AS server_name
     FROM appeals a JOIN moderation_actions m ON m.id = a.action_id
     JOIN users u ON u.id = a.user_id
     LEFT JOIN users r ON r.id = a.reviewer_id
     LEFT JOIN servers s ON s.id = a.server_id
     WHERE ${where.join(' AND ')}`,
    params
  );
  if (!row) return null;
  const appeal = shapeAppeal(row);
  appeal.case = row.case_id ? await cases.get(row.case_id, filter.serverId
    ? { scope: 'community', serverId: filter.serverId } : {}) : null;
  return appeal;
}

async function listMine(userId) {
  const rows = await db.all(
    `SELECT a.id, a.case_id AS caseId, a.server_id AS serverId, a.action_id AS actionId,
            a.status, a.decision, a.decision_note AS decisionNote,
            a.created_at AS createdAt, a.updated_at AS updatedAt, a.reviewed_at AS reviewedAt,
            m.action_type AS actionType, m.reason AS actionReason,
            m.target_type AS targetType, m.target_id AS targetId,
            s.name AS serverName
     FROM appeals a JOIN moderation_actions m ON m.id = a.action_id
     LEFT JOIN servers s ON s.id = a.server_id
     WHERE a.user_id = ? ORDER BY a.created_at DESC LIMIT 100`,
    [userId]
  );
  return rows;
}

// What the signed-in account can currently appeal. The same possession rule
// as anonymous submission, but rendered from auth so a member can see their
// own eligible decisions without knowing an id in advance.
async function eligibleAppeals(userId) {
  const actions = await db.all(
    `SELECT m.*, s.name AS server_name, s.owner_id AS server_owner_id
     FROM moderation_actions m LEFT JOIN servers s ON s.id = m.server_id
     WHERE m.status = 'ACTIVE'
       AND (
         (m.target_type = 'user' AND m.target_id = ?)
         OR (m.target_type = 'server' AND s.owner_id = ?)
       )
     ORDER BY m.created_at DESC LIMIT 100`,
    [userId, userId]
  );
  const out = [];
  for (const action of actions) {
    const live = await actionLiveState(action);
    if (!live.live) continue;
    const existing = await db.get(
      `SELECT id, status, decision, decision_note AS decisionNote, created_at AS createdAt
       FROM appeals WHERE action_id = ? ORDER BY created_at DESC LIMIT 1`,
      [action.id]
    );
    let serverName = action.server_name || null;
    if (!serverName && action.server_id) {
      const s = await db.get('SELECT name FROM servers WHERE id = ?', [action.server_id]);
      serverName = s ? s.name : null;
    }
    if (!serverName && action.target_type === 'server') {
      const s = await db.get('SELECT name FROM servers WHERE id = ?', [action.target_id]);
      serverName = s ? s.name : null;
    }
    out.push({
      actionId: action.id,
      caseId: action.case_id,
      actionType: action.action_type,
      reason: action.reason,
      serverId: action.server_id || (action.target_type === 'server' ? action.target_id : null),
      serverName,
      expiresAt: live.until || action.expires_at || null,
      createdAt: action.created_at,
      appeal: existing ? {
        id: existing.id, status: existing.status, decision: existing.decision,
        decisionNote: existing.decisionNote, createdAt: existing.createdAt,
      } : null,
    });
  }
  return out;
}

async function updateAppealStatus(actorId, id, status, filter = {}) {
  const row = await getAppeal(id, filter);
  if (!row) notFound('appeal not found');
  const next = String(status || '').toUpperCase();
  if (!['OPEN', 'UNDER_REVIEW'].includes(next)) bad('an appeal can only be opened or put under review here');
  if (row.status === 'APPROVED' || row.status === 'DENIED') conflict('appeal already decided');
  const ts = now();
  await db.run(
    `UPDATE appeals SET status = ?, reviewer_id = COALESCE(?, reviewer_id), updated_at = ? WHERE id = ?`,
    [next, actorId, ts, id]
  );
  if (row.caseId) {
    await cases.addEvent(row.caseId, actorId, 'APPEAL_' + next, null, { appealId: id });
  }
  await audit.record(actorId, 'APPEAL_' + next, 'appeal', id, null, {
    caseId: row.caseId, serverId: row.serverId,
  });
  return getAppeal(id, filter);
}

async function liftAction(actorId, action, note) {
  if (action.action_type === 'ACCOUNT_BAN' || action.action_type === 'SUSPENSION') {
    return require('./enforcement').liftUserEnforcement(actorId, action.target_id, note);
  }
  if (action.action_type === 'WARNING') {
    const ts = now();
    await db.run(
      `UPDATE moderation_actions SET status = 'LIFTED', lifted_at = ?, lifted_by = ?, updated_at = ? WHERE id = ?`,
      [ts, actorId, ts, action.id]
    );
    return { actionId: action.id, warningRemoved: true };
  }
  if (action.action_type === 'SERVER_SUSPENSION' || action.action_type === 'SERVER_REMOVAL') {
    const enforcement = require('./enforcement');
    if (action.action_type === 'SERVER_REMOVAL') return enforcement.restoreServer(actorId, action.target_id, note);
    return enforcement.liftServerEnforcement(actorId, action.target_id, note);
  }
  const memberships = require('./memberships');
  if (action.action_type === 'COMMUNITY_BAN') {
    return memberships.unban(action.server_id, actorId, action.target_id, note);
  }
  if (action.action_type === 'COMMUNITY_TIMEOUT') {
    return memberships.timeout(action.server_id, actorId, action.target_id, 0);
  }
  if (action.action_type === 'COMMUNITY_WARNING') {
    const ts = now();
    await db.run(
      `UPDATE moderation_actions SET status = 'LIFTED', lifted_at = ?, lifted_by = ?, updated_at = ? WHERE id = ?`,
      [ts, actorId, ts, action.id]
    );
    return { actionId: action.id, warningRemoved: true };
  }
  bad('this action cannot be lifted');
}

async function decideAppeal(actorId, id, input, filter = {}) {
  const decision = String((input && input.decision) || '').toUpperCase();
  if (!['APPROVED', 'DENIED'].includes(decision)) bad('decision must be APPROVED or DENIED');
  const note = String((input && (input.note || input.decisionNote)) || '').trim().slice(0, 4000);
  if (decision === 'DENIED' && !note) bad('a denial must explain the decision');
  const row = await getAppeal(id, filter);
  if (!row) notFound('appeal not found');
  if (row.status === 'APPROVED' || row.status === 'DENIED') conflict('appeal already decided');
  const action = await db.get('SELECT * FROM moderation_actions WHERE id = ?', [row.actionId]);
  if (!action) notFound('the action this appeal concerns no longer exists');
  if (decision === 'APPROVED') {
    const live = await actionLiveState(action);
    if (!live.live) conflict('this action is no longer active; deny the appeal or close it for another reason');
  }
  const ts = now();
  await db.run(
    `UPDATE appeals SET status = ?, decision = ?, decision_note = ?, reviewer_id = ?,
       reviewed_at = ?, updated_at = ? WHERE id = ?`,
    [decision, decision, note || null, actorId, ts, ts, id]
  );
  if (decision === 'APPROVED') {
    await liftAction(actorId, action, 'appeal granted: ' + (note || 'no note supplied'));
  }
  if (row.caseId) {
    await cases.update(row.caseId, actorId, {
      status: 'RESOLVED',
      resolution: decision + (note ? ': ' + note : ''),
      note: 'Appeal ' + decision.toLowerCase() + (note ? ': ' + note : ''),
    }, filter.serverId ? { scope: 'community', serverId: filter.serverId } : {});
    await cases.addEvent(row.caseId, actorId, 'APPEAL_' + decision, note || null, {
      appealId: id, actionId: action.id, decision,
    });
  }
  await audit.record(actorId, 'APPEAL_' + decision, 'appeal', id, note, {
    caseId: row.caseId, serverId: row.serverId,
    metadata: { actionId: action.id, actionType: action.action_type, decision },
  });
  try {
    await notifications.create(row.userId, 'appeal_update', actorId, id, {
      detail: decision === 'APPROVED'
        ? 'Your appeal was approved and the decision was lifted.'
        : 'Your appeal was reviewed and denied.' + (note ? ' Reason: ' + note.slice(0, 220) : ''),
      dedupeKey: 'appeal:decision:' + id,
    });
  } catch { /* the decision is already durable */ }
  return getAppeal(id, filter);
}

module.exports = {
  REPORT_STATUSES,
  APPEAL_STATUSES,
  APPEALABLE_ACTIONS,
  create,
  mine,
  list,
  get: getReport,
  getReport,
  updateStatus: updateReport,
  updateReport,
  addNote,
  addEvidence,
  actionLiveState,
  submitAppeal,
  listAppeals,
  getAppeal,
  listMine,
  eligibleAppeals,
  updateAppealStatus,
  decideAppeal,
};
