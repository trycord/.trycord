// What a DM conversation is, and who is in it.
//
// A direct-message conversation is 1:1 and always has been, which is why it has a
// canonical participant-pair key: sorting the two user ids makes Alice↔Bob and Bob↔Alice
// the same string, so UNIQUE(pair_key) is the whole duplicate-conversation guard. It is a
// database constraint rather than a check-then-insert, which is the only version of this
// that survives two people opening a chat with each other at the same moment.

const db = require('../../db');
const { now, uuid } = require('../../util');

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

// The conversation row if userId belongs to it, else null. Takes an optional transaction
// so callers that are already inside one do not open a second connection.
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

// Get-or-create the conversation between me and peerId. Race-safe: the unique constraint
// decides the winner and the loser re-reads, so neither side is told a conversation does
// not exist because someone beat them to it.
async function getOrCreate(me, peerId) {
  if (!peerId) throw { code: 'VALIDATION_ERROR', message: 'userId required' };
  if (String(peerId) === String(me.id)) throw { code: 'VALIDATION_ERROR', message: 'you cannot DM yourself' };
  if (!(await peerExists(peerId))) throw { code: 'NOT_FOUND', message: 'user not found' };
  const pair = pairKey(me.id, peerId);

  const found = await db.get('SELECT * FROM dm_conversations WHERE pair_key = ?', [pair]);
  if (found) return { conversation: found, created: false };

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
      // The peer's read position starts empty: they have read nothing.
      await t.run(
        'INSERT INTO dm_members (conversation_id, user_id, joined_at, last_read_at) VALUES (?, ?, ?, ?)',
        [id, peerId, ts, null]
      );
    });
    return { conversation: await db.get('SELECT * FROM dm_conversations WHERE id = ?', [id]), created: true };
  } catch (e) {
    const msg = String((e && e.message) || '');
    if (/UNIQUE|unique|ER_DUP_ENTRY|SQLITE_CONSTRAINT_UNIQUE/i.test(msg) || e.code === 'ER_DUP_ENTRY') {
      const conv = await db.get('SELECT * FROM dm_conversations WHERE pair_key = ?', [pair]);
      if (conv) return { conversation: conv, created: false };
    }
    throw e;
  }
}

function shape(conv, peer, lastMessage, unreadCount, members) {
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

module.exports = { pairKey, publicPeer, visibleConversation, memberIds, getOrCreate, shape };
