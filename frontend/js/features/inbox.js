// The Inbox, remade.
//
// Everything addressed to the reader, newest first, told as a calendar stream:
// day rails between what arrived today, yesterday and before. The filters narrow
// by category as well as by unread; the footer keeps older entries one step
// away. This is the full list behind the Pulse card on Home - same rows, same
// voice.

import { el, replaceChildren } from '../../packages/dom.js';
import {
  State, refreshNotifications, on as onStore, forgetNotifications,
} from '../../packages/store.js';
import Api from '../../packages/api.js';
import { head, hold, fault, blank, fold } from '../ui/page.js';
import { confirmDialog, errorToast, toast } from '../ui/overlays.js';
import { activityRow } from './activity.js';

const FILTERS = [
  ['all', 'All'],
  ['unread', 'Unread'],
  ['dm', 'Messages'],
  ['mention', 'Mentions'],
  ['friend', 'Friends'],
  ['group', 'Groups'],
  ['community', 'Communities'],
  ['moderation', 'Safety'],
  ['announcement', 'Announcements'],
];

const CATEGORY_FILTERS = new Set(FILTERS.map(([value]) => value).filter(
  (value) => value !== 'all' && value !== 'unread'
));

function dayKey(iso) {
  const d = new Date(iso || Date.now());
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, today)) return 'Today';
  if (same(d, yesterday)) return 'Yesterday';
  return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
}

function dayRail(label) {
  return el('div', {
    class: 'feedday', role: 'separator', 'aria-hidden': 'false',
  }, el('span', { class: 'feedday-label' }, label));
}

export function renderInbox() {
  const list = el('div', { class: 'feedlist' });
  const pager = el('div', { class: 'pagerline' });
  let filter = 'all';
  let loading = false;

  // A category is a request to the server, because the unread totals and the
  // cursor are the server's; "unread" is a lens over whatever is already here.
  const categoryFor = (value) => (CATEGORY_FILTERS.has(value) ? value : null);

  const chips = el('div', { class: 'chips', role: 'group', 'aria-label': 'Filter notifications' },
    ...FILTERS.map(([value, label]) => {
      const chip = el('button', {
        class: 'chip' + (value === 'unread' ? ' chip--quiet' : ''), type: 'button',
        'aria-pressed': 'false',
      }, label);
      chip.dataset.value = value;
      chip.addEventListener('click', () => {
        if (filter === value || loading) return;
        filter = value;
        if (categoryFor(value) && State.notifications.category !== value) loadCategory(value);
        else if (value === 'all' || value === 'unread') {
          if (State.notifications.category) loadCategory(null);
          else paint();
        } else paint();
      });
      return chip;
    }));

  const markAll = el('button', {
    class: 'btn btn--default btn--sm', type: 'button', onClick: () => markAllRead(),
  }, 'Mark all read');
  const clearRead = el('button', {
    class: 'btn btn--ghost btn--sm', type: 'button', onClick: () => clearReadItems(),
  }, 'Clear read');
  const clearAll = el('button', {
    class: 'btn btn--danger btn--sm', type: 'button', onClick: () => clearAllItems(),
  }, 'Clear all');

  const node = fold([
    head({
      kicker: 'Inbox',
      title: 'Notifications',
      lede: 'Everything addressed to you, by day. Opening an entry marks it read and follows it.',
      actions: [chips, el('div', { class: 'pagehead-actions' }, markAll, clearRead, clearAll)],
    }),
    list,
    pager,
  ]);

  function items() {
    return (State.notifications && State.notifications.items) || [];
  }

  function unreadTotal() {
    return (State.notifications && State.notifications.unreadCount) || 0;
  }

  function paintChips() {
    const byCategory = (State.notifications && State.notifications.unreadByCategory) || {};
    const all = items();
    const unreadHere = all.filter((entry) => !entry.readAt).length;
    for (const chip of chips.children) {
      const value = chip.dataset.value;
      let label = FILTERS.find((entry) => entry[0] === value)[1];
      const count = value === 'all' || value === 'unread'
        ? unreadTotal()
        : (byCategory[value] || 0);
      if (count) label += ' (' + count + ')';
      chip.textContent = label;
      chip.classList.toggle('chip--on', value === filter);
      chip.setAttribute('aria-pressed', value === filter ? 'true' : 'false');
    }
    // The badge can lag behind a row that just arrived; a list that still
    // holds an unread entry keeps the action available even then.
    markAll.disabled = loading || !(unreadTotal() || unreadHere);
    clearRead.disabled = loading || !all.some((entry) => entry.readAt);
    clearAll.disabled = loading || !all.length;
  }

  function paint() {
    const all = items();
    const inCategory = categoryFor(filter);
    const shown = all.filter((entry) => {
      if (inCategory && entry.category !== inCategory) return false;
      if (filter === 'unread' && entry.readAt) return false;
      return true;
    });

    if (!shown.length) {
      replaceChildren(list, blank({
        glyph: 'mail',
        title: filter === 'unread' ? 'Nothing waiting' : 'You are all caught up',
        text: inCategory
          ? 'Nothing in this category is waiting. The other filters still hold the rest.'
          : 'Messages, mentions, replies and requests arrive here by day.',
      }));
    } else {
      const parts = [];
      let last = null;
      for (const entry of shown) {
        const key = dayKey(entry.createdAt || entry.created_at || entry.timestamp);
        if (key !== last) { parts.push(dayRail(key)); last = key; }
        parts.push(activityRow(entry, paint, paint));
      }
      replaceChildren(list, ...parts);
    }
    paintChips();
    replaceChildren(pager,
      State.notifications.hasMore && !loading
        ? el('button', {
          class: 'btn btn--default btn--sm', type: 'button', onClick: () => more(),
        }, 'Load older')
        : null);
  }

  async function loadCategory(category) {
    loading = true;
    paintChips();
    replaceChildren(list, hold(category ? 'Reading this category' : 'Opening your inbox'));
    try {
      await refreshNotifications({ limit: 30, category: category || undefined });
      loading = false;
      paint();
    } catch (error) {
      loading = false;
      replaceChildren(list, fault(error, () => loadCategory(category)));
    }
  }

  async function load() {
    loading = true;
    replaceChildren(list, hold('Opening your inbox'));
    try {
      await refreshNotifications({ limit: 30, category: categoryFor(filter) || undefined });
      loading = false;
      paint();
    } catch (error) {
      loading = false;
      replaceChildren(list, fault(error, load));
    }
  }

  async function more() {
    try {
      loading = true;
      await refreshNotifications({
        limit: 30,
        before: State.notifications.nextCursor,
        category: categoryFor(filter) || undefined,
      });
      loading = false;
      paint();
    } catch (error) {
      loading = false;
      replaceChildren(list, fault(error, paint));
    }
  }

  async function markAllRead() {
    markAll.disabled = true;
    try {
      await Api.readAllNotifications();
      await refreshNotifications({ limit: 30, category: categoryFor(filter) || undefined });
      paint();
    } catch (error) { errorToast(error); paint(); }
  }

  async function clearReadItems() {
    try {
      const out = await Api.clearNotifications({ readOnly: true });
      await refreshNotifications({ limit: 30, category: categoryFor(filter) || undefined });
      paint();
      toast(out && out.remaining ? 'Read notifications cleared.' : 'Inbox cleared.');
    } catch (error) { errorToast(error); }
  }

  async function clearAllItems() {
    const yes = await confirmDialog({
      title: 'Clear every notification?',
      body: 'This removes the whole inbox, read and unread. Messages themselves stay where they are.',
      confirmLabel: 'Clear all',
      danger: true,
    });
    if (!yes) return;
    try {
      await Api.clearNotifications();
      forgetNotifications();
      paint();
    } catch (error) { errorToast(error); }
  }

  // A notification that arrived while the inbox is open is added to the store
  // by the gateway handler; this list redraws from the same store, so it is not
  // left one behind.
  const unloadStore = onStore('notifications', () => { if (!loading) paint(); });

  return {
    node,
    onMount: load,
    cleanup() { unloadStore(); },
  };
}

export default { renderInbox };
