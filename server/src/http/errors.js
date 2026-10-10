// The error envelope, and the two ways a route uses it.
//
// `fail` is for a refusal the route knows about. `serviceError` is for a service that
// threw { code, message }, and it is also the guard that keeps an unknown failure from
// leaking its raw message to a client.

const STATUS = {
  VALIDATION_ERROR: 400,
  BAD_JSON: 400,
  BAD_REQUEST: 400,
  PAYLOAD_TOO_LARGE: 413,
  AUTH_REQUIRED: 401,
  INVALID_CREDENTIALS: 401,
  SESSION_REVOKED: 401,
  NOT_FOUND: 404,
  SERVER_NOT_FOUND: 404,
  INVITE_INVALID: 404,
  FORBIDDEN: 403,
  PERMISSION_DENIED: 403,
  NOT_A_MEMBER: 403,
  EMAIL_NOT_VERIFIED: 403,
  TIMED_OUT: 403,
  ACCOUNT_ENFORCED: 403,
  CONFLICT: 409,
  ALREADY_EXISTS: 409,
  RATE_LIMITED: 429,
  // A feature this instance does not have enabled. 403 rather than 404, because the
  // request was well-formed and the resource may well exist - the capability does not.
  FEATURE_DISABLED: 403,
  ROOM_FULL: 409,
  BANNED: 403,
  INTERNAL: 500,
};

function fail(res, code, message, status, extra) {
  const s = status || STATUS[code] || 500;
  const body = { error: { code, message: message || code } };
  if (extra) body.error.details = extra;
  return res.status(s).json(body);
}

function serviceError(res, e) {
  if (e && e.code && STATUS[e.code]) return fail(res, e.code, e.message);
  // Unknown failures are logged with their stack and answered generically: never the
  // stack, never the SQL, never a filesystem path.
  try { console.error('[service]', (e && e.stack) || e); } catch { /* no console */ }
  return fail(res, 'INTERNAL', 'internal error');
}

// A service throwing anything at all is turned into the envelope, so a route can write
// `catch (e) { serviceError(res, e) }` and know nothing unsafe escapes.
function wrap(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (e) {
      serviceError(res, e);
    }
  };
}

module.exports = { STATUS, fail, serviceError, wrap };
