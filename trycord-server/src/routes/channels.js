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

module.exports = router;
