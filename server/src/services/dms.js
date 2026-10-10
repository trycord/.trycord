// Direct messages.
//
// A conversation is a pair, not a room: pair_key is derived from the two user ids in a
// stable order, so there is exactly one conversation between two people no matter which
// of them opened it, and no group channel can be created by accident.

const db = require('../db');
const { now, uuid } = require('../util');
const bus = require('./bus');

// The key is order-independent, so A talking to B and B talking to A are the same pair.
function pairKey(a, b) {
  return [String(a), String(b)].sort().join(':');
}

async function list(userId) {
  const rows = await db.all(
    `SELECT c.id, c.updated_at, peer.id AS peer_id, peer.username AS peer_username,
       peer.display_name AS peer_display, peer.avatar_url AS peer_avatar,
       last.content AS last_content, last.created_at AS last_at,
       (SELECT COUNT(*) FROM dm_messages m
          WHERE m.conversation_id = c.id AND m.seq > COALESCE((
            SELECT seq FROM dm_messages m2
              WHERE m2.conversation_id = c.id AND m2.id IN (
                SELECT reference_id FROM notifications
                  WHERE user_id = ? AND type = 'dm' AND reference_id IS NOT NULL)
            ), 0)) AS unread
     FROM dm_conversations c
       JOIN dm_members mine ON mine.conversation_id = c.id AND mine.user_id = ?
       JOIN dm_members theirs ON theirs.conversation_id = c.id AND theirs.user_id != ?
       JOIN users peer ON peer.id = theirs.user_id
       LEFT JOIN dm_messages last ON last.id = (
         SELECT id FROM dm_messages WHERE conversation_id = c.id ORDER BY seq DESC LIMIT 1
       )
     ORDER BY c.updated_at DESC`,
    [userId, userId, userId]
  );

  return rows.map((r) => ({
    id: r.id,
    updatedAt: r.updated_at,
    peer: {
      id: r.peer_id,
      username: r.peer_username,
      displayName: r.peer_display,
      avatarUrl: r.peer_avatar || null,
    },
    lastMessage: r.last_content ? {
      content: String(r.last_content).slice(0, 80),
      createdAt: r.last_at,
    } : null,
    unreadCount: Number(r.unread || 0),
  }));
}

async function open(userId, peerId) {
  if (String(userId) === String(peerId)) {
    throw { code: 'VALIDATION_ERROR', message: 'you cannot open a conversation with yourself' };
  }

  const existing = await db.get(
    `SELECT c.id FROM dm_conversations c
       JOIN dm_members a ON a.conversation_id = c.id AND a.user_id = ?
       JOIN dm_members b ON b.conversation_id = c.id AND b.user_id = ?
      WHERE c.pair_key = ?`,
    [userId, peerId, pairKey(userId, peerId)]
  );
  if (existing) return { conversationId: existing.id };

  const id = uuid();
  const at = now();
  await db.run(
    'INSERT INTO dm_conversations (id, pair_key, created_at, updated_at) VALUES (?, ?, ?, ?)',
    [id, pairKey(userId, peerId), at, at]
  );
  for (const who of [userId, peerId]) {
    await db.run(
      'INSERT INTO dm_members (conversation_id, user_id, joined_at) VALUES (?, ?, ?)',
      [id, who, at]
    );
  }
  return { conversationId: id };
}

async function detail(conversationId, userId) {
  const member = await db.get(
    'SELECT 1 FROM dm_members WHERE conversation_id = ? AND user_id = ?',
    [conversationId, userId]
  );
  if (!member) throw { code: 'NOT_A_MEMBER', message: 'conversation not found or not a member' };

  const conv = await db.get('SELECT * FROM dm_conversations WHERE id = ?', [conversationId]);
  if (!conv) throw { code: 'NOT_FOUND', message: 'conversation not found' };

  const peer = await db.get(
    `SELECT u.id, u.username, u.display_name, u.avatar_url, u.banner_url
       FROM dm_members m JOIN users u ON u.id = m.user_id
      WHERE m.conversation_id = ? AND m.user_id != ?`,
    [conversationId, userId]
  );

  return {
    id: conv.id,
    peer: peer ? {
      id: peer.id,
      username: peer.username,
      displayName: peer.display_name,
      avatarUrl: peer.avatar_url || null,
      bannerUrl: peer.banner_url || null,
    } : null,
    createdAt: conv.created_at,
  };
}

// A member may leave a one-to-one conversation, which removes them from it rather than
// deleting the other person's history.
async function leave(conversationId, userId) {
  await db.run(
    'DELETE FROM dm_members WHERE conversation_id = ? AND user_id = ?',
    [conversationId, userId]
  );
  return { ok: true };
}

async function nextSeq(conversationId) {
  const row = await db.get(
    'SELECT COALESCE(MAX(seq), 0) AS m FROM dm_messages WHERE conversation_id = ?',
    [conversationId]
  );
  return Number(row.m) + 1;
}

async function history(conversationId, userId, query = {}) {
  await detail(conversationId, userId);

  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), 200);
  const select = `SELECT m.*, u.username AS author_name, u.display_name AS author_display,
       u.avatar_url AS author_avatar, u.banner_url AS author_banner
     FROM dm_messages m JOIN users u ON u.id = m.author_id`;

  let rows;
  if (query.after !== undefined && query.after !== '') {
    const after = Math.max(parseInt(query.after, 10) || 0, 0);
    rows = await db.all(
      `${select} WHERE m.conversation_id = ? AND m.seq > ? ORDER BY m.seq ASC LIMIT ${limit}`,
      [conversationId, after]
    );
  } else if (query.before) {
    const raw = String(query.before);
    const anchor = /^\d+$/.test(raw)
      ? Number(raw)
      : await seqOf(conversationId, raw);
    if (anchor === null) throw { code: 'NOT_FOUND', message: 'message not found' };
    rows = await db.all(
      `${select} WHERE m.conversation_id = ? AND m.seq < ? ORDER BY m.seq DESC LIMIT ${limit}`,
      [conversationId, anchor]
    );
  } else {
    rows = await db.all(
      `${select} WHERE m.conversation_id = ? ORDER BY m.seq DESC LIMIT ${limit}`,
      [conversationId]
    );
  }

  // Normalise to oldest-first, so a client can always append.
  if (query.after === undefined || query.after === '') rows.reverse();
  return decorate(rows);
}

async function seqOf(conversationId, id) {
  const row = await db.get(
    'SELECT seq FROM dm_messages WHERE id = ? AND conversation_id = ?',
    [id, conversationId]
  );
  return row ? Number(row.seq) : null;
}

async function decorate(rows) {
  if (!rows.length) return [];
  return rows.map((r) => ({
    id: r.id,
    conversationId: r.conversation_id,
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
  }));
}

async function post(conversationId, viewer, { content, threadRootId, clientNonce }) {
  await detail(conversationId, viewer.id);

  const text = String(content == null ? '' : content);
  if (!text.trim()) throw { code: 'VALIDATION_ERROR', message: 'a message needs some text' };
  if (text.length > 4000) throw { code: 'VALIDATION_ERROR', message: 'a message is at most 4000 characters' };

  if (clientNonce) {
    const existing = await db.get(
      'SELECT * FROM dm_messages WHERE conversation_id = ? AND client_nonce = ?',
      [conversationId, String(clientNonce)]
    );
    if (existing) return { message: (await decorate([existing]))[0], deduped: true };
  }

  const id = uuid();
  const at = now();
  await db.run(
    `INSERT INTO dm_messages (id, conversation_id, author_id, content, created_at, seq, client_nonce, thread_root_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, conversationId, viewer.id, text, at, await nextSeq(conversationId),
      clientNonce ? String(clientNonce) : null, threadRootId || null]
  );
  await db.run('UPDATE dm_conversations SET updated_at = ? WHERE id = ?', [at, conversationId]);

  const row = await db.get('SELECT * FROM dm_messages WHERE id = ?', [id]);
  const message = (await decorate([row]))[0];
  bus.emit('dm:' + conversationId, { type: 'message', message });
  return { message, deduped: false };
}

async function edit(conversationId, messageId, viewer, content) {
  const row = await db.get(
    'SELECT * FROM dm_messages WHERE id = ? AND conversation_id = ?',
    [messageId, conversationId]
  );
  if (!row) throw { code: 'NOT_FOUND', message: 'message not found' };
  if (row.author_id !== viewer.id) {
    throw { code: 'PERMISSION_DENIED', message: 'you can only edit your own messages' };
  }
  const text = String(content == null ? '' : content);
  if (!text.trim()) throw { code: 'VALIDATION_ERROR', message: 'a message needs some text' };

  await db.run('UPDATE dm_messages SET content = ?, edited_at = ? WHERE id = ?', [text, now(), messageId]);
  return { ok: true };
}

async function remove(conversationId, messageId, viewer) {
  const row = await db.get(
    'SELECT * FROM dm_messages WHERE id = ? AND conversation_id = ?',
    [messageId, conversationId]
  );
  if (!row) throw { code: 'NOT_FOUND', message: 'message not found' };
  if (row.author_id !== viewer.id) {
    throw { code: 'PERMISSION_DENIED', message: 'you can only delete your own messages' };
  }
  await db.run('DELETE FROM dm_messages WHERE id = ?', [messageId]);
  return { ok: true };
}

async function markRead(conversationId, userId) {
  await db.run(
    'UPDATE dm_members SET last_read_at = ? WHERE conversation_id = ? AND user_id = ?',
    [now(), conversationId, userId]
  );
  return { ok: true };
}

module.exports = {
  pairKey, list, open, detail, leave,
  history, post, edit, remove, markRead, seqOf,
};
