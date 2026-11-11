// The developer portal page registry: one entry per destination in the Trycord Developer Portal.
//
// Each page has an id, route, scope, layout, sidebar, access, and nav.

const p = (id, route, rest) => ({
  id,
  route,
  access: 'session',
  layout: 'plain',
  sidebar: null,
  ...rest,
});

export const PAGES = [
  // Portal home page
  p('portal', '/portal', {
    layout: 'plain', sidebar: 'profile',
    label: 'Developer Portal', icon: 'code',
    blurb: 'Manage applications, keys and bots in Trycord',
  }),

  // Portal pages
  p('portal.keys', '/portal/keys', {
    layout: 'plain', sidebar: 'profile', hidden: true,
  }),
  p('portal.applications', '/portal/applications', {
    layout: 'plain', sidebar: 'profile', hidden: true,
  }),
  p('portal.dashboard', '/portal/dashboard', {
    layout: 'plain', sidebar: 'profile', hidden: true,
  }),
  p('portal.documentation', '/portal/documentation', {
    layout: 'plain', sidebar: 'profile', hidden: true,
  }),
];

export function bindRegistry() {
  // Portal registry binding
}

export function bind() {
  bindRegistry();
}

const BY_ID = new Map(PAGES.map((page) => [page.id, page]));
const BY_ROUTE = new Map();
for (const page of PAGES) {
  if (page.route) BY_ROUTE.set(page.route, page);
}

export function matchPath(rawPath) {
  const path = rawPath || '/';
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

function matches(pattern, path) {
  const want = pattern.split('/').filter(Boolean);
  const have = path.split('/').filter(Boolean);
  const fixed = want.length;
  for (let i = 0; i < fixed; i++) {
    if (want[i].startsWith(':')) continue;
    if (have[i] !== want[i]) return false;
  }
  if (want.length && want[want.length - 1].startsWith(':')) return have.length >= fixed;
  return have.length === fixed;
}

export function matchRoute(rawPath) {
  const path = rawPath || '/';
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

  const ordered = [];
  for (const [group, items] of groups) {
    ordered.push({ group, label: group, items: items.sort((a, b) => a.order - b.order) });
  }

  return ordered;
}

export function bind() {
  bindRegistry();
}