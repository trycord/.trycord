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

function resolveServer(req, res, next) {
  const id = serverIdOf(req);
  const srv = db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
  if (!srv) return fail(res, 'SERVER_NOT_FOUND', 'server not found');
  req.server = srv;
  next();
}

function requireMember(req, res, next) {
  if (!req.server) return fail(res, 'SERVER_NOT_FOUND', 'server not found');
  if (!isMember(req.user.id, req.server.id)) {
    return fail(res, 'NOT_A_MEMBER', 'you are not a member of this server');
  }
  const isOwner = req.server.owner_id === req.user.id;
  req.access = { isOwner, permissions: [...effectivePermissions(req.user.id, req.server.id)] };
  next();
}

function requireOwner(req, res, next) {
  if (!req.server) return fail(res, 'SERVER_NOT_FOUND', 'server not found');
  if (req.server.owner_id !== req.user.id) {
    return fail(res, 'PERMISSION_DENIED', 'only the server owner can do this');
  }
  req.access = { isOwner: true, permissions: ['*'] };
  next();
}

function requirePerm(perm) {
  return (req, res, next) => {
    if (!req.server) return fail(res, 'SERVER_NOT_FOUND', 'server not found');
    if (req.server.owner_id === req.user.id) {
      req.access = { isOwner: true, permissions: ['*'] };
      return next();
    }
    if (!isMember(req.user.id, req.server.id)) {
      return fail(res, 'NOT_A_MEMBER', 'you are not a member of this server');
    }
    if (!hasPermission(req.user.id, req.server.id, perm)) {
      return fail(res, 'PERMISSION_DENIED', `requires ${perm} permission`);
    }
    req.access = { isOwner: false, permissions: [...effectivePermissions(req.user.id, req.server.id)] };
    next();
  };
}

module.exports = { resolveServer, requireMember, requireOwner, requirePerm, getOwnerId };
