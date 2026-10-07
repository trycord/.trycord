// The shell: the parts of the interface that are not the page.
//
// Rail, place column, context header, member panel, phone tab bar. Each is a module under
// ./shell/ named for the thing it draws; this file is the only place that knows all five
// exist, which is what makes renderAllChrome possible and what makes it the right place
// to stop.
//
// Why it was one 1075-line file until now: because the regions call each other. Opening a
// community repaints the place column, collapsing the sidebar repaints everything, and a
// member action repaints the member list and the rail. Written inline, that reads as
// "the shell repaints itself", which is true, and as a cycle, which it also was:
//
//   renderPlaceNavigation -> dmsContext -> refreshHomeSidebar -> renderPlaceNavigation
//   toggleSidebar -> applySidebarState -> renderAllChrome -> renderPlaceNavigation
//
// Both are now closed by two small modules rather than by a comment saying to be careful.
// route.js owns the current-route value on its own, because "which route am I on" is
// state and "paint the place column" is a renderer, and one file being both is why the
// cycle was invisible. repaint.js owns the painter, registered from here, so a module
// that changes state asks for a repaint instead of importing the thing that repaints.

import { qs } from './ui.js';
import { renderCommunities } from './shell/rail.js';
import { renderPlaceNavigation } from './shell/navigation.js';
import { renderMemberSidebar, membersHidden, toggleMembers } from './shell/members.js';
import { renderContextHeader } from './shell/context-header.js';
import { renderMobileTabs, isTabBarHidden, setTabBarHidden } from './shell/tabs.js';
import { setNavRoute, currentRoute } from './shell/route.js';
import { isSidebarCollapsed, toggleSidebar, applySidebarState, toggleContextSidebar } from './shell/sidebar.js';
import { memberActions } from './shell/menus.js';
import { sidebarContext } from './shell/navigation.js';
import { setChromePainter } from './shell/repaint.js';
import { loadAnnouncements, clearAnnouncements, renderAnnouncementBanner, renderVerifyBanner } from './shell/banners.js';

// Repaint one region without taking the rest of the chrome with it.
//
// The catch is not defensive noise. This function is called from a socket handler, and a
// module that half-loaded throws here - shell.js calling icon() against a components.js
// the page had not reloaded gave "icon is not a function", which propagated out of
// renderAllChrome into the router's catch and replaced the whole view with an error
// screen. One region's failure is one region's failure.
function paintRegion(fn) {
  try {
    fn();
  } catch (e) {
    // Some embedders run with no console at all - a locked-down webview, an Electron
    // renderer with node integration off. Losing the log line is the entire cost of
    // catching here, and not catching it takes the chrome down.
    try { console.error('[trycord] chrome region failed', e); } catch { /* no console */ }
  }
}

export function renderAllChrome() {
  paintRegion(() => renderCommunities(qs('#community-navigation')));
  paintRegion(() => renderPlaceNavigation(qs('#place-navigation')));
  paintRegion(() => renderMobileTabs(qs('#mobile-tab-navigation')));
  paintRegion(() => renderMemberSidebar(qs('#member-sidebar')));
  paintRegion(() => renderAnnouncementBanner());
  paintRegion(() => renderVerifyBanner());
}

// Registered here rather than imported by each module, so the eight modules that want a
// repaint do not each import the module that knows how to do one.
setChromePainter(renderAllChrome);

// The shell's public surface, unchanged from when all of this was in this one file. The
// pages that import from shell.js should not learn that the shell has an interior.
export {
  setNavRoute,
  currentRoute,
  renderCommunities,
  renderPlaceNavigation,
  renderContextHeader,
  renderMemberSidebar,
  renderMobileTabs,
  membersHidden,
  toggleMembers,
  isSidebarCollapsed,
  toggleSidebar,
  applySidebarState,
  toggleContextSidebar,
  isTabBarHidden,
  setTabBarHidden,
  memberActions,
  sidebarContext,
  loadAnnouncements,
  clearAnnouncements,
  renderVerifyBanner,
};

export default {
  renderAllChrome,
  renderVerifyBanner,
  renderContextHeader,
  renderCommunities,
  renderPlaceNavigation,
  renderMemberSidebar,
  renderMobileTabs,
  setNavRoute,
  membersHidden,
  toggleMembers,
  isSidebarCollapsed,
  toggleSidebar,
  applySidebarState,
};
