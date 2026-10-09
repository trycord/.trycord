import { qs } from '../ui.js';
import { repaintChrome } from './repaint.js';
import { setShell, shellState, compose } from './compose.js';
import { isNavOpen, openNav, closeNav } from '../presentation.js';

// Sidebar visibility state - collapsed, docked, and the toggle that changes it.
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

/**
 * The one toggle in the context header, and the two things it can mean.
 *
 * Where the context navigation is a column (above 1100px) it collapses that column,
 * which is a preference and is persisted. Where it is a drawer it opens and closes the
 * drawer, which is a transient state and is not.
 *
 * It used to always call openDesktopNav(), which toggled #app-rail - and no stylesheet
 * anywhere turns the rail into a drawer. Below 820px the rail is display:none, so the
 * only control for reaching the conversation list, the channel list and the member list
 * was a button that opened a hidden element.
 */
export function toggleContextSidebar() {
  const plan = compose();
  if (!plan.channels.show) return;

  if (plan.channels.drawer) {
    if (isNavOpen()) closeNav();
    else openNav();
    return;
  }
  if (plan.channels.collapsible) toggleSidebar();
}
