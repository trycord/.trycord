const auth = require('../../middleware/auth');
const { now, uuid, sign, signWithJti, secret } = require('../../util');
const jwt = require('jsonwebtoken');

// The MFA challenge token.
// 
// A challenge is not a session. It is a short-lived, single-audience token that
// proves "this password was correct" and nothing else: the auth middleware
// rejects it, and it carries no username or permissions. Its only power is to
// let /2fa/verify mint a real session, and only while a second factor is still
// outstanding. Five minutes is long enough to find an authenticator and short
// enough that a challenge left in a log or a proxy buffer is not useful later.

// A challenge is not a session. It is a short-lived, single-audience token that
// proves "this password was correct" and nothing else: the auth middleware
// rejects it, and it carries no username or permissions. Its only power is to
// let /2fa/verify mint a real session, and only while a second factor is still
// outstanding. 5 minutes is long enough to find an authenticator and short
// enough that a challenge left in a log or a proxy buffer is not useful later.
const CHALLENGE_TTL_SECONDS = 300;

function signChallenge(userId) {
  return jwt.sign({ sub: userId, jti: uuid(), purpose: 'mfa' }, secret(), { expiresIn: CHALLENGE_TTL_SECONDS });
}

function readChallenge(token) {
  try {
    const claims = jwt.verify(token, secret());
    return claims && claims.purpose === 'mfa' && claims.sub ? String(claims.sub) : null;
  } catch {
    return null;
  }
}
