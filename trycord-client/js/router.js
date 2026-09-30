// Hash router. Maps #/... routes to real page renderers. Guards routes,

import { isAuthed, refreshServers, clearViewRefresh } from './state.js';
import PagesPublic from './pages-public.js';
import { renderHome } from './pages-home.js';
import { renderBrowse } from './pages-browse.js';
import HelloDms from './pages-dms.js';
// There is deliberately no `Workspace.*` facade any more: the old single
import { renderMenu, renderNewServer, renderServerLanding } from './pages-community.js';
import { renderChannel, renderChannelPins } from './pages-conversation.js';
import { renderServerMembers } from './pages-members.js';
import { renderServerRoles } from './pages-roles.js';
import { renderNewChannel, renderServerCategories } from './pages-channels.js';
import { renderInvites } from './pages-invites.js';
import { renderServerSettings } from './pages-settings.js';
import { renderAccount } from './pages-account.js';
import { renderAdmin } from './pages-admin.js';
import { renderAdminPages } from './pages-admin-pages.js';
import { renderProfile } from './pages-profile.js';
import { renderSupport, renderMyAppeals, renderNewAppeal } from './pages-support.js';
import { renderNotifications } from './pages-notifications.js';
import { presentationMode, closeDesktopNav } from './presentation.js';
import { setNavRoute, renderAllChrome, renderContextHeader } from './shell.js';
import { navigate, adoptLegacyHash, interceptLinks, BASE } from './nav.js';
import { setLayout, layoutForPath, layoutUsesSidebar } from './layout.js';
import Api from './api.js';

// A slug is a display convenience, not an identity, so a route that cannot
// resolve one says so plainly instead of rendering an empty page that looks
// like a broken app.
function renderRouteError(region, message) {
  region.replaceChildren();
  region.appendChild(el('div', { class: 'empty-state' }, [
    el('p', {}, message),
    el('a', { class: 'btn', href: '/' }, 'Go home'),
  ]));
}

// Both accept an id or a slug, because a link may be either: copied from the
// address bar after the move to slugs, or shared before it. A failed lookup
// returns null rather than throwing, so an unknown community reads as a dead
// link and not a crash.
async function resolveCommunity(token) {
  try {
    const row = await Api.server(token);
    return row && row.id ? { serverId: row.id } : null;
  } catch {
    return null;
  }
}

// Always resolved inside the community. A channel slug is unique per community
// and not globally, so resolving one without that context would be a guess - and
// a guess here can land on somebody else's channel.
async function resolveChannelToken(serverId, token) {
  try {
    const list = await Api.channels(serverId);
    const chans = (list && list.channels) || [];
    const hit = chans.find((c) => String(c.slug) === String(token) || String(c.id) === String(token));
    return hit ? hit.id : null;
  } catch {
    return null;
  }
}
import { el, clear, toast } from './ui.js';
import { serverPath } from './links.js';

let lastCleanup = null;
let lastRoute = '';

function viewRegion() {
  return document.getElementById('view-root');
}

function runCleanup() {
  if (lastCleanup) { try { lastCleanup(); } catch { /* ignore */ } lastCleanup = null; }
  // A realtime community event must never repaint the view we just left.
  try { clearViewRefresh(); } catch { /* ignore */ }
}

function setCleanup(fn) {
  runCleanup();
  lastCleanup = fn;
}

// A hash carries a path and, optionally, a query: #/server/s/channel/c?m=<id>.
function parseLocation() {
  // Routes are paths. A fragment still on the URL is an old link; nav.js has
  // already rewritten it onto the path form before this runs.
  //
  // The mount point comes off first. Where the app is served from a subpath the
  // pathname still carries it - /app/settings, not /settings - and without
  // stripping it the first route segment is the mount directory itself, which
  // matches no branch and drops every deep link onto the default route.
  let pathname = location.pathname || '/';
  if (BASE && pathname.startsWith(BASE)) pathname = pathname.slice(BASE.length) || '/';
  const raw = pathname + (location.search || '');
  const qIndex = raw.indexOf('?');
  const path = qIndex === -1 ? raw : raw.slice(0, qIndex);
  const query = {};
  if (qIndex !== -1) {
    for (const [k, v] of new URLSearchParams(raw.slice(qIndex + 1))) query[k] = v;
  }
  if (!path || path === '/') return { path: '/', parts: [], query };
  // Mutable: the V2 /c/... form is rewritten into the legacy /server/... shape
  // below so a single set of route branches serves both. The old routes are
  // kept working rather than removed because links to them already exist.
  let parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  return { path, parts, query };
}

function requireAuth() {
  if (!isAuthed()) {
    return false;
  }
  return true;
}

async function renderRoute() {
  // `route` is the raw hash split into segments. It is rebound - never mutated
  // in place - when a V2 path is normalised below, so it is deliberately `let`
  // while the destructured view of it is not.
  let { path, parts: route, query } = parseLocation();
  document.documentElement.dataset.route = path || '/';
    // fixed-position and escapes the desktop shell's grid, but it still has to
    delete document.documentElement.dataset.authPage;
  for (const stray of document.querySelectorAll('body > .auth-page')) stray.remove();
  // Session state as a styling hook. Without a session there is no rail and
  // session rather than the route fixes every such page at once, instead of
  document.documentElement.dataset.session = isAuthed() ? 'in' : 'out';
  const region = viewRegion();
  if (!region) return;

  // The shell is told what shape this surface is before anything paints. Doing
  // it here rather than in each page means a route cannot forget, and the chrome
  // that renders later already knows whether it has a sidebar to fill.
  setLayout(layoutForPath(path));

  setNavRoute(() => path);
  runCleanup();

  // The route the chrome compares against. Published again after a V2 slug is
  // resolved, so the sidebar's active highlighting keeps working no matter which
  // form the URL arrived in: the shell matches on the normalised
  // /server/:id/... shape, and matching against the raw /c/:slug path would
  // silently leave nothing highlighted.
  const publishRoute = (p) => setNavRoute(() => p);

  closeDesktopNav();

  if (path.startsWith('/login') || path === '' || path === '/') {
    if (isAuthed()) { navigate('#/home'); return; }
    renderContextHeader({});
    PagesPublic.login(region);
    setNavRoute(() => '/login');
    document.documentElement.dataset.route = '/login';
    renderAllChrome();
    return;
  }
  if (path.startsWith('/register')) {
    if (isAuthed()) { navigate('#/home'); return; }
    PagesPublic.register(region);
    renderAllChrome();
    return;
  }
  if (path.startsWith('/forgot')) {
    if (isAuthed()) { navigate('#/home'); return; }
    PagesPublic.forgot(region);
    renderAllChrome();
    return;
  }
  if (path.startsWith('/reset-password/')) {
    if (isAuthed()) { navigate('#/home'); return; }
    PagesPublic.resetPassword(region, route[1]);
    renderAllChrome();
    return;
  }
  if (path.startsWith('/legal/')) {
    PagesPublic.legal(region, route[1]);
    renderAllChrome();
    return;
  }
  // Public email-verification link (single-use, token in the URL).
  if (path.startsWith('/verify-email/')) {
    PagesPublic.verify(region, route[1]);
    renderAllChrome();
    return;
  }

  if (path.startsWith('/discover')) {
    const previewId = route[1] || null;
    await renderBrowse(region, { previewId });
    renderAllChrome();
    return;
  }

  if (path.startsWith('/support/appeals/new')) {
    renderNewAppeal(region);
    renderAllChrome();
    return;
  }
  if (path.startsWith('/support/appeals')) {
    if (!requireAuth()) {
      renderAllChrome();
      navigate('#/login');
      return;
    }
    await renderMyAppeals(region);
    renderAllChrome();
    return;
  }
  if (path.startsWith('/support')) {
    await renderSupport(region);
    renderAllChrome();
    return;
  }

  // --- everything below requires a session -------------------------
  if (!requireAuth()) {
    renderAllChrome();
    navigate('#/login');
    return;
  }

  try { await refreshServers().catch(() => {}); } catch { /* offline */ }

  if (path.startsWith('/friends')) {
    setCleanup(() => { HelloDms.leaveDm(); });
    await HelloDms.renderFriendsPage(region);
    renderAllChrome();
    return;
  }
  if (path.startsWith('/dms/')) {
    setCleanup(() => { HelloDms.leaveDm(); });
    await HelloDms.renderDms(region, { id: route[1] });
    renderAllChrome();
    return;
  }
  if (path.startsWith('/dms')) {
    setCleanup(() => { HelloDms.leaveDm(); });
    await HelloDms.renderDms(region, {});
    renderAllChrome();
    return;
  }
  if (path.startsWith('/notifications')) {
    await renderNotifications(region);
    renderAllChrome();
    return;
  }
  if (path.startsWith('/menu')) {
    await renderMenu(region);
    renderAllChrome();
    return;
  }

  if (path.startsWith('/settings/updates')) { await renderAccount(region, { tab: 'updates' }); renderAllChrome(); return; }
  if (path.startsWith('/settings/appearance')) { await renderAccount(region, { tab: 'appearance' }); renderAllChrome(); return; }
  if (path.startsWith('/settings/password')) { await renderAccount(region, { tab: 'security' }); renderAllChrome(); return; }
  if (path.startsWith('/settings/sessions')) { await renderAccount(region, { tab: 'security' }); renderAllChrome(); return; }
  if (path.startsWith('/settings/security')) { await renderAccount(region, { tab: 'security' }); renderAllChrome(); return; }
  if (path.startsWith('/settings/backend')) { await renderAccount(region, { tab: 'backend' }); renderAllChrome(); return; }
  if (path.startsWith('/settings/privacy')) { await renderAccount(region, { tab: 'privacy' }); renderAllChrome(); return; }
  if (path.startsWith('/settings/notifications')) { await renderAccount(region, { tab: 'notifications' }); renderAllChrome(); return; }
  if (path.startsWith('/settings')) { await renderAccount(region, { tab: 'profile' }); renderAllChrome(); return; }
  if (path.startsWith('/account/updates')) { await renderAccount(region, { tab: 'updates' }); renderAllChrome(); return; }
  if (path.startsWith('/account/appearance')) { await renderAccount(region, { tab: 'appearance' }); renderAllChrome(); return; }
  if (path.startsWith('/account/password')) { await renderAccount(region, { tab: 'security' }); renderAllChrome(); return; }
  if (path.startsWith('/account/sessions')) { await renderAccount(region, { tab: 'security' }); renderAllChrome(); return; }
  if (path.startsWith('/account/security')) { await renderAccount(region, { tab: 'security' }); renderAllChrome(); return; }
  if (path.startsWith('/account/backend')) { await renderAccount(region, { tab: 'backend' }); renderAllChrome(); return; }
  if (path.startsWith('/account/privacy')) { await renderAccount(region, { tab: 'privacy' }); renderAllChrome(); return; }
  if (path.startsWith('/account/notifications')) { await renderAccount(region, { tab: 'notifications' }); renderAllChrome(); return; }
  if (path.startsWith('/account')) { await renderAccount(region, { tab: 'profile' }); renderAllChrome(); return; }

  if (path === '/admin/pages' || path.startsWith('/admin/pages/')) {
    await renderAdminPages(region, { route: route[2] || null });
    renderAllChrome();
    return;
  }
  if (path.startsWith('/admin/')) {
    const adminSection = route[1] === 'servers' ? 'communities' : (route[1] || 'overview');    await renderAdmin(region, { section: adminSection });
    renderAllChrome();
    return;
  }
  if (path.startsWith('/admin')) {
    await renderAdmin(region, { section: 'overview' });
    renderAllChrome();
    return;
  }

  if (path.startsWith('/invite/')) {
    const code = route[1];
    renderContextHeader({ title: 'Joining', sub: code });
    clear(region);
    region.appendChild(el('div', { class: 'empty-state' }, 'Joining…'));
    try {
      const res = await Api.joinInvite(code);
      await refreshServers();
      toast('You joined the community.', 'ok');
      navigate(serverPath(res.serverId));
      return;
    } catch (ex) {
      clear(region);
      region.appendChild(el('div', { class: 'form-error' }, ex.message || 'Invite invalid'));
      renderAllChrome();
      return;
    }
  }

  if (path.startsWith('/users/')) {
    // A username is the V2 form and a UUID still works. The profile renderer
    // takes whatever the server accepts, and it accepts both.
    await renderProfile(region, { id: route[1] });
    renderAllChrome();
    return;
  }

  if (path.startsWith('/servers/new')) {
    await renderNewServer(region);
    renderAllChrome();
    return;
  }

  // V2 community routes: #/c/:slug and #/c/:slug/channel/:channelSlug.
  // Resolved to ids here, once, and then handed to the same renderers the
  // legacy /server/:id routes use. Resolution goes through the server-scoped
  // API, so a channel slug is always resolved inside its own community and can
  // never reach another one's channel.
  if (route[0] === 'c' && route[1]) {
    const community = await resolveCommunity(route[1]);
    if (!community) return renderRouteError(region, 'That community does not exist.');
    route = ['server', community.serverId].concat(route.slice(2));
    publishRoute('/' + route.join('/'));
  }

  if (route[0] === 'server' && route[1]) {
    // A legacy id route may still carry a channel slug, and a V2 route carries
    // the channel token verbatim. Either way it is resolved inside the
    // community, so one lookup serves both.
    const serverId = route[1];
    const what = route[2];
    if (what === 'channel' && route[3]) {
      const resolved = await resolveChannelToken(serverId, route[3]);
      if (!resolved) return renderRouteError(region, 'That channel does not exist.');
      // Republished so the sidebar marks the right channel as current.
      if (resolved !== route[3]) {
        route[3] = resolved;
        publishRoute('/' + route.join('/'));
      }
    }
    if (what === 'channel' && route[3] && route[4] === 'pins') {
      setCleanup(() => { try { region._cleanup && region._cleanup(); } catch { /* ignore */ } });
      await renderChannelPins(region, serverId, route[3]);
      renderAllChrome();
      return;
    }
    if (what === 'channel' && route[3]) {
      setCleanup(() => { try { region._cleanup && region._cleanup(); } catch { /* ignore */ } });
      await renderChannel(region, serverId, route[3], { focusMessage: query.m || null });
      renderAllChrome();
      return;
    }
    if (what === 'channels') { // /server/:id/channels/new
      await renderNewChannel(region, serverId);
      renderAllChrome();
      return;
    }
    if (what === 'invites') {
      await renderInvites(region, serverId);
      renderAllChrome();
      return;
    }
    if (what === 'members') {
      await renderServerMembers(region, serverId);
      renderAllChrome();
      return;
    }
    if (what === 'roles') {
      await renderServerRoles(region, serverId);
      renderAllChrome();
      return;
    }
    if (what === 'categories') {
      await renderServerCategories(region, serverId);
      renderAllChrome();
      return;
    }
    if (what === 'settings') {
      const known = ['overview', 'appearance', 'structure', 'members', 'roles', 'invites', 'moderation', 'ownership'];
      const section = route[3] && known.includes(route[3]) ? route[3] : 'overview';
      await renderServerSettings(region, serverId, section);
      renderAllChrome();
      return;
    }
    if (route.length === 2) {
      await renderServerLanding(region, serverId);
      renderAllChrome();
      return;
    }
    await renderServerLanding(region, serverId);
    renderAllChrome();
    return;
  }

  await renderHome(region);
  renderAllChrome();
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
          el('button', { class: 'btn primary', type: 'button', onClick: () => { navigate('#/home'); } }, 'Home'),
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
