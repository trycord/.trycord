// The voice session.
//
// One seat, one channel at a time, held in the in-house mesh the server runs
// itself: audio flows browser to browser, and the server only relays offers,
// answers and ICE between room members. Nothing here pretends a media server
// exists; the instance's refusal reads in every state the dock can draw.
//
// Two facts shape the module. The roster is the server's truth, so the room is
// polled while the session lives and diffed - a peer that disappears is closed,
// not clung to. And each peer connection runs the standard perfect-negotiation
// pattern, so a microphone granted after the join, or refused entirely, still
// reaches the room through the same offer path.

import Api from '../../packages/api.js';
import { on as onRealtime } from '../../packages/realtime.js';

const POLL_MS = 4000;

const state = {
  // The joined channel, or null while idle.
  channel: null,
  joined: false,
  muted: false,
  deafened: false,
  // True when the browser could not supply a microphone; the seat stays and hears.
  listenOnly: false,
  // [{ userId, speaking, connection: 'connecting' | 'live' | 'reconnecting', muted }]
  participants: [],
  // A room-level note the room view and the dock show as they are.
  note: '',
};

const subscribers = new Set();
export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

function emit() {
  for (const fn of Array.from(subscribers)) {
    try { fn(state); } catch { /* a listener must not break the room */ }
  }
}

// The state, read without subscribing - the views that poll on ticks use this
// for their current-world checks.
export function current() {
  return state;
}

function note(text) {
  state.note = text || '';
  emit();
}

// ---- capabilities ------------------------------------------------------------

let caps = null;
let capsAsked = false;

export async function capabilities(force) {
  if (capsAsked && !force) return caps;
  capsAsked = true;
  try {
    const res = await Api.voiceCapabilities();
    const flags = (res && res.features && res.features.voiceVideo) || {};
    caps = { enabled: !!flags.enabled, provider: flags.provider || '', detail: '' };
  } catch {
    // An unreachable backend is not the same as voice being switched off, and
    // reading it that way would hide a real outage behind a flag.
    caps = { enabled: false, provider: '', detail: 'Could not reach the server.' };
  }
  return caps;
}

// The cached answer, read synchronously by views that already waited for it.
export function currentCaps() {
  return caps;
}

// ---- media -------------------------------------------------------------------

function mediaSupported() {
  return typeof navigator !== 'undefined'
    && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
    && typeof window.RTCPeerConnection === 'function';
}

let localStream = null;
let audioContext = null;
let selfWatch = null;
let roomIceList = [];

const peers = new Map(); // userId -> { pc, polite, audio, watch, makingOffer }
let unsubs = [];
let pollTimer = 0;
let pulseTimer = 0;
let joining = false;

let userIdLookup = () => '';
export function setLocalUserId(id) {
  userIdLookup = typeof id === 'function' ? id : () => id;
}

function myId() {
  return String(userIdLookup() || '');
}

function signalTo(peerId, kind, payload) {
  if (!state.channel) return Promise.resolve();
  return Api.voiceMeshSignal(state.channel.id, { to: String(peerId), kind, payload })
    .catch(() => {}); // a lost signal is retried by renegotiation
}

// ---- one peer ----------------------------------------------------------------

function speakingOf(stream) {
  if (!audioContext || !stream || !stream.getAudioTracks().length) return null;
  try {
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);
    return { analyser, data: new Uint8Array(analyser.frequencyBinCount) };
  } catch {
    return null;
  }
}

function peerRow(userId) {
  const known = state.participants.find((p) => String(p.userId) === String(userId));
  if (known) return known;
  const row = { userId: String(userId), speaking: false, connection: 'connecting', muted: false };
  state.participants.push(row);
  return row;
}

function dropRow(userId) {
  state.participants = state.participants.filter((p) => String(p.userId) !== String(userId));
}

function attachAudio(audio, muted) {
  audio.muted = !!muted;
  try {
    audio.setAttribute('playsinline', '');
    audio.setAttribute('autoplay', '');
  } catch { /* best effort on the sink */ }
  if (!audio.isConnected) document.body.appendChild(audio);
}

function buildPeer(userId) {
  if (!mediaSupported() || !state.channel) return null;
  if (peers.has(String(userId))) return peers.get(String(userId));

  const pc = new window.RTCPeerConnection({ iceServers: roomIceList });
  const audio = document.createElement('audio');
  const row = peerRow(userId);
  const peer = { pc, polite: String(userId) > myId(), audio, watch: null, makingOffer: false };
  peers.set(String(userId), peer);

  if (localStream) {
    for (const track of localStream.getTracks()) {
      try { peer.pc.addTrack(track, localStream); } catch { /* renegotiated later */ }
    }
  }

  peer.pc.ontrack = (event) => {
    const remote = event.streams && event.streams[0];
    if (!remote) return;
    peer.audio.srcObject = remote;
    attachAudio(peer.audio, state.deafened);
    if (!peer.watch) peer.watch = speakingOf(remote);
  };

  peer.pc.onicecandidate = (event) => {
    if (event.candidate) signalTo(userId, 'ice', { candidate: event.candidate.toJSON() });
  };

  peer.pc.onconnectionstatechange = () => {
    const s = peer.pc.connectionState;
    if (s === 'connected') row.connection = 'live';
    else if (s === 'connecting' || s === 'new') row.connection = 'connecting';
    else if (s === 'disconnected') row.connection = 'reconnecting';
    else if (s === 'failed') destroyPeer(userId);
    emit();
  };

  // Perfect negotiation: whoever needs to talk, offers; the polite side yields
  // on a collision with a rollback rather than fighting one.
  peer.pc.onnegotiationneeded = async () => {
    try {
      peer.makingOffer = true;
      await peer.pc.setLocalDescription(await peer.pc.createOffer());
      const desc = peer.pc.localDescription && peer.pc.localDescription.toJSON();
      await signalTo(userId, 'offer', { sdp: desc });
    } catch { /* a race loses to the incoming offer or answer */ } finally {
      peer.makingOffer = false;
    }
  };

  return peer;
}

function destroyPeer(userId) {
  const peer = peers.get(String(userId));
  if (!peer) return;
  peers.delete(String(userId));
  try { peer.pc.close(); } catch { /* already closed */ }
  try { peer.audio.remove(); } catch { /* never attached */ }
  dropRow(userId);
  emit();
}

function destroyPeers() {
  for (const userId of Array.from(peers.keys())) destroyPeer(userId);
}

// ---- signaling frames ---------------------------------------------------------

async function handleOffer(frame) {
  const peer = buildPeer(frame.from);
  if (!peer) return;
  const description = frame.payload && frame.payload.sdp;
  if (!description) return;
  try {
    const collision = !!peer.makingOffer || (peer.pc.signalingState !== 'stable');
    if (!peer.polite && collision) return; // impolite side ignores a glare
    if (collision) await peer.pc.setLocalDescription({ type: 'rollback' });
    await peer.pc.setRemoteDescription(description);
    await peer.pc.setLocalDescription(await peer.pc.createAnswer());
    const desc = peer.pc.localDescription && peer.pc.localDescription.toJSON();
    await signalTo(frame.from, 'answer', { sdp: desc });
  } catch { /* a stale offer loses to the next round */ }
}

async function handleAnswer(frame) {
  const peer = peers.get(String(frame.from));
  const description = frame.payload && frame.payload.sdp;
  if (!peer || !description) return;
  try { await peer.pc.setRemoteDescription(description); } catch { /* stale answer */ }
}

function handleIce(frame) {
  const peer = peers.get(String(frame.from));
  const candidate = frame.payload && frame.payload.candidate;
  if (!peer || !candidate) return;
  try { peer.pc.addIceCandidate(candidate).catch(() => {}); } catch { /* late candidate */ }
}

function handleMute(frame) {
  const row = state.participants.find((p) => String(p.userId) === String(frame.from));
  if (!row) return;
  row.muted = !!(frame.payload && frame.payload.muted);
  emit();
}

function handleLeft(frame) {
  if (state.channel && String(frame.channelId) === String(state.channel.id)) destroyPeer(frame.from);
}

function onStatus(status) {
  if (status !== 'online' && status !== 'offline') return;
  for (const row of state.participants) {
    if (!peers.has(String(row.userId))) continue;
    if (status === 'offline') row.connection = 'reconnecting';
  }
  emit();
}

// ---- the room poll ------------------------------------------------------------

async function refreshRoom() {
  if (!state.channel) return;
  let seat = null;
  let ids = [];
  try {
    const room = await Api.voiceMeshPeers(state.channel.id);
    ids = ((room && room.participants) || []).map(String);
    if (myId() && !ids.includes(myId())) {
      // The server dropped the seat: the socket blinked, or a moderator
      // disconnected it. Re-seating is honest; pretending is not.
      seat = await Api.voiceMeshJoin(state.channel.id);
      ids = ((seat && seat.participants) || []).map(String);
    }
  } catch {
    // A failed poll does not end the room. The transport may be between
    // reconnects; the next tick judges again.
    return;
  }

  for (const userId of ids) {
    peerRow(userId);
    if (!peers.has(String(userId))) buildPeer(userId);
  }
  for (const key of Array.from(peers.keys())) {
    if (!ids.includes(String(key))) destroyPeer(key);
  }
  state.participants = state.participants
    .filter((p) => String(p.userId) === myId() || ids.includes(String(p.userId)));
  emit();
}

// ---- join and leave -------------------------------------------------------------

export async function join(channel) {
  if (joining || state.joined) return state;
  joining = true;
  try {
    const c = await capabilities();
    if (!c.enabled) {
      note('Voice and video are off on this instance.');
      emit();
      return state;
    }
    if (!mediaSupported()) {
      note('This browser cannot open a media connection, so the room cannot be joined from here.');
      emit();
      return state;
    }

    let seat;
    try {
      seat = await Api.voiceMeshJoin(channel.id);
    } catch (e) {
      note((e && e.message) || 'The room refused the join.');
      emit();
      return state;
    }

    roomIceList = (seat && seat.iceServers) || [];
    state.channel = { id: channel.id, serverId: channel.serverId, name: channel.name, type: channel.type };
    state.participants = [];
    state.joined = true;
    state.listenOnly = false;
    state.muted = false;
    state.deafened = false;
    peerRow(myId());

    // The microphone is asked for once the seat exists: a denial becomes a
    // listen-only seat rather than a failed join, because hearing people is
    // still worth something when your own mic is off the table.
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStream = stream;
      state.listenOnly = !(stream && stream.getAudioTracks().length);
      if (state.listenOnly) note('The microphone offered no audio; you are listening only.');
    } catch {
      localStream = null;
      state.listenOnly = true;
      note('The microphone was not granted; you are listening only. Speak from the dock once it is granted.');
    }

    if (!audioContext) {
      try { audioContext = new window.AudioContext(); } catch { audioContext = null; }
      if (!audioContext && typeof window.webkitAudioContext === 'function') {
        try { audioContext = new window.webkitAudioContext(); } catch { audioContext = null; }
      }
    }
    if (localStream) selfWatch = speakingOf(localStream);

    for (const userId of ((seat && seat.participants) || [])) {
      peerRow(String(userId));
      buildPeer(String(userId));
    }

    unsubs.push(onRealtime('voice.mesh.offer', handleOffer));
    unsubs.push(onRealtime('voice.mesh.answer', handleAnswer));
    unsubs.push(onRealtime('voice.mesh.ice', handleIce));
    unsubs.push(onRealtime('voice.mesh.mute', handleMute));
    unsubs.push(onRealtime('voice.mesh.leave', handleLeft));
    unsubs.push(onRealtime('status', onStatus));
    pollTimer = setInterval(() => { refreshRoom().catch(() => {}); }, POLL_MS);
    pulseTimer = setInterval(() => { pulse(); }, 220);

    const notes = [];
    if (!roomIceList.length) {
      notes.push('No STUN or TURN is configured on this instance; connections may only form on the same network.');
    }
    if (seat && seat.maxParticipants) notes.push('Peer-to-peer room, up to ' + seat.maxParticipants + ' people.');
    note(notes.join(' '));
    emit();
    return state;
  } finally {
    joining = false;
  }
}

export async function leave() {
  const channel = state.channel;
  if (channel) {
    for (const peerId of peers.keys()) await signalTo(peerId, 'leave', {});
  }
  if (pollTimer) { clearInterval(pollTimer); pollTimer = 0; }
  if (pulseTimer) { clearInterval(pulseTimer); pulseTimer = 0; }
  for (const fn of unsubs) { try { fn(); } catch { /* gone */ } }
  unsubs = [];
  if (localStream) {
    for (const track of localStream.getTracks()) {
      try { track.stop(); } catch { /* already stopped */ }
    }
    localStream = null;
  }
  selfWatch = null;
  destroyPeers();
  state.channel = null;
  state.joined = false;
  state.participants = [];
  state.muted = false;
  state.deafened = false;
  state.listenOnly = false;
  state.note = '';
  emit();
  if (channel) {
    // The seat clears on the socket close as well; this ask is the polite one.
    try { await Api.voiceMeshLeave(channel.id); } catch { /* the room forgets either way */ }
  }
  return state;
}

// ---- controls -------------------------------------------------------------------

export function setMuted(muted) {
  if (!state.joined) return state;
  state.muted = !!muted;
  if (localStream) {
    for (const track of localStream.getAudioTracks()) track.enabled = !state.muted;
  }
  for (const peerId of peers.keys()) signalTo(peerId, 'mute', { muted: state.muted });
  const self = state.participants.find((p) => String(p.userId) === myId());
  if (self) { self.muted = state.muted; self.speaking = false; }
  emit();
  return state;
}

export function setDeafened(deafened) {
  if (!state.joined) return state;
  state.deafened = !!deafened;
  for (const peer of peers.values()) attachAudio(peer.audio, state.deafened);
  emit();
  return state;
}

export function enableMic() {
  // A refused microphone becomes a granted one without leaving the room; the
  // added track triggers each peer's renegotiation through the same offer path.
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return Promise.resolve(state);
  return navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
    const track = stream && stream.getAudioTracks()[0];
    if (!track) return state;
    localStream = stream;
    state.listenOnly = false;
    if (!audioContext) {
      try { audioContext = new window.AudioContext(); } catch { audioContext = null; }
    }
    selfWatch = speakingOf(stream);
    for (const peer of peers.values()) {
      try { peer.pc.addTrack(track, stream); } catch { /* renegotiation covers it */ }
    }
    note('');
    emit();
    return state;
  }).catch(() => {
    note('The microphone was not granted; you are still listening only.');
    return state;
  });
}

export function pulse() {
  if (audioContext && audioContext.state === 'suspended') audioContext.resume().catch(() => {});
  for (const row of state.participants) {
    if (String(row.userId) === myId()) {
      row.speaking = !!(selfWatch && levelOf(selfWatch)) && !state.muted;
      continue;
    }
    const peer = peers.get(String(row.userId));
    row.speaking = !!(peer && peer.watch && levelOf(peer.watch));
  }
  emit();
}

function levelOf(watch) {
  if (!watch || !watch.analyser) return false;
  watch.analyser.getByteFrequencyData(watch.data);
  let sum = 0;
  for (const v of watch.data) sum += v;
  return (sum / watch.data.length) > 12;
}

export default {
  subscribe, capabilities, join, leave, setMuted, setDeafened, enableMic,
  pulse, setLocalUserId, state,
};
