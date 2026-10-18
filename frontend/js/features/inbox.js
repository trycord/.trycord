// The Inbox, remade.
//
// Everything addressed to the reader, newest first, told as a calendar stream:
// day rails between what arrived today, yesterday and before. The filter narrows
// to what is unread; the footer keeps older entries one step away. This is the
// full list behind the Pulse card on Home - same rows, same voice.

import { el } from '../../packages/dom.js';
import { State, refreshNotifications } from '../../packages/store.js';
import Api from '../../packages/api.js';
import { head, hold, fault, blank, fold } from '../ui/page.js';
import { activityRow } from './activity.js';

const FILTERS = [
  ['all', 'All'],
  ['unread', 'Unread'],
];

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

  const chips = el('div', { class: 'chips', role: 'group', 'aria-label': 'Filter' },
    ...FILTERS.map(([value, label]) => {
      const chip = el('button', { class: 'chip' + (value === 'unread' ? ' chip--quiet' : ''), type: 'button' }, label);
      chip.dataset.value = value;
      chip.addEventListener('click', () => { filter = value; paint(); });
      return chip;
    }));

  const markAll = el('button', { class: 'btn btn--default btn--sm', type: 'button', onClick: () => markAllRead() }, 'Mark all read');

  const node = fold([
    head({
      kicker: 'Inbox',
      title: 'Notifications',
      lede: 'Everything addressed to you, by day. Opening an entry marks it read and follows it.',
      actions: [chips, markAll],
    }),
    list,
    pager,
  ]);

  function paintChips() {
    const all = items();
    const unread = all.filter((entry) => !entry.readAt).length;
    for (const chip of chips.children) {
      const value = chip.dataset.value;
      let label = FILTERS.find((entry) => entry[0] === value)[1];
      if (value === 'unread' && unread) label += ' (' + unread + ')';
      chip.textContent = label;
      chip.classList.toggle('chip--on', value === filter);
    }
    markAll.disabled = !unread;
  }

  function items() {
    return (State.notifications && State.notifications.items) || [];
  }

  function paint() {
    const all = items();
    const shown = filter === 'unread' ? all.filter((entry) => !entry.readAt) : all;

    if (!shown.length) {
      list.replaceChildren(blank({
        glyph: 'mail',
        title: filter === 'unread' ? 'Nothing waiting' : 'You are all caught up',
        text: 'Messages, mentions, replies and requests arrive here by day.',
      }));
    } else {
      const parts = [];
      let last = null;
      for (const entry of shown) {
        const key = dayKey(entry.createdAt || entry.created_at || entry.timestamp);
        if (key !== last) { parts.push(dayRail(key)); last = key; }
        parts.push(activityRow(entry, paint));
      }
      list.replaceChildren(...parts);
    }
    paintChips();
    pager.replaceChildren(
      State.notifications.hasMore
        ? el('button', { class: 'btn btn--default btn--sm', type: 'button', onClick: () => more() }, 'Load older')
        : null);
  }

  async function load() {
    list.replaceChildren(hold('Opening your inbox'));
    try {
      await refreshNotifications({ limit: 30 });
      paint();
    } catch (error) {
      list.replaceChildren(fault(error, load));
    }
  }

  async function more() {
    try {
      await refreshNotifications({ limit: 30, before: State.notifications.nextCursor });
      paint();
    } catch (error) {
      list.replaceChildren(fault(error, paint));
    }
  }

  async function markAllRead() {
    markAll.disabled = true;
    try {
      await Api.readAllNotifications();
      await refreshNotifications({ limit: 30 });
      paint();
    } catch (error) {
      list.replaceChildren(fault(error, paint));
    }
  }

  return { node, onMount: load };
}

export default { renderInbox };
