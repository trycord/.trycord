// Notifications: the list, the unread count, and the preferences that shape them.

const express = require('express');
const { fail, wrap } = require('../errors');
const limit = require('../../middleware/ratelimit');
const { authenticate, requireVerified } = require('../../middleware/auth');
const notifications = require('../../services/notifications');

const router = express.Router();
router.use(authenticate);

router.get('/', wrap(async (req, res) => {
  res.json(await notifications.list(req.user.id, req.query));
}));

router.get('/unread', wrap(async (req, res) => {
  res.json({ count: await notifications.unreadCount(req.user.id) });
}));

router.post('/read', requireVerified, limit({ windowMs: 60000, max: 60 }), wrap(async (req, res) => {
  const { ids } = req.body || {};
  res.json(await notifications.markRead(req.user.id, ids));
}));

router.post('/read-all', requireVerified, wrap(async (req, res) => {
  res.json(await notifications.markAllRead(req.user.id));
}));

router.get('/prefs', wrap(async (req, res) => {
  res.json(await notifications.prefs(req.user.id));
}));

router.put('/prefs/:serverId', requireVerified, wrap(async (req, res) => {
  res.json(await notifications.setServerPref(req.user.id, req.params.serverId, req.body && req.body.categories));
}));

router.put('/channels/:channelId', requireVerified, wrap(async (req, res) => {
  res.json(await notifications.setChannelPref(req.user.id, req.params.channelId, req.body && req.body.muted));
}));

router.get('/muted', wrap(async (req, res) => {
  res.json({ channels: await notifications.mutedChannels(req.user.id) });
}));

module.exports = router;
