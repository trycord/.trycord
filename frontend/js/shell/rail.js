import { compose } from './compose.js';
import { serverChipMenuFor } from './menus.js';
import { sidebarToggleButton } from './sidebar.js';
import { labelFor } from '../badges.js';
import { el, clear, qs, toast, relTime, confirmDialog, openModal, openReportDialog, attachMenu, attachContextMenu, showUserCard, copyText, announce } from '../ui.js';
import { avatar, icon, navRow, serverChip, navGroup } from '../components.js';
import Api from '../api.js';
import State, { isAuthed, currentServerId, can, peerPresence, refreshServers, leaveServerContext, clearSession, refreshDms, refreshFriends, refreshNotifications, mustVerifyToPost, refreshServerView } from '../state.js';
import { channelPath, serverPath } from '../links.js';
import { navigate, route } from '../nav.js';
import { matchRoute, railPages, mobilePages } from '../pages/registry.js';

// The community rail - the destinations, the communities, and the account button.

export function renderCommunities(region) {
  clear(region);
  if (!isAuthed()) return;
  const here = compose().route;

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

export function railAccountButton() {
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

