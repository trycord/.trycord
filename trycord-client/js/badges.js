// How many things are waiting at each destination.
//
// Three surfaces ask this and each had its own arithmetic: the desktop rail, the
// phone tab bar, and the home page's own links. Direct messages fell out of it
// entirely - the home page knew there were four unread conversations and the rail
// showed nothing, because the rail's list only ever had two entries on it.
//
// One function, keyed by the page id in the registry, so a destination that exists
// in one navigation and not another cannot end up with a count in one and nothing
// in the other.
//
// Counts read from State rather than fetching. Everything here is already loaded at
// boot and refreshed on the realtime stream, so a badge that needed a request would
// either lag the number it is claiming or cost one per repaint.

import State from './state.js';

// Above this the exact number stops being useful and the width of the badge starts
// being a problem, so the rail, the tab bar and the home page all show this.
const CAP = 99;

const waiting = {
  // Unread across every conversation, not the number of conversations: a count of
  // threads would read as "one thing" when there are six messages in it.
  dms: () => (State.dms || []).reduce((n, d) => n + (d.unreadCount || 0), 0),
  notifications: () => State.notifUnread || 0,
  friends: () => (State.friendsIn || []).length,
};

/**
 * The count for one destination. Zero for a destination that does not keep a
 * count, so a caller can pass any page id and print whatever comes back.
 */
export function countFor(pageId) {
  const read = waiting[pageId];
  if (!read) return 0;
  return Math.max(0, read() || 0);
}

/** The label for a badge: the number, capped, or nothing at all when it is zero. */
export function labelFor(pageId) {
  const count = countFor(pageId);
  if (!count) return null;
  return count > CAP ? CAP + '+' : String(count);
}

export default { countFor, labelFor, CAP };