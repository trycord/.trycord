// The community settings surface: overview, appearance, structure, members,
// roles, invites, moderation, plus the ownership-transfer and danger-zone
// controls.
import Api from '../api.js';
import { SECTIONS } from './settings-sections.js';
import State from '../state.js';

import { can, leaveServerContext, peerPresence, refreshServers, setViewRefresh } from '../state.js';
import { clear, confirmDialog, el, relTime, toast } from '../ui.js';
import { communityMark, invalidateAuthedImage, loadAuthedImage } from '../components.js';
import { onStale } from '../view-states.js';
import { renderContextHeader } from '../shell.js';
import { ensureServer, reloadServer } from '../workspace-shared.js';
import { serverPath } from '../links.js';
import { settingsFrame, findItem } from '../settings-shell.js';
import { scopeHasTab } from '../pages/registry.js';
import { contextBlock as block, contextFact as fact, contextList as list, contextPara as para } from '../context-column.js';
import { renderIntegrations } from './integrations.js';
import { renderAnalytics } from './analytics.js';
import { navigate, route } from '../nav.js';;

// Community sections are addressed relative to the current community, so the
// href is resolved rather than stored - a stored path would go stale the moment
// a community is renamed or the URL slug changes.
//
// Four of them are the exception, and it is the same exception each time: the
// section already has a full page of its own, so the nav goes there. Members,
// Roles, Invites and Categories were being pointed at settings/<section>, which
// renders a card with a paragraph and a button - so reaching the member roster or
// the role hierarchy cost a click through a dead end that explained what you were
// about to see instead of showing it. One authoritative surface per section means
// the teaser is not a thing the reader can get to at all.
export const COMMUNITY_SECTION_ROUTE = {
  categories: (serverId) => serverPath(serverId, 'categories'),
  members: (serverId) => serverPath(serverId, 'members'),
  roles: (serverId) => serverPath(serverId, 'roles'),
  invites: (serverId) => serverPath(serverId, 'invites'),
};

function resolveCommunityHref(serverId, id) {
  if (COMMUNITY_SECTION_ROUTE[id]) return COMMUNITY_SECTION_ROUTE[id](serverId);
  return serverPath(serverId, 'settings', id === 'overview' ? '' : id);
}

// Kept across range changes so the picker does not spring back to 30 days when
// the section is re-rendered for any other reason.
let analyticsDays = 30;

async function renderServerSettings(container, serverId, section = 'overview') {
  clear(container);
  let server;
  try { ({ detail: server } = await ensureServer(serverId)); }
  catch (ex) { container.appendChild(el('div', { class: 'form-error' }, ex.message || 'Cannot open this community')); return; }
  if (!can('MANAGE_SERVER')) {
    renderContextHeader({ title: 'Settings', sub: server.name });
    container.appendChild(el('div', { class: 'form-error' },
      "You need permission to manage this community's settings."));
    return;
  }
  // An unknown section is not an error, it is the overview: a stale bookmark to a
  // section that no longer exists should land somewhere rather than nowhere.
  if (!scopeHasTab('community', section)) section = 'overview';
  const item = findItem('community', section);
  renderContextHeader({ title: 'Settings', sub: item && item.blurb ? item.blurb : server.name });

  const { frame, pane, context } = settingsFrame({
    scope: 'community',
    active: section,
    resolve: (id) => resolveCommunityHref(serverId, id),
    contentClass: 'settings-body',
  });
  // Not 'roles-page', which this picked up when it was copied out of the roles
  // page: that class restates .page and differs only in a gap, which cannot
  // apply to a wrapper holding a single frame.
  const wrap = el('div', { class: 'page' }, frame);
  const panel = pane;
  container.appendChild(wrap);

  // Painted here rather than at the end: every section below finishes with an
  // early return, so a call after them would only run for the one that falls
  // through. The counts come from the same values the pane is built from, so
  // there is no second request and nothing to wait for.
  paintCommunityContext(context, section, server, {
    members: (State.members || []).length,
    channels: ((State.channels && State.channels.channels) || []).length,
    roles: (State.roles || []).length,
  });

  // Force: the settings were just changed, which is also what decides permissions.
  const reload = async () => { await reloadServer(serverId); };
  setViewRefresh(() => { reload().catch(onStale('This page')); });

  const memberCount = (State.members || []).length;
  const channelCount = ((State.channels && State.channels.channels) || []).length;
  const categoryCount = ((State.channels && State.channels.categories) || []).length;
  const roleCount = (State.roles || []).length;
  const onlineCount = (State.members || []).filter((m) => peerPresence(m.user_id || m.id) === 'online').length;

  const ctx = { panel, reload, server, serverId, counts: {
    memberCount, channelCount, categoryCount, roleCount, onlineCount,
  } };
  // A section that is not in the map is a section that does not exist; the overview
  // is the honest answer, and it is where the old trailing `else` went.
  (SECTIONS[section] || SECTIONS.overview)(ctx);

}

/**
 * The community settings column.
 *
 * This community's shape, read from the values the pane was already built from,
 * plus what the section governs. No fetch: otherwise these would be a third copy
 * of counts the server has already sent twice.
 */
function paintCommunityContext(host, section, server, counts) {
  if (!host || !server) return;
  const out = [block('This community', list(
    fact('Members', String(counts.members)),
    fact('Channels', String(counts.channels)),
    fact('Roles', String(counts.roles)),
  ))];
  const NOTES = {
    overview: 'These counts move when you change anything on the left.',
    structure: 'Deleting a channel removes its messages with it. A category is only an ordering; moving one does not move its channels anywhere.',
    members: 'A role grants exactly what its permissions say. Holding several roles does not add their permissions together beyond what each grants.',
    roles: 'An override on a channel or category beats the role list for that place only.',
    invites: 'An invite is single-use and expires. Revoking one stops it being used again but does not undo it for anyone who already accepted.',
    moderation: 'A timeout lifts itself when it expires. A ban does not, and only an administrator can lift it.',
    ownership: 'Transferring ownership is immediate and cannot be undone from here.',
    appearance: 'Appearance is per member. Nobody else sees the theme you choose.',
  };
  const note = NOTES[section];
  if (note) out.push(block('About this section', para(note)));
  for (const n of out) host.appendChild(n);
  host.closest('.settings-layout').dataset.hasContext = 'yes';
}

export { renderServerSettings };
