// /api/channels/:channelId/messages — history + post (members with SEND_MESSAGES),
// delete (author or MANAGE_MESSAGES).
const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');
const rateLimit = require('../middleware/ratelimit');
const { fail, serviceError } = require('../errors');
const { now, uuid, visibleChannel } = require('../util');
const { hasChannelPermission } = require('../services/permissions');
const memberships = require('../services/memberships');
const uploads = require('../services/uploads');
const reactions = require('../services/reactions');
const threads = require('../services/threads');
const mentions = require('../services/mentions');

let broadcast = () => {};
let sendToUser = () => {};
// Full gateway wiring (broadcast + per-user push for mention delivery).
function setGateway(gw) {
  if (gw && typeof gw.broadcast === 'function') broadcast = gw.broadcast;
  if (gw && typeof gw.sendToUser === 'function') sendToUser = gw.sendToUser;
}

const router = express.Router({ mergeParams: true });
router.use(auth);

// Engagement enrichment: per-message reaction summaries (with the
// reader's own state) and pin flags, batched to two queries per read.
async function attachEngagement(rows, meId) {
  if (!rows.length) return;
  const ids = rows.map((r) => r.id);
  const [summaries, pins] = await Promise.all([
    reactions.summary(ids, meId),
    db.all(
      `SELECT message_id FROM pinned_messages WHERE message_id IN (${ids.map(() => '?').join(',')})`,
      ids
    ),
  ]);
  const pinnedSet = new Set(pins.map((p) => String(p.message_id)));
  for (const r of rows) {
    r.reactions = (summaries[r.id] || []);
    r.pinned = pinnedSet.has(String(r.id));
  }
}

router.get('/', async (req, res, next) => {
  try {
    const ch = await visibleChannel(req.params.channelId, req.user.id);
    if (!ch) return fail(res, 'NOT_A_MEMBER', 'channel not found or not a member');
    // Integer embedded after validation (keeps LIMIT working on every database).
    const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10) || 50, 1), 200);
    const select = `SELECT m.*, u.username AS author_name, u.display_name AS author_display, u.avatar_url AS author_avatar, u.banner_url AS author_banner
         FROM messages m JOIN users u ON u.id = m.author_id`;
    let rows;
    if (req.query.after !== undefined && req.query.after !== '') {
      // Forward cursor: everything strictly newer than the anchor, oldest
      // first. This is what a reconnecting client uses to fill the hole
      // between its last known message and now. Previously there was no
      // forward cursor at all, so anything missed while offline was simply
      // unrecoverable in the UI.
      const after = Math.max(parseInt(req.query.after, 10) || 0, 0);
      rows = await db.all(
        `${select} WHERE m.channel_id = ? AND m.seq > ? ORDER BY m.seq ASC LIMIT ${limit}`,
        [ch.id, after]
      );
    } else if (req.query.before) {
      // Backward cursor: older than the anchor, newest first.
      //
      // The anchor may be a seq (preferred: a single indexed integer) or a
      // message id (the original contract). Supporting both matters because
      // changing this parameter's meaning would silently break any existing
      // client: an id parsed as an integer is NaN, which would quietly turn
      // "page backwards" into "return nothing".
      const raw = String(req.query.before);
      const anchorSeq = /^\d+$/.test(raw)
        ? Number(raw)
        : await resolveSeq('messages', 'channel_id', ch.id, raw);
      if (anchorSeq === null) return fail(res, 'NOT_FOUND', 'message not found');
      rows = await db.all(
        `${select} WHERE m.channel_id = ? AND m.seq < ? ORDER BY m.seq DESC LIMIT ${limit}`,
        [ch.id, anchorSeq]
      );
    } else {
      rows = await db.all(
        `${select} WHERE m.channel_id = ? ORDER BY m.seq DESC LIMIT ${limit}`,
        [req.params.channelId]
      );
    }
    const byId = await uploads.getForMessages(rows.map((r) => r.id));
    // Normalise to oldest-first for the client. The default and forward
    // reads are already ascending, so reverse() is only meaningful for the
    // backward page.
    if (req.query.after === undefined || req.query.after === '') rows.reverse();
    rows.forEach((r) => { r.attachments = byId[r.id] || []; });
    // One grouped query for the whole page, so a history read costs the same
    // whether or not anything has been replied to.
    const counts = await threads.replyCounts('channel', ch.id, rows.map((r) => r.id));
    rows.forEach((r) => { r.reply_count = counts[r.id] || 0; });
    await attachEngagement(rows, req.user.id);
    res.json(rows);
  } catch (e) { next(e); }
});

// A thread: the message it hangs from, then its replies. The channel is
// permission-checked exactly as the history read is, so a thread cannot be used
// to read a channel the reader cannot otherwise see.
router.get('/:messageId/thread', async (req, res, next) => {
  try {
    const ch = await visibleChannel(req.params.channelId, req.user.id);
    if (!ch) return fail(res, 'NOT_A_MEMBER', 'channel not found or not a member');
    const rootId = await threads.resolveRoot('channel', ch.id, req.params.messageId);
    res.json(await threads.fetch('channel', ch.id, rootId));
  } catch (e) {
    if (e && e.code === 'NOT_FOUND') return fail(res, 'NOT_FOUND', 'message not found');
    next(e);
  }
});

// Assign the next seq for a channel. The unique index on (channel_id, seq)
// is the authority: if two writers race and pick the same value, one insert
// fails with a constraint violation and retries against the new maximum.
// Without the index this read-then-write would silently produce two rows
// with the same order.
async function nextSeq(channelId) {
  const row = await db.get('SELECT COALESCE(MAX(seq), 0) AS m FROM messages WHERE channel_id = ?', [channelId]);
  return (row ? Number(row.m) : 0) + 1;
}

// Resolve a legacy cursor (message id) to its seq, scoped so an id from
// another channel cannot be used as an anchor here.
async function resolveSeq(table, scope, scopeId, id) {
  const row = await db.get(
    `SELECT seq FROM ${table} WHERE id = ? AND ${scope} = ?`,
    [id, scopeId]
  );
  if (!row || row.seq === null || row.seq === undefined) return null;
  return Number(row.seq);
}

router.post('/', auth.requireVerified, rateLimit({ windowMs: 60000, max: 60 }), async (req, res, next) => {
  try {
    const ch = await visibleChannel(req.params.channelId, req.user.id);
    if (!ch) return fail(res, 'NOT_A_MEMBER', 'channel not found or not a member');
    if (!(await hasChannelPermission(req.user.id, ch.server_id, ch.id, 'SEND_MESSAGES'))) {
      return fail(res, 'PERMISSION_DENIED', 'you cannot post in this server');
    }
    if (await memberships.isTimedOut(ch.server_id, req.user.id)) {
      return fail(res, 'TIMED_OUT', 'you are timed out in this server');
    }
    const content = String((req.body || {}).content || '').trim().slice(0, 2000);
    // Attachments and text are independent: a message may carry files
    // alone, text alone, or both — but must carry at least one.
    const ids = uploads.sanitizeIds((req.body || {}).attachmentIds);
    if (!content && !ids.length) return fail(res, 'VALIDATION_ERROR', 'content or an attachment is required');

    // A reply to something that is not in this channel is refused rather than
    // quietly posted flat, which would look like the app had lost the message.
    let threadRootId = null;
    try {
      threadRootId = await threads.resolveRoot('channel', ch.id, (req.body || {}).replyToId);
    } catch (e) {
      return fail(res, e.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'VALIDATION_ERROR',
        e.code === 'NOT_FOUND' ? 'the message being replied to does not exist here' : 'cannot reply to that message');
    }

    // Idempotency. A caller that retries the same submission (because the
    // response was lost, not because the write failed) sends the same
    // clientNonce and gets the already-persisted message back instead of a
    // second copy. The nonce is scoped to the channel and is never compared
    // against message text or timestamps, so two genuinely different
    // messages that happen to be identical are still two messages.
    const nonce = String((req.body || {}).clientNonce || '').trim().slice(0, 64) || null;
    if (nonce) {
      const existing = await db.get(
        `SELECT m.*, u.username AS author_name, u.display_name AS author_display, u.avatar_url AS author_avatar, u.banner_url AS author_banner
         FROM messages m JOIN users u ON u.id = m.author_id
         WHERE m.channel_id = ? AND m.client_nonce = ?`,
        [ch.id, nonce]
      );
      if (existing) {
        const byId = await uploads.getForMessages([existing.id]);
        existing.attachments = byId[existing.id] || [];
        await attachEngagement([existing], req.user.id);
        // 200, not 201: nothing new was created.
        return res.json({ ...existing, server_id: ch.server_id, deduped: true });
      }
    }

    const msg = {
      id: uuid(), channel_id: ch.id, server_id: ch.server_id,
      author_id: req.user.id, user: req.user.username, content, created_at: now(),
      edited_at: null, thread_root_id: threadRootId,
    };

    // Insert with the canonical sequence, retrying on the (rare) race.
    let inserted = false;
    for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
      const seq = await nextSeq(ch.id);
      try {
        await db.run(
          'INSERT INTO messages (id, channel_id, author_id, content, created_at, seq, client_nonce, thread_root_id)' +
          ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [msg.id, msg.channel_id, msg.author_id, msg.content, msg.created_at, seq, nonce, threadRootId]
        );
        msg.seq = seq;
        inserted = true;
      } catch (e) {
        // A unique violation on (channel_id, seq) means another writer took
        // this value between our read and our write. Re-read and retry.
        const dupSeq = /unique/i.test(String(e && e.message)) || e && e.code === 'SQLITE_CONSTRAINT';
        if (!dupSeq || attempt === 4) throw e;
        // A unique violation on the nonce means a concurrent duplicate won.
        if (nonce) {
          const again = await db.get('SELECT id FROM messages WHERE channel_id = ? AND client_nonce = ?', [ch.id, nonce]);
          if (again) { msg.id = again.id; inserted = true; break; }
        }
      }
    }
    if (!inserted) return fail(res, 'CONFLICT', 'could not assign a message position, please retry');
    msg.attachments = ids.length
      ? await uploads.attachToMessage(ids, msg.id, req.user.id, { channelId: ch.id })
      : [];
    await attachEngagement([msg], req.user.id);
    broadcast(ch.server_id, ch.id, { type: 'message', ...msg });
    // @username mentions become durable notifications (+ realtime push),
    // skipped for muted channels inside the helper. Never fails the post.
    try {
      const found = await mentions.notifyMentions({
        serverId: ch.server_id, channelId: ch.id, messageId: msg.id,
        authorId: req.user.id, content,
      });
      for (const f of found) {
        try { sendToUser(f.userId, { type: 'notification', notification: f.notification }); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    res.json(msg);
  } catch (e) { next(e); }
});

router.delete('/:messageId', auth.requireVerified, async (req, res, next) => {
  try {
    const ch = await visibleChannel(req.params.channelId, req.user.id);
    if (!ch) return fail(res, 'NOT_A_MEMBER', 'channel not found or not a member');
    const msg = await db.get('SELECT * FROM messages WHERE id = ? AND channel_id = ?', [req.params.messageId, ch.id]);
    if (!msg) return fail(res, 'NOT_FOUND', 'message not found');
    const isAuthor = msg.author_id === req.user.id;
    if (!isAuthor && !(await hasChannelPermission(req.user.id, ch.server_id, ch.id, 'MANAGE_MESSAGES'))) {
      return fail(res, 'PERMISSION_DENIED', 'cannot delete this message');
    }
    // A timeout means the member cannot act in this community, not merely that
    // they cannot post. A moderator with MANAGE_MESSAGES is exempt, so a
    // moderation action is still possible while someone is timed out.
    if (isAuthor && (await memberships.isTimedOut(ch.server_id, req.user.id))) {
      return fail(res, 'TIMED_OUT', 'you are timed out in this server');
    }
    const fileRows = await db.all('SELECT id FROM attachments WHERE message_id = ?', [msg.id]);
    await db.run('DELETE FROM messages WHERE id = ?', [msg.id]);
    uploads.removeFiles(fileRows.map((r) => r.id));
    broadcast(ch.server_id, ch.id, { type: 'message_deleted', id: msg.id, channel_id: ch.id });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// PATCH /:messageId — author-only edit. Moderators can delete but never
// rewrite someone else's words. Broadcasts message_updated.
router.patch('/:messageId', auth.requireVerified, rateLimit({ windowMs: 60000, max: 40 }), async (req, res, next) => {
  try {
    const ch = await visibleChannel(req.params.channelId, req.user.id);
    if (!ch) return fail(res, 'NOT_A_MEMBER', 'channel not found or not a member');
    const msg = await db.get('SELECT * FROM messages WHERE id = ? AND channel_id = ?', [req.params.messageId, ch.id]);
    if (!msg) return fail(res, 'NOT_FOUND', 'message not found');
    if (msg.author_id !== req.user.id) return fail(res, 'PERMISSION_DENIED', 'only the author can edit');
    // Editing is a write, so it is gated the same way posting is.
    if (!(await hasChannelPermission(req.user.id, ch.server_id, ch.id, 'SEND_MESSAGES'))) {
      return fail(res, 'PERMISSION_DENIED', 'you cannot edit here');
    }
    if (await memberships.isTimedOut(ch.server_id, req.user.id)) {
      return fail(res, 'TIMED_OUT', 'you are timed out in this server');
    }
    const content = String(((req.body || {}).content === null || (req.body || {}).content === undefined) ? '' : req.body.content).trim().slice(0, 2000);
    if (!content) return fail(res, 'VALIDATION_ERROR', 'content required');
    const editedAt = now();
    await db.run('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?', [content, editedAt, msg.id]);
    const author = await db.get('SELECT username, display_name FROM users WHERE id = ?', [msg.author_id]);
    const out = {
      id: msg.id, channel_id: ch.id, server_id: ch.server_id,
      author_id: msg.author_id, user: req.user.username, content,
      created_at: msg.created_at, edited_at: editedAt,
      author_name: (author && author.username) || req.user.username,
      author_display: (author && author.display_name) || req.user.username,
    };
    await attachEngagement([out], req.user.id);
    broadcast(ch.server_id, ch.id, { type: 'message_updated', ...out });
    res.json(out);
  } catch (e) { next(e); }
});

// ---- reactions ------------------------------------------------------
// POST /api/channels/:channelId/messages/:messageId/reactions { emoji }
router.post('/:messageId/reactions', auth.requireVerified, rateLimit({ windowMs: 60000, max: 120 }), async (req, res, next) => {
  try {
    const ch = await visibleChannel(req.params.channelId, req.user.id);
    if (!ch) return fail(res, 'NOT_A_MEMBER', 'channel not found or not a member');
    if (!(await hasChannelPermission(req.user.id, ch.server_id, ch.id, 'SEND_MESSAGES'))) {
      return fail(res, 'PERMISSION_DENIED', 'you cannot react here');
    }
    if (await memberships.isTimedOut(ch.server_id, req.user.id)) {
      return fail(res, 'TIMED_OUT', 'you are timed out in this server');
    }
    const msg = await db.get('SELECT id FROM messages WHERE id = ? AND channel_id = ?', [req.params.messageId, ch.id]);
    if (!msg) return fail(res, 'NOT_FOUND', 'message not found in this channel');
    let emoji;
    try {
      emoji = await reactions.add(req.user.id, msg.id, (req.body || {}).emoji);
    } catch (e) {
      if (e && e.code) return fail(res, e.code, e.message);
      throw e;
    }
    const summaries = await reactions.summary([msg.id], req.user.id);
    broadcast(ch.server_id, ch.id, { type: 'message_reaction', id: msg.id, channel_id: ch.id, reactions: summaries[msg.id] || [] });
    res.json({ ok: true, emoji, reactions: summaries[msg.id] || [] });
  } catch (e) { next(e); }
});

// DELETE .../reactions/:emoji — removes only the caller's own reaction.
router.delete('/:messageId/reactions/:emoji', auth.requireVerified, async (req, res, next) => {
  try {
    const ch = await visibleChannel(req.params.channelId, req.user.id);
    if (!ch) return fail(res, 'NOT_A_MEMBER', 'channel not found or not a member');
    const msg = await db.get('SELECT id FROM messages WHERE id = ? AND channel_id = ?', [req.params.messageId, ch.id]);
    if (!msg) return fail(res, 'NOT_FOUND', 'message not found in this channel');
    // Removing your own reaction is a write, so it carries the same gate as
    // adding one. Without this a member denied SEND_MESSAGES, or timed out,
    // could still act on a channel they are supposed to be locked out of.
    if (!(await hasChannelPermission(req.user.id, ch.server_id, ch.id, 'SEND_MESSAGES'))) {
      return fail(res, 'PERMISSION_DENIED', 'you cannot react here');
    }
    if (await memberships.isTimedOut(ch.server_id, req.user.id)) {
      return fail(res, 'TIMED_OUT', 'you are timed out in this server');
    }
    let emoji;
    try {
      emoji = await reactions.remove(req.user.id, msg.id, req.params.emoji);
    } catch (e) {
      if (e && e.code) return fail(res, e.code, e.message);
      throw e;
    }
    const summaries = await reactions.summary([msg.id], req.user.id);
    broadcast(ch.server_id, ch.id, { type: 'message_reaction', id: msg.id, channel_id: ch.id, reactions: summaries[msg.id] || [] });
    res.json({ ok: true, emoji, reactions: summaries[msg.id] || [] });
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.setGateway = setGateway;
module.exports.nextSeq = nextSeq;
