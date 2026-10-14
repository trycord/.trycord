// Bearer-token auth. Rejects missing, invalid, expired, and revoked tokens.
// Tokens issued before the account's password change or session-invalidation
// markers are also rejected, so password changes and "sign out everywhere"
// actually end old sessions instead of leaving them valid.
// Trust & Safety: accounts under an active ban/suspension are rejected here
// too. The enforcement columns ride along in the same single query as the
// revocation flag, so the hot path stays one round trip.
const jwt = require('jsonwebtoken');
const db = require('../db');
const { fail } = require('../errors');
const { secret } = require('../util');

function tokenStale(user, row) {
  if (!row || !user.iat) return false;
  // JWT iat is whole seconds, so compare against the marker's whole
  // second too. A marker written in the same second the token was
  // issued must not flag a freshly-signed token as stale.
  for (const col of ['password_changed_at', 'sessions_invalidated_at']) {
    const t = row[col];
    if (!t) continue;
    const markerSec = Math.floor(new Date(t).getTime() / 1000);
    if (!Number.isNaN(markerSec) && user.iat < markerSec) return true;
  }
  return false;
}

function enforced(user, row) {
  const state = row ? row.enforcement_state : null;
  if (state === 'banned') return { type: 'ACCOUNT_BAN' };
  if (state === 'suspended') {
    const exp = row.enforcement_expires_at;
    if (exp && new Date(exp).getTime() < Date.now()) return null; // lapsed
    return { type: 'SUSPENSION', until: exp };
  }
  return null;
}

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!token) return fail(res, 'AUTH_REQUIRED', 'authentication required');
  let user;
  try {
    // Pinned to the one algorithm this server issues. jwt.verify without a list
    // accepts whatever the token's own header names, which is how an "alg: none"
    // or a mismatched-algorithm token gets treated as a signature to check.
    user = jwt.verify(token, secret(), { algorithms: ['HS256'] });
  } catch {
    return fail(res, 'AUTH_REQUIRED', 'invalid or expired session');
  }
  // One round trip for the whole session check: the revocation flag rides
  // along as a scalar subquery instead of a second sequential lookup.
  // Identical semantics: revoked jti, missing user, or stale markers reject.
  db.get(
    `SELECT u.password_changed_at, u.sessions_invalidated_at, u.enforcement_state,
       u.enforcement_expires_at, u.email_verified_at, u.session_version, u.totp_enabled_at,
       u.approved_at,
       (SELECT 1 FROM revoked_tokens r WHERE r.jti = ?) AS revoked
     FROM users u WHERE u.id = ?`,
    [user.jti || '', user.id]
  )
    .then(async (row) => {
      if (!row) return fail(res, 'NOT_FOUND', 'user not found');
      if (user.jti && row.revoked) return fail(res, 'SESSION_REVOKED', 'session revoked');
      if (tokenStale(user, row)) return fail(res, 'SESSION_REVOKED', 'session revoked');
      // Authoritative: a token minted before the version was bumped is dead,
      // whatever second it was issued in. Tokens with no sv predate the column
      // and are judged by the timestamps alone, which is the old behaviour.
      if (user.sv !== undefined && Number(user.sv) !== Number(row.session_version || 0)) {
        return fail(res, 'SESSION_REVOKED', 'session revoked');
      }
      // read() with a false fallback: before the store loads there is nothing to
      // enforce, and the login that follows would refuse every account.
      const require2fa = require('../services/settings').read('security.require2fa', false);
      const ef = enforced(user, row);
      if (ef) return fail(res, 'ACCOUNT_ENFORCED', 'account is subject to a moderation action', 403, ef);

      // A pending account is refused everywhere. NULL means the account predates
      // approval or the instance does not require it, so switching the setting on
      // never locks out the members an instance already has.
      const approval = require('../services/settings');
      if (approval.isLoaded() && approval.get('registration.approval')
          && row.approved_at === null) {
        return fail(res, 'ACCOUNT_PENDING',
          'this account is waiting for a system administrator to approve it', 403);
      }
      // An instance that requires a second factor refuses anyone who has not
      // enrolled. Platform admins are exempt, because locking out the people who
      // operate the instance, including whoever just turned the requirement on,
      // is not a security improvement.
      //
      // Read per request, so a change in the configuration centre applies to the
      // next request rather than the next restart.
      if (require2fa && !row.totp_enabled_at) {
        const isAdmin = await require('../services/enforcement').isPlatformAdmin(user.id);
        if (!isAdmin) {
          return fail(res, 'MFA_REQUIRED',
            'this instance requires two-factor authentication. Enrol a second factor to continue.',
            403);
        }
      }
      req.user = user;
      // Authoritative verification state for this session. Write routes
      // that require a verified email use requireVerified below; reads
      // and account-recovery flows never check it.
      req.verified = !!row.email_verified_at;
      next();
    })
    .catch((e) => next(e));
}

// Email-verification guard for normal user functionality (messages,
// reactions, community management, social writes). Reads, auth flows,
// account maintenance, safety flows (reports/appeals) and platform admin
// routes intentionally do NOT use this. See each router for its list.
//
// Verification is only enforceable when the instance can actually deliver a
// verification email. With mail disabled there is no way for anyone to confirm an
// address, so gating on it would lock messaging off permanently on self-hosted
// instances that never configure mail. In that case the guard is a no-op and
// clients should not prompt for verification either.
//
// Both delivering modes count: a relay and an HTTP endpoint can both deliver, so
// asking "is it smtp" would refuse email verification on an instance configured
// with an API and able to send perfectly well.
function verificationEnforceable() {
  try {
    return require('../services/mail').mode() !== 'disabled';
  } catch (e) {
    return false;
  }
}

function requireVerified(req, res, next) {
  if (!verificationEnforceable()) return next();
  if (req.verified) return next();
  return fail(res, 'EMAIL_NOT_VERIFIED', 'verify your email to use this', 403);
}

module.exports = auth;
module.exports.tokenStale = tokenStale;
module.exports.enforced = enforced;
module.exports.requireVerified = requireVerified;
module.exports.verificationEnforceable = verificationEnforceable;
