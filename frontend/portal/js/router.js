// The portal router.
//
// One place turns an address into a page. It reads the registry for what a URL
// means, resolves whatever that page needs, and then renders it.

import { matchRoute } from '../packages/registry.js';
import { el } from '../packages/dom.js';
import { bind } from '../packages/registry.js';
import { State, refreshServers } from '../packages/store.js';

// Page renderers
import { keysSection } from '../features/developer.js';
import { applicationsSection } from '../features/developer.js';
import { applicationsDashboard } from '../features/developer.js';
import { documentationSection } from '../features/developer.js';

let activeCleanup = null;

// Host element for the portal
function host() {
  return document.getElementById('app');
}

// Render a page
function renderPage(page) {
  const node = host();
  if (!node) return;

  const renderer = page.id === 'portal.keys' ? keysSection :
                   page.id === 'portal.applications' ? applicationsSection :
                   page.id === 'portal.dashboard' ? applicationsDashboard :
                   page.id === 'portal.documentation' ? documentationSection :
                   page.id === 'portal' ? renderPortalHome :
                   renderNotFound;

  const mountable = renderer(page);
  node.replaceChildren(mountable.node);

  if (mountable.onMount) mountable.onMount();
  if (activeCleanup) activeCleanup();
  activeCleanup = mountable.cleanup || (() => {});

  window.scrollTo(0, 0);
}

// Import the home page renderer
import { render } from './main.js';

// Render the portal home page
function renderPortalHome(page) {
  return render();
}

// Render not found
function renderNotFound(page) {
  const faultEl = fault({ title: 'Page Not Found', description: 'The page you requested does not exist.', primaryText: 'Return Home', primaryOnClick: () => window.location.href = '/portal' });
  return { node: faultEl, cleanup() {} };
}

// Initialize the router
function init() {
  bind();

  // Start with a route match
  const route = matchRoute(window.location.pathname);
  if (route) {
    renderPage(route.page);
  } else {
    // Default to portal home
    renderPage({ id: 'portal' });
  }
}

// Exports
export { init };