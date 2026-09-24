// /api/users/me — profile read/update.
// /api/users/search, /presence, /:id — public directory (no private fields).
const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');
const rateLimit = require('../middleware/ratelimit');
const { fail, serviceError } = require('../errors');
const enforcement = require('../services/enforcement');
const uploads = require('../services/uploads');
const multer = require('multer');

let gateway = { getPresence: null };
function setGateway(gw) {
  gateway = Object.assign(gateway, gw);
}

const router = express.Router();
router.use(auth);

const memory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: uploads.MAX_SIZE, files: 1 },
});

function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    createdAt: row.created_at,
    bio: row.bio || null,
    avatarUrl: row.avatar_url || null,
    bannerUrl: row.banner_url || null,
    statusText: row.status_text || null,
  };
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
    // isAdmin mirrors the adminGuard table (presentation only; every admin
    // route re-checks server-side, so a forged client value cannot escalate).
    const isAdmin = await enforcement.isPlatformAdmin(req.user.id);
    res.json(Object.assign(publicUser(row), {
      email: row.email || null,
      emailVerified: !!row.email_verified_at,
      isAdmin,
    }));
  } catch (e) { next(e); }
});

router.patch('/me', async (req, res, next) => {
  try {
    const body = req.body || {};
    const out = {};

    if ('displayName' in body) {
      const displayName = String(body.displayName || '').trim();
      if (displayName.length < 1 || displayName.length > 32) {
        return fail(res, 'VALIDATION_ERROR', 'display name must be 1-32 characters');
      }
      out.display_name = displayName;
    }
    if ('bio' in body) {
      const bio = String(body.bio == null ? '' : body.bio).trim();
      if (bio.length > 200) return fail(res, 'VALIDATION_ERROR', 'bio must be 200 characters or fewer');
      out.bio = bio || null;
    }
    if ('statusText' in body) {
      const st = String(body.statusText == null ? '' : body.statusText).trim();
      if (st.length > 64) return fail(res, 'VALIDATION_ERROR', 'status must be 64 characters or fewer');
      out.status_text = st || null;
    }
    if (!Object.keys(out).length) return fail(res, 'VALIDATION_ERROR', 'nothing to update');

    const sets = Object.keys(out).map((k) => k + ' = ?').join(', ');
    const vals = Object.keys(out).map((k) => out[k]);
    await db.run(`UPDATE users SET ${sets} WHERE id = ?`, vals.concat([req.user.id]));
    const row = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    res.json(publicUser(row));
  } catch (e) { next(e); }
});

// --- profile media (avatars / banners) -------------------------------------

function singleImage(req, res, next) {
  memory.single('file')(req, res, (err) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') {
      return fail(res, 'VALIDATION_ERROR', 'file is too large (max 8 MB)');
    }
    if (err) return next(err);
    next();
  });
}

function profileImageRoute(kind) {
  return async (req, res, next) => {
    try {
      if (!req.file || !req.file.buffer) {
        return fail(res, 'VALIDATION_ERROR', 'send the image as a multipart field named "file"');
      }
      const out = await uploads.storeProfileMedia({ userId: req.user.id, kind, buffer: req.file.buffer, originalName: req.file.originalname || '' });
      if (out.error) return fail(res, out.error, out.message);
      // Replace (and free) any previous image of the same kind.
      const row = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
      const prev = kind === 'avatar' ? row.avatar_url : row.banner_url;
      await db.run(`UPDATE users SET ${kind === 'avatar' ? 'avatar_url' : 'banner_url'} = ? WHERE id = ?`, [out.url, req.user.id]);
      await uploads.removeProfileFile(prev).catch(() => {});
      const updated = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
      res.status(201).json(publicUser(updated));
    } catch (e) { next(e); }
  };
}

function profileImageDelete(kind) {
  return async (req, res, next) => {
    try {
      const row = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
      const prev = kind === 'avatar' ? row.avatar_url : row.banner_url;
      await db.run(`UPDATE users SET ${kind === 'avatar' ? 'avatar_url' : 'banner_url'} = NULL WHERE id = ?`, [req.user.id]);
      if (prev) await uploads.removeProfileFile(prev).catch(() => {});
      const updated = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
      res.json(publicUser(updated));
    } catch (e) { next(e); }
  };
}

router.post('/me/avatar', rateLimit({ windowMs: 60000, max: 10 }), singleImage, profileImageRoute('avatar'));
router.delete('/me/avatar', profileImageDelete('avatar'));
router.post('/me/banner', rateLimit({ windowMs: 60000, max: 10 }), singleImage, profileImageRoute('banner'));
router.delete('/me/banner', profileImageDelete('banner'));

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
      `SELECT id, username, display_name, created_at, bio, avatar_url, banner_url, status_text FROM users
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
    const row = await db.get(
      'SELECT id, username, display_name, created_at, bio, avatar_url, banner_url, status_text FROM users WHERE id = ?',
      [req.params.id]
    );
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
