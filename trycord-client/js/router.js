// Routing.
//
// A pathname resolves to a row in routes.js and the row's work runs. What's left
// here is what a table can't do: parse the location, tell the shell what to
// paint before the view exists, decide who goes where, and own the single
// failure surface.
//
// Dispatch used to be a ~60-branch if-chain in this file. It's data now, so the
// shape of the app can be read in one place.

import { isAuthed, refreshServers, clearViewRefresh } from './state.js';
import { closeDesktopNav } from './presentation.js';
import { setNavRoute, renderAllChrome, renderContextHeader } from './shell.js';
import { navigate, adoptLegacyHash, interceptLinks, BASE } from './nav.js';
import { setLayout, layoutForPath } from './layout.js';
import { matchRoute, HOME_ROUTE } from './routes.js';
import { runCleanup, setViewRefreshCleaner } from './resolve.js';
import { el, clear } from './ui.js';

let lastRoute = '';

function viewRegion() {
  return document.getElementById('view-root');
}

// Rows register teardown through resolve.js. This one belongs to the router, so
// it's handed over rather than imported back into the table.
setViewRefreshCleaner(clearViewRefresh);

// The mount is stripped so '/app/settings' and '/settings' are one route.
function parseLocation() {
  let pathname = location.pathname || '/';
  if (BASE && pathname.startsWith(BASE)) pathname = pathname.slice(BASE.length) || '/';
  const qIndex = pathname.indexOf('?');
  let query = {};
  if (qIndex !== -1) {
    const search = new URLSearchParams(pathname.slice(qIndex + 1));
    query = Object.fromEntries(search.entries());
    pathname = pathname.slice(0, qIndex);
  }
  const path = pathname || '/';
  if (!path.startsWith('/')) return { path: '/', parts: [], query };
  return { path, parts: path.split('/').filter(Boolean).map(decodeURIComponent), query };
}

async function renderRoute() {
  const { path, parts, query } = parseLocation();
  document.documentElement.dataset.route = path || '/';
  delete document.documentElement.dataset.authPage;
  for (const stray of document.querySelectorAll('body > .auth-page')) stray.remove();
  document.documentElement.dataset.session = isAuthed() ? 'in' : 'out';
  const region = viewRegion();
  if (!region) return;

// Before anything paints, so a route can't forget and the chrome knows whether
// it has a sidebar to fill.
  setLayout(layoutForPath(path));

// Raw first, then again from inside a community row once a slug resolves to an
// id. Chrome matches the normalised /server/:id/... shape, so publishing only
// /c/:slug would highlight nothing.
  setNavRoute(() => path);
  runCleanup();
  closeDesktopNav();

  const row = matchRoute(path) || HOME_ROUTE;
  const authed = isAuthed();

  if (row.auth === 'guest' && authed) { navigate(row.guestTo || '/home'); return; }
  if (row.auth === 'session' && !authed) {
    renderAllChrome();
    navigate('/login');
    return;
  }

// The rail, sidebar and switcher all read this. Failure isn't fatal - surfaces
// that need it show their own empty state.
  if (row.auth === 'session') {
    try { await refreshServers().catch(() => {}); } catch { /* offline */ }
  }

// Not handled here: run() owns the failure surface, so there's one error screen
// rather than one per call site.
  lastRoute = path;
  await row.run({ region, path, parts, query, publishRoute: (p) => setNavRoute(() => p) });
}

// Where a throw came from, if it has a stack. Null for a server JSON error
// envelope - those have no JS origin, and a bogus one sends a reader to the
// wrong file.
function faultOrigin(ex) {
  if (!ex || typeof ex.stack !== 'string' || !ex.stack.trim()) return null;
  const frame = ex.stack.split('\n').slice(1).map((l) => l.trim())
    .find((l) => l && !/^at .*\b(eval|<anonymous>)\b/.test(l));
  return frame ? frame.replace(/^at\s+/, '') : null;
}

async function run() {
  try {
    return await renderRoute();
  } catch (ex) {
    const region = viewRegion();
    const origin = faultOrigin(ex);
    if (region) {
      clear(region);
      renderContextHeader({ title: 'Unable to load this view' });
      region.appendChild(el('div', { class: 'empty-state' },
        el('div', { class: 'form-error' }, ex && ex.message ? ex.message : 'Please try again.'),
        // The message alone has repeatedly been ambiguous - "Attempted to
        // assign to readonly property" names no file, and this screen is the
        // only surface a mobile user has. Surfacing the originating frame turns
        // an unactionable report into a locatable one.
        origin ? el('p', { class: 'muted small', 'data-fault-origin': origin }, origin) : null,
        el('div', { class: 'row-line' },
          el('button', { class: 'btn primary', type: 'button', onClick: () => { navigate('/home'); } }, 'Home'),
          el('button', { class: 'btn ghost', type: 'button', onClick: () => { run(); } }, 'Retry'))));
    }
    // Also to the console: the on-screen copy is for a reader without devtools.
    try { console.error('[trycord] view failed', ex); } catch { /* ignore */ }
    renderAllChrome();
    return null;
  }
}

const Router = {
  init() {
// A fragment URL from a bookmark or the desktop build's restored window state
// is rewritten onto its path form before the first render. Nothing in the client
// produces one any more.
    const adopted = adoptLegacyHash();
    interceptLinks();
    window.addEventListener('popstate', () => run());
    const first = run();
    if (adopted) first.catch(() => {});
    return first;
  },
  run,
};

export default Router;
