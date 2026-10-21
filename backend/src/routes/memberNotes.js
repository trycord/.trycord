// A moderator's note about a member.
//
// The notes of a community. Who may read them, who may write them, and the
// rule that matters most: the member a note is about never sees it.
//
// The gate is the moderation family - somebody who may remove a member, ban
// one, or run the community may keep notes about the people in it. Anybody
// else is refused, and the refusal says which permissions would open the
// door.

'use strict';

const auth = require('../middleware/auth');
const { resolveServer, requireAnyPerm } = require('../middleware/serverAccess');
const { fail } = require('../errors');
const notes = require('../services/community/notes');
const rateLimit = require('../middleware/ratelimit');

// mergeParams: the community's id is in the mount, not in the routes here, and
// the routes have to be able to see it.
//
// The chain is authentication and the community itself, once, at the edge:
// every route below is inside a community, and none of them has to work out
// who the community is.
const router = require('express').Router({ mergeParams: true });
router.use(auth, resolveServer);

// The permissions that open this door. The family of moderation: somebody
// who may remove a member, ban one, or run the community.
const MODERATION = ['KICK_MEMBERS', 'BAN_MEMBERS', 'MANAGE_SERVER'];

// The member the note is about has to be in the community: a note about
// somebody who is not here is a note about nobody.
async function memberOf(req, res) {
  const { isMember } = require('../util');
  const userId = String(req.params.userId || '');
  if (!userId) {
    fail(res, 'VALIDATION_ERROR', 'a member is needed');
    return null;
  }
  if (!(await isMember(userId, req.server.id))) {
    fail(res, 'NOT_A_MEMBER', 'that person is not in this community');
    return null;
  }
  return userId;
}

// Every note in the community, so the roster can say who has one.
router.get('/', requireAnyPerm(MODERATION), async (req, res, next) => {
  try {
    const rows = await notes.list(req.server.id);
    res.json({ notes: rows.map(notes.shown) });
  } catch (e) { next(e); }
});

// The note about one member.
router.get('/:userId', requireAnyPerm(MODERATION), async (req, res, next) => {
  try {
    const userId = await memberOf(req, res);
    if (!userId) return;
    const note = await notes.read(req.server.id, userId);
    res.json({ note: notes.shown(note) });
  } catch (e) { next(e); }
});

// Write the note about one member.
router.put('/:userId', requireAnyPerm(MODERATION),
  rateLimit({ windowMs: 60000, max: 60 }), async (req, res, next) => {
    try {
      const userId = await memberOf(req, res);
      if (!userId) return;
      const note = await notes.write(req.server.id, userId, req.user.id, (req.body || {}).body);
      res.json({ ok: true, note: notes.shown(note) });
    } catch (e) {
      if (e && e.code) return fail(res, e.code, e.message);
      next(e);
    }
  });

// Take the note about one member away.
router.delete('/:userId', requireAnyPerm(MODERATION),
  rateLimit({ windowMs: 60000, max: 60 }), async (req, res, next) => {
    try {
      const userId = await memberOf(req, res);
      if (!userId) return;
      const removed = await notes.remove(req.server.id, userId);
      res.json({ ok: true, removed });
    } catch (e) { next(e); }
  });

module.exports = router;
