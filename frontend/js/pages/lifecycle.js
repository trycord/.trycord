// What happens around a page.
//
// The router decides *which* page. This decides what surrounds it: who is allowed
// in, what the previous page gets to clean up, when the shell's chrome is painted,
// and what a page that throws looks like.
//
// Those four used to be spread across the route table and the router, which meant
// every one of the twenty-odd routes had to remember to call renderAllChrome() and
// a page that forgot left stale navigation next to fresh content. There were
// twenty-five of those calls. There are none now.

import { matchRoute, HOME_PAGE } from './registry.js';
import { HANDLERS } from './handlers.js';
import { isAuthed, refreshServers } from '../state.js';
import { setLayout } from '../layout.js';
import { setNavRoute, renderAllChrome, renderContextHeader } from '../shell.js';
import { navigate } from '../nav.js';
import { closeDesktopNav } from '../presentation.js';
import { el, clear, qs } from '../ui.js';
import { onCleanup, runTeardowns } from './teardown.js';
import { clearViewRefreshNow } from '../resolve.js';

// Retry re-mounts the address that failed. It is remembered here rather than
// reached through the router, because importing the router back into the module
// that the router starts would be a cycle for the sake of one call.
let lastPath = '/';

const splitSegments = (path) => String(path || '')
  .split('?')[0].split('/').filter(Boolean).map(decodeURIComponent);

function clearAuthPages() {
  for (const stray of document.querySelectorAll('body > .auth-page')) stray.remove();
}

/**
 * Resolve an address to a page, its parameters and whatever is left over.
 *
 * `rest` matters: /admin/pages/terms is one page addressing something inside it,
 * and without the leftovers the page editor loses which document was asked for.
 */
export function resolve(path) {
  return matchRoute(path) || { page: HOME_PAGE, params: {}, rest: [] };
}

/**
 * Mount the page for a path.
 *
 * Returns the page, so a caller can ask what it ended up on. Never throws: a page
 * that fails gets the failure surface and the shell keeps working, because one bad
 * page must not take the application with it.
 */
export async function mount(path, query = {}) {
  lastPath = path;
  const region = qs('#view-root');
  if (!region) return null;

  const { page, params, rest } = resolve(path);
  document.documentElement.dataset.route = path || '/';
  delete document.documentElement.dataset.authPage;
  clearAuthPages();
  document.documentElement.dataset.session = isAuthed() ? 'in' : 'out';

  // Teardown before anything else. The previous page's listeners must be gone
  // before its replacement starts making requests.
  //
  // The realtime repaint subscription goes with them. It is the one subscription
  // that is not registered per page - the router owns it for the whole session -
  // and clearing it here is what stops a community event repainting the view you
  // just left, which is how a channel jumps out from under you.
  runTeardowns();
  clearViewRefreshNow();

  // Before the view exists, so the chrome knows what shape to paint.
  setLayout(page.layout);
  // Raw first; the community handler republishes it in the id-shaped form the
  // chrome matches on.
  setNavRoute(() => path);
  closeDesktopNav();

  const authed = isAuthed();

  if (page.access === 'guest' && authed) {
    navigate(page.guestTo || '/home');
    return page;
  }
  if (page.access === 'session' && !authed) {
    renderAllChrome();
    navigate('/login');
    return page;
  }

  if (page.access === 'session') {
    // The rail, the sidebar and the switcher all read this. Failure is not fatal -
    // a surface that needs it paints its own empty state.
    try { await refreshServers(); } catch { /* offline */ }
  }

  const handler = HANDLERS[page.id];
  if (!handler) {
    // A page with no renderer is a mistake in the registry, and saying so beats a
    // blank pane.
    return fail(region, new Error('No renderer for page ' + page.id));
  }

  const ctx = {
    region, path, params, rest, query, page,
    // The path's segments, decoded. `params` is what the registry's pattern
    // matched and `rest` is what is left over; a handler that has to walk the
    // address itself - the community tree does, because a channel's id is only
    // known after a lookup - wants the segments. It was missing from the first
    // version of this, and every community route threw on parts[0].
    parts: splitSegments(path),
    publishRoute: (next) => setNavRoute(() => next),
    onCleanup,
  };

  try {
    const painted = await handler(ctx, page);
    // A handler that returns false has navigated or redirected; there is no new
    // chrome to paint over what it left.
    if (painted !== false) renderAllChrome();
    return page;
  } catch (ex) {
    return fail(region, ex);
  }
}

// Where a throw came from, if it has a stack. Null for a server JSON envelope,
// which has no JS origin and would send a reader to a file that cannot help.
function faultOrigin(ex) {
  if (!ex || typeof ex.stack !== 'string' || !ex.stack.trim()) return null;
  const frame = ex.stack.split('\n').slice(1).map((l) => l.trim())
    .find((l) => l && !/^at .*\b(eval|<anonymous>)\b/.test(l));
  return frame ? frame.replace(/^at\s+/, '') : null;
}

function fail(region, ex) {
  clear(region);
  renderContextHeader({ title: 'Unable to load this view' });
  const origin = faultOrigin(ex);
  region.appendChild(el('div', { class: 'empty-state' },
    el('div', { class: 'form-error' }, (ex && ex.message) || 'Please try again.'),
    // The message alone has repeatedly been unusable - "Attempted to assign to
    // readonly property" names no file, and on a phone this is the only surface
    // there is. The originating frame turns an unactionable report into a locatable
    // one.
    origin ? el('p', { class: 'muted small', 'data-fault-origin': origin }, origin) : null,
    el('div', { class: 'row-line' },
      el('button', { class: 'btn primary', type: 'button', onClick: () => { navigate('/home'); } }, 'Home'),
      el('button', {
        class: 'btn ghost', type: 'button',
        onClick: () => { mount(lastPath); },
      }, 'Retry'))));
  // Also to the console: the copy on screen is for a reader without devtools.
  try { console.error('[trycord] view failed', ex); } catch { /* no console */ }
  renderAllChrome();
  return null;
}

export { onCleanup, runTeardowns };

export default { mount, resolve, runTeardowns, onCleanup };
