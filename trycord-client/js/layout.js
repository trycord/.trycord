// Surface layouts.
//
// The shell used to declare three tracks and every route was fitted into them:
// a contextual sidebar on the left, content on the right, and a members panel
// inside. That suited a channel and nothing else, so every other surface either
// wasted a column or fought it. Settings was the worst case: it rendered its
// own navigation inside the content pane while the shell reserved a second
// sidebar beside it, so the same list appeared twice, five columns wide, with
// the part that mattered in the middle.
//
// A surface now declares the shape it needs and the shell reads that. This file
// is the declaration; the CSS consumes it. Nothing else decides geometry.
//
// The track list is always three tracks, even where the middle one is zero, and
// that is deliberate: the sidebar collapse animates by interpolating the track
// lengths, which a shorter track list cannot do. So a surface without a sidebar
// contributes a zero-width track rather than removing one, and the sidebar
// region is not rendered into it at all.
import { qs } from './ui.js';

// Surfaces a route can mount. `sidebar` means the contextual navigation region
// is used; `members` means the member panel is meaningful. Both are facts about
// the surface, not about the viewport - the breakpoints in the stylesheet decide
// how wide those regions are allowed to be.
const SIDE = 'var(--ui-sidebar)';
const NONE = '0px';

export const LAYOUTS = {
  // A community: contextual navigation plus the member panel.
  channel: { sidebar: true, members: true, tracks: `var(--ui-rail) ${SIDE} minmax(0, 1fr)` },

  // Conversations and lists. A sidebar holds the conversations, so it stays, but
  // there is no member panel to talk about.
  list: { sidebar: true, members: false, tracks: `var(--ui-rail) ${SIDE} minmax(0, 1fr)` },

  // Settings, Admin and a profile each carry their own navigation inside the
  // content surface, because that navigation belongs to the surface and not to
  // the shell. Reserving a shell sidebar for them duplicated it.
  settings: { sidebar: false, members: false, tracks: `var(--ui-rail) ${NONE} minmax(0, 1fr)` },
  admin: { sidebar: false, members: false, tracks: `var(--ui-rail) ${NONE} minmax(0, 1fr)` },
  profile: { sidebar: false, members: false, tracks: `var(--ui-rail) ${NONE} minmax(0, 1fr)` },

  // One column by nature. Keeps the rail, spends nothing else.
  plain: { sidebar: false, members: false, tracks: `var(--ui-rail) ${NONE} minmax(0, 1fr)` },
};

export const DEFAULT_LAYOUT = 'list';

let current = '';

export function layoutFor(name) {
  return LAYOUTS[name] || LAYOUTS[DEFAULT_LAYOUT];
}

export function currentLayout() {
  return current || DEFAULT_LAYOUT;
}

/**
 * Declare the layout for the route now on screen.
 *
 * Idempotent, because this runs on every render: writing the same value again
 * would restart the sidebar's width transition on every repaint.
 */
export function setLayout(name) {
  const next = LAYOUTS[name] ? name : DEFAULT_LAYOUT;
  if (next === current) return next;
  current = next;
  const shell = qs('#shell');
  if (!shell) return next;
  const spec = LAYOUTS[next];
  shell.dataset.layout = next;
  shell.style.setProperty('--ui-shell-cols', spec.tracks);
  // Read by the member panel's own width and by the stylesheet's rules, so a
  // surface without one cannot leave a panel reserving space it will not fill.
  shell.style.setProperty('--ui-members', spec.members ? '' : '0px');
  return next;
}

export function layoutUsesSidebar(name) {
  return layoutFor(name || currentLayout()).sidebar;
}

export function layoutUsesMembers(name) {
  return layoutFor(name || currentLayout()).members;
}

// Which surface a path belongs to. Data, so a new route is one line here rather
// than a branch inside the renderer that draws it.
//
// Order matters: the community and account prefixes are more specific than the
// fallbacks below them.
const BY_PREFIX = [
  ['/settings/', 'settings'],
  ['/settings', 'settings'],
  ['/account/', 'settings'],
  ['/account', 'settings'],
  ['/admin', 'admin'],
  ['/legal/', 'plain'],
  ['/support', 'plain'],
  ['/servers/new', 'plain'],
  ['/invite/', 'plain'],
  ['/verify-email/', 'plain'],
  ['/discover', 'plain'],
  ['/users/', 'profile'],
];

export function layoutForPath(path) {
  const p = String(path || '/');

  for (const [prefix, layout] of BY_PREFIX) {
    if (p === prefix || p.startsWith(prefix)) return layout;
  }

  // A community is a channel surface everywhere inside it, including its own
  // settings, roles and members pages: those are that community's structure, and
  // they sit beside the channels they describe rather than replacing them.
  if (/^\/(?:c|server)\//.test(p)) return 'channel';

  if (p === '/dms' || p.startsWith('/dms/')) return 'list';
  if (p.startsWith('/friends') || p.startsWith('/notifications')) return 'list';
  if (p.startsWith('/menu') || p === '/' || p.startsWith('/home')) return 'list';

  return 'plain';
}

export default {
  LAYOUTS,
  DEFAULT_LAYOUT,
  setLayout,
  currentLayout,
  layoutFor,
  layoutForPath,
  layoutUsesSidebar,
  layoutUsesMembers,
};
