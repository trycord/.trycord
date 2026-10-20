// /api/themes — the theme packages this instance runs.
//
// A theme is values, not code. Importing one validates it: a package that
// declares a schema version this build does not know is refused and the
// message names that version, and a package that carries anything but
// colours is refused as well.
//
// Export produces a package that can be imported somewhere else, and a
// rollback puts back the theme that was in force before the last change.
//
// Installing a theme for a community needs the MANAGE_THEME permission in
// that community. Installing one for the instance is an operator's decision.
const express = require('express');
const auth = require('../middleware/auth');
const rateLimit = require('../middleware/ratelimit');
const { fail, serviceError } = require('../errors');
const settings = require('../services/settings');
const permissions = require('../services/permissions');
const enforcement = require('../services/enforcement');
const themes = require('../services/themes');

const router = express.Router();

// The schema this build understands, and the theme in force.
router.get('/', async (req, res, next) => {
  try {
    const serverId = req.query.serverId ? String(req.query.serverId) : null;
    const scope = serverId ? 'community' : 'instance';
    res.json({
      schema: themes.schema(),
      active: await themes.activeTheme({ scope, serverId }),
      themes: await themes.listThemes({ serverId }),
    });
  } catch (e) { next(e); }
});

// One theme, and its package.
router.get('/:id', async (req, res, next) => {
  try {
    res.json(await themes.get(req.params.id));
  } catch (e) { serviceError(res, e); }
});

// The package, for writing to a file.
router.get('/:id/export', async (req, res, next) => {
  try {
    res.json(await themes.exportTheme(req.params.id));
  } catch (e) { serviceError(res, e); }
});

// Import a package.
//
// With a serverId it is a community's theme and the community's staff may
// install it; without one it is the instance's theme and only a system
// administrator may install it.
router.post('/import', auth, rateLimit({ windowMs: 60000, max: 20 }), async (req, res, next) => {
  try {
    const body = req.body || {};
    const serverId = body.serverId ? String(body.serverId) : null;

    if (!serverId) {
      if (!(await enforcement.isPlatformAdmin(req.user.id))) {
        return fail(res, 'PERMISSION_DENIED', 'forbidden');
      }
      res.status(201).json(await themes.importTheme(body.theme || body, { actorId: req.user.id }));
      return;
    }

    if (!settings.read('themes.allowCommunityThemes', true)) {
      return fail(res, 'FEATURE_DISABLED', 'this instance does not allow community themes');
    }
    const allowed = await permissions.hasPermission(req.user.id, serverId, 'MANAGE_THEME');
    if (!allowed) return fail(res, 'PERMISSION_DENIED', 'forbidden');
    res.status(201).json(await themes.importTheme(body.theme || body, {
      actorId: req.user.id,
      serverId,
    }));
  } catch (e) { serviceError(res, e); }
});

// Go back to the theme that was in force before the last change.
router.post('/rollback', auth, rateLimit({ windowMs: 60000, max: 20 }), async (req, res, next) => {
  try {
    const body = req.body || {};
    const serverId = body.serverId ? String(body.serverId) : null;

    if (!serverId) {
      if (!(await enforcement.isPlatformAdmin(req.user.id))) {
        return fail(res, 'PERMISSION_DENIED', 'forbidden');
      }
    } else {
      const allowed = await permissions.hasPermission(req.user.id, serverId, 'MANAGE_THEME');
      if (!allowed) return fail(res, 'PERMISSION_DENIED', 'forbidden');
    }

    const scope = serverId ? 'community' : 'instance';
    res.json(await themes.rollback({ scope, serverId, actorId: req.user.id }));
  } catch (e) { serviceError(res, e); }
});

module.exports = router;
