// The Mobile renderer table.
//
// One function per page id, kept apart from the registry so the registry can be
// read by the shell without importing every view. The mobile router binds this
// before it dispatches, and a page with no entry here is a page that cannot be
// opened. Every screen here is the Mobile module's own; none of it is the
// Desktop module at a smaller width.

import { PAGES } from '../../../packages/registry.js';
import { renderHome } from './home.js';
import { renderDms, renderDm } from './dms.js';
import { renderNotifications } from './notifications.js';
import { renderDiscover } from './discover.js';
import { renderFriends } from './friends.js';
import { renderMenu } from './menu.js';
import { renderProfile } from './profile.js';
import { renderAuth } from './auth.js';
import { renderSettings } from './settings.js';
import { onboardingScreen as renderOnboarding } from './onboarding.js';
import {
  renderChannel, renderChannelPins, renderMembersPage, renderRolesPage,
  renderInvitesPage, renderCategoriesPage, renderCommunitySettings, renderCommunityHome,
} from './community.js';
import { renderFederatedCommunity } from './federatedCommunity.js';
import {
  renderWorkspace, renderSpaces, renderSpace, renderDocuments, renderDocument,
  renderBoards, renderBoard, renderCard, renderEvents, renderEvent,
  renderPolls, renderPoll,
} from './workspace.js';
import {
  renderSupport, renderLegal, renderInvite, renderServerCreate, renderNotFound,
} from './plain.js';

// Pages a reader opens once in a long while are loaded on the visit, not with
// the shell: the developer console, the instance admin and the reader's own
// indexes stay out of the first paint. The router awaits a page's renderer,
// so a thunk that resolves to the real function is the same contract with a
// smaller graph - and a page nobody opens is never downloaded.
const lazy = (spec, name) => (ctx) => import(spec).then((m) => m[name](ctx));

const auth = (ctx) => renderAuth(ctx.page, ctx.params);

export const RENDERERS = {
  home: () => renderHome(),
  dms: () => renderDms(),
  'dms.conversation': (ctx) => renderDm(ctx),
  notifications: () => renderNotifications(),
  discover: () => renderDiscover(),
  friends: (ctx) => renderFriends(ctx),
  menu: () => renderMenu(),
  profile: (ctx) => renderProfile(ctx),
  // What the reader keeps, and what happened to the instance.
  search: lazy('./search.js', 'renderSearch'),
  collections: lazy('./collections.js', 'renderCollections'),
  federation: lazy('./federation.js', 'renderFederation'),
  status: lazy('./status.js', 'renderStatus'),
  community: (ctx) => renderCommunityHome(ctx),
  'community.legacy': (ctx) => renderCommunityHome(ctx),
  'community.channel': (ctx) => renderChannel(ctx),
  'community.channelPins': (ctx) => renderChannelPins(ctx),
  'community.members': (ctx) => renderMembersPage(ctx),
  'federated.community': (ctx) => renderFederatedCommunity(ctx),
  'community.roles': (ctx) => renderRolesPage(ctx),
  'community.invites': (ctx) => renderInvitesPage(ctx),
  'community.categories': (ctx) => renderCategoriesPage(ctx),
  'community.settings': (ctx) => renderCommunitySettings(ctx),
  'community.onboarding': (ctx) => renderOnboarding(ctx),
  'community.workspace': (ctx) => renderWorkspace(ctx),
  'community.workspace.spaces': (ctx) => renderSpaces(ctx),
  'community.workspace.space': (ctx) => renderSpace(ctx),
  'community.workspace.documents': (ctx) => renderDocuments(ctx),
  'community.workspace.document': (ctx) => renderDocument(ctx),
  'community.workspace.boards': (ctx) => renderBoards(ctx),
  'community.workspace.board': (ctx) => renderBoard(ctx),
  'community.workspace.card': (ctx) => renderCard(ctx),
  'community.workspace.events': (ctx) => renderEvents(ctx),
  'community.workspace.event': (ctx) => renderEvent(ctx),
  'community.workspace.polls': (ctx) => renderPolls(ctx),
  'community.workspace.poll': (ctx) => renderPoll(ctx),
  'community.new': () => renderServerCreate(),
  extensions: lazy('./extensions.js', 'renderExtensions'),
  developer: lazy('./developer.js', 'renderDeveloper'),
  'developer.keys': lazy('./developer.js', 'renderDeveloper'),
  'developer.applications': lazy('./developer.js', 'renderDeveloper'),
  'developer.documentation': lazy('./developer.js', 'renderDeveloper'),
  support: () => renderSupport(),
  legal: (ctx) => renderLegal(ctx),
  invite: (ctx) => renderInvite(ctx),
  login: auth,
  register: auth,
  instances: lazy('./instances.js', 'renderInstances'),
  forgot: auth,
  resetPassword: auth,
  verifyEmail: auth,
  twoStep: auth,
};

// The remaining pages all belong to a scope whose sections share one renderer,
// so they are filled from the registry rather than repeated by hand. When a
// section gains its own treatment it moves up into the literal above.
for (const page of PAGES) {
  if (RENDERERS[page.id]) continue;
  if (page.id === 'settings' || page.id.startsWith('settings.')) RENDERERS[page.id] = (ctx) => renderSettings(ctx);
  else if (page.id.startsWith('admin')) RENDERERS[page.id] = lazy('./admin.js', 'renderAdmin');
  else if (page.id.startsWith('community.settings.')) RENDERERS[page.id] = (ctx) => renderCommunitySettings(ctx);
}

export { renderNotFound };

export default { RENDERERS, renderNotFound };
