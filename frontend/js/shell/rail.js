// The application rail: the smallest persistent navigation layer, and the one that answers
// "where am I in Trycord globally".
//
// It is deliberately not a second sidebar. What is inside the current community - its
// channels, its members - belongs to contextual navigation, and mixing the two is what made
// a community look like just another destination in a list of global ones. The rail holds
// the mark, the global destinations, and the places you are in. Nothing else.

import { el, icon } from '../ui.js';
import { navigate, route } from '../nav.js';
import State from '../state.js';
import {
  hashColor, initialOf, communityIconUrl, loadAuthedImage,
} from '../components/media.js';

// Which global destinations exist, and where they go. Order is reading order, not route
// matching: the finder matches on prefix boundaries so moving an entry cannot change what a
// URL means.
const DESTINATIONS = [
  { id: 'home', label: 'Home', short: 'Home', icon: 'home', path: '/home' },
  { id: 'dms', label: 'Direct messages', short: 'DMs', icon: 'mail', path: '/dms' },
  { id: 'notifications', label: 'Notifications', short: 'Alerts', icon: 'bell', path: '/notifications' },
  { id: 'discover', label: 'Discover', short: 'Find', icon: 'compass', path: '/discover' },
];

/**
 * One rail button. Icon plus a label, both of which are read by assistive technology: the
 * icon is decorative and the label carries the meaning, so an icon-only rail is not an
 * unnamed one.
 */
function railLink({ label, short, icon: iconName, path, active, badge, onClick }) {
  const btn = el('a', {
    class: 'rail-link' + (active ? ' is-active' : ''),
    href: route(path),
    'aria-label': label,
    'aria-current': active ? 'page' : null,
    title: label,
    dataset: { label },
  });
  btn.appendChild(el('span', {
    class: 'rail-link__icon',
    'aria-hidden': 'true',
  }, icon(iconName)));
  if (badge) {
    btn.appendChild(el('span', { class: 'rail-link__badge', 'aria-hidden': 'true' }, badge));
  }
  return btn;
}

/**
 * The places the reader is in, as a list of community marks.
 *
 * An image is preferred where there is one, and the mark keeps a coloured background with
 * the community's initial behind it so it degrades to something recognisable rather than to
 * an empty box while the image loads - or forever, if it never does.
 */
function communityChip(name, { active, server, onClick }) {
  const chip = el('a', {
    class: 'rail-community' + (active ? ' is-active' : ''),
    href: route('/servers/' + (server && server.id ? server.id : '')),
    'aria-current': active ? 'page' : null,
    title: name + (server && server.is_owner ? ' — you own this community' : ''),
    dataset: { serverId: server && server.id, label: name },
  });

  // The derived colour is a hash of the name, so the same community is the same tone every
  // time, and the ink is the light one the palette guarantees against every entry in it.
  const mark = el('span', {
    class: 'community-mark',
    style: { background: hashColor(name), color: 'var(--color-mark-ink)' },
    'aria-hidden': 'true',
  }, initialOf(name));

  const src = communityIconUrl(server);
  if (src) {
    loadAuthedImage(src).then((url) => {
      if (!url || !mark.isConnected) return;
      mark.classList.add('has-img');
      mark.textContent = '';
      mark.appendChild(el('img', { class: 'community-mark__img', src: url, alt: '', loading: 'lazy' }));
    }).catch(() => { /* the initial stays behind; that is what it is for */ });
  }
  chip.appendChild(mark);
  chip.appendChild(el('span', { class: 'rail-community__name' }, name));
  if (onClick) chip.addEventListener('click', onClick);
  return chip;
}

/**
 * Draw the rail: the mark, the global destinations, and the communities.
 *
 * `plan` carries everything this needs - the reader's own home, the destinations to show,
 * the places they are in, and which of them is current. Building the rail is this function;
 * deciding what is in it is not, and that is what keeps it from becoming a place where
 * permission logic quietly accumulates.
 */
export function renderRail(region, plan) {
  const { me, destinations, communities, activePath, badges } = plan || {};

  // The mark is the way back to the start from anywhere, and it is the only thing in the
  // rail that says which product this is.
  const brand = el('a', {
    class: 'rail-mark-btn',
    href: route('/home'),
    title: 'Trycord',
    'aria-label': 'Trycord home',
  });
  const markImg = el('img', { class: 'rail-mark-btn__img', src: '/assets/trycord-logo.png', alt: '' });
  markImg.addEventListener('error', () => {
    // The mark is the one thing that has to be there even when the asset is not.
    brand.textContent = '';
    brand.appendChild(el('span', { class: 'rail-mark', 'aria-hidden': 'true' }, 'T'));
  });
  brand.appendChild(markImg);

  const global = el('nav', {
    class: 'rail-nav',
    id: 'global-navigation',
    'aria-label': 'Global navigation',
  });

  for (const d of (destinations || DESTINATIONS)) {
    const dest = DESTINATIONS.find((x) => x.id === d.id) || d;
    global.appendChild(railLink({
      label: dest.label,
      short: dest.short,
      icon: dest.icon,
      path: dest.path,
      active: activePath === dest.path || (dest.path === '/home' && activePath === '/'),
      badge: badges && badges[dest.id],
    }));
  }

  const places = el('section', {
    class: 'rail-group',
    id: 'community-navigation',
    'aria-label': 'Communities',
  }, [
    el('p', { class: 'rail-section__label' }, 'Places'),
    ...(communities || []).map((c) => communityChip(c.name, {
      active: activePath === '/servers/' + c.id,
      server: c,
    })),
    el('a', {
      class: 'rail-community rail-community--add',
      href: route('/discover'),
      title: 'Find a community',
      'aria-label': 'Find a community',
    }, el('span', { class: 'rail-community__name', 'aria-hidden': 'true' }, '+')),
  ]);

  region.replaceChildren(brand, global, places);
  return region;
}

export default { renderRail };

/**
 * The account button, at the foot of the rail. Kept as its own export because it is the one
 * control reachable from every page, and the shell composes it separately from the rail body.
 */
export function railAccountButton() {
  const me = State.me;
  if (!me) {
    return el('button', {
      class: 'rail-foot-btn',
      type: 'button',
      title: 'Sign in',
      'aria-label': 'Sign in',
      dataset: { label: 'Sign in' },
      onClick: () => { navigate(route('/login')); },
    }, el('span', { class: 'nv-icon' }, icon('users')));
  }
  return el('button', {
    class: 'rail-foot-btn rail-account',
    type: 'button',
    title: (me.displayName || me.username) + ' — account',
    'aria-label': 'Your account and settings',
    'aria-haspopup': 'menu',
    dataset: { label: 'Account' },
  }, el('span', { class: 'nv-icon' }, icon('users')));
}

/**
 * The rail's communities, for the caller that owns the region.
 *
 * The region this is given is already `#community-navigation` - tree.js creates it - so this
 * fills it rather than nesting a second element with the same id inside it, which is what
 * made every surface carry two `community-navigation` ids and failed the accessible-name
 * check on all forty of them.
 */
export function renderCommunities(region, servers, activePath) {
  const list = el('div', { class: 'rail-group', 'aria-label': 'Communities' }, [
    ...(servers || []).map((c) => communityChip(c.name, {
      active: activePath === '/servers/' + c.id,
      server: c,
    })),
  ]);
  region.replaceChildren(list);
  return region;
}
