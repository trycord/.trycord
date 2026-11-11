// Moderation cases: the durable record shared by reports, actions, appeals
// and evidence.
//
// A case is not another name for a report. A warning written by a moderator
// with no report still needs a case, a report about a community needs one
// whose scope is that community, and an appeal needs the whole sequence of
// what happened before it. The case is the thing every one of those attaches
// to; the report is one event in it.
const db = require('../db');
const { now, uuid } = require('../util');

const STATUSES = ['OPEN', 'UNDER_REVIEW', 'ASSIGNED', 'ESCALATED', 'RESOLVED', 'DISMISSED'];
const SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];
const CATEGORIES = [
  'HARASSMENT', 'HATE', 'SPAM', 'SEXUAL_CONTENT', 'VIOLENCE',
  'SELF_HARM', 'IMPERSONATION', 'PRIVACY', 'MISINFORMATION', 'OTHER',
];
const SCOPES = ['platform', 'community'];
const RESTRICTION_KINDS = ['CREATE_COMMUNITIES', 'SEND_MESSAGES', 'VOICE', 'DIRECT_MESSAGES'];

function bad(message) {
  const e = new Error(message);
  e.code = 'VALIDATION_ERROR';
  throw e;
}

function notFound(message) {
  const e = new Error(message || 'case not found');
  e.code = 'NOT_FOUND';
  throw e;
}

function upper(value, allowed, fallback, label) {
  if (value == null || value === '') return fallback;
  const v = String(value).toUpperCase();
  if (!allowed.includes(v)) bad('unknown ' + label);
  return v;
}

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function cleanTitle(value) {
  const title = String(value || '').trim().slice(0, 255);
  return title || 'Moderation case';
}

function scopeWhere(scope, serverId) {
  if (scope === 'platform') return { sql: 'c.scope = ? AND c.server_id IS NULL', params: ['platform'] };
  if (scope === 'community') {
    if (!serverId) bad('a community case needs a community');
    return { sql: 'c.scope = ? AND c.server_id = ?', params: ['community', String(serverId)] };
  }
  return { sql: '1 = 1', params: [] };
}

async function addEvent(caseId, actorId, kind, note, metadata, conn = db) {
  const id = uuid();
  await conn.run(
    'INSERT INTO case_events (id, case_id, actor_id, kind, note, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, caseId, actorId || null, kind, note ? String(note).slice(0, 4000) : null,
      metadata == null ? null : (typeof metadata === 'string' ? metadata : JSON.stringify(metadata)), now()]
  );
  return id;
}

async function create(input, conn = db) {
  const scope = String(input.scope || '').toLowerCase();
  if (!SCOPES.includes(scope)) bad('case scope must be platform or community');
  const serverId = scope === 'community' ? String(input.serverId || '') : null;
  if (scope === 'community' && !serverId) bad('a community case needs a community');
  const id = uuid();
  const ts = now();
  const status = upper(input.status, STATUSES, 'OPEN', 'case status');
  const category = upper(input.category, CATEGORIES, 'OTHER', 'report category');
  const severity = upper(input.severity, SEVERITIES, 'MEDIUM', 'severity');
  const priority = upper(input.priority, PRIORITIES, 'NORMAL', 'priority');
  const closed = status === 'RESOLVED' || status === 'DISMISSED' ? ts : null;
  await conn.run(
    `INSERT INTO moderation_cases
       (id, scope, server_id, subject_type, subject_id, title, category, severity,
        priority, status, assignee_id, reporter_id, report_id, action_id, summary,
        resolution, created_at, updated_at, closed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, scope, serverId, String(input.subjectType || 'unknown').slice(0, 32),
      input.subjectId ? String(input.subjectId).slice(0, 64) : null,
      cleanTitle(input.title), category, severity, priority, status,
      input.assigneeId || null, input.reporterId || null, input.reportId || null,
      input.actionId || null, input.summary ? String(input.summary).slice(0, 8000) : null,
      null, ts, ts, closed]
  );
  await addEvent(id, input.actorId || input.reporterId || null, 'CASE_OPENED',
    input.summary ? String(input.summary).slice(0, 4000) : cleanTitle(input.title), null, conn);
  return get(id, {}, conn);
}

async function get(id, filter = {}, conn = db) {
  const base = await conn.get('SELECT * FROM moderation_cases WHERE id = ?', [id]);
  if (!base) return null;
  if (filter.scope && base.scope !== filter.scope) return null;
  if (filter.serverId && String(base.server_id || '') !== String(filter.serverId)) return null;
  if (filter.platformOnly && base.scope !== 'platform') return null;
  if (filter.communityOnly && base.scope !== 'community') return null;

  const [report, actions, appeals, notes, evidence, events, audit, reporter, assignee] = await Promise.all([
    conn.get('SELECT * FROM reports WHERE case_id = ? ORDER BY created_at DESC LIMIT 1', [id]),
    conn.all(
      `SELECT m.*, u.username AS actor_name, u.display_name AS actor_display
       FROM moderation_actions m LEFT JOIN users u ON u.id = m.actor_id
       WHERE m.case_id = ? ORDER BY m.created_at ASC`,
      [id]
    ),
    conn.all(
      `SELECT a.*, u.username AS user_name, u.display_name AS user_display,
              r.username AS reviewer_name
       FROM appeals a LEFT JOIN users u ON u.id = a.user_id
       LEFT JOIN users r ON r.id = a.reviewer_id
       WHERE a.case_id = ? ORDER BY a.created_at ASC`,
      [id]
    ),
    conn.all(
      `SELECT n.*, u.username AS author_name, u.display_name AS author_display
       FROM case_notes n LEFT JOIN users u ON u.id = n.author_id
       WHERE n.case_id = ? ORDER BY n.created_at ASC`,
      [id]
    ),
    conn.all(
      `SELECT e.*, u.username AS creator_name
       FROM case_evidence e LEFT JOIN users u ON u.id = e.created_by
       WHERE e.case_id = ? ORDER BY e.created_at ASC`,
      [id]
    ),
    conn.all(
      `SELECT e.*, u.username AS actor_name, u.display_name AS actor_display
       FROM case_events e LEFT JOIN users u ON u.id = e.actor_id
       WHERE e.case_id = ? ORDER BY e.created_at ASC`,
      [id]
    ),
    conn.all(
      `SELECT a.*, u.username AS actor_name
       FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
       WHERE a.case_id = ? ORDER BY a.created_at ASC`,
      [id]
    ),
    base.reporter_id ? conn.get('SELECT id, username, display_name, avatar_url FROM users WHERE id = ?', [base.reporter_id]) : null,
    base.assignee_id ? conn.get('SELECT id, username, display_name FROM users WHERE id = ?', [base.assignee_id]) : null,
  ]);

  return {
    ...base,
    category: base.category || 'OTHER',
    severity: base.severity || 'MEDIUM',
    priority: base.priority || 'NORMAL',
    subject: report ? {
      type: report.target_type,
      id: report.target_id,
      snapshot: parseJson(report.target_snapshot, null),
    } : { type: base.subject_type, id: base.subject_id, snapshot: null },
    reporter: reporter ? {
      id: reporter.id, username: reporter.username, displayName: reporter.display_name,
      avatarUrl: reporter.avatar_url || null,
    } : null,
    assignee: assignee ? {
      id: assignee.id, username: assignee.username, displayName: assignee.display_name,
    } : null,
    report: report ? shapeReport(report) : null,
    actions: actions.map(shapeAction),
    appeals: appeals.map(shapeAppeal),
    notes: notes.map((n) => ({
      id: n.id, body: n.body, authorId: n.author_id,
      authorName: n.author_name || null, authorDisplay: n.author_display || null,
      createdAt: n.created_at, updatedAt: n.updated_at,
    })),
    evidence: evidence.map((e) => ({
      id: e.id, kind: e.kind, referenceId: e.reference_id,
      content: e.content, metadata: parseJson(e.metadata, null),
      creatorName: e.creator_name || null, createdAt: e.created_at,
    })),
    events: events.map((e) => ({
      id: e.id, kind: e.kind, note: e.note, metadata: parseJson(e.metadata, null),
      actorId: e.actor_id, actorName: e.actor_name || null,
      actorDisplay: e.actor_display || null, createdAt: e.created_at,
    })),
    audit: audit.map((a) => ({
      id: a.id, action: a.action, targetType: a.target_type, targetId: a.target_id,
      reason: a.reason, actorName: a.actor_name || null, createdAt: a.created_at,
      metadata: parseJson(a.metadata, null),
    })),
  };
}

function shapeReport(r) {
  return {
    id: r.id, caseId: r.case_id, reporterId: r.reporter_id,
    targetType: r.target_type, targetId: r.target_id, serverId: r.server_id,
    reason: r.reason, category: r.category || 'OTHER',
    severity: r.severity || 'MEDIUM', priority: r.priority || 'NORMAL',
    description: r.description, targetSnapshot: parseJson(r.target_snapshot, null),
    status: r.status === 'INVESTIGATING' ? 'UNDER_REVIEW' : r.status,
    assignedAdminId: r.assigned_admin_id, resolution: r.resolution,
    resolutionNote: r.resolution_note,
    createdAt: r.created_at, updatedAt: r.updated_at, resolvedAt: r.resolved_at,
    lastActivityAt: r.last_activity_at || r.updated_at,
  };
}

function shapeAction(a) {
  return {
    id: a.id, caseId: a.case_id, serverId: a.server_id,
    actorId: a.actor_id, actorName: a.actor_name || null, actorDisplay: a.actor_display || null,
    targetType: a.target_type, targetId: a.target_id,
    actionType: a.action_type, type: a.action_type,
    reason: a.reason, expiresAt: a.expires_at, status: a.status || 'ACTIVE',
    reportId: a.report_id, metadata: parseJson(a.metadata, null),
    liftedAt: a.lifted_at, liftedBy: a.lifted_by,
    createdAt: a.created_at, updatedAt: a.updated_at || a.created_at,
  };
}

function shapeAppeal(a) {
  return {
    id: a.id, caseId: a.case_id, serverId: a.server_id,
    userId: a.user_id, userName: a.user_name || null, userDisplay: a.user_display || null,
    actionId: a.action_id, reason: a.reason, status: a.status,
    decision: a.decision, decisionNote: a.decision_note,
    reviewerId: a.reviewer_id, reviewerName: a.reviewer_name || null,
    reviewedAt: a.reviewed_at, createdAt: a.created_at, updatedAt: a.updated_at,
  };
}

async function list(filter = {}) {
  const where = [];
  const params = [];
  if (filter.scope) {
    const scope = String(filter.scope).toLowerCase();
    if (!SCOPES.includes(scope)) bad('unknown case scope');
    where.push('c.scope = ?');
    params.push(scope);
    if (scope === 'platform') where.push('c.server_id IS NULL');
  }
  if (filter.serverId) {
    where.push('c.server_id = ?');
    params.push(String(filter.serverId));
  }
  if (filter.status) {
    const s = upper(filter.status, STATUSES, 'OPEN', 'case status');
    where.push('c.status = ?');
    params.push(s);
  }
  if (filter.assigneeId) {
    where.push('c.assignee_id = ?');
    params.push(String(filter.assigneeId));
  }
  if (filter.subjectId) {
    where.push('c.subject_id = ?');
    params.push(String(filter.subjectId));
  }
  if (filter.q) {
    where.push('(c.title LIKE ? OR c.summary LIKE ? OR c.id LIKE ?)');
    const q = '%' + String(filter.q).slice(0, 100) + '%';
    params.push(q, q, q);
  }
  const limit = Math.min(Math.max(parseInt(filter.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(filter.offset, 10) || 0, 0);
  const q = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = await db.all(
    `SELECT c.*,
       (SELECT COUNT(*) FROM case_notes n WHERE n.case_id = c.id) AS note_count,
       (SELECT COUNT(*) FROM case_evidence e WHERE e.case_id = c.id) AS evidence_count,
       (SELECT COUNT(*) FROM moderation_actions a WHERE a.case_id = c.id) AS action_count,
       (SELECT COUNT(*) FROM appeals ap WHERE ap.case_id = c.id) AS appeal_count,
       u.username AS assignee_name, u.display_name AS assignee_display,
       s.name AS server_name
     FROM moderation_cases c
     LEFT JOIN users u ON u.id = c.assignee_id
     LEFT JOIN servers s ON s.id = c.server_id
     ${q}
     ORDER BY CASE c.priority WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 ELSE 2 END,
              c.updated_at DESC
     LIMIT ${limit} OFFSET ${offset}`,
    params
  );
  return rows.map((c) => ({
    ...c,
    noteCount: Number(c.note_count || 0),
    evidenceCount: Number(c.evidence_count || 0),
    actionCount: Number(c.action_count || 0),
    appealCount: Number(c.appeal_count || 0),
    assigneeName: c.assignee_name || null,
    assigneeDisplay: c.assignee_display || null,
    serverName: c.server_name || null,
  }));
}

async function update(caseId, actorId, input, filter = {}) {
  const row = await get(caseId, filter);
  if (!row) notFound();
  const sets = [];
  const params = [];
  let statusChanged = false;
  let nextStatus = row.status;

  if (input.status !== undefined) {
    const status = upper(input.status, STATUSES, row.status, 'case status');
    nextStatus = status;
    statusChanged = status !== row.status;
    sets.push('status = ?');
    params.push(status);
    if (status === 'RESOLVED' || status === 'DISMISSED') {
      sets.push('closed_at = ?');
      params.push(row.closed_at || now());
    } else if (row.closed_at) {
      sets.push('closed_at = NULL');
    }
  }
  if (input.severity !== undefined) {
    sets.push('severity = ?'); params.push(upper(input.severity, SEVERITIES, row.severity, 'severity'));
  }
  if (input.priority !== undefined) {
    sets.push('priority = ?'); params.push(upper(input.priority, PRIORITIES, row.priority, 'priority'));
  }
  if (input.category !== undefined) {
    sets.push('category = ?'); params.push(upper(input.category, CATEGORIES, row.category, 'report category'));
  }
  if (input.assigneeId !== undefined) {
    const assignee = input.assigneeId ? String(input.assigneeId) : null;
    if (assignee) {
      const user = await db.get('SELECT id FROM users WHERE id = ?', [assignee]);
      if (!user) bad('assignee does not exist');
    }
    sets.push('assignee_id = ?'); params.push(assignee);
  }
  if (input.summary !== undefined) {
    sets.push('summary = ?'); params.push(input.summary ? String(input.summary).slice(0, 8000) : null);
  }
  if (input.resolution !== undefined) {
    sets.push('resolution = ?'); params.push(input.resolution ? String(input.resolution).slice(0, 4000) : null);
  }
  if (!sets.length && !input.note) {
    if (input.status === undefined && input.severity === undefined && input.priority === undefined
      && input.category === undefined && input.assigneeId === undefined) {
      bad('nothing to update');
    }
  }
  const ts = now();
  sets.push('updated_at = ?'); params.push(ts);
  params.push(caseId);
  await db.run(`UPDATE moderation_cases SET ${sets.join(', ')} WHERE id = ?`, params);

  if (statusChanged) {
    await addEvent(caseId, actorId, 'STATUS_CHANGED',
      input.note || ('Status: ' + row.status + ' -> ' + nextStatus),
      { from: row.status, to: nextStatus });
  } else if (input.assigneeId !== undefined) {
    await addEvent(caseId, actorId, 'ASSIGNED', input.note || 'Assignment updated',
      { assigneeId: input.assigneeId || null });
  } else if (input.note) {
    await addEvent(caseId, actorId, 'CASE_UPDATED', input.note, null);
  } else {
    await addEvent(caseId, actorId, 'CASE_UPDATED', 'Case details updated', null);
  }
  if (input.note && statusChanged) {
    // The note is a case note, not only a timeline line. It is the durable
    // explanation a future reviewer needs.
    await addNote(caseId, actorId, input.note);
  }
  return get(caseId, filter);
}

async function addNote(caseId, authorId, body, filter = {}) {
  const row = await get(caseId, filter);
  if (!row) notFound();
  const text = String(body || '').trim();
  if (!text) bad('a note is required');
  if (text.length > 4000) bad('a note cannot exceed 4000 characters');
  const id = uuid();
  const ts = now();
  await db.run(
    'INSERT INTO case_notes (id, case_id, author_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, caseId, authorId, text, ts, ts]
  );
  await db.run('UPDATE moderation_cases SET updated_at = ? WHERE id = ?', [ts, caseId]);
  await addEvent(caseId, authorId, 'NOTE_ADDED', text, { noteId: id });
  return { id, caseId, body: text, createdAt: ts, updatedAt: ts };
}

async function addEvidence(caseId, creatorId, input, filter = {}) {
  const row = await get(caseId, filter);
  if (!row) notFound();
  const kind = String(input.kind || 'NOTE').toUpperCase().slice(0, 32);
  const content = input.content == null ? null : String(input.content).slice(0, 100000);
  const referenceId = input.referenceId ? String(input.referenceId).slice(0, 64) : null;
  if (!content && !referenceId) bad('evidence needs a snapshot or a reference');
  const id = uuid();
  const ts = now();
  await db.run(
    `INSERT INTO case_evidence (id, case_id, kind, reference_id, content, metadata, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, caseId, kind, referenceId, content,
      input.metadata == null ? null : (typeof input.metadata === 'string' ? input.metadata : JSON.stringify(input.metadata)),
      creatorId, ts]
  );
  await db.run('UPDATE moderation_cases SET updated_at = ? WHERE id = ?', [ts, caseId]);
  await addEvent(caseId, creatorId, 'EVIDENCE_ADDED', input.note || ('Evidence: ' + kind),
    { evidenceId: id, kind });
  return { id, caseId, kind, referenceId, content, createdAt: ts };
}

async function linkReport(caseId, reportId, conn = db) {
  await conn.run('UPDATE reports SET case_id = ?, last_activity_at = COALESCE(last_activity_at, ?) WHERE id = ?',
    [caseId, now(), reportId]);
  await conn.run('UPDATE moderation_cases SET report_id = ?, updated_at = ? WHERE id = ?',
    [reportId, now(), caseId]);
}

async function linkAction(caseId, actionId, conn = db) {
  await conn.run('UPDATE moderation_actions SET case_id = ?, updated_at = COALESCE(updated_at, ?) WHERE id = ?',
    [caseId, now(), actionId]);
  await conn.run('UPDATE moderation_cases SET action_id = COALESCE(action_id, ?), updated_at = ? WHERE id = ?',
    [actionId, now(), caseId]);
}

async function linkAppeal(caseId, appealId, conn = db) {
  await conn.run('UPDATE appeals SET case_id = ? WHERE id = ?', [caseId, appealId]);
}

async function forAction(actionId, conn = db) {
  const action = await conn.get('SELECT * FROM moderation_actions WHERE id = ?', [actionId]);
  if (!action) return null;
  if (action.case_id) return get(action.case_id, {}, conn);
  const created = await create({
    scope: action.server_id ? 'community' : 'platform',
    serverId: action.server_id || null,
    subjectType: action.target_type,
    subjectId: action.target_id,
    title: String(action.action_type || 'Moderation action').replace(/_/g, ' ').toLowerCase(),
    category: 'OTHER',
    severity: 'MEDIUM',
    priority: 'NORMAL',
    status: 'RESOLVED',
    summary: action.reason,
    actionId: action.id,
    actorId: action.actor_id,
  }, conn);
  await linkAction(created.id, action.id, conn);
  return get(created.id, {}, conn);
}

module.exports = {
  STATUSES, SEVERITIES, PRIORITIES, CATEGORIES, SCOPES, RESTRICTION_KINDS,
  create, get, list, update, addEvent, addNote, addEvidence,
  linkReport, linkAction, linkAppeal, forAction,
  shapeReport, shapeAction, shapeAppeal, parseJson,
};
