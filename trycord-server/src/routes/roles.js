// /api/servers/:serverId/roles — role CRUD + assignment (MANAGE_ROLES, except list).
const express = require('express');
const auth = require('../middleware/auth');
const { resolveServer, requireMember, requirePerm } = require('../middleware/serverAccess');
const { fail, serviceError } = require('../errors');
const roles = require('../services/roles');
const memberships = require('../services/memberships');
const events = require('../services/events');
const { PERMISSIONS, effectivePermissions } = require('../services/permissions');

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
  res.json({
    is_owner: req.access.isOwner,
    permissions: req.access.permissions,
    all: Object.keys(PERMISSIONS),
    // The human-readable text lives here, with the permission that it describes,
    // so the client's grouped editor can label the toggles without keeping a
    // second copy of these strings that could drift out of sync.
    descriptions: PERMISSIONS,
  });
});

// The role list is the one place a client needs both "what roles exist" and
// "which of them do I already have" - the self-assign picker is useless
// without the second half, and making it a separate call would be a round trip
// on every surface that shows a role list. Annotation is strictly about the
// caller: per-member roles still come from the roster endpoint.
router.get('/', requireMember, async (req, res, next) => {
  try {
    const list = await roles.list(req.server.id);
    const mine = new Set((await roles.userRoles(req.user.id, req.server.id)).map((r) => String(r.id)));
    res.json(list.map((r) => ({ ...r, selfAssigned: mine.has(String(r.id)) })));
  } catch (e) { next(e); }
});

router.post('/', auth.requireVerified, requirePerm('MANAGE_ROLES'), async (req, res, next) => {
  try {
    const { name, permissions, color, selfAssign } = req.body || {};
    const role = await roles.create(req.server.id, { name, permissions, color, selfAssign });
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
    const { name, permissions, color, selfAssign } = req.body || {};
    const updated = await roles.update(role, { name, permissions, color, selfAssign });
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

// Self-assignable roles. Deliberately NOT gated on MANAGE_ROLES - that is the
// entire point, a plain member needs to be able to pick up a colour or a
// notification role for themselves. Only the caller's own membership row is
// ever touched; there is no userId in the request and none is read from the
// body, so this cannot be pointed at somebody else.
router.post('/:roleId/self', requireMember, async (req, res, next) => {
  try {
    const role = await roles.get(req.params.roleId);
    if (!role || role.server_id !== req.server.id) return fail(res, 'NOT_FOUND', 'role not found');
    if (!role.self_assign) {
      return fail(res, 'PERMISSION_DENIED', 'that role is not available for self-assignment');
    }

    const already = await roles.userHasRole(req.server.id, req.user.id, role.id);
    // Explicit when the caller sends one, otherwise toggle. The client sends
    // the target state so a retry cannot flip a role the other way.
    const want = (req.body && req.body.on !== undefined) ? !!req.body.on : !already;

    if (want && !already) {
      // Turning a role ON is the only direction that can ever grant access, so
      // that is the only direction that needs checking. A self-assignable
      // role must not carry a permission the member does not already hold
      // through their own roles: otherwise one misconfigured flag hands every
      // member on the server an escalation, and "self-assign" quietly becomes
      // "self-promote". Colour/notification roles grant nothing and are
      // unaffected. effectivePermissions returns a Set, and the literal Set
      // ['*'] for the owner, which already holds everything.
      const held = await effectivePermissions(req.user.id, req.server.id);
      const gained = held.has('*') ? [] : (role.permissions || []).filter((p) => !held.has(p));
      if (gained.length) {
        return fail(res, 'PERMISSION_DENIED', 'that role grants permissions you do not have',
          undefined, { detail: { permissions: gained } });
      }
    }

    if (want) await roles.assign(req.server.id, req.user.id, role.id);
    else await roles.unassign(req.server.id, req.user.id, role.id);

    events.emit(req.server.id, 'member_roles_updated', { userId: String(req.user.id) });
    res.json({ ok: true, roleId: String(role.id), on: want });
  } catch (e) { serviceError(res, e); }
});

module.exports = router;
