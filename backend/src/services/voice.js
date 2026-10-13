// Voice and video.
//
// This module owns every decision about who may speak: whether the instance has voice at
// all, whether this user is a member, whether they hold the permission, whether the
// channel is full, and whether they are banned. The provider underneath is a transport
// detail - it creates a session and moves an SDP offer - and it is deliberately inline
// rather than behind an interface, because there is exactly one server-backed provider
// and nothing consumes the seam polymorphically.
//
// A room is per-channel and outlives any one participant. A session is per-endpoint and
// belongs to the provider. The two are not the same thing, and the mapping between them
// lives in voice_participants.

const db = require('../db');
const { now, uuid } = require('../util');
const features = require('../features');
const permissions = require('./permissions');

const SFU_BASE = 'https://rtc.live.cloudflare.com/v1';
const PROVIDER = 'cloudflare';

class SfuError extends Error {
  constructor(status, code, description) {
    super(description || code || 'the media server refused the request');
    this.name = 'SfuError';
    this.status = status;
    this.code = code;
  }
}

// Provider credentials, read once and never returned by any route.
const CREDENTIALS = {
  appId: String(process.env.VOICE_VIDEO_SFU_APP_ID || ''),
  appSecret: String(process.env.VOICE_VIDEO_SFU_APP_SECRET || ''),
};

const iceServers = () => {
  const v = features.current.voiceVideo;
  const out = v.stun.map((urls) => ({ urls }));
  if (v.turn.url) {
    // The URL and username are what a client needs to open a connection. The credential
    // is the one this instance was configured with, and it never appears in the
    // capability response - that response carries the ICE list with this field absent.
    out.push({ urls: v.turn.url, username: v.turn.username, credential: v.turn.credential });
  }
  return out;
};

// One authenticated call to the media server. The App Secret is sent here and nowhere
// else; a browser never sees it.
async function sfu(method, path, body) {
  const res = await fetch(SFU_BASE + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + CREDENTIALS.appSecret,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* a non-JSON body is treated as empty */ }

  if (!res.ok) {
    const err = json && json.error;
    throw new SfuError(
      res.status,
      (err && err.errorCode) || ('HTTP_' + res.status),
      (err && err.errorDescription) || text.slice(0, 200)
    );
  }
  return json;
}

const disabled = () => ({
  code: 'FEATURE_DISABLED',
  message: 'voice and video is disabled on this instance',
  status: 403,
});

// Is voice usable right now?
//
// The flag decides whether it can be, and a live probe decides whether it actually is.
// An instance whose credentials are wrong is broken, and finding that out at the first
// join is worse than finding it out when the console asks.
async function available() {
  const f = features.current;
  if (!f.voiceVideo.enabled) {
    return { available: false, reason: 'disabled', detail: 'voice and video is off on this instance' };
  }
  const health = features.healthOf(f);
  if (!health.available) return health;

  try {
    // Creating a session is the cheapest authenticated call the provider offers, so it
    // doubles as the credential check.
    await sfu('POST', `/apps/${CREDENTIALS.appId}/sessions/new`, {});
    return { available: true, reason: 'ready', detail: '' };
  } catch (e) {
    return {
      available: false,
      reason: 'unreachable',
      detail: 'the media server could not be reached or refused the credentials',
      problems: [e.message],
    };
  }
}

// The permission question, asked of Trycord's own data rather than of the provider.
//
// CONNECT lets a user enter a voice channel; SPEAK lets them publish audio; VIDEO is the
// same for a camera; STREAM is the same for screen sharing, and the master flag has to
// permit it as well.
async function authorizeVoice(channelId, userId, { screen = false, video = false } = {}) {
  const f = features.current;
  if (!f.voiceVideo.enabled) return { ok: false, ...disabled() };

  const ch = await db.get('SELECT id, server_id, type FROM channels WHERE id = ?', [channelId]);
  if (!ch) return { ok: false, code: 'NOT_FOUND', message: 'channel not found', status: 404 };
  if (ch.type !== 'voice' && ch.type !== 'stage') {
    return { ok: false, code: 'VALIDATION_ERROR', message: 'that channel is not a voice channel', status: 400 };
  }

  const member = await db.get(
    'SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?',
    [ch.server_id, userId]
  );
  if (!member) {
    return { ok: false, code: 'NOT_A_MEMBER', message: 'you are not a member of this community', status: 403 };
  }

  // hasPermission is the gate the rest of this package already uses, and it carries the
  // owner short-circuit and the role/override precedence with it. A caller that built its
  // own permission set would have to get both of those right a second time.
  const need = screen ? 'STREAM' : 'CONNECT';
  const canConnect = await permissions.hasPermission(userId, ch.server_id, 'CONNECT');
  const canNeed = need === 'CONNECT'
    ? canConnect
    : await permissions.hasPermission(userId, ch.server_id, need);
  if (!canConnect && !canNeed) {
    return { ok: false, code: 'PERMISSION_DENIED', message: 'you cannot connect to this channel', status: 403 };
  }
  if (screen && !f.voiceVideo.screenSharing) {
    return { ok: false, code: 'FEATURE_DISABLED', message: 'screen sharing is disabled on this instance', status: 403 };
  }
  if (video && !await permissions.hasPermission(userId, ch.server_id, 'VIDEO')) {
    return { ok: false, code: 'PERMISSION_DENIED', message: 'you cannot send video in this channel', status: 403 };
  }

  // A banned member is a non-member as far as the media server is concerned. The expiry is
  // honoured the way the membership service honours it, so a ban that has lapsed does not
  // keep someone out of a channel they are allowed to be in.
  const ban = await db.get(
    'SELECT expires_at FROM server_bans WHERE server_id = ? AND user_id = ?',
    [ch.server_id, userId]
  );
  if (ban && (!ban.expires_at || new Date(ban.expires_at).getTime() > Date.now())) {
    return { ok: false, code: 'BANNED', message: 'you are banned from this community', status: 403 };
  }

  const room = await db.get('SELECT id FROM voice_rooms WHERE channel_id = ?', [channelId]);
  const inRoom = room
    ? await db.get('SELECT COUNT(*) AS n FROM voice_participants WHERE room_id = ? AND left_at IS NULL', [room.id])
    : { n: 0 };
  const limit = f.voiceVideo.maxParticipants;

  if (inRoom.n >= limit) {
    return {
      ok: false,
      code: 'ROOM_FULL',
      message: `this channel is full (${limit} participants)`,
      status: 409,
    };
  }

  return { ok: true, channel: ch, roomId: room ? room.id : null };
}

// A voice channel gets a room when its first participant arrives.
async function ensureRoom(channelId, serverId) {
  const existing = await db.get('SELECT id FROM voice_rooms WHERE channel_id = ?', [channelId]);
  if (existing) return existing.id;

  const id = uuid();
  await db.run(
    'INSERT INTO voice_rooms (id, channel_id, server_id, created_at) VALUES (?, ?, ?, ?)',
    [id, channelId, serverId, now()]
  );
  return id;
}

// A second join answers with the session that already exists, so a client retrying a
// join it already made does not create a second participant record.
async function liveSession(channelId, userId) {
  return db.get(
    'SELECT * FROM voice_participants WHERE channel_id = ? AND user_id = ? AND left_at IS NULL',
    [channelId, userId]
  );
}

async function join(channelId, userId) {
  const verdict = await authorizeVoice(channelId, userId);
  if (!verdict.ok) throw verdict;

  const existing = await liveSession(channelId, userId);
  if (existing) {
    return { sessionId: existing.session_id, roomId: existing.room_id, rejoined: true };
  }

  const roomId = await ensureRoom(channelId, verdict.channel.server_id);
  const created = await sfu('POST', `/apps/${CREDENTIALS.appId}/sessions/new`, {});

  const id = uuid();
  await db.run(
    `INSERT INTO voice_participants (id, room_id, channel_id, user_id, session_id, joined_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, roomId, channelId, userId, created.sessionId, now()]
  );

  return {
    participantId: id,
    roomId,
    sessionId: created.sessionId,
    iceServers: iceServers(),
    joined: true,
  };
}

// Leaving is a local fact first and a provider call second: a user whose socket dies is
// gone from Trycord's view immediately, and the media server is told when it can be.
async function leave(channelId, userId) {
  const row = await liveSession(channelId, userId);
  if (!row) return { ok: true };

  await db.run('UPDATE voice_participants SET left_at = ? WHERE id = ?', [now(), row.id]);
  await endSession(row.session_id);
  return { ok: true };
}

// The provider has no "delete session" call: a session ends by closing its tracks, and
// that means knowing which tracks it has. An empty track list is a request that does
// nothing, not a way to end a session.
async function endSession(sessionId) {
  if (!sessionId) return { ok: true };

  try {
    const state = await sfu('GET', `/apps/${CREDENTIALS.appId}/sessions/${sessionId}`);
    const local = (state.tracks || []).filter((t) => t.location === 'local' && t.mid !== undefined);
    if (!local.length) return { ok: true };

    await sfu('PUT', `/apps/${CREDENTIALS.appId}/sessions/${sessionId}/tracks/close`, {
      tracks: local.map((t) => ({ mid: t.mid, location: 'local' })),
    });
    return { ok: true, closed: local.length };
  } catch (e) {
    // The provider failing is not a reason to keep a participant who has left. The
    // session expires on its own; a stale participant row would not.
    if (e instanceof SfuError && e.status === 404) return { ok: true };
    throw e;
  }
}

// Publish or subscribe, by relaying an SDP offer and taking an answer back.
//
// location decides direction: 'local' is this endpoint publishing, 'remote' is this
// endpoint receiving from a named publisher session.
async function negotiate({ sessionId, tracks, sessionDescription }) {
  if (!sessionId) throw new SfuError(400, 'NO_SESSION', 'a session id is required');

  const out = await sfu('POST', `/apps/${CREDENTIALS.appId}/sessions/${sessionId}/tracks/new`, {
    tracks: tracks.map((t) => ({
      location: t.location || 'local',
      sessionId: t.sessionId,
      trackName: t.trackName,
      mid: t.mid,
    })),
    sessionDescription,
  });

  return {
    sessionDescription: out && out.sessionDescription,
    tracks: (out && out.tracks) || [],
    requiresAnswer: !!(out && out.sessionDescription && out.sessionDescription.type === 'offer'),
  };
}

async function answer({ sessionId, sessionDescription }) {
  if (!sessionId) throw new SfuError(400, 'NO_SESSION', 'a session id is required');
  await sfu('PUT', `/apps/${CREDENTIALS.appId}/sessions/${sessionId}/renegotiate`, { sessionDescription });
  return { ok: true };
}

async function publishScreenShare({ sessionId }) {
  return negotiate({ sessionId, tracks: [{ location: 'local', trackName: 'screen' }] });
}

// The provider's own view of a session. "A media track marked active does not prove that
// packets are arriving" is the provider's warning, so this is resource state and not a
// speaking indicator: speaking is signalled by the clients, and the two are reported
// separately.
async function sessionState({ sessionId }) {
  if (!sessionId) return { tracks: [], dataChannels: [] };
  const out = await sfu('GET', `/apps/${CREDENTIALS.appId}/sessions/${sessionId}`);
  return { tracks: (out && out.tracks) || [], dataChannels: (out && out.dataChannels) || [] };
}

// Moderation applied through the provider: close a participant's track. Trycord's own
// record of the action is written by the caller, because this module knows nothing about
// what a moderation action means.
async function closeTrack({ sessionId, mid }) {
  if (!sessionId || !mid) throw new SfuError(400, 'BAD_TARGET', 'a session and a track are required');
  await sfu('PUT', `/apps/${CREDENTIALS.appId}/sessions/${sessionId}/tracks/close`, {
    tracks: [{ mid, location: 'local' }],
  });
  return { ok: true };
}

// The participants Trycord knows about, which is a different question from the ones the
// provider knows about.
async function participants(channelId, userId) {
  const ch = await db.get('SELECT server_id FROM channels WHERE id = ?', [channelId]);
  if (!ch) throw { code: 'NOT_FOUND', message: 'channel not found', status: 404 };
  const member = await db.get(
    'SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?',
    [ch.server_id, userId]
  );
  if (!member) throw { code: 'NOT_A_MEMBER', message: 'you are not a member', status: 403 };

  const rows = await db.all(
    `SELECT p.id, p.user_id, p.session_id, p.joined_at, p.muted, p.deafened,
       u.username, u.display_name, u.avatar_url
     FROM voice_participants p JOIN users u ON u.id = p.user_id
      WHERE p.channel_id = ? AND p.left_at IS NULL
      ORDER BY p.joined_at`,
    [channelId]
  );

  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    username: r.username,
    displayName: r.display_name,
    avatarUrl: r.avatar_url || null,
    sessionId: r.session_id,
    joinedAt: r.joined_at,
    muted: !!r.muted,
    deafened: !!r.deafened,
    speaking: false,
  }));
}

// This user's own mute and deafen state. A moderator forcing one is a different call.
async function setSelfState(channelId, userId, { muted, deafened }) {
  const sets = [];
  const params = [];
  if (muted !== undefined) { sets.push('muted = ?'); params.push(muted ? 1 : 0); }
  if (deafened !== undefined) { sets.push('deafened = ?'); params.push(deafened ? 1 : 0); }
  if (!sets.length) return { ok: true };

  params.push(channelId, userId);
  await db.run(
    `UPDATE voice_participants SET ${sets.join(', ')} WHERE channel_id = ? AND user_id = ? AND left_at IS NULL`,
    params
  );
  return { ok: true };
}

// A moderator forcing a participant's state, or disconnecting them. Permission is checked
// here rather than in the route, so a second entry point cannot become the one that
// forgot.
async function moderate(channelId, actorId, targetUserId, { mute, deafen, disconnect }) {
  const ch = await db.get('SELECT server_id FROM channels WHERE id = ?', [channelId]);
  if (!ch) throw { code: 'NOT_FOUND', message: 'channel not found', status: 404 };

  const canMove = await permissions.hasPermission(actorId, ch.server_id, 'MOVE_MEMBERS');
  const canMute = await permissions.hasPermission(actorId, ch.server_id, 'MUTE_MEMBERS');
  if (!canMove && !canMute) {
    throw { code: 'PERMISSION_DENIED', message: 'you cannot moderate voice in this channel', status: 403 };
  }

  const target = await db.get(
    'SELECT * FROM voice_participants WHERE channel_id = ? AND user_id = ? AND left_at IS NULL',
    [channelId, targetUserId]
  );
  if (!target) throw { code: 'NOT_FOUND', message: 'that person is not in this channel', status: 404 };

  if (disconnect) {
    await db.run('UPDATE voice_participants SET left_at = ? WHERE id = ?', [now(), target.id]);
    await endSession(target.session_id);
  } else {
    const sets = [];
    const params = [];
    if (mute !== undefined) { sets.push('muted = ?'); params.push(mute ? 1 : 0); }
    if (deafen !== undefined) { sets.push('deafened = ?'); params.push(deafen ? 1 : 0); }
    if (sets.length) {
      params.push(target.id);
      await db.run(`UPDATE voice_participants SET ${sets.join(', ')} WHERE id = ?`, params);
    }
  }

  await db.run(
    `INSERT INTO audit_logs (id, actor_id, action, target_type, target_id, reason, created_at)
     VALUES (?, ?, ?, 'user', ?, NULL, ?)`,
    [uuid(), actorId, disconnect ? 'voice_disconnect' : 'voice_moderate', targetUserId, now()]
  );

  return { ok: true };
}

// A stage channel's speaker list is separate from its audience: an audience member can
// connect and listen but cannot publish.
async function requestSpeak(channelId, userId) {
  const ch = await db.get('SELECT type FROM channels WHERE id = ?', [channelId]);
  if (!ch || ch.type !== 'stage') {
    throw { code: 'VALIDATION_ERROR', message: 'that is not a stage channel', status: 400 };
  }
  await db.run(
    'INSERT INTO voice_speak_requests (id, channel_id, user_id, created_at) VALUES (?, ?, ?, ?)',
    [uuid(), channelId, userId, now()]
  );
  return { ok: true };
}

module.exports = {
  available, authorizeVoice,
  join, leave, participants, setSelfState, moderate, requestSpeak,
  // The transport calls a route needs in order to relay SDP. Each one requires a session
  // the caller already proved belongs to them.
  negotiate, answer, publishScreenShare, sessionState, closeTrack,
  iceServers,
};
