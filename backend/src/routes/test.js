// TEST-ONLY hooks. Mounted exclusively when ALLOW_TEST_HOOKS=true (never
// in production): automated suites must be able to reach the verified
// state through HTTP alone, since real email delivery is unavailable in
// CI and log-mode tokens never leave the server log.
//
// POST /api/test/self-verify — marks the CALLER verified (test address if
// the account has none) so suites can exercise verified-only behavior.
// Every other caller, and every production boot, sees these paths as 404.
const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');
const { now } = require('../util');

const router = express.Router();
router.use(auth);

router.post('/self-verify', async (req, res, next) => {
  try {
    const row = await db.get('SELECT email FROM users WHERE id = ?', [req.user.id]);
    if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'user not found' } });
    const email = row.email || ('test-' + String(req.user.id).slice(0, 8) + '@trycord.test');
    await db.run('UPDATE users SET email = ?, email_verified_at = ? WHERE id = ?', [email, now(), req.user.id]);
    res.json({ ok: true, verified: true });
  } catch (e) { next(e); }
});

module.exports = router;
