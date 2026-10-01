// Direct-message conversations: transactional get-or-create with a canonical
// participant-pair key (so Alice↔Bob is always exactly one conversation),
// cursor-paginated history, persistent read positions, author-only delete.
// All multi-row flows run inside db.transaction (works on SQLite + MySQL).
const db = require('../db');
const { now, uuid } = require('../util');
const uploads = require('./uploads');
const threads = require('./threads');

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
//
// One membership query with scalar subqueries for the peer id, latest
// message id, and unread count (all index-backed), then two batched
// lookups (users, messages) in parallel — 3 round trips no matter how
// many conversations, instead of 3 per conversation. Same shape as before.
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
      ? db.all(`SELECT id, username, display_name, created_at FROM users WHERE id IN (${peerIds.map(() => '?').join(',')})`, peerIds)
      : [],
    lastIds.length
      ? db.all(
        `SELECT dm.*, u.username AS author_name, u.display_name AS author_display, u.avatar_url AS author_avatar, u.banner_url AS author_banner
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
    const peerRow = (m.peer_id && peers[String(m.peer_id)]) || null;
    const last = (m.last_id && lasts[String(m.last_id)]) || null;
    return conversationShape(
      { id: m.conversation_id, created_at: m.conv_created, updated_at: last ? last.created_at : m.updated_at },
      publicPeer(peerRow),
      last ? {
        id: last.id, content: last.content, createdAt: last.created_at,
        editedAt: last.edited_at || null,
        authorId: last.author_id, authorName: last.author_display || last.author_name,
      } : null,
      m.unread_n || 0
    );
  });
  out.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return out;
}

// Latest N messages, then older pages via before=<messageId>.
// Deterministic order: (created_at, id), ascending for the client.
// Next canonical position within a conversation. The unique index on
// (conversation_id, seq) is the authority: if two writers race onto the same
// value, one insert loses with a constraint violation and retries against the
// new maximum, so an ambiguous order can never be written.
async function nextSeq(conversationId) {
  const row = await db.get('SELECT COALESCE(MAX(seq), 0) AS m FROM dm_messages WHERE conversation_id = ?', [conversationId]);
  return (row ? Number(row.m) : 0) + 1;
}

// Resolve a legacy cursor (message id) to its seq, scoped so an id from
// another conversation cannot be used as an anchor here.
async function resolveSeq(conversationId, id) {
  const row = await db.get(
    'SELECT seq FROM dm_messages WHERE id = ? AND conversation_id = ?',
    [id, conversationId]
  );
  if (!row || row.seq === null || row.seq === undefined) return null;
  return Number(row.seq);
}

// GET history. Mirrors the channel contract exactly: seq is the authoritative
// order, `after` walks forward for reconnect catch-up, `before` walks back and
// accepts either a seq or a legacy message id.
//
// The `before` anchor is resolved through resolveSeq rather than compared on
// the (created_at, id) tuple, because the tuple is exactly the thing seq
// replaced: two rows can share a created_at, and the old comparison made the
// boundary depend on which one the storage engine returned first.
async function history(userId, conversationId, { before = null, after = null, limit = 50 } = {}) {
  const seen = await visibleConversation(conversationId, userId);
  if (!seen) throw { code: 'NOT_A_MEMBER', message: 'conversation not found' };
  const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  const select = `SELECT dm.*, u.username AS author_name, u.display_name AS author_display, u.avatar_url AS author_avatar, u.banner_url AS author_banner
       FROM dm_messages dm JOIN users u ON u.id = dm.author_id`;
  let rows;
  let forward = false;
  if (after !== null && after !== undefined && after !== '') {
    const from = Math.max(parseInt(after, 10) || 0, 0);
    forward = true;
    rows = await db.all(
      `${select} WHERE dm.conversation_id = ? AND dm.seq > ? ORDER BY dm.seq ASC LIMIT ${lim}`,
      [conversationId, from]
    );
  } else if (before) {
    const raw = String(before);
    const anchorSeq = /^\d+$/.test(raw) ? Number(raw) : await resolveSeq(conversationId, raw);
    if (anchorSeq === null) throw { code: 'NOT_FOUND', message: 'message not found' };
    rows = await db.all(
      `${select} WHERE dm.conversation_id = ? AND dm.seq < ? ORDER BY dm.seq DESC LIMIT ${lim}`,
      [conversationId, anchorSeq]
    );
  } else {
    rows = await db.all(
      `${select} WHERE dm.conversation_id = ? ORDER BY dm.seq DESC LIMIT ${lim}`,
      [conversationId]
    );
  }
  // Normalise to oldest-first for the client. Only the backward page arrives
  // newest-first.
  if (!forward) rows.reverse();
  // One query for the whole page, the same way the channel history does it.
  const files = await uploads.getForDmMessages(rows.map((m) => m.id));
  const counts = await threads.replyCounts('dm', conversationId, rows.map((m) => m.id));
  return rows.map((m) => ({
    id: m.id,
    seq: m.seq === null || m.seq === undefined ? null : Number(m.seq),
    conversationId: m.conversation_id,
    content: m.content,
    createdAt: m.created_at,
    editedAt: m.edited_at || null,
    authorId: m.author_id,
    authorName: m.author_display || m.author_name,
    threadRootId: m.thread_root_id || null,
    replyCount: counts[m.id] || 0,
    attachments: files[m.id] || [],
  }));
}

async function send(userId, username, conversationId, content, clientNonce = null, attachmentIds = [], replyToId = null) {
  const seen = await visibleConversation(conversationId, userId);
  if (!seen) throw { code: 'NOT_A_MEMBER', message: 'conversation not found' };
  const text = String((content === null || content === undefined) ? '' : content).trim();
  // A file on its own is a message. The channels path has always allowed this;
  // requiring text here meant a picture could not be sent in a DM at all.
  const ids = uploads.sanitizeIds(attachmentIds);
  if (!text && !ids.length) throw { code: 'VALIDATION_ERROR', message: 'message is empty' };
  // A reply to something that is not in this conversation is refused rather
  // than quietly posted flat.
  const threadRootId = await threads.resolveRoot('dm', conversationId, replyToId);
  if (text.length > MAX_CONTENT) {
    throw { code: 'VALIDATION_ERROR', message: `message too long (max ${MAX_CONTENT} characters)` };
  }
  const nonce = String(clientNonce || '').trim().slice(0, 64) || null;
  const body = text.slice(0, MAX_CONTENT);

  // Idempotency, same contract as channels: a retried submission carries the
  // same nonce and gets the row the first attempt already wrote. Scoped to the
  // conversation and never compared against content, so two genuinely
  // identical messages are still two messages.
  if (nonce) {
    const existing = await db.get(
      `SELECT dm.*, u.username AS author_name, u.display_name AS author_display
       FROM dm_messages dm JOIN users u ON u.id = dm.author_id
       WHERE dm.conversation_id = ? AND dm.client_nonce = ?`,
      [conversationId, nonce]
    );
    if (existing) {
      return {
        id: existing.id,
        seq: existing.seq === null || existing.seq === undefined ? null : Number(existing.seq),
        conversationId: existing.conversation_id,
        content: existing.content,
        createdAt: existing.created_at,
        editedAt: null,
        authorId: existing.author_id,
        authorName: username,
        threadRootId: existing.thread_root_id || null,
        attachments: await uploads.getForDmMessage(existing.id),
        deduped: true,
      };
    }
  }

  const msg = {
    id: uuid(), conversation_id: conversationId, author_id: userId,
    content: body, created_at: now(), thread_root_id: threadRootId,
  };

  // Insert with the canonical position, retrying on the (rare) race where a
  // concurrent writer claimed the same seq first.
  let inserted = false;
  for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
    const seq = await nextSeq(conversationId);
    try {
      await db.transaction(async (t) => {
        await t.run(
          'INSERT INTO dm_messages (id, conversation_id, author_id, content, created_at, seq, client_nonce, thread_root_id)' +
          ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [msg.id, msg.conversation_id, msg.author_id, msg.content, msg.created_at, seq, nonce, threadRootId]
        );
        await t.run('UPDATE dm_conversations SET updated_at = ? WHERE id = ?', [msg.created_at, conversationId]);
      });
      msg.seq = seq;
      inserted = true;
    } catch (e) {
      const dup = /unique/i.test(String(e && e.message)) || (e && e.code === 'SQLITE_CONSTRAINT');
      if (!dup || attempt === 4) throw e;
      // A unique violation on the nonce means a concurrent duplicate won.
      if (nonce) {
        const again = await db.get(
          'SELECT id, seq FROM dm_messages WHERE conversation_id = ? AND client_nonce = ?',
          [conversationId, nonce]
        );
        if (again) { msg.id = again.id; msg.seq = again.seq; inserted = true; }
      }
    }
  }
  if (!inserted) throw { code: 'CONFLICT', message: 'could not assign a message position, please retry' };

  // Adopted after the insert, exactly as the channel path does: an id that is
  // not this uploader's own pending upload in this conversation simply does not
  // match, so it is ignored rather than attached.
  const attachments = await uploads.attachToMessage(ids, msg.id, userId, { conversationId });

  return {
    id: msg.id,
    seq: msg.seq,
    conversationId: msg.conversation_id,
    content: msg.content,
    createdAt: msg.created_at,
    editedAt: null,
    authorId: userId,
    authorName: username,
    threadRootId,
    attachments,
  };
}

// Author-only edit. No revision history table: edited_at marks the latest
// revision, matching the channel-message model.
async function edit(userId, conversationId, messageId, content, username) {
  const seen = await visibleConversation(conversationId, userId);
  if (!seen) throw { code: 'NOT_A_MEMBER', message: 'conversation not found' };
  const msg = await db.get(
    'SELECT * FROM dm_messages WHERE id = ? AND conversation_id = ?',
    [messageId, conversationId]
  );
  if (!msg) throw { code: 'NOT_FOUND', message: 'message not found' };
  if (msg.author_id !== userId) throw { code: 'PERMISSION_DENIED', message: 'only the author can edit' };
  const text = String(content === null || content === undefined ? '' : content).trim();
  if (!text) throw { code: 'VALIDATION_ERROR', message: 'message is empty' };
  if (text.length > MAX_CONTENT) {
    throw { code: 'VALIDATION_ERROR', message: `message too long (max ${MAX_CONTENT} characters)` };
  }
  const editedAt = now();
  await db.run('UPDATE dm_messages SET content = ?, edited_at = ? WHERE id = ?', [text.slice(0, MAX_CONTENT), editedAt, msg.id]);
  return {
    id: msg.id,
    conversationId,
    content: text.slice(0, MAX_CONTENT),
    createdAt: msg.created_at,
    editedAt,
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
  // The rows go with the message by cascade; the objects on disk do not, so they
  // are named before the delete. Same order the channel path uses.
  const files = await uploads.getForDmMessage(msg.id);
  // As in a channel: the replies stay, and become ordinary messages again.
  await db.run('UPDATE dm_messages SET thread_root_id = NULL WHERE thread_root_id = ?', [msg.id]);
  await db.run('DELETE FROM dm_messages WHERE id = ?', [msg.id]);
  await uploads.removeFiles(files.map((f) => ({
    id: f.id,
    channel_id: null,
    dm_conversation_id: conversationId,
  })));
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
  // Peer, read positions, and history are independent once membership
  // is validated — run them concurrently instead of sequentially.
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

module.exports = {
  pairKey,
  visibleConversation,
  memberIds,
  getOrCreate,
  listMine,
  history,
  send,
  edit,
  remove,
  markRead,
  detail,
  MAX_CONTENT,
};
