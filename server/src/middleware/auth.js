// Auth middleware.
//
// This resolves a session and puts it on req. Whether that session may do the thing is a
// separate question, answered by services/permissions.js against the server's own rows.

const auth = require('../services/auth');
const permissions = require('../services/permissions');
const { fail } = require('../http/errors');

async function authenticate(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!token) return fail(res, 'AUTH_REQUIRED', 'authentication required');

  const out = await auth.resolveSession(token);
  if (out.error) return fail(res, out.error, out.message, out.status);

  req.user = out.user;
  req.verified = out.verified;
  next();
}

// Verification is only enforceable when the instance can actually deliver mail. With
// MAIL_MODE=log there is no way for anyone to confirm an address, so gating on it would
// lock messaging off permanently on self-hosted instances that never configure SMTP.
function verificationEnforceable() {
  return require('../config').verificationEnforceable();
}

function requireVerified(req, res, next) {
  if (!verificationEnforceable()) return next();
  if (req.verified) return next();
  return fail(res, 'EMAIL_NOT_VERIFIED', 'verify your email to use this', 403);
}

module.exports = {
  authenticate,
  requireVerified,
  can: permissions.can,
  serverPermissions: permissions.serverPermissions,
  channelPermissions: permissions.channelPermissions,
  ALL: permissions.ALL,
};
