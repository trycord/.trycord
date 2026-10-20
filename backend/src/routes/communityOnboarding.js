// Community onboarding.
//
// Three audiences, three sets of routes:
//
//   the administrator   the configuration: the welcome, the rules, the
//                       channels and the questions;
//   the member          what they are shown, and their own answers;
//   the writer          the record of the answers.
//
// The administrator's routes need the community's own permission, and the
// member's routes need membership: an answer is recorded against a member,
// so a stranger has nothing to answer for.

const express = require('express');
const { fail, wrap } = require('../errors');
const rateLimit = require('../middleware/ratelimit');
const auth = require('../middleware/auth');
const { resolveServer, requireMember, requirePerm } = require('../middleware/serverAccess');
const onboarding = require('../services/community/onboarding');

// The router merges the mount's parameters, so `req.params.serverId` is the
// community the request is about. Without it the community is null and every
// route answers "server not found".
const router = express.Router({ mergeParams: true });

// Every route here is about a community, so every route here needs a signed-in
// reader: the community is resolved once, for the lot, and the routes say
// what they need on top of that.
router.use(auth, resolveServer);

// ---- the administrator ------------------------------------------------------

// GET /api/servers/:id/onboarding
//
// The configuration, and the roles an answer may hand out. The roles are in
// the answer because the picker may only offer what the answer would give:
// a role that would be refused is not offered, and the refusal is about the
// role rather than about the member.
router.get('/', requirePerm('MANAGE_SERVER'),
  wrap(async (req, res) => {
    const config = await onboarding.configuration(req.server.id);
    res.json({
      onboarding: config,
      eligibleRoles: await onboarding.eligibleRoles(req.server.id, req.user.id),
    });
  }));

// PUT /api/servers/:id/onboarding
//
// The configuration, saved.
//
// The questions are replaced wholesale, because an option carries what an
// answer may do: editing one in place would leave an answer recorded
// against options that no longer mean what they meant.
router.put('/', requirePerm('MANAGE_SERVER'),
  rateLimit({ windowMs: 60000, max: 30, key: 'community:onboarding' }),
  wrap(async (req, res) => {
    res.json({
      onboarding: await onboarding.save(req.server.id, req.user.id, req.body || {}),
    });
  }));

// ---- the member -------------------------------------------------------------

// GET /api/servers/:id/onboarding/preview
//
// What the member is shown when they arrive.
router.get('/preview', requireMember,
  wrap(async (req, res) => {
    res.json({ onboarding: await onboarding.preview(req.server.id, req.user.id) });
  }));

// GET /api/servers/:id/onboarding/me
//
// The member's own answers, and the channels those answers revealed.
//
// A member may change their mind later: the answers are theirs, and they
// are the only ones who may change them.
router.get('/me', requireMember,
  wrap(async (req, res) => {
    res.json(await onboarding.mine(req.server.id, req.user.id));
  }));

// POST /api/servers/:id/onboarding/answers
//
// The member's answers, recorded.
//
// The roles an answer gives are checked again here, against the roles as they
// are now: the picker offered what was eligible when the question was
// written, and the world may have moved since.
router.post('/answers', requireMember,
  rateLimit({ windowMs: 60000, max: 30, key: 'community:onboarding' }),
  wrap(async (req, res) => {
    res.json(await onboarding.answer(req.server.id, req.user.id, req.body || {}));
  }));

module.exports = router;
