// TEST-ONLY hooks. Mounted exclusively when ALLOW_TEST_HOOKS is true, which no production
// boot sets. Automated suites must be able to reach the verified state through HTTP
// alone, because real email delivery is unavailable in CI and a log-mode token never
// leaves the server log.

const express = require('express');
const db = require('../../db');
const { authenticate } = require('../../middleware/auth');
const { wrap } = require('../errors');
const { now } = require('../../util');

const router = express.Router();
router.use(authenticate);

router.post('/self-verify', wrap(async (req, res) => {
  const row = await db.get('SELECT email FROM users WHERE id = ?', [req.user.id]);
  if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'user not found' } });

  const email = row.email || ('test-' + String(req.user.id).slice(0, 8) + '@trycord.test');
  await db.run('UPDATE users SET email = ?, email_verified_at = ? WHERE id = ?', [email, now(), req.user.id]);
  res.json({ ok: true, verified: true });
}));

module.exports = router;
