import { compose } from './compose.js';
import { labelFor } from '../badges.js';
import { el, clear, qs, toast, relTime, confirmDialog, openModal, openReportDialog, attachMenu, attachContextMenu, showUserCard, copyText, announce } from '../ui.js';
import { avatar, icon, navRow, serverChip, navGroup } from '../components.js';
import State, { isAuthed, currentServerId, can, peerPresence, refreshServers, leaveServerContext, clearSession, refreshDms, refreshFriends, refreshNotifications, mustVerifyToPost, refreshServerView } from '../state.js';
import { navigate, route } from '../nav.js';
import { matchRoute, railPages, mobilePages } from '../pages/registry.js';

// The phone tab bar, and whether it is showing.

import { setShell, shellState } from './compose.js';

export function isTabBarHidden() {
  return !shellState().tabsVisible;
}

export function setTabBarHidden(hidden) {
  setShell({ tabsVisible: !hidden });
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
  const here = compose().route;
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
    route: page.route,
  }));
  const strip = el('div', { class: 'mobile-tab-navigation__strip' });
  for (const t of tabs) {
    const active = here === t.route || here.startsWith(t.route + '/');
    const btn = el('button', {
      type: 'button', class: 'tab-button' + (active ? ' active' : ''),
      'aria-current': active ? 'page' : null,
      onClick: () => { navigate(route(t.route)); },
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
