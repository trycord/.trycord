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
  bans: [],            // current server bans (staff only, refreshed on demand)
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
  return state.presence.get(String(id)) || state.presence.get(id) || 'offline';
}

// Server-room hooks (join/leave the community realtime room). Set once by
// app.js — state must not import realtime (realtime imports state).
let serverRoomHooks = { join() {}, leave() {} };
export function setServerRoomHooks(hooks) {
  serverRoomHooks = Object.assign({ join() {}, leave() {} }, hooks || {});
}

// Active view repaint hook, set by workspace renderers so realtime community
// events can repaint the current view. Cleared on every route change.
export function setViewRefresh(fn) {
  state.raw.refresh = typeof fn === 'function' ? fn : null;
}
export function clearViewRefresh() {
  state.raw.refresh = null;
}
export function repaintView() {
  try {
    if (typeof state.raw.refresh === 'function') state.raw.refresh();
  } catch { /* a stale view must never break the event loop */ }
}

// ---- session ------------------------------------------------------------

export function hydrate() {
  state.token = token();
  return state.token ? Api.me().then((me) => {
    // A 200 with an empty/non-JSON body yields null — treat it exactly
    // like a dead session instead of storing a null user.
    if (!me || typeof me !== 'object' || !me.id) {
      clearSession();
      return null;
    }
    state.me = me;
    return me;
  }).catch(() => {
    // token died server-side (revoked/expired)
    clearSession();
    return null;
  }) : Promise.resolve(null);
}

function validAuthPayload(payload) {
  return !!(payload && typeof payload === 'object' &&
    typeof payload.token === 'string' && payload.token &&
    payload.user && typeof payload.user === 'object' && payload.user.id);
}

export function applyAuth(payload) {
  // Contract: { token: string, user: { id, ... } }. Never dereference the
  // payload before proving its shape — a misconfigured backend, proxy, or
  // captive portal can answer 200 with HTML/empty bodies, which the API
  // layer surfaces as null. Callers catch the thrown error and show it.
  if (!validAuthPayload(payload)) {
    throw new Error('The backend did not return a valid session. Check the configured backend and try again.');
  }
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
  // Join the community realtime room, then backfill live presence for every
  // visible member (pushes alone only reach friends/DM peers otherwise).
  try { serverRoomHooks.join(serverId); } catch { /* ignore */ }
  try {
    const ids = (members || []).map((m) => m.user_id || m.id).filter(Boolean).slice(0, 100);
    if (ids.length) {
      const snap = await Api.presence(ids);
      if (snap && typeof snap === 'object') {
        for (const [id, p] of Object.entries(snap)) {
          state.presence.set(String(id), p);
          state.presence.set(id, p);
        }
      }
    }
  } catch { /* presence is best-effort */ }
  return { detail, layout, members, perms, roles };
}

// Serialized community refresh for realtime handlers: concurrent events
// chain instead of racing, so state always converges to the latest fetch.
let serverRefreshChain = Promise.resolve();
export function refreshServerView() {
  const sid = state.lastServerId;
  if (!sid) return Promise.resolve(null);
  const run = serverRefreshChain.then(() => enterServer(sid)).catch(() => null);
  serverRefreshChain = run.catch(() => null);
  return run.then(() => { repaintView(); return null; });
}

export async function refreshBans() {
  const sid = state.lastServerId;
  if (!sid) { state.bans = []; return state.bans; }
  try {
    state.bans = (await Api.serverBans(sid)) || [];
  } catch {
    state.bans = [];
  }
  return state.bans;
}

export function leaveServerContext() {
  try { serverRoomHooks.leave(); } catch { /* ignore */ }
  state.serverDetail = null;
  state.channels = { categories: [], channels: [] };
  state.members = [];
  state.permissions = [];
  state.roles = [];
  state.bans = [];
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
  state.presence.set(String(id), presence);
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