import { repaintChrome } from './repaint.js';
import { setShell, shellState, compose } from './compose.js';
import { el, clear, qs, toast, relTime, confirmDialog, openModal, openReportDialog, attachMenu, attachContextMenu, showUserCard, copyText, announce } from '../ui.js';
import { isDesktopNavOpen, openDesktopNav, closeDesktopNav } from '../presentation.js';

// Sidebar visibility state - collapsed, docked, and the toggles that change it.
//
// The persisted flag is the shell's, not this module's, and the thresholds are
// compose()'s. This file used to keep its own DOCK_MIN of 760, which is how it and the
// stylesheet came to disagree about where a member track begins.

export function isSidebarCollapsed() {
  return shellState().channelsCollapsed;
}

export function toggleSidebar() {
  setShell({ channelsCollapsed: !isSidebarCollapsed() });
  applySidebarState();
}

export function applySidebarState() {
  const shell = qs('#shell');
  if (shell) shell.classList.toggle('sidebar-collapsed', isSidebarCollapsed());
  repaintChrome();
}

export function contextSidebarDocked() {
  return compose().channels.collapsible;
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
