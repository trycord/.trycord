// Channels, messages and threads.

const db = require('../db');
const { now, uuid } = require('../util');
const servers = require('./servers');
const channels = require('./channels');
const bus = require('./bus');
const publish = (room, payload) => bus.emit(room, payload);

const MAX_CONTENT = 4000;

async function remove(serverId, channelId, viewerId) {
  const perms = await servers.permissions(viewerId, serverId);
  if (!servers.can(perms, 'MANAGE_CHANNELS')) {
    throw { code: 'PERMISSION_DENIED', message: 'you cannot delete channels in this community' };
  }
  const ch = await db.get('SELECT id FROM channels WHERE id = ? AND server_id = ?', [channelId, serverId]);
  if (!ch) throw { code: 'NOT_FOUND', message: 'channel not found' };
  await db.run('DELETE FROM channels WHERE id = ?', [channelId]);
  return { ok: true };
}

// A message body is capped rather than truncated: slicing to the limit loses what the
// sender meant to say, and a refusal they can act on is better than a silent edit.
function validateContent(content) {
  const text = String(content == null ? '' : content);
  if (!text.trim()) throw { code: 'VALIDATION_ERROR', message: 'a message needs some text' };
  if (text.length > MAX_CONTENT) {
    throw { code: 'VALIDATION_ERROR', message: `a message is at most ${MAX_CONTENT} characters` };
  }
  return text;
}

async function nextSeq(channelId) {
  const row = await db.get('SELECT COALESCE(MAX(seq), 0) AS m FROM messages WHERE channel_id = ?', [channelId]);
  return Number(row.m) + 1;
}

// A message id resolves to its seq, scoped so an id from another channel cannot be used
// as an anchor here.
async function seqOf(table, scopeColumn, scopeId, id) {
  const row = await db.get(`SELECT seq FROM ${table} WHERE id = ? AND ${scopeColumn} = ?`, [id, scopeId]);
  if (!row || row.seq == null) return null;
  return Number(row.seq);
}

async function history(channelId, viewerId, query = {}) {
  const ch = await channels.visible(viewerId, channelId);
  if (!ch) throw { code: 'NOT_A_MEMBER', message: 'channel not found or not a member' };

  // The integer is embedded after validation, which keeps LIMIT working on both engines.
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 200);
  const select = `SELECT m.*, u.username AS author_name, u.display_name AS author_display,
       u.avatar_url AS author_avatar, u.banner_url AS author_banner
     FROM messages m JOIN users u ON u.id = m.author_id`;

  let rows;
  if (query.after !== undefined && query.after !== '') {
    const after = Math.max(parseInt(query.after, 10) || 0, 0);
    rows = await db.all(
      `${select} WHERE m.channel_id = ? AND m.seq > ? ORDER BY m.seq ASC LIMIT ${limit}`,
      [ch.id, after]
    );
  } else if (query.before) {
    const raw = String(query.before);
    const anchor = /^\d+$/.test(raw) ? Number(raw) : await seqOf('messages', 'channel_id', ch.id, raw);
    if (anchor === null) throw { code: 'NOT_FOUND', message: 'message not found' };
    rows = await db.all(
      `${select} WHERE m.channel_id = ? AND m.seq < ? ORDER BY m.seq DESC LIMIT ${limit}`,
      [ch.id, anchor]
    );
  } else {
    rows = await db.all(`${select} WHERE m.channel_id = ? ORDER BY m.seq DESC LIMIT ${limit}`, [ch.id]);
  }

  // Normalise to oldest-first, so a client can always append. The default and forward
  // reads are already ascending, so the reverse only means something for a backward page.
  if (query.after === undefined || query.after === '') rows.reverse();

  return decorate(rows);
}

async function byId(channelId, messageId, viewerId) {
  const ch = await channels.visible(viewerId, channelId);
  if (!ch) throw { code: 'NOT_A_MEMBER', message: 'channel not found or not a member' };
  const row = await db.get(
    `SELECT m.*, u.username AS author_name, u.display_name AS author_display,
       u.avatar_url AS author_avatar, u.banner_url AS author_banner
     FROM messages m JOIN users u ON u.id = m.author_id
      WHERE m.id = ? AND m.channel_id = ?`,
    [messageId, ch.id]
  );
  if (!row) throw { code: 'NOT_FOUND', message: 'message not found' };
  const [decorated] = await decorate([row]);
  return decorated;
}

async function decorate(rows) {
  const ids = rows.map((r) => r.id);
  if (!ids.length) return [];

  const marks = new Set();
  for (const id of ids) marks.add(`'${id}'`);

  const attachments = await db.all(
    `SELECT * FROM attachments WHERE message_id IN (${[...marks].join(',')})`
  );
  const byMessage = {};
  for (const a of attachments) {
    (byMessage[a.message_id] = byMessage[a.message_id] || []).push(a);
  }

  const replies = await db.all(
    `SELECT thread_root_id AS root, COUNT(*) AS n FROM messages
      WHERE thread_root_id IN (${[...marks].join(',')}) GROUP BY thread_root_id`
  );
  const replyCount = {};
  for (const r of replies) replyCount[r.root] = Number(r.n);

  return rows.map((r) => ({
    id: r.id,
    channelId: r.channel_id,
    authorId: r.author_id,
    author: r.author_display || r.author_name,
    username: r.author_name,
    displayName: r.author_display || r.author_name,
    avatarUrl: r.author_avatar || null,
    bannerUrl: r.author_banner || null,
    content: r.content,
    createdAt: r.created_at,
    editedAt: r.edited_at || null,
    seq: r.seq,
    threadRootId: r.thread_root_id || null,
    attachments: (byMessage[r.id] || []).map((a) => ({
      id: a.id, filename: a.filename, mime: a.mime, size: a.size, url: a.url,
    })),
    replyCount: replyCount[r.id] || 0,
  }));
}

async function post(channelId, viewer, { content, threadRootId, clientNonce }) {
  const ch = await channels.visible(viewer.id, channelId);
  if (!ch) throw { code: 'NOT_A_MEMBER', message: 'channel not found or not a member' };

  if (!servers.can(ch.permissions, 'SEND_MESSAGES')) {
    throw { code: 'PERMISSION_DENIED', message: 'you cannot post in this community' };
  }

  const text = validateContent(content);

  // A duplicate client nonce is answered with the message that already carries it rather
  // than a second copy, so a retry does not double-post.
  if (clientNonce) {
    const existing = await db.get(
      'SELECT * FROM messages WHERE channel_id = ? AND client_nonce = ?',
      [ch.id, String(clientNonce)]
    );
    if (existing) {
      const [row] = await decorate([existing]);
      return { message: row, deduped: true };
    }
  }

  let rootId = null;
  if (threadRootId) {
    const root = await db.get('SELECT id FROM messages WHERE id = ? AND channel_id = ?', [threadRootId, ch.id]);
    if (!root) throw { code: 'NOT_FOUND', message: 'the message being replied to is not in this channel' };
    rootId = root.id;
  }

  const id = uuid();
  const at = now();
  const seq = await nextSeq(ch.id);

  await db.run(
    `INSERT INTO messages (id, channel_id, author_id, content, created_at, seq, client_nonce, thread_root_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, ch.id, viewer.id, text, at, seq, clientNonce ? String(clientNonce) : null, rootId]
  );

  const row = await db.get('SELECT * FROM messages WHERE id = ?', [id]);
  const [message] = await decorate([row]);
  // Published to both rooms, so a reader with the channel open sees it without a refresh
  // and one with the community open sees the unread move.
  publish('channel:' + ch.id, { type: 'message', message });
  publish('server:' + ch.server_id, { type: 'message', message });
  return { message, deduped: false };
}

async function edit(channelId, messageId, viewer, content) {
  const row = await db.get('SELECT * FROM messages WHERE id = ? AND channel_id = ?', [messageId, channelId]);
  if (!row) throw { code: 'NOT_FOUND', message: 'message not found' };
  if (row.author_id !== viewer.id) {
    throw { code: 'PERMISSION_DENIED', message: 'you can only edit your own messages' };
  }
  const text = validateContent(content);
  await db.run('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?', [text, now(), messageId]);
  return { ok: true };
}

async function remove(channelId, messageId, viewer) {
  const row = await db.get('SELECT * FROM messages WHERE id = ? AND channel_id = ?', [messageId, channelId]);
  if (!row) throw { code: 'NOT_FOUND', message: 'message not found' };

  const ch = await channels.visible(viewer.id, channelId);
  const mayModerate = servers.can(ch.permissions, 'MANAGE_MESSAGES');
  if (row.author_id !== viewer.id && !mayModerate) {
    throw { code: 'PERMISSION_DENIED', message: 'you cannot delete someone else\'s message' };
  }

  await db.run('DELETE FROM messages WHERE id = ?', [messageId]);
  return { ok: true };
}

async function react(channelId, messageId, viewer, emoji) {
  const row = await db.get('SELECT id FROM messages WHERE id = ? AND channel_id = ?', [messageId, channelId]);
  if (!row) throw { code: 'NOT_FOUND', message: 'message not found' };

  const clean = String(emoji || '').slice(0, 32);
  if (!clean) throw { code: 'VALIDATION_ERROR', message: 'an emoji is required' };

  const existing = await db.get(
    'SELECT 1 FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?',
    [messageId, viewer.id, clean]
  );

  if (existing) {
    await db.run(
      'DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?',
      [messageId, viewer.id, clean]
    );
  } else {
    await db.run(
      'INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)',
      [messageId, viewer.id, clean, now()]
    );
  }
  return { reactions: await reactionSummary([messageId]) };
}

async function reactionSummary(messageIds) {
  if (!messageIds.length) return {};
  const marks = messageIds.map((id) => `'${id}'`).join(',');
  const rows = await db.all(
    `SELECT message_id, emoji, COUNT(*) AS n FROM reactions
      WHERE message_id IN (${marks}) GROUP BY message_id, emoji`
  );
  const out = {};
  for (const r of rows) {
    (out[r.message_id] = out[r.message_id] || []).push({ emoji: r.emoji, count: Number(r.n) });
  }
  return out;
}

async function thread(messageId, viewerId) {
  const row = await db.get('SELECT * FROM messages WHERE id = ?', [messageId]);
  if (!row) throw { code: 'NOT_FOUND', message: 'message not found' };
  const ch = await channels.visible(viewerId, row.channel_id);
  if (!ch) throw { code: 'NOT_A_MEMBER', message: 'channel not found or not a member' };

  const replies = await db.all(
    `SELECT m.*, u.username AS author_name, u.display_name AS author_display, u.avatar_url AS author_avatar
     FROM messages m JOIN users u ON u.id = m.author_id
      WHERE m.thread_root_id = ? ORDER BY m.seq ASC`,
    [messageId]
  );
  const [root] = await decorate([row]);
  return { root, replies: await decorate(replies) };
}

module.exports = {
  history, byId, post, edit, remove: remove, react, thread,
  reactionSummary, seqOf, nextSeq, MAX_CONTENT,
};
