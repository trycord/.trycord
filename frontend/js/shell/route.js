// The current route, as state. Its own module because both renderers need it
// and one of them calls the other.

let navRoute = () => '';

export function setNavRoute(fn) {
  navRoute = fn;
}

export function currentRoute() {
  return navRoute();
}
