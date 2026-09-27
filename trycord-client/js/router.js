// Hash router. Maps #/... routes to real page renderers. Guards routes,
// re-renders the active shell's chrome, and cleans up listeners on change.

import { isAuthed, refreshServers, clearViewRefresh } from './state.js';
import PagesPublic from './pages-public.js';
import { renderHome } from './pages-home.js';
import { renderBrowse } from './pages-browse.js';
import HelloDms from './pages-dms.js';
// Community surfaces are imported from the feature module that owns each one.
// There is deliberately no `Workspace.*` facade any more: the old single
// pages-workspace.js mixed a conversation view, a member roster, the role
// hierarchy and community settings behind one default export, so every route
// reached every feature through the same namespace.
import { renderMenu, renderNewServer, renderServerLanding } from './pages-community.js';
import { renderChannel, renderChannelPins } from './pages-conversation.js';
import { renderServerMembers } from './pages-members.js';
import { renderServerRoles } from './pages-roles.js';
import { renderNewChannel, renderServerCategories } from './pages-channels.js';
import { renderInvites } from './pages-invites.js';
import { renderServerSettings } from './pages-settings.js';
import { renderAccount } from './pages-account.js';
import { renderAdmin } from './pages-admin.js';
import { renderProfile } from './pages-profile.js';
import { renderSupport, renderMyAppeals, renderNewAppeal } from './pages-support.js';
import { renderNotifications } from './pages-notifications.js';
import { presentationMode, closeMobileDrawer, closeDesktopNav } from './presentation.js';
import { setNavRoute, renderAllChrome, renderContextHeader, renderMobileHeader } from './shell.js';
import Api from './api.js';
import { el, clear, toast } from './ui.js';

let lastCleanup = null;
let lastRoute = '';

// The active view region depends on the presentation.
function viewRegion() {
  return presentationMode() === 'mobile'
    ? document.getElementById('mobile-main')
    : document.getElementById('view-root');
}

function activeShell() {
  return presentationMode() === 'mobile' ? 'mobile' : 'desktop';
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

function parseHash() {
  const raw = (location.hash || '#/').replace(/^#/, '');
  if (!raw || raw === '/') return { path: '/', parts: [] };
  const parts = raw.split('/').filter(Boolean).map(decodeURIComponent);
  return { path: raw, parts };
}

function requireAuth() {
  if (!isAuthed()) {
    return false;
  }
  return true;
}

async function renderRoute() {
    const { path, parts } = parseHash();
    document.documentElement.dataset.route = path || '/';
    // Cleared here and set only by the auth shell. A dedicated auth page is
    // fixed-position and escapes the desktop shell's grid, but it still has to
    // live inside a shell that is actually displayed - and below 600px the
    // mobile shell replaces the desktop one entirely. So the styling hook
    // follows the page that renders rather than a repeated list of routes.
    delete document.documentElement.dataset.authPage;
  // The auth overlay is mounted on <body> so that shell visibility rules cannot
  // collapse it (see the note in pages-public.js). Clearing the view region
  // therefore no longer removes it, so drop a leftover overlay here. Every
  // render passes through this point, which covers both re-rendering another
  // auth route and navigating away from one.
  for (const stray of document.querySelectorAll('body > .auth-page')) stray.remove();
  // Session state as a styling hook. Without a session there is no rail and
  // no context sidebar to render, but the desktop shell is still a fixed
  // three-column grid - so a signed-out visitor on any non-static route
  // (Support, Discover) got a 304px phantom gutter and every centred element
  // sat ~152px right of the viewport centre. Keying the collapse off the
  // session rather than the route fixes every such page at once, instead of
  // needing each one added to a route list.
  document.documentElement.dataset.session = isAuthed() ? 'in' : 'out';
  const region = viewRegion();
  if (!region) return;

  setNavRoute(() => path);
  runCleanup();

  closeMobileDrawer();
  closeDesktopNav();

  // --- public-only routes -----------------------------------------
  if (path.startsWith('/login') || path === '' || path === '/') {
    if (isAuthed()) { location.hash = '#/home'; return; }
    renderContextHeader({});
    PagesPublic.login(region);
    setNavRoute(() => '/login');
    // The default route renders the login surface. Normalize presentation state
    // so route-scoped auth layout applies to both `/` and `/login`.
    document.documentElement.dataset.route = '/login';
    renderAllChrome();
    return;
  }
  if (path.startsWith('/register')) {
    if (isAuthed()) { location.hash = '#/home'; return; }
    PagesPublic.register(region);
    renderAllChrome();
    return;
  }
  if (path.startsWith('/forgot')) {
    if (isAuthed()) { location.hash = '#/home'; return; }
    PagesPublic.forgot(region);
    renderAllChrome();
    return;
  }
  if (path.startsWith('/reset-password/')) {
    if (isAuthed()) { location.hash = '#/home'; return; }
    PagesPublic.resetPassword(region, parts[1]);
    renderAllChrome();
    return;
  }
  if (path.startsWith('/legal/')) {
    PagesPublic.legal(region, parts[1]);
    renderAllChrome();
    return;
  }
  // Public email-verification link (single-use, token in the URL).
  if (path.startsWith('/verify-email/')) {
    PagesPublic.verify(region, parts[1]);
    renderAllChrome();
    return;
  }

  // --- discover is public to browse, guarded to join -------------
  if (path.startsWith('/discover')) {
    const previewId = parts[1] || null;
    await renderBrowse(region, { previewId });
    renderAllChrome();
    return;
  }

  // --- support hub + appeals (submission is anonymous by design) ------
  if (path.startsWith('/support/appeals/new')) {
    renderNewAppeal(region);
    renderAllChrome();
    return;
  }
  if (path.startsWith('/support/appeals')) {
    if (!requireAuth()) {
      renderAllChrome();
      location.hash = '#/login';
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
    location.hash = '#/login';
    return;
  }

  // Warm the server list (we render chrome from it).
  try { await refreshServers().catch(() => {}); } catch { /* offline */ }

  // --- friends / dms -------------------------------------------------
  if (path.startsWith('/friends')) {
    setCleanup(() => { HelloDms.leaveDm(); });
    await HelloDms.renderFriendsPage(region);
    renderAllChrome();
    return;
  }
  if (path.startsWith('/dms/')) {
    setCleanup(() => { HelloDms.leaveDm(); });
    await HelloDms.renderDms(region, { id: parts[1] });
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

  // --- settings (account hub; /account* kept as working aliases) ----------
  if (path.startsWith('/settings/updates')) { await renderAccount(region, { tab: 'updates' }); renderAllChrome(); return; }
  if (path.startsWith('/settings/appearance')) { await renderAccount(region, { tab: 'appearance' }); renderAllChrome(); return; }
  if (path.startsWith('/settings/password')) { await renderAccount(region, { tab: 'security' }); renderAllChrome(); return; }
  if (path.startsWith('/settings/sessions')) { await renderAccount(region, { tab: 'security' }); renderAllChrome(); return; }
  if (path.startsWith('/settings/security')) { await renderAccount(region, { tab: 'security' }); renderAllChrome(); return; }
  if (path.startsWith('/settings/backend')) { await renderAccount(region, { tab: 'backend' }); renderAllChrome(); return; }
  if (path.startsWith('/settings')) { await renderAccount(region, { tab: 'profile' }); renderAllChrome(); return; }
  if (path.startsWith('/account/updates')) { await renderAccount(region, { tab: 'updates' }); renderAllChrome(); return; }
  if (path.startsWith('/account/appearance')) { await renderAccount(region, { tab: 'appearance' }); renderAllChrome(); return; }
  if (path.startsWith('/account/password')) { await renderAccount(region, { tab: 'security' }); renderAllChrome(); return; }
  if (path.startsWith('/account/sessions')) { await renderAccount(region, { tab: 'security' }); renderAllChrome(); return; }
  if (path.startsWith('/account/security')) { await renderAccount(region, { tab: 'security' }); renderAllChrome(); return; }
  if (path.startsWith('/account/backend')) { await renderAccount(region, { tab: 'backend' }); renderAllChrome(); return; }
  if (path.startsWith('/account')) { await renderAccount(region, { tab: 'profile' }); renderAllChrome(); return; }

  // --- platform admin ------------------------------------------------------
  if (path.startsWith('/admin/')) {
    const adminSection = parts[1] === 'servers' ? 'communities' : (parts[1] || 'overview');    await renderAdmin(region, { section: adminSection });
    renderAllChrome();
    return;
  }
  if (path.startsWith('/admin')) {
    await renderAdmin(region, { section: 'overview' });
    renderAllChrome();
    return;
  }

  // --- joins ------------------------------------------------------------
  if (path.startsWith('/invite/')) {
    const code = parts[1];
    renderContextHeader({ title: 'Joining', sub: code });
    clear(region);
    region.appendChild(el('div', { class: 'empty-state' }, 'Joining…'));
    try {
      const res = await Api.joinInvite(code);
      await refreshServers();
      toast('You joined the server.', 'ok');
      location.hash = '#/server/' + res.serverId;
      return;
    } catch (ex) {
      clear(region);
      region.appendChild(el('div', { class: 'form-error' }, ex.message || 'Invite invalid'));
      renderAllChrome();
      return;
    }
  }

  // --- profile -> public page ----------------------------------------------
  if (path.startsWith('/users/')) {
    await renderProfile(region, { id: parts[1] });
    renderAllChrome();
    return;
  }

  // --- servers -----------------------------------------------------
  if (path.startsWith('/servers/new')) {
    await renderNewServer(region);
    renderAllChrome();
    return;
  }
  if (parts[0] === 'server' && parts[1]) {
    const serverId = parts[1];
    const what = parts[2];
    if (what === 'channel' && parts[3] && parts[4] === 'pins') {
      setCleanup(() => { try { region._cleanup && region._cleanup(); } catch { /* ignore */ } });
      await renderChannelPins(region, serverId, parts[3]);
      renderAllChrome();
      return;
    }
    if (what === 'channel' && parts[3]) {
      setCleanup(() => { try { region._cleanup && region._cleanup(); } catch { /* ignore */ } });
      await renderChannel(region, serverId, parts[3]);
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
      // Sections live under /server/:id/settings/<section> so each one is
      // linkable and the back button behaves. An unknown section falls back to
      // the overview rather than rendering a blank page.
      const known = ['overview', 'appearance', 'structure', 'members', 'roles', 'invites', 'moderation', 'ownership'];
      const section = parts[3] && known.includes(parts[3]) ? parts[3] : 'overview';
      await renderServerSettings(region, serverId, section);
      renderAllChrome();
      return;
    }
    if (parts.length === 2) {
      await renderServerLanding(region, serverId);
      renderAllChrome();
      return;
    }
    await renderServerLanding(region, serverId);
    renderAllChrome();
    return;
  }

  // --- home as default ---------------------------------------------------
  await renderHome(region);
  renderAllChrome();
}

async function run() {
  try {
    return await renderRoute();
  } catch (ex) {
    // A failed data request must not strand the desktop shell with the last
    // view cleared. Keep real navigation mounted and give the user a route
    // back to the live application.
    const region = viewRegion();
    if (region) {
      clear(region);
      renderContextHeader({ title: 'Unable to load this view' });
      region.appendChild(el('div', { class: 'empty-state' },
        el('div', { class: 'form-error' }, ex && ex.message ? ex.message : 'Please try again.'),
        el('div', { class: 'row-line' },
          el('button', { class: 'btn primary', type: 'button', onClick: () => { location.hash = '#/home'; } }, 'Home'),
          el('button', { class: 'btn ghost', type: 'button', onClick: () => { run(); } }, 'Retry'))));
    }
    renderAllChrome();
    return null;
  }
}

const Router = {
  init() {
    window.addEventListener('hashchange', () => run());
    return run();
  },
  run,
};

export default Router;
