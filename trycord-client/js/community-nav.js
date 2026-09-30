// Community context navigation.
//
// This replaces the community sidebar: the banner header, the "Text channels"
// label above a flat list, the empty area, and the account panel pinned to the
// bottom. What it keeps is everything the old one did - switch community, reach
// every channel, and act on a channel or the community within the permissions
// the viewer actually has.
//
// The shape is a single switchable header and one scroller, because those are
// the two things a reader needs before they start reading. The banner is gone:
// it was a large, mostly empty image that pushed the channels it was supposed to
// be labelling below the fold, and the community is already identified by the
// rail chip and by the channel header. A compact control row carries the
// identity instead, and it is the same control whether or not a banner exists.
//
// The account panel moved out rather than being deleted. The rail is global
// navigation and already spans every surface, so "who am I" and "my settings"
// belong there rather than in a panel that only existed inside a community.
import { el, icon, attachContextMenu, attachMenu, copyText, confirmDialog, toast } from './ui.js';
import { communityMark } from './components.js';
import Api from './api.js';
import State, { can, isMuted, setMuted, refreshServers, leaveServerContext } from './state.js';
import { navigate, route } from './nav.js';
import { serverPath, channelPath, absoluteChannelUrl } from './links.js';

const LS_COLLAPSED = 'trycord.v2.communityGroups';

function collapsedKeys() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_COLLAPSED) || '[]');
    return new Set(Array.isArray(raw) ? raw : []);
  } catch { return new Set(); }
}

function persistCollapsed(set) {
  try { localStorage.setItem(LS_COLLAPSED, JSON.stringify([...set])); } catch { /* ignore */ }
}

function communityName(sid, server) {
  return (server && server.name) || (State.serverDetail && State.serverDetail.name) || 'Community';
}

/**
 * One control that identifies the community and opens everything that can be
 * done to it. Permission-shaped, and built on the shared menu so dismissal,
 * Escape and arrow keys behave as they do everywhere else.
 */
function communitySwitcher(sid, server) {
  const name = communityName(sid, server);
  const others = (State.servers || []).filter((s) => String(s.id) !== String(sid));
  const base = serverPath(sid);

  const wrap = el('div', { class: 'ctx-switcher' });
  const trigger = el('button', {
    class: 'ctx-switcher__trigger',
    type: 'button',
    'aria-haspopup': 'menu',
    'aria-label': 'Community menu for ' + name,
  });
  trigger.appendChild(el('span', { class: 'ctx-switcher__mark' },
    communityMark(name, { server: server || State.serverDetail })));
  const text = el('span', { class: 'ctx-switcher__text' });
  text.appendChild(el('span', { class: 'ctx-switcher__name' }, name));
  const count = (State.members || []).length;
  text.appendChild(el('span', { class: 'ctx-switcher__meta' },
    count ? count + (count === 1 ? ' member' : ' members') : 'Community'));
  trigger.appendChild(text);
  trigger.appendChild(el('span', { class: 'ctx-switcher__caret', 'aria-hidden': 'true' }, icon('chevron')));
  wrap.appendChild(trigger);

  attachMenu(trigger, () => {
    const go = (p) => () => navigate(p);
    const items = [{ label: 'Community overview', icon: 'home', onSelect: go(base) }];

    if (others.length) {
      items.push({ label: 'Switch community', icon: 'users', submenu: others.map((s) => ({
        label: s.name || 'Community',
        onSelect: go(serverPath(s.id)),
      })) });
    }
    items.push({ sep: true });
    items.push({ label: 'Members', icon: 'users', onSelect: go(base + '/members') });
    if (can('MANAGE_ROLES') || can('MANAGE_SERVER')) {
      items.push({ label: 'Roles', icon: 'shield', onSelect: go(base + '/roles') });
    }
    if (can('MANAGE_CHANNELS')) {
      items.push({ label: 'Categories', icon: 'list', onSelect: go(base + '/categories') });
      items.push({ label: 'Create channel', icon: 'plus', onSelect: go(base + '/channels/new') });
    }
    if (can('MANAGE_INVITES')) {
      items.push({ label: 'Invites', icon: 'mail', onSelect: go(base + '/invites') });
    }
    if (can('MANAGE_SERVER')) {
      items.push({ label: 'Community settings', icon: 'gear', onSelect: go(base + '/settings') });
    }
    items.push({ sep: true });
    items.push({
      label: 'Leave community', icon: 'logout', danger: true,
      onSelect: () => leaveCommunity(sid, server),
    });
    return items;
  });

  return wrap;
}

function leaveCommunity(sid, server) {
  if (server && server.is_owner) {
    toast('You own this community. Transfer or delete it first.', 'warn');
    return;
  }
  confirmDialog({
    title: 'Leave ' + communityName(sid, server) + '?',
    message: 'You can rejoin later with a new invite.',
    danger: true,
    confirmText: 'Leave',
    onConfirm: async () => {
      try {
        await Api.leaveServer(sid);
        await refreshServers();
        leaveServerContext();
        navigate(route('/home'));
      } catch (ex) { toast(ex.message || 'Failed to leave', 'error'); }
    },
  });
}

/**
 * A channel row. The count is the unread signal the sidebar is allowed to
 * invent, which is none - there is no per-channel unread count in the state, so
 * the row shows the channel and its muted state and nothing it cannot back up.
 */
function channelButton(sid, ch, here) {
  const active = here === '/server/' + sid + '/channel/' + ch.id;
  const muted = isMuted(ch.id);
  const row = el('button', {
    class: 'ctx-channel' + (active ? ' is-active' : '') + (muted ? ' is-muted' : ''),
    type: 'button',
    'aria-current': active ? 'page' : null,
    title: (muted ? '#' : '#') + (ch.name || 'channel') + (muted ? ' (muted)' : ''),
    onClick: () => navigate(channelPath(sid, ch.id)),
  });
  row.appendChild(el('span', { class: 'ctx-channel__hash', 'aria-hidden': 'true' }, '#'));
  row.appendChild(el('span', { class: 'ctx-channel__name' }, ch.name));
  if (muted) {
    row.appendChild(el('span', { class: 'ctx-channel__state', 'aria-label': 'muted' },
      icon('bell-off')));
  }
  return row;
}

function channelActions(sid, ch) {
  const cid = String(ch.id);
  const items = [
    { label: 'Open channel', desc: '#' + (ch.name || 'channel'), onSelect: () => navigate(channelPath(sid, ch.id)) },
    { label: isMuted(ch.id) ? 'Unmute channel' : 'Mute channel', onSelect: () => setMuted(ch.id, !isMuted(ch.id)) },
    { label: 'Copy channel link', onSelect: () => copyText(absoluteChannelUrl(sid, cid), 'Channel link copied.') },
    { label: 'Copy channel ID', onSelect: () => copyText(cid, 'Channel ID copied.') },
  ];
  if (can('MANAGE_CHANNELS')) {
    items.push({ sep: true });
    items.push({ label: 'Edit channel', onSelect: () => navigate(serverPath(sid, 'settings/structure')) });
  }
  return items;
}

/** A collapsible channel group. Collapsed state persists per community. */
function channelGroup({ label, sid, channels, here, collapsed, onToggle }) {
  const section = el('section', { class: 'ctx-group' + (collapsed ? ' is-collapsed' : '') });
  const head = el('button', {
    class: 'ctx-group__head',
    type: 'button',
    'aria-expanded': collapsed ? 'false' : 'true',
  });
  head.appendChild(el('span', { class: 'ctx-group__caret', 'aria-hidden': 'true' }, icon('chevron')));
  head.appendChild(el('span', { class: 'ctx-group__label' }, label));
  head.appendChild(el('span', { class: 'ctx-group__count' }, String(channels.length)));
  section.appendChild(head);

  const list = el('div', { class: 'ctx-group__list' });
  for (const ch of channels) {
    const row = channelButton(sid, ch, here);
    attachContextMenu(row, () => channelActions(sid, ch), {
      target: () => ({ type: 'channel', id: String(ch.id) }),
    });
    list.appendChild(row);
  }
  section.appendChild(list);

  head.addEventListener('click', () => {
    const next = !section.classList.contains('is-collapsed');
    section.classList.toggle('is-collapsed', next);
    head.setAttribute('aria-expanded', next ? 'false' : 'true');
    onToggle(next);
  });
  return section;
}

export function renderCommunityContext(region, sid, here) {
  const server = (State.servers || []).find((x) => String(x.id) === String(sid))
    || (State.serverDetail && String(State.serverDetail.id) === String(sid) ? State.serverDetail : null);

  region.appendChild(communitySwitcher(sid, server));

  const search = el('input', {
    class: 'ctx-filter',
    type: 'search',
    placeholder: 'Find a channel',
    'aria-label': 'Filter channels in this community',
    autocomplete: 'off',
  });
  region.appendChild(search);

  const scroll = el('div', { class: 'ctx-scroll ctx-scroll--channels' });
  region.appendChild(scroll);

  const empty = el('p', { class: 'ctx-empty', hidden: true }, 'No channel matches that.');
  region.appendChild(empty);

  const layout = State.channels || { categories: [], channels: [] };
  const categories = layout.categories || [];
  const channels = layout.channels || [];
  const collapsed = collapsedKeys();
  const keyFor = (catId) => 'v2:' + sid + ':' + catId;

  const byCategory = new Map();
  for (const c of channels) {
    const k = c.category_id ? String(c.category_id) : '__none__';
    if (!byCategory.has(k)) byCategory.set(k, []);
    byCategory.get(k).push(c);
  }

  const setCollapsed = (catId, isCollapsed) => {
    const key = keyFor(catId);
    const set = collapsedKeys();
    if (isCollapsed) set.add(key); else set.delete(key);
    persistCollapsed(set);
  };

  const uncategorised = byCategory.get('__none__') || [];
  const groups = [];

  const addGroup = (label, list, catId) => {
    if (!list.length) return;
    const key = keyFor(catId);
    const group = channelGroup({
      label, sid, channels: list, here,
      collapsed: collapsed.has(key),
      onToggle: (c) => setCollapsed(catId, c),
    });
    scroll.appendChild(group);
    groups.push(group);
  };

  addGroup(categories.length ? 'Channels' : 'Text channels', uncategorised, '__none__');
  for (const cat of categories) {
    addGroup(cat.name || 'Category', byCategory.get(String(cat.id)) || [], String(cat.id));
  }

  if (!channels.length) {
    const none = el('div', { class: 'ctx-empty' },
      can('MANAGE_CHANNELS')
        ? 'This community has no channels yet.'
        : 'This community has no channels yet.');
    if (can('MANAGE_CHANNELS')) {
      none.appendChild(el('button', {
        class: 'btn sm', type: 'button',
        onClick: () => navigate(serverPath(sid, 'channels/new')),
      }, 'Create the first channel'));
    }
    scroll.appendChild(none);
  }

  search.addEventListener('input', () => {
    const needle = search.value.trim().toLowerCase();
    let shown = 0;
    for (const group of groups) {
      let any = 0;
      for (const row of group.querySelectorAll('.ctx-channel')) {
        const name = (row.querySelector('.ctx-channel__name')?.textContent || '').toLowerCase();
        const hit = !needle || name.includes(needle);
        row.hidden = !hit;
        if (hit) any++;
      }
      group.hidden = any === 0;
      shown += any;
    }
    empty.hidden = shown > 0 || !needle;
  });
}

export default { renderCommunityContext };
