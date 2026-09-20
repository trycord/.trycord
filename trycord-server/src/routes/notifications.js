// /api/notifications — my own notifications only. The realtime gateway
// pushes new ones to connected sockets; this API is the durable source
// when offline. Authorization: every query is scoped to req.user.id.
const express = require('express');
const auth = require('../middleware/auth');
const { serviceError } = require('../errors');
const notifications = require('../services/notifications');

const router = express.Router();
router.use(auth);

// GET /api/notifications?limit= — newest first, with unread count.
router.get('/', async (req, res, next) => {
  try {
    res.json(await notifications.list(req.user.id, req.query.limit));
  } catch (e) { next(e); }
});

// POST /api/notifications/read-all
router.post('/read-all', async (req, res, next) => {
  try {
    res.json(await notifications.markAllRead(req.user.id));
  } catch (e) { next(e); }
});

// POST /api/notifications/:id/read
router.post('/:id/read', async (req, res, next) => {
  try {
    res.json(await notifications.markRead(req.user.id, req.params.id));
  } catch (e) { serviceError(res, e); }
});

module.exports = router;
