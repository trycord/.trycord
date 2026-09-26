// /api/channels/:channelId/messages — history + post (members with SEND_MESSAGES),
// delete (author or MANAGE_MESSAGES).
const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');
const rateLimit = require('../middleware/ratelimit');
const { fail, serviceError } = require('../errors');
const { now, uuid, visibleChannel } = require('../util');
const { hasPermission } = require('../services/permissions');
const memberships = require('../services/memberships');
const uploads = require('../services/uploads');
const reactions = require('../services/reactions');
const mentions = require('../services/mentions');

let broadcast = () => {};
let sendToUser = () => {};
function setBroadcaster(fn) {
  broadcast = fn;
}
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
    let rows;
    if (req.query.before) {
      // Cursor page: messages strictly older than the anchor, newest first.
      const anchor = await db.get(
        'SELECT created_at FROM messages WHERE id = ? AND channel_id = ?',
        [req.query.before, ch.id]
      );
      if (!anchor) return fail(res, 'NOT_FOUND', 'message not found');
      rows = await db.all(
        `SELECT m.*, u.username AS author_name, u.display_name AS author_display
         FROM messages m JOIN users u ON u.id = m.author_id
         WHERE m.channel_id = ? AND (m.created_at < ? OR (m.created_at = ? AND m.id < ?))
         ORDER BY m.created_at DESC, m.id DESC LIMIT ${limit}`,
        [ch.id, anchor.created_at, anchor.created_at, req.query.before]
      );
    } else {
      rows = await db.all(
        `SELECT m.*, u.username AS author_name, u.display_name AS author_display
         FROM messages m JOIN users u ON u.id = m.author_id
         WHERE m.channel_id = ? ORDER BY m.created_at DESC, m.id DESC LIMIT ${limit}`,
        [req.params.channelId]
      );
    }
    const byId = await uploads.getForMessages(rows.map((r) => r.id));
    rows.reverse().forEach((r) => { r.attachments = byId[r.id] || []; });
    await attachEngagement(rows, req.user.id);
    res.json(rows);
  } catch (e) { next(e); }
});

router.post('/', auth.requireVerified, rateLimit({ windowMs: 60000, max: 60 }), async (req, res, next) => {
  try {
    const ch = await visibleChannel(req.params.channelId, req.user.id);
    if (!ch) return fail(res, 'NOT_A_MEMBER', 'channel not found or not a member');
    if (!(await hasPermission(req.user.id, ch.server_id, 'SEND_MESSAGES'))) {
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
    const msg = {
      id: uuid(), channel_id: ch.id, server_id: ch.server_id,
      author_id: req.user.id, user: req.user.username, content, created_at: now(),
      edited_at: null,
    };
    await db.run(
      'INSERT INTO messages (id, channel_id, author_id, content, created_at) VALUES (?, ?, ?, ?, ?)',
      [msg.id, msg.channel_id, msg.author_id, msg.content, msg.created_at]
    );
    msg.attachments = ids.length
      ? await uploads.attachToMessage(ids, msg.id, req.user.id, ch.id)
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
    if (!isAuthor && !(await hasPermission(req.user.id, ch.server_id, 'MANAGE_MESSAGES'))) {
      return fail(res, 'PERMISSION_DENIED', 'cannot delete this message');
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
    if (!(await hasPermission(req.user.id, ch.server_id, 'SEND_MESSAGES'))) {
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
module.exports.setBroadcaster = setBroadcaster;
module.exports.setGateway = setGateway;
