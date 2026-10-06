import { storage } from './config.js';
import { labelFor } from './badges.js';

import { el, clear, qs, toast, relTime, confirmDialog, openModal, openReportDialog, attachMenu, attachContextMenu, showUserCard, copyText, announce } from './ui.js';
import { avatar, icon, navRow, serverChip, navGroup } from './components.js';
import Api from './api.js';
import State, { isAuthed, currentServerId, can, peerPresence, refreshServers, leaveServerContext, clearSession, refreshDms, refreshFriends, refreshNotifications, mustVerifyToPost, refreshServerView } from './state.js';
import { isDesktopNavOpen, openDesktopNav, closeDesktopNav } from './presentation.js';
import { channelPath, serverPath } from './links.js';
import { navigate, route } from './nav.js';
import { layoutUsesSidebar, layoutUsesMembers } from './layout.js';
import { matchRoute, railPages, mobilePages } from './pages/registry.js';
import { renderCommunityContext } from './community-nav.js';

// wiring, so a menu can never exist on one input method and be missing on
// another. Menus are permission-shaped here: an action the viewer cannot perform

function serverChipMenuFor(s) {
  return () => {
    const sid = String(s.id);
    const isCurrent = sid === String(currentServerId());
    const mayManage = (isCurrent && can('MANAGE_SERVER')) || (s.is_owner && !isCurrent);
    return [
      { label: 'Open community', desc: s.name || '', onSelect: () => { navigate(serverPath(sid)); } },
      {
        label: 'Community settings', desc: mayManage ? undefined : 'Requires Manage Community',
        disabled: !mayManage,
        onSelect: () => { navigate(serverPath(sid, 'settings')); },
      },
      { label: 'Copy community link', onSelect: () => copyText(sid, 'Community ID copied.') },
      { label: 'Copy community ID', onSelect: () => copyText(sid, 'Community ID copied.') },
      { sep: true },
      {
        label: 'Leave community', danger: true,
        onSelect: () => {
          if (s.is_owner) { toast('You own this community. Transfer or delete it first.', 'warn'); return; }
          confirmDialog({
            title: 'Leave ' + (s.name || 'community') + '?',
            message: 'You can rejoin later with a new invite.',
            danger: true, confirmText: 'Leave',
            onConfirm: async () => {
              try {
                await Api.leaveServer(sid);
                await refreshServers();
                if (isCurrent) leaveServerContext();
                navigate('/home');
              } catch (ex) { toast(ex.message || 'Failed', 'error'); }
            },
          });
        },
      },
    ];
  };
}

function roleAssignable(roleId) {
  if (!can('MANAGE_ROLES')) return false;
  if ((State.permissions || []).includes('*')) return true;
  const role = (State.roles || []).find((r) => String(r.id) === String(roleId));
  if (!role) return false;
  return myTopPosition() > Number(role.position || 0);
}

function myTopPosition() {
  const me = State.me;
  if (!me) return -1;
  const row = (State.members || []).find((m) => String(m.user_id || m.id) === String(me.id));
  const mine = (row && row.roles) || [];
  return mine.length ? Math.max(...mine.map((r) => Number(r.position || 0))) : -1;
}

function memberMenu(m) {
  return () => memberActions(m);
}

/**
 * Actions for one conversation in the sidebar.
 *
 * Everything here is something the DM routes already serve or something that is
 * purely local to this device. There is no "delete conversation" because the
 * server has no such route - offering one would be a button that either does
 * nothing or removes the conversation for both people, which is not what a
 * reader clicking it would expect.
 */
function dmRowActions(dm, peer, name) {
  const items = [
    { label: 'Open conversation', onSelect: () => { navigate('/dms/' + dm.id); } },
    { label: 'Copy conversation ID', onSelect: () => copyText(String(dm.id), 'Conversation ID copied.') },
  ];
  if (peer && peer.id) {
    items.push({ sep: true });
    items.push({
      label: 'View profile',
      desc: name,
      onSelect: () => { navigate('/users/' + peer.id); },
    });
    items.push({
      label: 'Mark as read',
      onSelect: async () => {
        try {
          await Api.dmRead(dm.id);
          toast('Marked as read.', 'ok');
          refreshDms().catch(() => {});
        } catch (ex) {
          toast(ex.message || 'Could not mark that read.', 'error');
        }
      },
    });
  }
  return items;
}

// The action list for one member, permission-shaped. Exported so the member
export function memberActions(m) {
  const id = m.user_id || m.id;
  const sid = currentServerId();
  const name = m.nickname || m.display_name || m.username || 'Unknown';
  const mine = String(id) === String(State.me && State.me.id);
  const canMod = !m.is_owner && !mine && !!sid;
  const modTimeout = () => {
    const dur = el('select', { class: 'input' });
    [['60', '1 hour'], ['1440', '1 day'], ['10080', '7 days']].forEach(([v, label]) => {
      dur.appendChild(el('option', { value: v }, label));
    });
    const err = el('div', { class: 'form-error', hidden: true });
    const cancel = el('button', { class: 'btn ghost', type: 'button' }, 'Cancel');
    const go = el('button', { class: 'btn danger', type: 'button' }, 'Time out');
    const modal = openModal({
      title: 'Time out @' + (m.username || ''),
      body: el('div', {}, el('div', { class: 'field' }, el('label', {}, 'Duration'), dur), err),
      footer: el('div', { class: 'row-line' }, cancel, go),
    });
    cancel.addEventListener('click', () => modal.close());
    go.addEventListener('click', async () => {
      try {
        await Api.timeoutMember(sid, id, Number(dur.value));
        modal.close();
        toast('Member timed out.', 'ok');
        renderAllChrome();
      } catch (ex) { err.hidden = false; err.textContent = ex.message || 'Could not time out.'; }
    });
  };

  // offered. There is deliberately no "assign to yourself" path anywhere.
  const held = new Set(((m.roles) || []).map((r) => String(r.id)));
  const assignable = (State.roles || []).filter((r) => !held.has(String(r.id)) && roleAssignable(String(r.id)));
  const removable = ((m.roles) || []).filter((r) => roleAssignable(String(r.id)));

  const rolesSubmenu = () => {
    if (!sid || mine) return null;
    if (!can('MANAGE_ROLES')) return null;
    const items = [];
    if (assignable.length) {
      items.push({ heading: 'Add role' });
      for (const r of assignable) {
        items.push({
          label: r.name || 'Role',
          desc: r.color ? 'Coloured' : undefined,
          onSelect: async () => {
            try {
              await Api.assignRole(sid, r.id, id);
              toast('Added ' + (r.name || 'role') + '.', 'ok');
              await refreshServerView();
              renderAllChrome();
            } catch (ex) { toast(ex.message || 'Could not add that role.', 'error'); }
          },
        });
      }
    }
    if (removable.length) {
      if (items.length) items.push({ sep: true });
      items.push({ heading: 'Remove role' });
      for (const r of removable) {
        items.push({
          label: r.name || 'Role',
          onSelect: async () => {
            try {
              await Api.unassignRole(sid, r.id, id);
              toast('Removed ' + (r.name || 'role') + '.', 'ok');
              await refreshServerView();
              renderAllChrome();
            } catch (ex) { toast(ex.message || 'Could not remove that role.', 'error'); }
          },
        });
      }
    }
    if (!items.length) return null;
    return { label: 'Roles', desc: 'Assign or remove', items };
  };

  const modSubmenu = () => {
    if (!canMod) return null;
    const items = [];
    if (can('BAN_MEMBERS')) items.push({ label: 'Timeout', onSelect: modTimeout });
    if (can('KICK_MEMBERS')) {
      items.push({
        label: 'Kick', danger: true, onSelect: () => confirmDialog({
          title: 'Remove member?', message: '@' + (m.username || '') + ' will leave this community immediately.',
          danger: true, confirmText: 'Remove',
          onConfirm: async () => {
            try { await Api.kickMember(sid, id); toast('Member removed.', 'ok'); renderAllChrome(); }
            catch (ex) { toast(ex.message || 'Could not remove member.', 'error'); }
          },
        }),
      });
    }
    if (can('BAN_MEMBERS')) {
      items.push({
        label: 'Ban', danger: true, onSelect: () => confirmDialog({
          title: 'Ban @' + (m.username || '') + '?', message: 'They will be removed and blocked from rejoining.',
          danger: true, confirmText: 'Ban',
          onConfirm: async () => {
            try { await Api.banMember(sid, id, {}); toast('Member banned.', 'ok'); renderAllChrome(); }
            catch (ex) { toast(ex.message || 'Could not ban member.', 'error'); }
          },
        }),
      });
    }
    if (!items.length) return null;
    return { label: 'Moderation', items };
  };

  const actions = [
    { label: 'View profile', onSelect: () => { navigate('/users/' + id); } },
    ...(mine ? [] : [{ label: 'Message', onSelect: () => messageMember(id) }]),
    { label: 'Copy user ID', onSelect: () => copyText(String(id), 'User ID copied.') },
  ];
  const roles = rolesSubmenu();
  if (roles) actions.push(roles);
  const mod = modSubmenu();
  if (mod) actions.push(mod);
  if (!mine) {
    actions.push({ sep: true });
    actions.push({
      label: 'Add friend', onSelect: async () => {
        try { await Api.sendFriendRequest(id); toast('Friend request sent.', 'ok'); }
        catch (ex) { toast(ex.message || 'Could not send request.', 'error'); }
      },
    });
    actions.push({
      label: 'Report user', onSelect: () => openReportDialog({
        targetType: 'user', targetId: id, title: 'Report user', subtitle: '@' + (m.username || 'unknown'),
        onSubmit: ({ category, extra }) => Api.reportContent('user', id, category, extra || undefined),
      }),
    });
  }
  return actions;
}

let navRoute = () => '';

export function setNavRoute(fn) {
  navRoute = fn;
}

export function currentRoute() {
  return navRoute();
}


export function renderCommunities(region) {
  clear(region);
  if (!isAuthed()) return;
  const here = currentRoute();

  // `path` is what the router reports, `href` is where the browser goes. They are
  // different strings wherever the app is mounted under a subpath, so the active
  // test has to use the first and the navigation the second.
  // `short` is what the 84px rail prints under the glyph; `label` is the full
  // name, still used for the title, the aria-label and the tooltip. At 84px
  // 'Direct messages' truncates to 'Direct me...', which is worse than useless.
  // The rail's destinations come from the registry, which is also what the route
  // table and the phone tab bar read. This list used to be a fourth copy of the
  // same five rows, which is how Discover ended up in the rail and nowhere else.
  // The count lives in badges.js, keyed by page id, because the phone tab bar asks
  // the same question about the same destinations. Two copies of this map is how
  // Direct messages ended up with no badge on the rail while the home page knew about
  // four unread conversations.
  const globalItems = railPages().map((page) => ({
    id: page.id,
    label: page.nav.label,
    short: page.nav.short,
    icon: page.nav.icon,
    path: page.path,
    badge: () => labelFor(page.id),
  }));

  // The rail's own destinations carry words, for the same reason communities do:
  // five glyphs in a column is a puzzle, five labelled rows is a menu.
  const railButton = ({ label, short, icon: iconName, path, active, badge }) => {
    const btn = el('button', {
      class: 'rail-nav' + (active ? ' is-active' : ''),
      type: 'button',
      title: label,
      'aria-label': label,
      'aria-current': active ? 'page' : null,
      dataset: { label },
      onClick: () => { navigate(route(path)); },
    },
    el('span', { class: 'rail-nav__icon' }, icon(iconName)),
    el('span', { class: 'rail-nav__label' }, short || label));
    const badgeLabel = badge ? badge() : null;
    if (badgeLabel) {
      btn.appendChild(el('span', { class: 'rail-nav__badge' }, badgeLabel));
    }
    return btn;
  };

  // The mark is the anchor for the whole rail: it says which product this is, and
  // it is the way back to the start from anywhere. The application had none at all -
  // the sign-in page had one and the shell did not.
  const mark = el('button', {
    class: 'rail-mark-btn',
    type: 'button',
    title: 'Trycord',
    'aria-label': 'Trycord home',
    onClick: () => { navigate(route('/home')); },
  }, el('img', { class: 'rail-mark-btn__img', src: '/assets/trycord-logo.png', alt: '' }));
  region.appendChild(el('div', { class: 'rail-brand' }, mark));

  // Two navigations, not one list. Where you are in Trycord, and which places you
  // are in, are different questions, and the rail answered both with one
  // undifferentiated column separated by a rule - so a community looked like just
  // another global destination. They are separate regions now, each with its own
  // heading. The distinction survives 84px because it is carried by the grouping
  // rather than by a word that would not fit.
  const globalGroup = el('nav', { class: 'rail-group', 'aria-label': 'Your Trycord' });
  for (const item of globalItems) {
    globalGroup.appendChild(railButton({
      label: item.label, short: item.short, icon: item.icon, path: item.path, badge: item.badge,
      active: here === item.path || here.startsWith(item.path + '/'),
    }));
  }
  region.appendChild(el('div', { class: 'rail-section' },
    el('div', { class: 'rail-section__label' }, 'Yours'),
    globalGroup));

  // Creation action. Discover is deliberately absent: it is a global destination
  // and already has a row above.
  const create = el('button', {
    class: 'rail-nav rail-nav--create',
    type: 'button',
    title: 'Create a community',
    'aria-label': 'Create a community',
    dataset: { label: 'Create a community' },
    onClick: () => { navigate('/servers/new'); },
  },
  el('span', { class: 'rail-nav__icon' }, icon('plus')),
  el('span', { class: 'rail-nav__label' }, 'New'));

  const servers = State.servers || [];
  const communityGroup = el('nav', { class: 'rail-group', 'aria-label': 'Your communities' });
  if (servers.length) {
    for (const s of servers) {
      const chip = serverChip(s, {
        active: String(s.id) === String(currentServerId()),
        onClick: () => { navigate(serverPath(s.id)); },
      });
      chip.dataset.label = s.name || 'Community';
      attachContextMenu(chip, serverChipMenuFor(s), {
        target: (node) => ({ type: 'community', id: String(s.id) }),
      });
      communityGroup.appendChild(chip);
    }
  }
  // Shown whether or not there are any yet: on a new account this is where the
  // empty list admits it, and where the action that fills it lives.
  communityGroup.appendChild(create);
  region.appendChild(el('div', { class: 'rail-section rail-section--communities' },
    el('div', { class: 'rail-section__label' },
      servers.length ? servers.length + (servers.length === 1 ? ' place' : ' places') : 'Places'),
    communityGroup));

  // The account control lives at the foot of the global rail rather than inside
  // any one surface's sidebar. It used to be a panel pinned to the bottom of the
  // community sidebar, which meant it disappeared on every surface without a
  // sidebar - and there is no surface that has a sidebar and no account, so the
  // rail is where a global control belongs.
  const foot = el('div', { class: 'rail-foot' });
  foot.appendChild(railAccountButton());
  foot.appendChild(sidebarToggleButton());
  region.appendChild(foot);
}

function railAccountButton() {
  const me = State.me;
  if (!me) {
    const guest = el('button', {
      class: 'rail-foot-btn',
      type: 'button',
      title: 'Sign in',
      'aria-label': 'Sign in',
      dataset: { label: 'Sign in' },
      onClick: () => { navigate(route('/login')); },
    }, el('span', { class: 'nv-icon' }, icon('users')));
    return guest;
  }
  const btn = el('button', {
    class: 'rail-foot-btn rail-account',
    type: 'button',
    title: (me.displayName || me.username) + ' — account',
    'aria-label': 'Your account and settings',
    dataset: { label: 'Account' },
  }, avatar(me, { size: 'sm', withPresence: true }));
  attachMenu(btn, () => [
    { label: me.displayName || me.username, desc: '@' + me.username, disabled: true },
    { sep: true },
    { label: 'Settings', icon: 'gear', onSelect: () => navigate(route('/settings')) },
    { label: 'Switch community', icon: 'users', onSelect: () => navigate(route('/menu')) },
    { sep: true },
    { label: 'Sign out', icon: 'logout', danger: true, onSelect: () => signOut() },
  ]);
  return btn;
}

async function signOut() {
  try { await Api.logout(); } catch { /* server may be down; still sign out locally */ }
  clearSession();
  navigate(route('/login'));
}

let homeRefreshAt = 0;
let homeRefreshOn = false;
function refreshHomeSidebar(region) {
  const now = Date.now();
  if (homeRefreshOn || now - homeRefreshAt < 30000) return;
  homeRefreshOn = true;
  homeRefreshAt = now;
  Promise.allSettled([refreshDms(), refreshFriends(), refreshNotifications()]).finally(() => {
    homeRefreshOn = false;
    if (region.isConnected) {
      try { renderPlaceNavigation(region); } catch { /* stale view */ }
      try { renderAllChrome(); } catch { /* ignore */ }
    }
  });
}

function pageHeader(title, sub) {
  const head = el('header', { class: 'ctx-head' });
  const bar = el('div', { class: 'ctx-head__bar' });
  const text = el('div', { class: 'ctx-head__text' });
  text.appendChild(el('div', { class: 'ctx-head__title' }, title));
  if (sub) text.appendChild(el('div', { class: 'ctx-head__sub' }, sub));
  bar.appendChild(text);
  head.appendChild(bar);
  return head;
}



function communityContext(region, sid) {
  renderCommunityContext(region, sid, currentRoute());
}


function dmsContext(region) {
  const here = currentRoute();
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

  const compose = el('div', { class: 'ctx-actions' });
  compose.appendChild(el('button', {
    class: 'btn primary block', type: 'button',
    onClick: () => { navigate('/friends'); },
  }, 'New message'));
  scroll.appendChild(compose);
  scroll.appendChild(search);
  scroll.appendChild(listBox);
  search.addEventListener('input', () => paint(search.value));
  paint('');

  refreshHomeSidebar(region);
}



function simpleListContext(region, { title, sub, groups }) {
  const here = currentRoute();
  region.appendChild(pageHeader(title, sub));
  const scroll = el('div', { class: 'ctx-scroll' });
  region.appendChild(scroll);
  for (const g of groups) {
    if (!g || !g.items.length) continue;
    const group = navGroup({ label: g.label });
    for (const item of g.items) {
      // A row with no destination is still information - it is a fact the reader was
      // shown - but it must not become a link that throws when the route is compared.
      const dest = item.path || '';
      const active = !!dest && (item.exact ? here === dest : (here === dest || here.startsWith(dest + '/')));
      group.list.appendChild(navRow({
        label: item.label, href: route(item.path), active,
        onClick: () => { navigate(item.path); },
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


function friendsContext(region) {
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

function notificationsContext(region) {
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
  const hit = matchRoute(currentRoute() || '/');
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
  if (!layoutUsesSidebar()) {
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

const LS_HIDE_MEMBERS = 'trycord.hideMembers';
const LS_SIDEBAR_COLLAPSED = 'trycord.sidebarCollapsed';

export function membersHidden() {
  try { return localStorage.getItem(LS_HIDE_MEMBERS) === '1'; } catch { return false; }
}

export function toggleMembers() {
  try {
    localStorage.setItem(LS_HIDE_MEMBERS, membersHidden() ? '0' : '1');
  } catch { /* ignore */ }
  renderMemberSidebar(qs('#member-sidebar'));
}


export function isSidebarCollapsed() {
  try { return localStorage.getItem(LS_SIDEBAR_COLLAPSED) === '1'; } catch { return false; }
}

export function toggleSidebar() {
  const next = !isSidebarCollapsed();
  storage(() => localStorage.setItem(LS_SIDEBAR_COLLAPSED, next));
  applySidebarState();
}

export function applySidebarState() {
  const shell = qs('#shell');
  if (shell) shell.classList.toggle('sidebar-collapsed', isSidebarCollapsed());
  renderAllChrome();
}

const SIDEBAR_DOCK_MIN = 760;

function contextSidebarDocked() {
  return window.innerWidth >= SIDEBAR_DOCK_MIN;
}

function contextSidebarVisible() {
  const shell = qs('#shell');
  if (!shell) return false;
  if (shell.classList.contains('sidebar-collapsed')) return isDesktopNavOpen();
  if (isDesktopNavOpen()) return true;
  return contextSidebarDocked();
}

export function toggleContextSidebar() {
  const shell = qs('#shell');
  if (!shell) return;
  if (contextSidebarDocked()) {
    if (isDesktopNavOpen()) closeDesktopNav();
    toggleSidebar();
    return;
  }
  if (isDesktopNavOpen()) closeDesktopNav();
  else openDesktopNav();
  const btn = qs('.nav-toggle');
  if (btn) btn.setAttribute('aria-expanded', isDesktopNavOpen() ? 'true' : 'false');
}

function sidebarToggleButton() {
  const collapsed = isSidebarCollapsed();
  const btn = el('button', {
    class: 'sidebar-collapse-toggle',
    type: 'button',
    title: collapsed ? 'Expand sidebar' : 'Collapse sidebar',
    'aria-label': collapsed ? 'Expand sidebar' : 'Collapse sidebar',
    'aria-pressed': collapsed ? 'true' : 'false',
  }, collapsed ? '▶' : '◀');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSidebar();
  });
  return btn;
}

export function renderMemberSidebar(region) {
  clear(region);
  // A member panel only means something inside a community. The route's layout
  // decides that, not the panel's own guess about the path, so a surface that
  // has no member panel cannot leave one reserving width it will not fill.
  if (!isAuthed() || !layoutUsesMembers() || !currentServerId()
    || !State.serverDetail || !currentRoute().startsWith('/server/')) {
    region.hidden = true;
    return;
  }
  if (membersHidden()) {
    region.hidden = true;
    return;
  }
  region.hidden = false;
  const server = State.serverDetail;
  const onlineCount = (State.members || []).filter((m) => peerPresence(m.user_id || m.id) === 'online').length;
  region.appendChild(el('div', { class: 'member-sidebar__header' },
    el('span', {}, 'Members'),
    el('span', { class: 'member-count' }, String(onlineCount) + ' online')
  ));

  const roles = Array.isArray(State.roles) ? [...State.roles].sort((a,b) => (Number(b.position)||0) - (Number(a.position)||0)) : [];
  const roleById = new Map(roles.map(r => [String(r.id), r]));
  const groups = new Map();
  const roleKey = (member) => {
    if (member.is_owner) return '__owner__';
    const top = Array.isArray(member.roles) && member.roles.length
      ? member.roles.map(r => roleById.get(String(r.id)) || r).sort((a,b) => (Number(b.position)||0) - (Number(a.position)||0))[0]
      : null;
    return top ? String(top.id) : '__member__';
  };
  for (const m of State.members || []) {
    const k = roleKey(m);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(m);
  }
  const order = ['__owner__', ...roles.map(r => String(r.id)), '__member__'];
  const seen = new Set();
  for (const key of order) {
    if (seen.has(key)) continue; seen.add(key);
    const members = groups.get(key) || [];
    if (!members.length) continue;
    let label = 'MEMBERS';
    if (key === '__owner__') label = 'OWNER';
    else if (key !== '__member__') {
      const role = roleById.get(key);
      label = role ? String(role.name || 'ROLE').toUpperCase() : 'ROLE';
    }
    const group = el('section', { class: 'member-group' });
    const groupLabel = el('div', { class: 'member-group__label' }, label + ' · ' + members.length);
    if (key !== '__owner__' && key !== '__member__') {
      const role = roleById.get(key);
      if (role && role.color) groupLabel.style.color = role.color;
    }
    group.appendChild(groupLabel);
    for (const m of members) {
      const id = m.user_id || m.id;
      const name = m.nickname || m.display_name || m.username || 'Unknown';
      const rolesForMember = Array.isArray(m.roles) ? m.roles : [];
      const top = m.is_owner ? null
        : rolesForMember.map((r) => roleById.get(String(r.id)) || r)
          .sort((a, b) => Number(b.position || 0) - Number(a.position || 0))[0] || null;
      const rowWrap = el('div', { class: 'member-row-wrap' });
      const row = el('button', { class: 'row row--member', type: 'button', title: '@' + (m.username || '') });
      row.appendChild(avatar({ id, username: m.username, displayName: name, avatarUrl: m.avatar_url }, { size: 'sm', withPresence: true }));
      const info = el('span', { class: 'member-item__info' });
      const nameLine = el('span', { class: 'member-item__name' }, name);
      if (m.is_bot) nameLine.appendChild(el('span', { class: 'bot-tag' }, 'BOT'));
      info.appendChild(nameLine);
      const roleText = m.is_owner ? 'Owner' : (top && top.name) || 'Member';
      const roleLine = el('span', { class: 'member-item__role' });
      if (top && top.color) roleLine.appendChild(el('span', { class: 'role-color-dot', style: { background: top.color } }));
      roleLine.appendChild(el('span', {}, roleText));
      info.appendChild(roleLine);
      row.appendChild(info);
      row.addEventListener('click', () => { navigate('/users/' + id); });
      attachContextMenu(row, memberMenu(m), {
        target: (node) => ({ type: 'member', id: String(m.user_id || m.id) }),
      });
      let hoverTimer = null;
      const hoverCapable = () => {
        try { return matchMedia('(hover: hover) and (pointer: fine)').matches; } catch { return true; }
      };
      row.addEventListener('mouseenter', () => {
        if (!hoverCapable()) return;
        hoverTimer = setTimeout(() => {
          const r = row.getBoundingClientRect();
          showUserCard(r.right + 8, r.top, {
            avatarEl: avatar({ id, username: m.username, displayName: name, avatarUrl: m.avatar_url }, { size: 'lg', withPresence: true }),
            title: name,
            sub: '@' + (m.username || 'unknown'),
            statusLine: m.status_text || null,
            actions: [],
          });
        }, 420);
      });
      const clearHover = () => { clearTimeout(hoverTimer); hoverTimer = null; };
      row.addEventListener('mouseleave', clearHover);
      row.addEventListener('click', clearHover);
      rowWrap.appendChild(row);
      group.appendChild(rowWrap);
    }
    region.appendChild(group);
  }
  if (!(State.members || []).length) {
    region.appendChild(el('div', { class: 'member-sidebar__empty' }, 'No members to show yet.'));
  }
}


// `icon` is destructured to iconGlyph rather than bound as `icon`: the imported
// icon() below builds the navigation toggle, and a parameter of the same name
// shadowed it. Every caller omits it, so icon() resolved to undefined and threw
// "icon is not a function" on every single header render - which is every page.
// The public { icon } key is unchanged; only the local binding is renamed.
export function renderContextHeader({ title, sub, icon: iconGlyph, actions } = {}) {
  const header = qs('#context-header');
  if (!header) return;
  header.dataset.hasIcon = iconGlyph ? 'true' : 'false';
  clear(header);

  if (title) announce(title + (sub ? '. ' + sub : ''));

  const navToggle = el('button', {
    class: 'nav-toggle', type: 'button',
    title: 'Navigation', 'aria-label': 'Toggle navigation',
    'aria-expanded': isDesktopNavOpen() ? 'true' : 'false',
  }, icon('menu'));
  navToggle.addEventListener('click', () => toggleContextSidebar());
  header.appendChild(navToggle);

  const titles = el('div', { class: 'context-header__titles' });
  if (iconGlyph) titles.appendChild(el('div', { class: 'context-header__icon' }, iconGlyph));
  // The one h1 on every surface. It was a div, so no page in the application
  // had a top-level heading: someone navigating by heading found nothing to
  // land on, and the current view had no heading identifying it at all.
  titles.appendChild(el('h1', { class: 'context-title', id: 'context-title' },
    title || 'Trycord'));
  if (sub) titles.appendChild(el('div', { class: 'context-sub' }, sub));
  header.appendChild(titles);

  // Accepts one node or a list of them. Nineteen page modules call this, and
  // passing a bare element where a list was expected threw on the for-of, which
  // took the entire surface down to the error screen over one header button.
  // Normalised here so that cannot happen again.
  const list = actions == null ? [] : (Array.isArray(actions) ? actions : [actions]);
  const acts = el('div', { class: 'context-actions' });
  for (const a of list) if (a) acts.appendChild(a);
  if (acts.childNodes.length) header.appendChild(acts);

}


const LS_TABBAR_HIDDEN = 'trycord.tabbarHidden';

export function isTabBarHidden() {
  try { return localStorage.getItem(LS_TABBAR_HIDDEN) === '1'; } catch { return false; }
}

export function setTabBarHidden(hidden) {
  storage(() => localStorage.setItem(LS_TABBAR_HIDDEN, hidden));
  const bar = qs('#mobile-tab-navigation');
  // The attribute lives on the bar, and the narrow layout's grid gives the bar
  // its own auto track, so collapsing it hands the height straight back to the
  // content above it. No padding to recalculate and nothing to reflow.
  if (bar) bar.dataset.collapsed = hidden ? 'true' : 'false';
}

// Collapsible because on a short phone the bar competes with the composer for
// the same 64px, and the message being typed matters more than the five
// destinations are reachable from. One thumb-tall handle remains so it can be
// brought back without a reload.
export function renderMobileTabs(region) {
  clear(region);
  if (!isAuthed()) return;
  const here = currentRoute();
  const hidden = isTabBarHidden();
  region.dataset.collapsed = hidden ? 'true' : 'false';

  // `path` is the route the app compares against, `href` is where it actually
  // goes. They differ wherever the app is mounted under a subpath, so the active
  // test has to use one and the navigation the other.
  // The same destinations the rail offers, narrowed for a phone. It used to be a
  // separate list with its own wording - 'DMs' here against 'Messages' there - and
  // its own idea of what exists: Menu was in this list and not in the rail's.
  const tabs = mobilePages().map((page) => ({
    id: page.id,
    label: page.nav.tabLabel || page.nav.short,
    icon: page.nav.icon,
    path: page.path,
  }));
  const strip = el('div', { class: 'mobile-tab-navigation__strip' });
  for (const t of tabs) {
    const active = here === t.path || here.startsWith(t.path + '/');
    const btn = el('button', {
      type: 'button', class: 'tab-button' + (active ? ' active' : ''),
      'aria-current': active ? 'page' : null,
      onClick: () => { navigate(route(t.path)); },
    });
    const count = labelFor(t.id);
    const glyph = el('span', { class: 'micon tab-button__glyph' }, icon(t.icon));
    if (count) glyph.appendChild(el('span', { class: 'tab-button__count' }, count));
    btn.appendChild(glyph);
    btn.appendChild(el('span', { class: 'mlabel tab-button__label' }, t.label));
    // The count is the only place it appears on a phone, so the label has to say it
    // out loud too: "four waiting" is not the same information as the word "Messages".
    if (count) btn.setAttribute('aria-label', t.label + ', ' + count + ' waiting');
    strip.appendChild(btn);
  }

  const toggle = el('button', {
    type: 'button',
    class: 'mobile-tab-navigation__toggle',
    'aria-expanded': hidden ? 'false' : 'true',
    'aria-controls': 'mobile-tab-navigation',
    title: hidden ? 'Show navigation' : 'Hide navigation',
    'aria-label': hidden ? 'Show navigation' : 'Hide navigation',
  }, icon('menu'));
  toggle.addEventListener('click', () => {
    const next = !isTabBarHidden();
    setTabBarHidden(next);
    renderMobileTabs(region);
  });

  region.append(toggle, strip);
}

// Each region is independent: the rail, the channel list, the mobile tab bar and
// the member pane are separate features, and one of them failing says nothing
// about the others.
//
// They were painted by one unguarded sequence, so any throw inside any of them
// propagated out of renderAllChrome and into the router's catch - which replaced
// the whole view with an error screen. A stale cached module was enough to blank
// the entire app that way: shell.js calling icon() against a components.js the
// page had not reloaded threw "icon is not a function" and took every region
// with it.
function paintRegion(fn) {
  try {
    fn();
  } catch (e) {
    // Some embedders run with no console at all - a locked-down webview, an
    // Electron renderer with node integration off. Losing the log line is the
    // entire cost of catching here, and not catching it takes the chrome down.
    try { console.error('[trycord] chrome region failed', e); } catch { /* no console */ }
  }
}

export function renderAllChrome() {
  paintRegion(() => renderCommunities(qs('#community-navigation')));
  paintRegion(() => renderPlaceNavigation(qs('#place-navigation')));
  paintRegion(() => renderMobileTabs(qs('#mobile-tab-navigation')));
  paintRegion(() => renderMemberSidebar(qs('#member-sidebar')));
  paintRegion(() => renderAnnouncementBanner());
  paintRegion(() => renderVerifyBanner());
}

// fetched once per session and then refreshed on a slow interval, so an admin

import { loadAnnouncements, clearAnnouncements, renderAnnouncementBanner, renderVerifyBanner } from './shell/banners.js';

// Re-exported for app.js and account/session.js, which have no business knowing that
// banners live in their own module. Imported first and exported second, because a bare
// `export { x } from` would leave the two names below unbound in this file's scope.
export { loadAnnouncements, clearAnnouncements };

export default { renderAllChrome, renderVerifyBanner, renderContextHeader, renderCommunities, renderPlaceNavigation, renderMemberSidebar, renderMobileTabs, setNavRoute, membersHidden, toggleMembers, isSidebarCollapsed, toggleSidebar, applySidebarState };
