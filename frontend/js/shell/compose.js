// One answer to "what is on screen right now", computed once before any region draws.
//
// Four subsystems used to answer that question separately, and two of them disagreed:
// the script docked the sidebar at 760px while the stylesheet reserved no track for the
// member panel until 1000px, which is how the panel ended up one pixel wide holding
// sixteen-pixel buttons.

import { currentRoute } from './route.js';
import { layoutUsesSidebar, layoutUsesMembers } from '../layout.js';
import { storage } from '../config.js';

// Every width the script decides anything from.
//
//   menuSheet  below this a menu is a bottom sheet rather than a popover. This one has no
//              counterpart in app.css: nothing in the stylesheet changes at 560, so a
//              menu became a sheet in a layout still shaped for a popover from 560 to
//              599. Either the sheet has a rule or it does not deserve the threshold.
export const WIDTH = {
  menuSheet: 560,
  // Matches the max-width: 599px / min-width: 600px pair, and presentation.js's own
  // mobile switch. Below this the rail is an overlay drawer, not a column.
  phone: 600,
  // Matches the 759/760 pair. At or above it the channel sidebar is a column and does
  // not need a toggle to be seen.
  dock: 760,
  // Matches the 999/1000 pair - NOT the dock threshold. The member panel is wider than
  // the channel sidebar and only earns a track once there is room for both. This is the
  // number the old code got wrong by borrowing the dock threshold.
  members: 1000,
};

// The shell's own state, in one object under one key.
//
// Three keys in three modules meant three reads to answer "what has the reader turned
// off", and no way to write a default that survives a rename. A caller that wants to
// change a flag goes through setShell, so the key is written in exactly one place.
const LS_KEY = 'trycord.shell';

const DEFAULTS = {
  channelsCollapsed: false,
  membersVisible: true,
  tabsVisible: true,
};

function readState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return Object.assign({}, DEFAULTS);
    const parsed = JSON.parse(raw);
    // Merged over the defaults rather than trusted: a key written by an older build, or
    // by a hand-edited localStorage, must not be able to produce a shell in a shape
    // nothing expects.
    return Object.assign({}, DEFAULTS, parsed && typeof parsed === 'object' ? parsed : {});
  } catch {
    return Object.assign({}, DEFAULTS);
  }
}

let state = readState();

function persist() {
  storage(() => localStorage.setItem(LS_KEY, JSON.stringify(state)));
}

export function shellState() {
  return Object.assign({}, state);
}

// The only way to change shell state. `storage` is deferred by the caller rather than
// here, matching how every other persisted write in the client is wrapped.
export function setShell(patch) {
  state = Object.assign({}, state, patch);
  persist();
  return shellState();
}

// Reset between renders in the render harness, which loads the module once and then
// navigates through many shells.
export function resetShellState() {
  state = readState();
  return shellState();
}

// The answer. Every region reads this and nothing else decides on its own.
export function compose() {
  const width = window.innerWidth;
  const route = currentRoute();
  const mode = width < WIDTH.phone ? 'phone' : (width < WIDTH.dock ? 'tablet' : 'desktop');
  const s = shellState();

  // A surface that has no channel list does not get one, whatever the width. The layout
  // table says what the surface needs; the width says what there is room for. Both have
  // to be true, and the previous code asked the questions in different modules.
  const channelsWanted = layoutUsesSidebar();
  const membersWanted = layoutUsesMembers();

  return {
    mode,
    width,
    route,
    state: s,

    rail: {
      // Always present. Below `phone` it is an overlay drawer over the view; at or above
      // it is a column, and the drawer state is irrelevant.
      overlay: width < WIDTH.phone,
    },

    channels: {
      // `show` is whether the surface has one at all. `collapsed` is the reader's
      // preference, and it only means something where a column exists.
      show: channelsWanted,
      collapsed: channelsWanted && mode !== 'phone' ? s.channelsCollapsed : false,
      // A toggle is offered only where collapsing actually changes what is visible.
      collapsible: channelsWanted && width >= WIDTH.dock,
    },

    members: {
      // Both conditions, and they are not the same condition. The surface has to have a
      // member panel to show, and there has to be a track wide enough to put it in.
      show: membersWanted && width >= WIDTH.members,
      visible: membersWanted && width >= WIDTH.members && s.membersVisible,
    },

    tabs: {
      // A phone shows destinations in a bar; a wider screen has a rail and does not need
      // one. The tab bar is not the phone's only navigation - the drawer is - so this is
      // a shortcut bar, not the nav.
      show: width < WIDTH.phone,
      visible: width < WIDTH.phone && s.tabsVisible,
    },
  };
}
