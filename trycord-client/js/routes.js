// The route table.
//
// Dispatch used to be a ~60-branch if-chain: the shape of the application was
// written as control flow, in one function, in the order somebody happened to
// append things. That has three costs. The order is load-bearing and invisible -
// moving a branch can silently change what a URL means. A route cannot be read
// without reading all of its neighbours, so nothing can be checked without
// running the whole app. And adding a route means finding the right place in a
// wall of `startsWith` calls, which is how /settings/* and /account/* ended up
// maintained as two hand-synced parallel lists of the same nine sections.
//
// So routes are data. A row is a prefix and what to do with it; matching is
// longest-prefix-wins, which makes the order of the table a presentation
// detail rather than a correctness one. The renderer and the sidebar get the
// same answer from the same row, so a surface can no longer be added to one and
// forgotten in the other.

import PagesPublic from './pages-public.js';
import { renderAccount } from './pages-account.js';
import { renderAdmin } from './pages-admin.js';
import { renderAdminPages } from './pages-admin-pages.js';
import { renderBrowse } from './pages-browse.js';
import { renderChannel, renderChannelPins } from './pages-conversation.js';
import { renderInvites } from './pages-invites.js';
import { renderMenu, renderNewServer, renderServerLanding } from './pages-community.js';
import { renderMyAppeals, renderNewAppeal, renderSupport } from './pages-support.js';
import { renderNotifications } from './pages-notifications.js';
import { renderProfile } from './pages-profile.js';
import { renderServerRoles } from './pages-roles.js';
import { renderServerSettings } from './pages-settings.js';
import { SETTINGS_IA } from './settings-shell.js';
import { renderServerMembers } from './pages-members.js';
import { renderNewChannel, renderServerCategories } from './pages-channels.js';
import { renderHome } from './pages-home.js';
import HelloDms from './pages-dms.js';
import { renderContextHeader, renderAllChrome } from './shell.js';
import { navigate } from './nav.js';
import { serverPath } from './links.js';
import Api from './api.js';
import { el, clear, toast } from './ui.js';
import { refreshServers } from './state.js';
import {
  setCleanup, resolveCommunity, resolveChannelToken, renderRouteError,
} from './resolve.js';

/**
 * A row.
 *
 *   prefix    matched against the route path, longest prefix wins
 *   auth      'public' | 'session' | 'guest'  - who may be here
 *   guestTo   where an authenticated reader is sent when auth is 'guest'
 *   run       the work. Receives { region, path, parts, query } and may return
 *             a path to redirect to instead of rendering
 *
 * `run` is responsible for calling renderAllChrome() when it rendered something.
 * That is deliberate: the chrome differs per surface (a member panel only in a
 * community) and a caller that forgot it is visible immediately.
 */

// Settings and the account tree are the same surface under two names. The legacy
// /account/* URLs predate the V2 /settings/* ones and still exist in the wild, so
// both are listed and both point at the same section. One list, generated, rather
// than two maintained by hand.
const SETTINGS_SECTIONS = [
  ['updates', 'updates'],
  ['appearance', 'appearance'],
  ['password', 'security'],
  ['sessions', 'security'],
  ['security', 'security'],
  ['backend', 'backend'],
  ['privacy', 'privacy'],
  ['notifications', 'notifications'],
];

const settingsRow = (root) => SETTINGS_SECTIONS.map(([slug, tab]) => ({
  prefix: `/${root}/${slug}`,
  auth: 'session',
  run: async ({ region }) => { await renderAccount(region, { tab }); renderAllChrome(); },
}));

const settingsIndexRow = (root) => ({
  prefix: `/${root}`,
  auth: 'session',
  run: async ({ region }) => { await renderAccount(region, { tab: 'profile' }); renderAllChrome(); },
});

// Community sub-routes. The key is the third segment, matched exactly, because
// these are nouns rather than nested paths: /server/:id/members is not a child
// of anything.
const COMMUNITY_SUBROUTES = {
  channels: async ({ region, serverId }) => { await renderNewChannel(region, serverId); },
  invites: async ({ region, serverId }) => { await renderInvites(region, serverId); },
  members: async ({ region, serverId }) => { await renderServerMembers(region, serverId); },
  roles: async ({ region, serverId }) => { await renderServerRoles(region, serverId); },
  categories: async ({ region, serverId }) => { await renderServerCategories(region, serverId); },
};

// Derived from the settings information architecture rather than written out
// again. A second hand-kept list is exactly how /settings/categories ended up
// working in the sidebar and silently rendering Overview in the router, and the
// same would happen to the next section added - it would appear in the nav, look
// correct, and open the wrong page.
const COMMUNITY_SETTINGS_SECTIONS = new Set(
  SETTINGS_IA.community.flatMap((g) => g.items).map((i) => i.id)
);

// Takes the context object whole, the way every other row does. Rows are called
// as run(ctx) with the context as the single argument, so a row that also
// declared a leading region parameter would destructure the context as though it
// were the region and fail on the first property.
async function renderCommunity({ region, parts, query, publishRoute }) {
  // A V2 /c/:slug route carries a slug; a legacy /server/:id carries an id.
  // Resolution goes through the server-scoped API, so a channel token is always
  // resolved inside its own community and can never reach another one's channel.
  let serverId = parts[1];
  let rest = parts.slice(2);
  if (parts[0] === 'c') {
    const community = await resolveCommunity(parts[1]);
    if (!community) return renderRouteError(region, 'That community does not exist.');
    serverId = community.serverId;
    // Republish in the resolved shape before anything paints. The chrome matches
    // on /server/:id/... and knows nothing about slugs, so without this the
    // community's own sidebar is not recognised as a community at all and the
    // reader gets the default one.
    publishRoute(['/server', serverId].concat(rest).join('/'));
  }
  if (!serverId) return renderRouteError(region, 'That community does not exist.');

  const what = rest[0];
  const what4 = rest[1];

  if (what === 'channel' && rest[1]) {
    const token = rest[1];
    const resolved = await resolveChannelToken(serverId, token);
    if (!resolved) return renderRouteError(region, 'That channel does not exist.');

    // Republished with the channel's real id for the same reason: the sidebar
    // marks the current channel by comparing against the id-shaped route.
    publishRoute(['/server', serverId, 'channel', resolved, ...rest.slice(2)].join('/'));

    if (what4 === 'pins') {
      setCleanup(() => { try { region._cleanup && region._cleanup(); } catch { /* ignore */ } });
      await renderChannelPins(region, serverId, resolved);
      renderAllChrome();
      return;
    }
    setCleanup(() => { try { region._cleanup && region._cleanup(); } catch { /* ignore */ } });
    await renderChannel(region, serverId, resolved, { focusMessage: query.m || null });
    renderAllChrome();
    return;
  }

  const sub = COMMUNITY_SUBROUTES[what];
  if (sub) {
    await sub({ region, serverId });
    renderAllChrome();
    return;
  }

  if (what === 'settings') {
    const section = what4 && COMMUNITY_SETTINGS_SECTIONS.has(what4) ? what4 : 'overview';
    await renderServerSettings(region, serverId, section);
    renderAllChrome();
    return;
  }

  await renderServerLanding(region, serverId);
  renderAllChrome();
}

export const ROUTES = [
  // ---- public: reachable without a session, and an authenticated reader is
  // sent on rather than shown a login form they do not need.
  {
    prefix: '/login', auth: 'guest', guestTo: '/home',
    run: async ({ region }) => {
      renderContextHeader({});
      PagesPublic.login(region);
      renderAllChrome();
    },
  },
  {
    prefix: '/register', auth: 'guest', guestTo: '/home',
    run: async ({ region }) => { PagesPublic.register(region); renderAllChrome(); },
  },
  {
    prefix: '/forgot', auth: 'guest', guestTo: '/home',
    run: async ({ region }) => { PagesPublic.forgot(region); renderAllChrome(); },
  },
  {
    prefix: '/reset-password/', auth: 'guest', guestTo: '/home',
    run: async ({ region, parts }) => { PagesPublic.resetPassword(region, parts[1]); renderAllChrome(); },
  },
  {
    prefix: '/verify-email/', auth: 'public',
    run: async ({ region, parts }) => { PagesPublic.verify(region, parts[1]); renderAllChrome(); },
  },
  {
    prefix: '/legal/', auth: 'public',
    run: async ({ region, parts }) => { PagesPublic.legal(region, parts[1]); renderAllChrome(); },
  },
  {
    prefix: '/discover', auth: 'public',
    run: async ({ region, parts }) => { await renderBrowse(region, { previewId: parts[1] || null }); renderAllChrome(); },
  },
  {
    prefix: '/support/appeals/new', auth: 'public',
    run: async ({ region }) => { renderNewAppeal(region); renderAllChrome(); },
  },
  {
    prefix: '/support/appeals', auth: 'session',
    run: async ({ region }) => { await renderMyAppeals(region); renderAllChrome(); },
  },
  {
    prefix: '/support', auth: 'public',
    run: async ({ region }) => { await renderSupport(region); renderAllChrome(); },
  },

  // ---- session required
  ...settingsRow('settings'),
  settingsIndexRow('settings'),
  ...settingsRow('account'),
  settingsIndexRow('account'),

  {
    prefix: '/admin/pages', auth: 'session',
    run: async ({ region, parts }) => { await renderAdminPages(region, { route: parts[2] || null }); renderAllChrome(); },
  },
  {
    prefix: '/admin/', auth: 'session',
    run: async ({ region, parts }) => {
      // 'servers' is the old name for the communities section.
      const section = parts[1] === 'servers' ? 'communities' : (parts[1] || 'overview');
      await renderAdmin(region, { section });
      renderAllChrome();
    },
  },
  { prefix: '/admin', auth: 'session', run: async ({ region }) => { await renderAdmin(region, { section: 'overview' }); renderAllChrome(); } },

  {
    prefix: '/invite/', auth: 'session',
    run: async ({ region, parts }) => {
      const code = parts[1];
      renderContextHeader({ title: 'Joining', sub: code });
      clear(region);
      region.appendChild(el('div', { class: 'empty-state' }, 'Joining…'));
      try {
        const res = await Api.joinInvite(code);
        await refreshServers();
        toast('You joined the community.', 'ok');
        navigate(serverPath(res.serverId));
      } catch (ex) {
        clear(region);
        region.appendChild(el('div', { class: 'form-error' }, ex.message || 'Invite invalid'));
        renderAllChrome();
      }
    },
  },

  { prefix: '/users/', auth: 'session', run: async ({ region, parts }) => { await renderProfile(region, { id: parts[1] }); renderAllChrome(); } },
  { prefix: '/servers/new', auth: 'session', run: async ({ region }) => { await renderNewServer(region); renderAllChrome(); } },

  { prefix: '/friends', auth: 'session', run: async ({ region }) => { setCleanup(() => { HelloDms.leaveDm(); }); await HelloDms.renderFriendsPage(region); renderAllChrome(); } },
  { prefix: '/dms/', auth: 'session', run: async ({ region, parts }) => { setCleanup(() => { HelloDms.leaveDm(); }); await HelloDms.renderDms(region, { id: parts[1] }); renderAllChrome(); } },
  { prefix: '/dms', auth: 'session', run: async ({ region }) => { setCleanup(() => { HelloDms.leaveDm(); }); await HelloDms.renderDms(region, {}); renderAllChrome(); } },
  { prefix: '/notifications', auth: 'session', run: async ({ region }) => { await renderNotifications(region); renderAllChrome(); } },
  { prefix: '/menu', auth: 'session', run: async ({ region }) => { await renderMenu(region); renderAllChrome(); } },

  // The community tree, matched last so that /c and /server can be the two
  // spellings of one surface rather than two branches.
  { prefix: '/c/', auth: 'session', community: true, run: renderCommunity },
  { prefix: '/server/', auth: 'session', community: true, run: renderCommunity },
];

/** The home surface, which is where an unknown path lands. */
export const HOME_ROUTE = {
  prefix: '/', auth: 'session',
  run: async ({ region }) => { await renderHome(region); renderAllChrome(); },
};

/**
 * The row for a path, or null.
 *
 * Longest prefix wins, so the table's order carries no meaning. A prefix ending
 * in a slash matches on segment boundaries only, which is what stops /dms from
 * swallowing /dmsomething.
 */
export function matchRoute(path) {
  let best = null;
  let bestLength = -1;
  for (const row of ROUTES) {
    if (!matches(row.prefix, path)) continue;
    if (row.prefix.length <= bestLength) continue;
    best = row;
    bestLength = row.prefix.length;
  }
  return best;
}

function matches(prefix, path) {
  if (prefix === '/') return true;
  // A prefix ending in a slash means "this segment and something under it". The
  // bare segment itself is a different route - /dms and /dms/abc are two rows -
  // so it must not match here, or the longer prefix wins for the shorter path and
  // /dms silently takes the id-carrying row.
  if (prefix.endsWith('/')) {
    return path.length > prefix.length && path.startsWith(prefix);
  }
  return path === prefix || path.startsWith(prefix + '/');
}

export default { ROUTES, HOME_ROUTE, matchRoute };
