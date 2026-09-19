// POST /api/auth/register, /login, /logout
const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../db');
const auth = require('../middleware/auth');
const { now, uuid, sign } = require('../util');

const router = express.Router();

router.post('/register', async (req, res) => {
  const { username, password, displayName } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  if (String(password).length < 6) return res.status(400).json({ error: 'password must be 6+ characters' });
  const name = String(username).trim();
  if (!/^[A-Za-z0-9_.]{2,32}$/.test(name)) {
    return res.status(400).json({ error: 'username must be 2-32 chars: letters, numbers, _ or .' });
  }
  try {
    const id = uuid();
    const hash = await bcrypt.hash(String(password), 10);
    db.prepare('INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, name, String(displayName || name).slice(0, 32), hash, now());
    const token = sign({ id, username: name });
    res.json({ token, user: { id, username: name, displayName: displayName || name } });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'username taken' });
    res.status(500).json({ error: e.message });
  }
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username).trim());
  if (!user) return res.status(401).json({ error: 'invalid credentials' });
  const ok = await bcrypt.compare(String(password), user.password_hash);
  if (!ok) return res.status(401).json({ error: 'invalid credentials' });
  res.json({
    token: sign(user),
    user: { id: user.id, username: user.username, displayName: user.display_name },
  });
});

// Revoke the current token so it cannot be used again.
router.post('/logout', auth, (req, res) => {
  try {
    if (req.user.jti) {
      const expiresAt = new Date(req.user.exp * 1000).toISOString();
      db.prepare('INSERT OR IGNORE INTO revoked_tokens (jti, expires_at) VALUES (?, ?)')
        .run(req.user.jti, expiresAt);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
