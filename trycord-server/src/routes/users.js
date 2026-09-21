// /api/users/me — profile read/update.
// /api/users/search, /presence, /:id — public directory (no private fields).
const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');
const rateLimit = require('../middleware/ratelimit');
const { fail, serviceError } = require('../errors');

let gateway = { getPresence: null };
function setGateway(gw) {
  gateway = Object.assign(gateway, gw);
}

const router = express.Router();
router.use(auth);

function publicUser(row) {
  return { id: row.id, username: row.username, displayName: row.display_name, createdAt: row.created_at };
}

function presenceOf(id) {
  try {
    const p = gateway.getPresence ? gateway.getPresence([id]) : {};
    return p[String(id)] || 'offline';
  } catch {
    return 'offline';
  }
}

router.get('/me', async (req, res, next) => {
  try {
    const row = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!row) return fail(res, 'NOT_FOUND', 'user not found');
    // Email recovery state is private to the owner — never on publicUser.
    res.json(Object.assign(publicUser(row), {
      email: row.email || null,
      emailVerified: !!row.email_verified_at,
    }));
  } catch (e) { next(e); }
});

router.patch('/me', async (req, res, next) => {
  try {
    const displayName = String((req.body || {}).displayName || '').trim();
    if (displayName.length < 1 || displayName.length > 32) {
      return fail(res, 'VALIDATION_ERROR', 'display name must be 1-32 characters');
    }
    await db.run('UPDATE users SET display_name = ? WHERE id = ?', [displayName, req.user.id]);
    const row = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    res.json(publicUser(row));
  } catch (e) { next(e); }
});

// LIKE metacharacters (%, _) plus the escape character itself must match
// literally, never as wildcards. The escape character is '!' deliberately:
// unlike backslash it needs no escaping of its own in JS string syntax NOR
// in SQL string syntax, so the statement text sent to MariaDB/MySQL contains
// a plain, valid ESCAPE '!' clause (a JS '\\' became SQL '\', which MariaDB
// parses as an unterminated string — the production 500). User input stays
// in bound parameters; only the static clause changed.
function escapeLike(s) {
  return String(s).replace(/[%_!]/g, (c) => '!' + c);
}

// GET /api/users/search?q=alice — prefix-first directory, public fields only.
router.get('/search', rateLimit({ windowMs: 60000, max: 60 }), async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 32);
    if (q.length < 2) return fail(res, 'VALIDATION_ERROR', 'type at least 2 characters to search');
    const lit = escapeLike(q);
    const rows = await db.all(
      `SELECT id, username, display_name, created_at FROM users
       WHERE username LIKE ? ESCAPE '!' OR username LIKE ? ESCAPE '!'
       ORDER BY CASE WHEN username LIKE ? ESCAPE '!' THEN 0 ELSE 1 END, username
       LIMIT 20`,
      [`${lit}%`, `%${lit}%`, `${lit}%`]
    );
    res.json(rows.map((r) => Object.assign(publicUser(r), { presence: presenceOf(r.id) })));
  } catch (e) { next(e); }
});

// GET /api/users/presence?ids=a,b — online/offline derived from live sockets.
router.get('/presence', async (req, res, next) => {
  try {
    const ids = String(req.query.ids || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 100);
    let out = {};
    try {
      out = gateway.getPresence ? gateway.getPresence(ids) : {};
    } catch { /* presence is best-effort */ }
    ids.forEach((id) => { if (!out[id]) out[id] = 'offline'; });
    res.json(out);
  } catch (e) { next(e); }
});

// GET /api/users/:id — public profile plus my relationship to them.
router.get('/:id', async (req, res, next) => {
  try {
    const row = await db.get('SELECT id, username, display_name, created_at FROM users WHERE id = ?', [req.params.id]);
    if (!row) return fail(res, 'NOT_FOUND', 'user not found');
    const me = req.user.id;
    const profile = Object.assign(publicUser(row), { presence: presenceOf(row.id) });
    if (String(row.id) === String(me)) {
      profile.relation = 'self';
    } else {
      const [friend, pending] = await Promise.all([
        db.get('SELECT 1 FROM friendships WHERE user_id = ? AND friend_id = ?', [me, row.id]),
        db.get(
          `SELECT from_user_id FROM friend_requests
           WHERE ((from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?))
             AND status = 'pending'`,
          [me, row.id, row.id, me]
        ),
      ]);
      profile.relation = friend ? 'friend' : pending
        ? (String(pending.from_user_id) === String(me) ? 'pending-out' : 'pending-in')
        : 'none';
    }
    res.json(profile);
  } catch (e) { serviceError(res, e); }
});

module.exports = router;
module.exports.setGateway = setGateway;
