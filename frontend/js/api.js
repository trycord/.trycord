// The HTTP surface: 179 one-line endpoint calls over api/core.js.
//
// Kept in one file on purpose. Grouping it by resource would mean six files each holding
// a fragment of one lookup table that nobody reads whole. The transport underneath is
// where the complexity lives, and it has its own file.

import {
  ApiError,
  onFailover,
  resetFailoverAnnouncement,
  token,
  setToken,
  request,
  xhrUpload,
  fetchProfileImage,
  fetchAuthedImage,
} from './api/core.js';

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
  revokeAllSessions: () => request('POST', '/api/auth/sessions/revoke-all'),
  revokeOthers: () => request('POST', '/api/auth/sessions/revoke-others'),
  // Per-session revocation. The list is the only way to learn a jti, and the
  // jti is the only handle a single revoke accepts - which is why the Security
  // page cannot offer "sign out this device" without it.
  sessions: () => request('GET', '/api/auth/sessions'),
  revokeSession: (jti) => request('POST', '/api/auth/sessions/revoke', { body: { jti } }),
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

  uploadProfileImage: (kind, file) => {
    const fd = new FormData();
    fd.append('file', file);
    return request('POST', kind === 'banner' ? '/api/users/me/banner' : '/api/users/me/avatar',
      { body: fd, form: true });
  },
  removeProfileImage: (kind) =>
    request('DELETE', kind === 'banner' ? '/api/users/me/banner' : '/api/users/me/avatar'),
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

  channels: (serverId) => request('GET', '/api/servers/' + encodeURIComponent(serverId) + '/channels'),
  createChannel: (serverId, body) => request('POST', '/api/servers/' + encodeURIComponent(serverId) + '/channels', { body }),
  updateChannel: (serverId, channelId, body) =>
    request('PATCH', '/api/servers/' + encodeURIComponent(serverId) + '/channels/' + encodeURIComponent(channelId), { body }),
  deleteChannel: (serverId, channelId) =>
    request('DELETE', '/api/servers/' + encodeURIComponent(serverId) + '/channels/' + encodeURIComponent(channelId)),

  createCategory: (serverId, body) => request('POST', '/api/servers/' + encodeURIComponent(serverId) + '/categories', { body }),
  deleteCategory: (serverId, categoryId) =>
    request('DELETE', '/api/servers/' + encodeURIComponent(serverId) + '/categories/' + encodeURIComponent(categoryId)),
  renameCategory: (serverId, categoryId, name) =>
    request('PATCH', '/api/servers/' + encodeURIComponent(serverId) + '/categories/' + encodeURIComponent(categoryId), { body: { name } }),
  reorderCategories: (serverId, orderedIds) =>
    request('POST', '/api/servers/' + encodeURIComponent(serverId) + '/categories/reorder', { body: { orderedIds } }),

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
  // Threads. The kind is 'channel' or 'dm'; the two are the same shape over
  // different tables, so they share these rather than having a pair each.
  messageThread: (kind, scopeId, messageId) =>
    request('GET', (kind === 'dm' ? '/api/dms/' : '/api/channels/') + encodeURIComponent(scopeId) +
      '/messages/' + encodeURIComponent(messageId) + '/thread'),
  sendThreadReply: (kind, scopeId, content, replyToId) =>
    kind === 'dm'
      ? request('POST', '/api/dms/' + encodeURIComponent(scopeId) + '/messages', { body: { content, replyToId } })
      : request('POST', '/api/channels/' + encodeURIComponent(scopeId) + '/messages', { body: { content, replyToId } }),
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

  // XHR rather than fetch, which cannot report how much of a body has been
  // sent. Both upload endpoints go through this.
  uploadAttachmentWithProgress: (channelId, file, onProgress) => {
    const fd = new FormData();
    fd.append('file', file);
    return xhrUpload('/api/channels/' + encodeURIComponent(channelId) + '/attachments', fd, onProgress);
  },
  uploadDmAttachment: (conversationId, file, onProgress) => {
    const fd = new FormData();
    fd.append('file', file);
    return xhrUpload('/api/dms/' + encodeURIComponent(conversationId) + '/attachments', fd, onProgress);
  },
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
  joinInvite: (code) => request('POST', '/api/invites/' + encodeURIComponent(code) + '/join'),
discover: ({ q = '', page = 1, limit = 12 } = {}) => {
    const qs = new URLSearchParams({
        page: String(page),
        limit: String(limit),
    });

    if (q) qs.set('q', q);

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
  sendDm: (id, content, clientNonce, attachmentIds, suppressEmbeds) =>
    request('POST', '/api/dms/' + encodeURIComponent(id) + '/messages',
      { body: Object.assign(
        clientNonce ? { content, clientNonce } : { content },
        attachmentIds && attachmentIds.length ? { attachmentIds } : {},
        suppressEmbeds ? { suppressEmbeds: true } : {}
      ) }),
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

  // Assembled by the server on request from the caller's own rows. `ndjson` is
  // the same export with a different content type, for when one document is
  // inconvenient to open - not a second export.
  exportData: () => request('GET', '/api/me/export'),

  // Privacy, blocking, notification preferences and wellbeing. All under
  // /api/me because they are all about the caller's own account; the server
  // reads a stranger's preferences when enforcing a rule, never exposes them.
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
  // Community integrations. Webhook secrets and application tokens are returned
  // once, at creation; nothing here can read either back afterwards, which is
  // why rotate exists rather than a "show secret" action.
  webhooks: (serverId) =>
    request('GET', '/api/servers/' + encodeURIComponent(serverId) + '/webhooks'),
  createWebhook: (serverId, body) =>
    request('POST', '/api/servers/' + encodeURIComponent(serverId) + '/webhooks', { body }),
  updateWebhook: (serverId, webhookId, body) =>
    request('PATCH', '/api/servers/' + encodeURIComponent(serverId) + '/webhooks/' + encodeURIComponent(webhookId), { body }),
  rotateWebhookSecret: (serverId, webhookId) =>
    request('POST', '/api/servers/' + encodeURIComponent(serverId) + '/webhooks/' + encodeURIComponent(webhookId) + '/rotate-secret'),
  webhookDeliveries: (serverId, webhookId, limit) =>
    request('GET', '/api/servers/' + encodeURIComponent(serverId) + '/webhooks/' + encodeURIComponent(webhookId) + '/deliveries'
      + (limit ? '?limit=' + encodeURIComponent(limit) : '')),
  deleteWebhook: (serverId, webhookId) =>
    request('DELETE', '/api/servers/' + encodeURIComponent(serverId) + '/webhooks/' + encodeURIComponent(webhookId)),

  apps: (serverId) =>
    request('GET', '/api/servers/' + encodeURIComponent(serverId) + '/apps'),
  createApp: (serverId, body) =>
    request('POST', '/api/servers/' + encodeURIComponent(serverId) + '/apps',
      { body: typeof body === 'string' ? { name: body } : body }),
  updateApp: (serverId, appId, body) =>
    request('PATCH', '/api/servers/' + encodeURIComponent(serverId) + '/apps/' + encodeURIComponent(appId), { body }),
  deleteApp: (serverId, appId) =>
    request('DELETE', '/api/servers/' + encodeURIComponent(serverId) + '/apps/' + encodeURIComponent(appId)),
  appCommands: (serverId, appId) =>
    request('GET', '/api/servers/' + encodeURIComponent(serverId) + '/apps/' + encodeURIComponent(appId) + '/commands'),
  setAppCommand: (serverId, appId, body) =>
    request('PUT', '/api/servers/' + encodeURIComponent(serverId) + '/apps/' + encodeURIComponent(appId) + '/commands', { body }),
  deleteAppCommand: (serverId, appId, commandId) =>
    request('DELETE', '/api/servers/' + encodeURIComponent(serverId) + '/apps/' + encodeURIComponent(appId) + '/commands/' + encodeURIComponent(commandId)),

  analytics: (serverId, days) =>
    request('GET', '/api/servers/' + encodeURIComponent(serverId) + '/analytics'
      + (days ? '?days=' + encodeURIComponent(days) : '')),

  adminPageRevisions: (route) =>
    request('GET', '/api/admin/pages/' + encodeURIComponent(route) + '/revisions'),
  adminRestorePageRevision: (route, revision) =>
    request('POST', '/api/admin/pages/' + encodeURIComponent(route) + '/revisions/' + encodeURIComponent(revision) + '/restore'),
};

export {
  ApiError,
  onFailover,
  resetFailoverAnnouncement,
  token,
  setToken,
  request,
  xhrUpload,
  fetchProfileImage,
  fetchAuthedImage,
};

export default Api;
