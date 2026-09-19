// /api/servers/:serverId/channels — list (members), create/patch/delete (MANAGE_CHANNELS).
const express = require('express');
const auth = require('../middleware/auth');
const { resolveServer, requireMember, requirePerm } = require('../middleware/serverAccess');
const { fail, serviceError } = require('../errors');
const channels = require('../services/channels');

const router = express.Router({ mergeParams: true });
router.use(auth, resolveServer);

router.get('/', requireMember, (req, res) => {
  res.json(channels.list(req.server.id));
});

router.post('/', requirePerm('MANAGE_CHANNELS'), (req, res) => {
  try {
    const { name, topic, categoryId } = req.body || {};
    if (!name || !String(name).trim()) return fail(res, 'VALIDATION_ERROR', 'name required');
    res.json(channels.create(req.server.id, { name, topic, categoryId }));
  } catch (e) { serviceError(res, e); }
});

router.patch('/:channelId', requirePerm('MANAGE_CHANNELS'), (req, res) => {
  const db = require('../db');
  const ch = db.prepare('SELECT * FROM channels WHERE id = ? AND server_id = ?')
    .get(req.params.channelId, req.server.id);
  if (!ch) return fail(res, 'NOT_FOUND', 'channel not found');
  try {
    const { name, topic, categoryId } = req.body || {};
    res.json(channels.update(ch, { name, topic, categoryId }));
  } catch (e) { serviceError(res, e); }
});

router.delete('/:channelId', requirePerm('MANAGE_CHANNELS'), (req, res) => {
  try {
    res.json(channels.remove(req.server.id, req.params.channelId));
  } catch (e) { serviceError(res, e); }
});

module.exports = router;
