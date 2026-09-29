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
import Api from './api.js';
import { el, clear, toast } from './ui.js';

let lastCleanup = null;
let lastRoute = '';

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

// A hash carries a path and, optionally, a query: #/server/s/channel/c?m=<id>.
function parseHash() {
  const raw = (location.hash || '#/').replace(/^#/, '');
  const qIndex = raw.indexOf('?');
  const path = qIndex === -1 ? raw : raw.slice(0, qIndex);
  const query = {};
  if (qIndex !== -1) {
    for (const [k, v] of new URLSearchParams(raw.slice(qIndex + 1))) query[k] = v;
  }
  if (!path || path === '/') return { path: '/', parts: [], query };
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  return { path, parts, query };
}

function requireAuth() {
  if (!isAuthed()) {
    return false;
  }
  return true;
}

async function renderRoute() {
  const { path, parts, query } = parseHash();
  document.documentElement.dataset.route = path || '/';
    // fixed-position and escapes the desktop shell's grid, but it still has to
    delete document.documentElement.dataset.authPage;
  for (const stray of document.querySelectorAll('body > .auth-page')) stray.remove();
  // Session state as a styling hook. Without a session there is no rail and
  // session rather than the route fixes every such page at once, instead of
  document.documentElement.dataset.session = isAuthed() ? 'in' : 'out';
  const region = viewRegion();
  if (!region) return;

  setNavRoute(() => path);
  runCleanup();

  closeDesktopNav();

  if (path.startsWith('/login') || path === '' || path === '/') {
    if (isAuthed()) { location.hash = '#/home'; return; }
    renderContextHeader({});
    PagesPublic.login(region);
    setNavRoute(() => '/login');
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

  if (path.startsWith('/discover')) {
    const previewId = parts[1] || null;
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

  try { await refreshServers().catch(() => {}); } catch { /* offline */ }

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

  if (path === '/admin/pages' || path.startsWith('/admin/pages/')) {
    await renderAdminPages(region, { route: parts[2] || null });
    renderAllChrome();
    return;
  }
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

  if (path.startsWith('/users/')) {
    await renderProfile(region, { id: parts[1] });
    renderAllChrome();
    return;
  }

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
      await renderChannel(region, serverId, parts[3], { focusMessage: query.m || null });
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

  await renderHome(region);
  renderAllChrome();
}

async function run() {
  try {
    return await renderRoute();
  } catch (ex) {
    // A failed data request must not strand the desktop shell with the last
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
