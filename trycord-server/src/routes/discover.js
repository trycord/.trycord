// GET /api/discover — public servers only. Never leaks join codes,
// member lists, or message contents.
const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');

const router = express.Router();
router.use(auth);

router.get('/', (req, res) => {
  const q = String(req.query.q || '').trim();
  const where = ['s.is_public = 1'];
  const vals = [];
  if (q) {
    where.push('(s.name LIKE ? OR s.description LIKE ?)');
    vals.push(`%${q}%`, `%${q}%`);
  }
  vals.push(50);
  const rows = db.prepare(`
    SELECT s.id, s.name, s.description, s.created_at,
      (SELECT COUNT(*) FROM server_members m WHERE m.server_id = s.id) AS member_count,
      (SELECT COUNT(*) FROM channels c WHERE c.server_id = s.id) AS channel_count
    FROM servers s WHERE ${where.join(' AND ')}
    ORDER BY member_count DESC, s.created_at DESC LIMIT ?
  `).all(...vals);
  res.json(rows);
});

module.exports = router;
