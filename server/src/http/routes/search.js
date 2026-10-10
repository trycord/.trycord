// Search.
//
// Two searches, answering two different questions. /api/search looks through messages
// the reader is already entitled to see - it is scoped by membership, so an id a stranger
// guesses is not a way to read someone else's conversation. /api/users/search is the
// public directory, prefix-first, with no private fields.

const express = require('express');
const { fail, wrap } = require('../errors');
const limit = require('../../middleware/ratelimit');
const { authenticate } = require('../../middleware/auth');
const db = require('../../db');

const router = express.Router();
router.use(authenticate);

// A LIKE pattern needs its metacharacters escaped, or a reader searching for "100%" gets
// every message there is.
function escapeLike(s) {
  return String(s).replace(/[!%_]/g, (c) => '!' + c);
}

// Messages, across every community this reader belongs to.
router.get('/', limit({ windowMs: 60000, max: 30 }), wrap(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 200);
  if (q.length < 2) return fail(res, 'VALIDATION_ERROR', 'type at least 2 characters to search');

  const page = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 50);
  const serverId = req.query.serverId ? String(req.query.serverId) : null;
  const params = [req.user.id, '%' + escapeLike(q) + '%'];
  let serverFilter = '';
  if (serverId) {
    serverFilter = 'AND ch.server_id = ?';
    params.push(serverId);
  }

  const rows = await db.all(
    `SELECT m.id, m.channel_id, m.content, m.created_at, m.author_id,
       u.username AS author_name, u.display_name AS author_display,
       u.avatar_url AS author_avatar,
       ch.name AS channel_name, ch.server_id AS server_id, s.name AS server_name
     FROM messages m
       JOIN users u ON u.id = m.author_id
       JOIN channels ch ON ch.id = m.channel_id
       JOIN servers s ON s.id = ch.server_id
       JOIN server_members sm ON sm.server_id = ch.server_id AND sm.user_id = ?
      WHERE m.content LIKE ? ESCAPE '!' ${serverFilter}
      ORDER BY m.created_at DESC, m.id DESC LIMIT ${page}`,
    params
  );

  res.json(rows);
}));

// The public directory: prefix matches first, then anywhere in the name.
router.get('/users/search', limit({ windowMs: 60000, max: 60 }), wrap(async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 64);
  if (q.length < 2) return fail(res, 'VALIDATION_ERROR', 'type at least 2 characters to search');

  const page = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 50);
  const rows = await db.all(
    `SELECT id, username, display_name, created_at, bio, avatar_url, banner_url, status_text, is_bot
       FROM users
      WHERE lower(username) LIKE lower(?) OR lower(display_name) LIKE lower(?)
      ORDER BY (lower(username) LIKE lower(?)) DESC, username
      LIMIT ?`,
    [q + '%', '%' + q + '%', q + '%', page]
  );

  res.json(rows.map((r) => ({
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    createdAt: r.created_at,
    bio: r.bio || null,
    avatarUrl: r.avatar_url || null,
    bannerUrl: r.banner_url || null,
    statusText: r.status_text || null,
    isBot: !!r.is_bot,
  })));
}));

module.exports = router;
