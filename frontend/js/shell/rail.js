// The application rail: the global navigation layer, and the one that answers
// "where am I in Trycord globally".
//
// It is deliberately not a second sidebar. What is inside the current community - its
// channels, its members - belongs to contextual navigation, and mixing the two is what
// makes a community look like just another destination in a list of global ones.
//
// Every destination drawn here comes from the page registry. This module used to carry
// its own DESTINITIONS table, which is how the rail came to offer a set of places that
// agreed with nothing else - Friends was a registry destination that was missing from
// it. And separately: renderRail() existed and nothing called it, so #global-navigation
// and #identity-region were empty elements on every page and the rail's only live
// content was the community list. One source of truth, and one caller.

import { el, icon, attachMenu } from '../ui.js';
import { navigate, route } from '../nav.js';
import State from '../state.js';
import { railPages } from '../pages/registry.js';
import { labelFor } from '../badges.js';
import { communityIconUrl, loadAuthedImage } from '../components/media.js';
import { confirmSignOut } from './sign-out.js';

/**
 * The rail's destinations, read from the registry.
 *
 * Reading them rather than restating them is the whole point: the rail, the phone tab
 * bar and the sidebar then cannot disagree about what exists, because they are all
 * reading the same list.
 */
function destinations() {
  return railPages().map((page) => ({
    id: page.id,
    label: page.nav.label,
    path: page.route,
    icon: page.nav.icon,
  }));
}

/**
 * Active when the reader is on a destination or inside it, so /dms/<id> keeps
 * Direct messages lit.
 */
function isActive(here, path) {
  if (!here || !path) return false;
  return here === path || here.startsWith(path + '/');
}

/**
 * One rail entry. Icon plus tooltip, both of which are read by assistive
 * technology: the glyph is decorative and the label carries the meaning, so an
 * icon-only rail is not an unnamed one.
 */
function railLink(dest, here) {
  const active = isActive(here, dest.path);
  const link = el('a', {
    class: 'rail-link' + (active ? ' is-active' : ''),
    href: route(dest.path),
    'aria-label': dest.label,
    'aria-current': active ? 'page' : null,
    title: dest.label,
    dataset: { nav: dest.id },
  });
  link.appendChild(el('span', { class: 'rail-link__icon', 'aria-hidden': 'true' },
    icon(dest.icon)));
  const badge = labelFor(dest.id);
  if (badge) {
    // Aria-hidden, because the label below already says the number out loud.
    link.appendChild(el('span', { class: 'rail-link__badge', 'aria-hidden': 'true' }, badge));
    link.setAttribute('aria-label', dest.label + ', ' + badge + ' waiting');
  }
  return link;
}

/**
 * A community in the rail. The mark is the community's own colour and image, and
 * the name under it is the point - a column of glyphs to be memorised is not a
 * navigation.
 */
function communityChip(server, { active = false } = {}) {
  const name = (server && server.name) || 'Community';
  const chip = el('a', {
    class: 'rail-community' + (active ? ' is-active' : ''),
    href: route('/servers/' + String(server && server.id ? server.id : '')),
    'aria-current': active ? 'page' : null,
    title: name + (server && server.is_owner ? ' — you own this community' : ''),
    dataset: { serverId: server && server.id },
  });

  const mark = el('span', { class: 'rail-mark', 'aria-hidden': 'true' });
  const src = communityIconUrl(server);
  if (src) {
    // Falls back to the coloured mark rather than to an empty box, which is what a
    // bare <img> with no bytes would leave behind. `.rail-community img` sizes it.
    loadAuthedImage(src).then((url) => {
      if (!url || !mark.isConnected) return;
      mark.classList.add('has-img');
      mark.appendChild(el('img', { src: url, alt: '', loading: 'lazy' }));
    }).catch(() => { /* the mark stays as it is; that is what it is for */ });
  }
  chip.appendChild(mark);
  chip.appendChild(el('span', { class: 'rail-community__name' }, name));
  return chip;
}

/**
 * The Trycord mark, at the head of the rail. The way back to the start from
 * anywhere, and the only thing up here that says which product this is.
 */
function trycordMark() {
  const brand = el('a', {
    class: 'rail-mark-btn',
    href: route('/home'),
    title: 'Trycord home',
    'aria-label': 'Trycord home',
  });
  const img = el('img', {
    class: 'rail-mark-btn__img',
    src: './assets/trycord-assets/brand/trycord-symbol.svg',
    alt: '',
    loading: 'lazy',
  });
  img.addEventListener('error', () => {
    // The mark is the one thing that has to be there even when the asset is not.
    brand.replaceChildren(el('span', { class: 'rail-mark', 'aria-hidden': 'true' }, 'T'));
  });
  brand.appendChild(img);
  return brand;
}

/**
 * The account control, at the foot of the rail.
 *
 * A button, not a link: it opens a menu rather than going anywhere. The signed-out
 * form is a sign-in link, because "your account" is meaningless before there is one.
 */
function accountControl() {
  const me = State.me;
  if (!me) {
    return el('a', {
      class: 'rail-foot-btn',
      href: route('/login'),
      title: 'Sign in',
      'aria-label': 'Sign in',
      'data-nav': 'signin',
    }, el('span', { class: 'nv-icon', 'aria-hidden': 'true' }, icon('users')));
  }
  const name = me.displayName || me.username || 'You';
  const btn = el('button', {
    class: 'rail-foot-btn rail-account',
    type: 'button',
    title: name + ' — account',
    'aria-label': 'Your account and settings',
    dataset: { nav: 'account' },
  });
  attachMenu(btn, () => [
    { label: 'Your profile', onSelect: () => { navigate('/users/' + String(me.id)); } },
    { label: 'Settings', onSelect: () => { navigate('/settings'); } },
    { sep: true },
    {
      label: 'Copy your user ID', onSelect: async () => {
        try {
          await navigator.clipboard.writeText(String(me.id));
        } catch { /* a clipboard the page cannot reach is not worth a dialog */ }
      },
    },
    { sep: true },
    { label: 'Sign out', danger: true, onSelect: confirmSignOut },
  ]);
  btn.appendChild(el('span', { class: 'nv-icon', 'aria-hidden': 'true' }, icon('users')));
  return btn;
}

/**
 * Paint the rail: the mark, the global destinations, the communities and the
 * account control.
 *
 * One call, from shell.js's renderAllChrome(). `plan` is optional so a caller
 * that has already fetched the community list can hand it over instead of
 * paying for it twice.
 */
export function renderRail(plan = {}) {
  const rail = document.getElementById('app-rail');
  if (!rail) return null;

  const here = plan.route || '';
  const identity = document.getElementById('identity-region');
  if (identity) identity.replaceChildren(trycordMark());

  const global = document.getElementById('global-navigation');
  if (global) {
    global.replaceChildren(...destinations().map((d) => railLink(d, here)));
  }

  const communities = Array.isArray(plan.servers)
    ? plan.servers
    : (State.servers || []);
  const places = document.getElementById('community-navigation');
  if (places) {
    places.replaceChildren(
      el('p', { class: 'rail-section__label' }, 'Places'),
      ...communities.map((c) => communityChip(c, { active: here === '/servers/' + String(c.id) })),
      el('a', {
        class: 'rail-community rail-community--add',
        href: route('/discover'),
        title: 'Find a community',
        'aria-label': 'Find a community',
      }, el('span', { class: 'rail-community__name', 'aria-hidden': 'true' }, '+')),
    );
  }

  const foot = document.getElementById('rail-foot');
  if (foot) foot.replaceChildren(accountControl());

  return rail;
}

export default { renderRail };
