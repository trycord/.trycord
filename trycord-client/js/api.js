/* API layer: centralized backend URL, token storage, typed endpoint helpers.
   Backend resolution (most explicit wins):
     1. ?api= URL parameter (used by the desktop exe's --api-url flag)
     2. saved Server setting on this device (Settings -> Application)
     3. window.TRYCORD_CONFIG.API_URL from config.js (edit without rebuilding)
     4. built-in default (http://localhost:9971, or same-origin when served)
   Errors are { code, message }; thrown Error carries .code for specific UX.
   401 on an authenticated call => session dead => clear + go to login. */
(function () {
  // Token storage is instance-scoped (see state.js); fall back to the
  // legacy flat key only before state loads.
  function tokenKey() {
    try {
      var st = window.TrycordState;
      if (st && st.tokenKey) return st.tokenKey();
    } catch (e) { /* ignore */ }
    return 'trycord.token';
  }
  var DEFAULT_API_URL = 'http://localhost:9971';

  // Returns a normalized http(s) base URL, or null if invalid.
  // 'http://host:9971/' and 'http://host:9971' both become 'http://host:9971'.
  // Anything non-http(s) (javascript:, data:, ftp:, bare words) is rejected.
  function normalizeApiUrl(raw) {
    if (!raw) return null;
    var s = String(raw).trim().replace(/\/+$/, '');
    if (!s) return null;
    var u;
    try {
      u = new URL(s);
    } catch (e) { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname) return null;
    var path = u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, '');
    return u.origin + path;
  }

  function resolveApiBase() {
    var q = null;
    try { q = new URLSearchParams(location.search).get('api'); } catch (e) { /* ignore */ }
    q = normalizeApiUrl(q);
    if (q) return { url: q, source: 'startup argument' };
    var saved = null;
    try {
      var st = window.TrycordState;
      // Access config (device pointer at an instance), then legacy location.
      saved = (st && st.access && st.access.apiBase) ||
        (st && st.settings && st.settings.apiBase) || null;
    } catch (e) { /* not loaded */ }
    saved = normalizeApiUrl(saved);
    if (saved) return { url: saved, source: 'saved setting' };
    var cfg = null;
    try { cfg = window.TRYCORD_CONFIG && window.TRYCORD_CONFIG.API_URL; } catch (e) { /* no config.js */ }
    cfg = normalizeApiUrl(cfg);
    if (cfg) return { url: cfg, source: 'server config' };
    if (location.protocol === 'file:' || location.port === '5500') {
      return { url: DEFAULT_API_URL, source: 'default' };
    }
    return { url: location.origin.replace(/\/+$/, ''), source: 'default' };
  }

  function baseUrl() {
    return resolveApiBase().url;
  }

  function apiError(data, status) {
    var err = data && data.error;
    var code = (err && err.code) || 'ERROR';
    // Prefer the server's message (already human-readable). Fall back to
    // something a person can act on instead of a bare HTTP status.
    var message = (err && err.message) || (typeof err === 'string' ? err :
      (!status ? "Couldn't reach the server. Check your connection and try again."
               : 'The server returned an error (HTTP ' + status + ').'));
    var e = new Error(message);
    e.code = code;
    e.status = status;
    return e;
  }

  async function finish(res, authed) {
    var text = await res.text();
    var data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
    if (res.status === 401 && authed) {
      API.token = null;
      if (window.TrycordState) TrycordState.user = null;
      Trycord.setOnline(true);
      location.hash = '#/login';
      throw apiError({ error: { code: 'SESSION_REVOKED', message: 'Session expired — please log in again.' } }, 401);
    }
    if (!res.ok) throw apiError(data, res.status);
    Trycord.setOnline(true);
    return data;
  }

  async function call(path, opts) {
    opts = opts || {};
    var headers = { 'Content-Type': 'application/json' };
    var authed = !!API.token;
    if (authed) headers.Authorization = 'Bearer ' + API.token;
    var res;
    try {
      res = await fetch(baseUrl() + path, {
        method: opts.method || 'GET',
        headers: headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
    } catch (e) {
      Trycord.setOnline(false);
      var net = new Error('Cannot reach the server at ' + baseUrl() + '. Is it running?');
      net.code = 'OFFLINE';
      throw net;
    }
    return finish(res, authed);
  }

  // Multipart upload: the browser sets the boundary itself (no Content-Type
  // header here). Same auth, error, and 401 semantics as call().
  async function multipart(path, file) {
    var authed = !!API.token;
    var fd = new FormData();
    fd.append('file', file, (file && file.name) || 'upload');
    var res;
    try {
      res = await fetch(baseUrl() + path, {
        method: 'POST',
        headers: authed ? { Authorization: 'Bearer ' + API.token } : {},
        body: fd,
      });
    } catch (e) {
      Trycord.setOnline(false);
      var net = new Error('Cannot reach the server at ' + baseUrl() + '. Is it running?');
      net.code = 'OFFLINE';
      throw net;
    }
    return finish(res, authed);
  }

  var API = {
    call,
    multipart,

    get token() {
      try { return localStorage.getItem(tokenKey()); } catch (e) { return null; }
    },
    set token(t) {
      try {
        if (t) localStorage.setItem(tokenKey(), t);
        else localStorage.removeItem(tokenKey());
      } catch (e) { /* ignore */ }
    },

    wsUrl() {
      // Derive from the configured backend: http -> ws, https -> wss.
      // No separate WebSocket host is ever hardcoded.
      var wsBase = baseUrl().replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
      return wsBase + '/?token=' + API.token;
    },

    // Centralized backend configuration (single source of truth).
    baseUrl,
    baseSource: () => resolveApiBase().source,
    normalizeUrl: normalizeApiUrl,
    DEFAULT_API_URL,

    // Stable id for the current instance: explicit config first,
    // otherwise derived from the backend URL. Scopes per-instance storage.
    instanceId() {
      try {
        var cfg = window.TRYCORD_CONFIG && window.TRYCORD_CONFIG.instanceId;
        if (cfg && String(cfg).trim()) {
          return 'cfg-' + String(cfg).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
        }
      } catch (e) { /* ignore */ }
      try {
        return 'url-' + new URL(baseUrl()).host.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      } catch (e) {
        return 'url-unknown';
      }
    },

    // Optional global service URL (empty = independent instance).
    // Only ever used for explicitly global resources — never for chat.
    globalUrl() {
      try {
        var g = window.TRYCORD_CONFIG && window.TRYCORD_CONFIG.globalUrl;
        var n = normalizeApiUrl(g);
        return n || '';
      } catch (e) {
        return '';
      }
    },

    // Probe a backend URL (used by the connection UI). Never throws.
    async testConnection(raw) {
      var url = normalizeApiUrl(raw);
      if (!url) {
        return { ok: false, code: 'INVALID_URL', message: 'Use an http(s) URL like http://51.79.44.111:9971' };
      }
      var t0 = Date.now();
      try {
        var ctrl = new AbortController();
        var timer = setTimeout(() => ctrl.abort(), 8000);
        var res;
        try {
          res = await fetch(url + '/api/health', { signal: ctrl.signal });
        } finally {
          clearTimeout(timer);
        }
        if (!res.ok) return { ok: false, code: 'BAD_STATUS', message: 'Server answered HTTP ' + res.status };
        return { ok: true, url, latencyMs: Date.now() - t0 };
      } catch (e) {
        return { ok: false, code: 'UNREACHABLE', message: 'Unable to connect to ' + url };
      }
    },

    // auth
    register: (body) => API.call('/api/auth/register', { method: 'POST', body }),
    login: (body) => API.call('/api/auth/login', { method: 'POST', body }),
    logout: () => API.call('/api/auth/logout', { method: 'POST' }),
    changePassword: (body) => API.call('/api/auth/change-password', { method: 'POST', body }),
    revokeAllSessions: () => API.call('/api/auth/sessions/revoke-all', { method: 'POST' }),
    revokeOtherSessions: () => API.call('/api/auth/sessions/revoke-others', { method: 'POST' }),
    forgotPassword: (body) => API.call('/api/auth/forgot-password', { method: 'POST', body }),
    resetPassword: (body) => API.call('/api/auth/reset-password', { method: 'POST', body }),
    verifyEmail: (body) => API.call('/api/auth/verify-email', { method: 'POST', body }),
    resendVerification: (body) => API.call('/api/auth/verify-email/resend', { method: 'POST', body }),
    changeEmail: (body) => API.call('/api/auth/change-email', { method: 'POST', body }),
    // users
    me: () => API.call('/api/users/me'),
    patchMe: (body) => API.call('/api/users/me', { method: 'PATCH', body }),
    // public instance metadata (no auth)
    legal: () => API.call('/api/legal'),
    // servers
    myServers: () => API.call('/api/servers'),
    createServer: (body) => API.call('/api/servers', { method: 'POST', body }),
    serverDetail: (id) => API.call('/api/servers/' + encodeURIComponent(id)),
    patchServer: (id, body) => API.call('/api/servers/' + encodeURIComponent(id), { method: 'PATCH', body }),
    deleteServer: (id) => API.call('/api/servers/' + encodeURIComponent(id), { method: 'DELETE' }),
    serverMembers: (id) => API.call('/api/servers/' + encodeURIComponent(id) + '/members'),
    leaveServer: (id) => API.call('/api/servers/' + encodeURIComponent(id) + '/leave', { method: 'POST' }),
    kickMember: (id, userId) => API.call('/api/servers/' + encodeURIComponent(id) + '/kick', { method: 'POST', body: { userId } }),
    previewByCode: (code) => API.call('/api/servers/by-code/' + encodeURIComponent(code)),
    joinByCode: (code) => API.call('/api/servers/join/' + encodeURIComponent(code), { method: 'POST' }),
    // roles
    serverPerms: (id) => API.call('/api/servers/' + encodeURIComponent(id) + '/roles/permissions'),
    roles: (id) => API.call('/api/servers/' + encodeURIComponent(id) + '/roles'),
    createRole: (id, body) => API.call('/api/servers/' + encodeURIComponent(id) + '/roles', { method: 'POST', body }),
    patchRole: (id, roleId, body) => API.call('/api/servers/' + encodeURIComponent(id) + '/roles/' + encodeURIComponent(roleId), { method: 'PATCH', body }),
    deleteRole: (id, roleId) => API.call('/api/servers/' + encodeURIComponent(id) + '/roles/' + encodeURIComponent(roleId), { method: 'DELETE' }),
    assignRole: (id, roleId, userId) => API.call('/api/servers/' + encodeURIComponent(id) + '/roles/' + encodeURIComponent(roleId) + '/assign', { method: 'POST', body: { userId } }),
    unassignRole: (id, roleId, userId) => API.call('/api/servers/' + encodeURIComponent(id) + '/roles/' + encodeURIComponent(roleId) + '/assign/' + encodeURIComponent(userId), { method: 'DELETE' }),
    // invites
    invites: (id) => API.call('/api/servers/' + encodeURIComponent(id) + '/invites'),
    createInvite: (id, body) => API.call('/api/servers/' + encodeURIComponent(id) + '/invites', { method: 'POST', body }),
    revokeInvite: (id, inviteId) => API.call('/api/servers/' + encodeURIComponent(id) + '/invites/' + encodeURIComponent(inviteId), { method: 'DELETE' }),
    invitePreview: (code) => API.call('/api/invites/' + encodeURIComponent(code) + '/preview'),
    joinWithInvite: (code) => API.call('/api/invites/' + encodeURIComponent(code) + '/join', { method: 'POST' }),
    // categories + channels + messages
    categories: (sid) => API.call('/api/servers/' + encodeURIComponent(sid) + '/categories'),
    createCategory: (sid, body) => API.call('/api/servers/' + encodeURIComponent(sid) + '/categories', { method: 'POST', body }),
    deleteCategory: (sid, cid) => API.call('/api/servers/' + encodeURIComponent(sid) + '/categories/' + encodeURIComponent(cid), { method: 'DELETE' }),
    channels: (sid) => API.call('/api/servers/' + encodeURIComponent(sid) + '/channels'),
    createChannel: (sid, body) => API.call('/api/servers/' + encodeURIComponent(sid) + '/channels', { method: 'POST', body }),
    deleteChannel: (sid, cid) => API.call('/api/servers/' + encodeURIComponent(sid) + '/channels/' + encodeURIComponent(cid), { method: 'DELETE' }),
    messages: (cid, limit, before) => API.call('/api/channels/' + encodeURIComponent(cid) + '/messages?limit=' + (limit || 50) + (before ? '&before=' + encodeURIComponent(before) : '')),
    postMessage: (cid, content, attachmentIds) => API.call('/api/channels/' + encodeURIComponent(cid) + '/messages', {
      method: 'POST',
      body: attachmentIds && attachmentIds.length ? { content, attachmentIds } : { content },
    }),
    patchMessage: (cid, mid, content) => API.call('/api/channels/' + encodeURIComponent(cid) + '/messages/' + encodeURIComponent(mid), { method: 'PATCH', body: { content } }),
    deleteMessage: (cid, mid) => API.call('/api/channels/' + encodeURIComponent(cid) + '/messages/' + encodeURIComponent(mid), { method: 'DELETE' }),
    // attachments (uploads feature)
    uploadAttachment: (channelId, file) =>
      API.multipart('/api/channels/' + encodeURIComponent(channelId) + '/attachments', file)
        .then((d) => d && d.attachment),
    attachmentUrl: (id) => baseUrl() + '/api/attachments/' + encodeURIComponent(id),
    // Authored download: the Bearer token cannot ride on a plain <a href>,
    // so callers fetch the blob and use an object URL.
    async attachmentBlob(id) {
      var res;
      try {
        res = await fetch(API.attachmentUrl(id), {
          headers: API.token ? { Authorization: 'Bearer ' + API.token } : {},
        });
      } catch (e) {
        Trycord.setOnline(false);
        var net = new Error('Cannot reach the server at ' + baseUrl() + '. Is it running?');
        net.code = 'OFFLINE';
        throw net;
      }
      if (res.status === 401 && API.token) {
        API.token = null;
        if (window.TrycordState) TrycordState.user = null;
        Trycord.setOnline(true);
        location.hash = '#/login';
        throw apiError({ error: { code: 'SESSION_REVOKED', message: 'Session expired — please log in again.' } }, 401);
      }
      if (!res.ok) throw apiError({ error: { code: 'NOT_FOUND', message: 'Attachment unavailable.' } }, res.status);
      Trycord.setOnline(true);
      return res.blob();
    },
    // browse + activity (discover is public: no membership required)
    discover: (q, page, limit) => {
      var qs = '?limit=' + (limit || 12) + '&page=' + (page || 1) + (q ? '&q=' + encodeURIComponent(q) : '');
      return API.call('/api/discover/servers' + qs);
    },
    discoverPreview: (id) => API.call('/api/discover/servers/' + encodeURIComponent(id)),
    joinPublic: (id) => API.call('/api/discover/servers/' + encodeURIComponent(id) + '/join', { method: 'POST' }),
    activity: (limit) => API.call('/api/activity?limit=' + (limit || 20)),
    health: () => API.call('/health'),
    // direct messages
    dms: () => API.call('/api/dms'),
    openDM: (userId) => API.call('/api/dms', { method: 'POST', body: { userId } }),
    dmDetail: (id) => API.call('/api/dms/' + encodeURIComponent(id)),
    dmHistory: (id, before, limit) => API.call('/api/dms/' + encodeURIComponent(id) + '/messages?limit=' + (limit || 50) + (before ? '&before=' + encodeURIComponent(before) : '')),
    dmSend: (id, content) => API.call('/api/dms/' + encodeURIComponent(id) + '/messages', { method: 'POST', body: { content } }),
    dmEdit: (id, mid, content) => API.call('/api/dms/' + encodeURIComponent(id) + '/messages/' + encodeURIComponent(mid), { method: 'PATCH', body: { content } }),
    dmDelete: (id, mid) => API.call('/api/dms/' + encodeURIComponent(id) + '/messages/' + encodeURIComponent(mid), { method: 'DELETE' }),
    dmRead: (id) => API.call('/api/dms/' + encodeURIComponent(id) + '/read', { method: 'POST' }),
    // friends
    friends: () => API.call('/api/friends'),
    friendRequests: () => API.call('/api/friends/requests'),
    friendRequest: (userId) => API.call('/api/friends/requests', { method: 'POST', body: { userId } }),
    friendAccept: (id) => API.call('/api/friends/requests/' + encodeURIComponent(id) + '/accept', { method: 'POST' }),
    friendDecline: (id) => API.call('/api/friends/requests/' + encodeURIComponent(id) + '/decline', { method: 'POST' }),
    friendCancel: (id) => API.call('/api/friends/requests/' + encodeURIComponent(id), { method: 'DELETE' }),
    friendRemove: (userId) => API.call('/api/friends/' + encodeURIComponent(userId), { method: 'DELETE' }),
    // directory + presence
    userSearch: (q) => API.call('/api/users/search?q=' + encodeURIComponent(q)),
    userProfile: (id) => API.call('/api/users/' + encodeURIComponent(id)),
    presence: (ids) => API.call('/api/users/presence?ids=' + ids.map(encodeURIComponent).join(',')),
    // notifications
    notifications: (limit) => API.call('/api/notifications?limit=' + (limit || 30)),
    notifRead: (id) => API.call('/api/notifications/' + encodeURIComponent(id) + '/read', { method: 'POST' }),
    notifReadAll: () => API.call('/api/notifications/read-all', { method: 'POST' }),
  };

  window.TrycordApi = API;
})();
