// The admin console: the frame, and one renderer per section.
//
// Each section is a module under ./admin/. They were all in this file, which made a
// change to the GDPR queue a merge conflict with a change to the announcements banner and
// put eight unrelated lists on screen behind one import. They share almost nothing - the
// paint sequence number and the small parts in shared.js - so this cut along seams that
// already existed.
//
//   admin/shared.js         denied, loadError, the tiles and rows, the sequence number
//   admin/overview.js       platform health
//   admin/users.js          accounts and enforcement
//   admin/communities.js    communities and enforcement
//   admin/reports.js        reported content
//   admin/gdpr.js           erasure and access requests
//   admin/appeals.js        requests to undo a moderation decision
//   admin/audit.js          the administrative log
//   admin/announcements.js  banners shown to everyone
//
// Pages is not here: /admin/pages is its own route with its own module, and it takes its
// place in the nav from the same registry as every other section.
//
// Every section renders what the API returns and never fabricates a privilege. The
// isAdmin check below is a convenience for the reader; the server refuses the requests.

import Api from '../api.js';
import State from '../state.js';
import { el, clear } from '../ui.js';
import { loadingState } from '../view-states.js';
import { renderContextHeader } from '../shell.js';
import { settingsNav, settingsFrame, findItem } from '../settings-shell.js';
import { adminContext } from '../context-column.js';
import { sectionHead } from '../settings-ui.js';
import { denied, loadError, nextSeq, currentSeq } from './shared.js';
import { renderOverview } from './overview.js';
import { renderUsers } from './users.js';
import { renderCommunities } from './communities.js';
import { renderReports } from './reports.js';
import { renderGdpr } from './gdpr.js';
import { renderAppeals } from './appeals.js';
import { renderAudit } from './audit.js';
import { renderAnnouncements } from './announcements.js';

// Which section paints which module. A section with no entry falls through to the
// overview, so a stale bookmark lands somewhere rather than nowhere.
const SECTIONS = {
  overview: renderOverview,
  users: renderUsers,
  communities: renderCommunities,
  reports: renderReports,
  appeals: renderAppeals,
  gdpr: renderGdpr,
  audit: renderAudit,
  announcements: renderAnnouncements,
};

// Shared with the pages admin, which is a separate route and would otherwise have no way
// back to the rest of the console.
export function renderAdminNav(current) {
  return settingsNav({ scope: 'admin', active: current });
}

export async function renderAdmin(container, { section = 'overview' } = {}) {
  clear(container);
  renderContextHeader({ title: 'Admin', sub: 'Platform trust, safety, and enforcement' });

  // The section title is the pane's heading rather than a page-level h1, so the nav and
  // the content read as one surface instead of a title stacked above a nav stacked above
  // the content.
  const { frame, pane, context } = settingsFrame({
    scope: 'admin',
    active: section,
    contentClass: 'admin-page',
  });
  const body = pane;

  // Read from the registry entry rather than typed here, so the heading and the nav item
  // cannot drift apart.
  const item = findItem('admin', section);
  const heading = item ? sectionHead(item.label, item.blurb || '') : null;

  const wrap = el('div', { class: 'page admin' }, frame);
  container.appendChild(wrap);

  // isAdmin is server-computed on /me; refresh it here so a session started before the
  // reader was promoted can still reach the console.
  let me = State.me;
  if (!me || me.isAdmin !== true) {
    const fresh = await Api.me().catch(() => null);
    if (fresh) { State.me = fresh; me = fresh; }
  }
  // Kept on the denied path too: a moderator who lost admin access mid-session should
  // still be able to see which console they were in.
  if (!me || me.isAdmin !== true) {
    if (heading) body.appendChild(heading);
    body.appendChild(denied());
    return;
  }

  const seq = nextSeq();
  // Re-attached on every paint. The pane is emptied each time a section renders itself
  // into it, so a heading appended once would survive only until the first thing drawn.
  const show = (node) => {
    if (seq !== currentSeq()) return;
    clear(body);
    if (heading) body.appendChild(heading);
    body.appendChild(node);
  };
  const sec = el('div', { class: 'admin-block' });
  const showSec = (node) => { if (seq === currentSeq()) { clear(sec); sec.appendChild(node); } };
  show(sec);
  sec.appendChild(loadingState('Loading'));

  try {
    const paint = SECTIONS[section] || renderOverview;
    await paint(sec, showSec, seq);
    await fillAdminContext(context, section);
  } catch (ex) {
    if (seq !== currentSeq()) return;
    clear(body);
    if (heading) body.appendChild(heading);
    if (ex && (ex.code === 'PERMISSION_DENIED' || ex.code === 'AUTH_REQUIRED')) body.appendChild(denied());
    else body.appendChild(loadError(ex, () => { clear(container); renderAdmin(container, { section }); }));
  }
}

// Painted after the section so the column reads the same instance the list does. A
// failure here must not take the console down with it.
async function fillAdminContext(host, section) {
  if (!host) return;
  try {
    const nodes = await adminContext(section);
    for (const n of nodes) host.appendChild(n);
    if (nodes.length) host.closest('.settings-layout').dataset.hasContext = 'yes';
  } catch { /* a summary is a convenience, never a dependency */ }
}

export default { renderAdmin, renderAdminNav };