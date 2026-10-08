// The channel header: five toolbar buttons, the context header they sit in, and the
// three-element skeleton a conversation is drawn into.
//
// It was the top seventy lines of a channel renderer, and the reason it reads as its own
// thing is that it has no reason to know about messages. Nothing in here can send, edit or
// fetch one; it resolves the channel, decides what the viewer may do here, draws the
// buttons, and returns the skeleton. The renderer fills it.
//
// `onSearch` is a callback rather than the search panel itself because the panel is built
// long after the header is drawn - the header is the first thing on screen - so passing the
// panel would mean passing something that does not exist yet. The arrow resolves the
// binding when it is clicked, by which point it does.

import Api from '../api.js';
import State from '../state.js';
import { isMuted, setMuted, setChannelPermissions, refreshMutes } from '../state.js';
import { membersHidden, toggleMembers, renderAllChrome, renderContextHeader } from '../shell.js';
import { el, esc, icon, toast } from '../ui.js';
import { channelPath } from '../links.js';
import { navigate } from '../nav.js';

/**
 * Draw the header and the skeleton, and return both.
 *
 * @param {object}      o
 * @param {string}      o.serverId
 * @param {string}      o.channelId
 * @param {object}      o.server      the resolved community, for the subtitle fallback
 * @param {Function}    o.onSearch    called when the reader asks to search here
 */
export async function channelHeader({ serverId, channelId, server, onSearch }) {
  const channel = (State.channels.channels || [])
    .find((c) => String(c.id) === String(channelId));
  const chanName = channel ? channel.name : 'channel';

  const memberToggle = el('button', {
    class: 'btn icon member-toggle', type: 'button',
    title: membersHidden() ? 'Show member list' : 'Hide member list',
    'aria-label': membersHidden() ? 'Show member list' : 'Hide member list',
    'aria-pressed': membersHidden() ? 'false' : 'true',
    onClick: (e) => {
      toggleMembers();
      const hidden = membersHidden();
      const btn = e.currentTarget;
      btn.title = hidden ? 'Show member list' : 'Hide member list';
      btn.setAttribute('aria-label', btn.title);
      btn.setAttribute('aria-pressed', hidden ? 'false' : 'true');
    },
  }, icon('menu'));
  // The server's own channel-scoped permission answer for this viewer. Fetched
  // per channel because an override on this channel, or on its category, is
  // invisible to the community-level list the composer used to consult.
  try {
    const ov = await Api.channelOverrides(serverId, channelId);
    setChannelPermissions(ov && Array.isArray(ov.effective) ? ov.effective : null);
  } catch { setChannelPermissions(null); /* fall back to community-level */ }
  let muted = isMuted(channelId);
  try { await refreshMutes(); muted = isMuted(channelId); } catch { /* keep last known */ }
  const bellBtn = el('button', {
    class: 'btn icon', type: 'button',
    title: muted ? 'Unmute this channel' : 'Mute this channel',
    'aria-label': muted ? 'Unmute this channel' : 'Mute this channel',
    'aria-pressed': muted ? 'true' : 'false',
    onClick: async (e) => {
      const btn = e.currentTarget;
      try {
        if (isMuted(channelId)) {
          await Api.unmuteChannel(channelId);
          setMuted(channelId, false);
        } else {
          await Api.muteChannel(channelId);
          setMuted(channelId, true);
        }
        const now = isMuted(channelId);
        renderAllChrome();
        btn.textContent = now ? '⊘' : '◉';
        btn.title = now ? 'Unmute this channel' : 'Mute this channel';
        btn.setAttribute('aria-label', btn.title);
        btn.setAttribute('aria-pressed', now ? 'true' : 'false');
        toast(now ? 'Channel muted.' : 'Channel unmuted.', 'ok');
      } catch (ex) { toast(ex.message || 'Could not change mute.', 'error'); }
    },
  }, muted ? '⊘' : '◉');
  const searchBtn = el('button', {
    class: 'btn icon', type: 'button', title: 'Search in this community', 'aria-label': 'Search messages',
    onClick: () => onSearch(),
  }, icon('search'));
  const pinsBtn = el('button', {
    class: 'btn icon', type: 'button', title: 'Pinned messages', 'aria-label': 'Pinned messages',
    onClick: () => { navigate(channelPath(serverId, channelId, '/pins')); },
  }, icon('star'));
  const moreBtn = el('button', {
    class: 'btn icon', type: 'button', title: 'Community actions', 'aria-label': 'Community actions',
    onClick: () => {
      const menu = document.querySelector('#place-navigation .place-header__menu');
      if (menu) menu.click();
    },
  }, icon('more'));
  renderContextHeader({ title: '#' + chanName, sub: (channel && channel.topic) ? esc(channel.topic) : server.name, icon: '#', actions: [searchBtn, pinsBtn, bellBtn, moreBtn, memberToggle] });

  const conv = el('div', { class: 'conversation' });
  const thread = el('div', { class: 'thread' });
  const feed = el('div', { class: 'feed' });
  thread.appendChild(feed);
  conv.appendChild(thread);

  return { conv, thread, feed };
}
