// Voice and video.
//
// The panel and the media session in one module, because the panel is the only way a
// person reaches the session and nothing else in the client needs either.
//
// The server owns membership and authorisation: join, leave, the participant list and
// this user's mute and deafen state are all server facts. This module owns the media,
// which is the part only a browser can do - capturing the microphone, holding one
// RTCPeerConnection, and relaying the SDP offer and answer through the provider.
//
// The receive path follows the provider's remote-track flow, driven by polling the
// participant list rather than by a signalling socket. It is written against the same
// negotiate endpoint the publish path uses. Neither path can be exercised without a
// live media server, so this is the one part of the client that a self-hoster running
// voice must confirm on their own instance.

import { el, clear } from '../packages/dom.js';
import { icon } from '../packages/icons.js';
import { avatar } from './components.js';
import { relativeTime } from '../packages/format.js';
import { toast, errorToast } from './ui.js';
import Api from '../packages/api.js';

// One live session per channel, so leaving a channel and coming back reuses the
// connection rather than opening a second one against the media server.
const sessions = new Map();

// Cached for the session: the answer only changes when the operator reconfigures the
// instance, and re-asking on every panel open would be a request per channel.
let capabilities = null;
let capabilitiesAsked = false;

export async function voiceCapabilities(force = false) {
  if (capabilitiesAsked && !force) return capabilities;
  capabilitiesAsked = true;
  try {
    const res = await Api.voiceCapabilities();
    const media = (res && res.voiceVideo) || {};
    const flags = (res && res.features && res.features.voiceVideo) || {};
    capabilities = {
      available: !!media.available,
      reason: media.reason || (media.available ? 'ready' : 'unknown'),
      detail: media.detail || '',
      screenSharing: !!flags.screenSharing,
      stageChannels: !!flags.stageChannels,
      maxParticipants: flags.maxParticipants || 0,
    };
  } catch {
    // An unreachable backend is not the same as voice being off, and calling it that
    // would hide a real problem behind a feature flag that was never read.
    capabilities = {
      available: false,
      reason: 'unknown',
      detail: 'Could not reach the server.',
      screenSharing: false,
      maxParticipants: 0,
    };
  }
  return capabilities;
}

function mediaSupported() {
  return typeof navigator !== 'undefined'
    && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
    && typeof RTCPeerConnection === 'function';
}

function unavailableState(caps) {
  if (caps.reason === 'disabled') {
    return {
      title: 'Voice is off here',
      body: 'Voice and video are not enabled on this instance.',
    };
  }
  if (caps.reason === 'misconfigured') {
    return {
      title: 'Voice is not configured',
      body: 'Voice is on, but the media server is not set up. An administrator needs to finish the configuration.',
    };
  }
  if (caps.reason === 'unreachable') {
    return {
      title: 'The media server is unreachable',
      body: 'Voice is on, but the media server could not be reached. An administrator needs to check its configuration.',
    };
  }
  return {
    title: 'Voice is unavailable',
    body: caps.detail || 'Could not check whether this instance supports voice.',
  };
}

function createSession(channel) {
  return {
    channel,
    region: null,
    joined: false,
    busy: false,
    muted: false,
    deafened: false,
    participants: [],
    iceServers: [],
    pc: null,
    localStream: null,
    remoteStream: null,
    audio: null,
    poll: null,
    subscribed: new Set(),
    // Serialises renegotiation, because two offers in flight on one connection is a
    // race the provider resolves by rejecting one of them.
    queue: Promise.resolve(),
  };
}

export async function voiceChannelPanel({ channel }) {
  const caps = await voiceCapabilities();
  let session = sessions.get(channel.id);
  if (!session) {
    session = createSession(channel);
    sessions.set(channel.id, session);
  }
  session.caps = caps;
  const panel = el('div', { class: 'voice' });
  session.region = panel;
  paint(session);
  return panel;
}

function paint(session) {
  const region = session.region;
  if (!region) return;
  clear(region);

  region.appendChild(el('div', { class: 'voice-head' },
    el('div', {},
      el('div', { class: 'voice-title' }, session.channel.name),
      el('div', { class: 'voice-sub' },
        session.channel.type === 'stage' ? 'Stage channel' : 'Voice channel'))));

  // The remote audio element outlives a repaint, so it is put back rather than rebuilt.
  if (session.audio) region.appendChild(session.audio);

  if (!session.caps || !session.caps.available) {
    const state = unavailableState(session.caps || {});
    region.appendChild(el('div', { class: 'voice-state' },
      icon('phone-off', { size: 26 }),
      el('div', { class: 'voice-state-title' }, state.title),
      el('div', { class: 'voice-state-body' }, state.body)));
    return;
  }

  if (!session.joined) {
    const join = el('button', {
      class: 'btn btn--primary', type: 'button', disabled: session.busy,
      onClick: () => joinChannel(session),
    }, icon('phone', { size: 16 }), el('span', {}, session.busy ? 'Connecting' : 'Join voice'));
    region.appendChild(el('div', { class: 'voice-join' },
      join,
      session.caps.maxParticipants
        ? el('div', { class: 'voice-hint' }, 'Up to ' + session.caps.maxParticipants + ' people in this channel.')
        : null));
    return;
  }

  region.appendChild(controls(session));
  region.appendChild(participantList(session));
}

function controls(session) {
  const bar = el('div', { class: 'voice-controls' });
  bar.appendChild(toggle(session, 'muted', 'Mute', 'Unmute', 'mic', 'mic-off', () => setOwnState(session, { muted: !session.muted })));
  bar.appendChild(toggle(session, 'deafened', 'Deafen', 'Undeafen', 'headphones', 'headphones-off', () => setOwnState(session, { deafened: !session.deafened })));
  bar.appendChild(el('button', {
    class: 'btn btn--default btn--sm', type: 'button',
    onClick: () => leaveChannel(session),
  }, 'Leave'));
  return bar;
}

function toggle(session, key, onLabel, offLabel, onIcon, offIcon, onClick) {
  const on = session[key];
  return el('button', {
    class: 'btn btn--default btn--sm voice-control' + (on ? ' is-on' : ''),
    type: 'button',
    'aria-pressed': on ? 'true' : 'false',
    onClick,
  }, icon(on ? onIcon : offIcon, { size: 15 }), el('span', {}, on ? offLabel : onLabel));
}

function participantList(session) {
  const list = el('div', { class: 'voice-participants' });
  if (!session.participants.length) {
    list.appendChild(el('div', { class: 'voice-state-body' }, 'Nobody else is here yet.'));
    return list;
  }
  const count = session.participants.length;
  list.appendChild(el('div', { class: 'voice-section-label' },
    count + (count === 1 ? ' person' : ' people')));
  for (const person of session.participants) {
    const row = el('div', { class: 'voice-participant' },
      avatar({ id: person.userId, username: person.username, displayName: person.displayName, avatarUrl: person.avatarUrl }, { size: 'sm' }),
      el('div', { class: 'voice-participant-main' },
        el('div', { class: 'voice-participant-name' },
          el('span', {}, person.displayName || person.username),
          person.muted ? el('span', { class: 'voice-flag', title: 'Muted' }, 'muted') : null,
          person.deafened ? el('span', { class: 'voice-flag', title: 'Deafened' }, 'deafened') : null),
        person.joinedAt ? el('div', { class: 'voice-participant-sub' }, 'joined ' + relativeTime(person.joinedAt)) : null));
    list.appendChild(row);
  }
  return list;
}

async function joinChannel(session) {
  if (!mediaSupported()) {
    toast('This browser cannot make voice calls.', { type: 'error' });
    return;
  }
  session.busy = true;
  paint(session);
  try {
    const out = await Api.voiceJoin(session.channel.id);
    session.iceServers = (out && out.iceServers) || [];
    await publishLocal(session);
    session.joined = true;
    await refreshParticipants(session);
    startPolling(session);
  } catch (error) {
    // A failed publish must not leave a half-open session behind on the server.
    teardownMedia(session);
    try { await Api.voiceLeave(session.channel.id); } catch { /* best effort */ }
    errorToast(error);
  } finally {
    session.busy = false;
    paint(session);
  }
}

async function publishLocal(session) {
  session.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  const pc = new RTCPeerConnection({ iceServers: session.iceServers });
  session.pc = pc;
  session.remoteStream = new MediaStream();

  pc.addEventListener('track', (event) => {
    for (const track of event.streams[0] ? event.streams[0].getTracks() : [event.track]) {
      if (!session.remoteStream.getTracks().includes(track)) session.remoteStream.addTrack(track);
    }
    attachAudio(session);
  });

  for (const track of session.localStream.getAudioTracks()) pc.addTrack(track, session.localStream);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  const tracks = session.localStream.getAudioTracks().map((track) => {
    const transceiver = pc.getTransceivers().find((t) => t.sender && t.sender.track === track);
    return { location: 'local', mid: transceiver ? transceiver.mid : undefined, trackName: 'audio' };
  });
  const answer = await Api.voiceNegotiate(session.channel.id, { tracks, sessionDescription: pc.localDescription });
  if (answer && answer.sessionDescription) await pc.setRemoteDescription(answer.sessionDescription);
}

function attachAudio(session) {
  if (!session.audio) {
    session.audio = el('audio', { autoplay: true, class: 'voice-audio' });
    session.audio.setAttribute('playsinline', '');
  }
  session.audio.srcObject = session.remoteStream;
  session.audio.play().catch(() => { /* autoplay policies are the browser's call */ });
  // The element may have been dropped by a repaint between the track arriving and now.
  if (session.region && !session.region.contains(session.audio)) session.region.appendChild(session.audio);
}

function startPolling(session) {
  stopPolling(session);
  session.poll = setInterval(() => { refreshParticipants(session); }, 5000);
}

function stopPolling(session) {
  if (session.poll) { clearInterval(session.poll); session.poll = null; }
}

async function refreshParticipants(session) {
  let people = [];
  try {
    const list = await Api.voiceParticipants(session.channel.id);
    people = Array.isArray(list) ? list : [];
  } catch {
    // A failed participant read is not a reason to drop a live session.
    return;
  }
  session.participants = people;

  // Subscribe to anyone new, drop the subscriptions of anyone who left.
  const present = new Set(people.map((p) => p.sessionId).filter(Boolean));
  for (const sessionId of Array.from(session.subscribed)) {
    if (!present.has(sessionId)) session.subscribed.delete(sessionId);
  }
  for (const person of people) {
    if (person.sessionId && !session.subscribed.has(person.sessionId)) {
      subscribeRemote(session, person).catch(() => { /* retried on the next poll */ });
    }
  }
  if (session.joined) paint(session);
}

// Ask the provider for a participant's published track. The offer carries one receiving
// transceiver so the answer has somewhere to land.
function subscribeRemote(session, person) {
  session.queue = session.queue.then(async () => {
    if (!session.pc || session.subscribed.has(person.sessionId)) return;
    const pc = session.pc;
    pc.addTransceiver('audio', { direction: 'recvonly' });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const answer = await Api.voiceNegotiate(session.channel.id, {
      tracks: [{ location: 'remote', sessionId: person.sessionId, trackName: 'audio' }],
      sessionDescription: pc.localDescription,
    });
    if (answer && answer.sessionDescription) await pc.setRemoteDescription(answer.sessionDescription);
    session.subscribed.add(person.sessionId);
  });
  return session.queue;
}

async function setOwnState(session, patch) {
  try {
    await Api.voiceState(session.channel.id, patch);
    Object.assign(session, patch);
    // Muting is local as well as server-reported: the track stops carrying audio without
    // tearing down the connection.
    applyMute(session);
    paint(session);
  } catch (error) {
    errorToast(error);
  }
}

function applyMute(session) {
  if (!session.localStream) return;
  for (const track of session.localStream.getAudioTracks()) track.enabled = !session.muted;
}

async function leaveChannel(session) {
  stopPolling(session);
  teardownMedia(session);
  session.joined = false;
  session.participants = [];
  sessions.delete(session.channel.id);
  paint(session);
  try { await Api.voiceLeave(session.channel.id); } catch (error) { errorToast(error); }
}

function teardownMedia(session) {
  stopPolling(session);
  session.subscribed.clear();
  if (session.pc) {
    try { session.pc.close(); } catch { /* already closed */ }
    session.pc = null;
  }
  if (session.localStream) {
    for (const track of session.localStream.getTracks()) track.stop();
    session.localStream = null;
  }
  session.remoteStream = null;
  if (session.audio) {
    session.audio.srcObject = null;
    if (session.audio.parentNode) session.audio.parentNode.removeChild(session.audio);
    session.audio = null;
  }
}

// Called when the view is torn down, so navigating away ends the call rather than
// leaving a microphone open in a panel nobody can see.
export function leaveVoice(channelId) {
  const session = sessions.get(channelId);
  if (!session) return;
  sessions.delete(channelId);
  teardownMedia(session);
  Api.voiceLeave(channelId).catch(() => { /* leaving cleanly is best-effort at teardown */ });
}

export function voicePanelFor(channelId) {
  return sessions.get(channelId) || null;
}

export default { voiceChannelPanel, voiceCapabilities, leaveVoice, voicePanelFor };
