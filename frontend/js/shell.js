// The shell: the parts of the interface that are not the page.
//
// Each region is a module under ./shell/ named for the thing it draws. This is the only
// place that knows all of them exist. Two small modules break the cycles the regions
// would otherwise have: route.js owns the current route, repaint.js owns the painter.

import { qs } from './ui.js';
import { buildTree, viewRoot } from './shell/tree.js';
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

// The shell's public surface. The pages that import from here should not learn that the
// shell has an interior.
export {
  buildTree,
  viewRoot,
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
