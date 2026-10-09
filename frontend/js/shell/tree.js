// Builds the application tree. index.html has one element in it; this fills it in.
//
// The ids are the contract - the stylesheet and every region renderer address them - so
// they are written once, here.
//
// The shell is a three-column grid, and the columns are the whole layout:
//
//   rail      who you are and where you can go       --rail-width
//   context   what is inside the current place       --sidebar-width
//   workspace the thing itself                        minmax(0, 1fr)
//
// The regions are direct children of #shell for that reason. A region nested inside
// another one is a region that inherits the wrong width: #place-navigation used to sit
// inside #app-rail, where it was laid out as a flex item of a 68px column - so the
// conversation list, the channel list and the member list were all 68px wide, and the
// workspace was auto-placed into the 244px context column instead of the 1fr one. A
// third of every screen was blank and the rest was unusable, and nothing in the
// stylesheet was wrong.
//
// The backdrop and the tab bar are not grid items: the backdrop is position:fixed and
// the tab bar is display:none on desktop, so neither takes a cell. They are kept as
// children of the shell because that is the scope they belong to.

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

  // Column 1. Identity first, because it is the one thing that is the same on every
  // page; then the global destinations; then the communities you are in; then the
  // account control, at the foot.
  const rail = el('aside', { id: 'app-rail', class: 'app-rail', 'aria-label': 'Navigation' }, [
    el('header', { id: 'identity-region', class: 'rail-identity' }),
    el('nav', { id: 'global-navigation', class: 'rail-global-nav', 'aria-label': 'Global navigation' }),
    el('section', { id: 'community-navigation', class: 'app-rail__items', 'aria-label': 'Communities' }),
    el('footer', { id: 'rail-foot', class: 'rail-foot', 'aria-label': 'Account' }),
  ]);

  // Column 2. The current place's own navigation: this community's channels, or the DM
  // list. Its own grid child, not a member of the rail - the rail answers "where can I
  // go" and this answers "what is in here", and they are different widths because they
  // hold different amounts of information.
  const place = el('section', {
    id: 'place-navigation',
    class: 'context-sidebar',
    'aria-label': 'Current place navigation',
  });

  // Column 3.
  const main = el('main', { id: 'trycord-main', class: 'main-content' }, [
    el('header', { id: 'context-header', class: 'context-header' }),
    el('div', { class: 'chat-environment' }, [view, members]),
  ]);

  const shell = el('section', { id: 'shell', class: 'shell', 'aria-label': 'Trycord' }, [
    rail,
    place,
    main,
    // Only ever shown on a narrow viewport, where the rail and the context navigation
    // are drawers and need something to click to close them. Hidden here so it cannot
    // be tabbed to on a desktop where it covers nothing. position:fixed, so it is not
    // a grid item.
    el('div', { id: 'desktop-backdrop', class: 'nav-backdrop', 'aria-hidden': 'true', hidden: true }),
    // display:none on desktop and position:fixed on a phone, so never a grid item
    // either. It is a child of the shell rather than of the body because it belongs to
    // the shell's scope and the shell is what hides it.
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
