// The voice dock.
//
// The one floating panel that follows a reader into any page while a voice
// session lives: where you are, who is in the room, whether anyone is audible,
// and the three acts that matter - mute, deafen, leave. It is mounted once at
// boot and empty until a session exists, so an idle instance costs nothing but
// an attribute.
//
// The session store emits on every speaking tick, so the dock separates the
// two kinds of change: the structure (who is in the room, which controls are
// on) rebuilds, while a speaking pulse only turns the glow class on the chips
// that are already in place.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import { avatar } from '../ui/primitives.js';
import { State, nameOf } from '../../packages/store.js';
import {
  subscribe, current, setMuted, setDeafened, leave, enableMic,
  refreshDevices, setInputDevice, setOutputDevice,
  canShareScreen, startScreenShare, stopScreenShare,
} from '../../packages/voiceSession.js';

let paintFn = null;
let host = null;
let lastStructure = '';

function personOf(userId, serverId) {
  const roster = State.serverMembers.get(serverId)
    || ((() => {
      for (const entry of State.serverMembers.values()) return entry;
      return null;
    })());
  const items = (roster && roster.items) || [];
  const member = items.find((m) => String(m && m.id) === String(userId));
  return member || null;
}

function chip(participant, serverId) {
  const person = personOf(participant.userId, serverId) || { id: participant.userId };
  const label = person.nickname || nameOf(person) || 'Someone';
  return el('span', {
    class: 'voice-dock__peer', 'data-peer': String(participant.userId), title: label,
  },
    avatar(person, { size: 'sm', rounded: true }),
    participant.muted ? el('span', { class: 'voice-dock__peerflag' }, icon('mic-off', { size: 11 })) : null,
    el('span', { class: 'visually-hidden' },
      label + (participant.speaking ? ' is speaking' : '')));
}

function structureSignature() {
  const s = current();
  if (!s.joined) return '';
  return JSON.stringify([
    s.channel && s.channel.id, s.muted, s.deafened, s.listenOnly, s.connection, s.sharing,
    Object.keys(s.sharedScreens || {}),
    s.inputDeviceId, s.outputDeviceId, s.canChooseOutput,
    (s.inputs || []).map((device) => device.id),
    (s.outputs || []).map((device) => device.id),
    (s.participants || []).map((p) => [String(p.userId), !!p.muted]),
  ]);
}

function structureNote() {
  const s = current();
  const base = s.note || '';
  if (s.listenOnly && base.startsWith('The microphone was not granted')) {
    return { text: 'No microphone granted - listening only.', offerRetry: true };
  }
  return { text: base, offerRetry: false };
}

function dockNode() {
  const s = current();
  if (!s.joined || !s.channel) return null;

  const flag = structureNote();
  const lead = el('div', { class: 'voice-dock__lead' },
    el('span', { class: 'voice-dock__glyph' }, icon('headphones', { size: 18 })),
    el('span', { class: 'voice-dock__title' }, '#' + (s.channel.name || 'voice')));

  // The state of the connection, in words.
  //
  // It is the state the session worked out from the peers, so the dock cannot
  // say "connected" while every peer is still trying.
  const state_ = s.connection || 'idle';
  const stateWord = {
    idle: 'Not in a room',
    joining: 'Joining the room',
    connecting: 'Connecting',
    connected: 'Connected',
    reconnecting: 'Reconnecting',
    failed: 'The connection failed',
    leaving: 'Leaving',
  }[state_] || 'Connected';

  const micBtn = el('button', {
    class: 'dock-btn dock-btn--round' + (s.muted ? ' is-off' : ''), type: 'button',
    'aria-pressed': String(s.muted), 'aria-label': s.muted ? 'Unmute yourself' : 'Mute yourself',
    title: s.muted ? 'Unmute yourself' : 'Mute yourself',
    onClick: () => setMuted(!s.muted),
  }, icon(s.muted ? 'mic-off' : 'mic', { size: 18 }));

  const deafBtn = el('button', {
    class: 'dock-btn dock-btn--round' + (s.deafened ? ' is-off' : ''), type: 'button',
    'aria-pressed': String(s.deafened), 'aria-label': s.deafened ? 'Hear the room again' : 'Deafen the room',
    title: s.deafened ? 'Hear the room again' : 'Deafen the room',
    onClick: () => setDeafened(!s.deafened),
  }, icon(s.deafened ? 'volume-off' : 'headphones', { size: 18 }));

  const controls = el('div', { class: 'voice-dock__controls' }, micBtn, deafBtn,
    el('button', {
      class: 'btn btn--danger btn--sm', type: 'button', 'aria-label': 'Leave the voice channel',
      onClick: () => leave(),
    }, 'Disconnect'));

  // The devices.
  //
  // The microphone and the speaker, from the list the browser reports. A
  // browser that will not let a page choose the speaker says so, and the
  // browser's own settings are the way - a picker that does nothing is worse
  // than no picker.
  const devices = el('div', { class: 'voice-dock__devices' });
  const inputs = s.inputs || [];
  const outputs = s.outputs || [];
  if (inputs.length > 1 || (s.canChooseOutput && outputs.length > 1)) {
    const mic = el('select', {
      class: 'input input--sm', 'aria-label': 'The microphone you speak with',
    }, ...inputs.map((device) => el('option', {
      value: device.id,
      selected: device.id === s.inputDeviceId ? 'selected' : null,
    }, device.label)));
    mic.addEventListener('change', () => { setInputDevice(mic.value); });
    devices.appendChild(el('label', { class: 'voice-dock__device' },
      el('span', { class: 'voice-dock__devicelabel' }, 'Microphone'), mic));

    if (s.canChooseOutput) {
      const speaker = el('select', {
        class: 'input input--sm', 'aria-label': 'The speaker you hear the room through',
      }, ...outputs.map((device) => el('option', {
        value: device.id,
        selected: device.id === s.outputDeviceId ? 'selected' : null,
      }, device.label)));
      speaker.addEventListener('change', () => { setOutputDevice(speaker.value); });
      devices.appendChild(el('label', { class: 'voice-dock__device' },
        el('span', { class: 'voice-dock__devicelabel' }, 'Speaker'), speaker));
    }
  } else if (s.canChooseOutput && outputs.length) {
    // One speaker: it is the one, and there is nothing to choose.
    devices.appendChild(el('p', { class: 'voice-dock__devicehint' },
      'Playing through ' + (outputs[0].label || 'the default speaker') + '.'));
  }

  const status = el('div', { class: 'voice-dock__status', role: 'status' },
    el('p', { class: 'voice-dock__note' },
      icon(s.listenOnly ? 'mic-off' : 'info', { size: 14 }),
      ' ',
      flag.text,
      flag.offerRetry ? el('button', {
        class: 'dock-link', type: 'button',
        'aria-label': 'Try the microphone again',
        onClick: () => enableMic(),
      }, 'Grant it') : null));

  const peers = el('div', { class: 'voice-dock__peers' },
    (s.participants || []).slice(0, 6).map((p) => chip(p, s.channel && s.channel.serverId)));

  // The screen somebody is sharing, if anybody is.
  //
  // The picture is carried peer to peer like the sound is, so the dock shows
  // the stream the browser sent rather than a picture of its own.
  const screens = el('div', { class: 'voice-dock__screens' });
  for (const [userId, stream] of Object.entries(s.sharedScreens || {})) {
    if (!stream) continue;
    const video = el('video', {
      class: 'voice-dock__screen', autoplay: true, playsinline: true, muted: true,
    });
    video.srcObject = stream;
    screens.appendChild(el('div', { class: 'voice-dock__screenwrap' },
      video,
      el('span', { class: 'voice-dock__screenwho' },
        (personOf(userId, s.channel && s.channel.serverId) || {}).displayName || 'A screen')));
  }

  // Sharing this seat's screen.
  const shareButton = canShareScreen()
    ? el('button', {
      class: 'btn btn--default btn--sm', type: 'button',
      'aria-pressed': String(!!s.sharing),
      onClick: () => (s.sharing ? stopScreenShare() : startScreenShare()),
    }, s.sharing ? 'Stop sharing' : 'Share your screen')
    : null;

  return el('div', { class: 'voice-dock', role: 'complementary', 'aria-label': 'Voice session' },
    el('div', { class: 'voice-dock__top' }, lead,
      el('span', { class: 'voice-dock__state', 'data-state': state_ }, stateWord)),
    peers,
    screens,
    status,
    devices,
    shareButton ? el('div', { class: 'voice-dock__controls' }, shareButton) : null,
    controls);
}

// The speaking glow, on a place: chips stay put, only the class follows the
// audio level.
function paintSpeaking() {
  if (!host) return;
  const s = current();
  for (const chipNode of host.querySelectorAll('[data-peer]')) {
    const row = (s.participants || []).find((p) => String(p.userId) === chipNode.getAttribute('data-peer'));
    chipNode.classList.toggle('is-speaking', !!(row && row.speaking));
  }
}

function render() {
  const s = current();
  const sig = structureSignature();
  const live = !!(s.joined && s.channel);

  if (host && sig === lastStructure) {
    paintSpeaking();
    return;
  }
  lastStructure = sig;

  if (!live) {
    host = null;
    if (paintFn) paintFn(null);
    return;
  }

  host = dockNode();
  if (paintFn) paintFn(host);
}

export function mountVoiceDock(setDock) {
  if (!paintFn) paintFn = setDock;
  subscribe(render);
  render();
  // The devices are read once, so the picker is ready before there is a
  // session to pick one in.
  refreshDevices().catch(() => {});
}

export default { mountVoiceDock };
