// /api/channels/:channelId/messages — history + post (members with SEND_MESSAGES),
// delete (author or MANAGE_MESSAGES).
const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');
const { fail, serviceError } = require('../errors');
const { now, uuid, visibleChannel } = require('../util');
const { hasPermission } = require('../services/permissions');

let broadcast = () => {};
function setBroadcaster(fn) {
  broadcast = fn;
}

const router = express.Router({ mergeParams: true });
router.use(auth);

router.get('/', (req, res) => {
  const ch = visibleChannel(req.params.channelId, req.user.id);
  if (!ch) return fail(res, 'NOT_A_MEMBER', 'channel not found or not a member');
  const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 200);
  const rows = db.prepare(`
    SELECT m.*, u.username AS author_name, u.display_name AS author_display
    FROM messages m JOIN users u ON u.id = m.author_id
    WHERE m.channel_id = ? ORDER BY m.created_at DESC LIMIT ?
  `).all(ch.id, limit);
  res.json(rows.reverse());
});

router.post('/', (req, res) => {
  const ch = visibleChannel(req.params.channelId, req.user.id);
  if (!ch) return fail(res, 'NOT_A_MEMBER', 'channel not found or not a member');
  if (!hasPermission(req.user.id, ch.server_id, 'SEND_MESSAGES')) {
    return fail(res, 'PERMISSION_DENIED', 'you cannot post in this server');
  }
  const content = String((req.body || {}).content || '').trim().slice(0, 2000);
  if (!content) return fail(res, 'VALIDATION_ERROR', 'content required');
  const msg = {
    id: uuid(), channel_id: ch.id, server_id: ch.server_id,
    author_id: req.user.id, user: req.user.username, content, created_at: now(),
  };
  try {
    db.prepare('INSERT INTO messages (id, channel_id, author_id, content, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(msg.id, msg.channel_id, msg.author_id, msg.content, msg.created_at);
  } catch (e) { return serviceError(res, e); }
  broadcast(ch.server_id, ch.id, { type: 'message', ...msg });
  res.json(msg);
});

router.delete('/:messageId', (req, res) => {
  const ch = visibleChannel(req.params.channelId, req.user.id);
  if (!ch) return fail(res, 'NOT_A_MEMBER', 'channel not found or not a member');
  const msg = db.prepare('SELECT * FROM messages WHERE id = ? AND channel_id = ?')
    .get(req.params.messageId, ch.id);
  if (!msg) return fail(res, 'NOT_FOUND', 'message not found');
  const isAuthor = msg.author_id === req.user.id;
  if (!isAuthor && !hasPermission(req.user.id, ch.server_id, 'MANAGE_MESSAGES')) {
    return fail(res, 'PERMISSION_DENIED', 'cannot delete this message');
  }
  db.prepare('DELETE FROM messages WHERE id = ?').run(msg.id);
  broadcast(ch.server_id, ch.id, { type: 'message_deleted', id: msg.id, channel_id: ch.id });
  res.json({ ok: true });
});

module.exports = router;
module.exports.setBroadcaster = setBroadcaster;
