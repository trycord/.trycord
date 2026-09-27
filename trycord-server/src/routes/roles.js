// /api/servers/:serverId/roles — role CRUD + assignment (MANAGE_ROLES, except list).
const express = require('express');
const auth = require('../middleware/auth');
const { resolveServer, requireMember, requirePerm } = require('../middleware/serverAccess');
const { fail, serviceError } = require('../errors');
const roles = require('../services/roles');
const memberships = require('../services/memberships');
const events = require('../services/events');
const { PERMISSIONS } = require('../services/permissions');

// Role hierarchy: you may only act on roles ranked strictly below your own
// top role (the owner bypasses). The service owns persistence; the server
// owns this authorization.
//
// This guard must be applied to EVERY mutation that targets an existing
// role - edit, delete and reorder included. Gating only on MANAGE_ROLES
// leaves a real escalation: a Moderator (position 2) who cannot grant
// Admin (position 3) could still blank Admin's permission array, recolour
// or rename it, reorder it to the bottom, or delete it outright. "You may
// not give this away" has to mean "you may not hand it out, reshape it, or
// remove it" - otherwise the hierarchy is decorative.
async function assertAssignable(req, role) {
  if (req.access && req.access.isOwner) return;
  const top = await roles.topPosition(req.server.id, req.user.id);
  if (top <= role.position) {
    throw { code: 'PERMISSION_DENIED', message: 'you can only manage roles below your own' };
  }
}

// Reorder rewrites the position of the whole role set, so every role it
// touches must clear the same bar as a single-role edit.
async function assertCanReorderAll(req, list) {
  if (req.access && req.access.isOwner) return;
  const top = await roles.topPosition(req.server.id, req.user.id);
  const blocked = list.filter((r) => top <= r.position);
  if (blocked.length) {
    throw {
      code: 'PERMISSION_DENIED',
      message: 'you can only reorder roles below your own',
      detail: { blocked: blocked.map((r) => r.name) },
    };
  }
}

const router = express.Router({ mergeParams: true });
router.use(auth, resolveServer);

router.get('/permissions', requireMember, (req, res) => {
  res.json({ is_owner: req.access.isOwner, permissions: req.access.permissions, all: Object.keys(PERMISSIONS) });
});

router.get('/', requireMember, async (req, res, next) => {
  try {
    res.json(await roles.list(req.server.id));
  } catch (e) { next(e); }
});

router.post('/', auth.requireVerified, requirePerm('MANAGE_ROLES'), async (req, res, next) => {
  try {
    const { name, permissions, color } = req.body || {};
    const role = await roles.create(req.server.id, { name, permissions, color });
    events.emit(req.server.id, 'role_created', { role });
    res.json(role);
  } catch (e) { serviceError(res, e); }
});

router.patch('/:roleId', auth.requireVerified, requirePerm('MANAGE_ROLES'), async (req, res, next) => {
  try {
    const role = await roles.get(req.params.roleId);
    if (!role || role.server_id !== req.server.id) return fail(res, 'NOT_FOUND', 'role not found');
    try {
      await assertAssignable(req, role);
    } catch (e) { return serviceError(res, e); }
    const { name, permissions, color } = req.body || {};
    const updated = await roles.update(role, { name, permissions, color });
    events.emit(req.server.id, 'role_updated', { role: updated });
    res.json(updated);
  } catch (e) { serviceError(res, e); }
});

// Atomic hierarchy reorder. MANAGE_ROLES gates the endpoint, the service
// validates the id set, and the hierarchy guard keeps the actor from
// reshuffling roles at or above their own rank. Reordering never changes
// anyone's membership.
router.post('/reorder', auth.requireVerified, requirePerm('MANAGE_ROLES'), async (req, res, next) => {
  try {
    const { orderedIds } = req.body || {};
    const existing = await roles.list(req.server.id);
    try {
      await assertCanReorderAll(req, existing);
    } catch (e) { return serviceError(res, e); }
    const list = await roles.reorder(req.server.id, orderedIds);
    events.emit(req.server.id, 'roles_reordered', { roles: list.map((r) => r.id) });
    res.json(list);
  } catch (e) { serviceError(res, e); }
});

router.delete('/:roleId', auth.requireVerified, requirePerm('MANAGE_ROLES'), async (req, res, next) => {
  try {
    const role = await roles.get(req.params.roleId);
    if (!role || role.server_id !== req.server.id) return fail(res, 'NOT_FOUND', 'role not found');
    try {
      await assertAssignable(req, role);
    } catch (e) { return serviceError(res, e); }
    const out = await roles.remove(role);
    events.emit(req.server.id, 'role_deleted', { roleId: String(role.id) });
    res.json(out);
  } catch (e) { serviceError(res, e); }
});

router.post('/:roleId/assign', auth.requireVerified, requirePerm('MANAGE_ROLES'), async (req, res, next) => {
  try {
    const role = await roles.get(req.params.roleId);
    if (!role || role.server_id !== req.server.id) return fail(res, 'NOT_FOUND', 'role not found');
    const { userId } = req.body || {};
    if (!userId || !(await memberships.get(req.server.id, userId))) {
      return fail(res, 'NOT_A_MEMBER', 'user is not a member');
    }
    try {
      await assertAssignable(req, role);
    } catch (e) { return serviceError(res, e); }
    const out = await roles.assign(req.server.id, userId, role.id);
    events.emit(req.server.id, 'member_roles_updated', { userId: String(userId) });
    res.json(out);
  } catch (e) { next(e); }
});

router.delete('/:roleId/assign/:userId', auth.requireVerified, requirePerm('MANAGE_ROLES'), async (req, res, next) => {
  try {
    const role = await roles.get(req.params.roleId);
    if (!role || role.server_id !== req.server.id) return fail(res, 'NOT_FOUND', 'role not found');
    try {
      await assertAssignable(req, role);
    } catch (e) { return serviceError(res, e); }
    const out = await roles.unassign(req.server.id, req.params.userId, role.id);
    events.emit(req.server.id, 'member_roles_updated', { userId: String(req.params.userId) });
    res.json(out);
  } catch (e) { next(e); }
});

module.exports = router;
