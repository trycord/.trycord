// /api/personal — the things a reader keeps for themselves.
//
//   templates    a named piece of text the reader inserts
//   collections  a named list of things the reader saved
//
// Both belong to the reader. A collection may be shared with the community
// it belongs to, and a shared collection is visible to that community's
// members and to nobody else.
//
// The reader's own state is the only thing these routes read: the owner is
// in every query, so one reader's template is never another's to read.
const express = require('express');
const auth = require('../middleware/auth');
const rateLimit = require('../middleware/ratelimit');
const { serviceError } = require('../errors');
const templates = require('../services/message-templates');
const collections = require('../services/saved-collections');

const router = express.Router();
router.use(auth);

// --- templates -------------------------------------------------------------

router.get('/templates', rateLimit(60), async (req, res, next) => {
  try {
    res.json(await templates.list(req.user.id));
  } catch (e) { next(e); }
});

router.post('/templates', rateLimit(30), async (req, res, next) => {
  try {
    res.status(201).json(await templates.create(req.user.id, req.body || {}));
  } catch (e) { serviceError(res, e); }
});

// The template a shortcut names, for the client that expands it.
// Registered before the /:id route, or "shortcut" would be read as an id.
router.get('/templates/shortcut/:shortcut', rateLimit(60), async (req, res, next) => {
  try {
    const found = await templates.byShortcut(req.user.id, req.params.shortcut);
    if (!found) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'no such template' } });
    res.json(found);
  } catch (e) { serviceError(res, e); }
});

router.get('/templates/:id', rateLimit(60), async (req, res, next) => {
  try {
    res.json(await templates.get(req.user.id, req.params.id));
  } catch (e) { serviceError(res, e); }
});

router.patch('/templates/:id', rateLimit(30), async (req, res, next) => {
  try {
    res.json(await templates.update(req.user.id, req.params.id, req.body || {}));
  } catch (e) { serviceError(res, e); }
});

router.delete('/templates/:id', rateLimit(30), async (req, res, next) => {
  try {
    res.json(await templates.remove(req.user.id, req.params.id));
  } catch (e) { serviceError(res, e); }
});

// --- collections -----------------------------------------------------------

// The reader's own collections, and the shared ones in the communities they
// belong to.
router.get('/collections', rateLimit(60), async (req, res, next) => {
  try {
    res.json(await collections.listForUser(req.user.id));
  } catch (e) { next(e); }
});

router.post('/collections', rateLimit(30), async (req, res, next) => {
  try {
    res.status(201).json(await collections.create(req.user.id, req.body || {}));
  } catch (e) { serviceError(res, e); }
});

router.get('/collections/:id', rateLimit(60), async (req, res, next) => {
  try {
    const collection = await collections.get(req.user.id, req.params.id);
    const items = await collections.items(req.user.id, req.params.id);
    res.json(Object.assign({}, collection, { items }));
  } catch (e) { serviceError(res, e); }
});

router.patch('/collections/:id', rateLimit(30), async (req, res, next) => {
  try {
    res.json(await collections.update(req.user.id, req.params.id, req.body || {}));
  } catch (e) { serviceError(res, e); }
});

router.delete('/collections/:id', rateLimit(30), async (req, res, next) => {
  try {
    res.json(await collections.remove(req.user.id, req.params.id));
  } catch (e) { serviceError(res, e); }
});

router.post('/collections/:id/items', rateLimit(60), async (req, res, next) => {
  try {
    res.status(201).json(await collections.addItem(req.user.id, req.params.id, req.body || {}));
  } catch (e) { serviceError(res, e); }
});

router.delete('/collections/:id/items/:itemId', rateLimit(60), async (req, res, next) => {
  try {
    res.json(await collections.removeItem(req.user.id, req.params.id, req.params.itemId));
  } catch (e) { serviceError(res, e); }
});

module.exports = router;
