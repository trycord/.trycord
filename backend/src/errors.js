// Structured API errors: { error: { code, message } }.
// Frontend maps codes to specific UX instead of generic messages.
const Codes = {
  AUTH_REQUIRED: 401,
  SESSION_REVOKED: 401,
  BAD_PASSWORD: 400,
  // Login throttling. 429 so a client can show a countdown and so a caller can
  // tell "locked out" from "wrong password" without parsing prose.
  ACCOUNT_LOCKED: 429,
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
  // Storage is full for this account. 413 so a client can tell a quota refusal
  // apart from a rejected file: the file itself was valid.
  QUOTA_EXCEEDED: 413,
  SERVER_PRIVATE: 403,
  SERVER_SUSPENDED: 403,
  SERVER_NOT_FOUND: 404,
  INVITE_INVALID: 404,
  // A refused registration is a policy decision, not a validation failure: the
  // details were fine, the instance is closed. 403 so a client can say so.
  REGISTRATION_DISABLED: 403,
  NOT_FOUND: 404,
  // A privacy setting refused an interaction. 403, and distinct from
  // PERMISSION_DENIED because the answer is a personal preference rather than
  // a role: the client can say "this person is not accepting messages" instead
  // of "you do not have permission".
  BLOCKED: 403,
  NOT_ACCEPTING_DMS: 403,
  NOT_ACCEPTING_REQUESTS: 403,
  // Voice and video. A feature that is switched off at the instance level is a refusal the
  // client can act on - it can hide the join control - rather than an internal error,
  // which is what an unmapped code used to become and which left a member looking at
  // "something went wrong" for a setting that is working exactly as configured.
  FEATURE_DISABLED: 403,
  // Registration approval is pending. Distinct from ACCOUNT_ENFORCED because the fix is
  // different: an administrator approves it, nobody lifts anything.
  ACCOUNT_PENDING: 403,
  // A full voice channel. 409 rather than 403: the member is allowed in, the room is not.
  ROOM_FULL: 409,
  // End-to-end encryption. A refusal that means the request was not understood
  // or not accepted, kept apart from the ordinary validation failure so a
  // client can say "this is an encryption problem" rather than "you filled
  // the form in wrong".
  E2EE_VALIDATION_ERROR: 400,
  // A signature that did not verify. 403 when the request carried a
  // credential: the key did not match what the server has for that device.
  E2EE_INVALID_SIGNATURE: 403,
  // An envelope whose protocol version this build does not speak. Refused
  // rather than downgraded: there is no plaintext path to fall back to.
  E2EE_UNSUPPORTED_VERSION: 400,
  E2EE_CRYPTO_ERROR: 400,
  E2EE_FORBIDDEN: 403,
  E2EE_DEVICE_REVOKED: 403,
  E2EE_NOT_FOUND: 404,
  E2EE_CONFLICT: 409,
  // A message or a state push that has already been applied.
  E2EE_REPLAY: 409,
  // A one-time prekey that has already been claimed.
  E2EE_PREKEY_GONE: 409,
  // The developer platform. A credential that is not what it claims to be,
  // and a credential that is real but does not hold the scope the request
  // needs. The missing scopes are named in the error's details, so a
  // developer is told which one to ask for rather than only that it failed.
  API_KEY_INVALID: 401,
  API_KEY_REVOKED: 401,
  API_KEY_EXPIRED: 401,
  INSUFFICIENT_SCOPE: 403,
  // A bot application that is disabled, or that is not in the community the
  // request names.
  BOT_NOT_ALLOWED: 403,
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
  return res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal error' } });
}

// An async route handler that cannot forget its try/catch.
//
// Every route in this package that awaits something has to translate a service throw
// into a status, and the ones that forget it answer a rejected promise with an
// unhandled rejection and a hung request instead of the error the client can read.
// Wrapping the handler centralises it, so a route body reads as the work and not as
// the error plumbing around it.
function wrap(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (e) {
      serviceError(res, e);
    }
  };
}

module.exports = { Codes, fail, serviceError, wrap };
