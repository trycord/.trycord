// Invites: manage scoped to a server (/api/servers/:serverId/invites),
// consume + preview scoped to a code (/api/invites/:code/...).
const express = require('express');
const auth = require('../middleware/auth');
const rateLimit = require('../middleware/ratelimit');
const { resolveServer, requirePerm } = require('../middleware/serverAccess');
const { fail, serviceError } = require('../errors');
const invites = require('../services/invites');
const events = require('../services/events');
const notifications = require('../services/notifications');
const db = require('../db');

// --- per-server management (MANAGE_INVITES) ---
const managed = express.Router({ mergeParams: true });
managed.use(auth, rateLimit({ windowMs: 60000, max: 120 }), resolveServer);

managed.get('/', requirePerm('MANAGE_INVITES'), async (req, res, next) => {
  try {
    res.json(await invites.list(req.server.id));
  } catch (e) { next(e); }
});

managed.post('/', auth.requireVerified, requirePerm('MANAGE_INVITES'), async (req, res, next) => {
  try {
    const { maxUses, expiresInHours, code } = req.body || {};
    const inv = await invites.create(req.server.id, req.user.id, { maxUses, expiresInHours, code });
    events.emit(req.server.id, 'invite_created', { invite: inv });
    res.json(inv);
  } catch (e) { serviceError(res, e); }
});

managed.delete('/:inviteId', auth.requireVerified, requirePerm('MANAGE_INVITES'), async (req, res, next) => {
  try {
    const inv = await invites.getById(req.params.inviteId);
    if (!inv || inv.server_id !== req.server.id) return fail(res, 'NOT_FOUND', 'invite not found');
    const out = await invites.revoke(inv);
    events.emit(req.server.id, 'invite_revoked', { inviteId: String(inv.id) });
    res.json(out);
  } catch (e) { next(e); }
});

// Send an existing invite to one person as a notification.
//
// The invite code is the reference: the recipient already has the join route,
// and putting the code in the notification means they do not have to be sent a
// link in a different app. This does not create a second invite and does not
// bypass the code's own limits; it only tells somebody it exists.
managed.post('/:inviteId/notify', auth.requireVerified,
  rateLimit({ windowMs: 60000, max: 20 }), requirePerm('MANAGE_INVITES'), async (req, res, next) => {
    try {
      const userId = String((req.body || {}).userId || '');
      if (!userId) return fail(res, 'VALIDATION_ERROR', '`userId` is required');
      const inv = await invites.getById(req.params.inviteId);
      if (!inv || inv.server_id !== req.server.id) return fail(res, 'NOT_FOUND', 'invite not found');
      const member = await db.get(
        'SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?',
        [req.server.id, userId]
      );
      if (member) return fail(res, 'ALREADY_MEMBER', 'they are already in this community');
      const target = await db.get('SELECT id FROM users WHERE id = ?', [userId]);
      if (!target) return fail(res, 'NOT_FOUND', 'user not found');
      const { notification, held, suppressed } = await notifications.create(
        userId, 'community_invite', req.user.id, inv.code,
        { detail: req.server.name, dedupeKey: 'community-invite:' + inv.id + ':' + userId }
      );
      if (notification && !held) {
        events.emitTo(userId, 'notification', { notification });
      }
      res.json({ notified: !!notification, held: !!held, suppressed: !!suppressed });
    } catch (e) { serviceError(res, e); }
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

byCode.post('/:code/join', auth.requireVerified, rateLimit({ windowMs: 60000, max: 30 }), async (req, res, next) => {
  try {
    const out = await invites.joinWithCode(req.params.code, req.user);
    if (out && out.serverId) events.emit(out.serverId, 'member_joined', { userId: String(req.user.id) });
    res.json(out);
  } catch (e) { serviceError(res, e); }
});

module.exports = { managed, byCode };
