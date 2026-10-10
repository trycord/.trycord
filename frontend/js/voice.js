// Voice and video.
//
// This module owns the voice panel: whether the instance has voice at all, joining and
// leaving, the participant list, and this user's own mute and deafen state.
//
// It does not own the WebRTC peer connection. That needs a real browser with real media
// devices and a real SFU, and building it here untested would be pretending. What this
// module does own is everything either side of the media: the honest capability check,
// the room membership the server enforces, and the state the server persists.
//
// So the states are: voice is off (say so, offer nothing), voice is on (offer a join
// button), joining, connected, and every failure the server actually returned.

import Api from './api.js';
import { esc, el, clear, icon, toast, relTime, confirmDialog } from './ui.js';
import { avatar, presenceLabel } from './components.js';
import { navigate } from './nav.js';

// One panel per channel, so switching channels leaves the old one behind.
const panels = new Map();

// Cached once per session: the answer only changes when the operator restarts the instance
// with a different configuration, and re-asking on every render would be a request per
// panel open.
let capabilities = null;
let capabilitiesAsked = false;

export async function voiceCapabilities(force = false) {
  if (capabilitiesAsked && !force) return capabilities;
  capabilitiesAsked = true;
  try {
    const res = await Api.voiceCapabilities();
    capabilities = (res && res.voiceVideo) || { available: false, reason: 'disabled' };
  } catch {
    // An unreachable backend is not "voice is off", and calling it that would hide a real
    // problem behind a feature flag that was never read.
    capabilities = { available: false, reason: 'unknown', detail: 'could not reach the server' };
  }
  return capabilities;
}

// What the panel says when voice is not available. Three genuinely different reasons, and
// they need three different messages: an instance that has no voice, one whose media
// server is unreachable, and one the client could not ask.
function unavailableState(caps) {
  if (caps.reason === 'disabled') {
    return {
      title: 'Voice is off here',
      body: 'The administrator of this instance has not enabled voice and video.',
    };
  }
  if (caps.reason === 'misconfigured') {
    return {
      title: 'Voice is not configured',
      body: 'This instance has voice switched on, but its media server is not set up. '
        + 'An administrator needs to finish the configuration.',
    };
  }
  if (caps.reason === 'unreachable') {
    return {
      title: 'The media server is unreachable',
      body: 'Voice is enabled here, but the media server could not be reached. '
        + 'An administrator needs to check its configuration.',
    };
  }
  return {
    title: 'Voice is unavailable',
    body: 'Could not find out whether this instance supports voice.',
  };
}

// The panel. Always rendered for a voice channel; what it contains depends on the
// capability and whether this user has joined.
export async function renderVoicePanel(container, channel, context = {}) {
  const key = channel.id;
  const existing = panels.get(key);
  if (existing) {
    // Re-rendering must not discard a live session, so the panel object is kept and only
    // its contents are rebuilt.
    existing.region = container;
    paintPanel(existing, channel, context);
    return existing;
  }

  const panel = {
    channelId: channel.id,
    region: container,
    joined: false,
    sessionId: null,
    participants: [],
    muted: false,
    deafened: false,
    loading: false,
    error: null,
  };
  panels.set(key, panel);
  paintPanel(panel, channel, context);
  return panel;
}

function paintPanel(panel, channel, context) {
  const region = panel.region;
  if (!region) return;
  clear(region);

  voiceCapabilities().then((caps) => {
    if (panel.region !== region) return; // the channel was switched mid-request
    clear(region);
    region.appendChild(panelBody(panel, channel, context, caps));
  });
}

function panelBody(panel, channel, context, caps) {
  const wrap = el('div', { class: 'voice' });
  wrap.appendChild(el('div', { class: 'voice__head' }, [
    el('div', { class: 'voice__title' }, channel.name),
    el('div', { class: 'voice__sub' },
      channel.type === 'stage' ? 'Stage channel' : 'Voice channel'),
  ]));

  if (!caps.available) {
    const state = unavailableState(caps);
    wrap.appendChild(el('div', { class: 'voice__empty' }, [
      el('div', { class: 'voice__empty-title' }, state.title),
      el('div', { class: 'voice__empty-body' }, state.body),
    ]));
    return wrap;
  }

  // The sub-capability flags are read from the capability response rather than assumed, so
  // a provider that cannot screen-share does not show a screen-share button.
  const limit = caps.maxParticipants || 0;

  if (!panel.joined) {
    const joinBtn = el('button', {
      class: 'btn primary', type: 'button',
      disabled: panel.loading,
      onClick: () => joinPanel(panel, channel, caps),
    }, panel.loading ? 'Connecting…' : 'Join voice');
    wrap.appendChild(el('div', { class: 'voice__join' }, [
      joinBtn,
      limit ? el('div', { class: 'voice__hint' },
        'Up to ' + limit + ' people in this channel.') : null,
    ]));
    return wrap;
  }

  // Connected. Controls first, because that is what someone in a call reaches for.
  const controls = el('div', { class: 'voice__controls' });
  controls.appendChild(stateButton(panel, 'muted', 'Mute', 'mute'));
  controls.appendChild(stateButton(panel, 'deafened', 'Deafen', 'volume'));
  if (caps.screenSharing) {
    controls.appendChild(el('button', {
      class: 'btn sm', type: 'button',
      title: 'Share your screen',
      'aria-label': 'Share your screen',
      onClick: () => shareScreen(panel, channel),
    }, icon('image')));
  }
  controls.appendChild(el('button', {
    class: 'btn sm danger', type: 'button',
    onClick: () => leavePanel(panel, channel),
  }, 'Leave'));

  wrap.appendChild(controls);
  wrap.appendChild(participantList(panel, context));
  return wrap;
}

function stateButton(panel, key, label, iconName) {
  const on = panel[key];
  return el('button', {
    class: 'btn sm' + (on ? ' active' : ''),
    type: 'button',
    'aria-pressed': on ? 'true' : 'false',
    title: on ? 'Turn off ' + label.toLowerCase() : 'Turn on ' + label.toLowerCase(),
    onClick: () => setOwnState(panel, { [key]: !on }),
  }, [icon(iconName), el('span', {}, label)]);
}

function participantList(panel, context) {
  const list = el('div', { class: 'voice__participants' });
  if (!panel.participants.length) {
    list.appendChild(el('div', { class: 'voice__empty-body' }, 'Nobody else is here yet.'));
    return list;
  }

  list.appendChild(el('div', { class: 'voice__section-label' },
    panel.participants.length + (panel.participants.length === 1 ? ' person' : ' people')));

  for (const p of panel.participants) {
    const row = el('div', { class: 'voice__participant' });
    row.appendChild(avatar({
      id: p.userId, username: p.username, displayName: p.displayName, avatarUrl: p.avatarUrl,
    }, { withPresence: true }));

    const main = el('div', { class: 'voice__participant-main' });
    const name = el('div', { class: 'voice__participant-name' });
    name.appendChild(el('span', {}, p.displayName || p.username));
    if (p.muted) {
      name.appendChild(el('span', { class: 'voice__flag', title: 'Muted' }, 'muted'));
    }
    if (p.deafened) {
      name.appendChild(el('span', { class: 'voice__flag', title: 'Deafened' }, 'deafened'));
    }
    main.appendChild(name);
    if (p.joinedAt) {
      main.appendChild(el('div', { class: 'voice__participant-sub' }, 'joined ' + relTime(p.joinedAt)));
    }
    row.appendChild(main);

    // A moderator's controls only appear where the server says this user may moderate.
    if (context.canModerateVoice) {
      row.appendChild(moderateMenu(panel, p));
    }
    list.appendChild(row);
  }
  return list;
}

function moderateMenu(panel, participant) {
  const menu = el('div', { class: 'voice__moderate' });
  menu.appendChild(el('button', {
    class: 'btn sm', type: 'button', title: 'Mute', 'aria-label': 'Mute ' + (participant.displayName || participant.username),
    onClick: () => Api.voiceModerate(panel.channelId, participant.userId, { mute: true })
      .then(() => refreshPanel(panel))
      .catch((e) => toast(e.message || 'Could not mute', 'error')),
  }, icon('mute')));

  menu.appendChild(el('button', {
    class: 'btn sm danger', type: 'button',
    title: 'Disconnect', 'aria-label': 'Disconnect ' + (participant.displayName || participant.username),
    onClick: () => confirmDialog({
      title: 'Disconnect ' + (participant.displayName || participant.username) + '?',
      message: 'They will be removed from this voice channel.',
      danger: true, confirmText: 'Disconnect',
      onConfirm: () => Api.voiceModerate(panel.channelId, participant.userId, { disconnect: true })
        .then(() => refreshPanel(panel))
        .catch((e) => toast(e.message || 'Could not disconnect', 'error')),
    }),
  }, icon('logout')));
  return menu;
}

async function joinPanel(panel, channel, caps) {
  panel.loading = true;
  panel.error = null;
  paintPanel(panel, channel, {});

  try {
    const res = await Api.voiceJoin(channel.id);
    panel.joined = true;
    panel.sessionId = res.sessionId;
    panel.roomId = res.roomId;
    if (res.iceServers) panel.iceServers = res.iceServers;
    panel.participants = [];
    await refreshPanel(panel);
  } catch (e) {
    panel.error = e;
    // The server's own reason, not a generic failure: ROOM_FULL and FEATURE_DISABLED are
    // different problems with different fixes.
    toast(e.message || 'Could not join voice', 'error');
  } finally {
    panel.loading = false;
    paintPanel(panel, channel, {});
  }
}

async function leavePanel(panel, channel) {
  try {
    await Api.voiceLeave(channel.id);
  } catch (e) {
    toast(e.message || 'Could not leave voice', 'error');
  }
  panel.joined = false;
  panel.sessionId = null;
  panel.participants = [];
  paintPanel(panel, channel, {});
}

async function setOwnState(panel, patch) {
  try {
    await Api.voiceState(panel.channelId, patch);
    Object.assign(panel, patch);
    paintPanel(panel, { id: panel.channelId, name: panel.channelName || '' }, {});
  } catch (e) {
    toast(e.message || 'Could not change that', 'error');
  }
}

async function shareScreen(panel, channel) {
  try {
    await Api.voiceScreen(channel.id);
    toast('Screen sharing is starting', 'ok');
  } catch (e) {
    toast(e.message || 'Screen sharing is not available', 'error');
  }
}

async function refreshPanel(panel) {
  try {
    const list = await Api.voiceParticipants(panel.channelId);
    panel.participants = Array.isArray(list) ? list : [];
  } catch {
    // A failed participant read is not a reason to drop a live session.
    panel.participants = [];
  }
  paintPanel(panel, { id: panel.channelId, name: panel.channelName || '' }, {});
}

export function leaveVoice(channelId) {
  const panel = panels.get(channelId);
  if (!panel || !panel.joined) return Promise.resolve();
  return Api.voiceLeave(channelId).then(() => {
    panel.joined = false;
    panels.delete(channelId);
  }).catch(() => { /* leaving cleanly is best-effort at teardown */ });
}

export function voicePanelFor(channelId) {
  return panels.get(channelId) || null;
}

export default {
  renderVoicePanel, voiceCapabilities, leaveVoice, voicePanelFor,
};
