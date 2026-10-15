// Notifications.
//
// Everything addressed to the reader, newest first. Opening one marks it read and
// then follows it, because a notification is a pointer and opening it is the same
// gesture as going there.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import { avatar } from '../components.js';
import { State, refreshNotifications } from '../../packages/store.js';
import { navigate } from '../../packages/nav.js';
import { relativeTime } from '../../packages/format.js';
import Api from '../../packages/api.js';
import { page, band, panel, prow, loading, failure, empty } from './util.js';

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
  const host = el('div', { class: 'stack' });
  const markAllButton = el('button', {
    class: 'btn btn--default btn--sm', type: 'button', onClick: markAll,
  }, 'Mark all read');

  const node = page(
    band({
      eyebrow: 'Inbox',
      icon: 'bell',
      title: 'Notifications',
      lede: 'Anything addressed to you, newest first. Opening one marks it read.',
      actions: markAllButton,
    }),
    host,
  );

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
    const unread = items.filter((entry) => !entry.readAt).length;
    markAllButton.disabled = unread === 0;
    host.replaceChildren();

    if (!items.length) {
      host.appendChild(empty({
        icon: 'bell',
        title: 'You are all caught up',
        text: 'Mentions, replies, friend requests and direct messages land here.',
      }));
      return;
    }

    host.appendChild(panel({
      title: 'Recent',
      note: unread ? unread + ' unread' : 'All read',
      rows: items.map(rowFor),
    }));

    if (State.notifications.hasMore) {
      host.appendChild(el('div', { class: 'pager' },
        el('button', { class: 'btn btn--default btn--sm', type: 'button', onClick: more }, 'Load older')));
    }
  }

  function rowFor(entry) {
    const actor = entry.actor || null;
    const who = actor ? (actor.displayName || actor.username) : 'Trycord';
    return prow({
      class: entry.readAt ? null : 'is-unread',
      lead: actor
        ? avatar({ id: actor.id, username: actor.username, displayName: actor.displayName }, { size: 'md' })
        : el('span', { class: 'view-empty-icon' }, icon(GLYPH[entry.type] || 'bell', { size: 18 })),
      title: who + ' ' + (PHRASE[entry.type] || 'sent you something'),
      sub: relativeTime(entry.createdAt),
      actions: entry.readAt ? null : el('span', { class: 'nav-dot', 'aria-label': 'Unread' }),
      onClick: () => follow(entry),
    });
  }

  async function follow(entry) {
    if (!entry.readAt) {
      entry.readAt = new Date().toISOString();
      State.notifications.unreadCount = Math.max(0, (State.notifications.unreadCount || 1) - 1);
      Api.readNotification(entry.id).catch(() => { /* the next load will correct it */ });
      paint();
    }
    const to = destination(entry);
    if (to) navigate(to);
  }

  function destination(entry) {
    if (entry.type === 'dm' && entry.referenceId) return '/dms/' + entry.referenceId;
    if ((entry.type === 'mention' || entry.type === 'reply') && entry.context) {
      const ctx = entry.context;
      if (ctx.conversationId) return '/dms/' + ctx.conversationId;
      if (ctx.serverId && ctx.channelId) {
        return '/server/' + ctx.serverId + '/channel/' + ctx.channelId;
      }
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
    }
  }

  return { node, onMount: load };
}

export default { renderNotifications };
