const sessions = require('../../services/sessions');
const { signWithJti } = require('../../util');

// The response every successful sign-in returns.
//
// Every token this mints is also a row in user_sessions, so the Security page can name
// the devices and revoke one without revoking all. Recording is best-effort by design:
// failing to note a session must not stop someone signing in, and the token's own
// signature is still what authenticates them.
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
  const payload = {
    token,
    user: {
      id: user.id, username: user.username,
      displayName: user.display_name, createdAt: user.created_at,
    },
  };
  // A caller that knows more about the account than the row does - an address
  // that was just given, whether it has been verified - says so here. The extra
  // fields merge into the user object rather than replacing it, so a caller
  // cannot accidentally drop the identity fields by passing one of its own.
  if (extra && extra.user) Object.assign(payload.user, extra.user);
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (key !== 'user') payload[key] = value;
    }
  }
  return res.json(payload);
}

module.exports = { issued };