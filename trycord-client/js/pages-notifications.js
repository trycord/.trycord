// Notification center: durable notification inbox (mentions, DMs via
// realtime, friend requests). Rows deep-link to their context; opening
// one marks it read.
import Api from './api.js';
import State, { refreshNotifications } from './state.js';
import { attachContextMenu, copyText, el, clear, toast, relTime } from './ui.js';
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

  // The action list for one notification. Entries reflect current state
  // rather than being rendered once and left stale: a notification that is
  // already read offers no "mark as read".
  const notifActions = (n, dest) => {
    const items = [];
    const markRead = async () => {
      try {
        await Api.readNotification(n.id);
        await refreshNotifications();
        renderAllChrome();
        renderNotifications(container);
        toast('Marked as read.', 'ok');
      } catch (ex) { toast(ex.message || 'Could not mark as read.', 'error'); }
    };

    if (dest) {
      items.push({ label: 'Go to', desc: 'Open where this happened', onSelect: async () => {
        try { await Api.readNotification(n.id); } catch { /* non-fatal */ }
        try { await refreshNotifications(); } catch { /* non-fatal */ }
        renderAllChrome();
        location.hash = dest;
      } });
    }
    if (!n.readAt) {
      items.push({ label: 'Mark as read', onSelect: markRead });
    }
    items.push({ sep: true });
    items.push({ label: 'Mark all as read', onSelect: async () => {
      try { await Api.readAllNotifications(); await refreshNotifications(); renderAllChrome(); renderNotifications(container); }
      catch (ex) { toast(ex.message || 'Failed', 'error'); }
    } });
    items.push({ label: 'Copy notification ID', onSelect: () => copyText(String(n.id), 'Notification ID copied.') });
    return items;
  };

  // Row rendering, shared by the first page and every "load more" after it.
  const renderRow = (n) => {
    const dest = destination(n);
    const row = el(dest ? 'button' : 'div', {
      class: 'row notif-row' + (n.readAt ? '' : ' unread'),
      type: dest ? 'button' : undefined,
    });
    // Right click / long press for the actions, click to open. The row is the
    // target so the menu knows which notification it belongs to, and the
    // builder is re-read on open, so an entry that is no longer valid (it was
    // just marked read) is simply not offered.
    attachContextMenu(row, () => notifActions(n, dest), {
      target: () => ({ type: 'notification', id: String(n.id) }),
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
    return row;
  };

  const PAGE = 30;
  // Cursor for the next older page, owned by the server. Null means the list
  // is exhausted, which is why the control is removed rather than disabled -
  // a permanently greyed-out button reads as a broken feature.
  let nextCursor = null;
  let loadingMore = false;

  const loadMoreBtn = el('button', { class: 'btn block notif-load-more', type: 'button', hidden: true }, 'Load older');
  loadMoreBtn.addEventListener('click', async () => {
    if (loadingMore || !nextCursor) return;
    loadingMore = true;
    loadMoreBtn.disabled = true;
    loadMoreBtn.textContent = 'Loading…';
    try {
      const res = await Api.notifications({ limit: PAGE, before: nextCursor });
      const older = res.items || [];
      for (const n of older) list.appendChild(renderRow(n));
      nextCursor = res.nextCursor || null;
      if (!nextCursor || !older.length) {
        loadMoreBtn.hidden = true;
      } else {
        loadMoreBtn.disabled = false;
        loadMoreBtn.textContent = 'Load older';
      }
    } catch (ex) {
      loadMoreBtn.disabled = false;
      loadMoreBtn.textContent = 'Try again';
      toast(ex.message || 'Could not load older notifications', 'error');
    } finally {
      loadingMore = false;
    }
  });
  list.appendChild(loadMoreBtn);

  container.appendChild(wrap);

  let items = State.raw.notifications || [];
  let cursor = null;
  let hasMore = false;
  try {
    const res = await Api.notifications({ limit: PAGE });
    items = res.items || [];
    cursor = res.nextCursor || null;
    hasMore = !!res.hasMore;
  } catch (ex) {
    list.appendChild(el('div', { class: 'form-error' }, ex.message || 'Cannot load notifications'));
    loadMoreBtn.hidden = true;
    return;
  }
  if (!items.length) {
    list.appendChild(emptyState('♧', 'All caught up', 'Mentions, messages and friend activity land here.'));
    loadMoreBtn.hidden = true;
    return;
  }
  for (const n of items) {
    list.appendChild(renderRow(n));
  }
  nextCursor = cursor;
  loadMoreBtn.hidden = !hasMore || !nextCursor;
}

export default { renderNotifications };
