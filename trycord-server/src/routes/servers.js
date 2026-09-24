// /api/servers — thin controllers over the membership/server services.
// Access chain: auth -> resolveServer -> requireMember / requirePerm / requireOwner.
const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');
const rateLimit = require('../middleware/ratelimit');
const { resolveServer, requireMember, requireOwner, requirePerm } = require('../middleware/serverAccess');
const { fail, serviceError } = require('../errors');
const servers = require('../services/servers');
const memberships = require('../services/memberships');
const permissions = require('../services/permissions');

const router = express.Router();
router.use(auth);

router.get('/', async (req, res, next) => {
  try {
    res.json(await servers.mine(req.user.id));
  } catch (e) { next(e); }
});

// Server creation is write-heavy (server + membership + roles + category +
// channel in one transaction); cap it so a burst cannot hammer the DB.
router.post('/', rateLimit({ windowMs: 60000, max: 10 }), async (req, res, next) => {
  try {
    const { name, description, joinCode, isPublic, isDiscoverable } = req.body || {};
    res.json(await servers.create({ name, description, joinCode, isPublic, isDiscoverable }, req.user));
  } catch (e) { serviceError(res, e); }
});

// Safe pre-join preview for code holders (subset only — no members, messages, or settings).
router.get('/by-code/:code', async (req, res, next) => {
  try {
    const srv = await db.get(
      `SELECT s.id, s.name, s.description, s.is_public, s.is_discoverable, s.created_at,
        (SELECT COUNT(*) FROM server_members m WHERE m.server_id = s.id) AS member_count
      FROM servers s WHERE s.join_code = ?`,
      [String(req.params.code).toLowerCase().trim()]
    );
    if (!srv) return fail(res, 'SERVER_NOT_FOUND', 'server not found');
    res.json(srv);
  } catch (e) { next(e); }
});

// Legacy permanent-code join (kept for back-compat; invites are the real system).
router.post('/join/:code', async (req, res, next) => {
  try {
    res.json(await memberships.joinByCode(req.params.code, req.user));
  } catch (e) { serviceError(res, e); }
});

router.get('/:id', resolveServer, requireMember, async (req, res, next) => {
  try {
    // req.access already holds this request's computed permission set.
    res.json(await servers.detail(req.server.id, req.user.id, req.access && req.access.permissions));
  } catch (e) { next(e); }
});

router.patch('/:id', resolveServer, requirePerm('MANAGE_SERVER'), async (req, res, next) => {
  try {
    const { name, description, isPublic, isDiscoverable } = req.body || {};
    await servers.update(req.server.id, { name, description, isPublic, isDiscoverable });
    res.json(await servers.detail(req.server.id, req.user.id, req.access && req.access.permissions));
  } catch (e) { serviceError(res, e); }
});

router.delete('/:id', resolveServer, requireOwner, async (req, res, next) => {
  try {
    res.json(await servers.remove(req.server.id));
  } catch (e) { next(e); }
});

router.get('/:id/members', resolveServer, requireMember, async (req, res, next) => {
  try {
    res.json(await memberships.list(req.server.id));
  } catch (e) { next(e); }
});

router.post('/:id/leave', resolveServer, async (req, res, next) => {
  try {
    res.json(await memberships.leave(req.server.id, req.user.id));
  } catch (e) { serviceError(res, e); }
});

router.post('/:id/kick', resolveServer, requirePerm('KICK_MEMBERS'), async (req, res, next) => {
  try {
    const { userId } = req.body || {};
    if (!userId) return fail(res, 'VALIDATION_ERROR', 'userId required');
    res.json(await memberships.kick(req.server.id, req.user.id, userId));
  } catch (e) { serviceError(res, e); }
});

// Set/clear a member nickname. Anyone may set their own; staff (KICK_MEMBERS)
// may set any member's. resolver + memberships gate membership itself.
router.patch('/:id/members/:userId/nickname', resolveServer, requireMember, async (req, res, next) => {
  try {
    const targetId = req.params.userId;
    const mine = String(targetId) === String(req.user.id);
    if (!mine) {
      const perms = await permissions.effectivePermissions(req.user.id, req.server.id);
      if (!perms.has('*') && !perms.has('KICK_MEMBERS')) {
        return fail(res, 'PERMISSION_DENIED', 'you can only change your own nickname here');
      }
    }
    res.json(await memberships.setNickname(req.server.id, targetId, (req.body || {}).nickname));
  } catch (e) { serviceError(res, e); }
});

module.exports = router;
