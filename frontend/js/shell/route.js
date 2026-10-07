// The current route, held as state.
// 
// This is the whole module because it is the thing that made the old file look
// cyclic. renderPlaceNavigation and renderMemberSidebar both need to know which
// route is current, and renderPlaceNavigation is called from both, so keeping the
// value here is what lets the renderers live in different files at all.

let navRoute = () => '';

export function setNavRoute(fn) {
  navRoute = fn;
}

export function currentRoute() {
  return navRoute();
}
