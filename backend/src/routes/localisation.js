// /api/localisation — the locale this instance answers in, and the packs
// that decide it.
//
// The answer is public: an interface that says "Sign in" has to be able to
// say it in the reader's language before anybody has signed in. A token is
// used when one is offered, so a signed-in reader gets their own
// preference rather than the instance's default.
//
// The pack administration is not public: an operator installs packs, and a
// community's own pack needs somebody with the right permission to install
// it and a reviewer to sign it off.
const express = require('express');
const auth = require('../middleware/auth');
const optionalAuth = require('../middleware/optionalAuth');
const adminGuard = require('../middleware/adminGuard');
const rateLimit = require('../middleware/ratelimit');
const { fail, serviceError } = require('../errors');
const settings = require('../services/settings');
const permissions = require('../services/permissions');
const localisation = require('../services/localisation');

const router = express.Router();

// The locale and the strings, for anybody.
router.get('/', optionalAuth, rateLimit(120), async (req, res, next) => {
  try {
    const serverId = req.query.serverId ? String(req.query.serverId) : null;
    const available = await localisation.effectivePacks({ serverId });
    const preferred = req.user ? await localisation.preferenceOf(req.user.id) : null;
    const answer = localisation.negotiate({
      preferred,
      defaultLocale: settings.read('localisation.defaultLocale', 'en'),
      acceptLanguage: req.headers['accept-language'],
      available,
    });
    res.json({
      locale: answer.locale,
      source: answer.source,
      pack: answer.pack ? { locale: answer.pack.locale, version: answer.pack.version } : null,
      locales: [...available.values()].map((pack) => ({
        locale: pack.locale,
        version: pack.version,
        scope: pack.serverId ? 'community' : 'instance',
      })),
      strings: localisation.stringsFor(answer.pack),
    });
  } catch (e) { next(e); }
});

// The locales this instance has a pack for.
router.get('/locales', rateLimit(120), async (req, res, next) => {
  try {
    const serverId = req.query.serverId ? String(req.query.serverId) : null;
    const available = await localisation.effectivePacks({ serverId });
    res.json([...available.values()].map((pack) => ({
      locale: pack.locale,
      version: pack.version,
      scope: pack.serverId ? 'community' : 'instance',
    })));
  } catch (e) { next(e); }
});

// The reader's own preference.
router.put('/preference', auth, rateLimit(30), async (req, res, next) => {
  try {
    const locale = (req.body && req.body.locale) || null;
    res.json(await localisation.setPreference(req.user.id, locale));
  } catch (e) { serviceError(res, e); }
});

router.get('/preference', auth, rateLimit(30), async (req, res, next) => {
  try {
    res.json({ locale: await localisation.preferenceOf(req.user.id) });
  } catch (e) { next(e); }
});

// --- packs -----------------------------------------------------------------

// The packs installed here, and the community ones for a community.
router.get('/packs', adminGuard, rateLimit(30), async (req, res, next) => {
  try {
    const serverId = req.query.serverId ? String(req.query.serverId) : null;
    res.json(await localisation.listPacks({ serverId }));
  } catch (e) { serviceError(res, e); }
});

// Install a pack.
//
// Without a serverId this is the instance's own pack and only a system
// administrator may install it. With one it is a community's pack, and the
// community's staff may install it - but it waits for a review before it is
// served.
router.post('/packs', auth, rateLimit(20), async (req, res, next) => {
  try {
    const body = req.body || {};
    const serverId = body.serverId ? String(body.serverId) : null;

    if (!serverId) {
      // The instance's own pack is an operator's decision. The platform
      // administration table is the authority, exactly as it is everywhere
      // else in the console.
      const admin = await require('../services/enforcement').isPlatformAdmin(req.user.id);
      if (!admin) return fail(res, 'PERMISSION_DENIED', 'forbidden');
      res.status(201).json(await localisation.installPack(body.pack || body, {
        actorId: req.user.id,
        reviewState: 'approved',
      }));
      return;
    }

    if (!settings.read('localisation.allowCommunityPacks', true)) {
      return fail(res, 'FEATURE_DISABLED', 'this instance does not allow community localisation packs');
    }
    const allowed = await permissions.hasPermission(req.user.id, serverId, 'MANAGE_LOCALISATION');
    if (!allowed) return fail(res, 'PERMISSION_DENIED', 'forbidden');
    res.status(201).json(await localisation.installPack(body.pack || body, {
      actorId: req.user.id,
      serverId,
      reviewState: 'pending',
    }));
  } catch (e) { serviceError(res, e); }
});

// Sign a pack off, or turn it down.
router.post('/packs/:id/review', adminGuard, rateLimit(20), async (req, res, next) => {
  try {
    const name = req.user && req.user.username ? req.user.username : null;
    res.json(await localisation.reviewPack(req.params.id, {
      decision: (req.body && req.body.decision) || '',
      reviewerId: req.user.id,
      reviewerName: name,
    }));
  } catch (e) { serviceError(res, e); }
});

router.delete('/packs/:id', adminGuard, rateLimit(20), async (req, res, next) => {
  try {
    res.json(await localisation.removePack(req.params.id));
  } catch (e) { serviceError(res, e); }
});

module.exports = router;
