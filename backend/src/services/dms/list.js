// The conversation list, and opening one conversation.
//
// listMine is the one query in the codebase that had to be rewritten rather than moved.
// It used to cost three round trips per conversation; it now costs three in total,
// whatever the count:
//
//   one membership query with index-backed scalar subqueries for peer id, latest message
//   id and unread count, then
//   two batched lookups - users and messages - issued together.
//
// The reason it is in its own file is that this shape is the answer to "how do I list N
// things that each need three related values". It is worth being able to point at.

const db = require('../../db');
const { publicPeer, visibleConversation, shape } = require('./conversation');
const { history } = require('./history');

// Everyone the user chats with, most-recently-active first.
async function listMine(userId) {
  const memberships = await db.all(
    `SELECT m.*, c.updated_at, c.created_at AS conv_created,
       (SELECT om.user_id FROM dm_members om
         WHERE om.conversation_id = m.conversation_id AND om.user_id != ? LIMIT 1) AS peer_id,
       (SELECT dm.id FROM dm_messages dm
         WHERE dm.conversation_id = m.conversation_id
         ORDER BY dm.created_at DESC, dm.id DESC LIMIT 1) AS last_id,
       (SELECT COUNT(*) FROM dm_messages um
         WHERE um.conversation_id = m.conversation_id AND um.author_id != ?
           AND (m.last_read_at IS NULL OR um.created_at > m.last_read_at)) AS unread_n
     FROM dm_members m JOIN dm_conversations c ON c.id = m.conversation_id
     WHERE m.user_id = ?`,
    [userId, userId, userId]
  );
  if (!memberships.length) return [];

  const peerIds = [...new Set(memberships.map((m) => m.peer_id).filter(Boolean))].slice(0, 500);
  const lastIds = [...new Set(memberships.map((m) => m.last_id).filter(Boolean))].slice(0, 500);
  const [peerRows, lastRows] = await Promise.all([
    peerIds.length
      ? db.all(
        `SELECT id, username, display_name, created_at FROM users WHERE id IN (${peerIds.map(() => '?').join(',')})`,
        peerIds
      )
      : [],
    lastIds.length
      ? db.all(
        `SELECT dm.*, u.username AS author_name, u.display_name AS author_display,
                u.avatar_url AS author_avatar, u.banner_url AS author_banner
         FROM dm_messages dm JOIN users u ON u.id = dm.author_id
         WHERE dm.id IN (${lastIds.map(() => '?').join(',')})`,
        lastIds
      )
      : [],
  ]);

  const peers = {};
  for (const p of peerRows) peers[String(p.id)] = p;
  const lasts = {};
  for (const l of lastRows) lasts[String(l.id)] = l;

  const out = memberships.map((m) => {
    const last = (m.last_id && lasts[String(m.last_id)]) || null;
    return shape(
      {
        id: m.conversation_id,
        created_at: m.conv_created,
        // A conversation sorts by its latest message, not by when the row was touched -
        // otherwise the first message in a dormant chat floats it to the top.
        updated_at: last ? last.created_at : m.updated_at,
      },
      publicPeer((m.peer_id && peers[String(m.peer_id)]) || null),
      last ? {
        id: last.id,
        content: last.content,
        createdAt: last.created_at,
        editedAt: last.edited_at || null,
        authorId: last.author_id,
        authorName: last.author_display || last.author_name,
      } : null,
      m.unread_n || 0
    );
  });
  out.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return out;
}

// Everything needed to open a chat: peer, members' read positions (which drive Seen
// receipts) and the latest page of history.
async function detail(userId, conversationId, opts) {
  const seen = await visibleConversation(conversationId, userId);
  if (!seen) throw { code: 'NOT_A_MEMBER', message: 'conversation not found' };
  // Peer, read positions and history are independent once membership is validated, so
  // they run concurrently rather than in sequence.
  const [peerRow, members, messages] = await Promise.all([
    db.get(
      `SELECT u.* FROM users u
       JOIN dm_members om ON om.user_id = u.id
       WHERE om.conversation_id = ? AND om.user_id != ? LIMIT 1`,
      [conversationId, userId]
    ),
    db.all(
      'SELECT user_id, last_read_at FROM dm_members WHERE conversation_id = ?',
      [conversationId]
    ),
    history(userId, conversationId, opts),
  ]);
  return {
    id: seen.conv.id,
    createdAt: seen.conv.created_at,
    updatedAt: seen.conv.updated_at,
    peer: publicPeer(peerRow),
    members: members.map((m) => ({ userId: m.user_id, lastReadAt: m.last_read_at })),
    messages,
  };
}

module.exports = { listMine, detail };
