// Invites: manage scoped to a server (/api/servers/:serverId/invites),
// consume + preview scoped to a code (/api/invites/:code/...).
const express = require('express');
const auth = require('../middleware/auth');
const { resolveServer, requirePerm } = require('../middleware/serverAccess');
const { fail, serviceError } = require('../errors');
const invites = require('../services/invites');

// --- per-server management (MANAGE_INVITES) ---
const managed = express.Router({ mergeParams: true });
managed.use(auth, resolveServer);

managed.get('/', requirePerm('MANAGE_INVITES'), (req, res) => {
  res.json(invites.list(req.server.id));
});

managed.post('/', requirePerm('MANAGE_INVITES'), (req, res) => {
  try {
    const { maxUses, expiresInHours } = req.body || {};
    res.json(invites.create(req.server.id, req.user.id, { maxUses, expiresInHours }));
  } catch (e) { serviceError(res, e); }
});

managed.delete('/:inviteId', requirePerm('MANAGE_INVITES'), (req, res) => {
  const inv = invites.getById(req.params.inviteId);
  if (!inv || inv.server_id !== req.server.id) return fail(res, 'NOT_FOUND', 'invite not found');
  res.json(invites.revoke(inv));
});

// --- code-scoped: preview (authed) + join (authed, validated, atomic) ---
const byCode = express.Router();
byCode.use(auth);

byCode.get('/:code/preview', (req, res) => {
  const p = invites.preview(req.params.code);
  if (!p) return fail(res, 'INVITE_INVALID', 'invite not found');
  res.json(p);
});

byCode.post('/:code/join', (req, res) => {
  try {
    res.json(invites.joinWithCode(req.params.code, req.user));
  } catch (e) { serviceError(res, e); }
});

module.exports = { managed, byCode };
