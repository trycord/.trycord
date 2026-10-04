// Surface layouts.
//
// Every route used to be fitted into the shell's three tracks, which suited a
// channel and nothing else. Settings was the worst: it drew its own nav inside
// the content pane while the shell reserved a sidebar beside it, so the same list
// appeared twice with the useful part in the middle.
//
// A surface declares the shape it needs; the CSS decides the measurements.
//
// Always three tracks, even where the middle one is zero - the sidebar collapse
// animates by interpolating track lengths, which a shorter list can't do. So a
// surface with no sidebar contributes a zero-width track instead of removing
// one, and nothing is rendered into it.
import { qs } from './ui.js';

// `sidebar` means the contextual nav region is used; `members` means the member
// panel means something. Facts about the surface, not the viewport.
//
// Track values are deliberately absent: this module sets one attribute and the
// stylesheet owns every measurement. An inline custom property outranks any media
// query, so writing tracks from script meant the phone layout could never apply
// and content was laid out in 64px next to a rail that overflowed.
export const LAYOUTS = {
  // Community: contextual nav plus members.
  channel: { sidebar: true, members: true },

  // Sidebar holds the conversations; no member panel to talk about.
  list: { sidebar: true, members: false },

  // These carry their own nav inside the content surface. A shell sidebar
  // duplicated it.
  settings: { sidebar: false, members: false },
  admin: { sidebar: false, members: false },
  profile: { sidebar: false, members: false },

  // One column by nature.
  plain: { sidebar: false, members: false },
};

export const DEFAULT_LAYOUT = 'list';

let current = '';

export function layoutFor(name) {
  return LAYOUTS[name] || LAYOUTS[DEFAULT_LAYOUT];
}

export function currentLayout() {
  return current || DEFAULT_LAYOUT;
}

// Idempotent because this runs on every render - rewriting the same value
// restarts the sidebar's width transition on every repaint.
export function setLayout(name) {
  const next = LAYOUTS[name] ? name : DEFAULT_LAYOUT;
  if (next === current) return next;
  current = next;
  const shell = qs('#shell');
  if (!shell) return next;
  const spec = LAYOUTS[next];
  shell.dataset.layout = next;
  // Hidden off this attribute rather than by measurement, so a surface without
  // members can't leave a panel reserving width.
  shell.dataset.members = spec.members ? 'yes' : 'no';
  return next;
}

export function layoutUsesSidebar(name) {
  return layoutFor(name || currentLayout()).sidebar;
}

export function layoutUsesMembers(name) {
  return layoutFor(name || currentLayout()).members;
}

// Data rather than branches inside the renderer. Order matters - the prefixes
// above are more specific than the fallbacks below them.
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
  // The directory lists every community and every channel itself, so a sidebar
  // beside it repeated the rail's own list a third time on one screen.
  ['/menu', 'plain'],
  ['/users/', 'profile'],
];

export function layoutForPath(path) {
  const p = String(path || '/');

  for (const [prefix, layout] of BY_PREFIX) {
    if (p === prefix || p.startsWith(prefix)) return layout;
  }

  // A community is a channel surface all the way in, including its own settings
  // and roles pages - that's the community's structure, sitting beside the
  // channels it describes.
  if (/^\/(?:c|server)\//.test(p)) return 'channel';

  if (p === '/dms' || p.startsWith('/dms/')) return 'list';
  if (p.startsWith('/friends') || p.startsWith('/notifications')) return 'list';
  // /menu is not here: it is in the table above, as a plain surface.
  if (p === '/' || p.startsWith('/home')) return 'list';

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
