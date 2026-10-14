// The page registry: one entry per destination in Trycord.
//
//   { id, route, scope, layout, sidebar, access, nav }
//
// id is the stable identity that navigation and tests reference. route is the
// address and may contain :params. layout says which shell shape the page needs,
// sidebar which navigation tree sits beside it, access who may be here.
//
// Matching is longest-prefix on segment boundaries, so array order is a reading
// convenience only: moving an entry cannot change what a URL means.

const p = (id, route, rest) => ({
  id,
  route,
  access: 'session',
  layout: 'list',
  sidebar: null,
  ...rest,
});

export const PAGES = [
  // ---- global destinations. These are the ones the rail carries, and most of
  // them the phone tab bar as well.
  p('home', '/home', {
    nav: { label: 'Home', short: 'Home', icon: 'home', global: true, mobile: true, tabOrder: 1 },
  }),
  p('dms', '/dms', {
    sidebar: 'dms',
    nav: { label: 'Direct messages', short: 'Messages', icon: 'message', global: true, mobile: true, tabLabel: 'DMs', tabOrder: 2 },
  }),
  // /dms/:id is the same place as /dms with a conversation open. Highlighting is
  // by prefix, so it needs no parent field.
  p('dms.conversation', '/dms/:id', { sidebar: 'dms', nav: null }),
  p('notifications', '/notifications', {
    sidebar: 'notifications',
    nav: { label: 'Notifications', short: 'Alerts', icon: 'bell', global: true, mobile: true, tabOrder: 4 },
  }),
  p('discover', '/discover', {
    access: 'public',
    layout: 'plain',
    nav: { label: 'Discover', short: 'Discover', icon: 'compass', global: true },
  }),
  p('friends', '/friends', {
    sidebar: 'friends',
    nav: { label: 'Friends', short: 'Friends', icon: 'users', global: true, mobile: true, tabOrder: 3 },
  }),
  // The directory: every community and channel. It lists them itself, so it takes
  // no sidebar.
  p('menu', '/menu', {
    layout: 'plain',
    sidebar: 'home',
    nav: { label: 'Menu', short: 'Menu', icon: 'menu', mobile: true, tabOrder: 5 },
  }),

  // ---- the community tree. /c/:slug is the current spelling and /server/:id the
  // legacy one; both resolve here and the shell only ever sees the id form.
  p('community', '/c/:slug', { layout: 'channel', sidebar: 'community', hidden: true }),
  p('community.legacy', '/server/:id', {
    layout: 'channel', sidebar: 'community', hidden: true, aliasOf: 'community',
  }),
  p('community.channel', '/server/:id/channel/:channel', {
    layout: 'channel', sidebar: 'community', hidden: true,
  }),
  p('community.channelPins', '/server/:id/channel/:channel/pins', {
    layout: 'channel', sidebar: 'community', hidden: true,
  }),
  p('community.members', '/server/:id/members', { layout: 'channel', sidebar: 'community', hidden: true }),
  p('community.roles', '/server/:id/roles', { layout: 'channel', sidebar: 'community', hidden: true }),
  p('community.invites', '/server/:id/invites', { layout: 'channel', sidebar: 'community', hidden: true }),
  p('community.categories', '/server/:id/categories', { layout: 'channel', sidebar: 'community', hidden: true }),
  p('community.settings', '/server/:id/settings', { layout: 'channel', sidebar: 'community', hidden: true }),

  // ---- account settings. /account/* is the older spelling.
  p('settings', '/settings', {
    layout: 'settings', scope: 'account', group: 'You', order: 1,
    label: 'Profile', icon: 'users', blurb: 'Your name, photo and status',
    tabs: ['profile'], nav: null,
  }),
  p('settings.security', '/settings/security', {
    layout: 'settings', scope: 'account', group: 'Safety', order: 1,
    label: 'Security', icon: 'shield',
    blurb: 'Your password, two-step sign-in, and signed-in devices',
    tabs: ['security', 'password', 'sessions', 'twofactor'],
  }),
  p('settings.privacy', '/settings/privacy', {
    layout: 'settings', scope: 'account', group: 'Safety', order: 2,
    label: 'Privacy', icon: 'ban',
    blurb: 'Who can contact you and see what you are doing',
    tabs: ['privacy'],
  }),
  p('settings.notifications', '/settings/notifications', {
    layout: 'settings', scope: 'account', group: 'Safety', order: 3,
    label: 'Notifications', icon: 'bell',
    blurb: 'Which channels stay quiet, and what you are told about',
    tabs: ['notifications'],
  }),
  p('settings.appearance', '/settings/appearance', {
    layout: 'settings', scope: 'account', group: 'Preferences', order: 1,
    label: 'Appearance', icon: 'image',
    blurb: 'Colours, how much you see at once, and animation',
    tabs: ['appearance'],
  }),
  p('settings.backend', '/settings/backend', {
    layout: 'settings', scope: 'account', group: 'Preferences', order: 2,
    label: 'Connection', icon: 'server',
    blurb: 'Which server this client talks to',
    tabs: ['backend'],
  }),
  p('settings.updates', '/settings/updates', {
    layout: 'settings', scope: 'account', group: 'Preferences', order: 3,
    label: 'Updates', icon: 'sparkle',
    blurb: 'What this build is and what changed',
    tabs: ['updates'],
  }),

  // ---- admin.
  p('admin', '/admin', {
    layout: 'admin', scope: 'admin', group: 'Instance', order: 1,
    label: 'Overview', icon: 'activity', tabs: ['overview'],
    blurb: 'Health, counts and what changed lately',
  }),
  p('admin.users', '/admin/users', {
    layout: 'admin', scope: 'admin', group: 'Moderation', order: 1,
    label: 'People', icon: 'users', tabs: ['users'],
    blurb: 'Search an account and act on it',
  }),
  p('admin.communities', '/admin/communities', {
    layout: 'admin', scope: 'admin', group: 'Moderation', order: 2,
    label: 'Communities', icon: 'layers', tabs: ['communities'],
    blurb: 'Every community on this instance',
  }),
  p('admin.reports', '/admin/reports', {
    layout: 'admin', scope: 'admin', group: 'Moderation', order: 3,
    label: 'Reports', icon: 'flag', tabs: ['reports'],
    blurb: 'Reports raised by members',
  }),
  p('admin.appeals', '/admin/appeals', {
    layout: 'admin', scope: 'admin', group: 'Moderation', order: 4,
    label: 'Appeals', icon: 'mail', tabs: ['appeals'],
    blurb: 'Requests to reconsider an enforcement',
  }),
  p('admin.audit', '/admin/audit', {
    layout: 'admin', scope: 'admin', group: 'Moderation', order: 5,
    label: 'Audit log', icon: 'book', tabs: ['audit'],
    blurb: 'Administrative actions, most recent first',
  }),
  p('admin.gdpr', '/admin/gdpr', {
    layout: 'admin', scope: 'admin', group: 'Moderation', order: 6,
    label: 'Data requests', icon: 'lock', tabs: ['gdpr'],
    blurb: 'Erasure and access requests',
  }),
  p('admin.announcements', '/admin/announcements', {
    layout: 'admin', scope: 'admin', group: 'Instance', order: 2,
    label: 'Announcements', icon: 'bell', tabs: ['announcements'],
    blurb: 'Messages shown to everyone',
  }),
  p('admin.pages', '/admin/pages', {
    layout: 'admin', scope: 'admin', group: 'Instance', order: 3,
    label: 'Pages', icon: 'file', tabs: ['pages'],
    blurb: 'The public site pages this instance serves',
  }),
  p('admin.settings', '/admin/settings', {
    layout: 'admin', scope: 'admin', group: 'Instance', order: 4,
    label: 'Configuration', icon: 'settings', tabs: ['settings'],
    blurb: 'Instance settings, changed here and applied as they are saved',
  }),
  p('admin.database', '/admin/database', {
    layout: 'admin', scope: 'admin', group: 'Instance', order: 5,
    label: 'Database', icon: 'database', tabs: ['database'],
    blurb: 'Where this instance keeps its data, and how to move it',
  }),

  // ---- community settings sections. No path: each is addressed relative to
  // whichever community is open, and the shell owns that resolver.
  ...[
    ['overview', 'Overview', 'home', 'Community profile and public details'],
    ['appearance', 'Appearance', 'image', 'Banner, accent and layout'],
    ['channels', 'Channels', 'hash', 'Create and reorder channels'],
    ['categories', 'Categories', 'layers', 'Group channels together'],
    ['members', 'Members', 'users', 'Everyone here, and what they can do'],
    ['roles', 'Roles', 'shield', 'What each role may manage'],
    ['invites', 'Invites', 'mail', 'Codes and their uses'],
    ['moderation', 'Moderation', 'flag', 'Reports and enforcement'],
    ['ownership', 'Ownership', 'crown', 'Transfer or take over'],
    ['analytics', 'Analytics', 'chart', 'Activity, channels, members'],
    ['integrations', 'Integrations', 'rocket', 'Webhooks and apps'],
  ].map(([id, label, icon, blurb], i) => p('community.settings.' + id, '', {
    layout: 'channel', sidebar: 'community',
    scope: 'community', group: groupForCommunitySetting(id), order: i,
    label, icon, blurb, tabs: [id],
  })),

  // ---- profile, support, legal, and the signed-out screens.
  p('profile', '/users/:id', { layout: 'profile', sidebar: 'profile', hidden: true }),
  p('community.new', '/servers/new', { layout: 'plain', hidden: true }),
  p('support', '/support', { access: 'public', layout: 'plain' }),
  p('legal', '/legal/:doc', { access: 'public', layout: 'plain' }),
  p('invite', '/invite/:code', { access: 'session', layout: 'plain', hidden: true }),

  p('login', '/login', { access: 'guest', guestTo: '/home', layout: 'plain' }),
  p('register', '/register', { access: 'guest', guestTo: '/home', layout: 'plain' }),
  p('forgot', '/forgot', { access: 'guest', guestTo: '/home', layout: 'plain' }),
  p('resetPassword', '/reset-password/:token', { access: 'guest', guestTo: '/home', layout: 'plain' }),
  p('verifyEmail', '/verify-email/:token', { access: 'public', layout: 'plain' }),
];

function groupForCommunitySetting(id) {
  if (id === 'overview' || id === 'appearance') return 'This community';
  if (id === 'channels' || id === 'categories') return 'Structure';
  if (id === 'members' || id === 'roles' || id === 'invites') return 'Access';
  if (id === 'moderation' || id === 'ownership') return 'Safety';
  return 'Reach';
}

const BY_ID = new Map(PAGES.map((page) => [page.id, page]));
const BY_ROUTE = new Map();
for (const page of PAGES) {
  if (page.route) BY_ROUTE.set(page.route, page);
}

const LEGACY_PREFIX = '/account';

// /account/* was the settings tree before it was renamed, and /admin/servers was
// the communities section. Folded in before matching so a page has one identity.
function normalise(rawPath) {
  const path = String(rawPath || '/');
  if (path === '/') return '/home';
  if (path === LEGACY_PREFIX || path.startsWith(LEGACY_PREFIX + '/')) {
    return '/settings' + path.slice(LEGACY_PREFIX.length);
  }
  if (path === '/admin/servers' || path.startsWith('/admin/servers/')) {
    return '/admin/communities' + path.slice('/admin/servers'.length);
  }
  return path;
}

export function matchPath(rawPath) {
  const path = normalise(rawPath);
  let best = null;
  let bestLength = -1;
  for (const page of PAGES) {
    if (!page.route) continue;
    if (!matches(page.route, path)) continue;
    if (page.route.length <= bestLength) continue;
    best = page;
    bestLength = page.route.length;
  }
  return best;
}

// Segment-aware, with :params. A pattern ending in a :param swallows the rest of
// the path, so /server/:id/channel/:channel also covers .../pins.
function matches(pattern, path) {
  const want = pattern.split('/').filter(Boolean);
  const have = path.split('/').filter(Boolean);
  const fixed = want.length;
  for (let i = 0; i < fixed; i++) {
    if (want[i].startsWith(':')) continue;
    if (have[i] !== want[i]) return false;
  }
  // A pattern ending in a :param swallows the rest of the path, so /server/:id
  // still answers /server/<id>/members when nothing more specific does. A pattern
  // ending in a literal is itself: comparing the joined segments made
  // /server/:id/members unmatchable, because the path holds an id where the
  // pattern holds ":id".
  if (want.length && want[want.length - 1].startsWith(':')) return have.length >= fixed;
  return have.length === fixed;
}

export function matchRoute(rawPath) {
  const path = normalise(rawPath);
  const page = matchPath(path);
  if (!page) return null;
  return Object.assign({ page }, splitPath(page.route, path));
}

function splitPath(pattern, path) {
  const want = String(pattern || '').split('/').filter(Boolean);
  const have = String(path || '').split('/').filter(Boolean);
  const params = {};
  for (let i = 0; i < want.length; i++) {
    if (!want[i].startsWith(':') || have[i] === undefined) continue;
    params[want[i].slice(1)] = decodeURIComponent(have[i]);
  }
  return { params, rest: have.slice(want.length).map(decodeURIComponent) };
}

export function pageById(id) {
  return BY_ID.get(id) || null;
}

export function pageAt(route) {
  return BY_ROUTE.get(route) || null;
}

// Every destination in a navigation scope, grouped and in order.
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
      route: page.route || null,
      order: page.order === undefined || page.order === null ? 999 : page.order,
    };
    const list = groups.get(page.group) || [];
    list.push(item);
    groups.set(page.group, list);
  }
  return Array.from(groups.entries()).map(([group, items]) => ({
    group,
    items: items.sort((a, b) => a.order - b.order),
  }));
}

export function globalPages() {
  return PAGES.filter((page) => page.nav && page.nav.global);
}

export function mobilePages() {
  return PAGES
    .filter((page) => page.nav && page.nav.mobile)
    .map((page, i) => ({ page, i }))
    .sort((a, b) => {
      const ao = a.page.nav.tabOrder === undefined || a.page.nav.tabOrder === null ? a.i : a.page.nav.tabOrder;
      const bo = b.page.nav.tabOrder === undefined || b.page.nav.tabOrder === null ? b.i : b.page.nav.tabOrder;
      return ao - bo;
    })
    .map((entry) => entry.page);
}

export function scopeHasTab(scope, tab) {
  for (const group of scopeNav(scope)) {
    for (const item of group.items) if (item.tabs.indexOf(tab) !== -1) return true;
  }
  return false;
}

export function scopeFor(page) {
  return page && page.scope ? page.scope : null;
}

// Renderers are attached after load by the router. Binding is separate from
// declaring because a renderer imports the shell and the shell reads this table;
// importing renderers here would close that loop.
const RENDERERS = new Map();

export function bind(renderers) {
  for (const id of Object.keys(renderers)) {
    if (renderers[id]) RENDERERS.set(id, renderers[id]);
  }
}

export function isBound() {
  return RENDERERS.size > 0;
}

export function rendererFor(page) {
  if (!page) return null;
  return RENDERERS.get(page.id) || null;
}

export function renderPage(page, ctx) {
  const render = rendererFor(page);
  if (typeof render !== 'function') throw new Error('No renderer for page ' + (page && page.id));
  return render(ctx, page);
}

export const HOME_PAGE = BY_ID.get('home');

export default {
  PAGES, matchPath, matchRoute, pageById, pageAt, scopeNav, scopeHasTab,
  globalPages, mobilePages, scopeFor, HOME_PAGE, bind, isBound, rendererFor, renderPage,
};
