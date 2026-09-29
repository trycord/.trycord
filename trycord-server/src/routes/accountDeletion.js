// Settings -> Account -> Delete my account, and the administrator's GDPR
// queue. The user side is deliberately awkward: it needs a password, it says
// what will and will not be erased, and it is rate limited.
const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../db');
const auth = require('../middleware/auth');
const rateLimit = require('../middleware/ratelimit');
const { fail, serviceError } = require('../errors');
const deletion = require('../services/accountDeletion');

const router = express.Router();
router.use(auth);

function publicRequest(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    requestType: row.request_type,
    requestedAt: row.requested_at,
    reviewedAt: row.reviewed_at,
    processedAt: row.processed_at,
    cancelledAt: row.cancelled_at,
    anonymisedAt: row.anonymised_at,
    // Always visible so the queue can render "REQUESTED BY GDPR" without an
    // administrator having to infer it.
    requestedBy: row.request_type === 'GDPR' ? 'GDPR' : null,
  };
}

router.get('/deletion', async (req, res, next) => {
  try {
    res.json({ request: publicRequest(await deletion.getForUser(req.user.id)) });
  } catch (e) { next(e); }
});

router.post('/deletion', rateLimit({ windowMs: 60000, max: 5 }), async (req, res, next) => {
  try {
    const { password, confirm, reason } = req.body || {};
    if (confirm !== 'DELETE') {
      return fail(res, 'VALIDATION_ERROR', 'type DELETE to confirm');
    }
    const user = await db.get('SELECT id, password_hash FROM users WHERE id = ?', [req.user.id]);
    if (!user) return fail(res, 'NOT_FOUND', 'user not found');
    // Re-authentication, because this is irreversible for the identity even
    // though the messages stay.
    if (!password) return fail(res, 'VALIDATION_ERROR', 'password required');
    const okPw = await bcrypt.compare(String(password), user.password_hash);
    if (!okPw) return fail(res, 'BAD_PASSWORD', 'password is incorrect');
    const row = await deletion.requestDeletion({ userId: req.user.id, reason });
    res.status(201).json({ request: publicRequest(row) });
  } catch (e) { serviceError(res, e); }
});

router.post('/deletion/cancel', rateLimit({ windowMs: 60000, max: 5 }), async (req, res, next) => {
  try {
    const row = await deletion.cancelDeletion({ userId: req.user.id, actorId: req.user.id });
    res.json({ request: publicRequest(row) });
  } catch (e) { serviceError(res, e); }
});

module.exports = router;
module.exports.publicRequest = publicRequest;
