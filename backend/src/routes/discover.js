// Public discovery. No auth, no membership — only public + discoverable servers,
// safe fields only. Private servers are indistinguishable from missing ones.
// Reads are rate-limited: discovery is public (no identity key), so the IP
// bucket is the only backstop against crawl abuse.
const express = require('express');
const auth = require('../middleware/auth');
const rateLimit = require('../middleware/ratelimit');
const { fail, serviceError } = require('../errors');
const discovery = require('../services/discovery');
const memberships = require('../services/memberships');
const db = require('../db');

const router = express.Router();

router.get('/servers', rateLimit({ windowMs: 60000, max: 120 }), async (req, res, next) => {
  try {
    res.json(await discovery.search({ q: req.query.q, page: req.query.page, limit: req.query.limit }));
  } catch (e) { next(e); }
});

router.get('/servers/:id', rateLimit({ windowMs: 60000, max: 120 }), async (req, res, next) => {
  try {
    const srv = await discovery.preview(req.params.id);
    if (!srv) return fail(res, 'SERVER_NOT_FOUND', 'server not found');
    res.json(srv);
  } catch (e) { next(e); }
});

// Join straight from a public preview. Private servers reject with SERVER_PRIVATE.
router.post('/servers/:id/join', auth, rateLimit({ windowMs: 60000, max: 30 }), async (req, res, next) => {
  try {
    const srv = await db.get('SELECT id, is_public FROM servers WHERE id = ?', [req.params.id]);
    if (!srv) return fail(res, 'SERVER_NOT_FOUND', 'server not found');
    if (!srv.is_public) return fail(res, 'SERVER_PRIVATE', 'this server is private — ask for an invite');
    res.json(await memberships.join(srv.id, req.user));
  } catch (e) { serviceError(res, e); }
});

module.exports = router;
