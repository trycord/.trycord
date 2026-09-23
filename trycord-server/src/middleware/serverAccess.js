// Centralized server access chain:
//   authenticate -> resolveServer -> requireMember -> requirePerm(perm)
// Routes declare the level they need; the frontend never decides.
const db = require('../db');
const { fail } = require('../errors');
const { isMember } = require('../util');
const { getOwnerId, effectivePermissionsFor } = require('../services/permissions');
const { isPlatformAdmin } = require('../services/enforcement');

function serverIdOf(req) {
  return req.params.serverId || req.params.id || null;
}

async function resolveServer(req, res, next) {
  try {
    const srv = await db.get('SELECT * FROM servers WHERE id = ?', [serverIdOf(req)]);
    if (!srv) return fail(res, 'SERVER_NOT_FOUND', 'server not found');
    // Trust & Safety: suspended servers are out of reach for everyone except
    // the owner (still needs a maintenance access path) and platform admins
    // (who may need to inspect before lifting). Everything else gets 403.
    if (srv.enforcement_state === 'suspended' && !(req.user && (req.user.id === srv.owner_id || (await isPlatformAdmin(req.user.id))))) {
      return fail(res, 'SERVER_SUSPENDED', 'server is suspended', 403, { suspended: true });
    }
    req.server = srv;
    next();
  } catch (e) { next(e); }
}

async function requireMember(req, res, next) {
  try {
    if (!req.server) return fail(res, 'SERVER_NOT_FOUND', 'server not found');
    if (!(await isMember(req.user.id, req.server.id))) {
      return fail(res, 'NOT_A_MEMBER', 'you are not a member of this server');
    }
    // Owner is known from the resolved row — no extra owner lookup, and
    // the role set is computed exactly once per request.
    const isOwner = req.server.owner_id === req.user.id;
    req.access = { isOwner, permissions: [...(await effectivePermissionsFor(req.server.owner_id, req.user.id, req.server.id))] };
    next();
  } catch (e) { next(e); }
}

async function requireOwner(req, res, next) {
  if (!req.server) return fail(res, 'SERVER_NOT_FOUND', 'server not found');
  if (req.server.owner_id !== req.user.id) {
    return fail(res, 'PERMISSION_DENIED', 'only the server owner can do this');
  }
  req.access = { isOwner: true, permissions: ['*'] };
  next();
}

function requirePerm(perm) {
  return async (req, res, next) => {
    try {
      if (!req.server) return fail(res, 'SERVER_NOT_FOUND', 'server not found');
      if (req.server.owner_id === req.user.id) {
        req.access = { isOwner: true, permissions: ['*'] };
        return next();
      }
      if (!(await isMember(req.user.id, req.server.id))) {
        return fail(res, 'NOT_A_MEMBER', 'you are not a member of this server');
      }
      // One role-set computation serves both the gate and req.access —
      // previously hasPermission() and effectivePermissions() each
      // rebuilt it (plus a redundant owner lookup).
      const perms = await effectivePermissionsFor(req.server.owner_id, req.user.id, req.server.id);
      if (!(perms.has('*') || perms.has(perm))) {
        return fail(res, 'PERMISSION_DENIED', `requires ${perm} permission`);
      }
      req.access = { isOwner: false, permissions: [...perms] };
      next();
    } catch (e) { next(e); }
  };
}

module.exports = { resolveServer, requireMember, requireOwner, requirePerm, getOwnerId };
