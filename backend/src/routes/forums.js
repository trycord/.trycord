// The forum routes.
//
// A forum is a channel of type 'forum'. Its topics are the channel's root
// messages, and the discussion under a topic is the existing thread - the
// same route, the same rows and the same permissions as everywhere else.
//
// The routes are mounted under the channel prefix so they share the one
// access chain: a topic cannot be read through a forum route by somebody who
// could not read the channel.
const express = require('express');
const db = require('../db');
const auth = require('../middleware/auth');
const rateLimit = require('../middleware/ratelimit');
const { fail, serviceError } = require('../errors');
const { visibleChannel } = require('../util');
const forums = require('../services/forums');
const threads = require('../services/threads');

// The router is mounted under a path with a parameter in it, so the mount's
// parameters have to be merged in - that is the convention every other router
// in this application follows.
const router = express.Router({ mergeParams: true });
router.use(auth);

// GET /topics — the topics of a forum. Mounted at /api/channels/:channelId.
//
// The channel is permission-checked exactly as the history read is, so a
// forum route cannot be used to read a channel the reader cannot otherwise
// see.
router.get('/topics', rateLimit({ windowMs: 60000, max: 60 }), async (req, res, next) => {
  try {
    const channel = await visibleChannel(req.params.channelId, req.user.id);
    if (!channel) return fail(res, 'NOT_A_MEMBER', 'channel not found or not a member');
    if (!forums.isForum(channel)) {
      return fail(res, 'VALIDATION_ERROR', 'that channel is not a forum');
    }
    const out = await forums.topics(channel, {
      limit: req.query.limit,
      offset: req.query.offset,
      sort: req.query.sort,
      q: req.query.q,
    });
    // Which of these the reader is following, so the list can show it without
    // a request per topic.
    const following = await forums.subscribedTo(req.user.id, out.topics.map((t) => t.id));
    out.topics.forEach((t) => { t.subscribed = !!following[t.id]; });
    res.json(out);
  } catch (e) { serviceError(res, e); }
});

// GET /topics/:messageId — one topic and its replies.
//
// This is the existing thread route's answer, under a name that says what it
// is in a forum. The thread model is the thread model.
router.get('/topics/:messageId', rateLimit({ windowMs: 60000, max: 60 }), async (req, res, next) => {
  try {
    const channel = await visibleChannel(req.params.channelId, req.user.id);
    if (!channel) return fail(res, 'NOT_A_MEMBER', 'channel not found or not a member');
    const thread = await threads.fetch('channel', channel.id, req.params.messageId);
    if (!thread) return fail(res, 'NOT_FOUND', 'topic not found');
    const following = await forums.subscribedTo(req.user.id, [req.params.messageId]);
    res.json({
      topic: thread.root,
      replies: thread.replies,
      subscribed: !!following[req.params.messageId],
    });
  } catch (e) { serviceError(res, e); }
});

// POST /topics/:messageId/subscribe — follow a topic.
router.post('/topics/:messageId/subscribe', rateLimit({ windowMs: 60000, max: 30 }),
  async (req, res, next) => {
    try {
      const channel = await visibleChannel(req.params.channelId, req.user.id);
      if (!channel) return fail(res, 'NOT_A_MEMBER', 'channel not found or not a member');
      res.json(await forums.subscribe(req.user.id, channel.id, req.params.messageId));
    } catch (e) { serviceError(res, e); }
  });

// DELETE /topics/:messageId/subscribe — stop following.
router.delete('/topics/:messageId/subscribe', rateLimit({ windowMs: 60000, max: 30 }),
  async (req, res, next) => {
    try {
      const channel = await visibleChannel(req.params.channelId, req.user.id);
      if (!channel) return fail(res, 'NOT_A_MEMBER', 'channel not found or not a member');
      res.json(await forums.unsubscribe(req.user.id, req.params.messageId));
    } catch (e) { serviceError(res, e); }
  });

// GET /subscriptions — the topics this reader follows in this channel.
router.get('/subscriptions', rateLimit({ windowMs: 60000, max: 60 }), async (req, res, next) => {
  try {
    const channel = await visibleChannel(req.params.channelId, req.user.id);
    if (!channel) return fail(res, 'NOT_A_MEMBER', 'channel not found or not a member');
    const all = await forums.subscriptions(req.user.id, { limit: 200 });
    res.json({ subscriptions: all.filter((s) => s.channelId === channel.id) });
  } catch (e) { serviceError(res, e); }
});

module.exports = router;
