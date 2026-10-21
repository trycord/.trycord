// Forums.
//
// A forum is a channel whose root messages are topics and whose replies are
// the discussion under each topic. It is **not** a second discussion model: the
// topic is an ordinary message, the reply is an ordinary thread reply, and the
// existing thread route serves the conversation. What a forum adds is the way
// the messages are *presented* — a list of topics rather than a running feed —
// and a way for a reader to follow a topic they care about.
//
// A channel becomes a forum by being created with the type. The type is
// recorded on the channel row, so the presentation decision is made once, at
// the channel, rather than being inferred per request.
//
// What a forum is not: a separate store, a separate permission system, or a
// separate copy of a message. Everything here reads and writes the same rows
// the channel does.
const db = require('../db');
const { now, uuid } = require('../util');
const threads = require('./threads');

// The ways a topic list can be ordered.
//
// "Latest" is the newest activity first, which is what a reader wants from a
// forum: the topic that was just talked in, not the topic that was started
// last. The activity is the newest reply, or the topic's own creation when it
// has no replies.
const SORTS = {
  latest: 'activity',
  oldest: 'created',
  replies: 'replies',
};

function sortOf(raw) {
  const key = String(raw || 'latest').trim().toLowerCase();
  return SORTS[key] ? key : 'latest';
}

function isForum(channel) {
  return String((channel && channel.type) || '').toLowerCase() === 'forum';
}

/**
 * The topics of a forum channel.
 *
 * Only the root messages: a reply belongs under its topic and is reached
 * through the thread route, the same way it is anywhere else. A flat feed of
 * every message in a forum is a chat channel wearing a forum's name.
 *
 * @param {object} channel  the channel row, already permission-checked
 * @param {object} options  { limit, offset, sort, q }
 */
async function topics(channel, options = {}) {
  const limit = Math.min(Math.max(parseInt(options.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(options.offset, 10) || 0, 0);
  const sort = sortOf(options.sort);
  const q = String(options.q || '').trim();

  const params = [channel.id];
  let where = 'm.channel_id = ? AND m.thread_root_id IS NULL';
  if (q) {
    where += ' AND m.content LIKE ?';
    params.push('%' + q.replace(/[!%_]/g, (c) => '!' + c) + '%');
  }

  // The ordering is computed in the query rather than in the client, because
  // "most recently active" is not a column: it is the newest reply, and the
  // reply count and the last activity both come from the reply table.
  //
  // The reply table is joined rather than sub-selected so the sort can use an
  // index, and the join is on the scope as well as the root, so a reply in
  // another channel never counts towards a topic's activity.
  const order = sort === 'oldest'
    ? 'm.created_at ASC, m.id ASC'
    : sort === 'replies'
      ? 'reply_count DESC, m.created_at ASC'
      : 'last_activity_at DESC, m.created_at ASC';

  const rows = await db.all(
    `SELECT m.*, u.username AS author_name, u.display_name AS author_display,
            u.avatar_url AS author_avatar, u.banner_url AS author_banner, u.is_bot AS author_is_bot,
            (SELECT COUNT(*) FROM messages r
               WHERE r.thread_root_id = m.id AND r.channel_id = m.channel_id) AS reply_count,
            (SELECT COALESCE(MAX(r.created_at), m.created_at) FROM messages r
               WHERE r.thread_root_id = m.id AND r.channel_id = m.channel_id) AS last_activity_at
     FROM messages m JOIN users u ON u.id = m.author_id
     WHERE ${where}
     ORDER BY ${order}
     LIMIT ${limit} OFFSET ${offset}`,
    params
  );

  const totalRow = await db.get(
    'SELECT COUNT(*) AS n FROM messages m WHERE ' + where,
    params
  );

  return {
    topics: rows,
    total: totalRow ? Number(totalRow.n) : 0,
    limit,
    offset,
    sort,
  };
}

/**
 * Follow a topic.
 *
 * A subscription is the reader's own record. It is what a later notification
 * is built on, and it is removed with the account.
 */
async function subscribe(userId, channelId, messageId) {
  // The topic has to exist in this channel. A subscription to a message that
  // is not a topic here would follow nothing.
  const topic = await db.get(
    'SELECT id FROM messages WHERE id = ? AND channel_id = ? AND thread_root_id IS NULL',
    [messageId, channelId]
  );
  if (!topic) {
    const e = new Error('that topic does not exist in this channel');
    e.code = 'NOT_FOUND';
    throw e;
  }
  const existing = await db.get(
    'SELECT id FROM forum_subscriptions WHERE user_id = ? AND message_id = ?',
    [userId, messageId]
  );
  if (existing) return { subscribed: true, messageId };
  try {
    await db.run(
      'INSERT INTO forum_subscriptions (id, user_id, channel_id, message_id, created_at) VALUES (?, ?, ?, ?, ?)',
      [uuid(), userId, channelId, messageId, now()]
    );
  } catch (error) {
    // Two follows at once raced the check above, and the second insert was
    // refused by the uniqueness that keeps one subscription per reader per
    // topic. The subscription the first one made is the subscription.
    if (db.isUniqueViolation(error)) return { subscribed: true, messageId };
    throw error;
  }
  return { subscribed: true, messageId };
}

async function unsubscribe(userId, messageId) {
  await db.run(
    'DELETE FROM forum_subscriptions WHERE user_id = ? AND message_id = ?',
    [userId, messageId]
  );
  return { subscribed: false, messageId };
}

/** The topics a reader is following, newest subscription first. */
async function subscriptions(userId, options = {}) {
  const limit = Math.min(Math.max(parseInt(options.limit, 10) || 50, 1), 200);
  const rows = await db.all(
    `SELECT s.message_id, s.channel_id, s.created_at AS subscribed_at,
            m.content, m.created_at, u.username AS author_name, u.display_name AS author_display
     FROM forum_subscriptions s
     JOIN messages m ON m.id = s.message_id
     JOIN users u ON u.id = m.author_id
     WHERE s.user_id = ?
     ORDER BY s.created_at DESC LIMIT ${limit}`,
    [userId]
  );
  return rows.map((r) => ({
    messageId: r.message_id,
    channelId: r.channel_id,
    subscribedAt: r.subscribed_at,
    title: excerpt(r.content),
    author: { username: r.author_name, displayName: r.author_display },
  }));
}

/** Whether a reader is following a set of topics. */
async function subscribedTo(userId, messageIds) {
  const ids = (messageIds || []).filter(Boolean).slice(0, 250);
  if (!ids.length) return {};
  const rows = await db.all(
    'SELECT message_id FROM forum_subscriptions WHERE user_id = ? AND message_id IN ('
    + ids.map(() => '?').join(',') + ')',
    [userId].concat(ids)
  );
  const out = {};
  for (const r of rows) out[r.message_id] = true;
  return out;
}

/** The first line of a message, which is what a topic list shows. */
function excerpt(content, max = 120) {
  const text = String(content || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

module.exports = {
  SORTS, isForum, sortOf, topics, subscribe, unsubscribe,
  subscriptions, subscribedTo, excerpt,
};
