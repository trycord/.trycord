// The platform-administration gate.
//
// Membership in the admins table is the single server-side source of truth. The
// /me response carries isAdmin for the client's convenience, but no route trusts it:
// a token with a tampered claim is still refused here.

const { authenticate } = require('./auth');
const db = require('../db');
const { fail } = require('../http/errors');

async function isPlatformAdmin(userId) {
  const row = await db.get('SELECT 1 FROM admins WHERE user_id = ?', [userId]);
  return !!row;
}

// A fixed message, so the gate is not an oracle for which usernames are administrators.
function requirePlatformAdmin(req, res, next) {
  authenticate(req, res, async () => {
    if (!req.user) return fail(res, 'AUTH_REQUIRED', 'authentication required');
    if (!(await isPlatformAdmin(req.user.id))) return fail(res, 'PERMISSION_DENIED', 'forbidden');
    req.admin = true;
    next();
  });
}

module.exports = { isPlatformAdmin, requirePlatformAdmin };
