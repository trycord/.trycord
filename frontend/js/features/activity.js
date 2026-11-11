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
import { noteNotificationRead, removeNotificationLocal } from '../../packages/store.js';
import { copyText } from '../ui/clipboard.js';
import Api from '../../packages/api.js';

const PHRASE = {
  dm: 'sent you a message',
  friend_request: 'wants to be friends',
  friend_accepted: 'accepted your request',
  mention: 'mentioned you',
  reply: 'replied to you',
  card_assigned: 'assigned you a card',
  event_reminder: 'is starting soon',
  group_invite: 'invited you to a group',
  group_member_added: 'added you to a group',
  group_member_removed: 'removed you from a group',
  group_role_changed: 'changed your role in a group',
  group_ownership_transferred: 'made you the owner of a group',
  community_invite: 'invited you to a community',
  community_event: 'shared an event with you',
  moderation_action: 'took a moderation action on your account',
  moderation_warning: 'sent you a warning',
  moderation_lift: 'lifted a moderation action',
  report_update: 'updated your report',
  appeal_update: 'updated your appeal',
  community_moderation: 'made a moderation decision in your community',
};

const GLYPH = {
  dm: 'message',
  friend_request: 'user-plus',
  friend_accepted: 'users',
  mention: 'at',
  reply: 'reply',
  card_assigned: 'layers',
  event_reminder: 'calendar',
  group_invite: 'users',
  group_member_added: 'users',
  group_member_removed: 'user-minus',
  group_role_changed: 'shield',
  group_ownership_transferred: 'crown',
  community_invite: 'globe',
  community_event: 'calendar',
  moderation_action: 'shield-alert',
  moderation_warning: 'alert',
  moderation_lift: 'shield-check',
  report_update: 'flag',
  appeal_update: 'mail-open',
  community_moderation: 'flag',
};

export function phraseFor(entry) {
  const actor = entry && entry.actor;
  if (!actor && entry && entry.type === 'event_reminder') {
    return 'An event you are attending starts soon';
  }
  const who = actor ? (actor.displayName || actor.username) : 'Trycord';
  return who + ' ' + (PHRASE[entry.type] || 'left you activity');
}

export function destination(entry) {
  const ctx = entry && entry.context;
  if (entry.type === 'dm' && entry.referenceId) return '/dms/' + entry.referenceId;
  if ((entry.type === 'mention' || entry.type === 'reply') && ctx) {
    if (ctx.conversationId) return '/dms/' + ctx.conversationId;
    if (ctx.serverId && ctx.channelId) return '/server/' + ctx.serverId + '/channel/' + ctx.channelId;
  }
  // An invitation names the invitation, not the conversation; accepting it
  // happens in the tray on the list page. Membership and role events name the
  // conversation itself.
  if (entry.type === 'group_invite') return '/dms';
  if (entry.type && entry.type.indexOf('group_') === 0 && entry.referenceId) {
    return '/dms/' + entry.referenceId;
  }
  if (entry.type === 'community_invite' && entry.referenceId) {
    return '/invite/' + entry.referenceId;
  }
  if (entry.type === 'friend_request') return '/friends';
  if (entry.type === 'card_assigned' && ctx && ctx.serverId && ctx.boardId) {
    return '/server/' + ctx.serverId + '/workspace/board/' + ctx.boardId + '/card/' + ctx.cardId;
  }
  if (entry.type === 'event_reminder' && ctx && ctx.serverId && ctx.eventId) {
    return '/server/' + ctx.serverId + '/workspace/event/' + ctx.eventId;
  }
  // Moderation rows are decisions, not a room. Opening one marks it read; the
  // decision itself lives in the account's mail and the community's records,
  // and guessing a route from an id would be worse than no link.
  if (entry.type && entry.type.indexOf('moderation') === 0) return null;
  if (entry.type === 'report_update' || entry.type === 'appeal_update' ||
      entry.type === 'community_moderation') return null;
  if (entry.actor) return '/users/' + entry.actor.id;
  return null;
}

// Opening is both gestures at once: the entry is marked read and followed.
// onOpened runs after the local state moved, so a list can repaint itself.
export function openActivity(entry, onOpened) {
  if (!entry.readAt) {
    noteNotificationRead(entry.id);
    Api.readNotification(entry.id).catch(() => { /* the next load corrects it */ });
    if (onOpened) onOpened();
  }
  const to = destination(entry);
  if (to) navigate(to);
}

// Dismissal removes the row, not a copy of it in this browser: the next read
// starts from the server's answer.
export async function dismissActivity(entry, onDismissed) {
  await Api.deleteNotification(entry.id);
  removeNotificationLocal(entry.id);
  if (onDismissed) onDismissed();
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
        noteNotificationRead(entry.id);
        Api.readNotification(entry.id).catch(() => { /* the next load corrects it */ });
        if (onChanged) onChanged();
      },
    });
  }
  items.push({ separator: true });
  items.push({
    label: 'Dismiss', icon: 'x', danger: true,
    onSelect: () => {
      dismissActivity(entry, onChanged).catch(() => { /* the row stays if the server refused */ });
    },
  });
  return items;
}

export function activityRow(entry, onOpened, onDismissed) {
  const actor = entry.actor || null;
  // The line is a div rather than the row kit's usual button, because it holds
  // the dismiss control as a real sibling button. Keyboard and pointer both
  // open the entry, and the context menu stays attached to the line itself.
  const line = row({
    unread: !entry.readAt,
    link: true,
    class: 'cardrow--feed',
    lead: actor
      ? avatar({
        id: actor.id,
        username: actor.username,
        displayName: actor.displayName,
        avatarUrl: actor.avatarUrl,
      }, { size: 'md' })
      : el('span', { class: 'blank-glyph' }, icon(GLYPH[entry.type] || 'bell', { size: 18 })),
    title: phraseFor(entry),
    sub: stamp(entry.createdAt),
    side: entry.readAt ? null : el('span', { class: 'unread-dot', 'aria-label': 'Unread' }),
    menu: () => activityMenuItems(entry, onOpened),
  });
  line.setAttribute('role', 'button');
  line.tabIndex = 0;
  line.addEventListener('click', () => openActivity(entry, onOpened));
  line.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    openActivity(entry, onOpened);
  });
  line.appendChild(el('button', {
    class: 'iconbtn feed-dismiss', type: 'button',
    'aria-label': 'Dismiss this notification',
    title: 'Dismiss',
    onClick: (event) => {
      event.preventDefault();
      event.stopPropagation();
      dismissActivity(entry, onDismissed).catch(() => { /* keep it if refused */ });
    },
  }, icon('x', { size: 14 })));
  return line;
}

export default { phraseFor, destination, openActivity, activityRow, activityMenuItems };
