import { dmRowActions } from './menus.js';
import { repaintChrome } from './repaint.js';
import { el, clear, qs, toast, relTime, confirmDialog, openModal, openReportDialog, attachMenu, attachContextMenu, showUserCard, copyText, announce } from '../ui.js';
import { avatar, icon, navRow, serverChip, navGroup } from '../components.js';
import State, { isAuthed, currentServerId, can, peerPresence, refreshServers, leaveServerContext, clearSession, refreshDms, refreshFriends, refreshNotifications, mustVerifyToPost, refreshServerView } from '../state.js';
import { channelPath, serverPath } from '../links.js';
import { navigate, route } from '../nav.js';
import { compose } from './compose.js';
import { matchRoute, railPages, mobilePages } from '../pages/registry.js';
import { renderCommunityContext } from '../community-nav.js';


// Throttle for the home sidebar: it refreshes the community list on a timer, and a
// route change mid-interval should not start a second one.

let homeRefreshAt = 0;
let homeRefreshOn = false;
// The place column: whatever list belongs beside the current route.

export function refreshHomeSidebar(region) {
  const now = Date.now();
  if (homeRefreshOn || now - homeRefreshAt < 30000) return;
  homeRefreshOn = true;
  homeRefreshAt = now;
  Promise.allSettled([refreshDms(), refreshFriends(), refreshNotifications()]).finally(() => {
    homeRefreshOn = false;
    if (region.isConnected) {
      try { renderPlaceNavigation(region); } catch { /* stale view */ }
      try { repaintChrome(); } catch { /* ignore */ }
    }
  });
}

export function pageHeader(title, sub) {
  const head = el('header', { class: 'ctx-head' });
  const bar = el('div', { class: 'ctx-head__bar' });
  const text = el('div', { class: 'ctx-head__text' });
  text.appendChild(el('div', { class: 'ctx-head__title' }, title));
  if (sub) text.appendChild(el('div', { class: 'ctx-head__sub' }, sub));
  bar.appendChild(text);
  head.appendChild(bar);
  return head;
}



export function communityContext(region, sid) {
  renderCommunityContext(region, sid, compose().route);
}


export function dmsContext(region) {
  const here = compose().route;
  // 'Conversations', not 'Direct messages': the page header directly to the right
  // already says Direct messages, and a second title a different width away with a
  // different subtitle under it reads as two things disagreeing about what this is.
  region.appendChild(pageHeader('Conversations'));

  const scroll = el('div', { class: 'ctx-scroll' });
  region.appendChild(scroll);

  const search = el('input', {
    class: 'input ctx-search', type: 'search',
    placeholder: 'Find a conversation', 'aria-label': 'Filter conversations',
  });
  const listBox = el('div', { class: 'ctx-list' });

  const paint = (q) => {
    clear(listBox);
    const query = String(q || '').trim().toLowerCase();
    const dms = State.dms || [];
    const shown = query
      ? dms.filter((d) => String((d.peer && (d.peer.displayName || d.peer.username)) || '').toLowerCase().includes(query))
      : dms;
    if (!shown.length) {
      // A list says whether it is empty. The pane beside it says what to do about
      // it, in full sentences, with the reason. Both were doing both jobs, so the
      // same advice appeared twice on one screen - once here in a 216px column
      // where it did not fit, and once beside it where it did.
      listBox.appendChild(el('div', { class: 'ctx-empty' },
        dms.length ? 'No conversations match.' : 'Nothing here yet'));
      return;
    }
    for (const dm of shown) {
      const peer = dm.peer || {};
      const name = peer.displayName || peer.username || 'Unknown';
      const active = here === '/dms/' + dm.id;
      const row = el('button', {
        class: 'row row--dm' + (active ? ' active' : '') + (dm.unreadCount ? ' is-unread' : ''),
        type: 'button', title: name,
        onClick: () => { navigate('/dms/' + dm.id); },
      });
      row.appendChild(avatar(peer, { size: 'sm', withPresence: true }));
      const main = el('div', { class: 'row__stack' });
      const top = el('div', { class: 'row__line' });
      top.appendChild(el('span', { class: 'row__title' }, name));
      if (dm.lastMessage) top.appendChild(el('span', { class: 'row__time' }, relTime(dm.lastMessage.createdAt)));
      main.appendChild(top);
      main.appendChild(el('div', { class: 'row__sub' },
        dm.lastMessage ? String(dm.lastMessage.content || '').slice(0, 80) : 'Say hello'));
      row.appendChild(main);
      if (dm.unreadCount) {
        row.appendChild(el('span', { class: 'row__count' },
          String(dm.unreadCount > 99 ? '99+' : dm.unreadCount)));
      }
      // A conversation row was the one interactive row in the sidebar with no
      // menu. Server chips and member rows beside it both had one, so right
      // -clicking a conversation did nothing while right-clicking the entry
      // above it worked.
      attachContextMenu(row, () => dmRowActions(dm, peer, name), {
        target: () => ({ type: 'conversation', id: String(dm.id) }),
      });
      listBox.appendChild(row);
    }
  };

  const actions = el('div', { class: 'ctx-actions' });
  actions.appendChild(el('button', {
    class: 'btn primary block', type: 'button',
    onClick: () => { navigate('/friends'); },
  }, 'New message'));
  scroll.appendChild(actions);
  scroll.appendChild(search);
  scroll.appendChild(listBox);
  search.addEventListener('input', () => paint(search.value));
  paint('');

  refreshHomeSidebar(region);
}



export function simpleListContext(region, { title, sub, groups }) {
  const here = compose().route;
  region.appendChild(pageHeader(title, sub));
  const scroll = el('div', { class: 'ctx-scroll' });
  region.appendChild(scroll);
  for (const g of groups) {
    if (!g || !g.items.length) continue;
    const group = navGroup({ label: g.label });
    for (const item of g.items) {
      // A row with no destination is still information - it is a fact the reader was
      // shown - but it must not become a link that throws when the route is compared.
      const dest = item.route || '';
      const active = !!dest && (item.exact ? here === dest : (here === dest || here.startsWith(dest + '/')));
      group.list.appendChild(navRow({
        label: item.label, href: route(item.route), active,
        onClick: () => { navigate(item.route); },
      }));
    }
    scroll.appendChild(group);
  }
}

// Home is a feed across every place, so its sidebar lists the places rather
// than one of them. It used to fall through to the direct-messages context,
// which put "No conversations yet" directly beside a full activity feed - the
// sidebar was describing a different page than the one it sat next to.
// Home's sidebar lists the reader's communities, not the five destinations the
// rail already shows directly above it. It repeated Home, Direct messages, Friends
// and Notifications here as well, so on the Home screen every one of them appeared
// twice with two different active states competing for the same row.
//
// What belongs here is the thing the rail cannot say: which communities this
// person is in, and where the unread is.
  // Home's sidebar used to list your communities, which the rail now does as well,
  // so the same community appeared twice on one screen - once as a place to go and
  // once as a duplicate of the place beside it. The rail is the navigation; this
  // panel is for what the rail has no room for: finding somewhere else to be, and
  // what is waiting for you.
  function homeContext(region) {
    const servers = State.servers || [];
    const attention = [
      ...(State.notifications || [])
        .filter((n) => n && (n.type === 'mention' || n.type === 'reply'))
        .slice(0, 5)
        .map((n) => {
          const who = (n.actor && (n.actor.displayName || n.actor.username)) || 'Someone';
          const what = n.type === 'mention' ? 'mentioned you' : 'replied to you';
          const where = n.context && n.context.channelName ? ' in #' + n.context.channelName : '';
          // A mention or a reply has somewhere to go: the channel it happened in, or
          // the conversation when it was a direct message. A row that cannot be
          // opened is not a navigation item, and passing a null path into the list
          // helper below used to throw on the startsWith.
          let path = null;
          if (n.context && n.context.serverId && n.context.channelId) {
            path = channelPath(n.context.serverId, n.context.channelId);
          } else if (n.context && n.context.conversationId) {
            path = '/dms/' + n.context.conversationId;
          } else if (n.type === 'reply' || n.type === 'mention') {
            path = '/notifications';
          }
          return { label: who + ' ' + what + where, path };
        }),
      ...(State.dms || [])
        .filter((d) => (d.unreadCount || 0) > 0)
        .slice(0, 5)
        .map((d) => ({
          label: (d.peer && (d.peer.displayName || d.peer.username)) || 'Someone',
          path: '/dms/' + d.id,
          count: d.unreadCount,
        })),
    ];
    const requests = (State.friendsIn || []).length;

    const groups = [{ label: 'Find', items: [
      { label: 'Discover communities', path: '/discover' },
      { label: 'Create a community', path: '/servers/new' },
    ] }];
    if (attention.length) groups.unshift({ label: 'Waiting for you', items: attention });
    if (requests) {
      groups.unshift({ label: 'Friends', items: [
        { label: requests + (requests === 1 ? ' friend request' : ' friend requests'), path: '/friends' },
      ] });
    }

    simpleListContext(region, {
      title: servers.length ? 'Your places' : 'Get started',
      sub: servers.length ? servers.length + ' joined' : 'No communities yet',
      groups,
    });

    refreshHomeSidebar(region);
  }


export function friendsContext(region) {
  const requests = (State.friendsIn || []).length;
  simpleListContext(region, {
    title: 'Friends',
    sub: requests ? requests + ' request' + (requests === 1 ? '' : 's') + ' pending' : 'People you know',
    groups: [{ label: 'People', items: [
      { label: 'All friends', path: '/friends', exact: true },
      { label: 'Add friend', path: '/friends', exact: true },
    ] }],
  });
}

export function notificationsContext(region) {
  simpleListContext(region, {
    title: 'Notifications',
    sub: State.notifUnread ? State.notifUnread + ' unread' : 'All caught up',
    groups: [{ label: 'Activity', items: [
      { label: 'All notifications', path: '/notifications', exact: true },
    ] }],
  });
}

// Privacy Policy are full document loads at /terms and /privacy, not hash
// queue - an admin reaches it deliberately, not while triaging - so it lives
// current destination is never hidden behind a collapsed control.

const ADMIN_OVERFLOW = [
  { label: 'Announcements', path: '/admin/announcements' },
];

const adminSectionActive = (s, route) => (s.exact ? route === s.path : (route === s.path || route.startsWith(s.path + '/')));

// Which sidebar the shell paints, asked of the page registry rather than guessed
// from the path.
//
// This used to be eleven route comparisons in a row, which is a second opinion on
// what page you are on and had already drifted: three of the types it returned -
// discover, support and profile - no longer had a case to render them, so they
// silently fell through to the messages list. The registry already knows, per page,
// whether it has a contextual sidebar and which one.
export function sidebarContext() {
  const hit = matchRoute(compose().route || '/');
  if (!hit || !hit.page.sidebar) return { type: 'dms' };
  return {
    type: hit.page.sidebar,
    // A community's channels and a person's profile are both addressed by an id,
    // and both are the only thing the sidebar needs to know about them.
    serverId: hit.params.id || null,
    userId: hit.params.id || null,
  };
}

export function renderPlaceNavigation(region) {
  clear(region);
  if (!isAuthed()) return;
  // The route's layout already said whether this surface has a contextual
  // sidebar. Settings, Admin and a profile carry their own navigation inside the
  // content pane, and painting the shell's sidebar as well is what put the same
  // list on screen twice.
  // A surface that carries its own navigation inside the content pane must not also
  // get the shell's. That part was right. What was missing is what happens to the
  // column afterwards: the track kept its 260px and rendered as an empty dark panel
  // beside the page, which is 260px of nothing on Discover, Support, the legal
  // documents and the sign-up form.
  //
  // So the track collapses rather than being reserved. The rail keeps the global
  // destinations, which every surface still needs; only the community column goes.
  const shell = region.closest('#shell');
  if (!compose().channels.show) {
    region.dataset.empty = 'true';
    region.hidden = true;
    if (shell) shell.classList.add('no-community-nav');
    return;
  }
  delete region.dataset.empty;
  region.hidden = false;
  if (shell) shell.classList.remove('no-community-nav');
  const ctx = sidebarContext();
// Five of the ten arms below could not run, and the reason is worth writing down.
//
// A surface whose layout has no sidebar - settings, admin, discover, support,
// profile, and every plain page - returns from renderPlaceNavigation before this
// switch is reached, so its arm here was unreachable. The surfaces that do need a
// navigation column build it themselves in context-column.js, where the page and
// its column live together. Discover had a discoverContext written for it and it
// had never painted anything, which is why the column beside Discover sat empty
// through several rounds of looking at it.
//
// So the arms are now exactly the surfaces that have a sidebar. Adding one is a
// layout change and an arm here, in that order; a surface whose layout says
// sidebar:false must not grow an arm, because that will look right in review and
// never run.
  switch (ctx.type) {
    case 'community': return communityContext(region, ctx.serverId);
    case 'dms': return dmsContext(region);
    case 'home': return homeContext(region);
    case 'friends': return friendsContext(region);
    case 'notifications': return notificationsContext(region);
    default: return dmsContext(region);
  }
}
