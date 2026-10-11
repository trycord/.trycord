// Voice and video routes.
//
// Every route asks the feature question at the service layer too, so a client that has
// not yet learned the flag is off still gets a consistent refusal rather than a 404 about
// a session that could never have existed.

const express = require('express');
const { fail, wrap } = require('../errors');
const limit = require('../middleware/ratelimit');
const auth = require('../middleware/auth');
const requireVerified = auth.requireVerified;
const voice = require('../services/voice');
const db = require('../db');

const router = express.Router();
router.use(auth);

// What this instance can do, and what it costs. Carries no credentials: the TURN URL is
// public by design, and its credential never appears here.
router.get('/capabilities', wrap(async (req, res) => {
  const f = require('../features').current;
  res.json({
    voiceVideo: await voice.available(),
    features: require('../features').capabilities(f),
  });
}));

// The ICE configuration for a session that already exists.
router.post('/credentials', requireVerified, limit({ windowMs: 60000, max: 20 }), wrap(async (req, res) => {
  const blocked = await gate();
  if (blocked) return fail(res, blocked.code, blocked.message, blocked.status);

  const { sessionId } = req.body || {};
  if (!sessionId) return fail(res, 'VALIDATION_ERROR', 'a session id is required');

  // The session must belong to this user, or a credential is being asked for someone
  // else's media session.
  const row = await db.get(
    'SELECT id FROM voice_participants WHERE session_id = ? AND user_id = ? AND left_at IS NULL',
    [sessionId, req.user.id]
  );
  if (!row) return fail(res, 'NOT_FOUND', 'that session is not yours');

  res.json({ iceServers: voice.iceServers() });
}));

// Join a voice channel. Authorization is the service's job, so this route stays thin.
router.post('/channels/:channelId/join', requireVerified, limit({ windowMs: 60000, max: 30 }), wrap(async (req, res) => {
  res.status(201).json(await voice.join(req.params.channelId, req.user.id));
}));

router.post('/channels/:channelId/leave', requireVerified, wrap(async (req, res) => {
  res.json(await voice.leave(req.params.channelId, req.user.id));
}));

router.post('/channels/:channelId/negotiate', requireVerified, limit({ windowMs: 60000, max: 60 }), wrap(async (req, res) => {
  const blocked = await gate();
  if (blocked) return fail(res, blocked.code, blocked.message, blocked.status);

  const sessionId = await sessionOf(req.params.channelId, req.user.id);
  if (!sessionId) return fail(res, 'NOT_FOUND', 'join the channel before negotiating');

  const { tracks, sessionDescription } = req.body || {};
  res.json(await voice.negotiate({ sessionId, tracks: tracks || [], sessionDescription }));
}));

router.post('/channels/:channelId/answer', requireVerified, limit({ windowMs: 60000, max: 60 }), wrap(async (req, res) => {
  const blocked = await gate();
  if (blocked) return fail(res, blocked.code, blocked.message, blocked.status);

  const sessionId = await sessionOf(req.params.channelId, req.user.id);
  if (!sessionId) return fail(res, 'NOT_FOUND', 'join the channel before answering');

  res.json(await voice.answer({ sessionId, sessionDescription: req.body && req.body.sessionDescription }));
}));

// Screen sharing is a separate publish because it is a separate permission, and the
// master flag has to permit it as well.
router.post('/channels/:channelId/screen', requireVerified, limit({ windowMs: 60000, max: 20 }), wrap(async (req, res) => {
  const blocked = await gate();
  if (blocked) return fail(res, blocked.code, blocked.message, blocked.status);

  const verdict = await voice.authorizeVoice(req.params.channelId, req.user.id, { screen: true });
  if (!verdict.ok) return fail(res, verdict.code, verdict.message, verdict.status);

  const sessionId = await sessionOf(req.params.channelId, req.user.id);
  if (!sessionId) return fail(res, 'NOT_FOUND', 'join the channel before sharing your screen');

  res.status(201).json(await voice.publishScreenShare({ sessionId }));
}));

router.get('/channels/:channelId/participants', wrap(async (req, res) => {
  res.json(await voice.participants(req.params.channelId, req.user.id));
}));

// The provider's view of one session, for a moderator diagnosing a connection.
router.get('/channels/:channelId/session', wrap(async (req, res) => {
  const blocked = await gate();
  if (blocked) return fail(res, blocked.code, blocked.message, blocked.status);

  const sessionId = await sessionOf(req.params.channelId, req.user.id);
  if (!sessionId) return fail(res, 'NOT_FOUND', 'join the channel first');

  try {
    res.json(await voice.sessionState({ sessionId }));
  } catch (e) {
    fail(res, e.code || 'SFU_ERROR', e.message, e.status);
  }
}));

// A moderator may force a mute, a deafen, or a disconnect.
router.post('/channels/:channelId/moderate/:userId', requireVerified, limit({ windowMs: 60000, max: 30 }), wrap(async (req, res) => {
  res.json(await voice.moderate(req.params.channelId, req.user.id, req.params.userId, req.body || {}));
}));

// Stage channels: an audience member asks to speak, and a moderator grants it.
router.post('/channels/:channelId/request-speak', requireVerified, wrap(async (req, res) => {
  res.json(await voice.requestSpeak(req.params.channelId, req.user.id));
}));

router.get('/channels/:channelId/speak-requests', wrap(async (req, res) => {
  const rows = await db.all(
    `SELECT r.id, r.user_id, r.created_at, u.username, u.display_name
       FROM voice_speak_requests r JOIN users u ON u.id = r.user_id
      WHERE r.channel_id = ? ORDER BY r.created_at`,
    [req.params.channelId]
  );
  res.json(rows.map((r) => ({
    id: r.id, userId: r.user_id, username: r.username,
    displayName: r.display_name, createdAt: r.created_at,
  })));
}));

// One refusal, asked once, so a disabled instance answers the same way on every route.
async function gate() {
  if (!require('../features').current.voiceVideo.enabled) {
    return { code: 'FEATURE_DISABLED', message: 'voice and video is disabled on this instance', status: 403 };
  }
  return null;
}

async function sessionOf(channelId, userId) {
  const row = await db.get(
    'SELECT session_id FROM voice_participants WHERE channel_id = ? AND user_id = ? AND left_at IS NULL',
    [channelId, userId]
  );
  return row ? row.session_id : null;
}

module.exports = router;
