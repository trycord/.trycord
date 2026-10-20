// Notifications, on a phone.
//
// Everything addressed to the reader, newest first. Opening one marks it read and
// then follows it, because a notification is a pointer and opening it is the same
// gesture as going there.

import { el } from '../../../packages/dom.js';
import { icon } from '../../../packages/icons.js';
import { avatar, empty, loading, failure } from '../components.js';
import { State, refreshNotifications } from '../../../packages/store.js';
import { navigate, path } from '../../../packages/nav.js';
import { relativeTime } from '../../../packages/format.js';
import Api from '../../../packages/api.js';
import { screen, section } from './util.js';
import { attachLongPress } from '../ui.js';
import { copyText } from '../clipboard.js';

const PHRASE = {
  dm: 'sent you a direct message',
  friend_request: 'sent you a friend request',
  friend_accepted: 'accepted your friend request',
  mention: 'mentioned you',
  reply: 'replied to you',
};

const GLYPH = {
  dm: 'message',
  friend_request: 'user-plus',
  friend_accepted: 'users',
  mention: 'at',
  reply: 'reply',
};

export function renderNotifications() {
  const host = el('div', { class: 'm-stack' });
  const markAllButton = el('button', {
    class: 'm-btn m-btn--sm m-btn--ghost', type: 'button', onClick: () => markAll(),
  }, 'Mark read');

  const node = screen(host);

  async function load() {
    host.replaceChildren(loading('Fetching your notifications'));
    try {
      await refreshNotifications({ limit: 30 });
      paint();
    } catch (error) {
      host.replaceChildren(failure(error, load));
    }
  }

  function paint() {
    const items = State.notifications.items || [];
    const unread = State.notifications.unreadCount || 0;
    markAllButton.hidden = unread === 0;
    host.replaceChildren();
    if (!items.length) {
      host.appendChild(empty({ icon: 'bell', title: 'Nothing yet', text: 'Mentions, replies, friend requests and messages show up here.' }));
      return;
    }
    const list = el('div', { class: 'm-list' });
    for (const entry of items) list.appendChild(rowFor(entry));
    host.appendChild(section('Notifications', list, { note: unread ? unread + ' unread' : null }));
    if (State.notifications.hasMore) {
      host.appendChild(el('div', { class: 'm-actions' },
        el('button', { class: 'm-btn m-btn--block m-btn--ghost', type: 'button', onClick: more }, 'Load older')));
    }
  }

  function rowFor(entry) {
    const actor = entry.actor || null;
    const who = actor ? (actor.displayName || actor.username) : 'Trycord';
    const node = el('button', {
      class: 'm-row' + (entry.readAt ? '' : ' is-unread'),
      type: 'button',
      onClick: () => follow(entry),
    },
      el('span', { class: 'm-row__lead' }, actor
        ? avatar({ id: actor.id, username: actor.username, displayName: actor.displayName }, { size: 'md', decorative: true })
        : el('span', { class: 'm-mark m-mark--sm' }, icon(GLYPH[entry.type] || 'bell', { size: 18 }))),
      el('span', { class: 'm-row__body' },
        el('span', { class: 'm-row__title' }, who + ' ' + (PHRASE[entry.type] || 'sent you something')),
        el('span', { class: 'm-row__sub truncate' }, entry.createdAt ? relativeTime(entry.createdAt) : '')),
      entry.readAt ? null : el('span', { class: 'm-row__dot', 'aria-label': 'Unread' }));
    // A long press on an entry raises the actions that belong to it.
    attachLongPress(node, () => entryActions(entry), { title: who });
    return node;
  }

  // What an entry can be asked for: opened, its address copied, and marked
  // read without being followed.
  function entryActions(entry) {
    const items = [];
    const to = destination(entry);
    if (to) {
      items.push({ label: 'Open', icon: 'external', onSelect: () => follow(entry) });
      items.push({
        label: 'Copy the link', icon: 'link',
        onSelect: () => copyText(window.location.origin + path(to), 'Link'),
      });
    }
    if (!entry.readAt) {
      items.push({ separator: true });
      items.push({ label: 'Mark as read', icon: 'check', onSelect: () => markRead(entry) });
    }
    return items;
  }

  function markRead(entry) {
    if (entry.readAt) return;
    entry.readAt = new Date().toISOString();
    State.notifications.unreadCount = Math.max(0, (State.notifications.unreadCount || 1) - 1);
    Api.readNotification(entry.id).catch(() => { /* the next load corrects it */ });
    paint();
  }

  async function follow(entry) {
    if (!entry.readAt) {
      entry.readAt = new Date().toISOString();
      State.notifications.unreadCount = Math.max(0, (State.notifications.unreadCount || 1) - 1);
      Api.readNotification(entry.id).catch(() => { /* the next load corrects it */ });
      paint();
    }
    const to = destination(entry);
    if (to) navigate(to);
  }

  function destination(entry) {
    if (entry.type === 'dm' && entry.referenceId) return '/dms/' + entry.referenceId;
    if ((entry.type === 'mention' || entry.type === 'reply') && entry.context) {
      const c = entry.context;
      if (c.conversationId) return '/dms/' + c.conversationId;
      if (c.serverId && c.channelId) return '/server/' + c.serverId + '/channel/' + c.channelId;
    }
    if (entry.actor) return '/users/' + entry.actor.id;
    return null;
  }

  async function more() {
    try {
      await refreshNotifications({ limit: 30, before: State.notifications.nextCursor });
      paint();
    } catch (error) {
      host.replaceChildren(failure(error, paint));
    }
  }

  async function markAll() {
    markAllButton.disabled = true;
    try {
      await Api.readAllNotifications();
      await refreshNotifications({ limit: 30 });
      paint();
    } catch (error) {
      host.replaceChildren(failure(error, paint));
    } finally {
      markAllButton.disabled = false;
    }
  }

  return { node, head: { title: 'Notifications', actions: [markAllButton] }, onMount: load };
}

export default { renderNotifications };
