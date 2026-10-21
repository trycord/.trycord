// Voice and video routes.
//
// Every route asks the feature question at the service layer too, so a client that has
// not yet learned the flag is off still gets a consistent refusal rather than a 404 about
// a session that could never have existed.
//
// The provider is chosen in the service layer, not here: a route says what a member
// wants to do and the service decides which media path carries it. The routes at the
// bottom are the administrative ones - the console asks them what the providers are,
// what they are missing, and whether the other end answers.

const express = require('express');
const { fail, wrap } = require('../errors');
const limit = require('../middleware/ratelimit');
const auth = require('../middleware/auth');
const adminGuard = require('../middleware/adminGuard');
const requireVerified = auth.requireVerified;
const voice = require('../services/voice');
const adapters = require('../services/voice/adapters');
const voiceConfig = require('../services/voice/config');
const diagnostics = require('../services/voice/diagnostics');
const permissions = require('../services/permissions');
const db = require('../db');

const router = express.Router();
router.use(auth);

// The refusals the voice services raise that the shared error map does not know
// about. Each one names what has to change, so it is sent as it is rather than
// as an internal error.
function voiceFailure(res, error) {
  if (!error || typeof error.code !== 'string') return false;
  if (error.code.startsWith('VOICE_')) {
    fail(res, error.code, error.message, error.status || 503);
    return true;
  }
  if (error.code === 'CAPACITY_EXCEEDED') {
    fail(res, 'ROOM_FULL', error.message, 429);
    return true;
  }
  if (error.code === 'FORBIDDEN') {
    fail(res, 'PERMISSION_DENIED', error.message, 403);
    return true;
  }
  return false;
}

// What this instance can do, and what it costs. Carries no credentials: the TURN URL is
// public by design, and its credential never appears here.
//
// The probe behind `voice.available()` opens a session with the provider on every call, so
// this is throttled like any other route that reaches a paid upstream: an unauthenticated
// loop against it would otherwise be a free way to spend the instance's provider budget.
router.get('/capabilities', limit({ windowMs: 60000, max: 30, key: 'voice-capabilities' }), wrap(async (req, res) => {
  const f = require('../features').current;
  res.json({
    voiceVideo: await voice.available(),
    features: require('../features').capabilities(f),
  });
}));

// ---- the administrative surface ---------------------------------------------

// Every provider, its own settings, and what state it is in.
//
// This is what the console renders: the provider in force, the shared controls,
// and each provider's fields with its secrets reported as set or not set.
router.get('/providers', adminGuard, wrap(async (req, res) => {
  res.json(await diagnostics.report());
}));

// One provider's connectivity, checked for real.
//
// The check reaches the other end: it opens a session on the SFU, it asks the
// media server whether it is there, or it sends a binding request to the relay
// the mesh hands to its peers.
router.post('/providers/:providerId/check', adminGuard, limit({ windowMs: 60000, max: 20, key: 'voice-provider-check' }), wrap(async (req, res) => {
  const providerId = String(req.params.providerId || '').toLowerCase();
  if (!voiceConfig.isProvider(providerId)) {
    return fail(res, 'NOT_FOUND', 'No such provider.', 404);
  }
  const check = await diagnostics.runCheck(providerId, { force: true });
  res.json({
    provider: providerId,
    ok: check.ok,
    detail: check.detail,
    checkedAt: check.at,
    missing: voiceConfig.missing(providerId),
  });
}));

// ---- the session ------------------------------------------------------------

// The ICE configuration for a session that already exists.
//
// The credential travels here and nowhere else: this route is behind the
// verification gate and only answers for a session that belongs to the caller.
router.post('/credentials', requireVerified, limit({ windowMs: 60000, max: 20 }), wrap(async (req, res) => {
  const blocked = await gate();
  if (blocked) return fail(res, blocked.code, blocked.message, blocked.status);

  const { sessionId } = req.body || {};
  if (!sessionId) return fail(res, 'VALIDATION_ERROR', 'a session id is required');

  // The session must belong to this user, or a credential is being asked for someone
  // else's media session.
  const row = await db.get(
    'SELECT id, channel_id FROM voice_participants WHERE session_id = ? AND user_id = ? AND left_at IS NULL',
    [sessionId, req.user.id]
  );
  if (!row) return fail(res, 'NOT_FOUND', 'that session is not yours');

  res.json({ iceServers: await adapters.iceServersForChannel(row.channel_id, req.user.id) });
}));

// Join a voice channel. Authorization is the service's job, so this route stays thin.
router.post('/channels/:channelId/join', requireVerified, limit({ windowMs: 60000, max: 30 }), wrap(async (req, res) => {
  try {
    res.status(201).json(await adapters.join(req.params.channelId, req.user.id));
  } catch (e) {
    if (!voiceFailure(res, e)) throw e;
  }
}));

router.post('/channels/:channelId/leave', requireVerified, wrap(async (req, res) => {
  res.json(await adapters.leave(req.params.channelId, req.user.id));
}));

router.post('/channels/:channelId/negotiate', requireVerified, limit({ windowMs: 60000, max: 60 }), wrap(async (req, res) => {
  const blocked = await gate();
  if (blocked) return fail(res, blocked.code, blocked.message, blocked.status);

  const { tracks, sessionDescription } = req.body || {};
  try {
    res.json(await adapters.negotiate(req.params.channelId, req.user.id, { tracks: tracks || [], sessionDescription }));
  } catch (e) {
    if (!voiceFailure(res, e)) throw e;
  }
}));

router.post('/channels/:channelId/answer', requireVerified, limit({ windowMs: 60000, max: 60 }), wrap(async (req, res) => {
  const blocked = await gate();
  if (blocked) return fail(res, blocked.code, blocked.message, blocked.status);

  try {
    res.json(await adapters.answer(req.params.channelId, req.user.id, {
      sessionDescription: req.body && req.body.sessionDescription,
    }));
  } catch (e) {
    if (!voiceFailure(res, e)) throw e;
  }
}));

// Screen sharing is a separate publish because it is a separate permission, and the
// master flag has to permit it as well.
router.post('/channels/:channelId/screen', requireVerified, limit({ windowMs: 60000, max: 20 }), wrap(async (req, res) => {
  const blocked = await gate();
  if (blocked) return fail(res, blocked.code, blocked.message, blocked.status);

  const verdict = await voice.authorizeVoice(req.params.channelId, req.user.id, { screen: true });
  if (!verdict.ok) return fail(res, verdict.code, verdict.message, verdict.status);

  try {
    res.status(201).json(await adapters.publishScreenShare(req.params.channelId, req.user.id));
  } catch (e) {
    if (!voiceFailure(res, e)) throw e;
  }
}));

router.put('/channels/:channelId/state', requireVerified, wrap(async (req, res) => {
  const blocked = await gate();
  if (blocked) return fail(res, blocked.code, blocked.message, blocked.status);

  res.json(await voice.setSelfState(req.params.channelId, req.user.id, req.body || {}));
}));

router.get('/channels/:channelId/participants', wrap(async (req, res) => {
  res.json(await voice.participants(req.params.channelId, req.user.id));
}));

// The provider's view of one session, for a moderator diagnosing a connection.
router.get('/channels/:channelId/session', wrap(async (req, res) => {
  const blocked = await gate();
  if (blocked) return fail(res, blocked.code, blocked.message, blocked.status);

  try {
    res.json(await adapters.sessionState(req.params.channelId, req.user.id));
  } catch (e) {
    if (!voiceFailure(res, e)) throw e;
  }
}));

// A moderator may force a mute, a deafen, or a disconnect.
router.post('/channels/:channelId/moderate/:userId', requireVerified, limit({ windowMs: 60000, max: 30 }), wrap(async (req, res) => {
  try {
    res.json(await adapters.moderate(req.params.channelId, req.user.id, req.params.userId, req.body || {}));
  } catch (e) {
    if (!voiceFailure(res, e)) throw e;
  }
}));

// Stage channels: an audience member asks to speak, and a moderator grants it.
router.post('/channels/:channelId/request-speak', requireVerified, limit({ windowMs: 60000, max: 30, key: 'voice-request-speak' }), wrap(async (req, res) => {
  res.json(await voice.requestSpeak(req.params.channelId, req.user.id));
}));

router.get('/turn/credentials', requireVerified, wrap(async (req, res) => {
  const turn = require('../services/turn');
  res.json(turn.issueCredentials(req.user.id));
}));

router.get('/channels/:channelId/speak-requests', requireVerified, wrap(async (req, res) => {
  const blocked = await gate();
  if (blocked) return fail(res, blocked.code, blocked.message, blocked.status);

  const ch = await db.get('SELECT server_id FROM channels WHERE id = ?', [req.params.channelId]);
  if (!ch) return fail(res, 'NOT_FOUND', 'channel not found');
  const member = await db.get(
    'SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?',
    [ch.server_id, req.user.id]
  );
  if (!member) return fail(res, 'NOT_A_MEMBER', 'you are not a member of this community', 403);
  if (!await permissions.hasPermission(req.user.id, ch.server_id, 'MUTE_MEMBERS')) {
    return fail(res, 'PERMISSION_DENIED', 'you cannot manage stage requests', 403);
  }

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
    return { code: 'FEATURE_DISABLED', message: 'Voice and video are off on this instance.', status: 403 };
  }
  return null;
}

// In-house WebRTC mesh (self-hosted peer-to-peer) signaling. Room cleanup happens on
// leave and on disconnect (handled by services/voice-mesh.cleanupUser on WS close).
//
// The mesh join is the same join every other provider gets: the permission
// checks, the participant limit and the provider in force are all asked of the
// service layer, so a mesh seat is held to the same rules as an SFU session.
router.post('/channels/:channelId/mesh-join', requireVerified, wrap(async (req, res) => {
  try {
    res.status(201).json(await adapters.join(req.params.channelId, req.user.id));
  } catch (e) {
    if (!voiceFailure(res, e)) throw e;
  }
}));

router.post('/channels/:channelId/mesh-leave', requireVerified, wrap(async (req, res) => {
  res.json(await adapters.leave(req.params.channelId, req.user.id));
}));

router.get('/channels/:channelId/mesh-peers', requireVerified, wrap(async (req, res) => {
  const voiceMesh = require('../services/voice-mesh');
  const voice = require('../services/voice');
  const room = await voiceMesh.participants(req.params.channelId);
  // The peers and the people: the ids are what the mesh connects, and the
  // names are what the reader reads. Both, so a client does not have to
  // guess who is in the room from a list of ids.
  res.json(Object.assign({}, room, { people: await voice.occupants(req.params.channelId) }));
}));

router.post('/channels/:channelId/mesh-signal', requireVerified, limit({ windowMs: 60000, max: 600 }), wrap(async (req, res) => {
  const { to, kind, payload } = req.body || {};
  if (!to || typeof to !== 'string' && typeof to !== 'number') return fail(res, 'VALIDATION_ERROR', 'target peer id required', 400);
  if (!['offer', 'answer', 'ice', 'mute', 'leave'].includes(kind)) return fail(res, 'VALIDATION_ERROR', 'unknown signal kind', 400);
  const voiceMesh = require('../services/voice-mesh');
  if (!voiceMesh.relay(req.params.channelId, req.user.id, to, kind, payload)) {
    return fail(res, 'NOT_FOUND', 'target peer not in room', 404);
  }
  res.json({ ok: true });
}));

module.exports = router;
