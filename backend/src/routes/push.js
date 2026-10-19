// The devices this instance may reach a reader on.
//
// A device that wants to be told about something while the application is
// closed has to give the instance a way to reach it. This is where that way
// is kept.
//
// What this is, precisely: a registry. The instance knows which devices its
// members have asked it to use, and a delivery mechanism reads the registry.
//
// What this is not: a delivery mechanism. Nothing here posts anything to
// Apple's or Google's servers - that needs credentials the operator holds and
// a transport this build does not ship. So the registry is real and the
// delivery is not, and the endpoint says which is which: an instance with
// push switched off refuses the registration rather than accepting it and
// never using it.
//
// The privacy rule that matters: a push payload carries no message content.
// A reader's notification says that something happened and names where, and
// the content is fetched from the instance when the application opens. That is
// a decision for the transport, not for this file, but this file is where a
// reader's device token is stored, so it is where the rule is written down.
const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');
const rateLimit = require('../middleware/ratelimit');
const { fail } = require('../errors');
const { now, uuid } = require('../util');
const features = require('../features');

const router = express.Router();
router.use(auth);

// The platforms a token can belong to. A token from a platform this build
// does not know is refused rather than stored, so the registry cannot fill
// with rows nothing will ever read.
const PLATFORMS = ['ios', 'android', 'web'];

router.post('/', rateLimit({ windowMs: 60000, max: 20 }), async (req, res, next) => {
  try {
    // The feature is off by default. Refusing is the honest answer: an
    // instance that accepted a registration it would never use would be
    // telling a reader that notifications work.
    if (!features.current.pushNotifications) {
      return fail(res, 'FEATURE_DISABLED',
        'this instance does not send push notifications', 403);
    }

    const token = String((req.body || {}).token || '').trim();
    const platform = String((req.body || {}).platform || '').trim().toLowerCase();
    const origin = String((req.body || {}).instanceOrigin || '').trim().slice(0, 255) || null;

    if (!token) return fail(res, 'VALIDATION_ERROR', 'a device token is required');
    if (token.length > 255) return fail(res, 'VALIDATION_ERROR', 'that device token is not a device token');
    if (!PLATFORMS.includes(platform)) {
      return fail(res, 'VALIDATION_ERROR', 'platform must be one of: ' + PLATFORMS.join(', '));
    }

    // A device may be signed in to more than one instance. Registering the
    // same token on a second account would take it away from the first, so a
    // token already in use by somebody else is refused rather than moved.
    const held = await db.get('SELECT user_id FROM push_devices WHERE token = ?', [token]);
    if (held && held.user_id !== req.user.id) {
      return fail(res, 'CONFLICT', 'that device is already registered to another account');
    }

    await db.upsert(
      'push_devices',
      ['id', 'user_id', 'token', 'platform', 'instance_origin', 'created_at', 'last_seen_at'],
      [uuid(), req.user.id, token, platform, origin, now(), now()],
      ['user_id', 'token'],
      {
        platform: db.dialect === 'mysql' ? 'VALUES(platform)' : 'excluded.platform',
        instance_origin: db.dialect === 'mysql' ? 'VALUES(instance_origin)' : 'excluded.instance_origin',
        last_seen_at: db.dialect === 'mysql' ? 'VALUES(last_seen_at)' : 'excluded.last_seen_at',
      },
    );

    res.json({ registered: true, platform });
  } catch (e) { next(e); }
});

router.get('/', rateLimit({ windowMs: 60000, max: 30 }), async (req, res, next) => {
  try {
    const rows = await db.all(
      'SELECT id, platform, instance_origin, created_at, last_seen_at FROM push_devices'
      + ' WHERE user_id = ? ORDER BY created_at DESC',
      [req.user.id],
    );
    // The token itself is never returned. A reader who can read their own
    // registry does not need the secret in it, and a client that has it in
    // one place should not have it in two.
    res.json({
      devices: rows.map((r) => ({
        id: r.id,
        platform: r.platform,
        instanceOrigin: r.instance_origin,
        createdAt: r.created_at,
        lastSeenAt: r.last_seen_at,
      })),
      enabled: !!features.current.pushNotifications,
    });
  } catch (e) { next(e); }
});

router.delete('/:token', rateLimit({ windowMs: 60000, max: 20 }), async (req, res, next) => {
  try {
    await db.run('DELETE FROM push_devices WHERE user_id = ? AND token = ?', [
      req.user.id, String(req.params.token || ''),
    ]);
    res.json({ registered: false });
  } catch (e) { next(e); }
});

module.exports = router;
