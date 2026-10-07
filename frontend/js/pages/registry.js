// The page registry: one entry per destination in Trycord.
//
// There used to be six lists, each answering part of "where can I go and what is
// this screen called" - the route table, a layout prefix table, a sidebar context
// classifier, the rail's destinations, the phone tab bar's, and the settings
// information architecture. They had drifted: the admin navigation came from
// SETTINGS_IA.admin while the admin page's title came from a second list holding the
// same nine sections in a different order, so adding one to the nav left the title
// silently reading Overview. Layout, sidebar and navigation are derived from the
// matched page now rather than decided again by whoever is asking.
//
// A page looks like:
//
//   {
//     id,      stable identity. Referenced by navigation and by tests; never a route
//              string, because routes change and identities should not.
//     path,    the address. May contain :params. Legacy spellings are rewritten to
//              the current one before matching rather than kept as parallel entries,
//              so /account/* reaches the page that answers to it and cannot drift.
//     access,  'guest'   signed out only; a signed-in reader is sent elsewhere
//              'session' needs a session
//              'public'  either
//     layout,  which shell layout: channel | list | settings | admin | profile | plain
//     sidebar, which contextual nav the shell paints, or null for a surface that
//              carries its own navigation inside its content
//     scope,   for the scoped navigations: 'account' | 'community' | 'admin'
//     group,   the heading it sits under inside its scope
//     label,   what the navigation calls it
//     icon,    glyph name from ui.js ICON_PATHS
//     order,   position within the scope. Not the array order - a page with no order
//              still belongs to its scope, it just sorts last.
//     blurb,   the line under the title when this is the current page
//     tabs,    every tab id that means this page. The settings tree has always had
//              more addresses than screens; /settings/sessions and /settings/password
//              are both Security.
//     nav,     presentation. `rail` and `mobile` say whether this destination appears
//              in the desktop rail and the phone tab bar. Presentation may differ
//              between them; identity does not.
//     hidden   true keeps a page routable but out of every navigation
//   }
//
// Matching is longest-prefix-wins on segment boundaries, which the old route table
// already did and is worth keeping: the order of this array is a reading convenience,
// not a correctness requirement, so moving an entry cannot change what a URL means.
//
// Deliberately not here: the renderer. Binding one to a registry entry would make
// every navigation consumer - the rail, the sidebar, the settings nav, the tab bar -
// import all nineteen page modules to read a label, and those modules import the
// shell, which reads this file. The binding lives in handlers.js, keyed by id.

const p = (id, path, rest) => ({ id, path, access: 'session', layout: 'list', sidebar: null, ...rest });

export const PAGES = [
  // ---- global destinations. These are the ones that appear in the rail, and most
  // of them in the phone tab bar as well.
  p('home', '/home', {
    nav: { label: 'Home', short: 'Home', icon: 'home', rail: true, mobile: true, tabOrder: 1 },
  }),
  p('dms', '/dms', {
    sidebar: 'dms',
    nav: { label: 'Direct messages', short: 'Messages', icon: 'mail', rail: true, mobile: true, tabLabel: 'DMs', tabOrder: 2 },
  }),
  // /dms/:id is the same place as /dms with a conversation open.
  //
  // It carried a parent: 'dms' field so the sidebar and the rail would highlight the
  // same entry here as they do on /dms. Nothing ever read it - the highlighting is done
  // by prefix match, since /dms/<id> starts with /dms/ - so the field said nothing and
  // the comment described a mechanism that did not exist. What does the job is noted
  // here instead, so nobody adds the field back.
  p('dms.conversation', '/dms/:id', {
    sidebar: 'dms',
    nav: null,
  }),
  p('notifications', '/notifications', {
    sidebar: 'notifications',
    nav: { label: 'Notifications', short: 'Alerts', icon: 'bell', rail: true, mobile: true, tabOrder: 4 },
  }),
  p('discover', '/discover', {
    access: 'public',
    layout: 'plain',
    nav: { label: 'Discover', short: 'Discover', icon: 'search', rail: true },
  }),
  p('friends', '/friends', {
    sidebar: 'friends',
    nav: { label: 'Friends', short: 'Friends', icon: 'users', rail: true, mobile: true, tabOrder: 3 },
  }),
  // The directory. Lists every community and channel itself, so it takes no
  // sidebar - a column beside it repeated the rail a third time.
  p('menu', '/menu', {
    layout: 'plain',
    sidebar: 'home',
    nav: { label: 'Menu', short: 'Menu', icon: 'menu', mobile: true, tabOrder: 5 },
  }),

  // ---- the community tree. /c/:slug is the current spelling and /server/:id the
  // legacy one; both resolve here and the shell only ever sees the id form, which
  // is why publishRoute() rewrites the route once the slug has been resolved.
  p('community', '/c/:slug', {
    layout: 'channel',
    sidebar: 'community',
    hidden: true,
  }),
  // The same destination under its other address. /c/<slug> is what a reader shares;
  // /server/<id> is what the app builds and what every sub-page below hangs off. One
  // page with two spellings, so it says so: otherwise "which page is this" has two
  // answers for one URL, and a comparison written against the wrong one silently stops
  // matching rather than failing loudly.
  p('community.legacy', '/server/:id', {
    layout: 'channel',
    sidebar: 'community',
    hidden: true,
    aliasOf: 'community',
  }),
  p('community.channel', '/server/:id/channel/:channel', {
    layout: 'channel',
    sidebar: 'community',
    hidden: true,
  }),
  p('community.channelPins', '/server/:id/channel/:channel/pins', {
    layout: 'channel',
    sidebar: 'community',
    hidden: true,
  }),
  p('community.members', '/server/:id/members', {
    layout: 'channel', sidebar: 'community', hidden: true,
  }),
  p('community.roles', '/server/:id/roles', {
    layout: 'channel', sidebar: 'community', hidden: true,
  }),
  p('community.invites', '/server/:id/invites', {
    layout: 'channel', sidebar: 'community', hidden: true,
  }),
  p('community.categories', '/server/:id/categories', {
    layout: 'channel', sidebar: 'community', hidden: true,
  }),

  // ---- community settings. Same shape as the account tree below, but the address
  // needs the community in it, so `href` is a function of the id the shell already
  // has rather than a string.
  p('community.settings', '/server/:id/settings', {
    layout: 'channel', sidebar: 'community', hidden: true,
  }),

  // ---- account settings. /account/* is the older spelling of all of this.
  p('settings', '/settings', {
    layout: 'settings',
    scope: 'account', group: 'You', order: 1,
    label: 'Profile', icon: 'users',
    blurb: 'Your name, photo and status',
    tabs: ['profile'],
    nav: null,
  }),
  p('settings.security', '/settings/security', {
    layout: 'settings',
    scope: 'account', group: 'Safety', order: 1,
    label: 'Security', icon: 'shield',
    blurb: 'Password, two-factor and sessions',
    // One screen, three old addresses.
    tabs: ['security', 'password', 'sessions', 'twofactor'],
  }),
  p('settings.privacy', '/settings/privacy', {
    layout: 'settings',
    scope: 'account', group: 'Safety', order: 2,
    label: 'Privacy', icon: 'ban',
    blurb: 'Friend requests and who can reach you',
    tabs: ['privacy'],
  }),
  p('settings.notifications', '/settings/notifications', {
    layout: 'settings',
    scope: 'account', group: 'Safety', order: 3,
    label: 'Notifications', icon: 'bell',
    blurb: 'Muted channels and alerts',
    tabs: ['notifications'],
  }),
  p('settings.appearance', '/settings/appearance', {
    layout: 'settings',
    scope: 'account', group: 'Preferences', order: 1,
    label: 'Appearance', icon: 'image',
    blurb: 'Theme, density and motion',
    tabs: ['appearance'],
  }),
  p('settings.backend', '/settings/backend', {
    layout: 'settings',
    scope: 'account', group: 'Instance', order: 1,
    label: 'Backend', icon: 'layers',
    blurb: 'Which instance this device talks to',
    tabs: ['backend'],
  }),
  p('settings.updates', '/settings/updates', {
    layout: 'settings',
    scope: 'account', group: 'Instance', order: 2,
    label: 'Updates', icon: 'download',
    blurb: 'Version and release notes',
    tabs: ['updates'],
  }),

  // ---- admin. Ordered the way the console reads, and the same order the nav used,
  // so the title and the nav cannot come from different lists any more.
  p('admin', '/admin', {
    layout: 'admin',
    scope: 'admin', group: 'Console', order: 1,
    label: 'Overview', icon: 'home',
    blurb: 'Platform health and recent activity',
    tabs: ['overview'],
  }),
  p('admin.users', '/admin/users', {
    layout: 'admin',
    scope: 'admin', group: 'People', order: 1,
    label: 'Users', icon: 'users', tabs: ['users'],
      blurb: 'Find an account, and act on it',
  }),
  p('admin.communities', '/admin/communities', {
    layout: 'admin',
    scope: 'admin', group: 'People', order: 2,
    label: 'Communities', icon: 'layers', tabs: ['communities'],
      blurb: 'Every community on this instance',
  }),
  p('admin.reports', '/admin/reports', {
    layout: 'admin',
    scope: 'admin', group: 'Trust and safety', order: 1,
    label: 'Reports', icon: 'warn', tabs: ['reports'],
      blurb: 'What people have reported, and what you decided',
  }),
  p('admin.appeals', '/admin/appeals', {
    layout: 'admin',
    scope: 'admin', group: 'Trust and safety', order: 2,
    label: 'Appeals', icon: 'flag', tabs: ['appeals'],
      blurb: 'Requests to undo a moderation decision',
  }),
  p('admin.audit', '/admin/audit', {
    layout: 'admin',
    scope: 'admin', group: 'Trust and safety', order: 3,
    label: 'Audit log', icon: 'document', tabs: ['audit'],
      blurb: 'Administrative actions, most recent first',
  }),
  p('admin.announcements', '/admin/announcements', {
    layout: 'admin',
    scope: 'admin', group: 'Trust and safety', order: 4,
    label: 'Announcements', icon: 'bell', tabs: ['announcements'],
      blurb: 'Banners shown to everyone on this instance',
  }),
  p('admin.pages', '/admin/pages', {
    layout: 'admin',
    scope: 'admin', group: 'Platform', order: 1,
    label: 'Pages', icon: 'document', tabs: ['pages'],
  }),
  p('admin.gdpr', '/admin/gdpr', {
    layout: 'admin',
    scope: 'admin', group: 'Platform', order: 2,
    label: 'GDPR requests', icon: 'shield', tabs: ['gdpr'],
      blurb: 'Erasure and access requests from account holders',
  }),

  // ---- community settings, declared for navigation. The router resolves the
  // address; these give the settings nav its labels, order and blurbs.
  ...[
    ['overview', 'Overview', 'home', 'Community profile and public details'],
    ['appearance', 'Appearance', 'image', 'Banner, accent and layout'],
    ['channels', 'Channels', 'hash', 'Create and reorder channels'],
    ['categories', 'Categories', 'layers', 'Group channels together'],
    ['members', 'Members', 'users', 'Everyone here, and what they can do'],
    ['roles', 'Roles', 'shield', 'What each role may manage'],
    ['invites', 'Invites', 'mail', 'Codes and their uses'],
    ['moderation', 'Moderation', 'warn', 'Reports and automod'],
    ['ownership', 'Ownership', 'flag', 'Transfer or hand over'],
    ['analytics', 'Analytics', 'compass', 'Activity, channels, members'],
    ['integrations', 'Integrations', 'rocket', 'Webhooks, apps, commands'],
  ].map(([id, label, icon, blurb], i) => p('community.settings.' + id, '', {
    layout: 'channel', sidebar: 'community',
    scope: 'community', group: groupForCommunitySetting(id), order: i,
    label, icon, blurb, tabs: [id],
    // No path: a community section is addressed relative to whichever community is
    // open, and resolveCommunityHref already owns that. The registry owns what the
    // section is called and where it sits; it does not need a second copy of where
    // it lives to say so.
  })),

  // ---- profile, support, legal, and the signed-out screens.
  p('profile', '/users/:id', {
    layout: 'profile', sidebar: 'profile', hidden: true,
  }),
  p('community.new', '/servers/new', { layout: 'plain', hidden: true }),
  p('support', '/support', { access: 'public', layout: 'plain' }),
  p('support.appeals', '/support/appeals', {
    layout: 'plain', hidden: true,
  }),
  p('support.newAppeal', '/support/appeals/new', {
    access: 'public', layout: 'plain', hidden: true,
  }),
  p('legal', '/legal/:doc', { access: 'public', layout: 'plain' }),
  p('invite', '/invite/:code', { access: 'session', layout: 'plain', hidden: true }),

  p('login', '/login', { access: 'guest', guestTo: '/home', layout: 'plain' }),
  p('register', '/register', { access: 'guest', guestTo: '/home', layout: 'plain' }),
  p('forgot', '/forgot', { access: 'guest', guestTo: '/home', layout: 'plain' }),
  p('resetPassword', '/reset-password/:token', {
    access: 'guest', guestTo: '/home', layout: 'plain',
  }),
  p('verifyEmail', '/verify-email/:token', {
    access: 'public', layout: 'plain',
  }),
];

function groupForCommunitySetting(id) {
  if (id === 'overview' || id === 'appearance') return 'This community';
  if (id === 'channels' || id === 'categories') return 'Structure';
  if (id === 'members' || id === 'roles' || id === 'invites') return 'Access';
  if (id === 'moderation' || id === 'ownership') return 'Safety';
  return 'Reach';
}

// ---- lookup tables, built once.

const BY_ID = new Map(PAGES.map((page) => [page.id, page]));
const BY_PATH = new Map();
for (const page of PAGES) {
  if (page.path) BY_PATH.set(page.path, page);
}

// /account/* was the whole settings tree before it was renamed, and both spellings
// are still in the wild. Rather than generate a second set of entries, the legacy
// prefix is rewritten before matching - which also means the account settings page
// is reached by exactly one identity, and the shell cannot end up with two navs.
const LEGACY_PREFIX = '/account';

export function matchPath(rawPath) {
  const path = normalise(String(rawPath || '/'));
  let best = null;
  let bestLength = -1;
  for (const page of PAGES) {
    if (!page.path) continue;
    if (!matches(page.path, path)) continue;
    if (page.path.length <= bestLength) continue;
    best = page;
    bestLength = page.path.length;
  }
  return best || null;
}

function normalise(path) {
  if (path === '/') return '/home';
  if (path === LEGACY_PREFIX || path.startsWith(LEGACY_PREFIX + '/')) {
    return '/settings' + path.slice(LEGACY_PREFIX.length);
  }
  // /admin/servers is what the communities section used to be called.
  if (path === '/admin/servers' || path.startsWith('/admin/servers/')) {
    return '/admin/communities' + path.slice('/admin/servers'.length);
  }
  return path;
}

/**
 * Segment-aware, with :params.
 *
 * A pattern ending in a segment matches that segment and anything under it, so
 * /server/:id/channel/:channel also covers /server/1/channel/2/pins - which is how
 * pins got matched before, as a literal prefix row.
 */
function matches(pattern, path) {
  const want = pattern.split('/').filter(Boolean);
  const have = path.split('/').filter(Boolean);

  // Every leading segment must match literally or as a param.
  const fixed = want.length;
  for (let i = 0; i < fixed; i++) {
    const w = want[i];
    if (w.startsWith(':')) continue;
    if (have[i] !== w) return false;
  }
  // A pattern with a trailing :param swallows the rest of the path.
  if (want.length && want[want.length - 1].startsWith(':')) return have.length >= fixed;

  // Otherwise the path must be exactly the pattern or below it.
  if (have.length < fixed) return false;
  if (have.length > fixed && want[fixed - 1] && want[fixed - 1].startsWith(':')) return true;
  return have.slice(0, fixed).join('/') === want.join('/') || path.startsWith(pattern + '/');
}

/**
 * Match an address and pull its parameters out at the same time.
 *
 * One implementation, because two consumers need it: the lifecycle to hand params
 * to a renderer, and the shell to know which community it is looking at. They were
 * deriving it separately, which is how the sidebar and the router can disagree
 * about what page you are on.
 *
 * `rest` is what is left after the pattern - /admin/pages/terms is one page
 * addressing something inside itself, and the page editor needs to know which.
 */
export function matchRoute(rawPath) {
  const path = normalise(String(rawPath || '/'));
  const page = matchPath(path);
  if (!page) return null;
  return { page, ...splitPath(page.path, path) };
}

function splitPath(pattern, path) {
  const want = String(pattern || '').split('/').filter(Boolean);
  const have = String(path || '').split('/').filter(Boolean);
  const params = {};
  for (let i = 0; i < want.length; i++) {
    if (!want[i].startsWith(':') || have[i] == null) continue;
    params[want[i].slice(1)] = decodeURIComponent(have[i]);
  }
  return { params, rest: have.slice(want.length).map(decodeURIComponent) };
}

export function pageById(id) {
  return BY_ID.get(id) || null;
}

export function pageAt(path) {
  return BY_PATH.get(path) || null;
}

/**
 * Every destination in a navigation scope, grouped and in order.
 *
 * A community section has no `path`: it is addressed relative to whichever
 * community is open, and its caller already has a resolver for that.
 */
export function scopeNav(scope) {
  const groups = new Map();
  for (const page of PAGES) {
    if (page.scope !== scope) continue;
    const item = {
      id: page.id,
      tab: (page.tabs && page.tabs[0]) || page.id.split('.').pop(),
      tabs: page.tabs || [],
      label: page.label,
      icon: page.icon,
      blurb: page.blurb || '',
      path: page.path || null,
      order: page.order == null ? 999 : page.order,
    };
    const g = groups.get(page.group) || [];
    g.push(item);
    groups.set(page.group, g);
  }
  return [...groups.entries()].map(([group, items]) => ({
    group,
    items: items.sort((a, b) => a.order - b.order),
  }));
}

/** The rail's destinations, in the order the rail reads. */
export function railPages() {
  return PAGES.filter((page) => page.nav && page.nav.rail);
}

/**
 * The phone tab bar's destinations.
 *
 * Same pages as the rail, sorted by tabOrder when they give one. The order is
 * separate because it genuinely differs - Friends sat before Alerts on the phone
 * bar and after it on the rail - and putting that in one shared ordering would
 * mean moving a tab on one surface to move it on the other.
 */
export function mobilePages() {
  return PAGES
    .filter((page) => page.nav && page.nav.mobile)
    .map((page, i) => ({ page, i }))
    .sort((a, b) => {
      const ao = a.page.nav.tabOrder == null ? a.i : a.page.nav.tabOrder;
      const bo = b.page.nav.tabOrder == null ? b.i : b.page.nav.tabOrder;
      return ao - bo;
    })
    .map((entry) => entry.page);
}

/** Does this scope answer to that section name, under any of its addresses? */
export function scopeHasTab(scope, tab) {
  for (const g of scopeNav(scope)) {
    for (const item of g.items) if (item.tabs.includes(tab)) return true;
  }
  return false;
}

/** Which scope's navigation a path belongs to, or null. */
export function scopeFor(page) {
  return page && page.scope ? page.scope : null;
}

export const HOME_PAGE = BY_ID.get('home');

export default {
  PAGES, matchPath, matchRoute, pageById, pageAt, scopeNav, scopeHasTab,
  railPages, mobilePages, scopeFor, HOME_PAGE,
};
