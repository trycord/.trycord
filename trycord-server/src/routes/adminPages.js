// Admin Dashboard -> Pages.
//
// Authorisation is enforced here and in the service, not in the client: every
// route requires auth plus the admin guard, and the service refuses any route
// that is not on the editable list. A request naming an arbitrary file never
// reaches the filesystem.
//
// Legal pages carry an extra confirmation. Publishing Terms, Privacy, Official
// instance terms or Trust & Safety is immediately visible to every visitor and
// is the kind of change that is hard to walk back, so the caller has to type
// the page's own route to confirm.
const express = require('express');
const adminGuard = require('../middleware/adminGuard');
const rateLimit = require('../middleware/ratelimit');
const { fail, serviceError } = require('../errors');
const pages = require('../services/pages');
const content = require('../services/pageContent');

const router = express.Router();
router.use(adminGuard);
router.use(rateLimit({ windowMs: 60000, max: 300 }));

router.get('/', async (req, res, next) => {
  try {
    res.json(await pages.list());
  } catch (e) { serviceError(res, e); }
});

router.get('/:route', async (req, res, next) => {
  try {
    const page = await pages.get(req.params.route);
    if (!page) return fail(res, 'NOT_FOUND', 'page not found');
    res.json(page);
  } catch (e) { serviceError(res, e); }
});

router.put('/:route', async (req, res, next) => {
  try {
    const body = req.body || {};
    if (body.preview) {
      // Preview renders the same blocks the published page would, so what the
      // administrator sees is what a visitor gets.
      const blocks = content.normalise(body.body);
      return res.json({ ok: true, html: content.toHtml(blocks) });
    }
    res.json(await pages.saveDraft({
      route: req.params.route,
      title: body.title,
      body: body.body,
      actorId: req.user.id,
    }));
  } catch (e) { serviceError(res, e); }
});

router.post('/:route/publish', async (req, res, next) => {
  try {
    res.json(await pages.publish({
      route: req.params.route,
      actorId: req.user.id,
      confirm: (req.body || {}).confirm,
    }));
  } catch (e) { serviceError(res, e); }
});

router.post('/:route/unpublish', async (req, res, next) => {
  try {
    res.json(await pages.unpublish({ route: req.params.route, actorId: req.user.id }));
  } catch (e) { serviceError(res, e); }
});

router.get('/:route/revisions', async (req, res, next) => {
  try {
    res.json(await pages.revisions({ route: req.params.route, limit: (req.query || {}).limit }));
  } catch (e) { serviceError(res, e); }
});

router.post('/:route/revisions/:revision/restore', async (req, res, next) => {
  try {
    res.json(await pages.restore({
      route: req.params.route,
      revision: req.params.revision,
      actorId: req.user.id,
    }));
  } catch (e) { serviceError(res, e); }
});

module.exports = router;
