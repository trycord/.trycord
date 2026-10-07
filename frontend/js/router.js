// Routing. The pathname becomes a page via the registry, mounted by the lifecycle.
//
// This file keeps only what a table cannot do: read the location, handle the mount
// prefix and the query string, react to history.

import { mount } from './pages/lifecycle.js';
import { clearViewRefresh } from './state.js';
import { navigate, adoptLegacyHash, interceptLinks, BASE } from './nav.js';
import { setViewRefreshCleaner } from './resolve.js';

// This one belongs to the router rather than to the page lifecycle, so it is handed
// over instead of imported back the other way.
setViewRefreshCleaner(clearViewRefresh);

// The mount is stripped so '/app/settings' and '/settings' are one address.
function parseLocation() {
  let pathname = location.pathname || '/';
  if (BASE && pathname.startsWith(BASE)) pathname = pathname.slice(BASE.length) || '/';
  const qIndex = pathname.indexOf('?');
  let query = {};
  if (qIndex !== -1) {
    query = Object.fromEntries(new URLSearchParams(pathname.slice(qIndex + 1)).entries());
    pathname = pathname.slice(0, qIndex);
  }
  if (!pathname.startsWith('/')) return { path: '/', query };
  return { path: pathname, query };
}

async function run() {
  const { path, query } = parseLocation();
  return mount(path, query);
}

const Router = {
  init() {
    // A fragment URL from a bookmark or from the desktop build's restored window
    // state is rewritten onto its path form before the first render. Nothing the
    // client produces writes one any more.
    const adopted = adoptLegacyHash();
    interceptLinks();
    window.addEventListener('popstate', () => run());
    const first = run();
    if (adopted) first.catch(() => {});
    return first;
  },
  run,
  navigate,
};

export default Router;
