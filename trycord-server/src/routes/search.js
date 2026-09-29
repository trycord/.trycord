// GET /api/search — message search across communities the requester
// belongs to. Membership-scoped: a row is returned only for channels in
// servers where the requester is a member (same rule as history reads).
// LIKE '%q%' cannot use an index, so this is a full scan of every message the
// requester can reach; the rate limit is the only thing bounding its cost.
const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');
const rateLimit = require('../middleware/ratelimit');
const { fail } = require('../errors');
const { escapeLike } = require('../util');

const router = express.Router();
router.use(auth);

router.get('/', rateLimit(30), async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 200);
    if (q.length < 2) return fail(res, 'VALIDATION_ERROR', 'type at least 2 characters to search');
    const limit = Math.min(Math.max(parseInt(req.query.limit || '25', 10) || 25, 1), 50);
    const serverId = req.query.serverId ? String(req.query.serverId) : null;
    const params = [req.user.id, '%' + escapeLike(q) + '%'];
    let serverFilter = '';
    if (serverId) {
      serverFilter = 'AND ch.server_id = ?';
      params.push(serverId);
    }
    const rows = await db.all(
      `SELECT m.*, u.username AS author_name, u.display_name AS author_display,
              ch.name AS channel_name, ch.server_id AS server_id, s.name AS server_name
       FROM messages m
       JOIN users u ON u.id = m.author_id
       JOIN channels ch ON ch.id = m.channel_id
       JOIN servers s ON s.id = ch.server_id
       JOIN server_members sm ON sm.server_id = ch.server_id AND sm.user_id = ?
       WHERE m.content LIKE ? ESCAPE '!' ${serverFilter}
       ORDER BY m.created_at DESC, m.id DESC LIMIT ${limit}`,
      params
    );
    res.json(rows);
  } catch (e) { next(e); }
});

module.exports = router;
