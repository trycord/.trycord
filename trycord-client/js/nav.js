// Navigation.
//
// Routes live in the path. They used to live in the fragment, which is never
// sent to the server - so a shared fragment link and a refresh were two
// different behaviours, and two ways to name one route is two ways for them to
// disagree.
//
// adoptLegacyHash() is the only thing left that understands the old form. It
// upgrades bookmarks; nothing here produces one.

// Not ours - don't treat these as routes.
const EXTERNAL = /^(https?:|mailto:|tel:|#$|blob:|data:)/i;

// This module is served at /js/nav.js on a self-hosted instance and
// /app/js/nav.js on the hosted one. Routes are absolute, so without knowing the
// mount '/settings' would leave the app entirely from under /app/.
function mountPoint() {
  let pathname;
  try {
    const u = new URL('.', import.meta.url);
    // file:// would give a filesystem path as a URL prefix. Desktop builds
    // served off disk get no mount.
    if (u.protocol === 'file:' || u.protocol === 'data:') return '';
    pathname = u.pathname;
  } catch {
    return '';
  }
  const mount = pathname.replace(/js\/$/, '');
  if (mount === '/' || !mount.startsWith('/')) return '';
  return mount.replace(/\/$/, '');
}

export const BASE = mountPoint();

// '/settings' -> '/app/settings'.
//
// Idempotent on purpose: serverPath() and channelPath() already return a
// mounted path and those results get passed to navigate(), which routes again.
// Not being idempotent is what turned /c/slug into /app/app/c/slug on a subpath
// deployment.
export function route(path) {
  if (!path) return BASE || '/';
  if (EXTERNAL.test(path) || /^\/\//.test(path)) return path;
  if (!path.startsWith('/')) return path;
  if (BASE && (path === BASE || path.startsWith(BASE + '/'))) return path;
  return BASE + path;
}

/** '/app/settings' -> '/settings'. */
export function unroute(path) {
  if (!BASE || !path) return path;
  if (path === BASE) return '/';
  return path.startsWith(BASE + '/') ? path.slice(BASE.length) : path;
}

// A navigation target as a path, or null if it isn't one of ours.
//
// Deliberately doesn't strip a leading '#'. Accepting it would mean a typo like
// '#/dms' still worked, which keeps two addressing schemes alive in a codebase
// that has one. Old fragment URLs are handled once, by adoptLegacyHash.
export function routePath(target) {
  if (target == null) return null;
  const raw = String(target).trim();
  if (!raw || EXTERNAL.test(raw)) return null;
  return raw.startsWith('/') ? raw : '/' + raw;
}

/**
 * Go to a route.
 *
 * @param {string} target  '/home', or a full URL to somewhere else
 * @param {object} [opts]
 * @param {boolean} [opts.replace]  replace this entry instead of pushing one
 * @param {boolean} [opts.external]  a different origin: a real navigation
 */
export function navigate(target, opts = {}) {
  const path = routePath(target);
  if (path === null) {
    // Another origin has to be a real navigation or the SPA stays mounted on the
    // old origin, which reads as the link not working.
    if (/^(https?:)?\/\//i.test(String(target).trim())) {
      window.location.assign(String(target).trim());
      return;
    }
    // A fragment with no path is a real anchor on this page, not a route.
    location.hash = String(target);
    return;
  }
  if (opts.external) {
    // route() can't hand a relative route to another origin: it no-ops on a full
    // URL and otherwise adds the mount.
    window.location.assign(route(path));
    return;
  }
  const current = location.pathname + location.search;
  // route() is idempotent, so a caller that passed an already-mounted path is
  // unaffected.
  const next = route(path.startsWith('/') ? path : '/' + path);
  if (next === current && !opts.force) {
    // Pushing a duplicate entry makes Back do nothing visible.
    return;
  }
  if (opts.replace) history.replaceState(null, '', next);
  else history.pushState(null, '', next);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/** Current route as the app sees it: '/settings/privacy'. */
export function currentPath() {
  return (location.pathname || '/') + (location.search || '');
}

/** Build a query string from an object. */
export function withQuery(path, query) {
  const entries = Object.entries(query || {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (!entries.length) return path;
  return path + '?' + new URLSearchParams(entries).toString();
}

// Upgrade a fragment URL on arrival. These exist in bookmarks, in the desktop
// build's saved window state, and in messages people have sent each other.
export function adoptLegacyHash() {
  const hash = location.hash;
  if (!hash || hash.length < 2) return false;
  // Stripped here, not in routePath() - this is the only code left that knows
  // the fragment form.
  const path = routePath(hash.slice(1) || '/');
  if (path === null) return false;
  // Through route() like every other navigation. Writing the path straight into
  // history dropped the mount, which only shows up on a subpath deployment -
  // the fragment form is the one way an old URL arrives already under a mount.
  history.replaceState(null, '', route(path.startsWith('/') ? path : '/' + path) + location.search);
  return true;
}

// Intercept plain left clicks on same-origin app links so navigation doesn't
// throw away the running application and boot it again.
//
// Anchors stay the right element: middle-clickable, real destination in the
// status bar, and they work if this script never runs.
//
// Modified clicks are left to the browser. So is `data-document` - the legal
// pages and public site are documents on this origin, not routes, and routing
// them would show the app instead of the page.
export function interceptLinks(doc = document) {
  doc.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a || !doc.contains(a)) return;
    if (a.hasAttribute('download') || a.hasAttribute('data-document')) return;
    if (a.target && a.target !== '_self') return;

    const raw = a.getAttribute('href');
    if (!raw) return;
    // A legacy '#/route' href, from a page rendered before the move to paths.
    // Treating it as an in-page fragment is what left these links looking right
    // and doing nothing. Only the route shape qualifies, and the '#' is stripped
    // here rather than by routePath(), which no longer understands the fragment
    // form. Passing it through would navigate to '/#/route'.
    if (raw === '#/' || raw.startsWith('#/')) {
      e.preventDefault();
      navigate(routePath(raw.slice(1) || '/'));
      return;
    }
    // Every other '#...' is a same-page jump (the skip link, mostly) and the
    // browser already handles it.
    if (raw.startsWith('#')) return;

    let url;
    try { url = new URL(raw, location.href); } catch { return; }
    if (url.origin !== location.origin) return;
    // Outside the app's mount: a document belonging to the origin, not a route.
    if (BASE && url.pathname !== BASE && !url.pathname.startsWith(BASE + '/')) return;

    // Back to an app route: the router works in paths without the mount.
    e.preventDefault();
    navigate(unroute(url.pathname) + url.search + url.hash);
  }, { passive: false });
}

export default { navigate, route, unroute, routePath, currentPath, withQuery, adoptLegacyHash, interceptLinks, BASE };