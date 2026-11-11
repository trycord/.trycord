// Notifications: persisted per user, newest first. Created for events the
// user didn't see live (offline DM, incoming friend request, accepted
// request). The realtime gateway pushes them to connected sockets; the
// database is the durable source when offline.
const db = require('../db');
const { now, uuid } = require('../util');
const wellbeing = require('./wellbeing');
const prefs = require('./prefs');

// The kinds of notification this instance can raise.
//
// A closed list on purpose: a notification with a type nobody handles is a
// row in a table that appears in the interface with no meaning, and the
// exception is thrown at the point of creation rather than discovered later.
//
// The collaboration workspace adds two: a card assigned to a member, and a
// reminder about an event they are coming to. Both carry a reference to the
// card or the event, which the client resolves.
const TYPES = [
  'dm', 'friend_request', 'friend_accepted', 'mention', 'reply',
  'card_assigned', 'event_reminder',
  // Direct conversations of more than two people. An invitation is distinct
  // from membership: being added is a fact, being invited is a question.
  'group_invite', 'group_member_added', 'group_member_removed',
  'group_role_changed', 'group_ownership_transferred',
  // Communities. The invite carries the invite code as its reference, so the
  // recipient can join without the sender having to paste it elsewhere.
  'community_invite', 'community_event',
  // Trust & Safety. These are decision notifications, not a live feed of
  // investigation detail: they name the action and point at the case/appeal,
  // and never carry internal notes or evidence.
  'moderation_action', 'moderation_warning', 'moderation_lift',
  'report_update', 'appeal_update', 'community_moderation',
];

// The category a type belongs to. Preferences are stored by category, and a
// type with no category would be a notification the settings screen cannot
// switch off - which is not a setting, it is an omission.
const CATEGORY_OF = {
  dm: 'dm',
  mention: 'mention',
  reply: 'mention',
  friend_request: 'friend',
  friend_accepted: 'friend',
  group_invite: 'group',
  group_member_added: 'group',
  group_member_removed: 'group',
  group_role_changed: 'group',
  group_ownership_transferred: 'group',
  community_invite: 'community',
  community_event: 'community',
  card_assigned: 'announcement',
  event_reminder: 'announcement',
  moderation_action: 'moderation',
  moderation_warning: 'moderation',
  moderation_lift: 'moderation',
  report_update: 'moderation',
  appeal_update: 'moderation',
  community_moderation: 'moderation',
};

function categoryOf(type) {
  return CATEGORY_OF[type] || 'announcement';
}

// Whether the account wants this category at all. An absent row is every
// default on, so this changes nothing for an account that never opened the
// settings. A category switched off suppresses the row as well as the push:
// persisting it would still show it in the list and count it in the badge,
// which is the opposite of what the setting says.
async function wanted(userId, type) {
  try {
    const p = await prefs.getNotificationPrefs(userId);
    const category = categoryOf(type);
    return p[category] !== false;
  } catch {
    return true;
  }
}

// 'dnd' is a presence state as well as a wellbeing setting. A person who has
// told the instance "do not disturb" means it here too; the row is still
// written, only the interruption is held.
async function inDnd(userId) {
  try {
    const row = await db.get('SELECT presence_status FROM users WHERE id = ?', [userId]);
    return !!row && row.presence_status === 'dnd';
  } catch {
    return false;
  }
}


// `held` means this account's wellbeing settings say not to interrupt them right now.
// The row is still written: a held notification is waiting next time they open the app,
// which is what quiet hours mean. Only the push is skipped.
//
// Without this the setting was stored, returned by the API and shown in Settings, and
// nothing ever read it - a toggle that changes nothing.
async function create(userId, type, actorId, referenceId, options = {}) {
  if (TYPES.indexOf(type) === -1) throw { code: 'VALIDATION_ERROR', message: 'Unknown notification type.' };
  if (!(await wanted(userId, type))) {
    // The preference is about not being told, so there is nothing to hold for
    // later and nothing to show in the list. Callers that send the realtime
    // event must check `notification` before doing so.
    return { notification: null, held: false, suppressed: true, duplicate: false };
  }
  const opts = options && typeof options === 'object' ? options : {};
  const row = {
    id: uuid(), user_id: userId, type,
    actor_id: actorId || null, reference_id: referenceId || null,
    dedupe_key: opts.dedupeKey ? String(opts.dedupeKey).slice(0, 128) : null,
    detail: opts.detail ? String(opts.detail).slice(0, 500) : null,
    created_at: now(), read_at: null,
  };
  try {
    await db.run(
      `INSERT INTO notifications
         (id, user_id, type, actor_id, reference_id, dedupe_key, detail, created_at, read_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.user_id, row.type, row.actor_id, row.reference_id,
        row.dedupe_key, row.detail, row.created_at, row.read_at]
    );
  } catch (error) {
    // The dedupe key is the idempotency contract. If this event has already
    // been delivered, return the row that exists rather than creating a
    // second, contradictory notification.
    if (row.dedupe_key && db.isUniqueViolation(error)) {
      const existing = await db.get('SELECT * FROM notifications WHERE dedupe_key = ?', [row.dedupe_key]);
      if (existing) {
        return { notification: shape(existing, null), held: false, duplicate: true };
      }
    }
    throw error;
  }
  const quiet = await wellbeing.holds(userId, type);
  return {
    notification: shape(row, null),
    held: quiet || await inDnd(userId),
    suppressed: false,
    duplicate: false,
  };
}

function shape(n, actor) {
  return {
    id: n.id, type: n.type, category: categoryOf(n.type),
    createdAt: n.created_at, readAt: n.read_at,
    referenceId: n.reference_id, detail: n.detail || null,
    // The actor, with their picture. A notification that shows a name and no
    // face is a notification about somebody the reader cannot recognise.
    actor: actor ? {
      id: actor.id,
      username: actor.username,
      displayName: actor.display_name,
      avatarUrl: actor.avatar_url || null,
    } : null,
  };
}

// Keyset cursor for the notification list.
//
// Encoded as "<created_at>|<id>". created_at alone is not a usable anchor: it
// is a timestamp with a resolution finer than a busy minute, so several
// notifications can share it and an anchor on that value alone would either
// skip the rest of the tie or loop forever. Pairing it with the primary key
// makes the order total and the boundary exact, which is the same reason the
// message tables moved to seq - the difference here is that notifications have
// no existing counter, and adding one would mean a migration for a list that
// is already ordered by an indexed column.
function encodeCursor(row) {
  return row ? row.created_at + '|' + row.id : null;
}

function decodeCursor(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const s = String(raw);
  const at = s.lastIndexOf('|');
  if (at <= 0) return null;
  const createdAt = s.slice(0, at);
  const id = s.slice(at + 1);
  if (!createdAt || !id) return null;
  return { createdAt, id };
}

async function list(userId, limit, cursor, category) {
  const lim = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 100);
  const anchor = decodeCursor(cursor);

  // A category narrows the list to the types that belong to it. The mapping
  // lives beside the closed type list, so a new notification cannot be added
  // without deciding which switch controls it.
  const wantedCategory = category ? String(category) : null;
  const categoryTypes = wantedCategory
    ? TYPES.filter((t) => categoryOf(t) === wantedCategory)
    : null;
  if (wantedCategory && !categoryTypes.length) {
    throw { code: 'VALIDATION_ERROR', message: 'Unknown notification category.' };
  }
  const typeClause = categoryTypes ? ` AND n.type IN (${categoryTypes.map(() => '?').join(',')})` : '';
  const typeParams = categoryTypes || [];

  let rows;
  if (anchor) {
    rows = await db.all(
      `SELECT n.*, u.username AS actor_name, u.display_name AS actor_display, u.avatar_url AS actor_avatar
       FROM notifications n LEFT JOIN users u ON u.id = n.actor_id
       WHERE n.user_id = ?
         AND (n.created_at < ? OR (n.created_at = ? AND n.id < ?))${typeClause}
       ORDER BY n.created_at DESC, n.id DESC LIMIT ${lim + 1}`,
      [userId, anchor.createdAt, anchor.createdAt, anchor.id].concat(typeParams)
    );
  } else {
    rows = await db.all(
      `SELECT n.*, u.username AS actor_name, u.display_name AS actor_display, u.avatar_url AS actor_avatar
       FROM notifications n LEFT JOIN users u ON u.id = n.actor_id
       WHERE n.user_id = ?${typeClause} ORDER BY n.created_at DESC, n.id DESC LIMIT ${lim + 1}`,
      [userId].concat(typeParams)
    );
  }

  const hasMore = rows.length > lim;
  if (hasMore) rows = rows.slice(0, lim);

  const unread = await db.get(
    'SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL',
    [userId]
  );
  const unreadRows = await db.all(
    `SELECT type, COUNT(*) AS n FROM notifications
     WHERE user_id = ? AND read_at IS NULL GROUP BY type`,
    [userId]
  );
  const unreadByCategory = {};
  for (const r of unreadRows) {
    const key = categoryOf(r.type);
    unreadByCategory[key] = (unreadByCategory[key] || 0) + Number(r.n || 0);
  }
  // Deep links: batch-resolve the referenced message so the client can jump
  // straight to it. Mentions and channel replies resolve to a channel, DM
  // replies to a conversation. Missing rows (deleted messages) simply carry no
  // context, and the row still renders.
  const needsCtx = rows.filter((r) => (r.type === 'mention' || r.type === 'reply') && r.reference_id);
  const ctx = {};
  const channelIds = [...new Set(needsCtx.filter((r) => r.type !== 'dm').map((r) => String(r.reference_id)))];
  if (channelIds.length) {
    const placeholders = channelIds.map(() => '?').join(',');
    const found = await db.all(
      `SELECT m.id AS mid, m.channel_id, ch.server_id FROM messages m
       JOIN channels ch ON ch.id = m.channel_id
       WHERE m.id IN (${placeholders})`,
      channelIds
    );
    for (const f of found) {
      ctx[String(f.mid)] = { serverId: String(f.server_id), channelId: String(f.channel_id), messageId: String(f.mid) };
    }
  }
  const dmIds = [...new Set(rows.filter((r) => r.type === 'reply' && r.reference_id).map((r) => String(r.reference_id)))];
  if (dmIds.length) {
    const placeholders = dmIds.map(() => '?').join(',');
    const found = await db.all(
      `SELECT m.id AS mid, m.conversation_id FROM dm_messages m WHERE m.id IN (${placeholders})`,
      dmIds
    );
    for (const f of found) {
      ctx[String(f.mid)] = { conversationId: String(f.conversation_id), messageId: String(f.mid) };
    }
  }
  // Workspace reminders name the event, and assignments name the card. The
  // client needs the community and board as well as the id, because neither
  // has a route of its own outside its community. The title and time are not
  // copied into the notification: they are read from the workspace, which
  // stays the authority if the event was moved or the card renamed.
  const eventIds = [...new Set(rows
    .filter((r) => r.type === 'event_reminder' && r.reference_id)
    .map((r) => String(r.reference_id)))];
  if (eventIds.length) {
    const placeholders = eventIds.map(() => '?').join(',');
    const found = await db.all(
      `SELECT id, server_id FROM events WHERE id IN (${placeholders})`,
      eventIds
    );
    for (const f of found) {
      ctx[String(f.id)] = { serverId: String(f.server_id), eventId: String(f.id) };
    }
  }
  const cardIds = [...new Set(rows
    .filter((r) => r.type === 'card_assigned' && r.reference_id)
    .map((r) => String(r.reference_id)))];
  if (cardIds.length) {
    const placeholders = cardIds.map(() => '?').join(',');
    const found = await db.all(
      `SELECT id, server_id, board_id FROM cards WHERE id IN (${placeholders})`,
      cardIds
    );
    for (const f of found) {
      ctx[String(f.id)] = {
        serverId: String(f.server_id),
        boardId: String(f.board_id),
        cardId: String(f.id),
      };
    }
  }
  return {
    // Unread is a whole-account badge count, not a per-page count, so it must
    // not shrink just because the caller paged.
    unreadCount: unread ? unread.n : 0,
    unreadByCategory,
    category: wantedCategory,
    items: rows.map((r) => {
      const out = shape(r, r.actor_name ? {
        id: r.actor_id,
        username: r.actor_name,
        display_name: r.actor_display,
        avatar_url: r.actor_avatar,
      } : null);
      if (ctx[String(r.reference_id)]) {
        out.context = ctx[String(r.reference_id)];
      }
      return out;
    }),
    // Cursor for the next older page, or null at the end of the list.
    nextCursor: hasMore && rows.length ? encodeCursor(rows[rows.length - 1]) : null,
    hasMore,
  };
}

async function markRead(userId, id) {
  const n = await db.get('SELECT * FROM notifications WHERE id = ? AND user_id = ?', [id, userId]);
  if (!n) throw { code: 'NOT_FOUND', message: 'Notification not found' };
  await db.run('UPDATE notifications SET read_at = ? WHERE id = ?', [now(), id]);
  return { id, read: true };
}

async function markAllRead(userId) {
  await db.run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', [now(), userId]);
  return { ok: true };
}

// Remove one notification. Scoped to the owner by the same condition as every
// other query here; a caller who knows another account's id learns nothing.
async function remove(userId, id) {
  const n = await db.get('SELECT id FROM notifications WHERE id = ? AND user_id = ?', [id, userId]);
  if (!n) throw { code: 'NOT_FOUND', message: 'Notification not found' };
  await db.run('DELETE FROM notifications WHERE id = ? AND user_id = ?', [id, userId]);
  return { id, deleted: true };
}

// Clear the list. `read` narrows it to the ones already read, which is the
// common "clear the ones I have dealt with" action; omitting it clears all.
async function clear(userId, { read } = {}) {
  const onlyRead = read === true || read === 'true' || read === 1 || read === '1';
  if (onlyRead) {
    await db.run('DELETE FROM notifications WHERE user_id = ? AND read_at IS NOT NULL', [userId]);
  } else {
    await db.run('DELETE FROM notifications WHERE user_id = ?', [userId]);
  }
  const left = await db.get('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?', [userId]);
  return { ok: true, remaining: Number((left && left.n) || 0) };
}

module.exports = { TYPES, CATEGORY_OF, categoryOf, create, list, markRead, markAllRead, remove, clear };
