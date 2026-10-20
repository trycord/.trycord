// The voice console's own settings.
//
// The voice settings are changed here and nowhere else. The general
// Configuration page shows them read-only and says where they are changed,
// because a setting with two editors is a setting with two answers.
//
// This route is the other half of that rule: it writes the voice settings,
// and it writes **only** the voice settings. A write that arrives here for
// the instance name is refused, so this console cannot become a second place
// to change the general configuration.
//
// Everything here is behind the platform-admin gate, which is the admins
// table and nothing else.

const express = require('express');
const { fail, wrap } = require('../errors');
const rateLimit = require('../middleware/ratelimit');
const adminGuard = require('../middleware/adminGuard');
const settings = require('../services/settings');

const router = express.Router();
router.use(adminGuard);

// The console this route speaks for.
//
// It is the same name the settings catalogue uses, so "who owns this
// setting" has one answer in the whole product.
const OWNER = 'admin.voice';

// The voice settings, with their values and where each value came from.
//
// They are asked for by key rather than by category, because the provider's
// own fields and the older keys they replaced are deliberately not published
// in the general catalogue - they belong to this console, and this is where
// they are shown.
//
// The shape of each entry is the catalogue's own, so the console shows the
// same words the general Configuration page shows for the same setting, and a
// value cannot drift between the two.
router.get('/', wrap(async (req, res) => {
  await settings.load();
  res.json({
    owner: OWNER,
    settings: settings.ownedSettings(OWNER),
    status: settings.status(),
  });
}));

// Save. The body is a map of setting key to value, and every key in it must
// be a voice setting.
router.put('/', rateLimit({ windowMs: 60000, max: 60 }), wrap(async (req, res) => {
  await settings.load();
  const body = req.body || {};
  const keys = Object.keys(body);
  if (!keys.length) return fail(res, 'VALIDATION_ERROR', 'nothing to save');

  // A consequential setting - one that locks people out or opens registration - is the
  // one that needs saying yes to rather than clicking save.
  //
  // This is the console that owns the voice settings, so this is where the
  // person is asked about the ones that change what every member of the
  // instance may do - and the console sends the flag when it has asked.
  const consequential = keys.filter((k) => {
    const entry = settings.SCHEMA.find((s) => s.key === k);
    return entry && entry.consequential;
  });
  if (consequential.length && body.__confirm !== true) {
    return fail(res, 'CONFIRMATION_REQUIRED',
      consequential.join(', ') + ' need confirmation', 400);
  }

  // The confirmation flag is not a setting, and treating it as one would refuse every
  // consequential change as "unknown setting".
  const entries = Object.assign({}, body);
  delete entries.__confirm;

  let result;
  try {
    result = await settings.save(entries, req.user.id, { owner: OWNER });
  } catch (e) {
    // A concurrent write is a refusal, not a failure: the administrator's value was not
    // stored and nothing was changed, which is exactly what the conflict says.
    if (e && e.code === 'CONFLICT') {
      return fail(res, 'CONFLICT', e.message, 409);
    }
    throw e;
  }
  if (!result.ok) return fail(res, 'VALIDATION_ERROR', result.problems.join('; '), 400);

  res.json({
    ok: true,
    changed: result.changed,
    settings: entries,
    status: settings.status(),
  });
}));

// Reset one voice setting to whatever the deployment and the schema say
// without a saved value.
router.delete('/:key', rateLimit({ windowMs: 60000, max: 60 }), wrap(async (req, res) => {
  await settings.load();
  try {
    await settings.reset(req.params.key, req.user.id, { owner: OWNER });
  } catch (e) {
    if (e && e.code === 'NOT_FOUND') return fail(res, 'NOT_FOUND', 'unknown setting');
    if (e && e.code === 'LOCKED') return fail(res, 'PERMISSION_DENIED', e.message, 403);
    throw e;
  }
  res.json({ ok: true, status: settings.status() });
}));

module.exports = router;
