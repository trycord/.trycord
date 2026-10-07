// The application tree.
//
// index.html has one element in it. This builds the rest, so the structure is code that
// can be read, checked and changed rather than markup that has to be diffed by eye.
//
//   Application
//     navigation   the rail: identity, global destinations, communities, the current place
//     context      the header above the workspace, which changes with the place
//     workspace    the main landmark, and the element pages render into
//     secondary    the member panel, present only where the page asks for one
//     overlays     modals, menus, toasts, the route announcer, connection state
//     phone        the tab bar
//
// There is one tree. The phone presentation is the same tree under a different
// arrangement - the rail becomes a drawer over it and the tab bar appears below - not a
// second application with its own landmarks, its own state and its own copy of the same
// regions.
//
// The ids are the contract. The stylesheet addresses these, and so do the region
// renderers and every page that mounts something beside them, so they are written here
// once rather than declared in two places that can disagree.

import { el } from '../ui/dom.js';

let built = null;

/**
 * Build the tree into the mount point. Idempotent.
 *
 * Called before the first route is drawn rather than on every render, because a route
 * change replaces the contents of regions and not the regions themselves.
 */
export function buildTree() {
  if (built && built.isConnected) return built;

  const mount = document.getElementById('app');
  if (!mount) return null;

  const view = el('section', {
    id: 'view-root',
    class: 'view-root',
    // Pages own their own scrolling context; the workspace does not, or the composer
    // would scroll away with the messages instead of staying put.
  });

  const members = el('aside', {
    id: 'member-sidebar',
    class: 'member-sidebar',
    'aria-label': 'Community members',
  });

  const rail = el('aside', { id: 'app-rail', class: 'app-rail', 'aria-label': 'Navigation' }, [
    // Identity has to come first and has to stay a landmark: it holds the account menu,
    // which is reachable from every page.
    el('header', { id: 'identity-region', class: 'rail-identity' }),
    el('nav', { id: 'global-navigation', class: 'rail-global-nav', 'aria-label': 'Global navigation' }),
    el('section', { id: 'community-navigation', class: 'app-rail__items', 'aria-label': 'Communities' }),
    // The current place's own navigation: this community's channels, or the DM list.
    // One region for both because both answer the same question - what is in here.
    el('section', { id: 'place-navigation', class: 'context-sidebar', 'aria-label': 'Current place navigation' }),
  ]);

  const main = el('main', { id: 'trycord-main', class: 'main-content' }, [
    el('header', { id: 'context-header', class: 'context-header' }),
    el('div', { class: 'chat-environment' }, [view, members]),
  ]);

  const shell = el('section', { id: 'shell', class: 'shell', 'aria-label': 'Trycord' }, [
    rail,
    // Only ever shown on a narrow viewport, where the rail is a drawer and needs
    // something to click to close it. Hidden here so it cannot be tabbed to on a
    // desktop where it covers nothing.
    el('div', { id: 'desktop-backdrop', class: 'nav-backdrop', 'aria-hidden': 'true', hidden: true }),
    main,
    el('nav', { id: 'mobile-tab-navigation', class: 'mobile-tab-navigation', 'aria-label': 'Primary navigation' }),
  ]);

  // Overlays live outside the shell so a region's repaint cannot take a dialog with it,
  // and so a dialog is never clipped by a region's overflow.
  const overlays = [
    el('div', { id: 'modal-root', class: 'modal-root' }),
    el('div', { id: 'popover-root', class: 'popover-root' }),
    // Route changes are announced here rather than by making the whole view a live
    // region, which would re-read every message on every render.
    el('div', {
      id: 'route-announcer', class: 'sr-only', role: 'status',
      'aria-live': 'polite', 'aria-atomic': 'true',
    }),
    el('div', {
      id: 'toast-root', class: 'toast-root',
      'aria-live': 'polite', 'aria-atomic': 'true',
    }),
    el('div', {
      id: 'connection-status', class: 'connection-status',
      role: 'status', 'aria-live': 'polite',
    }),
  ];

  const root = el('div', { id: 'trycord-root', class: 'trycord-app' }, [shell, ...overlays]);

  mount.replaceChildren(root);
  built = shell;
  return shell;
}

/** The element pages render into, or null before the tree is built. */
export function viewRoot() {
  return document.getElementById('view-root');
}

export default { buildTree, viewRoot };