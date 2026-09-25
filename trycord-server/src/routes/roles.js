// /api/servers/:serverId/roles — role CRUD + assignment (MANAGE_ROLES, except list).
const express = require('express');
const auth = require('../middleware/auth');
const { resolveServer, requireMember, requirePerm } = require('../middleware/serverAccess');
const { fail, serviceError } = require('../errors');
const roles = require('../services/roles');
const memberships = require('../services/memberships');
const events = require('../services/events');
const { PERMISSIONS } = require('../services/permissions');

// Role hierarchy for assignment: you may only grant/revoke roles ranked
// strictly below your own top role (the owner bypasses). The service owns
// persistence; the server owns this authorization.
async function assertAssignable(req, role) {
  if (req.access && req.access.isOwner) return;
  const top = await roles.topPosition(req.server.id, req.user.id);
  if (top <= role.position) {
    throw { code: 'PERMISSION_DENIED', message: 'you can only manage roles below your own' };
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

router.post('/', requirePerm('MANAGE_ROLES'), async (req, res, next) => {
  try {
    const { name, permissions, color } = req.body || {};
    const role = await roles.create(req.server.id, { name, permissions, color });
    events.emit(req.server.id, 'role_created', { role });
    res.json(role);
  } catch (e) { serviceError(res, e); }
});

router.patch('/:roleId', requirePerm('MANAGE_ROLES'), async (req, res, next) => {
  try {
    const role = await roles.get(req.params.roleId);
    if (!role || role.server_id !== req.server.id) return fail(res, 'NOT_FOUND', 'role not found');
    const { name, permissions, color } = req.body || {};
    const updated = await roles.update(role, { name, permissions, color });
    events.emit(req.server.id, 'role_updated', { role: updated });
    res.json(updated);
  } catch (e) { serviceError(res, e); }
});

// Atomic hierarchy reorder. MANAGE_ROLES gates the endpoint; the service
// validates the id set. Reordering never changes anyone's membership.
router.post('/reorder', requirePerm('MANAGE_ROLES'), async (req, res, next) => {
  try {
    const { orderedIds } = req.body || {};
    const list = await roles.reorder(req.server.id, orderedIds);
    events.emit(req.server.id, 'roles_reordered', { roles: list.map((r) => r.id) });
    res.json(list);
  } catch (e) { serviceError(res, e); }
});

router.delete('/:roleId', requirePerm('MANAGE_ROLES'), async (req, res, next) => {
  try {
    const role = await roles.get(req.params.roleId);
    if (!role || role.server_id !== req.server.id) return fail(res, 'NOT_FOUND', 'role not found');
    const out = await roles.remove(role);
    events.emit(req.server.id, 'role_deleted', { roleId: String(role.id) });
    res.json(out);
  } catch (e) { serviceError(res, e); }
});

router.post('/:roleId/assign', requirePerm('MANAGE_ROLES'), async (req, res, next) => {
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

router.delete('/:roleId/assign/:userId', requirePerm('MANAGE_ROLES'), async (req, res, next) => {
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
