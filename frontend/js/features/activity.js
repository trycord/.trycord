// The activity vocabulary.
//
// Everything the platform pushes at the reader - messages, requests, mentions,
// replies - is one notification row in one voice, wherever it appears. The
// Home pulse shows the recent few; the Inbox shows the full stream. Both use
// this module, so neither can describe the same event differently.

import { el } from '../../packages/dom.js';
import { icon } from '../../packages/icons.js';
import { avatar } from '../ui/primitives.js';
import { row, stamp } from '../ui/page.js';
import { navigate, path } from '../../packages/nav.js';
import { State } from '../../packages/store.js';
import { copyText } from '../ui/clipboard.js';
import Api from '../../packages/api.js';

const PHRASE = {
  dm: 'sent you a message',
  friend_request: 'wants to be friends',
  friend_accepted: 'accepted your request',
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

export function phraseFor(entry) {
  const actor = entry && entry.actor;
  const who = actor ? (actor.displayName || actor.username) : 'Trycord';
  return who + ' ' + (PHRASE[entry.type] || 'left you activity');
}

export function destination(entry) {
  if (entry.type === 'dm' && entry.referenceId) return '/dms/' + entry.referenceId;
  if ((entry.type === 'mention' || entry.type === 'reply') && entry.context) {
    const ctx = entry.context;
    if (ctx.conversationId) return '/dms/' + ctx.conversationId;
    if (ctx.serverId && ctx.channelId) return '/server/' + ctx.serverId + '/channel/' + ctx.channelId;
  }
  if (entry.actor) return '/users/' + entry.actor.id;
  return null;
}

// Opening is both gestures at once: the entry is marked read and followed.
// onOpened runs after the local state moved, so a list can repaint itself.
export function openActivity(entry, onOpened) {
  if (!entry.readAt) {
    entry.readAt = new Date().toISOString();
    State.notifications.unreadCount = Math.max(0, (State.notifications.unreadCount || 1) - 1);
    Api.readNotification(entry.id).catch(() => { /* the next load corrects it */ });
    if (onOpened) onOpened();
  }
  const to = destination(entry);
  if (to) navigate(to);
}

// The menu an entry offers. It can be opened, its address copied, and it can
// be marked read without being followed.
export function activityMenuItems(entry, onChanged) {
  const items = [];
  const to = destination(entry);
  if (to) {
    items.push({
      label: 'Open', icon: 'external',
      onSelect: () => openActivity(entry, onChanged),
    });
    items.push({
      label: 'Copy the link', icon: 'link',
      onSelect: () => copyText(window.location.origin + path(to), 'Link copied.'),
    });
  }
  if (!entry.readAt) {
    items.push({ separator: true });
    items.push({
      label: 'Mark as read', icon: 'check',
      onSelect: () => {
        entry.readAt = new Date().toISOString();
        State.notifications.unreadCount = Math.max(0, (State.notifications.unreadCount || 1) - 1);
        Api.readNotification(entry.id).catch(() => { /* the next load corrects it */ });
        if (onChanged) onChanged();
      },
    });
  }
  return items;
}

export function activityRow(entry, onOpened) {
  const actor = entry.actor || null;
  return row({
    unread: !entry.readAt,
    link: true,
    lead: actor
      ? avatar({ id: actor.id, username: actor.username, displayName: actor.displayName }, { size: 'md' })
      : el('span', { class: 'blank-glyph' }, icon(GLYPH[entry.type] || 'bell', { size: 18 })),
    title: phraseFor(entry),
    sub: stamp(entry.createdAt),
    side: entry.readAt ? null : el('span', { class: 'unread-dot', 'aria-label': 'Unread' }),
    onClick: () => openActivity(entry, onOpened),
    menu: () => activityMenuItems(entry, onOpened),
  });
}

export default { phraseFor, destination, openActivity, activityRow, activityMenuItems };
