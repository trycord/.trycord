// Navigation.
//
// The client is mounted under a prefix the server alone knows (/app/ on the
// hosted instance, / for a self-hoster). The module's own address carries that
// prefix, so every address is built from it and no module hardcodes where the
// client lives. Deriving it from <base> instead reads the wrong thing on a page
// served off disk, where the base is a directory rather than a mount.

const EXTERNAL = /^(https?:|mailto:|tel:|#$|blob:|data:)/i;

// The mount is derived from the module's own directory, which sits one level under
// the client root (`packages/nav.js`, or `js/nav.js` before the platform was split
// out). Stripping that one directory leaves the mount the server serves from, so the
// answer follows the file instead of a hard-coded `/app`. Getting this wrong is
// silent: every in-app link and every navigate() then carries an extra `/packages`.
export function mountFromModuleUrl(href) {
  let url;
  try { url = new URL('.', href); } catch { return ''; }
  // file:// and data: would give a filesystem path as a URL prefix. Desktop builds
  // served off disk get no mount.
  if (url.protocol === 'file:' || url.protocol === 'data:') return '';
  const mount = url.pathname.replace(/(?:^|\/)(?:js|packages)\/$/, '/');
  if (mount === '/' || !mount.startsWith('/')) return '';
  return mount.replace(/\/$/, '');
}

function mountPoint() {
  return mountFromModuleUrl(import.meta.url);
}

export const BASE = mountPoint();

// Cursor into the in-app history, so a back/forward can be told apart by index.
// Read from history.state so a reload keeps its place.
let cursor = readCursor();
// The first paint is not a move between screens, so it is not animated.
let direction = 'initial';

function readCursor() {
  try {
    const state = window.history && window.history.state;
    if (state && typeof state.index === 'number') return state.index;
  } catch { /* no history */ }
  return 0;
}

function entry(route, index) {
  return { route, index };
}

// 'forward' | 'back' | 'replace' | 'same'. Only the first two are animated.
export function navigationDirection() {
  return direction;
}

// False on a first-load deep link, where Back would leave the app.
export function canGoBack() {
  return cursor > 0;
}

// An absolute, in-document address for a route. Route strings never carry the
// mount prefix themselves. Idempotent, because some callers hand over a path
// that was already mounted.
export function path(route) {
  const clean = String(route || '/');
  if (EXTERNAL.test(clean) || clean.startsWith('//')) return clean;
  if (!clean.startsWith('/')) return clean;
  if (BASE && (clean === BASE || clean.startsWith(BASE + '/'))) return clean;
  return BASE + clean;
}

// An address for the public site, which is served at the origin root by the same
// deployment rather than under the application mount. path() would prefix these
// with /app and hand the click to the router, which has no public page to draw.
// Exported so the callers that mean "the public site" say so rather than
// hand-writing a leading slash that reads like the same thing path() gives.
export function publicPath(route) {
  const clean = String(route || '/');
  if (EXTERNAL.test(clean) || clean.startsWith('//')) return clean;
  return clean.startsWith('/') ? clean : '/' + clean;
}

// The current route as the router sees it: always leading-slash, never
// carrying the mount prefix.
export function currentRoute() {
  const pathname = String(window.location.pathname || '/');
  if (!BASE) return '/' + pathname.replace(/^\/+/, '');
  if (pathname === BASE) return '/';
  const rest = pathname.startsWith(BASE + '/') ? pathname.slice(BASE.length) : pathname;
  return '/' + rest.replace(/^\/+/, '');
}

export function currentQuery() {
  try { return new URLSearchParams(window.location.search); } catch { return new URLSearchParams(); }
}

export function currentHash() {
  try { return window.location.hash || ''; } catch { return ''; }
}

export function navigate(route, options) {
  const opts = options || {};
  const clean = String(route || '/');
  const target = path(clean);
  if (target === window.location.pathname && !opts.force) {
    direction = 'same';
    notify(clean, { same: true });
    return;
  }
  if (opts.replace) {
    // A redirect does not grow the stack: it corrects the entry that is already
    // showing, so it keeps the cursor where it is and does not animate.
    window.history.replaceState(entry(clean, cursor), '', target);
    direction = 'replace';
  } else {
    cursor += 1;
    window.history.pushState(entry(clean, cursor), '', target);
    direction = 'forward';
  }
  notify(clean, opts);
}

// pushState does not fire popstate, and the router has to hear about a route it
// itself asked for, so the notification is explicit rather than assumed.
function notify(route, options) {
  window.dispatchEvent(new window.CustomEvent('trycord:navigate', { detail: { route, options: options || {} } }));
}

// Intercept internal link clicks at the document, so a view writes a plain
// <a href> and still gets client-side navigation, middle-click and copy-link
// included. Modified clicks and external origins are left to the browser.
export function installLinkHandler() {
  document.addEventListener('click', (event) => {
    if (event.defaultPrevented) return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    const anchor = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    if (!anchor) return;
    if (anchor.target && anchor.target !== '_self') return;
    if (anchor.hasAttribute('download') || anchor.dataset.external === 'true') return;

    let url;
    try { url = new URL(anchor.href, window.location.href); } catch { return; }
    if (url.origin !== window.location.origin) return;
    if (url.pathname.indexOf(BASE) !== 0) return;

    const route = '/' + url.pathname.slice(BASE.length).replace(/^\/+/, '');
    const here = window.location.pathname + window.location.search;
    const there = url.pathname + url.search;
    event.preventDefault();
    if (here === there) {
      notify(route, { same: true });
      return;
    }
    cursor += 1;
    window.history.pushState(entry(route, cursor), '', there + url.hash);
    direction = 'forward';
    notify(route, { fromLink: true });
    window.scrollTo(0, 0);
  });
}

export function installPopStateHandler() {
  window.addEventListener('popstate', () => {
    // The platform moved the cursor: the entry it landed on carries the index it
    // was stamped with, and comparing it with where we were is the one honest way
    // to know whether this was a step back or a step forward.
    const next = readCursor();
    direction = next < cursor ? 'back' : 'forward';
    cursor = next;
    notify(currentRoute(), { pop: true });
  });
}
