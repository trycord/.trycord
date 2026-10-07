const sessions = require('../../services/sessions');
const auth = require('../../middleware/auth');
const { now, uuid, sign, signWithJti, secret } = require('../../util');

// The response every successful sign-in returns.
// 
// Every token this API mints is also a row in user_sessions, so the Security page
// can name the devices and revoke one without revoking all. Recording is
// best-effort by design: failing to note a session must not stop someone signing
// in, and the token's own signature is still what authenticates them.

// Every token this file mints is also a row in user_sessions, so the Security
// page can name the devices and revoke one without revoking all. Recording is
// best-effort by design: failing to note a session must not stop someone
// signing in, and the token's own signature is still what authenticates them.
function issued(res, user, req, extra) {
  const { token, jti } = signWithJti(user);
  Promise.resolve()
    .then(() => sessions.recordSession({
      jti,
      userId: user.id,
      userAgent: req.get('user-agent'),
      ip: req.ip,
    }))
    .catch((e) => { console.error('[auth] session record failed', e && e.message); });
  return res.json(Object.assign({
    token,
    user: {
      id: user.id, username: user.username,
      displayName: user.display_name, createdAt: user.created_at,
    },
  }, extra || {}));
}
