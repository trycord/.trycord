// Platform-administration gate. Mount after auth. Membership in the admins
// table is the single server-side source of truth; there is no client-side
// isAdmin flag that could be tampered with. Returns a fixed generic message
// so the gate does not double as an admin-name oracle.
const auth = require('./auth');
const { fail } = require('../errors');
const enforcement = require('../services/enforcement');

function adminGuard(req, res, next) {
  auth(req, res, () => {
    const userId = req.user && req.user.id;
    if (!userId) return fail(res, 'AUTH_REQUIRED', 'authentication required');
    enforcement.isPlatformAdmin(userId)
      .then((is) => {
        if (!is) return fail(res, 'PERMISSION_DENIED', 'forbidden');
        next();
      })
      .catch(next);
  });
}

module.exports = adminGuard;