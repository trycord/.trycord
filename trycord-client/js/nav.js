// Navigation.
//
// Routes live in the path. They used to live in the fragment, and 46 call sites
// still wrote '#/settings' when this was last touched. The fragment form is gone
// for two reasons. The fragment is never sent to the server, so a bookmarked
// fragment URL is not a route until JavaScript has booted - which meant a shared
// link and a refresh were two different behaviours. And having two ways to name
// one route is two ways for them to disagree.
//
// So navigation is one function, and a route is one string. adoptLegacyHash()
// still upgrades a fragment URL that arrives from a bookmark, which is the only
// remaining place the old form is understood; nothing in this codebase produces
// one.

// The client's own routes, which must not be mistaken for navigation.
const EXTERNAL = /^(https?:|mailto:|tel:|#$|blob:|data:)/i;

// Where the app is mounted, derived from this module's own URL rather than
// hard-coded. trycord-client/js/nav.js is served at /js/nav.js on a
// self-hosted instance and at /app/js/nav.js on the hosted deployment, and the
// difference matters: a route written as '/settings' is absolute, so from under
// /app/ it leaves the app entirely and lands on whatever else the origin
// serves. Deriving the mount point is what makes one set of route literals
// correct on both.
function mountPoint() {
  let pathname;
  try {
    const u = new URL('.', import.meta.url);
    // A file:// module is not a web deployment. Deriving a mount point from it
    // would produce a filesystem path as a URL prefix, which is worse than not
    // having one, so a desktop build served straight off disk falls back to the
    // origin root.
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

/**
 * '/settings' -> '/app/settings' where that is where the app lives.
 *
 * Idempotent. The link builders already return a mounted path - serverPath()
 * and channelPath() both go through here - and those results are then passed to
 * navigate(), which routes again. A second application of the mount is what
 * turned /c/slug into /app/app/c/slug on a subpath deployment and sent the
 * reader to a route that does not exist. A route never legitimately begins with
 * the mount, so returning an already-mounted path unchanged is safe.
 */
export function route(path) {
  if (!path) return BASE || '/';
  if (EXTERNAL.test(path) || /^\/\//.test(path)) return path;
  if (!path.startsWith('/')) return path;
  if (BASE && (path === BASE || path.startsWith(BASE + '/'))) return path;
  return BASE + path;
}

/** The route without the mount: '/app/settings' -> '/settings'. */
export function unroute(path) {
  if (!BASE || !path) return path;
  if (path === BASE) return '/';
  return path.startsWith(BASE + '/') ? path.slice(BASE.length) : path;
}

/**
 * A navigation target as a route path, or null if it is not one of ours.
 *
 * A leading '#' is no longer stripped. Routes are paths: the fragment form
 * existed because the app used to live in it, and every call site has been
 * converted. Accepting it silently would mean a typo like '#/dms' still worked,
 * which is the opposite of what removing the hash was for - and it would keep the
 * second addressing scheme alive in a codebase that is supposed to have one.
 * An old fragment URL is still handled once, by adoptLegacyHash.
 */
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
    // Not ours. A full URL to another origin has to be a real navigation or the
    // SPA stays mounted on the old origin, which reads as the link not working.
    if (/^(https?:)?\/\//i.test(String(target).trim())) {
      window.location.assign(String(target).trim());
      return;
    }
    // A fragment with no path is a real anchor on this page, not a route.
    location.hash = String(target);
    return;
  }
  if (opts.external) {
    // route() is a no-op on a full URL and adds the mount to a path, so this
    // cannot hand a relative route to another origin.
    window.location.assign(route(path));
    return;
  }
  const current = location.pathname + location.search;
  // A route, not a URL: the mount is added once, here, and route() is
  // idempotent so a caller that passed an already-mounted path is unaffected.
  const next = route(path.startsWith('/') ? path : '/' + path);
  if (next === current && !opts.force) {
    // Already there. Pushing a duplicate entry would make Back do nothing
    // visible, which is worse than not pushing at all.
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

/**
 * Move an old fragment URL onto the path form, once, and drop the fragment.
 *
 * Links to the fragment form already exist in bookmarks, in the desktop build's
 * stored window state, and in messages people have sent each other. Rather than
 * break those, they are upgraded on arrival: the route is identical, and the
 * address bar ends up canonical.
 */
export function adoptLegacyHash() {
  const hash = location.hash;
  if (!hash || hash.length < 2) return false;
  // Stripped here rather than in routePath(), which no longer knows about the
  // fragment form. This is the only code left that does, and it exists only for
  // URLs that were already in the wild before the move to paths.
  const path = routePath(hash.slice(1) || '/');
  if (path === null) return false;
  // Through route(), like every other navigation. Writing the route path
  // straight into history put '/app/#/settings' at '/settings' on a subpath
  // deployment: the fragment form is the only way an old URL can arrive under a
  // mount, and it is the one place that dropped the mount, so the app handed its
  // own route to the public site.
  history.replaceState(null, '', route(path.startsWith('/') ? path : '/' + path) + location.search);
  return true;
}

/**
 * Route the app's own links instead of reloading the document.
 *
 * Anchors are the right element for these links - they are middle-clickable,
 * they put a real destination in the status bar, and they still work if this
 * script never runs. But without something listening, a left click asks the
 * server for the page, throws away the running application and boots it again.
 * That is the fragment-era behaviour path routing was supposed to end, and it
 * made every Settings click a cold start.
 *
 * Only the plain left click on a same-origin link inside the app is taken over.
 * Modified clicks keep the browser's own behaviour so open-in-new-tab and
 * open-in-new-window keep working, and an anchor marked `data-document` is left
 * alone: the legal pages and the public site are documents on this origin, not
 * routes, and serving them through the router would show the app instead.
 */
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
    // form - passing it straight through would navigate to '/#/route'.
    if (raw === '#/' || raw.startsWith('#/')) {
      e.preventDefault();
      navigate(routePath(raw.slice(1) || '/'));
      return;
    }
    // Every other '#...' is a same-page jump - the skip link above all - and the
    // browser already does the right thing with it.
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