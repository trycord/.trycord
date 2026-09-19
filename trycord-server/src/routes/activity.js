// GET /api/activity — recent messages across servers the user belongs to.
const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');

const router = express.Router();
router.use(auth);

router.get('/', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '20', 10) || 20, 50);
  const rows = db.prepare(`
    SELECT m.id, m.content, m.created_at,
      m.channel_id, c.name AS channel_name,
      s.id AS server_id, s.name AS server_name,
      u.username AS author_name, u.display_name AS author_display
    FROM messages m
    JOIN channels c ON c.id = m.channel_id
    JOIN servers s ON s.id = c.server_id
    JOIN server_members sm ON sm.server_id = s.id AND sm.user_id = ?
    JOIN users u ON u.id = m.author_id
    ORDER BY m.created_at DESC LIMIT ?
  `).all(req.user.id, limit);
  res.json(rows);
});

module.exports = router;
