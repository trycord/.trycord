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
import { renderInstances } from './instances.js';
import { renderSettings } from './settings.js';
import { renderAdmin } from './admin.js';
import {
  renderChannel, renderChannelPins, renderMembersPage, renderRolesPage,
  renderInvitesPage, renderCategoriesPage, renderCommunitySettings, renderCommunityHome,
} from './community.js';
import {
  renderSupport, renderLegal, renderInvite, renderServerCreate, renderNotFound,
} from './plain.js';
import { renderSearch } from './search.js';
import { renderCollections } from './collections.js';
import { renderFederation } from './federation.js';
import { renderStatus } from './status.js';

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
  search: (ctx) => renderSearch(ctx),
  collections: (ctx) => renderCollections(ctx),
  federation: (ctx) => renderFederation(ctx),
  status: (ctx) => renderStatus(ctx),
  community: (ctx) => renderCommunityHome(ctx),
  'community.legacy': (ctx) => renderCommunityHome(ctx),
  'community.channel': (ctx) => renderChannel(ctx),
  'community.channelPins': (ctx) => renderChannelPins(ctx),
  'community.members': (ctx) => renderMembersPage(ctx),
  'community.roles': (ctx) => renderRolesPage(ctx),
  'community.invites': (ctx) => renderInvitesPage(ctx),
  'community.categories': (ctx) => renderCategoriesPage(ctx),
  'community.settings': (ctx) => renderCommunitySettings(ctx),
  'community.new': () => renderServerCreate(),
  support: () => renderSupport(),
  legal: (ctx) => renderLegal(ctx),
  invite: (ctx) => renderInvite(ctx),
  login: auth,
  register: auth,
  instances: () => renderInstances(),
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
  else if (page.id.startsWith('admin')) RENDERERS[page.id] = (ctx) => renderAdmin(ctx);
  else if (page.id.startsWith('community.settings.')) RENDERERS[page.id] = (ctx) => renderCommunitySettings(ctx);
}

export { renderNotFound };

export default { RENDERERS, renderNotFound };
