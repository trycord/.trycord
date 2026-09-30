// Central application state. Holds the authenticated session as revealed by

import Api, { token, setToken } from './api.js';

const LS_SERVER_ID = 'trycord.lastServerId';

const state = {
  me: null,            // { id, username, displayName, email, emailVerified, createdAt }
  // cannot, an address can never be confirmed, so the client must not gate
  verificationRequired: true,
  token: null,
  servers: [],         // serverCore rows the user belongs to
  serverDetail: null,  // detail for the current place, when in a server
  channels: { categories: [], channels: [] }, // current server layout
  members: [],         // current server member rows (one page, or all when small)
  memberTotal: 0,      // total members in the community, server-computed
  memberHasMore: false,// whether the roster has a further page
  permissions: [],     // current server permission strings (+is_owner via all)
  // Channel-scoped permission set for the channel currently open, as computed by
  // the server's own evaluator (GET .../channels/:id/overrides -> `effective`).
  // Null until that channel has been fetched. `can()` cannot answer channel
  // questions on its own: the community list has no idea an override exists,
  // which is why a channel-level deny used to leave the composer looking usable.
  channelPermissions: null,
  roles: [],           // current server roles
  bans: [],            // current server bans (staff only, refreshed on demand)
  presence: new Map(), // userId -> 'online'|'offline'
  dms: [],             // dmSummary list
  friends: [],         // friend rows
  friendsIn: [],       // incoming requests
  friendsOut: [],      // outgoing requests
  notifUnread: 0,
  mutedChannels: new Set(), // channel ids with notifications suppressed
  activity: [],
  online: false,       // WS connected?
  lastServerId: null,
  raw: {},             // per-session scratch (route locals, caches)
};

export function isAuthed() {
  return !!(state.me && token());
}

export function currentServerId() {
  // A malformed backend payload (e.g. empty-body 200) must never brick
  const list = Array.isArray(state.servers) ? state.servers : [];
  return state.lastServerId || (list[0] && list[0].id) || null;
}

export function can(perm) {
  const p = state.permissions || [];
  return p.includes('*') || p.includes(perm);
}

// Channel-scoped equivalent of can(), backed by the server's answer rather than
// a reimplementation of the precedence rules here. Falls back to the
// community-level answer when the current channel's set has not been fetched,
// which is the previous behaviour rather than a wrong one.
export function canInChannel(perm) {
  const p = state.channelPermissions;
  if (!Array.isArray(p)) return can(perm);
  return p.includes('*') || p.includes(perm);
}

export function setChannelPermissions(list) {
  state.channelPermissions = Array.isArray(list) ? list.slice() : null;
}

export function peerPresence(id) {
  return state.presence.get(String(id)) || 'offline';
}

// app.js — state must not import realtime (realtime imports state).
let serverRoomHooks = { join() {}, leave() {} };
export function setServerRoomHooks(hooks) {
  serverRoomHooks = Object.assign({ join() {}, leave() {} }, hooks || {});
}

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
    // like a dead session instead of storing a null user.
    if (!me || typeof me !== 'object' || !me.id) {
      clearSession();
      return null;
    }
    state.me = me;
    syncVerificationPolicy(me);
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
  if (!validAuthPayload(payload)) {
    throw new Error('The backend did not return a valid session. Check the configured backend and try again.');
  }
  setToken(payload.token);
  state.token = payload.token;
  state.me = payload.user;
  // Login/register responses do not carry the policy flag, so treat the
  state.verificationRequired = payload.user.verificationRequired !== false;
  return state.me;
}

// UI never nags about an action the backend will not enforce.
function syncVerificationPolicy(me) {
  state.verificationRequired = !me || me.verificationRequired !== false;
}

export function verificationRequired() {
  return state.verificationRequired !== false;
}

export function mustVerifyToPost() {
  return verificationRequired() && !!(state.me && state.me.emailVerified === false);
}

export function clearSession() {
  setToken(null);
  state.token = null;
  state.me = null;
  state.servers = [];
  state.serverDetail = null;
  state.channels = { categories: [], channels: [] };
  state.members = [];
  state.memberTotal = 0;
  state.memberHasMore = false;
  state.permissions = [];
  state.channelPermissions = null;
  state.roles = [];
  state.dms = [];
  state.friends = [];
  state.friendsIn = [];
  state.friendsOut = [];
  state.activity = [];
  // a shared browser carried the previous session's peer list into the
  state.presence.clear();
  state.mutedChannels.clear();
}


export async function refreshServers() {
  const list = await Api.servers();
  state.servers = Array.isArray(list) ? list : [];
  if (state.servers.length) {
    const found = state.servers.find((s) => s.id === state.lastServerId);
    if (!found && state.lastServerId) {
      state.lastServerId = null;
      localStorage.removeItem(LS_SERVER_ID);
    }
  }
  return state.servers;
}

// One in-flight load per community. Every route that opens a community calls
// this, and several of them do so concurrently on first paint, so without this a
// single navigation fired the same six requests more than once. Deduplicating
// on the community id also means a refresh arriving while the first is still in
// flight joins it instead of starting a second copy.
const enterInFlight = new Map();

export async function enterServer(serverId) {
  const key = String(serverId);
  const running = enterInFlight.get(key);
  if (running) return running;

  const load = loadServer(serverId).finally(() => { enterInFlight.delete(key); });
  enterInFlight.set(key, load);
  return load;
}

async function loadServer(serverId) {
  const [detail, layout, members, perms, roles] = await Promise.all([
    Api.server(serverId),
    Api.channels(serverId),
    Api.serverMembers(serverId),
    Api.serverPermissions(serverId),
    Api.roles(serverId),
  ]);
  state.serverDetail = detail;
  state.channels = (layout && typeof layout === 'object') ? layout : { categories: [], channels: [] };
  state.members = Array.isArray(members) ? members : (members && Array.isArray(members.items) ? members.items : []);
  state.memberTotal = members && typeof members.total === 'number' ? members.total : state.members.length;
  state.memberHasMore = !!(members && members.hasMore);
  // Easy to drop while editing the lines above, and every permission gate in
  // the owner.
  state.permissions = (perms && perms.permissions) || [];
  state.channelPermissions = null;
  state.roles = roles || [];
  state.lastServerId = serverId;
  try { localStorage.setItem(LS_SERVER_ID, serverId); } catch { /* ignore */ }
  try { serverRoomHooks.join(serverId); } catch { /* ignore */ }
  try {
    const ids = (members || []).map((m) => m.user_id || m.id).filter(Boolean).slice(0, 100);
    if (ids.length) {
      const snap = await Api.presence(ids);
      if (snap && typeof snap === 'object') {
        for (const [id, p] of Object.entries(snap)) {
          state.presence.set(String(id), p);
        }
      }
    }
  } catch { /* presence is best-effort */ }
  return { detail, layout, members, perms, roles };
}

let serverRefreshChain = Promise.resolve();
export function refreshServerView() {
  const sid = state.lastServerId;
  if (!sid) return Promise.resolve(null);
  const run = serverRefreshChain.then(() => enterServer(sid)).catch(() => null);
  serverRefreshChain = run.catch(() => null);
  return run.then(() => { repaintView(); return null; });
}

// Two things this deliberately does not do any more:
let bansSeq = 0;
export async function refreshBans(serverId) {
  const sid = serverId || state.lastServerId;
  if (!sid) return state.bans;
  const seq = ++bansSeq;
  try {
    const list = await Api.serverBans(sid);
    if (seq !== bansSeq) return state.bans;          // superseded
    state.bans = Array.isArray(list) ? list : [];
  } catch {
  }
  return state.bans;
}

export function leaveServerContext() {
  try { serverRoomHooks.leave(); } catch { /* ignore */ }
  state.serverDetail = null;
  state.channels = { categories: [], channels: [] };
  state.members = [];
  state.memberTotal = 0;
  state.memberHasMore = false;
  state.permissions = [];
  state.roles = [];
  state.bans = [];
  state.lastServerId = null;
  // session; the next enterServer() repopulates it from a fresh snapshot.
  state.presence.clear();
  try { localStorage.removeItem(LS_SERVER_ID); } catch { /* ignore */ }
}

export async function refreshDms() {
  const dms = await Api.dms();
  state.dms = Array.isArray(dms) ? dms : [];
  return state.dms;
}

export async function refreshFriends() {
  const [friends, reqs] = await Promise.all([Api.friends(), Api.friendRequests()]);
  state.friends = Array.isArray(friends) ? friends : [];
  state.friendsIn = (reqs && reqs.incoming) || [];
  state.friendsOut = (reqs && reqs.outgoing) || [];
  return state;
}

let notifInFlight = null;
export function refreshNotifications() {
  if (notifInFlight) return notifInFlight;
  notifInFlight = (async () => {
    try {
      const n = await Api.notifications({ limit: 30 });
      state.notifUnread = (n && n.unreadCount) || 0;
      state.raw.notifications = (n && n.items) || [];
    } catch { /* non-fatal */ }
    return state.notifUnread;
  })().finally(() => { notifInFlight = null; });
  return notifInFlight;
}

export async function refreshMutes() {
  try {
    const ids = await Api.mutes();
    state.mutedChannels = new Set((ids || []).map(String));
  } catch { /* non-fatal: keep last known set */ }
  return state.mutedChannels;
}

export function isMuted(channelId) {
  return state.mutedChannels.has(String(channelId));
}

export function setMuted(channelId, muted) {
  if (muted) state.mutedChannels.add(String(channelId));
  else state.mutedChannels.delete(String(channelId));
}

export async function refreshActivity() {
  const activity = await Api.activity({ limit: 20 });
  state.activity = Array.isArray(activity) ? activity : [];
  return state.activity;
}

export function setPresence(id, presence) {
  state.presence.set(String(id), presence);
}

export function setOnline(v) {
  state.online = v;
}

const TrycordState = state;
export default TrycordState;
export { Api };
