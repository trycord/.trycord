// /api/users/me — profile read/update, password change.
const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../db');
const auth = require('../middleware/auth');
const { fail, serviceError } = require('../errors');

const router = express.Router();
router.use(auth);

function publicUser(row) {
  return { id: row.id, username: row.username, displayName: row.display_name, createdAt: row.created_at };
}

router.get('/me', async (req, res, next) => {
  try {
    const row = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!row) return fail(res, 'NOT_FOUND', 'user not found');
    res.json(publicUser(row));
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

router.post('/me/password', async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return fail(res, 'VALIDATION_ERROR', 'current and new password required');
    }
    if (String(newPassword).length < 6) {
      return fail(res, 'VALIDATION_ERROR', 'new password must be 6+ characters');
    }
    const row = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!row) return fail(res, 'NOT_FOUND', 'user not found');
    const ok = await bcrypt.compare(String(currentPassword), row.password_hash);
    if (!ok) return fail(res, 'AUTH_REQUIRED', 'current password is incorrect');
    const hash = await bcrypt.hash(String(newPassword), 10);
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hash, req.user.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
