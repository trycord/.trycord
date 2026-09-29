// carrying { code, message, status, retryAfter }. Authorization is attached
// from state.js (localStorage token) unless overridden.

import { TrycordConfig } from './config.js';

const TOKEN_KEY = 'trycord.token';

export class ApiError extends Error {
  constructor(code, message, status, retryAfter, details) {
    super(message || code);
    this.name = 'ApiError';
    this.code = code || 'INTERNAL';
    this.status = status || 500;
    this.retryAfter = retryAfter || 0;
    // Never sensitive: the server decides what goes in here.
    this.details = details || null;
  }
}

const REQUEST_TIMEOUT_MS = 25000;

function base() {
  return TrycordConfig.backendUrl().replace(/\/+$/, '');
}

export function token() {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

export function setToken(t) {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* ignore */ }
}

export function apiBase() {
  return base();
}

async function request(method, path, { body, auth = true, raw = false, form = false } = {}) {
  const url = base() + path;
  const headers = {};
  if (auth) {
    const t = token();
    if (t) headers.Authorization = 'Bearer ' + t;
  }
  let payload = body;
  if (body !== undefined && !form) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    res = await fetch(url, { method, headers, body: payload, credentials: 'omit', signal: ctrl.signal });
  } catch (e) {
    if (e && e.name === 'AbortError') throw new ApiError('TIMEOUT', 'the request timed out — the backend may be unreachable', 0);
    throw new ApiError('NETWORK', 'cannot reach the Trycord server', 0);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401) {
    // Token missing/bad/revoked: drop it and surface a typed error so the
    if (auth) setToken(null);
    try {
      const e = await res.json().catch(() => null);
      if (e && e.error) throw new ApiError(e.error.code, e.error.message, 401, 0, e.error.details);
    } catch (err) { if (err instanceof ApiError) throw err; }
    throw new ApiError('AUTH_REQUIRED', 'you need to sign in', 401);
  }
  if (!res.ok) {
    let info = null;
    try { info = await res.json(); } catch { /* non-json error */ }
    const retryAfter = parseInt(res.headers.get('Retry-After') || '0', 10) || 0;
    if (info && info.error) {
      throw new ApiError(info.error.code, info.error.message, res.status, retryAfter, info.error.details);
    }
    throw new ApiError('HTTP_' + res.status, res.statusText || 'request failed', res.status, retryAfter);
  }
  if (raw) {
    const buffer = await res.arrayBuffer();
    return { buffer, headers: res.headers };
  }
  if (res.status === 204) return null;
  return res.json().catch(() => null);
}

const Api = {
  instance: () => request('GET', '/api/instance', { auth: false }),
  legal: () => request('GET', '/api/legal', { auth: false }),

  register: (body) => request('POST', '/api/auth/register', { body, auth: false }),
  login: (body) => request('POST', '/api/auth/login', { body, auth: false }),
  logout: () => request('POST', '/api/auth/logout'),
  changePassword: (body) => request('POST', '/api/auth/change-password', { body }),
  revokeAllSessions: () => request('POST', '/api/auth/sessions/revoke-all'),
  revokeOthers: () => request('POST', '/api/auth/sessions/revoke-others'),
  forgotPassword: (body) => request('POST', '/api/auth/forgot-password', { body, auth: false }),
  resetPassword: (body) => request('POST', '/api/auth/reset-password', { body, auth: false }),
  verifyEmail: (body) => request('POST', '/api/auth/verify-email', { body, auth: false }),
  verifyEmailResend: (body) => request('POST', '/api/auth/verify-email/resend', { body }),
  changeEmail: (body) => request('POST', '/api/auth/change-email', { body }),
  wsTicket: () => request('POST', '/api/auth/ws/ticket'),

  me: () => request('GET', '/api/users/me'),
  updateMe: (body) => request('PATCH', '/api/users/me', { body }),
  searchUsers: (q) => request('GET', '/api/users/search?q=' + encodeURIComponent(q)),
  presence: (ids) => request('GET', '/api/users/presence?ids=' + encodeURIComponent(ids.join(','))),
  user: (id, serverId) => request('GET', '/api/users/' + encodeURIComponent(id) + (serverId ? '?serverId=' + encodeURIComponent(serverId) : '')),
  legacyMe: () => request('GET', '/api/me'),

  uploadProfileImage: (kind, file) => {
    const fd = new FormData();
    fd.append('file', file);
    return request('POST', kind === 'banner' ? '/api/users/me/banner' : '/api/users/me/avatar',
      { body: fd, form: true });
  },
  removeProfileImage: (kind) =>
    request('DELETE', kind === 'banner' ? '/api/users/me/banner' : '/api/users/me/avatar'),
  fetchProfileImage: (path) => request('GET', path, { raw: true }),
  // Generic authenticated image fetch. Profile avatars/banners and community
  // icons/banners are both "GET this path with the session, get bytes back", so
  fetchAuthedImage: (path) => request('GET', path, { raw: true }),

  servers: () => request('GET', '/api/servers'),
  createServer: (body) => request('POST', '/api/servers', { body }),
  server: (id) => request('GET', '/api/servers/' + encodeURIComponent(id)),
  updateServer: (id, body) => request('PATCH', '/api/servers/' + encodeURIComponent(id), { body }),
  deleteServer: (id) => request('DELETE', '/api/servers/' + encodeURIComponent(id)),
  serverMembers: (id, { limit, offset, q } = {}) => {
    const p = new URLSearchParams();
    if (limit !== undefined && limit !== null) p.set('limit', String(limit));
    if (offset) p.set('offset', String(offset));
    if (q) p.set('q', q);
    const qs = p.toString();
    return request('GET', '/api/servers/' + encodeURIComponent(id) + '/members' + (qs ? '?' + qs : ''));
  },
  // Community identity media. The bytes live behind the authenticated media
  // route, so the client fetches them with the session and swaps in a blob URL
  setServerImage: (id, kind, file) => {
    const fd = new FormData();
    fd.append('file', file);
    return request('POST', '/api/servers/' + encodeURIComponent(id) + '/' + encodeURIComponent(kind),
      { body: fd, form: true });
  },
  removeServerImage: (id, kind) =>
    request('DELETE', '/api/servers/' + encodeURIComponent(id) + '/' + encodeURIComponent(kind)),
  leaveServer: (id) => request('POST', '/api/servers/' + encodeURIComponent(id) + '/leave'),
  // Hand the community to another member. Owner-only, server-authorised.
  transferServer: (id, userId) =>
    request('POST', '/api/servers/' + encodeURIComponent(id) + '/transfer', { body: { userId } }),
  kickMember: (id, userId) => request('POST', '/api/servers/' + encodeURIComponent(id) + '/kick', { body: { userId } }),
  banMember: (id, userId, body) => request('POST', '/api/servers/' + encodeURIComponent(id) + '/ban', { body: { userId, ...(body || {}) } }),
  unbanMember: (id, userId) => request('POST', '/api/servers/' + encodeURIComponent(id) + '/unban', { body: { userId } }),
  serverBans: (id) => request('GET', '/api/servers/' + encodeURIComponent(id) + '/bans'),
  timeoutMember: (id, userId, minutes) => request('POST', '/api/servers/' + encodeURIComponent(id) + '/timeout', { body: { userId, minutes } }),
  setNickname: (serverId, userId, nickname) =>
    request('PATCH', '/api/servers/' + encodeURIComponent(serverId) + '/members/' + encodeURIComponent(userId) + '/nickname', { body: { nickname } }),
  serverByCode: (code) => request('GET', '/api/servers/by-code/' + encodeURIComponent(code)),
  joinServerByCode: (code) => request('POST', '/api/servers/join/' + encodeURIComponent(code)),

  channels: (serverId) => request('GET', '/api/servers/' + encodeURIComponent(serverId) + '/channels'),
  createChannel: (serverId, body) => request('POST', '/api/servers/' + encodeURIComponent(serverId) + '/channels', { body }),
  updateChannel: (serverId, channelId, body) =>
    request('PATCH', '/api/servers/' + encodeURIComponent(serverId) + '/channels/' + encodeURIComponent(channelId), { body }),
  deleteChannel: (serverId, channelId) =>
    request('DELETE', '/api/servers/' + encodeURIComponent(serverId) + '/channels/' + encodeURIComponent(channelId)),

  categories: (serverId) => request('GET', '/api/servers/' + encodeURIComponent(serverId) + '/categories'),
  createCategory: (serverId, body) => request('POST', '/api/servers/' + encodeURIComponent(serverId) + '/categories', { body }),
  deleteCategory: (serverId, categoryId) =>
    request('DELETE', '/api/servers/' + encodeURIComponent(serverId) + '/categories/' + encodeURIComponent(categoryId)),
  renameCategory: (serverId, categoryId, name) =>
    request('PATCH', '/api/servers/' + encodeURIComponent(serverId) + '/categories/' + encodeURIComponent(categoryId), { body: { name } }),
  reorderCategories: (serverId, orderedIds) =>
    request('POST', '/api/servers/' + encodeURIComponent(serverId) + '/categories/reorder', { body: { orderedIds } }),
  reorderChannels: (serverId, orderedIds) =>
    request('POST', '/api/servers/' + encodeURIComponent(serverId) + '/channels/reorder', { body: { orderedIds } }),

  // ---- permission overrides: category -> channel tri-state --------------
  channelOverrides: (serverId, channelId) =>
    request('GET', '/api/servers/' + encodeURIComponent(serverId) + '/channels/' + encodeURIComponent(channelId) + '/overrides'),
  setChannelOverride: (serverId, channelId, permission, effect) =>
    request('PUT', '/api/servers/' + encodeURIComponent(serverId) + '/channels/' + encodeURIComponent(channelId) +
      '/overrides/' + encodeURIComponent(permission), { body: { effect } }),
  categoryOverrides: (serverId, categoryId) =>
    request('GET', '/api/servers/' + encodeURIComponent(serverId) + '/categories/' + encodeURIComponent(categoryId) + '/overrides'),
  setCategoryOverride: (serverId, categoryId, permission, effect) =>
    request('PUT', '/api/servers/' + encodeURIComponent(serverId) + '/categories/' + encodeURIComponent(categoryId) +
      '/overrides/' + encodeURIComponent(permission), { body: { effect } }),
  messages: (channelId, { before, after, limit } = {}) => {
    const q = new URLSearchParams();
    if (before !== undefined && before !== null) q.set('before', String(before));
    if (after !== undefined && after !== null) q.set('after', String(after));
    if (limit) q.set('limit', String(limit));
    const qs = q.toString();
    return request('GET', '/api/channels/' + encodeURIComponent(channelId) + '/messages' + (qs ? '?' + qs : ''));
  },
  sendMessage: (channelId, body) =>
    request('POST', '/api/channels/' + encodeURIComponent(channelId) + '/messages', { body }),
  updateMessage: (channelId, messageId, body) =>
    request('PATCH', '/api/channels/' + encodeURIComponent(channelId) + '/messages/' + encodeURIComponent(messageId), { body }),
  deleteMessage: (channelId, messageId) =>
    request('DELETE', '/api/channels/' + encodeURIComponent(channelId) + '/messages/' + encodeURIComponent(messageId)),

  search: (q, { serverId, limit } = {}) => {
    const p = new URLSearchParams({ q: String(q || '') });
    if (serverId) p.set('serverId', serverId);
    if (limit) p.set('limit', String(limit));
    return request('GET', '/api/search?' + p.toString());
  },
  listPins: (serverId, channelId) =>
    request('GET', '/api/servers/' + encodeURIComponent(serverId) + '/channels/' + encodeURIComponent(channelId) + '/pins'),
  pinMessage: (serverId, channelId, messageId) =>
    request('POST', '/api/servers/' + encodeURIComponent(serverId) + '/channels/' + encodeURIComponent(channelId) + '/pins', { body: { messageId } }),
  unpinMessage: (serverId, channelId, messageId) =>
    request('DELETE', '/api/servers/' + encodeURIComponent(serverId) + '/channels/' + encodeURIComponent(channelId) + '/pins/' + encodeURIComponent(messageId)),
  addReaction: (channelId, messageId, emoji) =>
    request('POST', '/api/channels/' + encodeURIComponent(channelId) + '/messages/' + encodeURIComponent(messageId) + '/reactions', { body: { emoji } }),
  removeReaction: (channelId, messageId, emoji) =>
    request('DELETE', '/api/channels/' + encodeURIComponent(channelId) + '/messages/' + encodeURIComponent(messageId) + '/reactions/' + encodeURIComponent(emoji)),
  mutes: () => request('GET', '/api/mutes'),
  muteChannel: (channelId) => request('POST', '/api/mutes', { body: { channelId } }),
  unmuteChannel: (channelId) => request('DELETE', '/api/mutes/' + encodeURIComponent(channelId)),

  // server-side (this client flag is never the authority).
  announcements: () => request('GET', '/api/announcements'),
  allAnnouncements: () => request('GET', '/api/announcements/all'),
  createAnnouncement: (data) => request('POST', '/api/announcements', { body: data }),
  updateAnnouncement: (id, data) => request('PATCH', '/api/announcements/' + encodeURIComponent(id), { body: data }),
  deleteAnnouncement: (id) => request('DELETE', '/api/announcements/' + encodeURIComponent(id)),

  uploadAttachment: async (channelId, file) => {
    const fd = new FormData();
    fd.append('file', file);
    return request('POST', '/api/channels/' + encodeURIComponent(channelId) + '/attachments',
      { body: fd, form: true });
  },
  attachmentUrl: (id) => base() + '/api/attachments/' + encodeURIComponent(id),
  fetchAttachment: (id) => request('GET', '/api/attachments/' + encodeURIComponent(id), { raw: true }),

  serverPermissions: (serverId) => request('GET', '/api/servers/' + encodeURIComponent(serverId) + '/roles/permissions'),
  roles: (serverId) => request('GET', '/api/servers/' + encodeURIComponent(serverId) + '/roles'),
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
  // There is deliberately no self-assign call. Roles reach members only through

  invites: (serverId) => request('GET', '/api/servers/' + encodeURIComponent(serverId) + '/invites'),
  createInvite: (serverId, body) => request('POST', '/api/servers/' + encodeURIComponent(serverId) + '/invites', { body }),
  deleteInvite: (serverId, inviteId) =>
    request('DELETE', '/api/servers/' + encodeURIComponent(serverId) + '/invites/' + encodeURIComponent(inviteId)),
  invitePreview: (code) => request('GET', '/api/invites/' + encodeURIComponent(code) + '/preview'),
  joinInvite: (code) => request('POST', '/api/invites/' + encodeURIComponent(code) + '/join'),
discover: ({ q = '', page = 1, limit = 12 } = {}) => {
    const qs = new URLSearchParams({
        page: String(page),
        limit: String(limit),
    });

    if (q) qs.set('q', q);

    // Use the existing stored session token.
    return request(
        'GET',
        '/api/discover/servers?' + qs.toString(),
        { auth: true }
    );
},

discoverServer: (id) =>
    request(
        'GET',
        '/api/discover/servers/' + encodeURIComponent(id),
        { auth: true }
    ),

joinDiscover: (id) =>
    request(
        'POST',
        '/api/discover/servers/' + encodeURIComponent(id) + '/join',
        { auth: true }
    ),

  activity: ({ limit = 20 } = {}) => request('GET', '/api/activity?limit=' + limit),

  // Submit is anonymous by design (possession of the action id is the key);
  submitAppeal: (body) => request('POST', '/api/appeals', { body, auth: false }),
  myAppeals: () => request('GET', '/api/appeals/mine'),

  dms: () => request('GET', '/api/dms'),
  dm: (id) => request('GET', '/api/dms/' + encodeURIComponent(id)),
  openDm: (userId) => request('POST', '/api/dms', { body: { userId } }),
  dmMessages: (id, { before, after, limit } = {}) => {
    const q = new URLSearchParams();
    if (after !== undefined && after !== null && after !== '') q.set('after', String(after));
    if (before) q.set('before', before);
    if (limit) q.set('limit', String(limit));
    const qs = q.toString();
    return request('GET', '/api/dms/' + encodeURIComponent(id) + '/messages' + (qs ? '?' + qs : ''));
  },
  sendDm: (id, content, clientNonce) =>
    request('POST', '/api/dms/' + encodeURIComponent(id) + '/messages',
      { body: clientNonce ? { content, clientNonce } : { content } }),
  deleteDm: (id, messageId) =>
    request('DELETE', '/api/dms/' + encodeURIComponent(id) + '/messages/' + encodeURIComponent(messageId)),
  updateDm: (id, messageId, content) =>
    request('PATCH', '/api/dms/' + encodeURIComponent(id) + '/messages/' + encodeURIComponent(messageId), { body: { content } }),
  dmRead: (id) => request('POST', '/api/dms/' + encodeURIComponent(id) + '/read'),

  friends: () => request('GET', '/api/friends'),
  friendRequests: () => request('GET', '/api/friends/requests'),
  sendFriendRequest: (userId) => request('POST', '/api/friends/requests', { body: { userId } }),
  acceptFriendRequest: (id) => request('POST', '/api/friends/requests/' + encodeURIComponent(id) + '/accept'),
  declineFriendRequest: (id) => request('POST', '/api/friends/requests/' + encodeURIComponent(id) + '/decline'),
  cancelFriendRequest: (id) => request('DELETE', '/api/friends/requests/' + encodeURIComponent(id)),
  removeFriend: (userId) => request('DELETE', '/api/friends/' + encodeURIComponent(userId)),

  notifications: ({ limit = 30, before = null } = {}) => {
    const q = new URLSearchParams();
    q.set('limit', String(limit));
    if (before) q.set('before', before);
    return request('GET', '/api/notifications?' + q.toString());
  },
  readAllNotifications: () => request('POST', '/api/notifications/read-all'),
  readNotification: (id) => request('POST', '/api/notifications/' + encodeURIComponent(id) + '/read'),

  adminOverview: () => request('GET', '/api/admin/overview'),
  adminUsers: ({ q = '', limit = 25 } = {}) =>
    request('GET', '/api/admin/users?q=' + encodeURIComponent(q) + '&limit=' + limit),
  adminUserActions: (userId) =>
    request('GET', '/api/admin/users/' + encodeURIComponent(userId) + '/actions'),
  adminEnforceUser: (userId, actionType, reason, { hours, reportId, confirm } = {}) =>
    request('POST', '/api/admin/users/' + encodeURIComponent(userId) + '/enforce',
      { body: { actionType, reason, expiresInHours: hours, reportId, confirm } }),
  adminLiftUser: (userId, reason) =>
    request('POST', '/api/admin/users/' + encodeURIComponent(userId) + '/lift', { body: { reason } }),
  adminSetBot: (userId, isBot) =>
    request('POST', '/api/admin/users/' + encodeURIComponent(userId) + '/bot', { body: { isBot: !!isBot } }),
  adminServers: ({ q = '', limit = 25 } = {}) =>
    request('GET', '/api/admin/servers?q=' + encodeURIComponent(q) + '&limit=' + limit),
  adminServerActions: (serverId) =>
    request('GET', '/api/admin/servers/' + encodeURIComponent(serverId) + '/actions'),
  adminEnforceServer: (serverId, actionType, reason, { reportId, confirm } = {}) => {
    // The server exposes suspend/remove (there is no /enforce endpoint):
    const type = String(actionType || '').toUpperCase();
    if (type === 'SERVER_REMOVAL') {
      return request('POST', '/api/admin/servers/' + encodeURIComponent(serverId) + '/remove',
        { body: { reason, confirm } });
    }
    if (type === 'SERVER_SUSPENSION') {
      return request('POST', '/api/admin/servers/' + encodeURIComponent(serverId) + '/suspend',
        { body: { reason, reportId } });
    }
    throw new Error('Unknown community action: ' + String(actionType || '(none)'));
  },
  adminLiftServer: (serverId, reason) =>
    request('POST', '/api/admin/servers/' + encodeURIComponent(serverId) + '/lift', { body: { reason } }),
  adminReports: ({ status, limit = 50 } = {}) => {
    const q = new URLSearchParams();
    if (status) q.set('status', status);
    q.set('limit', String(limit));
    const qs = q.toString();
    return request('GET', '/api/admin/reports' + (qs ? '?' + qs : ''));
  },
  adminReport: (id) => request('GET', '/api/admin/reports/' + encodeURIComponent(id)),
  reportContent: (targetType, targetId, reason, description) =>
    request('POST', '/api/reports', { body: { targetType, targetId, reason, description } }),
  adminUpdateReport: (id, body) =>
    request('PATCH', '/api/admin/reports/' + encodeURIComponent(id), { body }),
  adminAppeals: ({ status, limit = 50 } = {}) => {
    const q = new URLSearchParams();
    if (status) q.set('status', status);
    q.set('limit', String(limit));
    const qs = q.toString();
    return request('GET', '/api/admin/appeals' + (qs ? '?' + qs : ''));
  },
  adminAppeal: (id) => request('GET', '/api/admin/appeals/' + encodeURIComponent(id)),
  adminDecideAppeal: (id, decision, reason) =>
    request('PATCH', '/api/admin/appeals/' + encodeURIComponent(id), { body: { decision, reason } }),
  adminAudit: ({ actorId, action, targetId, limit = 50 } = {}) => {
    const q = new URLSearchParams();
    if (actorId) q.set('actorId', actorId);
    if (action) q.set('action', action);
    if (targetId) q.set('targetId', targetId);
    q.set('limit', String(limit));
    return request('GET', '/api/admin/audit?' + q.toString());
  },

  // Account deletion. The user side is deliberately explicit: a password, and
  accountDeletion: () => request('GET', '/api/account/deletion'),
  requestAccountDeletion: (password) =>
    request('POST', '/api/account/deletion', { body: { password, confirm: 'DELETE' } }),
  cancelAccountDeletion: () => request('POST', '/api/account/deletion/cancel'),

  adminGdprRequests: ({ status, limit = 50 } = {}) => {
    const q = new URLSearchParams();
    if (status) q.set('status', status);
    q.set('limit', String(limit));
    return request('GET', '/api/admin/gdpr/requests?' + q.toString());
  },
  adminReviewGdprRequest: (id, decision, note) =>
    request('POST', '/api/admin/gdpr/requests/' + encodeURIComponent(id) + '/review', {
      body: { decision, note },
    }),
  adminProcessGdprRequest: (id) =>
    request('POST', '/api/admin/gdpr/requests/' + encodeURIComponent(id) + '/process', {
      body: { confirm: 'ERASE' },
    }),

  // Static page editor. The body is typed blocks, never HTML.
  adminPages: () => request('GET', '/api/admin/pages'),
  adminPage: (route) => request('GET', '/api/admin/pages/' + encodeURIComponent(route)),
  adminPreviewPage: (route, body) =>
    request('PUT', '/api/admin/pages/' + encodeURIComponent(route), { body: { preview: true, body } }),
  adminSavePageDraft: (route, title, body) =>
    request('PUT', '/api/admin/pages/' + encodeURIComponent(route), { body: { title, body } }),
  adminPublishPage: (route, confirm) =>
    request('POST', '/api/admin/pages/' + encodeURIComponent(route) + '/publish', { body: { confirm } }),
  adminUnpublishPage: (route) =>
    request('POST', '/api/admin/pages/' + encodeURIComponent(route) + '/unpublish'),
  adminPageRevisions: (route) =>
    request('GET', '/api/admin/pages/' + encodeURIComponent(route) + '/revisions'),
  adminRestorePageRevision: (route, revision) =>
    request('POST', '/api/admin/pages/' + encodeURIComponent(route) + '/revisions/' + encodeURIComponent(revision) + '/restore'),
};

export default Api;
