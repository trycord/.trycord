// Boards: columns, cards, milestones, activity.
//
// A board belongs to a community and optionally to a space. Its columns are
// the status lanes; a card is the unit of work and carries a title, a body,
// an assignee, a due date, a priority, a status, labels and links.
//
// Two rules shape the whole file:
//
//   - an assignee has to be a member of the community, and a due date is a
//     UTC instant plus the timezone it was written in, so a due date means
//     the same moment to everybody who reads it
//   - an update states the version it was written against, and the write only
//     lands when that is still the current version, so two people editing the
//     same card produce one edit and one conflict rather than one edit that
//     silently loses the other
//
// Every change to a card is appended to the card's activity. The activity log
// is a record, not a summary: it is never rewritten.
const db = require('../../db');
const { now, uuid } = require('../../util');
const { fail, text, required, optionalInstant, oneOf, labels, conflict } = require('./common');
const { assertTimeZone } = require('./time');
const { canAccessChannel } = require('./access');
const memberships = require('../memberships');
const notifications = require('../notifications');
const jobs = require('../jobs');

const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const STATUSES = ['open', 'in_progress', 'blocked', 'done', 'cancelled'];
const LINK_KINDS = ['channel', 'document', 'discussion', 'event', 'message'];
const DEFAULT_COLUMNS = ['To do', 'In progress', 'Done'];

// The lead time of the due-date reminder, in hours. A day is long enough to
// act on and short enough to be worth a notification.
const DUE_REMINDER_LEAD_MS = 24 * 60 * 60 * 1000;

function shapeBoard(row) {
  return {
    id: row.id,
    serverId: row.server_id,
    spaceId: row.space_id || null,
    name: row.name,
    description: row.description || '',
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function shapeColumn(row) {
  return {
    id: row.id,
    boardId: row.board_id,
    name: row.name,
    position: Number(row.position || 0),
    createdAt: row.created_at,
  };
}

function shapeCard(row) {
  return {
    id: row.id,
    boardId: row.board_id,
    serverId: row.server_id,
    columnId: row.column_id,
    title: row.title,
    body: row.body || '',
    assigneeId: row.assignee_id || null,
    dueAt: row.due_at || null,
    dueTimezone: row.due_timezone || null,
    priority: row.priority,
    status: row.status,
    position: Number(row.position || 0),
    version: Number(row.version),
    sourceMessageId: row.source_message_id || null,
    sourceChannelId: row.source_channel_id || null,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function shapeMilestone(row) {
  return {
    id: row.id,
    boardId: row.board_id,
    name: row.name,
    description: row.description || '',
    dueAt: row.due_at || null,
    dueTimezone: row.due_timezone || null,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function shapeActivity(row) {
  return {
    id: row.id,
    cardId: row.card_id,
    actorId: row.actor_id,
    field: row.field || null,
    from: row.from_value === null ? null : row.from_value,
    to: row.to_value === null ? null : row.to_value,
    createdAt: row.created_at,
  };
}

async function boardOf(serverId, boardId) {
  const row = await db.get('SELECT * FROM boards WHERE id = ? AND server_id = ?', [boardId, serverId]);
  if (!row) fail('NOT_FOUND', 'board not found');
  return row;
}

async function list(serverId) {
  const rows = await db.all('SELECT * FROM boards WHERE server_id = ? ORDER BY created_at ASC, name ASC', [serverId]);
  return rows.map(shapeBoard);
}

// A board with its columns, milestones and cards.
async function get(serverId, boardId) {
  const board = await boardOf(serverId, boardId);
  const [columns, milestones, cards] = await Promise.all([
    db.all('SELECT * FROM board_columns WHERE board_id = ? ORDER BY position ASC, name ASC', [board.id]),
    db.all('SELECT * FROM milestones WHERE board_id = ? ORDER BY created_at ASC, name ASC', [board.id]),
    db.all('SELECT * FROM cards WHERE board_id = ? ORDER BY position ASC, created_at ASC', [board.id]),
  ]);
  return Object.assign(shapeBoard(board), {
    columns: columns.map(shapeColumn),
    milestones: milestones.map(shapeMilestone),
    cards: cards.map(shapeCard),
  });
}

async function create(serverId, actorId, { name, description, spaceId }) {
  const clean = required(name, 64, 'name');
  let space = null;
  if (spaceId) {
    space = await db.get('SELECT id FROM spaces WHERE id = ? AND server_id = ?', [spaceId, serverId]);
    if (!space) fail('NOT_FOUND', 'space not found in this community');
  }
  const id = uuid();
  const ts = now();
  await db.transaction(async (t) => {
    await t.run(
      'INSERT INTO boards (id, server_id, space_id, name, description, created_by, created_at, updated_at)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, serverId, space ? space.id : null, clean, text(description, 1000, 'description'), actorId, ts, ts]
    );
    // A board starts with the three lanes a project actually has, so a card
    // can be filed the moment the board exists.
    let pos = 0;
    for (const column of DEFAULT_COLUMNS) {
      await t.run(
        'INSERT INTO board_columns (id, board_id, name, position, created_at) VALUES (?, ?, ?, ?, ?)',
        [uuid(), id, column, pos++, ts]
      );
    }
  });
  return get(serverId, id);
}

async function createColumn(serverId, boardId, actorId, { name }) {
  const board = await boardOf(serverId, boardId);
  const clean = required(name, 64, 'name');
  const pos = await db.get(
    'SELECT COALESCE(MAX(position), -1) + 1 AS p FROM board_columns WHERE board_id = ?',
    [board.id]
  );
  const id = uuid();
  await db.run(
    'INSERT INTO board_columns (id, board_id, name, position, created_at) VALUES (?, ?, ?, ?, ?)',
    [id, board.id, clean, pos.p, now()]
  );
  const row = await db.get('SELECT * FROM board_columns WHERE id = ?', [id]);
  return shapeColumn(row);
}

async function createMilestone(serverId, boardId, actorId, { name, description, dueAt, dueTimezone }) {
  const board = await boardOf(serverId, boardId);
  const clean = required(name, 128, 'name');
  const due = optionalInstant(dueAt, 'dueAt');
  const zone = due ? assertTimeZone(dueTimezone || 'UTC', 'dueTimezone') : null;
  const id = uuid();
  await db.run(
    'INSERT INTO milestones (id, board_id, server_id, name, description, due_at, due_timezone, created_by, created_at)'
    + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, board.id, serverId, clean, text(description, 1000, 'description'), due, zone, actorId, now()]
  );
  const row = await db.get('SELECT * FROM milestones WHERE id = ?', [id]);
  return shapeMilestone(row);
}

// The assignee has to be somebody the community can reach.
async function assertAssignee(serverId, assigneeId) {
  if (!assigneeId) return null;
  const member = await memberships.get(serverId, assigneeId);
  if (!member) fail('VALIDATION_ERROR', 'the assignee must be a member of this community');
  return String(assigneeId);
}

// The activity log. Append-only: one row per change, with what it was and
// what it became.
async function recordActivity(conn, cardId, serverId, actorId, field, from, to) {
  await conn.run(
    'INSERT INTO card_activity (id, card_id, server_id, actor_id, field, from_value, to_value, created_at)'
    + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [uuid(), cardId, serverId, actorId, field || null,
      from === undefined || from === null ? null : String(from),
      to === undefined || to === null ? null : String(to),
      now()]
  );
}

// Tell somebody they have been given a card.
//
// The notification service owns the notification types, and a card assignment
// is announced as a mention of the card: the recipient is told, and the card
// is what the notification points at.
async function notifyAssignee(assigneeId, actorId, cardId) {
  if (!assigneeId || String(assigneeId) === String(actorId)) return;
  try {
    await notifications.create(assigneeId, 'mention', actorId, cardId);
  } catch (e) {
    // A card that was saved must not be lost because a notification could
    // not be written. The failure is logged rather than swallowed.
    console.warn('[workspace] could not notify ' + assigneeId + ' about card ' + cardId + ': ' + (e && e.message));
  }
}

// The due-date reminder, scheduled through the durable job system.
//
// The job is queued when the due date is set. It fires a day before the date,
// or immediately when the date is less than a day away.
async function scheduleDueReminder(card) {
  if (!card.due_at || !card.assignee_id) return null;
  const dueAt = new Date(card.due_at).getTime();
  if (Number.isNaN(dueAt)) return null;
  const runAt = Math.max(dueAt - DUE_REMINDER_LEAD_MS, Date.now());
  const jobId = await jobs.enqueue(
    'workspace_card_due_reminder',
    { cardId: card.id },
    { runAfterMs: runAt - Date.now(), maxAttempts: 3 }
  );
  return jobId;
}

// The job handler. Registered by the server at boot; see the report for the
// exact jobs.register(...) call.
async function dueReminderJob({ cardId }) {
  const card = await db.get('SELECT * FROM cards WHERE id = ?', [cardId]);
  if (!card) return { skipped: 'card not found' };
  if (!card.assignee_id) return { skipped: 'card has no assignee' };
  try {
    await notifications.create(card.assignee_id, 'mention', card.created_by, card.id);
  } catch (e) {
    console.warn('[workspace] could not send the due-date reminder for card ' + card.id + ': ' + (e && e.message));
  }
  return { notified: card.assignee_id };
}

async function cardOf(serverId, boardId, cardId) {
  const board = await boardOf(serverId, boardId);
  const card = await db.get('SELECT * FROM cards WHERE id = ? AND board_id = ?', [cardId, board.id]);
  if (!card) fail('NOT_FOUND', 'card not found');
  return card;
}

async function card(serverId, boardId, cardId) {
  const row = await cardOf(serverId, boardId, cardId);
  const [labels_, links, milestones, activity] = await Promise.all([
    db.all('SELECT label FROM card_labels WHERE card_id = ? ORDER BY label ASC', [row.id]),
    db.all('SELECT * FROM card_links WHERE card_id = ? ORDER BY created_at ASC, id ASC', [row.id]),
    db.all(
      'SELECT m.* FROM card_milestones cm JOIN milestones m ON m.id = cm.milestone_id WHERE cm.card_id = ?',
      [row.id]
    ),
    db.all('SELECT * FROM card_activity WHERE card_id = ? ORDER BY created_at ASC, id ASC', [row.id]),
  ]);
  return Object.assign(shapeCard(row), {
    labels: labels_.map((l) => l.label),
    links: links.map((l) => ({ id: l.id, kind: l.kind, targetId: l.target_id || null })),
    milestones: milestones.map(shapeMilestone),
    activity: activity.map(shapeActivity),
  });
}

async function createCard(serverId, boardId, actorId, input) {
  const board = await boardOf(serverId, boardId);
  const title = required(input.title, 255, 'title');
  const assignee = await assertAssignee(serverId, input.assigneeId);
  const due = optionalInstant(input.dueAt, 'dueAt');
  const zone = due ? assertTimeZone(input.dueTimezone || 'UTC', 'dueTimezone') : null;
  const priority = oneOf(input.priority, PRIORITIES, 'priority', 'normal');
  const status = oneOf(input.status, STATUSES, 'status', 'open');
  const column = await resolveColumn(board.id, input.columnId);
  const pos = await db.get(
    'SELECT COALESCE(MAX(position), -1) + 1 AS p FROM cards WHERE column_id = ?',
    [column.id]
  );
  const id = uuid();
  const ts = now();
  await db.transaction(async (t) => {
    await t.run(
      'INSERT INTO cards (id, board_id, server_id, column_id, title, body, assignee_id, due_at, due_timezone,'
      + ' priority, status, position, version, created_by, created_at, updated_at)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)',
      [id, board.id, serverId, column.id, title, text(input.body, 10000, 'body'), assignee, due, zone,
        priority, status, pos.p, actorId, ts, ts]
    );
    for (const label of labels(input.labels)) {
      await t.run('INSERT INTO card_labels (card_id, label) VALUES (?, ?)', [id, label]);
    }
    await recordActivity(t, id, serverId, actorId, 'created', null, title);
  });
  const created = await db.get('SELECT * FROM cards WHERE id = ?', [id]);
  await scheduleDueReminder(created);
  await notifyAssignee(assignee, actorId, id);
  return card(serverId, board.id, id);
}

// The column a card goes into. A card that names no column goes into the
// first lane, which is the one a board starts with.
async function resolveColumn(boardId, columnId) {
  if (columnId) {
    const column = await db.get('SELECT * FROM board_columns WHERE id = ? AND board_id = ?', [columnId, boardId]);
    if (!column) fail('NOT_FOUND', 'column not found on this board');
    return column;
  }
  const first = await db.get('SELECT * FROM board_columns WHERE board_id = ? ORDER BY position ASC LIMIT 1', [boardId]);
  if (!first) fail('CONFLICT', 'this board has no columns');
  return first;
}

// The change a save makes, and the activity it writes.
//
// The fields that are absent from the patch are left alone; a field that is
// present is written even when its value did not change, because "the author
// saved this card" is itself worth recording.
function planChanges(card, patch) {
  const changes = [];
  const add = (field, column, value, from) => {
    changes.push({ field, column, value, from });
  };
  if (patch.title !== undefined) add('title', 'title', required(patch.title, 255, 'title'), card.title);
  if (patch.body !== undefined) add('body', 'body', text(patch.body, 10000, 'body'), card.body || '');
  if (patch.assigneeId !== undefined) {
    add('assignee', 'assignee_id', patch.assigneeId ? String(patch.assigneeId) : null, card.assignee_id || null);
  }
  if (patch.dueAt !== undefined) {
    const due = optionalInstant(patch.dueAt, 'dueAt');
    add('due', 'due_at', due, card.due_at || null);
    if (patch.dueTimezone === undefined) {
      // A due date without a zone would be a moment nobody could read. It
      // keeps the zone the card already had, or UTC when it had none.
      add('due_timezone', 'due_timezone', due ? (card.due_timezone || 'UTC') : null, card.due_timezone || null);
    }
  }
  if (patch.dueTimezone !== undefined) {
    add('due_timezone', 'due_timezone', patch.dueTimezone ? assertTimeZone(patch.dueTimezone, 'dueTimezone') : null,
      card.due_timezone || null);
  }
  if (patch.priority !== undefined) add('priority', 'priority', oneOf(patch.priority, PRIORITIES, 'priority'), card.priority);
  if (patch.status !== undefined) add('status', 'status', oneOf(patch.status, STATUSES, 'status'), card.status);
  return changes;
}

// An update, against a version.
//
// The version is the precondition: the row is only written when it still
// carries the version the caller was working from. When it does not, the
// write is refused and the current version is returned, so the client can
// show the author what changed and let them decide.
async function updateCard(serverId, boardId, cardId, actorId, patch) {
  const card_ = await cardOf(serverId, boardId, cardId);
  const version = Number(patch.version);
  if (!Number.isInteger(version) || version < 1) {
    fail('VALIDATION_ERROR', 'an update must state the version it was written against');
  }
  if (patch.assigneeId !== undefined) await assertAssignee(serverId, patch.assigneeId);
  const changes = planChanges(card_, patch);
  if (!changes.length && patch.labels === undefined) {
    fail('VALIDATION_ERROR', 'nothing to update');
  }
  const ts = now();
  let newAssignee = null;
  await db.transaction(async (t) => {
    if (changes.length) {
      const sets = changes.map((c) => `${c.column} = ?`);
      const vals = changes.map((c) => c.value);
      sets.push('version = version + 1', 'updated_at = ?');
      vals.push(ts);
      const res = await t.run(
        `UPDATE cards SET ${sets.join(', ')} WHERE id = ? AND version = ?`,
        vals.concat([card_.id, version])
      );
      if (res.changes !== 1) {
        const latest = await t.get('SELECT version, updated_at FROM cards WHERE id = ?', [card_.id]);
        throw conflict('this card changed since you loaded it', {
          currentVersion: latest ? Number(latest.version) : Number(card_.version),
          submittedVersion: version,
          currentUpdatedAt: latest ? latest.updated_at : card_.updated_at,
        });
      }
      for (const change of changes) {
        await recordActivity(t, card_.id, serverId, actorId, change.field, change.from, change.value);
      }
    }
    if (patch.labels !== undefined) {
      const wanted = labels(patch.labels);
      const current = await t.all('SELECT label FROM card_labels WHERE card_id = ?', [card_.id]);
      const before = current.map((l) => l.label);
      await t.run('DELETE FROM card_labels WHERE card_id = ?', [card_.id]);
      for (const label of wanted) {
        await t.run('INSERT INTO card_labels (card_id, label) VALUES (?, ?)', [card_.id, label]);
      }
      if (before.join(',') !== wanted.join(',')) {
        await recordActivity(t, card_.id, serverId, actorId, 'labels', before.join(','), wanted.join(','));
      }
    }
    const assigneeChange = changes.find((c) => c.field === 'assignee');
    newAssignee = assigneeChange ? assigneeChange.value : null;
  });
  const updated = await db.get('SELECT * FROM cards WHERE id = ?', [card_.id]);
  if (newAssignee) {
    await notifyAssignee(newAssignee, actorId, card_.id);
    await scheduleDueReminder(updated);
  }
  return card(serverId, card_.board_id, card_.id);
}

// Moving a card to another lane. The same version precondition as any other
// change, because moving a card is a change to it.
async function moveCard(serverId, boardId, cardId, actorId, { columnId, position, version }) {
  const card_ = await cardOf(serverId, boardId, cardId);
  const version_ = Number(version);
  if (!Number.isInteger(version_) || version_ < 1) {
    fail('VALIDATION_ERROR', 'a move must state the version it was written against');
  }
  const column = await resolveColumn(card_.board_id, columnId);
  const pos = position === undefined || position === null
    ? Number(card_.position)
    : Math.max(Number(position) || 0, 0);
  const ts = now();
  await db.transaction(async (t) => {
    const res = await t.run(
      'UPDATE cards SET column_id = ?, position = ?, version = version + 1, updated_at = ?'
      + ' WHERE id = ? AND version = ?',
      [column.id, pos, ts, card_.id, version_]
    );
    if (res.changes !== 1) {
      const latest = await t.get('SELECT version, updated_at FROM cards WHERE id = ?', [card_.id]);
      throw conflict('this card changed since you loaded it', {
        currentVersion: latest ? Number(latest.version) : Number(card_.version),
        submittedVersion: version_,
        currentUpdatedAt: latest ? latest.updated_at : card_.updated_at,
      });
    }
    await recordActivity(t, card_.id, serverId, actorId, 'column', card_.column_id, column.id);
  });
  return card(serverId, card_.board_id, card_.id);
}

// A card made from a message.
//
// The card keeps the message it came from, and the link is what makes the
// conversion reversible in the reader's mind: the task says where it came
// from and the message still says what it was.
async function fromMessage(serverId, boardId, actorId, { messageId, columnId, title, body }) {
  const board = await boardOf(serverId, boardId);
  const id = String(messageId || '').trim();
  if (!id) fail('VALIDATION_ERROR', 'messageId is required');
  const message = await db.get('SELECT * FROM messages WHERE id = ?', [id]);
  if (!message) fail('NOT_FOUND', 'message not found');
  const channel = await db.get('SELECT * FROM channels WHERE id = ? AND server_id = ?', [message.channel_id, serverId]);
  if (!channel) fail('NOT_FOUND', 'message not found in this community');
  // The person converting a message has to be able to take part in the
  // channel it is in, or they could use the board to read a channel they may
  // not read.
  if (!(await canAccessChannel(actorId, serverId, channel.id))) {
    fail('PERMISSION_DENIED', 'you may not take part in that channel');
  }
  const cardTitle = title
    ? required(title, 255, 'title')
    : String(message.content || '').trim().slice(0, 120) || 'Message';
  const column = await resolveColumn(board.id, columnId);
  const pos = await db.get(
    'SELECT COALESCE(MAX(position), -1) + 1 AS p FROM cards WHERE column_id = ?',
    [column.id]
  );
  const cardId = uuid();
  const ts = now();
  await db.transaction(async (t) => {
    await t.run(
      'INSERT INTO cards (id, board_id, server_id, column_id, title, body, priority, status, position, version,'
      + ' source_message_id, source_channel_id, created_by, created_at, updated_at)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)',
      [cardId, board.id, serverId, column.id, cardTitle, body === undefined ? String(message.content || '') : text(body, 10000, 'body'),
        'normal', 'open', pos.p, message.id, channel.id, actorId, ts, ts]
    );
    await t.run(
      'INSERT INTO card_links (id, card_id, server_id, kind, target_id, created_by, created_at)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?)',
      [uuid(), cardId, serverId, 'message', message.id, actorId, ts]
    );
    await recordActivity(t, cardId, serverId, actorId, 'created from message', null, message.id);
  });
  return card(serverId, board.id, cardId);
}

// A link from a card to something else in the community.
//
// A discussion is a thread: the target is the id of the thread's root
// message, and the thread is read through the existing thread model. There is
// no second discussion structure here.
async function addLink(serverId, boardId, cardId, actorId, { kind, targetId }) {
  const card_ = await cardOf(serverId, boardId, cardId);
  const linkKind = oneOf(kind, LINK_KINDS, 'kind');
  const target = String(targetId || '').trim();
  if (!target) fail('VALIDATION_ERROR', 'targetId is required');
  await assertLinkTarget(serverId, linkKind, target);
  const id = uuid();
  await db.transaction(async (t) => {
    await t.run(
      'INSERT INTO card_links (id, card_id, server_id, kind, target_id, created_by, created_at)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, card_.id, serverId, linkKind, target, actorId, now()]
    );
    await recordActivity(t, card_.id, serverId, actorId, 'linked ' + linkKind, null, target);
  });
  return card(serverId, card_.board_id, card_.id);
}

async function assertLinkTarget(serverId, kind, target) {
  if (kind === 'channel') {
    const ch = await db.get('SELECT id FROM channels WHERE id = ? AND server_id = ?', [target, serverId]);
    if (!ch) fail('NOT_FOUND', 'channel not found in this community');
    return;
  }
  if (kind === 'document') {
    const doc = await db.get('SELECT id FROM documents WHERE id = ? AND server_id = ?', [target, serverId]);
    if (!doc) fail('NOT_FOUND', 'document not found in this community');
    return;
  }
  if (kind === 'event') {
    const event = await db.get('SELECT id FROM events WHERE id = ? AND server_id = ?', [target, serverId]);
    if (!event) fail('NOT_FOUND', 'event not found in this community');
    return;
  }
  // A discussion is a thread root message, and a message link is a message.
  // Both are messages, and both have to be messages of this community.
  const message = await db.get('SELECT * FROM messages WHERE id = ?', [target]);
  if (!message) fail('NOT_FOUND', 'message not found');
  const channel = await db.get('SELECT id FROM channels WHERE id = ? AND server_id = ?', [message.channel_id, serverId]);
  if (!channel) fail('NOT_FOUND', 'message not found in this community');
}

async function attachMilestone(serverId, boardId, cardId, actorId, milestoneId) {
  const card_ = await cardOf(serverId, boardId, cardId);
  const milestone = await db.get('SELECT * FROM milestones WHERE id = ? AND board_id = ?', [milestoneId, card_.board_id]);
  if (!milestone) fail('NOT_FOUND', 'milestone not found on this board');
  await db.run(
    `INSERT ${db.ignoreKeyword} INTO card_milestones (card_id, milestone_id) VALUES (?, ?)`,
    [card_.id, milestone.id]
  );
  await recordActivity(db, card_.id, serverId, actorId, 'milestone', null, milestone.id);
  return card(serverId, card_.board_id, card_.id);
}

async function activity(serverId, boardId, cardId) {
  const card_ = await cardOf(serverId, boardId, cardId);
  const rows = await db.all(
    'SELECT * FROM card_activity WHERE card_id = ? ORDER BY created_at ASC, id ASC',
    [card_.id]
  );
  return rows.map(shapeActivity);
}

module.exports = {
  PRIORITIES, STATUSES, LINK_KINDS,
  list, get, create, createColumn, createMilestone,
  card, createCard, updateCard, moveCard, fromMessage, addLink, attachMilestone,
  activity, dueReminderJob,
};
