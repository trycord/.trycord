// URL construction, in one place.
//
// Every link used to be built inline as '#/server/' + id, spread across a dozen
// files. That is why readable slugs never reached the address bar: the id form
// was the only form, in every call site, and changing it meant finding them all
// and hoping none was missed.
//
// Slugs are best-effort. State can hold a server whose detail has not loaded
// yet, and a channel list that predates a rename, so every helper falls back to
// the id. The id route always resolves, so a missing slug degrades the URL
// rather than breaking it - which is the whole reason resolution accepts both
// forms.
import State from './state.js';
import { route } from './nav.js';

function serverRow(id) {
  const list = Array.isArray(State.servers) ? State.servers : [];
  return list.find((s) => String(s.id) === String(id)) || null;
}

// The channel cache the shell already keeps, if any. Read defensively: a
// missing cache must yield an id link, not an exception.
function channelRow(serverId, channelId) {
  const byServer = State.raw && State.raw.channels;
  const rows = byServer && byServer[String(serverId)];
  if (!Array.isArray(rows)) return null;
  return rows.find((c) => String(c.id) === String(channelId)) || null;
}

export function serverToken(id) {
  if (!id) return '';
  const row = serverRow(id);
  return (row && row.slug) || String(id);
}

export function channelToken(serverId, channelId) {
  if (!channelId) return '';
  const row = channelRow(serverId, channelId);
  return (row && row.slug) || String(channelId);
}

export function userToken(user) {
  if (!user) return '';
  return user.username || String(user.id || '');
}

// '#/c/:slug' and '#/c/:slug/channel/:slug'. The short prefixes are the V2
// shape; the old '/server/:id/...' routes are still understood by the router, so
// nothing here has to know who is reading a given link.
// Every builder here goes through route(), which is the one place that knows
// where the app is mounted. They were returning '#/c/...' - hash routing, the
// thing the move to paths was meant to leave behind - so communities and
// channels were still a separate navigation system from the rest of the app:
// /app/home by pathname and #/c/slug/channel/general by fragment. Nested one
// more level, that hybrid could not work, because the fragment had nowhere to
// sit once the path was already carrying the mount.
export function serverPath(serverId, suffix) {
  const base = route('/c/' + encodeURIComponent(serverToken(serverId)));
  return suffix ? base + '/' + suffix : base;
}

export function channelPath(serverId, channelId, query) {
  const p = serverPath(serverId, 'channel/' + encodeURIComponent(channelToken(serverId, channelId)));
  return query ? p + query : p;
}

export function userPath(user) {
  return route('/users/' + encodeURIComponent(userToken(user)));
}

// A shareable absolute link. Channel permalinks are the case that matters:
// they are pasted into other applications, so a UUID is a poor thing to hand
// someone.
//
// The mount comes from route() rather than a literal '/app/'. Hard-coding it
// would make a self-hoster's permalinks point at a path they do not serve,
// while their own app sits at the root - the link would only ever be right on
// one deployment.
export function absoluteChannelUrl(serverId, channelId, messageId) {
  const p = channelPath(serverId, channelId, messageId ? '?m=' + encodeURIComponent(messageId) : '');
  return location.origin + p;
}
