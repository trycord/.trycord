import Api from '../api.js';
import State, { refreshNotifications } from '../state.js';
import { attachContextMenu, copyText, el, clear, toast, relTime } from '../ui.js';
import { emptyState, avatar } from '../components.js';
import { loadingState } from '../view-states.js';
import { renderContextHeader, renderAllChrome } from '../shell.js';
import { channelPath } from '../links.js';
import { navigate, route } from '../nav.js';

function describe(n) {
  const who = (n.actor && (n.actor.displayName || n.actor.username)) || 'Someone';
  switch (n.type) {
    case 'mention': return who + ' mentioned you';
    case 'reply': return who + ' replied to your message';
    case 'dm': return 'New message from ' + who;
    case 'friend_request': return who + ' sent you a friend request';
    case 'friend_accepted': return who + ' accepted your friend request';
    default: return 'Notification from ' + who;
  }
}

// Every branch returns a mounted route, because navigate() mounts again anyway
// and route() is idempotent. The mention branch goes through channelPath(), which
// already mounts, so making the other two return bare paths would have left the
// function returning two different shapes.
//
// `route` was used here without being imported, which threw "Can't find
// variable" on every render and took the whole page down - not just the row.
function destination(n) {
  if (!n || !n.type) return null;
  if ((n.type === 'mention' || n.type === 'reply') && n.context) {
    if (n.context.serverId && n.context.channelId) {
      return channelPath(n.context.serverId, n.context.channelId);
    }
    // A reply inside a direct message: the conversation, not a channel.
    if (n.context.conversationId) return route('/dms/' + n.context.conversationId);
  }
  if (n.type === 'dm' && n.referenceId) return route('/dms/' + n.referenceId);
  if ((n.type === 'friend_request' || n.type === 'friend_accepted') && n.actor) {
    return route('/friends');
  }
  // An unknown type, or one whose context did not come with it. A row with no
  // destination still renders - it is still a fact the reader was shown - and
  // must not be able to take the list down with it.
  return null;
}

export async function renderNotifications(container) {
  clear(container);
  renderContextHeader({ title: 'Notifications', sub: 'Replies, mentions, messages and requests' });
  const wrap = el('div', { class: 'page' });
  const toolbar = el('div', { class: 'row-line', style: { marginBottom: 'var(--space-4)' } });
  const markAll = el('button', { class: 'btn sm', type: 'button' }, 'Mark all read');
  markAll.addEventListener('click', async () => {
    try {
      await Api.readAllNotifications();
      await refreshNotifications();
      renderAllChrome();
      renderNotifications(container);
    } catch (ex) { toast(ex.message || 'Failed', 'error'); }
  });
  // Kept out of the tree until there is something unread. 'Mark all read' above an
  // empty list is a control with nothing to act on, which is worse than no control:
  // it says there is something to clear when there is not.
  const list = el('div', { class: 'stack' });
  wrap.appendChild(list);

  // Opening a notification is the point; marking it read rides along. Neither
  // this nor the row click wants a toast when it fails - being told the mark
  // failed, after being taken where they asked to go anyway, is noise. The
  // unread badge is stale until the next refresh, which happens on every
  // realtime notification anyway.
  const settleRead = async (id) => {
    try { await Api.readNotification(id); } catch { /* badge stays until next refresh */ }
    try { await refreshNotifications(); } catch { /* same */ }
  };

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
        await settleRead(n.id);
        renderAllChrome();
        navigate(dest);
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

  const renderRow = (n) => {
    const dest = destination(n);
    const row = el(dest ? 'button' : 'div', {
      class: 'row notif-row' + (n.readAt ? '' : ' unread'),
      type: dest ? 'button' : undefined,
    });
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
        await settleRead(n.id);
        renderAllChrome();
        navigate(dest);
      });
    }
    return row;
  };

  const PAGE = 30;
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

  // Something has to be on screen before the request goes out. Without this the page
  // arrives already finished and empty: a reader landing here saw the whole layout with
  // nothing in it for as long as the request took, which is indistinguishable from "you
  // have no notifications" and quite the opposite.
  const waiting = loadingState('Loading notifications');
  list.appendChild(waiting);

  // Cached rows are real, so they are shown - but they may not be the newest, so they
  // sit under the indicator rather than instead of it. They live in their own container
  // so they can be taken out cleanly once the real answer lands.
  const cached = el('div');
  for (const n of items) cached.appendChild(renderRow(n));
  list.appendChild(cached);

  try {
    const res = await Api.notifications({ limit: PAGE });
    items = res.items || [];
    cursor = res.nextCursor || null;
    hasMore = !!res.hasMore;
  } catch (ex) {
    waiting.remove();
    if (items.length) {
      // The cached rows are the whole page now, so say what happened above them instead
      // of replacing them with an error the reader did not need.
      list.appendChild(el('div', { class: 'form-error' },
        (ex.message || 'Cannot load the newest notifications') + ' - showing the last loaded.'));
      loadMoreBtn.hidden = true;
      return;
    }
    list.removeChild(cached);
    list.appendChild(el('div', { class: 'form-error' }, ex.message || 'Cannot load notifications'));
    loadMoreBtn.hidden = true;
    return;
  }
  waiting.remove();
  cached.remove();
  if (!items.length) {
    list.appendChild(emptyState('bell', 'All caught up', 'Mentions, messages and friend activity land here.'));
    loadMoreBtn.hidden = true;
    return;
  }
  // Only now, with rows to act on.
  if (items.some((n) => n && !n.readAt)) {
    toolbar.insertBefore(markAll, toolbar.firstChild);
    wrap.insertBefore(toolbar, list);
  }
  for (const n of items) {
    list.appendChild(renderRow(n));
  }
  nextCursor = cursor;
  loadMoreBtn.hidden = !hasMore || !nextCursor;
}

export default { renderNotifications };
