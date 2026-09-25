// Invites: manage scoped to a server (/api/servers/:serverId/invites),
// consume + preview scoped to a code (/api/invites/:code/...).
const express = require('express');
const auth = require('../middleware/auth');
const rateLimit = require('../middleware/ratelimit');
const { resolveServer, requirePerm } = require('../middleware/serverAccess');
const { fail, serviceError } = require('../errors');
const invites = require('../services/invites');
const events = require('../services/events');

// --- per-server management (MANAGE_INVITES) ---
const managed = express.Router({ mergeParams: true });
managed.use(auth, rateLimit({ windowMs: 60000, max: 120 }), resolveServer);

managed.get('/', requirePerm('MANAGE_INVITES'), async (req, res, next) => {
  try {
    res.json(await invites.list(req.server.id));
  } catch (e) { next(e); }
});

managed.post('/', requirePerm('MANAGE_INVITES'), async (req, res, next) => {
  try {
    const { maxUses, expiresInHours } = req.body || {};
    const inv = await invites.create(req.server.id, req.user.id, { maxUses, expiresInHours });
    events.emit(req.server.id, 'invite_created', { invite: inv });
    res.json(inv);
  } catch (e) { serviceError(res, e); }
});

managed.delete('/:inviteId', requirePerm('MANAGE_INVITES'), async (req, res, next) => {
  try {
    const inv = await invites.getById(req.params.inviteId);
    if (!inv || inv.server_id !== req.server.id) return fail(res, 'NOT_FOUND', 'invite not found');
    const out = await invites.revoke(inv);
    events.emit(req.server.id, 'invite_revoked', { inviteId: String(inv.id) });
    res.json(out);
  } catch (e) { next(e); }
});

// --- code-scoped: preview (authed) + join (authed, validated, atomic) ---
const byCode = express.Router();
byCode.use(auth, rateLimit({ windowMs: 60000, max: 120 }));

byCode.get('/:code/preview', async (req, res, next) => {
  try {
    const p = await invites.preview(req.params.code);
    if (!p) return fail(res, 'INVITE_INVALID', 'invite not found');
    res.json(p);
  } catch (e) { next(e); }
});

byCode.post('/:code/join', rateLimit({ windowMs: 60000, max: 30 }), async (req, res, next) => {
  try {
    const out = await invites.joinWithCode(req.params.code, req.user);
    if (out && out.serverId) events.emit(out.serverId, 'member_joined', { userId: String(req.user.id) });
    res.json(out);
  } catch (e) { serviceError(res, e); }
});

module.exports = { managed, byCode };
