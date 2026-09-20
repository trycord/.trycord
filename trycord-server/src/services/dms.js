// Direct-message conversations: transactional get-or-create with a canonical
// participant-pair key (so Alice↔Bob is always exactly one conversation),
// cursor-paginated history, persistent read positions, author-only delete.
// All multi-row flows run inside db.transaction (works on SQLite + MySQL).
const db = require('../db');
const { now, uuid } = require('../util');

const MAX_CONTENT = 2000;

// Canonical key for a one-to-one pair. Order-independent by construction,
// so the UNIQUE(pair_key) constraint is the duplicate-conversation guard.
function pairKey(a, b) {
  return [String(a), String(b)].sort().join(':');
}

async function peerExists(id) {
  return !!(await db.get('SELECT id FROM users WHERE id = ?', [id]));
}

function publicPeer(row) {
  if (!row) return null;
  return { id: row.id, username: row.username, displayName: row.display_name, createdAt: row.created_at };
}

// The conversation row if `userId` belongs to it, else null.
async function visibleConversation(conversationId, userId, t) {
  const q = t || db;
  const conv = await q.get('SELECT * FROM dm_conversations WHERE id = ?', [conversationId]);
  if (!conv) return null;
  const member = await q.get(
    'SELECT * FROM dm_members WHERE conversation_id = ? AND user_id = ?',
    [conversationId, userId]
  );
  return member ? { conv, member } : null;
}

async function memberIds(conversationId, t) {
  const q = t || db;
  const rows = await q.all('SELECT user_id FROM dm_members WHERE conversation_id = ?', [conversationId]);
  return rows.map((r) => r.user_id);
}

// Get-or-create the 1:1 conversation between me and peerId.
// Race-safe: UNIQUE(pair_key) decides the winner; the loser re-reads.
async function getOrCreate(me, peerId) {
  if (!peerId) throw { code: 'VALIDATION_ERROR', message: 'userId required' };
  if (String(peerId) === String(me.id)) throw { code: 'VALIDATION_ERROR', message: 'you cannot DM yourself' };
  if (!(await peerExists(peerId))) throw { code: 'NOT_FOUND', message: 'user not found' };
  const pair = pairKey(me.id, peerId);

  let conv = await db.get('SELECT * FROM dm_conversations WHERE pair_key = ?', [pair]);
  if (conv) return { conversation: conv, created: false };

  const id = uuid();
  const ts = now();
  try {
    await db.transaction(async (t) => {
      await t.run(
        'INSERT INTO dm_conversations (id, pair_key, created_at, updated_at) VALUES (?, ?, ?, ?)',
        [id, pair, ts, ts]
      );
      await t.run(
        'INSERT INTO dm_members (conversation_id, user_id, joined_at, last_read_at) VALUES (?, ?, ?, ?)',
        [id, me.id, ts, ts]
      );
      await t.run(
        'INSERT INTO dm_members (conversation_id, user_id, joined_at, last_read_at) VALUES (?, ?, ?, ?)',
        [id, peerId, ts, null]
      );
    });
    conv = await db.get('SELECT * FROM dm_conversations WHERE id = ?', [id]);
    return { conversation: conv, created: true };
  } catch (e) {
    // Lost the race: someone created it first. Re-read instead of failing.
    const msg = String((e && e.message) || '');
    if (/UNIQUE|unique|ER_DUP_ENTRY|SQLITE_CONSTRAINT_UNIQUE/i.test(msg) || e.code === 'ER_DUP_ENTRY') {
      conv = await db.get('SELECT * FROM dm_conversations WHERE pair_key = ?', [pair]);
      if (conv) return { conversation: conv, created: false };
    }
    throw e;
  }
}

function conversationShape(conv, peer, lastMessage, unreadCount, members) {
  return {
    id: conv.id,
    createdAt: conv.created_at,
    updatedAt: conv.updated_at,
    peer,
    lastMessage: lastMessage || null,
    unreadCount: unreadCount || 0,
    members: members || undefined,
  };
}

// Everyone the user chats with, most-recently-active first, with the peer,
// the latest message, and the unread count each.
async function listMine(userId) {
  const memberships = await db.all(
    `SELECT m.*, c.updated_at, c.created_at AS conv_created
     FROM dm_members m JOIN dm_conversations c ON c.id = m.conversation_id
     WHERE m.user_id = ?`,
    [userId]
  );
  const out = [];
  for (const m of memberships) {
    const peerRow = await db.get(
      `SELECT u.* FROM users u
       JOIN dm_members om ON om.user_id = u.id
       WHERE om.conversation_id = ? AND om.user_id != ? LIMIT 1`,
      [m.conversation_id, userId]
    );
    const last = await db.get(
      `SELECT dm.*, u.username AS author_name, u.display_name AS author_display
       FROM dm_messages dm JOIN users u ON u.id = dm.author_id
       WHERE dm.conversation_id = ? ORDER BY dm.created_at DESC, dm.id DESC LIMIT 1`,
      [m.conversation_id]
    );
    const unread = await db.get(
      `SELECT COUNT(*) AS n FROM dm_messages
       WHERE conversation_id = ? AND author_id != ?
         AND ( ? IS NULL OR created_at > ? )`,
      [m.conversation_id, userId, m.last_read_at, m.last_read_at]
    );
    out.push(conversationShape(
      { id: m.conversation_id, created_at: m.conv_created, updated_at: last ? last.created_at : m.updated_at },
      publicPeer(peerRow),
      last ? {
        id: last.id, content: last.content, createdAt: last.created_at,
        authorId: last.author_id, authorName: last.author_display || last.author_name,
      } : null,
      unread ? unread.n : 0
    ));
  }
  out.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return out;
}

// Latest N messages, then older pages via before=<messageId>.
// Deterministic order: (created_at, id), ascending for the client.
async function history(userId, conversationId, { before = null, limit = 50 } = {}) {
  const seen = await visibleConversation(conversationId, userId);
  if (!seen) throw { code: 'NOT_A_MEMBER', message: 'conversation not found' };
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  let rows;
  if (before) {
    const anchor = await db.get(
      'SELECT created_at FROM dm_messages WHERE id = ? AND conversation_id = ?',
      [before, conversationId]
    );
    if (!anchor) throw { code: 'NOT_FOUND', message: 'message not found' };
    rows = await db.all(
      `SELECT dm.*, u.username AS author_name, u.display_name AS author_display
       FROM dm_messages dm JOIN users u ON u.id = dm.author_id
       WHERE dm.conversation_id = ? AND (dm.created_at < ? OR (dm.created_at = ? AND dm.id < ?))
       ORDER BY dm.created_at DESC, dm.id DESC LIMIT ${lim}`,
      [conversationId, anchor.created_at, anchor.created_at, before]
    );
  } else {
    rows = await db.all(
      `SELECT dm.*, u.username AS author_name, u.display_name AS author_display
       FROM dm_messages dm JOIN users u ON u.id = dm.author_id
       WHERE dm.conversation_id = ? ORDER BY dm.created_at DESC, dm.id DESC LIMIT ${lim}`,
      [conversationId]
    );
  }
  return rows.reverse().map((m) => ({
    id: m.id,
    conversationId: m.conversation_id,
    content: m.content,
    createdAt: m.created_at,
    authorId: m.author_id,
    authorName: m.author_display || m.author_name,
  }));
}

async function send(userId, username, conversationId, content) {
  const seen = await visibleConversation(conversationId, userId);
  if (!seen) throw { code: 'NOT_A_MEMBER', message: 'conversation not found' };
  const text = String((content === null || content === undefined) ? '' : content).trim();
  if (!text) throw { code: 'VALIDATION_ERROR', message: 'message is empty' };
  if (text.length > MAX_CONTENT) {
    throw { code: 'VALIDATION_ERROR', message: `message too long (max ${MAX_CONTENT} characters)` };
  }
  const msg = { id: uuid(), conversation_id: conversationId, author_id: userId, content: text.slice(0, MAX_CONTENT), created_at: now() };
  await db.transaction(async (t) => {
    await t.run(
      'INSERT INTO dm_messages (id, conversation_id, author_id, content, created_at) VALUES (?, ?, ?, ?, ?)',
      [msg.id, msg.conversation_id, msg.author_id, msg.content, msg.created_at]
    );
    await t.run('UPDATE dm_conversations SET updated_at = ? WHERE id = ?', [msg.created_at, conversationId]);
  });
  return {
    id: msg.id,
    conversationId: msg.conversation_id,
    content: msg.content,
    createdAt: msg.created_at,
    authorId: userId,
    authorName: username,
  };
}

// Hard delete, author only — same model as channel messages.
async function remove(userId, conversationId, messageId) {
  const seen = await visibleConversation(conversationId, userId);
  if (!seen) throw { code: 'NOT_A_MEMBER', message: 'conversation not found' };
  const msg = await db.get(
    'SELECT * FROM dm_messages WHERE id = ? AND conversation_id = ?',
    [messageId, conversationId]
  );
  if (!msg) throw { code: 'NOT_FOUND', message: 'message not found' };
  if (msg.author_id !== userId) throw { code: 'PERMISSION_DENIED', message: 'cannot delete this message' };
  await db.run('DELETE FROM dm_messages WHERE id = ?', [msg.id]);
  return { id: msg.id, conversationId };
}

// Viewing the conversation drives read state — never the list load.
async function markRead(userId, conversationId) {
  const seen = await visibleConversation(conversationId, userId);
  if (!seen) throw { code: 'NOT_A_MEMBER', message: 'conversation not found' };
  const ts = now();
  await db.run(
    'UPDATE dm_members SET last_read_at = ? WHERE conversation_id = ? AND user_id = ?',
    [ts, conversationId, userId]
  );
  return { conversationId, lastReadAt: ts };
}

// Full conversation payload for opening a chat: peer, members' read
// positions (drives Seen receipts), and the latest page of history.
async function detail(userId, conversationId, opts) {
  const seen = await visibleConversation(conversationId, userId);
  if (!seen) throw { code: 'NOT_A_MEMBER', message: 'conversation not found' };
  const peerRow = await db.get(
    `SELECT u.* FROM users u
     JOIN dm_members om ON om.user_id = u.id
     WHERE om.conversation_id = ? AND om.user_id != ? LIMIT 1`,
    [conversationId, userId]
  );
  const members = await db.all(
    'SELECT user_id, last_read_at FROM dm_members WHERE conversation_id = ?',
    [conversationId]
  );
  const messages = await history(userId, conversationId, opts);
  return {
    id: seen.conv.id,
    createdAt: seen.conv.created_at,
    updatedAt: seen.conv.updated_at,
    peer: publicPeer(peerRow),
    members: members.map((m) => ({ userId: m.user_id, lastReadAt: m.last_read_at })),
    messages,
  };
}

module.exports = {
  pairKey,
  visibleConversation,
  memberIds,
  getOrCreate,
  listMine,
  history,
  send,
  remove,
  markRead,
  detail,
  MAX_CONTENT,
};
