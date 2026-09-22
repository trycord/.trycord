// Hash router. Maps #/... routes to real page renderers. Guards routes,
// re-renders the active shell's chrome, and cleans up listeners on change.

import { isAuthed, refreshServers } from './state.js';
import PagesPublic from './pages-public.js';
import { renderHome } from './pages-home.js';
import { renderBrowse } from './pages-browse.js';
import HelloDms from './pages-dms.js';
import Workspace from './pages-workspace.js';
import { renderAccount } from './pages-account.js';
import { presentationMode, closeMobileDrawer } from './presentation.js';
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
}

function setCleanup(fn) {
  runCleanup();
  lastCleanup = fn;
}

function parseHash() {
  const raw = (location.hash || '#/').replace(/^#/, '');
  if (!raw || raw === '/') return { name: 'home' };
  const parts = raw.split('/').filter(Boolean).map(decodeURIComponent);
  return { path: raw, parts };
}

function requireAuth() {
  if (!isAuthed()) {
    return false;
  }
  return true;
}

async function run() {
  const { path, parts } = parseHash();
  const region = viewRegion();
  if (!region) return;

  setNavRoute(() => path);
  runCleanup();

  closeMobileDrawer();

  // --- public-only routes -----------------------------------------
  if (path.startsWith('/login') || path === '' || path === '/') {
    if (isAuthed()) { location.hash = '#/home'; return; }
    renderContextHeader({});
    PagesPublic.login(region);
    setNavRoute(() => '/login');
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
  if (path.startsWith('/legal/')) {
    PagesPublic.legal(region, parts[1]);
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

  // --- account --------------------------------------------------------
  if (path.startsWith('/account/password')) { await renderAccount(region, { tab: 'password' }); renderAllChrome(); return; }
  if (path.startsWith('/account/sessions')) { await renderAccount(region, { tab: 'sessions' }); renderAllChrome(); return; }
  if (path.startsWith('/account')) { await renderAccount(region, { tab: 'profile' }); renderAllChrome(); return; }

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

  // --- servers -----------------------------------------------------
  if (path.startsWith('/servers/new')) {
    await Workspace.renderNewServer(region);
    renderAllChrome();
    return;
  }
  if (parts[0] === 'server' && parts[1]) {
    const serverId = parts[1];
    const what = parts[2];
    if (what === 'channel' && parts[3]) {
      setCleanup(() => { try { region._cleanup && region._cleanup(); } catch { /* ignore */ } });
      await Workspace.renderChannel(region, serverId, parts[3]);
      renderAllChrome();
      return;
    }
    if (what === 'channels') { // /server/:id/channels/new
      await Workspace.renderNewChannel(region, serverId);
      renderAllChrome();
      return;
    }
    if (what === 'invites') {
      await Workspace.renderInvites(region, serverId);
      renderAllChrome();
      return;
    }
    if (what === 'settings') {
      await Workspace.renderServerSettings(region, serverId);
      renderAllChrome();
      return;
    }
    if (parts.length === 2) {
      await Workspace.renderServerLanding(region, serverId);
      renderAllChrome();
      return;
    }
    await Workspace.renderServerLanding(region, serverId);
    renderAllChrome();
    return;
  }

  // --- home as default ---------------------------------------------------
  await renderHome(region);
  renderAllChrome();
}

const Router = {
  init() {
    window.addEventListener('hashchange', () => run());
    return run();
  },
  run,
};

export default Router;