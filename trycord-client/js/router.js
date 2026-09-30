// Routing.
//
// A pathname is resolved to a row in the route table (routes.js) and the row's
// work runs. Everything this file owns is what a table cannot: parsing the
// location, telling the shell what to paint before the view exists, deciding who
// is allowed where, and the one failure surface for a view that throws.
//
// The dispatch itself used to be a ~60-branch if-chain here. It is data now, so
// the shape of the application can be read in one place and adding a route does
// not mean finding the right spot in a wall of startsWith calls.

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

// The route table's rows register teardown through resolve.js, but the realtime
// repaint subscription belongs to the router, so it is handed over rather than
// imported by the module that would otherwise have to import the table back.
setViewRefreshCleaner(clearViewRefresh);

// A path is a path, optionally with a query. The mount is stripped so that
// '/app/settings' and '/settings' are one route rather than two, and a fragment
// is upgraded to the path form before this runs.
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

  // The shell is told what shape this surface is before anything paints. Doing
  // it here rather than in each page means a route cannot forget, and the chrome
  // that renders later already knows whether it has a sidebar to fill.
  setLayout(layoutForPath(path));

  // Published as the raw path first, then again from inside a community row once
  // a slug has been resolved to an id. The chrome compares against this, and it
  // matches the normalised /server/:id/... shape, so publishing only the raw
  // /c/:slug path would leave nothing highlighted.
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

  // The server list is what the rail, the sidebar and the community switcher all
  // read, so a session route cannot paint before it is in hand. A failure is not
  // fatal: surfaces that do not need it still render, and the ones that do show
  // their own empty state.
  if (row.auth === 'session') {
    try { await refreshServers().catch(() => {}); } catch { /* offline */ }
  }

  // A throw is not handled here. run() owns the failure surface, so there is one
  // error screen rather than one per call site: a page that swallowed its own
  // failure would leave the reader looking at a half-rendered view with no
  // explanation and no Retry.
  lastRoute = path;
  await row.run({ region, path, parts, query, publishRoute: (p) => setNavRoute(() => p) });
}

// Where a thrown value came from, when it carries a stack. Absent for anything
// the server sent as a JSON error envelope, which is correct: those have no JS
// origin and showing a bogus one would send a reader looking in the wrong file.
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
    // An arriving '#/settings' is rewritten onto '/settings' before the first
    // render, so old links and the desktop build's restored state keep working
    // and the address bar ends up canonical.
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
