// Search across the instance, scoped to what the reader is allowed to see.
//
// A community is searchable when it chose to be discoverable; a person is searchable by
// username and display name, which is what the friend picker needs.

const express = require('express');
const { fail, wrap } = require('../errors');
const limit = require('../../middleware/ratelimit');
const { authenticate } = require('../../middleware/auth');
const users = require('../../services/users');
const db = require('../../db');

const router = express.Router();
router.use(authenticate);

function needle(req, res) {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) {
    fail(res, 'VALIDATION_ERROR', 'a search needs at least two characters');
    return null;
  }
  return q.slice(0, 64);
}

router.get('/users', limit({ windowMs: 60000, max: 30 }), wrap(async (req, res) => {
  const q = needle(req, res);
  if (!q) return;
  res.json({ users: await users.search(q, req.query.limit) });
}));

router.get('/communities', limit({ windowMs: 60000, max: 30 }), wrap(async (req, res) => {
  const q = needle(req, res);
  if (!q) return;

  const rows = await db.all(
    `SELECT s.id, s.name, s.description, s.slug, s.icon_url
       FROM servers s
      WHERE s.is_discoverable = 1 AND (s.name LIKE ? OR s.description LIKE ?)
      ORDER BY s.name LIMIT ?`,
    [`%${q}%`, `%${q}%`, Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50)]
  );
  res.json({ communities: rows });
}));

module.exports = router;
