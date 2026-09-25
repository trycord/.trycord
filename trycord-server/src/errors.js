// Structured API errors: { error: { code, message } }.
// Frontend maps codes to specific UX instead of generic messages.
const Codes = {
  AUTH_REQUIRED: 401,
  SESSION_REVOKED: 401,
  BAD_PASSWORD: 400,
  ACCOUNT_ENFORCED: 403,
  VALIDATION_ERROR: 400,
  ALREADY_MEMBER: 400,
  INVITE_EXPIRED: 400,
  INVITE_EXHAUSTED: 400,
  INVITE_REVOKED: 400,
  OWNER_CANNOT_LEAVE: 400,
  CANNOT_DELETE_LAST_CHANNEL: 400,
  ROLE_IN_USE: 409,
  CONFLICT: 409,
  NOT_A_MEMBER: 403,
  PERMISSION_DENIED: 403,
  BANNED: 403,
  TIMED_OUT: 403,
  RATE_LIMITED: 429,
  SERVER_PRIVATE: 403,
  SERVER_SUSPENDED: 403,
  SERVER_NOT_FOUND: 404,
  INVITE_INVALID: 404,
  NOT_FOUND: 404,
};

function fail(res, code, message, status, extra) {
  const s = status || Codes[code] || 500;
  const body = { error: { code, message: message || code } };
  if (extra) body.error.details = extra;
  return res.status(s).json(body);
}

// Services throw { code, message }; routes translate them here.
// Unknown failures never leak their raw message (stack traces, SQL, paths)
// to clients: log the real error server-side, send a fixed generic envelope.
function serviceError(res, e) {
  if (e && e.code && Codes[e.code]) return fail(res, e.code, e.message);
  console.error('[service]', (e && e.stack) || e);
  return res.status(500).json({ error: { code: 'INTERNAL', message: 'internal error' } });
}

module.exports = { Codes, fail, serviceError };
