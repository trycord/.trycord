// Page id -> what to run.
//
// Split from registry.js on purpose. The registry holds identity, routes, layout
// and navigation labels; it imports nothing but itself. If the renderers lived
// there, every navigation consumer - the rail, the sidebar, the settings nav, the
// phone tab bar - would pull in all nineteen page modules to read a string, and
// those modules import the shell, which reads the registry. That is a cycle, and
// the kind that works until someone reorders an import.
//
// So: registry.js says what a page *is*. This file says what it *does*.
//
// No page calls renderAllChrome(). lifecycle.js paints the chrome after the
// handler returns, because a surface that forgets to is indistinguishable from one
// that has no members panel.

import Api from '../api.js';
import { refreshServers } from '../state.js';
import { el, clear, toast } from '../ui.js';
import { navigate } from '../nav.js';
import { serverPath } from '../links.js';
import { renderContextHeader } from '../shell.js';
import PagesPublic from '../public/public.js';
import { renderAccount } from '../account/account.js';
import { renderAdmin } from '../admin/admin.js';
import { renderAdminPages } from '../admin/pages.js';
import { renderBrowse } from '../discovery/browse.js';
import { renderChannel, renderChannelPins } from '../community/conversation.js';
import { renderInvites } from '../community/invites.js';
import { renderMenu, renderNewServer, renderServerLanding } from '../community/community.js';
import { renderMyAppeals, renderNewAppeal, renderSupport } from '../support/support.js';
import { renderNotifications } from '../global/notifications.js';
import { renderProfile } from '../profile/profile.js';
import { renderServerRoles } from '../community/roles.js';
import { renderServerSettings } from '../community/settings.js';
import { renderServerMembers } from '../community/members.js';
import { renderNewChannel, renderServerCategories } from '../community/channels.js';
import { renderHome } from '../global/home.js';
import HelloDms from '../messages/dms.js';
import { resolveCommunity, resolveChannelToken, renderRouteError } from '../resolve.js';

// The community tree. The registry knows these addresses; this resolves the slug
// to an id, republishes the route in the shape the chrome matches on, and picks
// the sub-page. It used to be a branch of the route table and before that a
// sixty-case if-chain - it is the one place where routing and rendering genuinely
// cannot be separated, because a channel's id is only known after a lookup.
async function community(ctx) {
  const { region, parts, query, publishRoute, onCleanup } = ctx;
  const what = parts[2];
  const sub = parts[3];

  let serverId = parts[1];
  let rest = parts.slice(2);

  // /c/:slug carries a slug; the legacy /server/:id carries an id.
  if (parts[0] === 'c') {
    const found = await resolveCommunity(parts[1]);
    if (!found) return renderRouteError(region, 'That community does not exist.');
    serverId = found.serverId;
    // Before anything paints. The chrome matches /server/:id/... and knows nothing
    // about slugs, so without this the community is not recognised as one and the
    // reader gets the default sidebar instead of their own channels.
    publishRoute(['/server', serverId].concat(rest).join('/'));
  }
  if (!serverId) return renderRouteError(region, 'That community does not exist.');

  if (what === 'channel' && sub) {
    const resolved = await resolveChannelToken(serverId, sub);
    if (!resolved) return renderRouteError(region, 'That channel does not exist.');
    // Same reason, one level deeper: the sidebar marks the current channel by
    // comparing against the id-shaped route.
    publishRoute(['/server', serverId, 'channel', resolved, ...parts.slice(4)].join('/'));

    const stop = () => { try { region._cleanup && region._cleanup(); } catch { /* gone already */ } };
    onCleanup(stop);

    if (parts[4] === 'pins') await renderChannelPins(region, serverId, resolved);
    else await renderChannel(region, serverId, resolved, { focusMessage: query.m || null });
    return;
  }

  const subroutes = {
    channels: () => renderNewChannel(region, serverId),
    invites: () => renderInvites(region, serverId),
    members: () => renderServerMembers(region, serverId),
    roles: () => renderServerRoles(region, serverId),
    categories: () => renderServerCategories(region, serverId),
  };
  if (subroutes[what]) return subroutes[what]();

  if (what === 'settings') {
    // Members, Roles, Invites and Categories have their own pages and the settings
    // nav points at them. A deep link or an old bookmark to /settings/<one of them>
    // used to render a card explaining where the section had moved, and when that
    // card went away it would have rendered nothing at all. Redirect instead, so
    // the address and the nav item agree.
    const elsewhere = { members: 1, roles: 1, invites: 1, categories: 1, channels: 1 };
    if (sub && elsewhere[sub]) {
      navigate('/server/' + encodeURIComponent(serverId) + '/' + sub);
      return false;
    }
    return renderServerSettings(region, serverId, sub || 'overview');
  }

  return renderServerLanding(region, serverId);
}

// /invite/:code is a page that navigates rather than renders, which is why the
// handler returns false: lifecycle skips the chrome repaint for a redirect.
async function invite(ctx) {
  const { region, parts } = ctx;
  const code = parts[1];
  renderContextHeader({ title: 'Joining', sub: code });
  clear(region);
  region.appendChild(el('div', { class: 'empty-state' }, 'Joining…'));
  try {
    const res = await Api.joinInvite(code);
    await refreshServers();
    toast('You joined the community.', 'ok');
    navigate(serverPath(res.serverId));
    return false;
  } catch (ex) {
    clear(region);
    region.appendChild(el('div', { class: 'form-error' }, ex.message || 'Invite invalid'));
    return true;
  }
}

export const HANDLERS = {
  home: (ctx) => renderHome(ctx.region),

  dms: async (ctx, page) => {
    // Leaving is a teardown, not a detail of the page: the socket room and the
    // draft have to go whether we arrived from a conversation or from the list.
    ctx.onCleanup(() => HelloDms.leaveDm());
    await HelloDms.renderDms(ctx.region, { id: ctx.params.id || null });
  },
  'dms.conversation': (ctx) => HANDLERS.dms(ctx),

  notifications: (ctx) => renderNotifications(ctx.region),
  discover: (ctx) => renderBrowse(ctx.region, { previewId: ctx.params.id || null }),
  friends: (ctx) => HelloDms.renderFriendsPage(ctx.region),
  menu: (ctx) => renderMenu(ctx.region),

  community,
  'community.legacy': community,
  'community.channel': community,
  'community.channelPins': community,
  'community.members': community,
  'community.roles': community,
  'community.invites': community,
  'community.categories': community,
  'community.settings': community,

  settings: (ctx) => renderAccount(ctx.region, { tab: 'profile' }),
  'settings.security': (ctx) => renderAccount(ctx.region, { tab: 'security' }),
  'settings.privacy': (ctx) => renderAccount(ctx.region, { tab: 'privacy' }),
  'settings.notifications': (ctx) => renderAccount(ctx.region, { tab: 'notifications' }),
  'settings.appearance': (ctx) => renderAccount(ctx.region, { tab: 'appearance' }),
  'settings.backend': (ctx) => renderAccount(ctx.region, { tab: 'backend' }),
  'settings.updates': (ctx) => renderAccount(ctx.region, { tab: 'updates' }),

  admin: (ctx) => renderAdmin(ctx.region, { section: 'overview' }),
  'admin.users': (ctx) => renderAdmin(ctx.region, { section: 'users' }),
  'admin.communities': (ctx) => renderAdmin(ctx.region, { section: 'communities' }),
  'admin.reports': (ctx) => renderAdmin(ctx.region, { section: 'reports' }),
  'admin.appeals': (ctx) => renderAdmin(ctx.region, { section: 'appeals' }),
  'admin.audit': (ctx) => renderAdmin(ctx.region, { section: 'audit' }),
  'admin.announcements': (ctx) => renderAdmin(ctx.region, { section: 'announcements' }),
  'admin.pages': (ctx) => renderAdminPages(ctx.region, { route: ctx.rest[0] || null }),
  'admin.gdpr': (ctx) => renderAdmin(ctx.region, { section: 'gdpr' }),

  profile: (ctx) => renderProfile(ctx.region, { id: ctx.params.id }),
  'community.new': (ctx) => renderNewServer(ctx.region),

  support: (ctx) => renderSupport(ctx.region),
  'support.appeals': (ctx) => renderMyAppeals(ctx.region),
  'support.newAppeal': (ctx) => renderNewAppeal(ctx.region),
  legal: (ctx) => PagesPublic.legal(ctx.region, ctx.params.doc),

  invite,
  login: (ctx) => { renderContextHeader({}); PagesPublic.login(ctx.region); },
  register: (ctx) => PagesPublic.register(ctx.region),
  forgot: (ctx) => PagesPublic.forgot(ctx.region),
  resetPassword: (ctx) => PagesPublic.resetPassword(ctx.region, ctx.params.token),
  verifyEmail: (ctx) => PagesPublic.verify(ctx.region, ctx.params.token),
};

export default { HANDLERS };
