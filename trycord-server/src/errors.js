// Structured API errors: { error: { code, message } }.
// Frontend maps codes to specific UX instead of generic messages.
const Codes = {
  AUTH_REQUIRED: 401,
  SESSION_REVOKED: 401,
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
  RATE_LIMITED: 429,
  SERVER_PRIVATE: 403,
  SERVER_NOT_FOUND: 404,
  INVITE_INVALID: 404,
  NOT_FOUND: 404,
};

function fail(res, code, message) {
  const status = Codes[code] || 500;
  return res.status(status).json({ error: { code, message: message || code } });
}

// Services throw { code, message }; routes translate them here.
function serviceError(res, e) {
  if (e && e.code && Codes[e.code]) return fail(res, e.code, e.message);
  return res.status(500).json({ error: { code: 'INTERNAL', message: String((e && e.message) || e) } });
}

module.exports = { Codes, fail, serviceError };
