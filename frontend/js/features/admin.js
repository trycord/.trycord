// The instance administration.
//
// Twelve addresses, one dispatcher, three small modules behind it: the people
// and the moderation queue in adminSurfaces.js, the instance infrastrucure in
// adminInfra.js, and the configuration console - with the mail panel - in
// adminCfg.js. The registry binds once; the pages stay readable. Around every
// page the dispatcher draws the studio rail, so the twelve doors are visible
// from all of them.

import {
  adminOverview, adminPeople, adminCommunities, adminReports, adminAppeals,
  adminAudit, adminGdpr, adminApprovals,
} from './adminSurfaces.js';
import {
  adminAnnouncements, adminDatabase, adminContinuum, adminDiagnostics,
} from './adminInfra.js';
import { adminPageEditor } from './adminPages.js';
import { adminConfiguration } from './adminCfg.js';
import { scopeNav } from '../../packages/registry.js';
import { icon } from '../../packages/icons.js';
import { el } from '../../packages/dom.js';
import { path } from '../../packages/nav.js';

const LAYOUTS = new Map([
  ['admin', () => adminOverview()],
  ['admin.users', () => adminPeople()],
  ['admin.approvals', () => adminApprovals()],
  ['admin.communities', () => adminCommunities()],
  ['admin.reports', () => adminReports()],
  ['admin.appeals', () => adminAppeals()],
  ['admin.audit', () => adminAudit()],
  ['admin.gdpr', () => adminGdpr()],
  ['admin.announcements', () => adminAnnouncements()],
  ['admin.pages', () => adminPageEditor()],
  ['admin.settings', () => adminConfiguration()],
  ['admin.database', () => adminDatabase()],
  ['admin.continuum', () => adminContinuum()],
  ['admin.diagnostics', () => adminDiagnostics()],
]);

// Same rail as the settings studio, one scope over; the registry owns the
// labels and the grouping.
function studioRail(activeId, heading) {
  const rail = el('nav', { class: 'studionav', 'aria-label': heading });
  for (const group of scopeNav('admin')) {
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

export function renderAdmin(ctx) {
  const view = LAYOUTS.get(ctx.page.id);
  if (!view) return null;
  // The studio pages keep their own lifecycle ({ node, onMount, cleanup }); the
  // rail frames them without swallowing it.
  const page = view();
  const node = page && page.node ? page.node : page;
  const framed = el('div', { class: 'studio' },
    studioRail(ctx.page.id, 'Administration sections'),
    el('div', { class: 'studio-stage' }, node));
  if (page && page.node) {
    return { node: framed, onMount: page.onMount, cleanup: page.cleanup };
  }
  return framed;
}

export default { renderAdmin };
