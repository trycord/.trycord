// /api/channels/:channelId/messages — history + post (server members only).
const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');
const { now, uuid, visibleChannel } = require('../util');

let broadcast = () => {};
function setBroadcaster(fn) {
  broadcast = fn;
}

const router = express.Router({ mergeParams: true });
router.use(auth);

router.get('/', (req, res) => {
  const ch = visibleChannel(req.params.channelId, req.user.id);
  if (!ch) return res.status(403).json({ error: 'channel not found or not a member' });
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
  if (!ch) return res.status(403).json({ error: 'channel not found or not a member' });
  const content = String((req.body || {}).content || '').trim().slice(0, 2000);
  if (!content) return res.status(400).json({ error: 'content required' });
  const msg = {
    id: uuid(), channel_id: ch.id, server_id: ch.server_id,
    author_id: req.user.id, user: req.user.username, content, created_at: now(),
  };
  db.prepare('INSERT INTO messages (id, channel_id, author_id, content, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(msg.id, msg.channel_id, msg.author_id, msg.content, msg.created_at);
  broadcast(ch.server_id, ch.id, { type: 'message', ...msg });
  res.json(msg);
});

module.exports = router;
module.exports.setBroadcaster = setBroadcaster;
