// Navigation.
//
// Routes used to live in the fragment: `location.hash = '#/settings'`, and 83
// assignments across 23 files did it by hand. Two problems with that beyond the
// ugliness of the URL. The fragment is not sent to the server, so a bookmarked
// route is not a route until JavaScript runs; and every one of those 83 sites
// was its own definition of "go somewhere", which is why half of them missed a
// case at some point.
//
// So navigation is one function. It takes the same strings the old code passed
// to location.hash - '#/home', '#/c/slug', with or without a query - and works
// out the real path. Call sites keep their existing literals; there is nothing
// to find and rewrite, and a route added later needs no new plumbing.

// The client's own routes, which must not be mistaken for navigation.
const EXTERNAL = /^(https?:|mailto:|tel:|#$|blob:|data:)/i;

/** '#/home' -> '/home'. Returns null for anything that is not our route. */
export function routePath(target) {
  if (target == null) return null;
  const raw = String(target).trim();
  if (!raw || EXTERNAL.test(raw)) return null;
  return raw.startsWith('#') ? raw.slice(1) || '/' : raw;
}

/**
 * Go to a route.
 *
 * @param {string} target  '#/home', '/home', or a full URL
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
    location.hash = String(target);   // a bare '#' anchor, not a route
    return;
  }
  if (opts.external) {
    window.location.assign(path);
    return;
  }
  const current = location.pathname + location.search;
  const next = path.startsWith('/') ? path : '/' + path;
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
  const path = routePath(hash);
  if (path === null) return false;
  history.replaceState(null, '', path + location.search);
  return true;
}

export default { navigate, routePath, currentPath, withQuery, adoptLegacyHash };