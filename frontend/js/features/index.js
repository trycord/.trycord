// The renderer table.
//
// One function per page id, kept apart from the registry so the registry can be
// read by the shell without importing every feature. main.js binds this before
// the router dispatches, and a page with no entry here is a page that cannot be
// opened - the router reports it as a fault rather than silently rendering
// nothing, so an unbuilt screen is loud, not invisible.

import { renderHome } from './home.js';
import { renderInbox } from './inbox.js';
import { renderMenu } from './everything.js';
import { renderAuth } from './auth.js';
import {
  renderSupport, renderLegal, renderInvite, renderServerCreate, renderNotFound,
} from './documents.js';
import { renderDms, renderDmConversation } from './dms.js';
import { renderFriends } from './friends.js';
import { renderDiscover } from './discover.js';
import { renderProfile } from './profile.js';
import { renderCommunity, renderChannelView, renderMembers, renderRoles, renderInvites, renderCategories } from './community.js';
import { renderSettings } from './settings.js';
import { renderAdmin } from './admin.js';

const gates = (ctx) => renderAuth(ctx.page, ctx.params);

export const RENDERERS = {
  home: () => renderHome(),
  notifications: () => renderInbox(),
  menu: () => renderMenu(),
  support: () => renderSupport(),
  legal: (ctx) => renderLegal(ctx),
  invite: (ctx) => renderInvite(ctx),
  discover: () => renderDiscover(),
  friends: () => renderFriends(),
  dms: () => renderDms(),
  'dms.conversation': (ctx) => renderDmConversation(ctx),
  profile: (ctx) => renderProfile(ctx),

  // The community surfaces. The bare community and the settings addresses all
  // answer to one dispatcher; the channels are the conversation pages.
  community: (ctx) => renderCommunity(ctx),
  'community.legacy': (ctx) => renderCommunity(ctx),
  'community.channel': (ctx) => renderChannelView(ctx),
  'community.channelPins': (ctx) => renderChannelView(ctx),
  'community.members': (ctx) => renderMembers(ctx),
  'community.roles': (ctx) => renderRoles(ctx),
  'community.invites': (ctx) => renderInvites(ctx),
  'community.categories': (ctx) => renderCategories(ctx),
  'community.new': () => renderServerCreate(),

  // The community settings addresses resolve to the pages above through the
  // registry's router; these bindings exist so an address typed as a settings
  // page never answers with a fault.
  'community.settings': (ctx) => renderCommunity(ctx),
  'community.settings.overview': (ctx) => renderCommunity(ctx),
  'community.settings.appearance': (ctx) => renderCommunity(ctx),
  'community.settings.channels': (ctx) => renderCommunity(ctx),
  'community.settings.categories': (ctx) => renderCommunity(ctx),
  'community.settings.members': (ctx) => renderCommunity(ctx),
  'community.settings.roles': (ctx) => renderCommunity(ctx),
  'community.settings.invites': (ctx) => renderCommunity(ctx),
  'community.settings.moderation': (ctx) => renderCommunity(ctx),
  'community.settings.ownership': (ctx) => renderCommunity(ctx),
  'community.settings.analytics': (ctx) => renderCommunity(ctx),
  'community.settings.integrations': (ctx) => renderCommunity(ctx),

  // The account studio and the instance admin.
  settings: (ctx) => renderSettings(ctx),
  'settings.security': (ctx) => renderSettings(ctx),
  'settings.privacy': (ctx) => renderSettings(ctx),
  'settings.notifications': (ctx) => renderSettings(ctx),
  'settings.appearance': (ctx) => renderSettings(ctx),
  'settings.backend': (ctx) => renderSettings(ctx),
  'settings.updates': (ctx) => renderSettings(ctx),

  admin: (ctx) => renderAdmin(ctx),
  'admin.users': (ctx) => renderAdmin(ctx),
  'admin.communities': (ctx) => renderAdmin(ctx),
  'admin.reports': (ctx) => renderAdmin(ctx),
  'admin.appeals': (ctx) => renderAdmin(ctx),
  'admin.audit': (ctx) => renderAdmin(ctx),
  'admin.gdpr': (ctx) => renderAdmin(ctx),
  'admin.announcements': (ctx) => renderAdmin(ctx),
  'admin.pages': (ctx) => renderAdmin(ctx),
  'admin.settings': (ctx) => renderAdmin(ctx),
  'admin.database': (ctx) => renderAdmin(ctx),
  'admin.continuum': (ctx) => renderAdmin(ctx),

  login: gates,
  register: gates,
  forgot: gates,
  resetPassword: gates,
  verifyEmail: gates,
  twoStep: gates,
};

export { renderNotFound };
export default { RENDERERS, renderNotFound };
