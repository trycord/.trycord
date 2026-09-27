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
const events = require('../services/events');
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
router.post('/', auth.requireVerified, rateLimit({ windowMs: 60000, max: 10 }), async (req, res, next) => {
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
router.post('/join/:code', auth.requireVerified, async (req, res, next) => {
  try {
    const out = await memberships.joinByCode(req.params.code, req.user);
    if (out && out.serverId) events.emit(out.serverId, 'member_joined', { userId: String(req.user.id) });
    res.json(out);
  } catch (e) { serviceError(res, e); }
});

router.get('/:id', resolveServer, requireMember, async (req, res, next) => {
  try {
    // req.access already holds this request's computed permission set.
    res.json(await servers.detail(req.server.id, req.user.id, req.access && req.access.permissions));
  } catch (e) { next(e); }
});

router.patch('/:id', resolveServer, auth.requireVerified, requirePerm('MANAGE_SERVER'), async (req, res, next) => {
  try {
    const { name, description, isPublic, isDiscoverable } = req.body || {};
    await servers.update(req.server.id, { name, description, isPublic, isDiscoverable });
    const detail = await servers.detail(req.server.id, req.user.id, req.access && req.access.permissions);
    events.emit(req.server.id, 'server_updated', { server: { id: detail.id, name: detail.name } });
    res.json(detail);
  } catch (e) { serviceError(res, e); }
});

router.delete('/:id', resolveServer, auth.requireVerified, requireOwner, async (req, res, next) => {
  try {
    res.json(await servers.remove(req.server.id));
  } catch (e) { next(e); }
});

router.get('/:id/members', resolveServer, requireMember, async (req, res, next) => {
  try {
    // Paged. This previously returned the entire roster for any member of
    // the community with no LIMIT anywhere, and the paired role query read
    // every role assignment in the community regardless. Both are now bounded
    // and the role lookup is scoped to the page returned.
    //
    // The default is generous because the web client still derives member
    // counts and role membership from the whole roster. A community larger
    // than this will show a truncated list until the client moves to paged
    // rendering with server-computed aggregates.
    const hasPaging = req.query.limit !== undefined || req.query.offset !== undefined || req.query.q !== undefined;
    res.json(await memberships.list(req.server.id, {
      limit: hasPaging ? (req.query.limit === undefined ? 50 : req.query.limit) : 500,
      offset: req.query.offset,
      search: req.query.q,
    }));
  } catch (e) { next(e); }
});

router.post('/:id/leave', resolveServer, async (req, res, next) => {
  try {
    res.json(await memberships.leave(req.server.id, req.user.id));
  } catch (e) { serviceError(res, e); }
});

// Ownership transfer. requireOwner is the authorisation gate, and the service
// re-checks it inside the transaction rather than trusting middleware.
router.post('/:id/transfer', resolveServer, auth.requireVerified, requireOwner, async (req, res, next) => {
  try {
    const { userId } = req.body || {};
    res.json(await servers.transferOwnership(req.server.id, req.user.id, userId));
  } catch (e) { serviceError(res, e); }
});

router.post('/:id/kick', resolveServer, auth.requireVerified, requirePerm('KICK_MEMBERS'), async (req, res, next) => {
  try {
    const { userId } = req.body || {};
    if (!userId) return fail(res, 'VALIDATION_ERROR', 'userId required');
    res.json(await memberships.kick(req.server.id, req.user.id, userId));
  } catch (e) { serviceError(res, e); }
});

// Ban: persistent per-server ban (member removed now, rejoin blocked until
// lifted/expired). Hierarchy is enforced in the service; BAN_MEMBERS gates.
router.post('/:id/ban', resolveServer, auth.requireVerified, requirePerm('BAN_MEMBERS'), async (req, res, next) => {
  try {
    const { userId, reason, minutes } = req.body || {};
    if (!userId) return fail(res, 'VALIDATION_ERROR', 'userId required');
    res.json(await memberships.ban(req.server.id, req.user.id, userId, { reason, minutes }));
  } catch (e) { serviceError(res, e); }
});

router.post('/:id/unban', resolveServer, auth.requireVerified, requirePerm('BAN_MEMBERS'), async (req, res, next) => {
  try {
    const { userId } = req.body || {};
    if (!userId) return fail(res, 'VALIDATION_ERROR', 'userId required');
    res.json(await memberships.unban(req.server.id, userId));
  } catch (e) { serviceError(res, e); }
});

router.get('/:id/bans', resolveServer, requirePerm('BAN_MEMBERS'), async (req, res, next) => {
  try {
    res.json(await memberships.listBans(req.server.id));
  } catch (e) { next(e); }
});

// Timeout: member stays but cannot post until it lapses. minutes null/0
// clears. Enforced on every message send, server-side.
router.post('/:id/timeout', resolveServer, auth.requireVerified, requirePerm('BAN_MEMBERS'), async (req, res, next) => {
  try {
    const { userId, minutes } = req.body || {};
    if (!userId) return fail(res, 'VALIDATION_ERROR', 'userId required');
    res.json(await memberships.timeout(req.server.id, req.user.id, userId, minutes));
  } catch (e) { serviceError(res, e); }
});

// Set/clear a member nickname. Anyone may set their own; staff (KICK_MEMBERS)
// may set any member's. resolver + memberships gate membership itself.
router.patch('/:id/members/:userId/nickname', resolveServer, auth.requireVerified, requireMember, async (req, res, next) => {
  try {
    const targetId = req.params.userId;
    const mine = String(targetId) === String(req.user.id);
    if (!mine) {
      const perms = await permissions.effectivePermissions(req.user.id, req.server.id);
      if (!perms.has('*') && !perms.has('KICK_MEMBERS')) {
        return fail(res, 'PERMISSION_DENIED', 'you can only change your own nickname here');
      }
    }
    const out = await memberships.setNickname(req.server.id, targetId, (req.body || {}).nickname);
    events.emit(req.server.id, 'member_updated', { userId: String(targetId) });
    res.json(out);
  } catch (e) { serviceError(res, e); }
});

module.exports = router;
