// URL construction, in one place.
//
// Links used to be built inline as '#/server/' + id in a dozen files, which is
// why readable slugs never reached the address bar.
//
// Slugs are best-effort: a server's detail may not be loaded yet, a channel
// list may predate a rename. Every helper falls back to the id, which always
// resolves - hence resolve.js accepting both forms.
import State from './state.js';
import { route } from './nav.js';

function serverRow(id) {
  const list = Array.isArray(State.servers) ? State.servers : [];
  return list.find((s) => String(s.id) === String(id)) || null;
}

// Missing cache has to yield an id link, not throw.
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

// '/c/:slug' and '/c/:slug/channel/:slug'. Old '/server/:id/...' routes are
// still understood by the router, so nothing here knows who reads a link.
//
// Everything goes through route(), the one place that knows the mount. These
// used to return '#/c/...', leaving communities on a separate navigation system
// from the rest of the app - and that hybrid couldn't nest, because the fragment
// had nowhere to sit once the path was already carrying the mount.
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

// Permalink. These get picked into other apps, so a UUID is a poor thing to hand
// someone.
//
// Mount from route(), never a literal '/app/' - a self-hoster's app is at the
// root, and the link would only ever be right on one deployment.
export function absoluteChannelUrl(serverId, channelId, messageId) {
  const p = channelPath(serverId, channelId, messageId ? '?m=' + encodeURIComponent(messageId) : '');
  return location.origin + p;
}
