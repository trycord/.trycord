// Application state.
//
// One mutable object and one event bus. Views read from it and subscribe to the
// event that concerns them; nothing reaches into another module's copy of the
// same data, which is how two screens came to disagree about who was online.

import Api, { ApiError, token, setToken, tokenClaims } from './api.js';

const listeners = new Map();

export function on(event, handler) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(handler);
  return () => listeners.get(event).delete(handler);
}

export function emit(event, payload) {
  const set = listeners.get(event);
  if (!set) return;
  for (const handler of Array.from(set)) {
    try { handler(payload); } catch (error) {
      // A broken listener must not take the screen down with it, but it must
      // not be invisible either.
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[trycord] listener for "' + event + '" failed', error);
      }
    }
  }
}

export const State = {
  ready: false,
  online: false,
  user: null,
  instance: null,
  announcements: [],
  servers: [],
  serverDetail: new Map(),
  serverTree: new Map(),
  serverMembers: new Map(),
  serverRoles: new Map(),
  serverPermissions: new Map(),
  dms: [],
  friends: [],
  friendRequests: { incoming: [], outgoing: [] },
  notifications: { items: [], unreadCount: 0, hasMore: false, nextCursor: null },
  presence: new Map(),
  typing: new Map(),
  mutedChannels: new Set(),
  hasToken: !!token(),
  // The instance requires a second factor and this account has none. Set while
  // loading the session; the router reads it to send the reader to enrolment
  // rather than to every screen that is going to be refused.
  mfaRequired: false,
};

// --- normalisation ----------------------------------------------------------
//
// The API is not uniform: /api/users/me answers camelCase, the member roster
// answers snake_case, because they were written at different times. Normalising
// here means a view never has to know which one it is holding.

export function normalizeUser(raw) {
  if (!raw) return null;
  return {
    id: raw.id,
    username: raw.username,
    displayName: raw.display_name || raw.displayName || raw.username,
    nickname: raw.nickname || null,
    avatarUrl: raw.avatar_url !== undefined ? raw.avatar_url : raw.avatarUrl,
    bannerUrl: raw.banner_url !== undefined ? raw.banner_url : raw.bannerUrl,
    bio: raw.bio || null,
    statusText: raw.status_text !== undefined ? raw.status_text : raw.statusText,
    isBot: !!(raw.is_bot || raw.isBot),
    isOwner: !!raw.is_owner || !!raw.isOwner,
    roles: raw.roles || [],
    joinedAt: raw.joined_at || raw.joinedAt || null,
    timeoutExpiresAt: raw.timeout_expires_at || null,
    createdAt: raw.created_at || raw.createdAt || null,
    email: raw.email || null,
    emailVerified: raw.email_verified !== undefined ? raw.email_verified : raw.emailVerified,
    isAdmin: !!raw.isAdmin,
  };
}

export function nameOf(user) {
  if (!user) return 'Unknown';
  return user.nickname || user.displayName || user.username || 'Unknown';
}

export function handleOf(user) {
  return user && user.username ? user.username : '';
}

// --- session ----------------------------------------------------------------

export async function loadInstance() {
  try {
    State.instance = await Api.instance();
  } catch {
    State.instance = null;
  }
  emit('instance', State.instance);
  return State.instance;
}

export async function loadLegal() {
  try {
    return await Api.legal();
  } catch {
    return null;
  }
}

export async function loadSession() {
  if (!token()) {
    State.user = null;
    State.hasToken = false;
    return null;
  }
  try {
    State.user = normalizeUser(await Api.me());
    State.hasToken = true;
    State.mfaRequired = false;
    emit('user', State.user);
    return State.user;
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.code === 'AUTH_REQUIRED')) {
      State.mfaRequired = false;
      signOut({ local: true });
      return null;
    }
    if (error instanceof ApiError && error.code === 'MFA_REQUIRED') {
      // The instance requires a second factor and this account has not enrolled
      // one. The token is kept: it is valid, it is what the enrolment endpoints
      // accept, and it is what lets the reader fix this without signing in again.
      State.user = null;
      State.hasToken = true;
      State.mfaRequired = true;
      throw error;
    }
    // A network failure is not a signed-out reader: keep the token and let the
    // caller show a connection problem instead of a login screen.
    throw error;
  }
}

export function applyToken(value, user) {
  setToken(value);
  State.hasToken = !!value;
  if (user) State.user = normalizeUser(user);
}

// Whether there is a credential to present, read from storage rather than from
// the last session load: a tab whose token was cleared elsewhere is a guest even
// if State.user has not caught up.
export function signedIn() {
  return !!token();
}

export function signOut(options) {
  const opts = options || {};
  clearCaches();
  setToken(null);
  State.hasToken = false;
  State.user = null;
  State.mfaRequired = false;
  emit('signed-out', opts.reason || null);
}

function clearCaches() {
  State.servers = [];
  State.serverDetail.clear();
  State.serverTree.clear();
  treeInFlight.clear();
  treeFetchedAt.clear();
  State.serverMembers.clear();
  State.serverRoles.clear();
  State.serverPermissions.clear();
  State.dms = [];
  State.friends = [];
  State.friendRequests = { incoming: [], outgoing: [] };
  State.notifications = { items: [], unreadCount: 0, hasMore: false, nextCursor: null };
  State.presence.clear();
  presenceInFlight = null;
  presenceFetchedAt = 0;
  presenceWanted = [];
  State.typing.clear();
  State.mutedChannels.clear();
}

export function ownJti() {
  const claims = tokenClaims();
  return claims && claims.jti ? String(claims.jti) : null;
}

export async function logout() {
  try { await Api.logout(); } catch { /* the session is going regardless */ }
  signOut();
}

// --- communities ------------------------------------------------------------

export async function refreshServers() {
  State.servers = await Api.servers();
  emit('servers', State.servers);
  return State.servers;
}

export async function refreshServer(serverId) {
  const detail = await Api.server(serverId);
  State.serverDetail.set(serverId, detail);
  emit('server', detail);
  return detail;
}

const TREE_TTL_MS = 5000;
const treeInFlight = new Map();
const treeFetchedAt = new Map();

export async function refreshServerTree(serverId, options) {
  const force = !!(options && options.force);
  const fresh = treeFetchedAt.get(serverId) && (Date.now() - treeFetchedAt.get(serverId)) < TREE_TTL_MS;
  if (!force && fresh) return State.serverTree.get(serverId);
  if (treeInFlight.has(serverId)) return treeInFlight.get(serverId);
  const run = (async () => {
    try {
      const tree = await Api.channels(serverId);
      State.serverTree.set(serverId, tree || { categories: [], channels: [] });
      treeFetchedAt.set(serverId, Date.now());
      emit('tree', { serverId, tree: State.serverTree.get(serverId) });
      return State.serverTree.get(serverId);
    } finally {
      treeInFlight.delete(serverId);
    }
  })();
  treeInFlight.set(serverId, run);
  return run;
}

export async function refreshServerMembers(serverId, opts) {
  const page = await Api.serverMembers(serverId, opts);
  State.serverMembers.set(serverId, page);
  emit('members', { serverId, page });
  return page;
}

export async function refreshServerRoles(serverId) {
  const roles = await Api.roles(serverId);
  State.serverRoles.set(serverId, roles || []);
  return State.serverRoles.get(serverId);
}

export async function refreshServerPermissions(serverId) {
  const perms = await Api.rolePermissions(serverId);
  State.serverPermissions.set(serverId, perms || { permissions: [], all: [], descriptions: {}, is_owner: false });
  emit('permissions', { serverId, permissions: State.serverPermissions.get(serverId) });
  return State.serverPermissions.get(serverId);
}

export function serverById(id) {
  return State.servers.find((s) => s.id === id) || State.serverDetail.get(id) || null;
}

export function channelsOf(serverId) {
  const tree = State.serverTree.get(serverId);
  return tree ? tree.channels || [] : [];
}

export function categoriesOf(serverId) {
  const tree = State.serverTree.get(serverId);
  return tree ? tree.categories || [] : [];
}

export function channelById(serverId, channelId) {
  return channelsOf(serverId).find((c) => c.id === channelId) || null;
}

// A community's address is its slug when it has one, because that is what a
// person can read out loud. The id is the fallback, and the route accepts both.
export function serverPath(server) {
  return server && server.slug ? server.slug : (server ? server.id : '');
}

export function permissionsOf(serverId) {
  const server = State.servers.find((s) => s.id === serverId);
  if (server && server.permissions) return server.permissions;
  return [];
}

export function can(serverId, permission) {
  const perms = permissionsOf(serverId);
  if (perms.indexOf('*') !== -1) return true;
  return perms.indexOf(permission) !== -1;
}

export function isOwner(serverId) {
  const server = State.servers.find((s) => s.id === serverId);
  return !!(server && server.is_owner);
}

// --- direct messages --------------------------------------------------------

export async function refreshDms() {
  State.dms = await Api.dms();
  emit('dms', State.dms);
  return State.dms;
}

export function dmById(id) {
  return State.dms.find((d) => d.id === id) || null;
}

// The person on the other side of a one-to-one conversation.
export function dmPeer(dm) {
  if (!dm) return null;
  const users = dm.users || dm.participants || [];
  const me = State.user && State.user.id;
  const others = users.filter((u) => u.id !== me);
  const peer = others.length ? others[0] : (users[0] || null);
  return peer ? normalizeUser(peer) : null;
}

// --- friends ----------------------------------------------------------------

export async function refreshFriends() {
  const [friends, requests] = await Promise.all([
    Api.friends(),
    Api.friendRequests(),
  ]);
  State.friends = Array.isArray(friends) ? friends.map(normalizeUser) : (friends.items || []).map(normalizeUser);
  State.friendRequests = {
    incoming: (requests.incoming || []).map((r) => Object.assign({}, r, { user: normalizeUser(r.user || r.from || r.sender) })),
    outgoing: (requests.outgoing || []).map((r) => Object.assign({}, r, { user: normalizeUser(r.user || r.to || r.receiver) })),
  };
  emit('friends', { friends: State.friends, requests: State.friendRequests });
  return State.friends;
}

export function friendshipWith(userId) {
  if (State.friends.some((f) => f.id === userId)) return 'friend';
  if (State.friendRequests.incoming.some((r) => r.user && r.user.id === userId)) return 'incoming';
  if (State.friendRequests.outgoing.some((r) => r.user && r.user.id === userId)) return 'outgoing';
  return 'none';
}

// --- notifications ----------------------------------------------------------

export async function refreshNotifications(opts) {
  const page = await Api.notifications(opts);
  if (opts && opts.before) {
    State.notifications.items = State.notifications.items.concat(page.items || []);
  } else {
    State.notifications.items = page.items || [];
  }
  State.notifications.unreadCount = page.unreadCount || 0;
  State.notifications.hasMore = !!page.hasMore;
  State.notifications.nextCursor = page.nextCursor || null;
  emit('notifications', State.notifications);
  return State.notifications;
}

export function bumpUnread(delta) {
  State.notifications.unreadCount = Math.max(0, State.notifications.unreadCount + delta);
  emit('notifications', State.notifications);
}

// --- presence ---------------------------------------------------------------

const PRESENCE_TTL_MS = 3000;
let presenceInFlight = null;
let presenceFetchedAt = 0;
let presenceWanted = [];

export async function refreshPresence(ids) {
  const unique = Array.from(new Set(ids.filter(Boolean)));
  if (!unique.length) return State.presence;
  for (const id of unique) if (presenceWanted.indexOf(id) === -1) presenceWanted.push(id);
  const fresh = presenceFetchedAt && (Date.now() - presenceFetchedAt) < PRESENCE_TTL_MS;
  if (fresh || presenceInFlight) {
    if (presenceInFlight) await presenceInFlight;
    return State.presence;
  }
  const batch = presenceWanted.slice();
  presenceWanted = [];
  presenceInFlight = (async () => {
    try {
      const map = await Api.presence(batch);
      for (const id of Object.keys(map || {})) State.presence.set(id, map[id]);
      presenceFetchedAt = Date.now();
      emit('presence', State.presence);
    } catch { /* presence is best-effort */ } finally {
      presenceInFlight = null;
    }
  })();
  await presenceInFlight;
  return State.presence;
}

export function presenceOf(userId) {
  return State.presence.get(userId) || 'offline';
}

export function setPresence(userId, status) {
  State.presence.set(userId, status);
  emit('presence', State.presence);
}

// --- typing -----------------------------------------------------------------

export function noteTyping(key, userId, name) {
  if (!State.typing.has(key)) State.typing.set(key, new Map());
  const map = State.typing.get(key);
  const me = State.user && State.user.id;
  if (userId === me) return;
  map.set(userId, { name, until: Date.now() + 6000 });
  emit('typing', { key });
  clearTimeout(map.get(userId)._timer);
  map.get(userId)._timer = setTimeout(() => {
    map.delete(userId);
    emit('typing', { key });
  }, 6000);
}

export function typersFor(key) {
  const map = State.typing.get(key);
  if (!map) return [];
  const now = Date.now();
  return Array.from(map.values()).filter((entry) => entry.until > now).map((entry) => entry.name);
}

// --- mutes ------------------------------------------------------------------

export async function refreshMutes() {
  try {
    const mutes = await Api.mutes();
    State.mutedChannels = new Set((mutes || []).map((m) => m.channel_id || m.channelId || m));
  } catch { /* not fatal */ }
  emit('mutes', State.mutedChannels);
  return State.mutedChannels;
}

export function isMuted(channelId) {
  return State.mutedChannels.has(channelId);
}
