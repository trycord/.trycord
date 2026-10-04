// Slug -> identity, and teardown for the view we left.
//
// Not in the router: the table needs these and the router needs the table.

import Api from './api.js';
import { el } from './ui.js';

// A slug is a display convenience, not an identity. An unresolvable one says so
// plainly rather than rendering an empty page that looks like a broken app.
export function renderRouteError(region, message) {
  region.replaceChildren();
  region.appendChild(el('div', { class: 'empty-state' }, [
    el('p', {}, message),
    el('a', { class: 'btn', href: '/' }, 'Go home'),
  ]));
}

// Id or slug - links exist in both forms. Null on failure, so an unknown
// community reads as a dead link rather than a crash.
export async function resolveCommunity(token) {
  try {
    const row = await Api.server(token);
    return row && row.id ? { serverId: row.id } : null;
  } catch {
    return null;
  }
}

// Needs the community. A channel slug is unique per community, not globally, so
// resolving one without that context could land on someone else's channel.
export async function resolveChannelToken(serverId, token) {
  try {
    const list = await Api.channels(serverId);
    const chans = (list && list.channels) || [];
    const hit = chans.find((c) => String(c.slug) === String(token) || String(c.id) === String(token));
    return hit ? hit.id : null;
  } catch {
    return null;
  }
}

// Realtime subscriptions and the DM presence heartbeat both outlive the view that
// started them, and a community event repainting the view you just left is how a
// channel jumps out from under you. So the router hands this the one function that
// can stop them, rather than the registry of realtime rooms reaching into state.
let clearViewRefreshFn = null;

export function setViewRefreshCleaner(fn) {
  clearViewRefreshFn = fn;
}

export function clearViewRefreshNow() {
  if (clearViewRefreshFn) clearViewRefreshFn();
}

export default {
  renderRouteError, resolveCommunity, resolveChannelToken,
  setViewRefreshCleaner, clearViewRefreshNow,
};
