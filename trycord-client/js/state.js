// Central application state. Holds the authenticated session as revealed by
// the real API + WebSocket system only. There is no fake data here.

import Api, { token, setToken } from './api.js';

const LS_SERVER_ID = 'trycord.lastServerId';

const state = {
  me: null,            // { id, username, displayName, email, emailVerified, createdAt }
  token: null,
  servers: [],         // serverCore rows the user belongs to
  serverDetail: null,  // detail for the current place, when in a server
  channels: { categories: [], channels: [] }, // current server layout
  members: [],         // current server member rows
  permissions: [],     // current server permission strings (+is_owner via all)
  roles: [],           // current server roles
  presence: new Map(), // userId -> 'online'|'offline'
  dms: [],             // dmSummary list
  friends: [],         // friend rows
  friendsIn: [],       // incoming requests
  friendsOut: [],      // outgoing requests
  notifUnread: 0,
  activity: [],
  online: false,       // WS connected?
  lastServerId: null,
  raw: {},             // per-session scratch (route locals, caches)
};

export function isAuthed() {
  return !!(state.me && token());
}

export function currentServerId() {
  return state.lastServerId || (state.servers[0] && state.servers[0].id) || null;
}

export function can(perm) {
  const p = state.permissions || [];
  return p.includes('*') || p.includes(perm);
}

export function peerPresence(id) {
  return state.presence.get(id) || 'offline';
}

// ---- session ------------------------------------------------------------

export function hydrate() {
  state.token = token();
  return state.token ? Api.me().then((me) => {
    state.me = me;
    return me;
  }).catch(() => {
    // token died server-side (revoked/expired)
    clearSession();
    return null;
  }) : Promise.resolve(null);
}

export function applyAuth(payload) {
  // payload: { token, user }
  setToken(payload.token);
  state.token = payload.token;
  state.me = payload.user;
  return state.me;
}

export function clearSession() {
  setToken(null);
  state.token = null;
  state.me = null;
  state.servers = [];
  state.serverDetail = null;
  state.channels = { categories: [], channels: [] };
  state.members = [];
  state.permissions = [];
  state.roles = [];
  state.dms = [];
  state.friends = [];
  state.friendsIn = [];
  state.friendsOut = [];
  state.activity = [];
}

// ---- data -----------------------------------------------------------------

export async function refreshServers() {
  state.servers = await Api.servers();
  if (state.servers.length) {
    const found = state.servers.find((s) => s.id === state.lastServerId);
    if (!found && state.lastServerId) {
      // server no longer among ours
      state.lastServerId = null;
      localStorage.removeItem(LS_SERVER_ID);
    }
  }
  return state.servers;
}

export async function enterServer(serverId) {
  const [detail, layout, members, perms, roles] = await Promise.all([
    Api.server(serverId),
    Api.channels(serverId),
    Api.serverMembers(serverId),
    Api.serverPermissions(serverId),
    Api.roles(serverId),
  ]);
  state.serverDetail = detail;
  state.channels = layout;
  state.members = members;
  state.permissions = (perms && perms.permissions) || [];
  state.roles = roles || [];
  state.lastServerId = serverId;
  try { localStorage.setItem(LS_SERVER_ID, serverId); } catch { /* ignore */ }
  return { detail, layout, members, perms, roles };
}

export function leaveServerContext() {
  state.serverDetail = null;
  state.channels = { categories: [], channels: [] };
  state.members = [];
  state.permissions = [];
  state.roles = [];
  state.lastServerId = null;
  try { localStorage.removeItem(LS_SERVER_ID); } catch { /* ignore */ }
}

export async function refreshDms() {
  state.dms = await Api.dms();
  return state.dms;
}

export async function refreshFriends() {
  const [friends, reqs] = await Promise.all([Api.friends(), Api.friendRequests()]);
  state.friends = friends;
  state.friendsIn = (reqs && reqs.incoming) || [];
  state.friendsOut = (reqs && reqs.outgoing) || [];
  return state;
}

export async function refreshNotifications() {
  try {
    const n = await Api.notifications({ limit: 30 });
    state.notifUnread = (n && n.unreadCount) || 0;
    state.raw.notifications = (n && n.items) || [];
  } catch { /* non-fatal */ }
  return state.notifUnread;
}

export async function refreshActivity() {
  state.activity = await Api.activity({ limit: 20 });
  return state.activity;
}

export function setPresence(id, presence) {
  state.presence.set(id, presence);
}

export function setOnline(v) {
  state.online = v;
}

export function serverWithId(list, id) {
  return (list || []).find((s) => String(s.id) === String(id)) || null;
}

const TrycordState = state;
export default TrycordState;
export { Api };