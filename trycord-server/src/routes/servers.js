// /api/servers — thin controllers over the membership/server services.
// Access chain: auth -> resolveServer -> requireMember / requirePerm / requireOwner.
const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');
const { resolveServer, requireMember, requireOwner, requirePerm } = require('../middleware/serverAccess');
const { fail, serviceError } = require('../errors');
const servers = require('../services/servers');
const memberships = require('../services/memberships');

const router = express.Router();
router.use(auth);

router.get('/', (req, res) => {
  try {
    res.json(servers.mine(req.user.id));
  } catch (e) { serviceError(res, e); }
});

router.post('/', (req, res) => {
  try {
    const { name, description, joinCode, isPublic, isDiscoverable } = req.body || {};
    res.json(servers.create({ name, description, joinCode, isPublic, isDiscoverable }, req.user));
  } catch (e) { serviceError(res, e); }
});

// Safe pre-join preview for code holders (subset only — no members, messages, or settings).
router.get('/by-code/:code', (req, res) => {
  const srv = db.prepare(`
    SELECT s.id, s.name, s.description, s.is_public, s.is_discoverable, s.created_at,
      (SELECT COUNT(*) FROM server_members m WHERE m.server_id = s.id) AS member_count
    FROM servers s WHERE s.join_code = ?
  `).get(String(req.params.code).toLowerCase().trim());
  if (!srv) return fail(res, 'SERVER_NOT_FOUND', 'server not found');
  res.json(srv);
});

// Legacy permanent-code join (kept for back-compat; invites are the real system).
router.post('/join/:code', (req, res) => {
  try {
    res.json(memberships.joinByCode(req.params.code, req.user));
  } catch (e) { serviceError(res, e); }
});

router.get('/:id', resolveServer, requireMember, (req, res) => {
  try {
    res.json(servers.detail(req.server.id, req.user.id));
  } catch (e) { serviceError(res, e); }
});

router.patch('/:id', resolveServer, requirePerm('MANAGE_SERVER'), (req, res) => {
  try {
    const { name, description, isPublic, isDiscoverable } = req.body || {};
    const row = servers.update(req.server.id, { name, description, isPublic, isDiscoverable });
    res.json(servers.detail(row.id, req.user.id));
  } catch (e) { serviceError(res, e); }
});

router.delete('/:id', resolveServer, requireOwner, (req, res) => {
  try {
    res.json(servers.remove(req.server.id));
  } catch (e) { serviceError(res, e); }
});

router.get('/:id/members', resolveServer, requireMember, (req, res) => {
  try {
    res.json(memberships.list(req.server.id));
  } catch (e) { serviceError(res, e); }
});

router.post('/:id/leave', resolveServer, (req, res) => {
  try {
    res.json(memberships.leave(req.server.id, req.user.id));
  } catch (e) { serviceError(res, e); }
});

router.post('/:id/kick', resolveServer, requirePerm('KICK_MEMBERS'), (req, res) => {
  try {
    const { userId } = req.body || {};
    if (!userId) return fail(res, 'VALIDATION_ERROR', 'userId required');
    res.json(memberships.kick(req.server.id, req.user.id, userId));
  } catch (e) { serviceError(res, e); }
});

module.exports = router;
