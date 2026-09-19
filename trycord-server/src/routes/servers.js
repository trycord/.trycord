// /api/servers — create, list mine, preview by code, join, detail, members, owner settings.
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const auth = require('../middleware/auth');
const { now, uuid, isMember, isOwner } = require('../util');

const router = express.Router();
router.use(auth);

const LIST_COLS = `
  s.id, s.name, s.description, s.owner_id, s.join_code, s.is_public, s.created_at,
  (SELECT COUNT(*) FROM server_members m WHERE m.server_id = s.id) AS member_count,
  (SELECT COUNT(*) FROM channels c WHERE c.server_id = s.id) AS channel_count,
  (SELECT MAX(m2.created_at) FROM messages m2
     JOIN channels c2 ON c2.id = m2.channel_id WHERE c2.server_id = s.id) AS last_activity_at`;

function withRole(row, userId) {
  row.is_public = !!row.is_public;
  row.is_owner = row.owner_id === userId;
  return row;
}

// My servers, with real counts.
router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT ${LIST_COLS} FROM servers s
    JOIN server_members m ON m.server_id = s.id
    WHERE m.user_id = ? ORDER BY s.created_at DESC
  `).all(req.user.id).map((r) => withRole(r, req.user.id));
  res.json(rows);
});

// Create + auto-join as owner + default #general channel.
router.post('/', (req, res) => {
  const { name, description, joinCode, isPublic } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });
  const serverId = uuid();
  const code = String(joinCode || crypto.randomBytes(4).toString('hex')).toLowerCase();
  if (!/^[a-z0-9-]{3,32}$/.test(code)) {
    return res.status(400).json({ error: 'join code must be 3-32 chars: a-z, 0-9, -' });
  }
  try {
    db.prepare('INSERT INTO servers (id, name, description, owner_id, join_code, is_public, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(serverId, String(name).slice(0, 64), String(description || '').slice(0, 500),
        req.user.id, code, isPublic ? 1 : 0, now());
    db.prepare('INSERT INTO server_members (id, user_id, server_id, nickname, joined_at) VALUES (?, ?, ?, ?, ?)')
      .run(uuid(), req.user.id, serverId, req.user.username, now());
    const channelId = uuid();
    db.prepare("INSERT INTO channels (id, server_id, name, topic, type, position) VALUES (?, ?, 'general', 'General chat', 'text', 0)")
      .run(channelId, serverId);
    res.json({ serverId, joinCode: code, channelId });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'join code taken' });
    res.status(500).json({ error: e.message });
  }
});

// Public preview before joining (safe subset — no join code leak beyond the code itself,
// no member list, no messages).
router.get('/by-code/:code', (req, res) => {
  const srv = db.prepare(`
    SELECT s.id, s.name, s.description, s.is_public, s.created_at,
      (SELECT COUNT(*) FROM server_members m WHERE m.server_id = s.id) AS member_count
    FROM servers s WHERE s.join_code = ?
  `).get(String(req.params.code).toLowerCase().trim());
  if (!srv) return res.status(404).json({ error: 'server not found' });
  srv.is_public = !!srv.is_public;
  res.json(srv);
});

router.post('/join/:code', (req, res) => {
  const srv = db.prepare('SELECT * FROM servers WHERE join_code = ?')
    .get(String(req.params.code).toLowerCase().trim());
  if (!srv) return res.status(404).json({ error: 'server not found' });
  if (isMember(req.user.id, srv.id)) return res.json({ serverId: srv.id, alreadyMember: true });
  db.prepare('INSERT INTO server_members (id, user_id, server_id, nickname, joined_at) VALUES (?, ?, ?, ?, ?)')
    .run(uuid(), req.user.id, srv.id, req.user.username, now());
  res.json({ serverId: srv.id, name: srv.name });
});

// Full detail for members only.
router.get('/:id', (req, res) => {
  if (!isMember(req.user.id, req.params.id)) {
    return res.status(403).json({ error: 'not a member' });
  }
  const row = db.prepare(`
    SELECT ${LIST_COLS},
      (SELECT COUNT(*) FROM messages m2
         JOIN channels c2 ON c2.id = m2.channel_id WHERE c2.server_id = s.id) AS message_count,
      u.username AS owner_name, u.display_name AS owner_display
    FROM servers s JOIN users u ON u.id = s.owner_id WHERE s.id = ?
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'server not found' });
  res.json(withRole(row, req.user.id));
});

// Owner-only settings.
router.patch('/:id', (req, res) => {
  if (!isOwner(req.user.id, req.params.id)) {
    return res.status(403).json({ error: 'only the server owner can change settings' });
  }
  const { name, description, isPublic } = req.body || {};
  const sets = [];
  const vals = [];
  if (name !== undefined) {
    if (!String(name).trim()) return res.status(400).json({ error: 'name cannot be empty' });
    sets.push('name = ?');
    vals.push(String(name).slice(0, 64));
  }
  if (description !== undefined) {
    sets.push('description = ?');
    vals.push(String(description).slice(0, 500));
  }
  if (isPublic !== undefined) {
    sets.push('is_public = ?');
    vals.push(isPublic ? 1 : 0);
  }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  vals.push(req.params.id);
  db.prepare(`UPDATE servers SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  const row = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id);
  res.json(withRole(row, req.user.id));
});

// Member list for members only.
router.get('/:id/members', (req, res) => {
  if (!isMember(req.user.id, req.params.id)) {
    return res.status(403).json({ error: 'not a member' });
  }
  const rows = db.prepare(`
    SELECT u.id, u.username, u.display_name, m.nickname, m.joined_at,
      CASE WHEN u.id = s.owner_id THEN 1 ELSE 0 END AS is_owner
    FROM server_members m
    JOIN users u ON u.id = m.user_id
    JOIN servers s ON s.id = m.server_id
    WHERE m.server_id = ?
    ORDER BY is_owner DESC, m.joined_at ASC
  `).all(req.params.id);
  res.json(rows);
});

module.exports = router;
