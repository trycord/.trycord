// The voice runtime.
//
// This is where the provider is chosen. Everything above it - the routes, the
// console - asks this module, and this module asks the provider that is
// carrying the call.
//
// Two rules decide which provider that is:
//
//   1. A call that is already running keeps the provider it started on. The
//      provider is remembered beside the participant, so changing the setting
//      while people are talking does not move the call underneath them.
//   2. A new call uses the provider this instance is configured to use, and
//      only if that provider can actually carry it. A provider that is
//      selected but incomplete is refused with the list of what is missing -
//      the same list the diagnostics show.
//
// The permission checks, the participant limit and the screen-sharing rule
// are the same for every provider: they are asked of Trycord's own data, in
// services/voice.js, before a session is created.

'use strict';

const voice = require('../voice.js');
const voiceMesh = require('../voice-mesh.js');
const voiceConfig = require('./config');
const diagnostics = require('./diagnostics');
const sfu = require('./sfu');

// The provider carrying the call in this channel.
//
// A room that is running keeps the provider it started on; a room nobody is in
// takes the one this instance is configured to use.
async function providerFor(channelId) {
  const pinned = await voice.providerOfRoom(channelId);
  if (pinned && voiceConfig.isProvider(pinned)) return pinned;
  return voiceConfig.selected();
}

// The refusal a provider that cannot carry a session gets.
//
// It is the same refusal the diagnostics give, and it names what is missing.
function refuseIncomplete(provider) {
  const refusal = diagnostics.refusalOf(provider);
  if (refusal) throw refusal;
}

// The mesh's way of reaching a peer has to be there before a seat is given.
//
// The other providers are asked directly when the session is created, so an
// unreachable one fails there with the provider's own answer. The mesh has no
// such call: its peers find each other through the ICE addresses, so the
// addresses are checked first.
async function requireReachable(provider) {
  if (provider !== 'mesh') return;
  const check = await diagnostics.runCheck(provider);
  if (!check.ok) {
    throw {
      code: 'VOICE_PROVIDER_UNREACHABLE',
      message: check.detail || 'The mesh has no way to reach a peer at the moment.',
      status: 503,
    };
  }
}

// Start a session on the provider that will carry it.
async function startSession(provider, { channelId, userId }) {
  if (provider === 'mesh') {
    // The mesh keeps its rooms in memory, so a room that is empty in memory
    // but full in the database is a room from a previous run of the process.
    if (!voiceMesh.hasRoom(channelId)) await voice.clearStaleParticipants(channelId);
    const seat = await voiceMesh.join(channelId, userId);
    if (!seat.ok) throw seat;
    return seat.sessionId;
  }

  if (provider === 'cloudflare') {
    return voice.createSession();
  }

  const cfg = voiceConfig.configuration('sfu');
  return sfu.createSession(cfg);
}

// End a session on the provider that was carrying it.
async function stopSession(provider, sessionId, { channelId, userId }) {
  try {
    if (provider === 'mesh') {
      await voiceMesh.leave(channelId, userId);
      return;
    }
    if (provider === 'cloudflare') {
      await voice.endSession(sessionId);
      return;
    }
    const cfg = voiceConfig.configuration('sfu');
    await sfu.endSession(cfg, sessionId);
  } catch (error) {
    // The provider failing is not a reason to keep a participant who has left.
    // The session expires on its own; a stale participant row would not.
    console.error('[voice] could not end the media session', (error && error.message) || error);
  }
}

// The participant's own session, or null.
async function sessionOf(channelId, userId) {
  return voice.liveSession(channelId, userId);
}

// Join a voice channel.
async function join(channelId, userId) {
  const provider = await providerFor(channelId);
  refuseIncomplete(provider);

  const limit = voiceConfig.limit(provider);
  const verdict = await voice.authorizeVoice(channelId, userId, { maxParticipants: limit });
  if (!verdict.ok) throw verdict;

  const existing = await sessionOf(channelId, userId);
  if (existing) {
    return {
      sessionId: existing.session_id,
      roomId: existing.room_id,
      rejoined: true,
      provider,
    };
  }

  await requireReachable(provider);

  const roomId = await voice.ensureRoom(channelId, verdict.channel.server_id);

  let sessionId;
  try {
    sessionId = await startSession(provider, { channelId, userId });
  } catch (error) {
    if (error && error.status && error.code) throw error;
    throw {
      code: 'VOICE_PROVIDER_UNREACHABLE',
      message: 'The media server could not be reached: ' + ((error && error.message) || 'the connection failed') + '.',
      status: 503,
    };
  }

  const participantId = await voice.recordParticipant({
    channelId, userId, roomId, sessionId, provider,
  });

  return {
    participantId,
    roomId,
    sessionId,
    iceServers: await iceServersForChannel(channelId, userId),
    joined: true,
    provider,
  };
}

// Leave a voice channel.
//
// Leaving is a local fact first and a provider call second: a user whose
// socket dies is gone from Trycord's view immediately, and the media server is
// told when it can be.
async function leave(channelId, userId) {
  const provider = await providerFor(channelId);
  const row = await voice.endParticipant(channelId, userId);
  if (!row) return { ok: true };
  await stopSession(provider, row.session_id, { channelId, userId });
  return { ok: true };
}

// The ICE servers for a session that already exists.
async function iceServersForChannel(channelId, userId) {
  const provider = await providerFor(channelId);
  return voiceConfig.iceServers(provider, { credentials: true, userId });
}

// The mesh does not negotiate over HTTP: its signalling goes through the
// realtime gateway, between the peers themselves.
function signallingNotUsed(provider) {
  return {
    code: 'VOICE_SIGNALLING_NOT_USED',
    message: 'The mesh carries its signalling over the realtime gateway, between the peers. '
      + 'There is nothing to negotiate over HTTP.',
    status: 400,
  };
}

async function negotiate(channelId, userId, { tracks, sessionDescription }) {
  const provider = await providerFor(channelId);
  const session = await sessionOf(channelId, userId);
  if (!session) throw { code: 'NOT_FOUND', message: 'join the channel before negotiating', status: 404 };
  if (provider === 'mesh') throw signallingNotUsed(provider);

  if (provider === 'cloudflare') {
    return voice.negotiate({ sessionId: session.session_id, tracks, sessionDescription });
  }
  return sfu.negotiate(voiceConfig.configuration('sfu'), {
    sessionId: session.session_id, tracks, sessionDescription,
  });
}

async function answer(channelId, userId, { sessionDescription }) {
  const provider = await providerFor(channelId);
  const session = await sessionOf(channelId, userId);
  if (!session) throw { code: 'NOT_FOUND', message: 'join the channel before answering', status: 404 };
  if (provider === 'mesh') throw signallingNotUsed(provider);

  if (provider === 'cloudflare') {
    return voice.answer({ sessionId: session.session_id, sessionDescription });
  }
  return sfu.answer(voiceConfig.configuration('sfu'), {
    sessionId: session.session_id, sessionDescription,
  });
}

async function publishScreenShare(channelId, userId) {
  const provider = await providerFor(channelId);
  const session = await sessionOf(channelId, userId);
  if (!session) throw { code: 'NOT_FOUND', message: 'join the channel before sharing your screen', status: 404 };
  if (provider === 'mesh') throw signallingNotUsed(provider);

  if (provider === 'cloudflare') {
    return voice.publishScreenShare({ sessionId: session.session_id });
  }
  const cfg = voiceConfig.configuration('sfu');
  return sfu.negotiate(cfg, {
    sessionId: session.session_id,
    tracks: [{ location: 'local', trackName: 'screen' }],
  });
}

// The provider's own view of a session.
async function sessionState(channelId, userId) {
  const provider = await providerFor(channelId);
  const session = await sessionOf(channelId, userId);
  if (!session) return { tracks: [], dataChannels: [] };

  if (provider === 'mesh') return voiceMesh.roomState(channelId);
  if (provider === 'cloudflare') return voice.sessionState({ sessionId: session.session_id });
  return sfu.sessionState(voiceConfig.configuration('sfu'), { sessionId: session.session_id });
}

// Moderation applied through the provider: close a participant's media.
//
// On the mesh there is no track to close on a server, so the participant is
// told to stop publishing and the room drops the seat.
async function closeTrack(channelId, actorId, targetUserId, { mid } = {}) {
  const provider = await providerFor(channelId);
  const session = await sessionOf(channelId, targetUserId);
  if (!session) throw { code: 'NOT_FOUND', message: 'That person is not in this channel.', status: 404 };

  if (provider === 'mesh') {
    voiceMesh.relay(channelId, actorId, targetUserId, 'mute', { forced: true });
    return { ok: true };
  }
  if (provider === 'cloudflare') {
    return voice.closeTrack({ sessionId: session.session_id, mid });
  }
  return sfu.closeTrack(voiceConfig.configuration('sfu'), { sessionId: session.session_id, mid });
}

// A moderator forcing a participant's state, or disconnecting them.
async function moderate(channelId, actorId, targetUserId, options) {
  const provider = await providerFor(channelId);
  const result = await voice.moderate(channelId, actorId, targetUserId, options);
  if (result.disconnected) {
    await stopSession(provider, result.sessionId, { channelId, userId: targetUserId });
  }
  return result;
}

module.exports = {
  providerFor,
  join,
  leave,
  negotiate,
  answer,
  publishScreenShare,
  sessionState,
  closeTrack,
  moderate,
  iceServersForChannel,
  sessionOf,
};
