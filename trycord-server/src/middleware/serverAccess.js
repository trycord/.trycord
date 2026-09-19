// Centralized server access chain:
//   authenticate -> resolveServer -> requireMember -> requirePerm(perm)
// Routes declare the level they need; the frontend never decides.
const db = require('../db');
const { fail } = require('../errors');
const { isMember } = require('../util');
const { getOwnerId, effectivePermissions, hasPermission } = require('../services/permissions');

function serverIdOf(req) {
  return req.params.serverId || req.params.id || null;
}

async function resolveServer(req, res, next) {
  try {
    const srv = await db.get('SELECT * FROM servers WHERE id = ?', [serverIdOf(req)]);
    if (!srv) return fail(res, 'SERVER_NOT_FOUND', 'server not found');
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
    const isOwner = req.server.owner_id === req.user.id;
    req.access = { isOwner, permissions: [...(await effectivePermissions(req.user.id, req.server.id))] };
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
      if (!(await hasPermission(req.user.id, req.server.id, perm))) {
        return fail(res, 'PERMISSION_DENIED', `requires ${perm} permission`);
      }
      req.access = { isOwner: false, permissions: [...(await effectivePermissions(req.user.id, req.server.id))] };
      next();
    } catch (e) { next(e); }
  };
}

module.exports = { resolveServer, requireMember, requireOwner, requirePerm, getOwnerId };
