// /api/servers/:serverId/channels — list/create (members), delete (owner).
const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');
const { uuid, isMember, isOwner } = require('../util');

const router = express.Router({ mergeParams: true });
router.use(auth);

function requireMember(req, res) {
  if (!isMember(req.user.id, req.params.serverId)) {
    res.status(403).json({ error: 'not a member' });
    return false;
  }
  return true;
}

router.get('/', (req, res) => {
  if (!requireMember(req, res)) return;
  res.json(db.prepare('SELECT * FROM channels WHERE server_id = ? ORDER BY position, name')
    .all(req.params.serverId));
});

router.post('/', (req, res) => {
  if (!requireMember(req, res)) return;
  const { name, topic } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });
  const clean = String(name).trim().toLowerCase().replace(/[^a-z0-9-_ ]/g, '').slice(0, 32) || 'channel';
  const pos = db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM channels WHERE server_id = ?')
    .get(req.params.serverId).p;
  const channelId = uuid();
  db.prepare('INSERT INTO channels (id, server_id, name, topic, type, position) VALUES (?, ?, ?, ?, ?, ?)')
    .run(channelId, req.params.serverId, clean, String(topic || '').slice(0, 200), 'text', pos);
  res.json({ channelId });
});

router.delete('/:channelId', (req, res) => {
  if (!requireMember(req, res)) return;
  if (!isOwner(req.user.id, req.params.serverId)) {
    return res.status(403).json({ error: 'only the server owner can delete channels' });
  }
  const ch = db.prepare('SELECT * FROM channels WHERE id = ? AND server_id = ?')
    .get(req.params.channelId, req.params.serverId);
  if (!ch) return res.status(404).json({ error: 'channel not found' });
  const count = db.prepare('SELECT COUNT(*) AS n FROM channels WHERE server_id = ?')
    .get(req.params.serverId).n;
  if (count <= 1) return res.status(400).json({ error: 'cannot delete the last channel' });
  db.prepare('DELETE FROM channels WHERE id = ?').run(ch.id);
  res.json({ ok: true });
});

module.exports = router;
