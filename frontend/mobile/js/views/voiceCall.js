// The voice call, on a phone.
//
// The same session the desktop uses - the shared engine in
// packages/voiceSession.js - and a panel of its own, because a phone has no
// room for a floating dock: the call is a sheet over the page, with the
// people in the room, the three acts that matter, and the devices.
//
// The panel says what the session says. There is no "connected" that is not
// the connection, and no speaking glow that is not the audio.

import { el, replaceChildren } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import { sheet, toast } from '../ui.js';
import { avatar } from '../components.js';
import { State, nameOf } from '../../../packages/store.js';
import {
  subscribe, current, join, leave, setMuted, setDeafened, enableMic,
  refreshDevices, setInputDevice, setOutputDevice,
  canShareScreen, startScreenShare, stopScreenShare,
} from '../../../packages/voiceSession.js';

// The name of somebody in the room.
function personOf(userId, serverId) {
  const roster = State.serverMembers.get(serverId)
    || (() => {
      for (const entry of State.serverMembers.values()) return entry;
      return null;
    })();
  const items = (roster && roster.items) || [];
  return items.find((member) => String(member && member.id) === String(userId))
    || { id: userId };
}

// The state of the connection, in a word.
const STATE_WORD = {
  idle: 'Not in a room',
  joining: 'Joining the room',
  connecting: 'Connecting',
  connected: 'Connected',
  reconnecting: 'Reconnecting',
  failed: 'The connection failed',
  leaving: 'Leaving',
};

/**
 * Join a voice channel and show the call.
 *
 * The sheet opens first, so the reader sees what is happening while the
 * microphone is being asked for - and so a refusal is a sentence in the
 * panel rather than a failure with nothing on the screen.
 *
 * @param {object} channel  { id, serverId, name, type }
 */
export async function joinVoiceCall(channel) {
  const host = el('div', { class: 'm-stack' });
  // The sheet is the call on a phone, so closing it ends the call: a call
  // nobody can hear is not a call, and the phone has no floating dock to
  // carry it in.
  const layer = sheet({
    title: 'In the room: ' + (channel.name || 'voice'),
    body: host,
    onClose: () => { leave(); },
  });

  const paint = () => {
    const s = current();
    const state = s.connection || 'idle';
    const status = el('div', { class: 'm-notice m-notice--info', role: 'status' },
      el('span', { class: 'm-notice__icon' }, icon('info', { size: 18 })),
      el('div', { class: 'm-notice__main' },
        el('div', { class: 'm-notice__text' }, STATE_WORD[state] || 'Connected')));

    const people = el('div', { class: 'm-list' });
    const rows = (s.participants || []);
    if (!rows.length) {
      people.appendChild(el('p', { class: 'm-section__note' }, 'Nobody is here yet.'));
    }
    for (const row of rows) {
      const person = personOf(row.userId, channel.serverId);
      const label = person.nickname || nameOf(person) || 'Someone';
      people.appendChild(el('div', {
        class: 'm-row' + (row.speaking ? ' is-speaking' : ''),
      },
        el('span', { class: 'm-row__lead' }, avatar(person, { size: 'md', presence: true, decorative: true })),
        el('span', { class: 'm-row__body' },
          el('span', { class: 'm-row__title truncate' }, label),
          el('span', { class: 'm-row__sub truncate' },
            row.connection === 'live' ? 'Connected'
              : row.connection === 'reconnecting' ? 'Reconnecting'
                : row.connection === 'failed' ? 'The connection failed'
                  : 'Connecting')),
        row.muted ? el('span', { class: 'm-row__trailing' }, icon('mic-off', { size: 16 })) : null));
    }

    // The screen somebody is sharing, if anybody is.
    const screens = el('div', { class: 'm-stack' });
    for (const [userId, stream] of Object.entries(s.sharedScreens || {})) {
      if (!stream) continue;
      const video = el('video', {
        class: 'm-video', autoplay: true, playsinline: true, muted: true,
      });
      video.srcObject = stream;
      screens.appendChild(video);
    }

    const controls = el('div', { class: 'm-stack' });
    const mic = el('button', {
      class: 'm-btn' + (s.muted ? ' m-btn--ghost' : ''), type: 'button',
      'aria-pressed': String(s.muted),
      onClick: () => setMuted(!s.muted),
    }, s.muted ? 'Unmute' : 'Mute');
    const deaf = el('button', {
      class: 'm-btn' + (s.deafened ? ' m-btn--ghost' : ''), type: 'button',
      'aria-pressed': String(s.deafened),
      onClick: () => setDeafened(!s.deafened),
    }, s.deafened ? 'Undeafen' : 'Deafen');
    const gone = el('button', {
      class: 'm-btn m-btn--danger', type: 'button',
      onClick: async () => { await leave(); layer.close(); },
    }, 'Leave');
    controls.appendChild(mic);
    controls.appendChild(deaf);
    controls.appendChild(gone);
    if (canShareScreen()) {
      const share = el('button', {
        class: 'm-btn' + (s.sharing ? ' m-btn--ghost' : ''), type: 'button',
        'aria-pressed': String(!!s.sharing),
        onClick: () => (s.sharing ? stopScreenShare() : startScreenShare()),
      }, s.sharing ? 'Stop sharing' : 'Share your screen');
      controls.appendChild(share);
    }
    if (s.listenOnly) {
      const grant = el('button', {
        class: 'm-btn m-btn--primary', type: 'button',
        onClick: () => enableMic(),
      }, 'Allow the microphone');
      controls.appendChild(grant);
    }

    // The devices.
    const devices = el('div', { class: 'm-stack' });
    const inputs = s.inputs || [];
    const outputs = s.outputs || [];
    if (inputs.length > 1) {
      const picker = el('select', {
        class: 'm-input m-input--compact m-input--select',
        'aria-label': 'The microphone you speak with',
      }, ...inputs.map((device) => el('option', {
        value: device.id,
        selected: device.id === s.inputDeviceId ? 'selected' : null,
      }, device.label)));
      picker.addEventListener('change', () => { setInputDevice(picker.value); });
      devices.appendChild(el('label', { class: 'm-field' },
        el('span', { class: 'm-field__label' }, 'Microphone'), picker));
    }
    if (s.canChooseOutput && outputs.length > 1) {
      const picker = el('select', {
        class: 'm-input m-input--compact m-input--select',
        'aria-label': 'The speaker you hear the room through',
      }, ...outputs.map((device) => el('option', {
        value: device.id,
        selected: device.id === s.outputDeviceId ? 'selected' : null,
      }, device.label)));
      picker.addEventListener('change', () => { setOutputDevice(picker.value); });
      devices.appendChild(el('label', { class: 'm-field' },
        el('span', { class: 'm-field__label' }, 'Speaker'), picker));
    }

    replaceChildren(host, status, people, screens, devices, controls);
  };

  const unsubscribe = subscribe(paint);
  paint();
  refreshDevices().catch(() => {});

  try {
    await join(channel);
  } catch (error) {
    toast((error && error.message) || 'The room refused the join.', { type: 'danger' });
  }
  paint();

  // The subscription ends with the sheet.
  const close = layer.close;
  layer.close = () => { unsubscribe(); close(); };
  return layer;
}

export default { joinVoiceCall };
