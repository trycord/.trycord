// The third-party SFU transport.
//
// A media server the operator runs, reached over HTTP. The protocol it
// speaks is small and is written down in docs/voice.md, so an operator knows
// what their server has to offer:
//
//   POST   {endpoint}/sessions                 -> { "sessionId": "..." }
//   POST   {endpoint}/sessions/{id}/negotiate  -> { "sessionDescription": {...} }
//   POST   {endpoint}/sessions/{id}/answer     -> {}
//   GET    {endpoint}/sessions/{id}             -> { "tracks": [...], "dataChannels": [...] }
//   DELETE {endpoint}/sessions/{id}
//
// The token is sent as a bearer credential with every request and never
// reaches a browser.

'use strict';

const config = require('./config');

class SfuError extends Error {
  constructor(status, code, description) {
    super(description || code || 'the media server refused the request');
    this.name = 'SfuError';
    this.status = status;
    this.code = code;
  }
}

function base(cfg) {
  return String(cfg.endpoint || '').replace(/\/+$/, '');
}

async function request(cfg, method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.token) headers.Authorization = 'Bearer ' + cfg.token;

  const res = await fetch(base(cfg) + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* a body that is not json is read as empty */ }

  if (!res.ok) {
    const err = json && json.error;
    throw new SfuError(
      res.status,
      (err && (err.code || err.errorCode)) || ('HTTP_' + res.status),
      (err && (err.message || err.errorDescription)) || text.slice(0, 200)
    );
  }
  return json;
}

// A session on the media server.
async function createSession(cfg) {
  const out = await request(cfg, 'POST', '/sessions', {});
  const sessionId = out && (out.sessionId || out.id);
  if (!sessionId) {
    throw new SfuError(502, 'NO_SESSION_ID', 'The media server did not return a session id.');
  }
  return sessionId;
}

async function endSession(cfg, sessionId) {
  if (!sessionId) return { ok: true };
  await request(cfg, 'DELETE', '/sessions/' + encodeURIComponent(sessionId));
  return { ok: true };
}

// The offer in, the answer out.
async function negotiate(cfg, { sessionId, tracks, sessionDescription }) {
  if (!sessionId) throw new SfuError(400, 'NO_SESSION', 'a session id is required');
  const out = await request(cfg, 'POST', '/sessions/' + encodeURIComponent(sessionId) + '/negotiate', {
    tracks: (tracks || []).map((track) => ({
      location: track.location || 'local',
      sessionId: track.sessionId,
      trackName: track.trackName,
      mid: track.mid,
    })),
    sessionDescription,
  });
  return {
    sessionDescription: out && out.sessionDescription,
    tracks: (out && out.tracks) || [],
    requiresAnswer: !!(out && out.sessionDescription && out.sessionDescription.type === 'offer'),
  };
}

async function answer(cfg, { sessionId, sessionDescription }) {
  if (!sessionId) throw new SfuError(400, 'NO_SESSION', 'a session id is required');
  await request(cfg, 'POST', '/sessions/' + encodeURIComponent(sessionId) + '/answer', { sessionDescription });
  return { ok: true };
}

// The media server's own view of a session.
async function sessionState(cfg, { sessionId }) {
  if (!sessionId) return { tracks: [], dataChannels: [] };
  const out = await request(cfg, 'GET', '/sessions/' + encodeURIComponent(sessionId));
  return { tracks: (out && out.tracks) || [], dataChannels: (out && out.dataChannels) || [] };
}

// Closing a track is how a moderator stops one participant's media.
async function closeTrack(cfg, { sessionId, mid }) {
  if (!sessionId || !mid) throw new SfuError(400, 'BAD_TARGET', 'a session and a track are required');
  await request(cfg, 'DELETE', '/sessions/' + encodeURIComponent(sessionId) + '/tracks/' + encodeURIComponent(mid));
  return { ok: true };
}

module.exports = {
  SfuError,
  createSession,
  endSession,
  negotiate,
  answer,
  sessionState,
  closeTrack,
  configuration: (overlay) => config.configuration('sfu', overlay),
};
