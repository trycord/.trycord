// The account settings studio.
//
// Seven addresses, one dispatcher: profile, security, privacy, notifications,
// appearance, the connection, and the build. Each page is a small module of its
// own; this file is the switchboard, so the registry binds once and the pages
// stay readable. Around every page the dispatcher draws one thing the pages
// used to hide: the studio's own rail, so where the reader can go is visible.

import { profileView } from './settingsAccount.js';
import { securityView } from './settingsSecurity.js';
import { privacyView } from './settingsSafety.js';
import { notificationsView } from './settingsNotices.js';
import { appearanceView, backendView, updatesView } from './settingsClient.js';
import { languageView } from './settingsLanguage.js';
import { encryptionView } from './encryption.js';
import { scopeNav } from '../../packages/registry.js';
import { icon } from '../../packages/icons.js';
import { el } from '../../packages/dom.js';
import { path } from '../../packages/nav.js';

const LAYOUTS = new Map([
  ['settings', () => profileView()],
  ['settings.security', () => securityView()],
  ['settings.privacy', () => privacyView()],
  ['settings.notifications', () => notificationsView()],
  ['settings.encryption', () => encryptionView()],
  ['settings.appearance', () => appearanceView()],
  ['settings.language', () => languageView()],
  ['settings.backend', () => backendView()],
  ['settings.updates', () => updatesView()],
]);

// The rail is read straight from the registry: labels, icons, groups and
// addresses stay declared once, in one place.
function studioRail(scope, activeId, heading) {
  const rail = el('nav', { class: 'studionav', 'aria-label': heading });
  for (const group of scopeNav(scope)) {
    rail.appendChild(el('p', { class: 'studionav-group' }, group.group));
    for (const item of group.items) {
      rail.appendChild(el('a', {
        class: 'studionav-link' + (item.id === activeId ? ' studionav-link--active' : ''),
        href: path(item.route),
        'aria-current': item.id === activeId ? 'page' : null,
      },
      icon(item.icon || 'circle-dot', { size: 16 }),
      el('span', { class: 'studionav-label' }, item.label)));
    }
  }
  return rail;
}

export function renderSettings(ctx) {
  const view = LAYOUTS.get(ctx.page.id);
  if (!view) {
    // Not a page this studio owns - the registry should not route here, but a
    // wrong link deserves an honest surface rather than a crash.
    return null;
  }
  // Each page keeps its own lifecycle contract ({ node, onMount, cleanup }) -
  // the rail is drawn around whatever the page is, never instead of it.
  const page = view();
  const node = page && page.node ? page.node : page;
  const framed = el('div', { class: 'studio' },
    studioRail('account', ctx.page.id, 'Settings sections'),
    el('div', { class: 'studio-stage' }, node));
  if (page && page.node) {
    return { node: framed, onMount: page.onMount, cleanup: page.cleanup };
  }
  return framed;
}

export default { renderSettings };
