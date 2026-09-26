// Notification center: durable notification inbox (mentions, DMs via
// realtime, friend requests). Rows deep-link to their context; opening
// one marks it read.
import Api from './api.js';
import State, { refreshNotifications } from './state.js';
import { el, clear, toast, relTime } from './ui.js';
import { emptyState, avatar } from './components.js';
import { renderContextHeader, renderAllChrome } from './shell.js';

function describe(n) {
  const who = (n.actor && (n.actor.displayName || n.actor.username)) || 'Someone';
  switch (n.type) {
    case 'mention': return who + ' mentioned you';
    case 'dm': return 'New message from ' + who;
    case 'friend_request': return who + ' sent you a friend request';
    case 'friend_accepted': return who + ' accepted your friend request';
    default: return 'Notification from ' + who;
  }
}

function destination(n) {
  if (n.type === 'mention' && n.context) {
    return '#/server/' + n.context.serverId + '/channel/' + n.context.channelId;
  }
  if (n.type === 'dm' && n.referenceId) return '#/dms/' + n.referenceId;
  if ((n.type === 'friend_request' || n.type === 'friend_accepted') && n.actor) {
    return '#/friends';
  }
  return null;
}

export async function renderNotifications(container) {
  clear(container);
  renderContextHeader({ title: 'Notifications', sub: 'Mentions, messages and requests' });
  const wrap = el('div', { class: 'page atrium' });
  const toolbar = el('div', { class: 'row-line', style: { marginBottom: 'var(--t-d-3)' } });
  const markAll = el('button', { class: 'btn sm', type: 'button' }, 'Mark all read');
  markAll.addEventListener('click', async () => {
    try {
      await Api.readAllNotifications();
      await refreshNotifications();
      renderAllChrome();
      renderNotifications(container);
    } catch (ex) { toast(ex.message || 'Failed', 'error'); }
  });
  toolbar.appendChild(markAll);
  wrap.appendChild(toolbar);
  const list = el('div', { class: 'stack' });
  wrap.appendChild(list);
  container.appendChild(wrap);

  let items = State.raw.notifications || [];
  try {
    const res = await Api.notifications({ limit: 30 });
    items = res.items || [];
  } catch (ex) {
    list.appendChild(el('div', { class: 'form-error' }, ex.message || 'Cannot load notifications'));
    return;
  }
  if (!items.length) {
    list.appendChild(emptyState('♧', 'All caught up', 'Mentions, messages and friend activity land here.'));
    return;
  }
  for (const n of items) {
    const dest = destination(n);
    const row = el(dest ? 'button' : 'div', {
      class: 'row notif-row' + (n.readAt ? '' : ' unread'),
      type: dest ? 'button' : undefined,
    });
    if (n.actor) row.appendChild(avatar({ id: n.actor.id, username: n.actor.username, displayName: n.actor.displayName }, { size: 'sm', withPresence: false }));
    const main = el('div', { class: 'row-main' });
    main.appendChild(el('div', { class: 'row-title' }, describe(n)));
    main.appendChild(el('div', { class: 'row-sub' }, relTime(n.createdAt)));
    row.appendChild(main);
    if (!n.readAt) row.appendChild(el('span', { class: 'unread-dot', title: 'Unread' }));
    if (dest) {
      row.addEventListener('click', async () => {
        try { await Api.readNotification(n.id); } catch { /* non-fatal */ }
        try { await refreshNotifications(); } catch { /* non-fatal */ }
        renderAllChrome();
        location.hash = dest;
      });
    }
    list.appendChild(row);
  }
}

export default { renderNotifications };
