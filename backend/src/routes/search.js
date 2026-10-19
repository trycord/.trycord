// GET /api/search — message search across communities the requester
// belongs to. Membership-scoped: a row is returned only for channels in
// servers where the requester is a member (same rule as history reads).
const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');
const rateLimit = require('../middleware/ratelimit');
const { fail } = require('../errors');
const { escapeLike } = require('../util');
const settings = require('../services/settings');

const router = express.Router();
router.use(auth);

router.get('/', rateLimit(30), async (req, res, next) => {
  try {
    settings.get('search.provider');
    const q = String(req.query.q || '').trim().slice(0, 200);
    if (q.length < 2) return fail(res, 'VALIDATION_ERROR', 'type at least 2 characters to search');
    const limit = Math.min(Math.max(parseInt(req.query.limit || '25', 10) || 25, 1), 50);
    const serverId = req.query.serverId ? String(req.query.serverId) : null;

    // The in-house index, when it is there. It is permission-scoped in the
    // index itself, so the query cannot return a message the reader may not
    // see.
    try {
      const index = require('../services/search-index');
      if (await index.available()) {
        const rows = await index.find(q, { userId: req.user.id, serverId, limit });
        return res.json(rows);
      }
    } catch (e) {
      // A search that cannot use the index still has to answer. The slower
      // path below is correct, just slower.
    }

    let rows = null;
    let useFts = false;
    try {
      if (db.dialect === 'sqlite') {
        const present = await db.get("SELECT 1 AS n FROM sqlite_master WHERE type='table' AND name='messages_fts'");
        useFts = !!(present && present.n);
      }
    } catch { useFts = false; }

    // In-house search: SQLite uses an FTS5 virtual index over messages.content
    // (kept in sync via triggers); dialects without FTS fall back to the
    // existing permission-scoped LIKE query. Always membership-scoped.
    if (useFts) {
      const escaped = String(q).replace(/"/g, '');
      const ftsQ = '"' + escaped + '"';
      const params = [req.user.id, ftsQ];
      let serverFilter = '';
      if (serverId) {
        serverFilter = 'AND ch.server_id = ?';
        params.push(serverId);
      }
      try {
        rows = await db.all(
          `SELECT m.*, u.username AS author_name, u.display_name AS author_display,
                  ch.name AS channel_name, ch.server_id AS server_id, s.name AS server_name
            FROM messages m
            JOIN users u ON u.id = m.author_id
            JOIN channels ch ON ch.id = m.channel_id
            JOIN servers s ON s.id = ch.server_id
            JOIN server_members sm ON sm.server_id = ch.server_id AND sm.user_id = ?
            JOIN messages_fts f ON f.rowid = m.rowid
            WHERE messages_fts MATCH ? ${serverFilter}
            ORDER BY m.created_at DESC, m.id DESC LIMIT ${limit}`,
          params
        );
      } catch { rows = null; }
    }

    if (!rows) {
      const params = [req.user.id, '%' + escapeLike(q) + '%'];
      let serverFilter = '';
      if (serverId) {
        serverFilter = 'AND ch.server_id = ?';
        params.push(serverId);
      }
      rows = await db.all(
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
    }
    res.json(rows);
  } catch (e) { next(e); }
});

module.exports = router;