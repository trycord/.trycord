// Platform-administration gate. Mount after auth. The admins table is the one
// server-side source of truth; the role on that row decides which console
// surfaces are reachable. There is no client-side isAdmin flag that could be
// tampered with.
//
// `adminGuard` itself requires the wildcard platform administrator role, so
// existing operator routes (settings, database, mail, extensions) keep the
// authority they always needed. Trust & Safety routes mount `adminGuard.any`
// and each declare the permission it needs.
const auth = require('./auth');
const { fail } = require('../errors');
const platformRoles = require('../services/platformRoles');

function gate(req, res, next, permission) {
  auth(req, res, async () => {
    try {
      const userId = req.user && req.user.id;
      if (!userId) return fail(res, 'AUTH_REQUIRED', 'authentication required');
      const admin = await platformRoles.get(userId);
      if (!admin) return fail(res, 'PERMISSION_DENIED', 'forbidden');
      req.admin = admin;
      if (permission && !platformRoles.allows(admin, permission)) {
        return fail(res, 'PERMISSION_DENIED', 'forbidden');
      }
      next();
    } catch (e) { next(e); }
  });
}

function adminGuard(req, res, next) {
  gate(req, res, next, 'platform.admin');
}

// Any platform role. Only Trust & Safety routers should use this, and every
// route under it still names its own permission.
adminGuard.any = (req, res, next) => gate(req, res, next, null);

adminGuard.permission = (permission) => (req, res, next) => gate(req, res, next, permission);

module.exports = adminGuard;
