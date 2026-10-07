// Which shell shape a surface gets.
//
// A surface declares what it needs in the page registry and the stylesheet owns every
// measurement. Always three tracks, even where the middle one is zero: the sidebar
// collapse animates by interpolating track lengths, which a shorter list can't do.
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

export default {
  LAYOUTS, DEFAULT_LAYOUT, setLayout, currentLayout,
  layoutFor, layoutUsesSidebar, layoutUsesMembers,
};
