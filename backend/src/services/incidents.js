// The operational incident timeline.
//
// An instance records what happened to it: an operator posts an incident
// with a status, a summary and when it happened, and the status page shows
// what the operator wrote.
//
// The one rule this module exists to keep: nothing is invented. The status
// page shows the rows an operator wrote and nothing else, and an instance
// with no incidents says it has none rather than claiming that everything is
// fine - which would be a claim nobody made.
//
// A planned maintenance notice is the same thing with a date: a row of the
// same shape, with the day it is going to happen.

const db = require('../db');
const { now, uuid } = require('../clock');

const KINDS = ['incident', 'maintenance'];
const STATUSES = ['investigating', 'identified', 'monitoring', 'resolved', 'scheduled'];
const TITLE_MAX = 128;
const SUMMARY_MAX = 4000;

function bad(message, code) {
  const e = new Error(message);
  e.code = code || 'VALIDATION_ERROR';
  throw e;
}

function notFound() {
  const e = new Error('no such incident');
  e.code = 'NOT_FOUND';
  throw e;
}

function cleanTitle(value) {
  return String(value == null ? '' : value).trim().slice(0, TITLE_MAX);
}

function cleanSummary(value) {
  return String(value == null ? '' : value).trim().slice(0, SUMMARY_MAX);
}

// A timestamp an operator gave, or now.
function cleanTimestamp(value, fallback) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return fallback;
  const at = Date.parse(text);
  if (!Number.isFinite(at)) bad('"' + text + '" is not a time');
  return new Date(at).toISOString();
}

// Record an incident, or a planned maintenance notice.
async function create(options) {
  const opts = options || {};
  const kind = String(opts.kind || 'incident').trim().toLowerCase();
  if (!KINDS.includes(kind)) bad('kind must be incident or maintenance');
  const status = String(opts.status || (kind === 'maintenance' ? 'scheduled' : 'investigating')).trim().toLowerCase();
  if (!STATUSES.includes(status)) {
    bad('status must be one of: ' + STATUSES.join(', '));
  }
  const title = cleanTitle(opts.title);
  if (!title) bad('an incident needs a title');
  const summary = cleanSummary(opts.summary);
  if (!summary) bad('an incident needs a summary');

  const ts = now();
  const startedAt = cleanTimestamp(opts.startedAt, ts);
  const scheduledFor = kind === 'maintenance'
    ? cleanTimestamp(opts.scheduledFor, null)
    : null;
  if (kind === 'maintenance' && !scheduledFor) {
    bad('a planned maintenance notice needs the date it is planned for');
  }

  const id = uuid();
  await db.run(
    'INSERT INTO incidents (id, kind, status, title, summary, body, started_at, scheduled_for,'
    + ' resolved_at, created_by, created_at, updated_at)'
    + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      id, kind, status, title, summary,
      cleanSummary(opts.body) || null, startedAt, scheduledFor,
      status === 'resolved' ? ts : null,
      opts.actorId, ts, ts,
    ]
  );
  return get(id);
}

// Change an incident: its status, its summary, or the note under it.
async function update(id, options) {
  const opts = options || {};
  const current = await get(id);
  const status = opts.status === undefined ? current.status : String(opts.status).trim().toLowerCase();
  if (!STATUSES.includes(status)) {
    bad('status must be one of: ' + STATUSES.join(', '));
  }
  const summary = opts.summary === undefined ? current.summary : cleanSummary(opts.summary);
  const body = opts.body === undefined ? current.body : (cleanSummary(opts.body) || null);
  const title = opts.title === undefined ? current.title : cleanTitle(opts.title);
  if (!title) bad('an incident needs a title');
  if (!summary) bad('an incident needs a summary');

  const ts = now();
  await db.run(
    'UPDATE incidents SET status = ?, summary = ?, body = ?, title = ?, resolved_at = ?, updated_at = ?'
    + ' WHERE id = ?',
    [status, summary, body, title, status === 'resolved' ? (current.resolvedAt || ts) : null, ts, id]
  );
  return get(id);
}

async function get(id) {
  const row = await db.get(
    'SELECT id, kind, status, title, summary, body, started_at AS startedAt,'
    + ' scheduled_for AS scheduledFor, resolved_at AS resolvedAt, created_at AS createdAt,'
    + ' updated_at AS updatedAt FROM incidents WHERE id = ?',
    [id]
  );
  if (!row) notFound();
  return row;
}

// The timeline, newest first.
//
// This is what the status page shows, so it carries what an operator wrote
// and nothing else: no health claim, no invented entry, no countdown.
async function list(options) {
  const opts = options || {};
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 200);
  const where = [];
  const params = [];
  if (opts.kind) {
    where.push('kind = ?');
    params.push(String(opts.kind));
  }
  if (opts.open) where.push("status != 'resolved'");
  return db.all(
    'SELECT id, kind, status, title, summary, body, started_at AS startedAt,'
    + ' scheduled_for AS scheduledFor, resolved_at AS resolvedAt, created_at AS createdAt,'
    + ' updated_at AS updatedAt FROM incidents'
    + (where.length ? ' WHERE ' + where.join(' AND ') : '')
    + ' ORDER BY started_at DESC, id DESC LIMIT ' + limit,
    params
  );
}

// The status page's own answer.
//
// An instance with nothing recorded says so. It does not say that everything
// is working, because that is a claim about the whole instance and nobody
// wrote it.
async function status(options) {
  const opts = options || {};
  const incidents = await list({ kind: 'incident', limit: opts.limit });
  const maintenance = await list({ kind: 'maintenance', limit: opts.limit });
  const open = incidents.filter((row) => row.status !== 'resolved');
  return {
    incidents,
    maintenance,
    openIncidents: open.length,
    summary: incidents.length
      ? (open.length
        ? open.length + ' open incident(s)'
        : 'No open incidents')
      : 'No incidents have been recorded.',
  };
}

module.exports = { KINDS, STATUSES, create, update, get, list, status };
