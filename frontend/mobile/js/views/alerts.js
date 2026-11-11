// Alerts: everything the instance wanted the reader to know.
//
// One press answers an alert; a long-press offers the rest. The bar's bell
// carries the unread count; this screen carries the words.

import { el, clear } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import Api from '../../../packages/api.js';
import { State, refreshNotifications } from '../../../packages/store.js';
import { navigate, path } from '../../../packages/nav.js';
import { avatar } from '../../../js/ui/primitives.js';
import { attachLongPress, failed, toast, emptyState, hold, failure } from '../ui.js';
import { timeAgo } from './time.js';

export function renderAlerts(ctx) {
  const host = el('div', { class: 'm-stack' });
  let version = 0;

  async function load() {
    const mine = ++version;
    await refreshNotifications();
    if (mine !== version) return;
    paint();
  }

  function goTo(n) {
    // An alert names its place: a person, a room, a conversation.
    if (n.url) { navigate(path(n.url)); return; }
    if (n.actorId || (n.actor && n.actor.id)) { navigate(path('/users/' + (n.actorId || n.actor.id))); return; }
    if (n.serverId) { navigate(path('/server/' + n.serverId)); return; }
    if (n.conversationId || n.dmId) { navigate(path('/dms/' + (n.conversationId || n.dmId))); }
  }

  function alertRow(n) {
    const actor = n.actor || {};
    const row = el('button', { class: 'm-row' + (n.read ? '' : ' m-row--unread'), type: 'button', onClick: () => open(n) },
      actor.id ? avatar(actor, { size: 'sm' }) : el('div', { class: 'm-empty__icon', style: { width: '36px', height: '36px' } }, icon('bell', { size: 16 })),
      el('div', { class: 'm-row__body' },
        el('div', { class: 'm-row__name' }, n.title || n.body || 'An alert'),
        n.body && n.title ? el('div', { class: 'm-row__note' }, n.body) : null),
      el('div', { class: 'm-row__meta' }, el('span', { class: 'm-row__time' }, timeAgo(n.createdAt || n.created_at))));
    attachLongPress(row, () => [
      { label: 'Mark read', icon: 'check', onClick: () => open(n) },
      { label: 'Forget this one', icon: 'trash', danger: true, onClick: () => drop(n) },
    ]);
    return row;
  }

  async function open(n) {
    try { if (!n.read) await Api.readNotification(n.id); } catch { /* the pip stays */ }
    n.read = true;
    await refreshNotifications().catch(() => {});
    goTo(n);
  }

  async function drop(n) {
    try {
      await Api.deleteNotification(n.id);
      await refreshNotifications();
      paint();
    } catch (e) { failed(e); }
  }

  function paint() {
    clear(host);
    // The store keeps the inbox as a page - the items, the count, the cursor -
    // not as a list of alerts. Reading it as a list found nothing to filter.
    const inbox = State.notifications || {};
    const items = inbox.items || [];
    const unread = inbox.unreadCount !== undefined
      ? inbox.unreadCount
      : items.filter((n) => !n.read).length;

    if (unread > 1) {
      host.appendChild(el('button', {
        class: 'm-go m-go--quiet m-go--block', type: 'button',
        onClick: async () => {
          try { await Api.readAllNotifications(); await refreshNotifications(); paint(); toast('All read', { type: 'success' }); }
          catch (e) { failed(e); }
        },
      }, 'Mark all read'));
    }

    if (!items.length) {
      host.appendChild(emptyState('bell', 'Nothing new', 'Alerts arrive here when the instance has something for you.'));
      return;
    }
    host.appendChild(el('div', { class: 'm-card' }, items.map(alertRow)));
  }

  host.appendChild(hold());
  load().catch((e) => { clear(host); host.appendChild(failure(e, load)); });

  return {
    node: host,
    head: { back: true, title: 'Alerts' },
    door: '',
    onMount: load,
    cleanup() { version += 1; },
  };
}
