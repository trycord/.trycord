// The command palette.
//
// One input, three jobs in one place: jump to a place, act, and search what has
// been said. Ctrl/Cmd+K opens it from anywhere. Everything it lists is read from
// the registry and the store - the destinations, the communities, the open
// channels, the conversations - so there is no second navigation list to drift
// from the application the way a hand-written menu would.
//
// Message search runs against the server (membership-scoped, and scoped to the
// community you are inside when you are inside one); people search is the same
// endpoint the friend finder uses.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import { openDialog } from '../ui/overlays.js';
import { globalPages, pageById } from '../../packages/registry.js';
import { State, dmPeer, nameOf } from '../../packages/store.js';
import { currentRoute, navigate } from '../../packages/nav.js';
import Api from '../../packages/api.js';

const SEARCH_DEBOUNCE_MS = 220;
const SEARCH_MIN = 2;

export function shortcutLabel() {
  try {
    const platform = (navigator.userAgentData && navigator.userAgentData.platform)
      || navigator.platform || '';
    return /mac|iphone|ipad/i.test(platform) ? '⌘K' : 'Ctrl K';
  } catch {
    return 'Ctrl K';
  }
}

function channelIconName(type) {
  if (type === 'voice' || type === 'stage') return 'volume';
  if (type === 'announcement') return 'bell';
  if (type === 'forum') return 'list';
  return 'hash';
}

function currentServerId() {
  const match = /^\/server\/([^/]+)/.exec(currentRoute());
  return match ? match[1] : null;
}

function staticEntries() {
  const entries = [];
  for (const page of globalPages()) {
    entries.push({ group: 'Go to', label: page.nav.label, icon: page.nav.icon, route: page.route });
  }
  if (pageById('settings')) entries.push({ group: 'Go to', label: 'Settings', icon: 'settings', route: '/settings' });
  if (State.user && State.user.isAdmin) entries.push({ group: 'Go to', label: 'Instance admin', icon: 'shield', route: '/admin' });
  if (State.user) entries.push({ group: 'Go to', label: 'Your profile', icon: 'user', route: '/users/' + State.user.id });

  for (const server of State.servers) {
    entries.push({ group: 'Communities', label: server.name, icon: 'grid', route: '/server/' + server.id });
  }
  for (const dm of State.dms) {
    const peer = dmPeer(dm);
    entries.push({
      group: 'Conversations',
      label: peer ? nameOf(peer) : 'Conversation',
      icon: 'message',
      route: '/dms/' + dm.id,
    });
  }

  const serverId = currentServerId();
  const tree = serverId ? State.serverTree.get(serverId) : null;
  for (const channel of (tree && tree.channels) || []) {
    entries.push({
      group: 'Channels',
      label: channel.name,
      icon: channelIconName(channel.type),
      route: '/server/' + serverId + '/channel/' + channel.id,
    });
  }
  return entries;
}

export function openPalette() {
  let entries = staticEntries();
  let searchTimer = null;
  let searchToken = 0;
  let activeIndex = 0;

  const input = el('input', {
    class: 'palette-input', type: 'text',
    placeholder: 'Search or jump to...',
    'aria-label': 'Search or jump to a place',
    autocomplete: 'off', spellcheck: 'false',
    role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'palette-results',
  });

  const results = el('div', {
    class: 'palette-results', id: 'palette-results', role: 'listbox',
    'aria-label': 'Results',
  });

  const palette = el('div', { class: 'palette' },
    el('div', { class: 'palette-input-row' }, icon('search', { size: 16 }), input),
    results);

  const dialog = openDialog({
    head: false,
    class: 'dialog--palette',
    overlayClass: 'overlay--top',
    onClose: () => { if (searchTimer) clearTimeout(searchTimer); },
  });
  dialog.element.appendChild(palette);
  dialog.element.setAttribute('aria-label', 'Command palette');

  function items() {
    return Array.from(results.querySelectorAll('.palette-item'));
  }

  function paintActive() {
    const all = items();
    if (!all.length) return;
    activeIndex = Math.max(0, Math.min(activeIndex, all.length - 1));
    all.forEach((item, index) => {
      const on = index === activeIndex;
      item.classList.toggle('is-active', on);
      item.setAttribute('aria-selected', String(on));
    });
    all[activeIndex].scrollIntoView({ block: 'nearest' });
  }

  function render() {
    const query = input.value.trim().toLowerCase();
    const filtered = entries.filter((entry) => !query
      || entry.label.toLowerCase().includes(query)
      || entry.group.toLowerCase().includes(query));

    results.replaceChildren();
    if (!filtered.length) {
      results.appendChild(el('div', { class: 'palette-note' },
        query ? 'Nothing matches.' : 'Start typing to search.'));
      return;
    }

    const order = ['Go to', 'Communities', 'Conversations', 'Channels', 'People', 'Messages'];
    const groups = new Map();
    for (const entry of filtered) {
      const list = groups.get(entry.group) || [];
      list.push(entry);
      groups.set(entry.group, list);
    }
    for (const name of order) {
      const list = groups.get(name);
      if (!list || !list.length) continue;
      const group = el('div', { class: 'palette-group' },
        el('div', { class: 'palette-group-label' }, name));
      for (const entry of list) {
        group.appendChild(paletteItem(entry));
      }
      results.appendChild(group);
    }
    paintActive();
  }

  function paletteItem(entry) {
    return el('button', {
      class: 'palette-item', type: 'button', role: 'option', 'aria-selected': 'false',
      onClick: () => choose(entry),
    },
      icon(entry.icon, { size: 16 }),
      el('span', { class: 'palette-item-label truncate' }, entry.label),
      entry.hint ? el('span', { class: 'palette-item-hint truncate' }, entry.hint) : null,
    );
  }

  function choose(entry) {
    dialog.close();
    navigate(entry.route);
  }

  function runSearch(query) {
    const token = ++searchToken;
    const serverId = currentServerId();
    Api.searchUsers(query).then((people) => {
      if (token !== searchToken) return;
      const list = Array.isArray(people) ? people : (people && people.users) || [];
      for (const user of list.slice(0, 6)) {
        entries.push({
          group: 'People',
          label: user.display_name || user.displayName || user.username,
          hint: '@' + user.username,
          icon: 'user',
          route: '/users/' + user.id,
        });
      }
      render();
    }).catch(() => { /* people search is best-effort */ });

    Api.search(query, serverId ? { serverId, limit: 12 } : { limit: 12 }).then((rows) => {
      if (token !== searchToken) return;
      for (const row of (Array.isArray(rows) ? rows : []).slice(0, 8)) {
        entries.push({
          group: 'Messages',
          label: String(row.content || '').replace(/\s+/g, ' ').trim() || '(attachment)',
          hint: '#' + (row.channel_name || 'channel'),
          icon: 'message',
          route: '/server/' + row.server_id + '/channel/' + row.channel_id,
        });
      }
      render();
    }).catch(() => { /* message search is best-effort */ });
  }

  function onInput() {
    const query = input.value.trim();
    entries = staticEntries();
    searchToken++;
    if (searchTimer) clearTimeout(searchTimer);
    if (query.length >= SEARCH_MIN) {
      const token = searchToken;
      searchTimer = setTimeout(() => { if (token === searchToken) runSearch(query.toLowerCase()); }, SEARCH_DEBOUNCE_MS);
    }
    activeIndex = 0;
    render();
  }

  function onKey(event) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const all = items();
      if (!all.length) return;
      event.preventDefault();
      activeIndex = event.key === 'ArrowDown'
        ? (activeIndex + 1) % all.length
        : (activeIndex - 1 + all.length) % all.length;
      paintActive();
      return;
    }
    if (event.key === 'Enter') {
      const all = items();
      if (!all.length) return;
      event.preventDefault();
      const active = all[Math.max(0, Math.min(activeIndex, all.length - 1))];
      if (active) active.click();
    }
  }

  input.addEventListener('input', onInput);
  input.addEventListener('keydown', onKey);
  render();
  return dialog;
}
