// Communities: create, read, update, delete, membership, roles, invites.

const express = require('express');
const { fail, wrap } = require('../errors');
const limit = require('../../middleware/ratelimit');
const { authenticate, requireVerified } = require('../../middleware/auth');
const permissions = require('../../services/permissions');
const servers = require('../../services/servers');
const memberships = require('../../services/moderation');
const { singleFile } = require('../../middleware/upload');
const media = require('../../services/media');

const router = express.Router();
router.use(authenticate);

// Rate limited on purpose: a join code is short, so an unthrottled endpoint is a working
// oracle for guessing one.
router.get('/by-code/:code', limit({ windowMs: 60000, max: 20 }), wrap(async (req, res) => {
  const db = require('../../db');
  const srv = await db.get(
    `SELECT s.id, s.name, s.description, s.is_public, s.is_discoverable, s.created_at,
       (SELECT COUNT(*) FROM server_members m WHERE m.server_id = s.id) AS member_count
     FROM servers s WHERE s.join_code = ?`,
    [String(req.params.code).toLowerCase().trim()]
  );
  if (!srv) return fail(res, 'SERVER_NOT_FOUND', 'community not found');
  res.json({
    id: srv.id, name: srv.name, description: srv.description || '',
    isPublic: !!srv.is_public, isDiscoverable: !!srv.is_discoverable,
    createdAt: srv.created_at, memberCount: Number(srv.member_count || 0),
  });
}));

router.post('/join/:code', requireVerified, limit({ windowMs: 60000, max: 20 }), wrap(async (req, res) => {
  const out = await servers.joinByCode(req.user.id, req.params.code);
  res.json(out);
}));

router.get('/', wrap(async (req, res) => {
  res.json(await servers.list(req.user.id));
}));

router.post('/', limit({ windowMs: 60000, max: 10 }), wrap(async (req, res) => {
  const { name, description, joinCode, isPublic, isDiscoverable } = req.body || {};
  if (!name || !String(name).trim()) return fail(res, 'VALIDATION_ERROR', 'a community needs a name');
  res.json(await servers.create({ name: String(name).trim(), description, joinCode, isPublic, isDiscoverable }, req.user));
}));

router.get('/:id', wrap(async (req, res) => {
  const out = await servers.detail(req.params.id, req.user.id);
  if (!out) return fail(res, 'SERVER_NOT_FOUND', 'community not found');
  res.json(out);
}));

router.patch('/:id', requireVerified, wrap(async (req, res) => {
  res.json(await servers.update(req.params.id, req.user.id, req.body || {}));
}));

router.delete('/:id', wrap(async (req, res) => {
  res.json(await servers.remove(req.params.id, req.user.id));
}));

router.get('/:id/members', wrap(async (req, res) => {
  res.json(await servers.members(req.params.id, req.user.id, req.query));
}));

router.post('/:id/members/:userId/kick', requireVerified, wrap(async (req, res) => {
  const perms = await permissions.serverPermissions(req.user.id, req.params.id);
  if (!permissions.can(perms, 'KICK_MEMBERS')) {
    return fail(res, 'PERMISSION_DENIED', 'you cannot remove members from this community');
  }
  const out = await require('../../services/memberships').kick(req.params.id, req.user.id, req.params.userId);
  res.json(out);
}));

router.post('/:id/members/:userId/timeout', requireVerified, wrap(async (req, res) => {
  const perms = await permissions.serverPermissions(req.user.id, req.params.id);
  if (!permissions.can(perms, 'BAN_MEMBERS')) {
    return fail(res, 'PERMISSION_DENIED', 'you cannot time out members in this community');
  }
  res.json(await require('../../services/memberships').timeout(req.params.id, req.user.id, req.params.userId, req.body && req.body.minutes));
}));

router.post('/:id/members/:userId/ban', requireVerified, wrap(async (req, res) => {
  const perms = await permissions.serverPermissions(req.user.id, req.params.id);
  if (!permissions.can(perms, 'BAN_MEMBERS')) {
    return fail(res, 'PERMISSION_DENIED', 'you cannot ban members in this community');
  }
  res.json(await require('../../services/memberships').ban(req.params.id, req.user.id, req.params.userId, req.body || {}));
}));

router.delete('/:id/bans/:userId', requireVerified, wrap(async (req, res) => {
  const perms = await permissions.serverPermissions(req.user.id, req.params.id);
  if (!permissions.can(perms, 'BAN_MEMBERS')) {
    return fail(res, 'PERMISSION_DENIED', 'you cannot unban members in this community');
  }
  res.json(await require('../../services/memberships').unban(req.params.id, req.params.userId));
}));

router.get('/:id/bans', wrap(async (req, res) => {
  const perms = await permissions.serverPermissions(req.user.id, req.params.id);
  if (!permissions.can(perms, 'BAN_MEMBERS')) {
    return fail(res, 'PERMISSION_DENIED', 'you cannot see the bans for this community');
  }
  res.json(await require('../../services/memberships').listBans(req.params.id));
}));

router.post('/:id/leave', requireVerified, wrap(async (req, res) => {
  res.json(await servers.leave(req.params.id, req.user.id));
}));

router.post('/:id/transfer', requireVerified, wrap(async (req, res) => {
  const { userId } = req.body || {};
  if (!userId) return fail(res, 'VALIDATION_ERROR', 'a user id is required');
  res.json(await servers.transferOwnership(req.params.id, req.user.id, userId));
}));

// Invites
router.get('/:id/invites', wrap(async (req, res) => {
  res.json(await servers.listInvites(req.params.id, req.user.id));
}));

router.post('/:id/invites', requireVerified, wrap(async (req, res) => {
  res.json(await servers.createInvite(req.params.id, req.user.id, req.body || {}));
}));

router.delete('/:id/invites/:inviteId', requireVerified, wrap(async (req, res) => {
  res.json(await servers.revokeInvite(req.params.id, req.params.inviteId, req.user.id));
}));

// Roles
router.get('/:id/roles', wrap(async (req, res) => {
  res.json(await require('../../services/roles').list(req.params.id, req.user.id));
}));

router.post('/:id/roles', requireVerified, wrap(async (req, res) => {
  res.json(await require('../../services/roles').create(req.params.id, req.user.id, req.body || {}));
}));

router.patch('/:id/roles/:roleId', requireVerified, wrap(async (req, res) => {
  res.json(await require('../../services/roles').update(req.params.id, req.params.roleId, req.user.id, req.body || {}));
}));

router.delete('/:id/roles/:roleId', requireVerified, wrap(async (req, res) => {
  res.json(await require('../../services/roles').remove(req.params.id, req.params.roleId, req.user.id));
}));

// Identity media: the icon and the banner are the same feature as an avatar, differing
// only in which table and which key builder they land in.
for (const kind of ['icon', 'banner']) {
  router.post('/:id/' + kind, requireVerified, singleFile, limit({ windowMs: 60000, max: 10 }), wrap(async (req, res) => {
    if (!req.file || !req.file.buffer) {
      return fail(res, 'VALIDATION_ERROR', 'send the image as a multipart field named "file"');
    }
    const stored = await media.storeCommunity(req.params.id, kind, req.file.buffer, req.file.originalname, req.user.id);
    if (stored.error) return fail(res, stored.error, stored.message);
    res.status(201).json(stored);
  }));

  router.delete('/:id/' + kind, requireVerified, wrap(async (req, res) => {
    res.json(await media.removeCommunity(req.params.id, kind, req.user.id));
  }));
}

module.exports = router;
