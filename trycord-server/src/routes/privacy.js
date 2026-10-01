// /api/me/privacy, /api/me/blocks, /api/me/wellbeing, /api/me/notification-prefs
//
// One file for the account-scoped settings that did not have a home. They are
// grouped because the client loads them together to paint the Privacy and
// Notification summaries, and splitting them across four mounts would mean four
// round trips for one screen.
//
// Every route here is about the caller's own account. There is no route that
// reads or writes another person's preferences: those are read server-side by
// the services that enforce them, and a client that could read them would be a
// client that could infer a stranger's settings.
const express = require('express');
const auth = require('../middleware/auth');
const rateLimit = require('../middleware/ratelimit');
const { fail } = require('../errors');
const privacy = require('../services/privacy');
const events = require('../services/events');

const router = express.Router();
router.use(auth);

// ---- privacy preferences -------------------------------------------------

// GET /api/me/privacy — the caller's effective settings. An account with no row
// gets the defaults rather than a 404: "not configured" is not a state a client
// should have to distinguish from "set to the default".
router.get('/privacy', async (req, res, next) => {
  try {
    res.json(await privacy.getPrivacy(req.user.id));
  } catch (e) { next(e); }
});

// PATCH /api/me/privacy — partial. Only the keys present are written, so an
// older client cannot reset a preference it does not know about.
router.patch('/privacy', rateLimit({ windowMs: 60_000, max: 30 }), async (req, res, next) => {
  try {
    const body = req.body || {};
    const patch = {};
    for (const key of ['friendRequests', 'dms', 'presence']) {
      if (body[key] === undefined) continue;
      const v = privacy.normalizeScope(body[key]);
      if (!v) {
        return fail(res, 'VALIDATION_ERROR', `\`${key}\` must be one of ${privacy.SCOPES.join(', ')} or everyone`);
      }
      patch[key] = v;
    }
    if (body.discoverable !== undefined) {
      if (typeof body.discoverable !== 'boolean') {
        return fail(res, 'VALIDATION_ERROR', '`discoverable` must be a boolean');
      }
      patch.discoverable = body.discoverable;
    }
    if (!Object.keys(patch).length) {
      return fail(res, 'VALIDATION_ERROR', 'nothing to update');
    }
    const saved = await privacy.setPrivacy(req.user.id, patch);
    // Account-scoped: a phone that has this page open has to learn that the
    // setting changed here, or it will keep enforcing the old answer until it is
    // refreshed. The payload is the caller's own preferences, so it discloses
    // nothing to anyone else.
    events.emitTo(req.user.id, 'privacy', { privacy: saved });
    res.json(saved);
  } catch (e) { next(e); }
});

// ---- blocking ------------------------------------------------------------

// GET /api/me/blocks — who the caller has blocked. Only ever the caller's own
// list: a block is a private decision, and a mutual block is enforced without
// either side learning about the other's.
router.get('/blocks', async (req, res, next) => {
  try {
    res.json(await privacy.listBlocks(req.user.id));
  } catch (e) { next(e); }
});

// POST /api/me/blocks { userId, reason? } — block.
//
// This is a one-way, immediately effective action: the service removes a
// pending request and any friendship in the same call, so "block" cannot leave a
// relationship alive behind it. Rate limited because it is destructive to
// someone else's access to the caller.
router.post('/blocks', rateLimit({ windowMs: 60_000, max: 20 }), async (req, res, next) => {
  try {
    const body = req.body || {};
    const userId = String(body.userId || '');
    if (!userId) return fail(res, 'VALIDATION_ERROR', '`userId` is required');
    if (body.reason && String(body.reason).length > 500) {
      return fail(res, 'VALIDATION_ERROR', '`reason` must be 500 characters or fewer');
    }
    const blocked = await privacy.block(req.user.id, userId, body.reason ? String(body.reason) : null);
    events.emitTo(req.user.id, 'blocks', { blocked });
    res.json(blocked);
  } catch (e) { next(e); }
});

// DELETE /api/me/blocks/:userId — unblock.
router.delete('/blocks/:userId', async (req, res, next) => {
  try {
    const unblocked = await privacy.unblock(req.user.id, String(req.params.userId));
    events.emitTo(req.user.id, 'blocks', { unblocked });
    res.json(unblocked);
  } catch (e) { next(e); }
});

// ---- notification preferences --------------------------------------------

// GET /api/me/notification-prefs[?serverId=] — effective preferences. With a
// serverId the per-community row overrides the global one; without it, the
// global row is returned, which is what the Privacy summary displays.
router.get('/notification-prefs', async (req, res, next) => {
  try {
    const serverId = req.query.serverId ? String(req.query.serverId) : null;
    res.json({
      global: await privacy.getNotificationPrefs(req.user.id, null),
      server: serverId ? await privacy.getNotificationPrefs(req.user.id, serverId) : null,
      categories: privacy.NOTIFICATION_CATEGORIES,
    });
  } catch (e) { next(e); }
});

// PATCH /api/me/notification-prefs { categories, serverId? } — partial; only the
// boolean keys present are written.
router.patch('/notification-prefs', rateLimit({ windowMs: 60_000, max: 60 }), async (req, res, next) => {
  try {
    const body = req.body || {};
    const patch = {};
    for (const key of privacy.NOTIFICATION_CATEGORIES) {
      if (body[key] === undefined) continue;
      if (typeof body[key] !== 'boolean') {
        return fail(res, 'VALIDATION_ERROR', `\`${key}\` must be a boolean`);
      }
      patch[key] = body[key];
    }
    if (!Object.keys(patch).length) {
      return fail(res, 'VALIDATION_ERROR', 'nothing to update');
    }
    const serverId = body.serverId ? String(body.serverId) : null;
    const effective = await privacy.setNotificationPrefs(req.user.id, patch, serverId);
    events.emitTo(req.user.id, 'notification-prefs', { prefs: effective, serverId });
    res.json({ effective, serverId });
  } catch (e) { next(e); }
});

// ---- wellbeing -----------------------------------------------------------

// GET /api/me/wellbeing — DND, quiet hours and the motion preference.
router.get('/wellbeing', async (req, res, next) => {
  try {
    res.json(await privacy.getWellbeing(req.user.id));
  } catch (e) { next(e); }
});

// PATCH /api/me/wellbeing — partial. Times are minutes from local midnight,
// clamped rather than rejected, because a slider can legitimately land on a
// value one past the end and rejecting the whole save is worse than clamping.
router.patch('/wellbeing', rateLimit({ windowMs: 60_000, max: 60 }), async (req, res, next) => {
  try {
    const body = req.body || {};
    const patch = {};
    for (const key of ['dndEnabled', 'quietHoursOn', 'reducedMotion']) {
      if (body[key] === undefined) continue;
      if (typeof body[key] !== 'boolean') {
        return fail(res, 'VALIDATION_ERROR', `\`${key}\` must be a boolean`);
      }
      patch[key] = body[key];
    }
    for (const key of ['quietStart', 'quietEnd']) {
      if (body[key] === undefined) continue;
      const n = Number(body[key]);
      if (!Number.isFinite(n)) return fail(res, 'VALIDATION_ERROR', `\`${key}\` must be a number of minutes`);
      patch[key] = n;
    }
    if (!Object.keys(patch).length) {
      return fail(res, 'VALIDATION_ERROR', 'nothing to update');
    }
    const saved = await privacy.setWellbeing(req.user.id, patch);
    // Wellbeing changes what the client's own chrome does - motion, attention -
    // so a second client has to apply it without being told to refresh.
    events.emitTo(req.user.id, 'wellbeing', { wellbeing: saved });
    res.json(saved);
  } catch (e) { next(e); }
});

module.exports = router;
