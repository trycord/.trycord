// /api/users/me — profile read/update, password change.
const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../db');
const auth = require('../middleware/auth');

const router = express.Router();
router.use(auth);

function publicUser(row) {
  return { id: row.id, username: row.username, displayName: row.display_name, createdAt: row.created_at };
}

router.get('/me', (req, res) => {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!row) return res.status(404).json({ error: 'user not found' });
  res.json(publicUser(row));
});

router.patch('/me', (req, res) => {
  const displayName = String((req.body || {}).displayName || '').trim();
  if (displayName.length < 1 || displayName.length > 32) {
    return res.status(400).json({ error: 'display name must be 1-32 characters' });
  }
  db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(displayName, req.user.id);
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json(publicUser(row));
});

router.post('/me/password', async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'current and new password required' });
  }
  if (String(newPassword).length < 6) {
    return res.status(400).json({ error: 'new password must be 6+ characters' });
  }
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!row) return res.status(404).json({ error: 'user not found' });
  const ok = await bcrypt.compare(String(currentPassword), row.password_hash);
  if (!ok) return res.status(401).json({ error: 'current password is incorrect' });
  const hash = await bcrypt.hash(String(newPassword), 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user.id);
  res.json({ ok: true });
});

module.exports = router;
