import { compose } from './compose.js';
import { labelFor } from '../badges.js';
import { el, clear, qs, toast, relTime, confirmDialog, openModal, openReportDialog, attachMenu, attachContextMenu, showUserCard, copyText, announce } from '../ui.js';
import { avatar, icon, navRow, serverChip, navGroup } from '../components.js';
import State, { isAuthed, currentServerId, can, peerPresence, refreshServers, leaveServerContext, clearSession, refreshDms, refreshFriends, refreshNotifications, mustVerifyToPost, refreshServerView } from '../state.js';
import { navigate, route } from '../nav.js';
import { matchRoute, railPages, mobilePages } from '../pages/registry.js';

export function renderMobileTabs(region) {
  clear(region);
  if (!isAuthed()) return;
  const here = compose().route;

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
      type: 'button', class: 'tab-button',
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

  region.appendChild(strip);
}
