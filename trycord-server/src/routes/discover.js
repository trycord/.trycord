// Public discovery. No auth, no membership — only public + discoverable servers,
// safe fields only. Private servers are indistinguishable from missing ones.
const express = require('express');
const auth = require('../middleware/auth');
const { fail, serviceError } = require('../errors');
const discovery = require('../services/discovery');
const memberships = require('../services/memberships');
const db = require('../db');

const router = express.Router();

router.get('/servers', (req, res) => {
  try {
    res.json(discovery.search({ q: req.query.q, page: req.query.page, limit: req.query.limit }));
  } catch (e) { serviceError(res, e); }
});

router.get('/servers/:id', (req, res) => {
  const srv = discovery.preview(req.params.id);
  if (!srv) return fail(res, 'SERVER_NOT_FOUND', 'server not found');
  res.json(srv);
});

// Join straight from a public preview. Private servers reject with SERVER_PRIVATE.
router.post('/servers/:id/join', auth, (req, res) => {
  const srv = db.prepare('SELECT id, is_public FROM servers WHERE id = ?').get(req.params.id);
  if (!srv) return fail(res, 'SERVER_NOT_FOUND', 'server not found');
  if (!srv.is_public) return fail(res, 'SERVER_PRIVATE', 'this server is private — ask for an invite');
  try {
    res.json(memberships.join(srv.id, req.user));
  } catch (e) { serviceError(res, e); }
});

module.exports = router;
