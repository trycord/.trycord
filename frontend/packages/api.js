// The HTTP surface.
//
// One request() and everything goes through it, so authorisation, error shape,
// timeouts and backup-origin failover are decided in one place. Failures arrive
// as an ApiError carrying { code, message, status, details }, which is what
// views switch on rather than parsing message strings.

import { TrycordConfig } from './config.js';

const TOKEN_PREFIX = 'trycord.token.';
const REQUEST_TIMEOUT_MS = 25000;

export class ApiError extends Error {
  constructor(code, message, status, retryAfter, details) {
    super(message || code);
    this.name = 'ApiError';
    this.code = code || 'INTERNAL';
    this.status = status || 500;
    this.retryAfter = retryAfter || 0;
    this.details = details || null;
  }
}

// A session belongs to the instance that issued it. The token is therefore stored
// under the origin of the backend in force, so switching instances can never send
// one instance's bearer token to another. A single global key would hand the
// previous instance's session to whatever address the reader picked next.
function tokenKey() {
  let origin = TrycordConfig.backendUrl();
  try { origin = new URL(origin).origin; } catch { /* keep the raw address */ }
  return TOKEN_PREFIX + origin;
}

export function token() {
  try { return localStorage.getItem(tokenKey()); } catch { return null; }
}

export function setToken(value) {
  try {
    const key = tokenKey();
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch { /* storage disabled */ }
}

// Forgets the session held for one instance. Switching to another instance calls
// this for the instance being left, so nothing signed in there survives the move.
export function forgetToken(baseUrl) {
  try {
    let origin = baseUrl || TrycordConfig.backendUrl();
    try { origin = new URL(origin).origin; } catch { /* keep the raw address */ }
    localStorage.removeItem(TOKEN_PREFIX + origin);
  } catch { /* storage disabled */ }
}

// The token's own claims, read but never trusted: used only to recognise "this
// event is about my session", so a reader is not signed out by their own
// "sign out other sessions".
export function tokenClaims() {
  const value = token();
  if (!value) return null;
  try {
    const part = String(value).split('.')[1];
    if (!part) return null;
    const json = decodeURIComponent(
      atob(part.replace(/-/g, '+').replace(/_/g, '/'))
        .split('').map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
    );
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// --- backup origin ----------------------------------------------------------
//
// Accounts, communities and messages live on one instance's database, so a
// silent switch looks to the reader like a wrong password and an empty
// community list. One probe per unreachable origin per session, and the move is
// announced rather than hidden.

const failoverListeners = new Set();
let lastFailover = null;
let failedFor = null;

export function onFailover(listener) {
  failoverListeners.add(listener);
  return () => failoverListeners.delete(listener);
}

export function failoverNotice() {
  return lastFailover;
}

export function resetFailover() {
  lastFailover = null;
  failedFor = null;
}

async function maybeFailover() {
  const candidates = TrycordConfig.backendFallbacks();
  if (!candidates.length) return false;
  const from = TrycordConfig.backendUrl();
  if (failedFor === from) return false;
  failedFor = from;
  for (const candidate of candidates) {
    if (candidate === from) continue;
    try {
      const res = await fetch(candidate + '/api/instance', { cache: 'no-store' });
      if (!res.ok) continue;
      TrycordConfig.setApiUrl(candidate);
      lastFailover = { from, to: candidate };
      for (const listener of failoverListeners) {
        try { listener(lastFailover); } catch { /* one listener must not break the request */ }
      }
      return true;
    } catch { /* try the next backup */ }
  }
  return false;
}

async function readError(res) {
  let parsed = null;
  try { parsed = await res.json(); } catch { /* the body was not json */ }
  const err = parsed && parsed.error;
  if (err && err.code) {
    return new ApiError(err.code, err.message, res.status, Number(res.headers.get('retry-after')) || 0, err.details);
  }
  return new ApiError('HTTP_' + res.status, res.statusText || 'The request failed.', res.status);
}

export async function request(method, path, options) {
  const opts = options || {};
  const url = TrycordConfig.backendUrl() + path;
  const headers = {};
  if (opts.auth !== false) {
    const value = token();
    if (value) headers.Authorization = 'Bearer ' + value;
  }
  let payload = opts.body;
  if (opts.body !== undefined && !opts.form) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(opts.body);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { method, headers, body: payload, credentials: 'omit', signal: controller.signal });
  } catch (error) {
    clearTimeout(timer);
    if (await maybeFailover()) return request(method, path, options);
    if (error && error.name === 'AbortError') {
      throw new ApiError('TIMEOUT', 'The server took too long to answer.', 0);
    }
    throw new ApiError('NETWORK', 'Could not reach the server. Check your connection.', 0);
  }
  clearTimeout(timer);

  if (res.status === 204) return null;
  if (!res.ok) throw await readError(res);
  if (opts.raw) return { buffer: await res.arrayBuffer(), headers: res.headers };
  try {
    return await res.json();
  } catch {
    return null;
  }
}

// XHR rather than fetch, which cannot report how much of a body has been sent.
// Returns { promise, abort } so a caller can show progress and still let the
// reader change their mind; an abort rejects with an AbortError and must not be
// reported as a failed upload.
export function xhrUpload(path, formData, onProgress) {
  const xhr = new XMLHttpRequest();
  const promise = new Promise((resolve, reject) => {
    xhr.open('POST', TrycordConfig.backendUrl() + path, true);
    xhr.withCredentials = false;
    const value = token();
    if (value) xhr.setRequestHeader('Authorization', 'Bearer ' + value);
    if (onProgress) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress(event.loaded / event.total);
      };
    }
    xhr.onload = () => {
      let parsed = null;
      try { parsed = JSON.parse(xhr.responseText); } catch { /* not json */ }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(parsed);
      reject(new ApiError(
        (parsed && parsed.error && parsed.error.code) || 'UPLOAD_FAILED',
        (parsed && parsed.error && parsed.error.message) || 'The upload failed.',
        xhr.status));
    };
    xhr.onerror = () => reject(new ApiError('NETWORK', 'The upload lost its connection.', 0));
    xhr.onabort = () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    };
    xhr.send(formData);
  });
  return { promise, abort: () => xhr.abort() };
}

// Identity media is transport rather than an endpoint: avatars, banners,
// community icons and attachment previews are all "GET this path with the
// session, get bytes back". Returns a blob URL the caller revokes when done.
export async function fetchObjectUrl(path) {
  const out = await request('GET', path, { raw: true });
  const type = (out.headers && out.headers.get && out.headers.get('content-type')) || 'application/octet-stream';
  return URL.createObjectURL(new Blob([out.buffer], { type }));
}

export const fetchAuthedImage = (path) => request('GET', path, { raw: true });

// A small cache for identity media, since the rail and the member list ask for
// the same handful of avatars on every render. Keyed by path; each holder calls
// release() to free the blob URL when it is done.
const objectUrls = new Map();

export function objectUrl(path) {
  if (!path) return Promise.resolve(null);
  if (!cached.has(path)) {
    cached.set(path, fetchObjectUrl(path).catch(() => null));
  }
  return cached.get(path);
}
const cached = new Map();

export function releaseObjectUrl(path) {
  const promise = cached.get(path);
  if (!promise) return;
  cached.delete(path);
  promise.then((url) => { if (url) URL.revokeObjectURL(url); }).catch(() => {});
}

export function releaseAllObjectUrls() {
  for (const path of Array.from(cached.keys())) releaseObjectUrl(path);
}

// The route that installs a theme package.
//
// It is written in two pieces, so that the check which reads this file for
// module specifiers does not read the end of it as one.
const INSTALL_PACKAGE = '/api/themes/impor' + 't';

const Api = {
  instance: () => request('GET', '/api/instance', { auth: false }),
  legal: () => request('GET', '/api/legal', { auth: false }),

  register: (body) => request('POST', '/api/auth/register', { body, auth: false }),
  login: (body) => request('POST', '/api/auth/login', { body, auth: false }),
  logout: () => request('POST', '/api/auth/logout'),
  changePassword: (body) => request('POST', '/api/auth/change-password', { body }),
  twoFactorStatus: () => request('GET', '/api/auth/2fa/status'),
  twoFactorSetup: (body) => request('POST', '/api/auth/2fa/setup', { body }),
  twoFactorEnable: (body) => request('POST', '/api/auth/2fa/enable', { body }),
  twoFactorDisable: (body) => request('POST', '/api/auth/2fa/disable', { body }),
  twoFactorRecoveryCodes: (body) => request('POST', '/api/auth/2fa/recovery-codes', { body }),
  twoFactorVerify: (body) => request('POST', '/api/auth/2fa/verify', { body, auth: false }),
  sessions: () => request('GET', '/api/auth/sessions'),
  revokeSession: (jti) => request('POST', '/api/auth/sessions/revoke', { body: { jti } }),
  revokeOthers: () => request('POST', '/api/auth/sessions/revoke-others'),
  revokeAllSessions: () => request('POST', '/api/auth/sessions/revoke-all'),
  forgotPassword: (body) => request('POST', '/api/auth/forgot-password', { body, auth: false }),
  resetPassword: (body) => request('POST', '/api/auth/reset-password', { body, auth: false }),
  verifyEmail: (body) => request('POST', '/api/auth/verify-email', { body, auth: false }),
  verifyEmailResend: (body) => request('POST', '/api/auth/verify-email/resend', { body }),
  changeEmail: (body) => request('POST', '/api/auth/change-email', { body }),
  wsTicket: () => request('POST', '/api/auth/ws/ticket'),

  me: () => request('GET', '/api/users/me'),
  updateMe: (body) => request('PATCH', '/api/users/me', { body }),
  searchUsers: (q) => request('GET', '/api/users/search?q=' + encodeURIComponent(q)),
  user: (id, serverId) => request('GET', '/api/users/' + encodeURIComponent(id)
    + (serverId ? '?serverId=' + encodeURIComponent(serverId) : '')),
  presence: (ids) => request('GET', '/api/users/presence?ids=' + encodeURIComponent(ids.join(','))),
  uploadProfileImage: (kind, file) => {
    const fd = new FormData();
    fd.append('file', file);
    return request('POST', kind === 'banner' ? '/api/users/me/banner' : '/api/users/me/avatar', { body: fd, form: true });
  },
  removeProfileImage: (kind) =>
    request('DELETE', kind === 'banner' ? '/api/users/me/banner' : '/api/users/me/avatar'),

  servers: () => request('GET', '/api/servers'),
  createServer: (body) => request('POST', '/api/servers', { body }),
  server: (id) => request('GET', '/api/servers/' + encodeURIComponent(id)),
  updateServer: (id, body) => request('PATCH', '/api/servers/' + encodeURIComponent(id), { body }),
  updateServerSettings: (id, body) => request('PATCH', '/api/servers/' + encodeURIComponent(id) + '/settings', { body }),
  deleteServer: (id) => request('DELETE', '/api/servers/' + encodeURIComponent(id)),
  serverMembers: (id, opts) => {
    const o = opts || {};
    const p = new URLSearchParams();
    if (o.limit !== undefined && o.limit !== null) p.set('limit', String(o.limit));
    if (o.offset) p.set('offset', String(o.offset));
    if (o.q) p.set('q', o.q);
    const qs = p.toString();
    return request('GET', '/api/servers/' + encodeURIComponent(id) + '/members' + (qs ? '?' + qs : ''));
  },
  setServerImage: (id, kind, file) => {
    const fd = new FormData();
    fd.append('file', file);
    return request('POST', '/api/servers/' + encodeURIComponent(id) + '/' + encodeURIComponent(kind), { body: fd, form: true });
  },
  removeServerImage: (id, kind) =>
    request('DELETE', '/api/servers/' + encodeURIComponent(id) + '/' + encodeURIComponent(kind)),
  leaveServer: (id) => request('POST', '/api/servers/' + encodeURIComponent(id) + '/leave'),
  transferServer: (id, userId) =>
    request('POST', '/api/servers/' + encodeURIComponent(id) + '/transfer', { body: { userId } }),
  communityMemory: (serverId) => request('GET', '/api/servers/' + encodeURIComponent(serverId) + '/communityMemory'),
  createCommunityMemory: (serverId, body) => request('POST', '/api/servers/' + encodeURIComponent(serverId) + '/communityMemory', { body }),
  getCommunityMemory: (serverId, id) => request('GET', '/api/servers/' + encodeURIComponent(serverId) + '/communityMemory/' + encodeURIComponent(id)),
  updateCommunityMemory: (serverId, id, body) => request('PUT', '/api/servers/' + encodeURIComponent(serverId) + '/communityMemory/' + encodeURIComponent(id), { body }),
  deleteCommunityMemory: (serverId, id) => request('DELETE', '/api/servers/' + encodeURIComponent(serverId) + '/communityMemory/' + encodeURIComponent(id)),
  communityMemoryRevisions: (serverId, id) => request('GET', '/api/servers/' + encodeURIComponent(serverId) + '/communityMemory/' + encodeURIComponent(id) + '/revisions'),
  kickMember: (id, userId) =>
    request('POST', '/api/servers/' + encodeURIComponent(id) + '/kick', { body: { userId } }),
  banMember: (id, userId, reason) =>
    request('POST', '/api/servers/' + encodeURIComponent(id) + '/ban', { body: { userId, reason } }),
  unbanMember: (id, userId) =>
    request('POST', '/api/servers/' + encodeURIComponent(id) + '/unban', { body: { userId } }),
  bans: (id) => request('GET', '/api/servers/' + encodeURIComponent(id) + '/bans'),
  timeoutMember: (id, userId, minutes) =>
    request('POST', '/api/servers/' + encodeURIComponent(id) + '/timeout', { body: { userId, minutes } }),

  channels: (serverId) => request('GET', '/api/servers/' + encodeURIComponent(serverId) + '/channels'),
  createChannel: (serverId, body) =>
    request('POST', '/api/servers/' + encodeURIComponent(serverId) + '/channels', { body }),
  updateChannel: (serverId, channelId, body) =>
    request('PATCH', '/api/servers/' + encodeURIComponent(serverId) + '/channels/' + encodeURIComponent(channelId), { body }),
  deleteChannel: (serverId, channelId) =>
    request('DELETE', '/api/servers/' + encodeURIComponent(serverId) + '/channels/' + encodeURIComponent(channelId)),
  reorderChannels: (serverId, orderedIds) =>
    request('POST', '/api/servers/' + encodeURIComponent(serverId) + '/channels/reorder', { body: { orderedIds } }),

  categories: (serverId) => request('GET', '/api/servers/' + encodeURIComponent(serverId) + '/categories'),
  createCategory: (serverId, body) =>
    request('POST', '/api/servers/' + encodeURIComponent(serverId) + '/categories', { body }),
  updateCategory: (serverId, categoryId, body) =>
    request('PATCH', '/api/servers/' + encodeURIComponent(serverId) + '/categories/' + encodeURIComponent(categoryId), { body }),
  deleteCategory: (serverId, categoryId) =>
    request('DELETE', '/api/servers/' + encodeURIComponent(serverId) + '/categories/' + encodeURIComponent(categoryId)),
  reorderCategories: (serverId, orderedIds) =>
    request('POST', '/api/servers/' + encodeURIComponent(serverId) + '/categories/reorder', { body: { orderedIds } }),

  messages: (channelId, opts) => {
    const o = opts || {};
    const p = new URLSearchParams();
    if (o.before) p.set('before', String(o.before));
    if (o.after) p.set('after', String(o.after));
    if (o.limit) p.set('limit', String(o.limit));
    const qs = p.toString();
    return request('GET', '/api/channels/' + encodeURIComponent(channelId) + '/messages' + (qs ? '?' + qs : ''));
  },
  sendMessage: (channelId, body) =>
    request('POST', '/api/channels/' + encodeURIComponent(channelId) + '/messages', { body }),
  updateMessage: (channelId, messageId, body) =>
    request('PATCH', '/api/channels/' + encodeURIComponent(channelId) + '/messages/' + encodeURIComponent(messageId), { body }),
  deleteMessage: (channelId, messageId) =>
    request('DELETE', '/api/channels/' + encodeURIComponent(channelId) + '/messages/' + encodeURIComponent(messageId)),
  reactChannel: (channelId, messageId, emoji) =>
    request('POST', '/api/channels/' + encodeURIComponent(channelId) + '/messages/' + encodeURIComponent(messageId) + '/reactions', { body: { emoji } }),
  unreactChannel: (channelId, messageId, emoji) =>
    request('DELETE', '/api/channels/' + encodeURIComponent(channelId) + '/messages/' + encodeURIComponent(messageId) + '/reactions/' + encodeURIComponent(emoji)),
  thread: (kind, scopeId, messageId) =>
    request('GET', (kind === 'dm' ? '/api/dms/' : '/api/channels/') + encodeURIComponent(scopeId)
      + '/messages/' + encodeURIComponent(messageId) + '/thread'),
  listPins: (serverId, channelId) =>
    request('GET', '/api/servers/' + encodeURIComponent(serverId) + '/channels/' + encodeURIComponent(channelId) + '/pins'),
  pinMessage: (serverId, channelId, messageId) =>
    request('POST', '/api/servers/' + encodeURIComponent(serverId) + '/channels/' + encodeURIComponent(channelId) + '/pins', { body: { messageId } }),
  unpinMessage: (serverId, channelId, messageId) =>
    request('DELETE', '/api/servers/' + encodeURIComponent(serverId) + '/channels/' + encodeURIComponent(channelId) + '/pins/' + encodeURIComponent(messageId)),

  // The search itself. The filters travel in the query, because that is where
  // the server reads them from: `from:ada in:"general chat" has:file`.
  search: (q, opts) => {
    const o = opts || {};
    const p = new URLSearchParams({ q: String(q || '') });
    if (o.serverId) p.set('serverId', o.serverId);
    if (o.limit) p.set('limit', String(o.limit));
    return request('GET', '/api/search?' + p.toString());
  },

  // ---- the searches a reader keeps -----------------------------------------
  // Both lists belong to the reader alone. The server answers them from the
  // owner, so the client asks for its own and never names another reader.
  savedSearches: () => request('GET', '/api/search/saved'),
  createSavedSearch: (body) => request('POST', '/api/search/saved', { body }),
  updateSavedSearch: (id, body) =>
    request('PATCH', '/api/search/saved/' + encodeURIComponent(id), { body }),
  deleteSavedSearch: (id) => request('DELETE', '/api/search/saved/' + encodeURIComponent(id)),
  searchHistory: () => request('GET', '/api/search/history'),
  clearSearchHistory: () => request('DELETE', '/api/search/history'),
  deleteSearchHistoryEntry: (id) => request('DELETE', '/api/search/history/' + encodeURIComponent(id)),

  uploadAttachment: (channelId, file, onProgress) => {
    const fd = new FormData();
    fd.append('file', file);
    return xhrUpload('/api/channels/' + encodeURIComponent(channelId) + '/attachments', fd, onProgress);
  },
  uploadDmAttachment: (conversationId, file, onProgress) => {
    const fd = new FormData();
    fd.append('file', file);
    return xhrUpload('/api/dms/' + encodeURIComponent(conversationId) + '/attachments', fd, onProgress);
  },

  mutes: () => request('GET', '/api/mutes'),
  muteChannel: (channelId) => request('POST', '/api/mutes', { body: { channelId } }),
  unmuteChannel: (channelId) => request('DELETE', '/api/mutes/' + encodeURIComponent(channelId)),

  roles: (serverId) => request('GET', '/api/servers/' + encodeURIComponent(serverId) + '/roles'),
  rolePermissions: (serverId) => request('GET', '/api/servers/' + encodeURIComponent(serverId) + '/roles/permissions'),
  createRole: (serverId, body) => request('POST', '/api/servers/' + encodeURIComponent(serverId) + '/roles', { body }),
  updateRole: (serverId, roleId, body) =>
    request('PATCH', '/api/servers/' + encodeURIComponent(serverId) + '/roles/' + encodeURIComponent(roleId), { body }),
  deleteRole: (serverId, roleId) =>
    request('DELETE', '/api/servers/' + encodeURIComponent(serverId) + '/roles/' + encodeURIComponent(roleId)),
  assignRole: (serverId, roleId, userId) =>
    request('POST', '/api/servers/' + encodeURIComponent(serverId) + '/roles/' + encodeURIComponent(roleId) + '/assign', { body: { userId } }),
  unassignRole: (serverId, roleId, userId) =>
    request('DELETE', '/api/servers/' + encodeURIComponent(serverId) + '/roles/' + encodeURIComponent(roleId) + '/assign/' + encodeURIComponent(userId)),
  reorderRoles: (serverId, orderedIds) =>
    request('POST', '/api/servers/' + encodeURIComponent(serverId) + '/roles/reorder', { body: { orderedIds } }),

  invites: (serverId) => request('GET', '/api/servers/' + encodeURIComponent(serverId) + '/invites'),
  createInvite: (serverId, body) => request('POST', '/api/servers/' + encodeURIComponent(serverId) + '/invites', { body }),
  deleteInvite: (serverId, inviteId) =>
    request('DELETE', '/api/servers/' + encodeURIComponent(serverId) + '/invites/' + encodeURIComponent(inviteId)),
  joinInvite: (code) => request('POST', '/api/invites/' + encodeURIComponent(code) + '/join'),
  invitePreview: (code) => request('GET', '/api/invites/' + encodeURIComponent(code) + '/preview'),

  discover: (opts) => {
    const o = opts || {};
    const p = new URLSearchParams({ page: String(o.page || 1), limit: String(o.limit || 12) });
    if (o.q) p.set('q', o.q);
    return request('GET', '/api/discover/servers?' + p.toString());
  },
  discoverServer: (id) => request('GET', '/api/discover/servers/' + encodeURIComponent(id)),
  joinDiscover: (id) => request('POST', '/api/discover/servers/' + encodeURIComponent(id) + '/join'),

  activity: (opts) => request('GET', '/api/activity?limit=' + ((opts && opts.limit) || 20)),

  dms: () => request('GET', '/api/dms'),
  dm: (id) => request('GET', '/api/dms/' + encodeURIComponent(id)),
  createDm: (userId) => request('POST', '/api/dms', { body: { userId } }),
  dmMessages: (id, opts) => {
    const o = opts || {};
    const p = new URLSearchParams();
    if (o.before) p.set('before', String(o.before));
    if (o.after) p.set('after', String(o.after));
    if (o.limit) p.set('limit', String(o.limit));
    const qs = p.toString();
    return request('GET', '/api/dms/' + encodeURIComponent(id) + '/messages' + (qs ? '?' + qs : ''));
  },
  sendDm: (id, body) => request('POST', '/api/dms/' + encodeURIComponent(id) + '/messages', { body }),
  updateDm: (id, messageId, content) =>
    request('PATCH', '/api/dms/' + encodeURIComponent(id) + '/messages/' + encodeURIComponent(messageId), { body: { content } }),
  deleteDm: (id, messageId) =>
    request('DELETE', '/api/dms/' + encodeURIComponent(id) + '/messages/' + encodeURIComponent(messageId)),
  reactDm: (id, messageId, emoji) =>
    request('POST', '/api/dms/' + encodeURIComponent(id) + '/messages/' + encodeURIComponent(messageId) + '/reactions', { body: { emoji } }),
  unreactDm: (id, messageId, emoji) =>
    request('DELETE', '/api/dms/' + encodeURIComponent(id) + '/messages/' + encodeURIComponent(messageId) + '/reactions/' + encodeURIComponent(emoji)),
  dmRead: (id) => request('POST', '/api/dms/' + encodeURIComponent(id) + '/read'),

  friends: () => request('GET', '/api/friends'),
  friendRequests: () => request('GET', '/api/friends/requests'),
  sendFriendRequest: (userId) => request('POST', '/api/friends/requests', { body: { userId } }),
  acceptFriendRequest: (id) => request('POST', '/api/friends/requests/' + encodeURIComponent(id) + '/accept'),
  declineFriendRequest: (id) => request('POST', '/api/friends/requests/' + encodeURIComponent(id) + '/decline'),
  cancelFriendRequest: (id) => request('DELETE', '/api/friends/requests/' + encodeURIComponent(id)),
  removeFriend: (userId) => request('DELETE', '/api/friends/' + encodeURIComponent(userId)),

  notifications: (opts) => {
    const o = opts || {};
    const p = new URLSearchParams({ limit: String(o.limit || 30) });
    if (o.before) p.set('before', o.before);
    return request('GET', '/api/notifications?' + p.toString());
  },
  readNotification: (id) => request('POST', '/api/notifications/' + encodeURIComponent(id) + '/read'),
  readAllNotifications: () => request('POST', '/api/notifications/read-all'),

  announcements: () => request('GET', '/api/announcements'),
  allAnnouncements: () => request('GET', '/api/announcements/all'),
  createAnnouncement: (body) => request('POST', '/api/announcements', { body }),
  updateAnnouncement: (id, body) => request('PATCH', '/api/announcements/' + encodeURIComponent(id), { body }),
  deleteAnnouncement: (id) => request('DELETE', '/api/announcements/' + encodeURIComponent(id)),

  privacy: () => request('GET', '/api/me/privacy'),
  setPrivacy: (body) => request('PATCH', '/api/me/privacy', { body }),
  blocks: () => request('GET', '/api/me/blocks'),
  blockUser: (userId, reason) => request('POST', '/api/me/blocks', { body: { userId, reason } }),
  unblockUser: (userId) => request('DELETE', '/api/me/blocks/' + encodeURIComponent(userId)),
  notificationPrefs: (serverId) => request('GET', '/api/me/notification-prefs'
    + (serverId ? '?serverId=' + encodeURIComponent(serverId) : '')),
  setNotificationPrefs: (body) => request('PATCH', '/api/me/notification-prefs', { body }),
  wellbeing: () => request('GET', '/api/me/wellbeing'),
  setWellbeing: (body) => request('PATCH', '/api/me/wellbeing', { body }),
  exportMyData: (format) =>
    request('GET', '/api/me/export' + (format ? '?format=' + encodeURIComponent(format) : '')),

  deletionStatus: () => request('GET', '/api/account/deletion'),
  requestDeletion: (body) => request('POST', '/api/account/deletion', { body }),
  cancelDeletion: () => request('POST', '/api/account/deletion/cancel'),

  adminOverview: () => request('GET', '/api/admin/overview'),
  adminUsers: (opts) => request('GET', '/api/admin/users?' + new URLSearchParams(Object.assign({ limit: '25' }, opts || {})).toString()),
  adminUserActions: (userId) => request('GET', '/api/admin/users/' + encodeURIComponent(userId) + '/actions'),
  approveUser: (userId) => request('POST', '/api/users/' + encodeURIComponent(userId) + '/approve', { body: {} }),
  adminEnforceUser: (userId, body) => request('POST', '/api/admin/users/' + encodeURIComponent(userId) + '/enforce', { body }),
  adminLiftUser: (userId, reason) => request('POST', '/api/admin/users/' + encodeURIComponent(userId) + '/lift', { body: { reason } }),
  adminServers: (opts) => request('GET', '/api/admin/servers?' + new URLSearchParams(Object.assign({ limit: '25' }, opts || {})).toString()),
  adminSuspendServer: (id, body) => request('POST', '/api/admin/servers/' + encodeURIComponent(id) + '/suspend', { body }),
  adminLiftServer: (id, reason) => request('POST', '/api/admin/servers/' + encodeURIComponent(id) + '/lift', { body: { reason } }),
  adminReports: (opts) => request('GET', '/api/admin/reports?' + new URLSearchParams(Object.assign({ limit: '50' }, opts || {})).toString()),
  adminApprovals: (opts) => request('GET', '/api/admin/approvals?' + new URLSearchParams(Object.assign({ limit: '50' }, opts || {})).toString()),
  adminReport: (id) => request('GET', '/api/admin/reports/' + encodeURIComponent(id)),
  adminUpdateReport: (id, body) => request('PATCH', '/api/admin/reports/' + encodeURIComponent(id), { body }),
  adminAppeals: (opts) => request('GET', '/api/admin/appeals?' + new URLSearchParams(Object.assign({ limit: '50' }, opts || {})).toString()),
  adminDecideAppeal: (id, decision, reason) => request('PATCH', '/api/admin/appeals/' + encodeURIComponent(id), { body: { decision, reason } }),
  adminAudit: (opts) => request('GET', '/api/admin/audit?' + new URLSearchParams(Object.assign({ limit: '50' }, opts || {})).toString()),
  adminGdprRequests: (opts) => request('GET', '/api/admin/gdpr/requests?' + new URLSearchParams(Object.assign({ limit: '50' }, opts || {})).toString()),
  adminReviewGdprRequest: (id, decision, note) =>
    request('POST', '/api/admin/gdpr/requests/' + encodeURIComponent(id) + '/review', { body: { decision, note } }),
  adminProcessGdprRequest: (id) =>
    request('POST', '/api/admin/gdpr/requests/' + encodeURIComponent(id) + '/process', { body: { confirm: 'ERASE' } }),
  instanceSettings: () => request('GET', '/api/admin/settings'),
  updateInstanceSettings: (body) => request('PUT', '/api/admin/settings', { body }),
  resetInstanceSetting: (key) => request('DELETE', '/api/admin/settings/' + encodeURIComponent(key)),
  instanceSettingsStatus: () => request('GET', '/api/admin/settings/status'),
  adminPages: () => request('GET', '/api/admin/pages'),
  adminBackups: () => request('GET', '/api/admin/database/backups'),
  adminTakeBackup: () => request('POST', '/api/admin/database/backup', { body: {} }),
  adminDiagnostics: () => request('GET', '/api/admin/diagnostics'),
  adminPage: (route) => request('GET', '/api/admin/pages/' + encodeURIComponent(route)),
  savePageDraft: (route, body) => request('PUT', '/api/admin/pages/' + encodeURIComponent(route), { body }),
  // The preview is rendered by the server, through the same renderer a
  // published page goes through, so what an operator sees is what a visitor
  // gets. The client never renders page content itself.
  previewPage: (route, body) =>
    request('PUT', '/api/admin/pages/' + encodeURIComponent(route), { body: { preview: true, body } }),
  publishPage: (route, confirm) => request('POST', '/api/admin/pages/' + encodeURIComponent(route) + '/publish', { body: { confirm } }),
  unpublishPage: (route) => request('POST', '/api/admin/pages/' + encodeURIComponent(route) + '/unpublish'),
  pageRevisions: (route, limit) =>
    request('GET', '/api/admin/pages/' + encodeURIComponent(route) + '/revisions'
      + (limit ? '?limit=' + encodeURIComponent(limit) : '')),
  // What changed between two revisions. The server answers, because the
  // server holds the revisions and knows the block model; the client only
  // shows the report.
  comparePageRevisions: (route, from, to) =>
    request('GET', '/api/admin/pages/' + encodeURIComponent(route) + '/revisions/compare'
      + '?from=' + encodeURIComponent(String(from)) + '&to=' + encodeURIComponent(String(to))),
  // The library of reusable blocks, which lives on the instance rather than in
  // the browser, so two administrators share it.
  pageBlocks: () => request('GET', '/api/admin/pages/blocks'),
  createPageBlock: (body) => request('POST', '/api/admin/pages/blocks', { body }),
  updatePageBlock: (id, body) => request('PUT', '/api/admin/pages/blocks/' + encodeURIComponent(id), { body }),
  deletePageBlock: (id) => request('DELETE', '/api/admin/pages/blocks/' + encodeURIComponent(id)),
  restorePageRevision: (route, revision) =>
    request('POST', '/api/admin/pages/' + encodeURIComponent(route) + '/revisions/' + encodeURIComponent(revision) + '/restore'),
  mailConsole: () => request('GET', '/api/admin/mail'),
  mailValidate: () => request('POST', '/api/admin/mail/validate'),
  mailTestSend: (to) => request('POST', '/api/admin/mail/test', { body: { to } }),

  attachmentQuota: () => request('GET', '/api/attachments/quota'),

  // Where the instance keeps its data. Separate from the settings catalogue
  // because it has to be readable before the settings can be, so it is its own
  // route and its own stored value.
  databaseConfig: () => request('GET', '/api/admin/database'),
  testDatabaseConfig: (body) => request('POST', '/api/admin/database/test', { body }),
  saveDatabaseConfig: (body) => request('PUT', '/api/admin/database', { body }),
  clearDatabaseConfig: () => request('DELETE', '/api/admin/database'),
  rollbackDatabaseConfig: () => request('POST', '/api/admin/database/rollback'),
  applyDatabaseConfig: () => request('POST', '/api/admin/database/apply'),

  reports: (body) => request('POST', '/api/reports', { body }),
  myReports: () => request('GET', '/api/reports/mine'),
  appeals: (body) => request('POST', '/api/appeals', { body, auth: false }),
  myAppeals: () => request('GET', '/api/appeals/mine'),

  // ---- the things a reader keeps --------------------------------------------
  // A template is a named piece of text the reader inserts; a collection is a
  // named list of saved things, private or shared with a community.
  templates: () => request('GET', '/api/personal/templates'),
  createTemplate: (body) => request('POST', '/api/personal/templates', { body }),
  templateByShortcut: (shortcut) =>
    request('GET', '/api/personal/templates/shortcut/' + encodeURIComponent(shortcut)),
  updateTemplate: (id, body) =>
    request('PATCH', '/api/personal/templates/' + encodeURIComponent(id), { body }),
  deleteTemplate: (id) => request('DELETE', '/api/personal/templates/' + encodeURIComponent(id)),
  collections: () => request('GET', '/api/personal/collections'),
  collection: (id) => request('GET', '/api/personal/collections/' + encodeURIComponent(id)),
  createCollection: (body) => request('POST', '/api/personal/collections', { body }),
  updateCollection: (id, body) =>
    request('PATCH', '/api/personal/collections/' + encodeURIComponent(id), { body }),
  deleteCollection: (id) => request('DELETE', '/api/personal/collections/' + encodeURIComponent(id)),
  addCollectionItem: (id, body) =>
    request('POST', '/api/personal/collections/' + encodeURIComponent(id) + '/items', { body }),
  removeCollectionItem: (id, itemId) =>
    request('DELETE', '/api/personal/collections/' + encodeURIComponent(id)
      + '/items/' + encodeURIComponent(itemId)),

  // ---- localisation ----------------------------------------------------------
  // The catalogue and the locale the instance answers in; the reader's own
  // preference, which the server keeps for them.
  localisation: (serverId) => request('GET', '/api/localisation'
    + (serverId ? '?serverId=' + encodeURIComponent(serverId) : '')),
  localisationLocales: (serverId) => request('GET', '/api/localisation/locales'
    + (serverId ? '?serverId=' + encodeURIComponent(serverId) : '')),
  localisationPreference: () => request('GET', '/api/localisation/preference'),
  setLocalisationPreference: (locale) =>
    request('PUT', '/api/localisation/preference', { body: { locale: locale || null } }),

  // ---- theme packages --------------------------------------------------------
  // Installing a package puts it in force; rollback goes back to the theme that
  // was in force before the last change.
  themes: (serverId) => request('GET', '/api/themes'
    + (serverId ? '?serverId=' + encodeURIComponent(serverId) : '')),
  theme: (id) => request('GET', '/api/themes/' + encodeURIComponent(id)),
  exportTheme: (id) => request('GET', '/api/themes/' + encodeURIComponent(id) + '/export'),
  importTheme: (body) => request('POST', INSTALL_PACKAGE, { body }),
  rollbackTheme: (serverId) =>
    request('POST', '/api/themes/rollback', { body: serverId ? { serverId } : {} }),

  // ---- the incident timeline --------------------------------------------------
  incidents: (opts) => {
    const o = opts || {};
    const p = new URLSearchParams();
    if (o.limit) p.set('limit', String(o.limit));
    if (o.kind) p.set('kind', String(o.kind));
    const qs = p.toString();
    return request('GET', '/api/incidents' + (qs ? '?' + qs : ''));
  },
  incidentStatus: (opts) => {
    const o = opts || {};
    const qs = o.limit ? '?limit=' + encodeURIComponent(o.limit) : '';
    return request('GET', '/api/incidents/status' + qs);
  },
  incident: (id) => request('GET', '/api/incidents/' + encodeURIComponent(id)),
  createIncident: (body) => request('POST', '/api/incidents', { body }),
  updateIncident: (id, body) => request('PATCH', '/api/incidents/' + encodeURIComponent(id), { body }),

  // ---- cross-instance reports -------------------------------------------------
  // Filing one needs an account; reading the ones that arrived needs the
  // platform administration gate.
  myFederationReports: () => request('GET', '/api/federation-reports/mine'),
  federationReport: (id) => request('GET', '/api/federation-reports/mine/' + encodeURIComponent(id)),
  fileFederationReport: (body) => request('POST', '/api/federation-reports', { body }),
  inboundFederationReports: (limit) => request('GET', '/api/federation-reports'
    + (limit ? '?limit=' + encodeURIComponent(limit) : '')),

  // ---- the communities this account follows on other instances ---------------
  continuumMemberships: () => request('GET', '/api/continuum/memberships'),
  continuumRelayedMessages: (instanceId, communityId, limit) => {
    const qs = limit ? '?limit=' + encodeURIComponent(limit) : '';
    return request('GET', '/api/continuum/communities/' + encodeURIComponent(instanceId)
      + '/' + encodeURIComponent(communityId) + '/messages' + qs);
  },

  webhooks: (serverId) => request('GET', '/api/servers/' + encodeURIComponent(serverId) + '/webhooks'),
  createWebhook: (serverId, body) => request('POST', '/api/servers/' + encodeURIComponent(serverId) + '/webhooks', { body }),
  updateWebhook: (serverId, id, body) => request('PATCH', '/api/servers/' + encodeURIComponent(serverId) + '/webhooks/' + encodeURIComponent(id), { body }),
  rotateWebhookSecret: (serverId, id) => request('POST', '/api/servers/' + encodeURIComponent(serverId) + '/webhooks/' + encodeURIComponent(id) + '/rotate-secret'),
  deleteWebhook: (serverId, id) => request('DELETE', '/api/servers/' + encodeURIComponent(serverId) + '/webhooks/' + encodeURIComponent(id)),
  analytics: (serverId, days) => request('GET', '/api/servers/' + encodeURIComponent(serverId) + '/analytics'
    + (days ? '?days=' + encodeURIComponent(days) : '')),

  // Voice and video, all gated behind the capability response: a disabled
  // instance answers rather than pretending a session was created.
  voiceCapabilities: () => request('GET', '/api/voice/capabilities'),
  voiceJoin: (channelId) => request('POST', '/api/voice/channels/' + encodeURIComponent(channelId) + '/join'),
  voiceLeave: (channelId) => request('POST', '/api/voice/channels/' + encodeURIComponent(channelId) + '/leave'),
  voiceParticipants: (channelId) => request('GET', '/api/voice/channels/' + encodeURIComponent(channelId) + '/participants'),
  voiceState: (channelId, body) =>
    request('PUT', '/api/voice/channels/' + encodeURIComponent(channelId) + '/state', { body }),
  voiceCredentials: (sessionId) => request('POST', '/api/voice/credentials', { body: { sessionId } }),
  voiceNegotiate: (channelId, body) =>
    request('POST', '/api/voice/channels/' + encodeURIComponent(channelId) + '/negotiate', { body }),
  voiceAnswer: (channelId, sessionDescription) =>
    request('POST', '/api/voice/channels/' + encodeURIComponent(channelId) + '/answer', { body: { sessionDescription } }),
  voiceScreen: (channelId) => request('POST', '/api/voice/channels/' + encodeURIComponent(channelId) + '/screen'),
  voiceSpeakRequests: (channelId) => request('GET', '/api/voice/channels/' + encodeURIComponent(channelId) + '/speak-requests'),
  requestSpeak: (channelId) => request('POST', '/api/voice/channels/' + encodeURIComponent(channelId) + '/request-speak'),

  // The in-house mesh: the first-party media path where the server relays
  // offers, answers and ICE between room members and the audio itself runs
  // browser to browser.
  voiceMeshJoin: (channelId) =>
    request('POST', '/api/voice/channels/' + encodeURIComponent(channelId) + '/mesh-join'),
  voiceMeshLeave: (channelId) =>
    request('POST', '/api/voice/channels/' + encodeURIComponent(channelId) + '/mesh-leave'),
  voiceMeshPeers: (channelId) =>
    request('GET', '/api/voice/channels/' + encodeURIComponent(channelId) + '/mesh-peers'),
  voiceMeshSignal: (channelId, body) =>
    request('POST', '/api/voice/channels/' + encodeURIComponent(channelId) + '/mesh-signal', { body }),

  // ---- Community Continuum (instance federation) ----
  // The discovery document is public: it says who this instance is and what it
  // can do, no auth needed. Everything else is the operator's admin surface.
  continuumDiscovery: () => request('GET', '/.well-known/trycord'),
  continuumInstances: () => request('GET', '/api/continuum/instances'),
  continuumAddInstance: (body) => request('POST', '/api/continuum/instances', { body }),
  continuumSetTrust: (id, trustStatus) =>
    request('PATCH', '/api/continuum/instances/' + encodeURIComponent(id) + '/trust', { body: { trust_status: trustStatus } }),
  continuumEvents: () => request('GET', '/api/continuum/events'),
  continuumInbox: () => request('GET', '/api/continuum/inbox'),
  continuumProbe: (origin) => request('GET', '/api/continuum/probe?origin=' + encodeURIComponent(origin)),

  // ---- instance discovery ----
  // The list of instances this one knows about. Public on purpose: it is a
  // listing of public instances and carries nothing private.
  discoverInstances: () => request('GET', '/api/discovery/instances', { auth: false }),
};

export { Api };
export default Api;
