import { repaintChrome } from './repaint.js';
import { storage } from '../config.js';
import { el, clear, qs, toast, relTime, confirmDialog, openModal, openReportDialog, attachMenu, attachContextMenu, showUserCard, copyText, announce } from '../ui.js';
import { isDesktopNavOpen, openDesktopNav, closeDesktopNav } from '../presentation.js';

// Sidebar visibility state - collapsed, docked, and the toggles that change it.

const LS_SIDEBAR_COLLAPSED = 'trycord.sidebarCollapsed';

export function isSidebarCollapsed() {
  try { return localStorage.getItem(LS_SIDEBAR_COLLAPSED) === '1'; } catch { return false; }
}

export function toggleSidebar() {
  const next = !isSidebarCollapsed();
  storage(() => localStorage.setItem(LS_SIDEBAR_COLLAPSED, next));
  applySidebarState();
}

export function applySidebarState() {
  const shell = qs('#shell');
  if (shell) shell.classList.toggle('sidebar-collapsed', isSidebarCollapsed());
  repaintChrome();
}

const SIDEBAR_DOCK_MIN = 760;

export function contextSidebarDocked() {
  return window.innerWidth >= SIDEBAR_DOCK_MIN;
}

export function contextSidebarVisible() {
  const shell = qs('#shell');
  if (!shell) return false;
  if (shell.classList.contains('sidebar-collapsed')) return isDesktopNavOpen();
  if (isDesktopNavOpen()) return true;
  return contextSidebarDocked();
}

export function toggleContextSidebar() {
  const shell = qs('#shell');
  if (!shell) return;
  if (contextSidebarDocked()) {
    if (isDesktopNavOpen()) closeDesktopNav();
    toggleSidebar();
    return;
  }
  if (isDesktopNavOpen()) closeDesktopNav();
  else openDesktopNav();
  const btn = qs('.nav-toggle');
  if (btn) btn.setAttribute('aria-expanded', isDesktopNavOpen() ? 'true' : 'false');
}

export function sidebarToggleButton() {
  const collapsed = isSidebarCollapsed();
  const btn = el('button', {
    class: 'sidebar-collapse-toggle',
    type: 'button',
    title: collapsed ? 'Expand sidebar' : 'Collapse sidebar',
    'aria-label': collapsed ? 'Expand sidebar' : 'Collapse sidebar',
    'aria-pressed': collapsed ? 'true' : 'false',
  }, collapsed ? '▶' : '◀');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSidebar();
  });
  return btn;
}
