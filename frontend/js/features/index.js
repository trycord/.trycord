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
import { renderFederatedCommunity } from './federatedCommunity.js';
import { renderWorkspace } from './workspace.js';
import { onboardingView as renderOnboarding } from './onboarding.js';
import { renderSettings } from './settings.js';

// Pages a reader opens once in a long while are loaded on the visit, not with
// the shell: the developer console, the instance admin and the reader's own
// indexes stay out of the first paint. The router awaits a page's renderer,
// so a thunk that resolves to the real function is the same contract with a
// smaller graph - and a page nobody opens is never downloaded.
const lazy = (spec, name) => (ctx) => import(spec).then((m) => m[name](ctx));

const gates = (ctx) => renderAuth(ctx.page, ctx.params);

export const RENDERERS = {
  home: () => renderHome(),
  notifications: () => renderInbox(),
  menu: () => renderMenu(),
  // The phone carries /communities as a hub of its own; the desk shows the
  // same places in its rail, so the address is answered by the finder, which
  // lists them all and everything beside them.
  communities: () => renderMenu(),
  extensions: lazy('./extensions.js', 'renderExtensions'),
  developer: lazy('./developer.js', 'renderDeveloper'),
  'developer.keys': lazy('./developer.js', 'renderDeveloper'),
  'developer.applications': lazy('./developer.js', 'renderDeveloper'),
  'developer.documentation': lazy('./developer.js', 'renderDeveloper'),
  support: () => renderSupport(),
  legal: (ctx) => renderLegal(ctx),
  invite: (ctx) => renderInvite(ctx),
  discover: () => renderDiscover(),
  instances: lazy('./instances.js', 'renderInstances'),
  friends: () => renderFriends(),
  dms: () => renderDms(),
  'dms.conversation': (ctx) => renderDmConversation(ctx),
  profile: (ctx) => renderProfile(ctx),

  // What the reader keeps, and what happened to the instance.
  search: lazy('./search.js', 'renderSearch'),
  collections: lazy('./collections.js', 'renderCollections'),
  federation: lazy('./federation.js', 'renderFederation'),
  status: lazy('./status.js', 'renderStatus'),

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
  'community.workspace': (ctx) => renderWorkspace(ctx),
  'community.workspace.spaces': (ctx) => renderWorkspace(ctx),
  'community.workspace.space': (ctx) => renderWorkspace(ctx),
  'community.workspace.documents': (ctx) => renderWorkspace(ctx),
  'community.workspace.document': (ctx) => renderWorkspace(ctx),
  'community.workspace.boards': (ctx) => renderWorkspace(ctx),
  'community.workspace.board': (ctx) => renderWorkspace(ctx),
  'community.workspace.card': (ctx) => renderWorkspace(ctx),
  'community.workspace.events': (ctx) => renderWorkspace(ctx),
  'community.workspace.event': (ctx) => renderWorkspace(ctx),
  'community.workspace.polls': (ctx) => renderWorkspace(ctx),
  'community.workspace.poll': (ctx) => renderWorkspace(ctx),
  'community.new': () => renderServerCreate(),

  // A community that lives on another instance.
  'federated.community': (ctx) => renderFederatedCommunity(ctx),

  // The community settings addresses resolve to the pages above through the
  // registry's router; these bindings exist so an address typed as a settings
  // page never answers with a fault.
  'community.settings': (ctx) => renderCommunity(ctx),
  'community.onboarding': (ctx) => renderOnboarding(ctx),
  'community.settings.overview': (ctx) => renderCommunity(ctx),
  'community.settings.appearance': (ctx) => renderCommunity(ctx),
  'community.settings.channels': (ctx) => renderCommunity(ctx),
  'community.settings.categories': (ctx) => renderCommunity(ctx),
  'community.settings.members': (ctx) => renderCommunity(ctx),
  'community.settings.roles': (ctx) => renderCommunity(ctx),
  'community.settings.invites': (ctx) => renderCommunity(ctx),
  'community.settings.moderation': (ctx) => renderCommunity(ctx),
  'community.settings.rules': (ctx) => renderCommunity(ctx),
  'community.settings.voice': (ctx) => renderCommunity(ctx),
  'community.settings.ownership': (ctx) => renderCommunity(ctx),
  'community.settings.analytics': (ctx) => renderCommunity(ctx),
  'community.settings.integrations': (ctx) => renderCommunity(ctx),

  // The account studio and the instance admin.
  settings: (ctx) => renderSettings(ctx),
  'settings.security': (ctx) => renderSettings(ctx),
  'settings.privacy': (ctx) => renderSettings(ctx),
  'settings.notifications': (ctx) => renderSettings(ctx),
  'settings.encryption': (ctx) => renderSettings(ctx),
  'settings.appearance': (ctx) => renderSettings(ctx),
  'settings.language': (ctx) => renderSettings(ctx),
  'settings.backend': (ctx) => renderSettings(ctx),
  'settings.updates': (ctx) => renderSettings(ctx),

  admin: lazy('./admin.js', 'renderAdmin'),
  'admin.users': lazy('./admin.js', 'renderAdmin'),
  'admin.approvals': lazy('./admin.js', 'renderAdmin'), // TEMP-CHECK
  'admin.communities': lazy('./admin.js', 'renderAdmin'),
  'admin.reports': lazy('./admin.js', 'renderAdmin'),
  'admin.appeals': lazy('./admin.js', 'renderAdmin'),
  'admin.audit': lazy('./admin.js', 'renderAdmin'),
  'admin.gdpr': lazy('./admin.js', 'renderAdmin'),
  'admin.announcements': lazy('./admin.js', 'renderAdmin'),
  'admin.pages': lazy('./admin.js', 'renderAdmin'),
  'admin.settings': lazy('./admin.js', 'renderAdmin'),
  'admin.database': lazy('./admin.js', 'renderAdmin'),
  'admin.continuum': lazy('./admin.js', 'renderAdmin'),
  'admin.voice': lazy('./admin.js', 'renderAdmin'),
  'admin.diagnostics': lazy('./admin.js', 'renderAdmin'),
  'admin.incidents': lazy('./admin.js', 'renderAdmin'),
  'admin.federation': lazy('./admin.js', 'renderAdmin'),

  login: gates,
  register: gates,
  forgot: gates,
  resetPassword: gates,
  verifyEmail: gates,
  twoStep: gates,
};

export { renderNotFound };
export default { RENDERERS, renderNotFound };
