// /api/servers/:serverId/roles — role CRUD + assignment (MANAGE_ROLES, except list).
const express = require('express');
const auth = require('../middleware/auth');
const { resolveServer, requireMember, requirePerm } = require('../middleware/serverAccess');
const { fail, serviceError } = require('../errors');
const roles = require('../services/roles');
const memberships = require('../services/memberships');
const { PERMISSIONS } = require('../services/permissions');

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
    const { name, permissions } = req.body || {};
    res.json(await roles.create(req.server.id, { name, permissions }));
  } catch (e) { serviceError(res, e); }
});

router.patch('/:roleId', requirePerm('MANAGE_ROLES'), async (req, res, next) => {
  try {
    const role = await roles.get(req.params.roleId);
    if (!role || role.server_id !== req.server.id) return fail(res, 'NOT_FOUND', 'role not found');
    const { name, permissions } = req.body || {};
    res.json(await roles.update(role, { name, permissions }));
  } catch (e) { serviceError(res, e); }
});

router.delete('/:roleId', requirePerm('MANAGE_ROLES'), async (req, res, next) => {
  try {
    const role = await roles.get(req.params.roleId);
    if (!role || role.server_id !== req.server.id) return fail(res, 'NOT_FOUND', 'role not found');
    res.json(await roles.remove(role));
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
    res.json(await roles.assign(req.server.id, userId, role.id));
  } catch (e) { next(e); }
});

router.delete('/:roleId/assign/:userId', requirePerm('MANAGE_ROLES'), async (req, res, next) => {
  try {
    const role = await roles.get(req.params.roleId);
    if (!role || role.server_id !== req.server.id) return fail(res, 'NOT_FOUND', 'role not found');
    res.json(await roles.unassign(req.server.id, req.params.userId, role.id));
  } catch (e) { next(e); }
});

module.exports = router;
