// The voice room, as a channel page.
//
// A voice channel is a room, not a thread: who is in it right now, the standing
// invite to join, and the honest limits of this instance - the flag that is
// off, the browser that cannot speak, a network with no STUN. Nothing is said
// about the room before the server has been asked: "nobody is here" arrives
// only after the roster has answered.

import { el, replaceChildren } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import { avatar } from '../ui/primitives.js';
import { State, nameOf } from '../../packages/store.js';
import Api from '../../packages/api.js';
import { card, blank, hold } from '../ui/page.js';
import {
  subscribe, current, capabilities, currentCaps, join, leave, setMuted, setDeafened, enableMic,
} from './session.js';

let capsReady = false;

function memberOf(serverId, userId) {
  const roster = State.serverMembers.get(serverId);
  const items = (roster && roster.items) || [];
  return items.find((m) => String(m && m.id) === String(userId)) || null;
}

function rosterRow(participant, serverId, { small } = {}) {
  const person = memberOf(serverId, participant.userId) || { id: participant.userId };
  const label = person.nickname || nameOf(person) || 'Someone';
  const side = participant.connection === 'reconnecting'
    ? el('span', { class: 'chip chip--warn' }, 'Reconnecting')
    : participant.connection === 'connecting'
      ? el('span', { class: 'chip chip--quiet' }, 'Connecting')
      : participant.muted
        ? el('span', { class: 'voice-room__muteflag' }, icon('mic-off', { size: 13 }))
        : null;

  return el('li', {
    class: 'voice-room__row' + (participant.speaking ? ' is-speaking' : '')
      + (small ? ' voice-room__row--preview' : ''),
    'data-peer': String(participant.userId),
  },
    avatar(person, { size: small ? 'sm' : 'md', rounded: true }),
    el('span', { class: 'voice-room__name' }, label),
    el('span', { class: 'voice-room__row-side' }, side));
}

function joinControls(channel, serverId) {
  return el('button', {
    class: 'btn btn--default', type: 'button', 'aria-label': 'Join this voice room',
    onClick: () => join({ id: channel.id, serverId, name: channel.name, type: channel.type })
      .catch(() => {}),
  }, icon('headphones', { size: 16 }), 'Join the room');
}

// The room, one body. Structure changes rebuild; a speaking pulse only turns
// the glow class on the rows that are already here.
export function renderVoiceRoom(channel, serverId) {
  const body = el('div', { class: 'voice-room' });
  let lastStructure = '';

  const paint = () => {
    const s = current();
    const sig = JSON.stringify([
      capsReady, s.joined, s.channel && s.channel.id, s.muted, s.deafened, s.listenOnly, s.note,
      (s.participants || []).map((p) => [String(p.userId), p.connection, !!p.muted]),
    ]);

    if (sig === lastStructure) {
      for (const rowNode of body.querySelectorAll('[data-peer]')) {
        const userId = rowNode.getAttribute('data-peer');
        const row = (s.participants || []).find((p) => String(p.userId) === userId);
        rowNode.classList.toggle('is-speaking', !!(row && row.speaking));
      }
      return;
    }
    lastStructure = sig;

    if (!capsReady) {
      replaceChildren(body, hold('Asking whether this instance runs voice'));
      return;
    }

    const c = currentCaps();
    if (c && !c.enabled) {
      replaceChildren(body, blank({
        glyph: 'volume-off',
        title: 'Voice is off on this instance',
        text: 'An administrator can enable voice and video. Nothing here pretends a room exists before then.',
      }));
      return;
    }

    if (!s.joined) {
      // The roster is asked before anything is claimed about it. A room with
      // people shows them and the way in; a room without says so, having asked.
      replaceChildren(body, hold('Asking who is in the room'));
      Api.voiceMeshPeers(channel.id).then((room) => {
        if (current().joined) return; // the join landed while this was away
        const ids = (room && room.participants) || [];
        const preview = ids.map((userId) => ({ userId: String(userId), connection: 'live', muted: false, speaking: false }));
        const note = (room && (room.iceServers || []).length)
          ? 'Peer-to-peer audio, straight between members. The server only relays the introduction.'
          : 'No STUN or TURN is configured on this instance; connections may only form on the same network.';
        replaceChildren(body, 
          el('div', { class: 'voice-room__gate' },
            preview.length
              ? card({
                label: 'In the room',
                glyph: 'headphones',
                body: el('ul', { class: 'voice-room__roster' }, preview.map((p) => rosterRow(p, serverId, { small: true }))),
                flush: true,
              })
              : blank({
                glyph: 'volume',
                title: 'Nobody is in the room',
                text: 'Be the first to join.',
              }),
            joinControls(channel, serverId),
            el('p', { class: 'voice-room__note' }, note)));
      }).catch(() => {
        if (current().joined) return;
        replaceChildren(body, blank({
          glyph: 'volume',
          title: 'The room could not be read',
          text: 'The roster did not answer. Join anyway, or come back when the instance is reachable.',
        }));
      });
      return;
    }

    // The joined seat: the full room at hand.
    const rows = (s.participants || []).map((p) => rosterRow(p, serverId));
    const speakAgain = s.listenOnly
      ? el('li', {}, el('button', {
        class: 'btn btn--default btn--sm', type: 'button',
        'aria-label': 'Grant the microphone and speak',
        onClick: () => enableMic(),
      }, icon('mic', { size: 16 }), 'Speak: grant the microphone'))
      : null;

    replaceChildren(body, 
      card({
        label: 'In the room',
        glyph: 'headphones',
        body: el('ul', { class: 'voice-room__roster' }, rows),
        flush: true,
      }),
      el('ul', { class: 'voice-room__controls' },
        el('li', {},
          el('button', {
            class: 'btn btn--danger', type: 'button', 'aria-label': 'Disconnect from this room',
            onClick: () => leave(),
          }, icon('phone-off', { size: 16 }), 'Disconnect')),
        el('li', {},
          el('button', {
            class: 'btn btn--ghost' + (s.muted ? ' is-off' : ''), type: 'button',
            'aria-pressed': String(s.muted), 'aria-label': s.muted ? 'Unmute yourself' : 'Mute yourself',
            onClick: () => setMuted(!s.muted),
          }, icon(s.muted ? 'mic-off' : 'mic', { size: 16 }), s.muted ? 'Muted' : 'Speaking on')),
        el('li', {},
          el('button', {
            class: 'btn btn--ghost' + (s.deafened ? ' is-off' : ''), type: 'button',
            'aria-pressed': String(s.deafened), 'aria-label': s.deafened ? 'Hear the room again' : 'Deafen the room',
            onClick: () => setDeafened(!s.deafened),
          }, icon(s.deafened ? 'volume-off' : 'headphones', { size: 16 }), s.deafened ? 'You are deafened' : 'Deafen')),
        speakAgain),
      s.note ? el('p', { class: 'voice-room__note', role: 'status' }, s.note) : null);
  };

  capabilities().then(() => { capsReady = true; paint(); }).catch(() => { capsReady = true; paint(); });
  const unsubscribe = subscribe(paint);
  paint();

  return {
    node: body,
    cleanup() {
      unsubscribe();
    },
  };
}
