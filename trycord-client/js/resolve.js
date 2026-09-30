// Resolving a slug to an identity, and cleaning up after the view we left.
//
// These live apart from the router because the route table needs them and the
// router needs the table: keeping them in the router would mean the table
// imported the module that imports the table.

import Api from './api.js';
import { el, clear } from './ui.js';

// A slug is a display convenience, not an identity, so a route that cannot
// resolve one says so plainly instead of rendering an empty page that looks
// like a broken app.
export function renderRouteError(region, message) {
  region.replaceChildren();
  region.appendChild(el('div', { class: 'empty-state' }, [
    el('p', {}, message),
    el('a', { class: 'btn', href: '/' }, 'Go home'),
  ]));
}

// Both accept an id or a slug, because a link may be either: copied from the
// address bar after the move to slugs, or shared before it. A failed lookup
// returns null rather than throwing, so an unknown community reads as a dead
// link and not a crash.
export async function resolveCommunity(token) {
  try {
    const row = await Api.server(token);
    return row && row.id ? { serverId: row.id } : null;
  } catch {
    return null;
  }
}

// Always resolved inside the community. A channel slug is unique per community
// and not globally, so resolving one without that context would be a guess - and
// a guess here can land on somebody else's channel.
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

// A view registers teardown here. Realtime subscriptions and the DM presence
// heartbeat both outlive the view that started them, and a community event that
// repaints the view you just left is how a channel jumps out from under you.
let lastCleanup = null;
let onViewRefreshCleared = null;

// Supplied by the router, which owns the realtime repaint subscription.
export function setViewRefreshCleaner(fn) {
  onViewRefreshCleared = fn;
}

export function runCleanup() {
  if (lastCleanup) { try { lastCleanup(); } catch { /* ignore */ } lastCleanup = null; }
  try { if (onViewRefreshCleared) onViewRefreshCleared(); } catch { /* ignore */ }
}

export function setCleanup(fn) {
  runCleanup();
  lastCleanup = fn;
}

export default { renderRouteError, resolveCommunity, resolveChannelToken, runCleanup, setCleanup, setViewRefreshCleaner };
