// /api/servers/:serverId/channels — list (members), create/patch/delete (MANAGE_CHANNELS).
const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');
const { resolveServer, requireMember, requirePerm } = require('../middleware/serverAccess');
const { fail, serviceError } = require('../errors');
const channels = require('../services/channels');
const events = require('../services/events');

const router = express.Router({ mergeParams: true });
router.use(auth, resolveServer);

// Channel-room broadcaster (pins land on the channel room, next to the
// message events). Wired once at boot; structural events keep using emit().
let broadcastChannel = () => {};
function setGateway(gw) {
  if (gw && typeof gw.broadcast === 'function') broadcastChannel = gw.broadcast;
}

router.get('/', requireMember, async (req, res, next) => {
  try {
    res.json(await channels.list(req.server.id));
  } catch (e) { next(e); }
});

router.post('/', requirePerm('MANAGE_CHANNELS'), async (req, res, next) => {
  try {
    const { name, topic, categoryId } = req.body || {};
    if (!name || !String(name).trim()) return fail(res, 'VALIDATION_ERROR', 'name required');
    const ch = await channels.create(req.server.id, { name, topic, categoryId });
    events.emit(req.server.id, 'channel_created', { channel: ch });
    res.json(ch);
  } catch (e) { serviceError(res, e); }
});

router.patch('/:channelId', requirePerm('MANAGE_CHANNELS'), async (req, res, next) => {
  try {
    const ch = await db.get('SELECT * FROM channels WHERE id = ? AND server_id = ?', [req.params.channelId, req.server.id]);
    if (!ch) return fail(res, 'NOT_FOUND', 'channel not found');
    const { name, topic, categoryId } = req.body || {};
    const updated = await channels.update(ch, { name, topic, categoryId });
    events.emit(req.server.id, 'channel_updated', { channel: updated });
    res.json(updated);
  } catch (e) { serviceError(res, e); }
});

router.post('/reorder', requirePerm('MANAGE_CHANNELS'), async (req, res, next) => {
  try {
    const { orderedIds } = req.body || {};
    const layout = await channels.reorderChannels(req.server.id, orderedIds);
    events.emit(req.server.id, 'channels_reordered', { channels: layout.channels.map((c) => c.id) });
    res.json(layout);
  } catch (e) { serviceError(res, e); }
});

router.delete('/:channelId', requirePerm('MANAGE_CHANNELS'), async (req, res, next) => {
  try {
    const out = await channels.remove(req.server.id, req.params.channelId);
    events.emit(req.server.id, 'channel_deleted', { channelId: String(req.params.channelId) });
    res.json(out);
  } catch (e) { serviceError(res, e); }
});

// ---- pins -----------------------------------------------------------
// Pins live at /api/servers/:serverId/channels/:channelId/pins so the
// channel is addressable without the /messages nesting. Pinning needs
// MANAGE_MESSAGES; reading needs membership.
const { visibleChannel } = require('../util');
const { hasPermission } = require('../services/permissions');
const rateLimit = require('../middleware/ratelimit');
const uploads = require('../services/uploads');
const reactions = require('../services/reactions');
const { now } = require('../util');

async function pinChannel(req) {
  const ch = await visibleChannel(req.params.channelId, req.user.id);
  if (!ch || String(ch.server_id) !== String(req.server.id)) return null;
  return ch;
}

router.get('/:channelId/pins', requireMember, async (req, res, next) => {
  try {
    const ch = await pinChannel(req);
    if (!ch) return fail(res, 'NOT_A_MEMBER', 'channel not found or not a member');
    const rows = await db.all(
      `SELECT m.*, u.username AS author_name, u.display_name AS author_display,
              p.pinned_by, p.pinned_at
       FROM pinned_messages p
       JOIN messages m ON m.id = p.message_id
       JOIN users u ON u.id = m.author_id
       WHERE p.channel_id = ? ORDER BY p.pinned_at ASC, m.created_at ASC`,
      [ch.id]
    );
    const byId = await uploads.getForMessages(rows.map((r) => r.id));
    rows.forEach((r) => { r.attachments = byId[r.id] || []; r.pinned = true; });
    const summaries = await reactions.summary(rows.map((r) => r.id), req.user.id);
    rows.forEach((r) => { r.reactions = summaries[r.id] || []; });
    res.json(rows);
  } catch (e) { next(e); }
});

router.post('/:channelId/pins', requirePerm('MANAGE_MESSAGES'), rateLimit({ windowMs: 60000, max: 30 }), async (req, res, next) => {
  try {
    const ch = await pinChannel(req);
    if (!ch) return fail(res, 'NOT_A_MEMBER', 'channel not found or not a member');
    const messageId = String((req.body || {}).messageId || '');
    const msg = await db.get('SELECT id FROM messages WHERE id = ? AND channel_id = ?', [messageId, ch.id]);
    if (!msg) return fail(res, 'NOT_FOUND', 'message not found in this channel');
    const at = now();
    try {
      await db.run(
        'INSERT INTO pinned_messages (message_id, channel_id, server_id, pinned_by, pinned_at) VALUES (?, ?, ?, ?, ?)',
        [messageId, ch.id, ch.server_id, req.user.id, at]
      );
    } catch (e) {
      const s = String((e && e.message) || e);
      if (!/UNIQUE|unique|duplicate|PRIMARY/i.test(s)) throw e;
    }
    broadcastChannel(ch.server_id, ch.id, { type: 'message_pinned', id: messageId, channel_id: ch.id, pinned_by: req.user.id, pinned_at: at });
    res.json({ ok: true, id: messageId });
  } catch (e) { next(e); }
});

router.delete('/:channelId/pins/:messageId', requirePerm('MANAGE_MESSAGES'), async (req, res, next) => {
  try {
    const ch = await pinChannel(req);
    if (!ch) return fail(res, 'NOT_A_MEMBER', 'channel not found or not a member');
    await db.run('DELETE FROM pinned_messages WHERE message_id = ? AND channel_id = ?', [req.params.messageId, ch.id]);
    broadcastChannel(ch.server_id, ch.id, { type: 'message_unpinned', id: req.params.messageId, channel_id: ch.id });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

module.exports = router;
module.exports.setGateway = setGateway;
