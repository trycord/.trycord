// /api/notifications — my own notifications only. The realtime gateway
// pushes new ones to connected sockets; this API is the durable source
// when offline. Authorization: every query is scoped to req.user.id.
//
// Notifications are delivered in-house ('notifications.provider' in the
// settings catalogue). External push is an optional add-on.
const express = require('express');
const auth = require('../middleware/auth');
const rateLimit = require('../middleware/ratelimit');
const settings = require('../services/settings');
const { serviceError } = require('../errors');
const notifications = require('../services/notifications');

const router = express.Router();
router.use(auth);

// GET /api/notifications?limit=&before=&category= — newest first, with unread count.
//
// `before` is the opaque cursor returned as `nextCursor` by the previous page.
// Passing it back walks one page further back; omitting it starts at the newest
// notification. The unread count is the whole-account badge total, so it does
// not shrink as the caller pages. `unreadByCategory` is what the filter row
// draws; `category` narrows the items without changing either total.
router.get('/', async (req, res, next) => {
  try {
    settings.get('notifications.provider');
    res.json(await notifications.list(
      req.user.id, req.query.limit, req.query.before, req.query.category
    ));
  } catch (e) { serviceError(res, e); }
});

// POST /api/notifications/read-all
router.post('/read-all', async (req, res, next) => {
  try {
    res.json(await notifications.markAllRead(req.user.id));
  } catch (e) { next(e); }
});

// DELETE /api/notifications?read=true — clear the list, or only the items
// already dealt with. Scoped to the caller by the service.
router.delete('/', rateLimit({ windowMs: 60_000, max: 20, key: 'notification-clear' }), async (req, res, next) => {
  try {
    res.json(await notifications.clear(req.user.id, { read: req.query.read }));
  } catch (e) { next(e); }
});

// POST /api/notifications/:id/read
router.post('/:id/read', async (req, res, next) => {
  try {
    res.json(await notifications.markRead(req.user.id, req.params.id));
  } catch (e) { serviceError(res, e); }
});

// DELETE /api/notifications/:id
router.delete('/:id', rateLimit({ windowMs: 60_000, max: 60, key: 'notification-dismiss' }), async (req, res, next) => {
  try {
    res.json(await notifications.remove(req.user.id, req.params.id));
  } catch (e) { serviceError(res, e); }
});

module.exports = router;
